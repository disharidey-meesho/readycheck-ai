import express from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import metrics from "./metrics.cjs";
import { initPktSchema, registerPktRoutes } from "./pkt";
import { registerAdminRoutes, saveDriveConnection, DRIVE_SCOPES } from "./admin";
import { rateLimiter, byIp, byUser } from "./rate-limit";

// Settings come from the environment. Locally they can sit in .env (preferred: builders stores a
// published .env as secrets) or .env.local; a value already in the environment always wins.
const appDir = path.dirname(fileURLToPath(import.meta.url));
const envFiles = [".env", ".env.local"].map((f) => path.resolve(appDir, f)).filter((f) => fs.existsSync(f));
if (envFiles.length) dotenv.config({ path: envFiles, quiet: true });
console.log("[env] settings files: %s | SUPER_ADMIN_EMAIL set: %s", envFiles.map((f) => path.basename(f)).join(", ") || "none", !!process.env.SUPER_ADMIN_EMAIL);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// On builders the app folder is read-only; DATA_DIR (/data) is the persistent volume.
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.resolve(DATA_DIR, "readycheck.db");
const DB_BACKUP_PATH = path.resolve(DATA_DIR, "readycheck.db.bak");

// --- Auto-restore from backup if DB is missing ---
if (!fs.existsSync(DB_PATH) && fs.existsSync(DB_BACKUP_PATH)) {
  fs.copyFileSync(DB_BACKUP_PATH, DB_PATH);
  console.log("[backup] DB was missing — restored from readycheck.db.bak ✅");
}

const db = new Database(DB_PATH);
console.log(`Database at: ${DB_PATH}`);

// Backups are online snapshots taken by admin.ts (at most one every 15 minutes, never
// touching the live file); until the server has started, changes are simply not snapshotted.
let scheduleBackup: () => void = () => {};
function snapshotBackup() {
  scheduleBackup();
}

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS sops (
    account_id TEXT PRIMARY KEY,
    sop_text TEXT,
    is_locked INTEGER DEFAULT 0,
    last_modified_by TEXT,
    last_modified_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS pods (
    name TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

`);

// Migration for existing sops table
try {
  db.exec("ALTER TABLE sops ADD COLUMN is_locked INTEGER DEFAULT 0");
} catch (e) {}
try {
  db.exec("ALTER TABLE sops ADD COLUMN last_modified_by TEXT");
} catch (e) {}
try {
  db.exec("ALTER TABLE sops ADD COLUMN last_modified_at DATETIME");
} catch (e) {}

// Migration: each pod has its own number of training days (existing pods keep 5)
try {
  db.exec("ALTER TABLE pods ADD COLUMN training_days INTEGER DEFAULT 5");
} catch (e) {}

// Role grants (trainer / admin) given by the Super Admin; legacy user_admins become admins.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_roles (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    role TEXT NOT NULL,
    added_by TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL,
    view TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// Old-system tables (user_admins, test_results, agent_assignments, assignment_settings) are
// imported into the new tables once on startup (see legacyCleanup below) and then dropped.
const LEGACY_TABLES = ['user_admins', 'test_results', 'agent_assignments', 'assignment_settings'];
const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

initPktSchema(db);

// Migration: copy existing flat SOPs to Day 1 format
try {
  db.prepare(`
    INSERT OR IGNORE INTO sops (account_id, sop_text, is_locked, last_modified_by, last_modified_at)
    SELECT account_id || '_Day1', sop_text, is_locked, last_modified_by, last_modified_at
    FROM sops
    WHERE sop_text != '' AND account_id NOT LIKE '%_Day%'
  `).run();
} catch (e) {}

// Defaults are inserted only on a brand-new database.
// Re-inserting them on every boot resurrected pods the admin had deleted (e.g. Seekho).
const DEFAULT_ACCOUNTS = ['Atomberg', 'Spinny', 'Noise', 'Bajaj Electricals'];

db.exec(`
  CREATE TABLE IF NOT EXISTS deleted_pods (
    name TEXT PRIMARY KEY,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const defaultsSeeded = db.prepare(`SELECT 1 FROM app_meta WHERE key = 'defaults_seeded'`).get();
const podCount = (db.prepare(`SELECT COUNT(*) AS c FROM pods`).get() as { c: number }).c;

if (!defaultsSeeded && podCount === 0) {
  const insertSop = db.prepare('INSERT OR IGNORE INTO sops (account_id, sop_text) VALUES (?, ?)');
  const insertPod = db.prepare('INSERT OR IGNORE INTO pods (name) VALUES (?)');
  for (const acc of DEFAULT_ACCOUNTS) {
    const removed = db.prepare('SELECT 1 FROM deleted_pods WHERE LOWER(name) = LOWER(?)').get(acc);
    if (removed) continue;
    insertPod.run(acc);
    for (let day = 1; day <= 5; day++) {
      insertSop.run(`${acc}_Day${day}`, '');
    }
  }
}

if (!defaultsSeeded) {
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('defaults_seeded', '1')`).run();
}

// Seekho was deleted by an admin and then restored by the old startup seed.
const seekhoRemoved = db.prepare(`SELECT 1 FROM app_meta WHERE key = 'seekho_removed'`).get();
if (!seekhoRemoved) {
  db.prepare(`INSERT OR IGNORE INTO deleted_pods (name) VALUES ('Seekho')`).run();
  db.prepare(`DELETE FROM pods WHERE name = 'Seekho'`).run();
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seekho_removed', '1')`).run();
}

// Drop SOP rows left behind after a pod delete (legacy flat keys and day slots).
db.prepare(`
  DELETE FROM sops
  WHERE account_id NOT IN (SELECT name FROM pods)
    AND NOT EXISTS (
      SELECT 1 FROM pods p
      WHERE substr(sops.account_id, 1, length(p.name) + 4) = p.name || '_Day'
    )
`).run();

const MAX_TRAINING_DAYS = 10;
function ensureSopSlots(podName: string, days: number) {
  const insertSopSlot = db.prepare('INSERT OR IGNORE INTO sops (account_id, sop_text) VALUES (?, ?)');
  for (let day = 1; day <= days; day++) insertSopSlot.run(`${podName}_Day${day}`, '');
}


// --- Google OAuth & Session Management ---

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const CALLBACK_URL = `${APP_URL}/auth/google/callback`;

// Each role can also open every view below it: super_admin > admin > trainer > agent.
type Role = 'agent' | 'trainer' | 'admin' | 'super_admin';
const ROLE_LEVEL: Record<Role, number> = { agent: 0, trainer: 1, admin: 2, super_admin: 3 };
const isRole = (r: unknown): r is Role => typeof r === 'string' && r in ROLE_LEVEL;
// role = highest access granted; view = the view the user chose at login (or switched to)
interface Session { email: string; name: string; role: Role; view: Role; createdAt: number; }
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// The database keeps only a SHA-256 of each session ID, so a copy of the database (or a backup)
// can't be turned back into a working cookie. Rows from before hashing (36-character UUIDs) are
// dropped on startup: everyone signs in again once.
const sidHash = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex');
db.prepare('DELETE FROM sessions WHERE length(sid) != 64').run();
const sweepSessions = () => db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL_MS);
setInterval(sweepSessions, 15 * 60_000).unref();

function isSuperAdminEmail(email: string): boolean {
  const admin = (process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  return admin.length > 0 && email.trim().toLowerCase() === admin;
}

function grantedRole(email: string): Role {
  if (isSuperAdminEmail(email)) return 'super_admin';
  const row = db.prepare('SELECT role FROM user_roles WHERE email = ?').get(email.toLowerCase()) as { role: string } | undefined;
  return row && isRole(row.role) && row.role !== 'super_admin' ? row.role : 'agent';
}

function createSession(res: express.Response, s: Omit<Session, 'createdAt'>) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sweepSessions();
  db.prepare('INSERT INTO sessions (sid, email, name, role, view, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sidHash(sid), s.email, s.name, s.role, s.view, Date.now());
  res.append(
    "Set-Cookie",
    `rc_session=${sid}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}; Path=/`
  );
}

// OAuth "state" values waiting for Google's callback: protects the login from CSRF and
// carries what the sign-in is for: a login ("auto" = straight to the highest role granted)
// or an admin connecting Google Drive for SOP sync and backups.
type PendingLogin = { as: Role | 'auto'; purpose: 'login' | 'drive'; byEmail?: string; codeVerifier?: string; createdAt: number };
const pendingLogins = new Map<string, PendingLogin>();
// the state is also kept in a short-lived cookie, so a callback only works in the browser that
// started the sign-in (a forged callback link can't sign someone into another account)
function newOAuthState(res: express.Response, p: Omit<PendingLogin, 'createdAt'>) {
  const state = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  for (const [k, v] of pendingLogins) if (now - v.createdAt > 10 * 60 * 1000) pendingLogins.delete(k);
  pendingLogins.set(state, { ...p, createdAt: now });
  res.append("Set-Cookie", `rc_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/google`);
  return state;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}

function getSession(req: express.Request): Session | null {
  const cookies = parseCookies(req.headers.cookie || "");
  const sid = cookies["rc_session"];
  if (!sid || sid.length > 100) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sidHash(sid)) as
    | { sid: string; email: string; name: string; role: string; view: string; created_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
    return null;
  }
  // access can be removed by the Super Admin at any time; re-check on every request
  const role = grantedRole(row.email);
  const view = isRole(row.view) && ROLE_LEVEL[row.view] <= ROLE_LEVEL[role] ? row.view : role;
  return { email: row.email, name: row.name || row.email, role, view, createdAt: row.created_at };
}

// Old-system tables: import their rows into the new tables once, then drop them.
function legacyCleanup(importLegacy: (src: InstanceType<typeof Database>) => unknown) {
  const present = LEGACY_TABLES.filter(tableExists);
  if (!present.length) return;
  const rows = present.reduce((n, t) => n + (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c, 0);
  try {
    if (rows > 0) {
      console.log('[legacy] importing old-system data:', importLegacy(db));
    }
    for (const t of present) db.exec(`DROP TABLE IF EXISTS ${t}`);
  } catch (err) {
    console.error('[legacy] import failed; old tables kept:', err);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  // req.ip is the first address outside the platform's private network (its ingress adds X-Forwarded-For)
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // basic browser protections on every response
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', process.env.NODE_ENV === 'production'
      ? [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: https://upload.wikimedia.org",
          "connect-src 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
        ].join('; ')
      : "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    next();
  });

  // request counts and timings for the platform (PROMETHEUS_METRICS=true); before the body parsers
  app.use(metrics.middleware);
  app.get("/metrics", metrics.handler);
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

  // Small bodies everywhere; up to 1 MB (the platform's own cap) only where whole documents or
  // file chunks are sent. Anything bigger is refused with 413 before it is parsed.
  const LARGE_BODY_ROUTES = [
    '/api/sops', '/api/admin/pod-sources/:pod/paste', '/api/admin/extract-pdf',
    '/api/admin/legacy/chunk', '/api/trainer/import',
  ];
  app.use(LARGE_BODY_ROUTES, express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    return next(err);
  });

  // per-address limits on everything, tighter ones on sign-in
  app.use('/api', rateLimiter({ name: 'api', windowMs: 60_000, max: 600, key: byIp }));
  const signInLimit = rateLimiter({ name: 'sign-in', windowMs: 15 * 60_000, max: 40, key: byIp });

  function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    (req as any).session = session;
    return next();
  }

  // granted access must be at least `min` (a higher role can do everything a lower one can)
  function requireLevel(min: Role) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const session = (req as any).session as Session | undefined;
      if (!session) return res.status(401).json({ error: 'Unauthorized' });
      if (ROLE_LEVEL[session.role] < ROLE_LEVEL[min]) return res.status(403).json({ error: 'Forbidden' });
      return next();
    };
  }

  // --- Google OAuth Routes ---

  app.get("/auth/google", signInLimit, async (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect("/?auth_error=not_configured");
    }
    const as = isRole(req.query.as) ? req.query.as : 'auto';
    const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);
    // PKCE: Google only hands out tokens to whoever holds the verifier, which never leaves the server
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = newOAuthState(res, { as, purpose: 'login', codeVerifier });
    const url = client.generateAuthUrl({
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      access_type: "online",
      scope: [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
      prompt: "select_account",
      state,
    });
    res.redirect(url);
  });

  // only the Super Admin connects Drive (SOP sync and backups); see the callback for which accounts
  app.get("/auth/google/drive", signInLimit, requireAuth, requireLevel('super_admin'), async (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect("/?drive=not_configured");
    const session = (req as any).session as Session;
    const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = newOAuthState(res, { as: session.view, purpose: 'drive', byEmail: session.email, codeVerifier });
    res.redirect(client.generateAuthUrl({
      access_type: "offline", prompt: "consent", scope: DRIVE_SCOPES, state, login_hint: session.email,
      code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    }));
  });

  app.get("/auth/google/callback", signInLimit, async (req, res) => {
    const { code, error, state } = req.query as { code?: string; error?: string; state?: string };
    if (error || !code) return res.redirect("/?auth_error=access_denied");
    const pending = state ? pendingLogins.get(state) : undefined;
    if (state) pendingLogins.delete(state);
    const browserState = parseCookies(req.headers.cookie || "")["rc_oauth"];
    res.append("Set-Cookie", "rc_oauth=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth/google");
    if (!pending || !state || browserState !== state) return res.redirect("/?auth_error=expired");
    if (pending.purpose === 'drive') {
      try {
        const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);
        const { tokens } = await client.getToken({ code, codeVerifier: pending.codeVerifier });
        if (!tokens.refresh_token) return res.redirect("/?drive=no_refresh_token");
        const ticket = await new OAuth2Client(GOOGLE_CLIENT_ID).verifyIdToken({ idToken: tokens.id_token!, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const driveEmail = (payload?.email ?? '').toLowerCase();
        // a verified Meesho Workspace account only: a personal Gmail would take SOPs and backups off Meesho's Drive
        if (!payload?.email_verified || payload.hd !== 'meesho.com' || !driveEmail.endsWith('@meesho.com')) {
          console.warn(`[drive] refused connection by ${pending.byEmail}: not a verified @meesho.com account`);
          return res.redirect("/?drive=not_meesho");
        }
        // the role is checked again: access may have changed while the consent screen was open
        if (!pending.byEmail || grantedRole(pending.byEmail) !== 'super_admin') return res.redirect("/?drive=error");
        saveDriveConnection(db, tokens.refresh_token, driveEmail, pending.byEmail);
        console.log(`[drive] connected ${driveEmail} (by ${pending.byEmail})`);
        snapshotBackup();
        return res.redirect("/?drive=connected");
      } catch (err) {
        console.error("Drive connect error:", err);
        return res.redirect("/?drive=error");
      }
    }
    try {
      const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);
      const { tokens } = await client.getToken({ code, codeVerifier: pending.codeVerifier });
      const verifier = new OAuth2Client(GOOGLE_CLIENT_ID);
      const ticket = await verifier.verifyIdToken({
        idToken: tokens.id_token!,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload()!;
      const email = (payload.email ?? "").toLowerCase();
      const name = payload.name ?? email;
      if (!payload.email_verified || payload.hd !== "meesho.com" || !email.endsWith("@meesho.com")) {
        console.warn(`[auth] refused sign-in: ${payload.email_verified ? 'non-Meesho' : 'unverified'} account`);
        return res.redirect("/?auth_error=domain_restricted");
      }
      const role = grantedRole(email);
      if (pending.as !== 'auto' && ROLE_LEVEL[pending.as] > ROLE_LEVEL[role]) {
        return res.redirect(`/?auth_error=no_access&as=${pending.as}`);
      }
      createSession(res, { email, name, role, view: pending.as === 'auto' ? role : pending.as });
      res.redirect("/");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.redirect("/?auth_error=server_error");
    }
  });

  app.get("/api/me", (req, res) => {
    const session = getSession(req);
    res.json({ user: session ? { email: session.email, name: session.name, role: session.role, view: session.view } : null });
  });

  // switch between the views this user's access allows
  app.post("/api/session/view", requireAuth, (req, res) => {
    const session = (req as any).session as Session;
    const { view } = req.body as { view?: unknown };
    if (!isRole(view) || ROLE_LEVEL[view] > ROLE_LEVEL[session.role]) {
      return res.status(403).json({ error: "You don't have access to that view." });
    }
    const sid = parseCookies(req.headers.cookie || "")["rc_session"];
    db.prepare('UPDATE sessions SET view = ? WHERE sid = ?').run(view, sidHash(sid));
    res.json({ user: { email: session.email, name: session.name, role: session.role, view } });
  });

  // --- User access (Super Admin only) ---
  app.get("/api/user-roles", requireAuth, requireLevel('super_admin'), (_req, res) => {
    res.json(db.prepare('SELECT email, role, added_by, added_at FROM user_roles ORDER BY role DESC, email').all());
  });

  app.post("/api/user-roles", requireAuth, requireLevel('super_admin'), (req, res) => {
    const session = (req as any).session as Session;
    const { email, role } = req.body as { email?: unknown; role?: unknown };
    const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@meesho\.com$/.test(clean)) return res.status(400).json({ error: 'Enter a valid @meesho.com email.' });
    if (role !== 'trainer' && role !== 'admin') return res.status(400).json({ error: 'Role must be Trainer or Admin.' });
    if (isSuperAdminEmail(clean)) return res.status(400).json({ error: 'That is the Super Admin account.' });
    db.prepare(`
      INSERT INTO user_roles (email, role, added_by) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET role = excluded.role, added_by = excluded.added_by, added_at = CURRENT_TIMESTAMP
    `).run(clean, role, session.email);
    snapshotBackup();
    res.json({ ok: true });
  });

  app.delete("/api/user-roles/:email", requireAuth, requireLevel('super_admin'), (req, res) => {
    const email = String(req.params.email).trim().toLowerCase();
    db.prepare('DELETE FROM user_roles WHERE email = ?').run(email);
    db.prepare('DELETE FROM trainer_scopes WHERE email = ?').run(email);
    snapshotBackup();
    res.json({ ok: true });
  });

  // --- Pods (Clients) ---
  app.get("/api/pods", requireAuth, (req, res) => {
    const pods = db.prepare('SELECT name, COALESCE(training_days, 5) AS training_days FROM pods ORDER BY created_at ASC').all();
    res.json(pods);
  });

  const parseTrainingDays = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= MAX_TRAINING_DAYS ? n : null;
  };

  app.patch("/api/pods/:name", requireAuth, requireLevel('admin'), (req, res) => {
    const podName = String(req.params.name).trim();
    const days = parseTrainingDays((req.body as { training_days?: unknown }).training_days);
    if (!days) return res.status(400).json({ error: `Training days must be between 1 and ${MAX_TRAINING_DAYS}.` });
    const info = db.prepare('UPDATE pods SET training_days = ? WHERE name = ?').run(days, podName);
    if (!info.changes) return res.status(404).json({ error: `Pod "${podName}" not found.` });
    ensureSopSlots(podName, days);
    snapshotBackup();
    return res.json({ ok: true, name: podName, training_days: days });
  });

  app.post("/api/pods", requireAuth, requireLevel('admin'), (req, res) => {
    const { name, training_days } = req.body as { name?: string; training_days?: unknown };
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Pod name is required.' });
    }
    const podName = name.trim();
    if (podName.length > 100) {
      return res.status(400).json({ error: 'Pod name must be 100 characters or fewer.' });
    }
    const days = parseTrainingDays(training_days ?? 5);
    if (!days) {
      return res.status(400).json({ error: `Training days must be between 1 and ${MAX_TRAINING_DAYS}.` });
    }
    const existing = db.prepare('SELECT name FROM pods WHERE LOWER(name) = LOWER(?)').get(podName);
    if (existing) {
      return res.status(409).json({ error: `A pod named "${podName}" already exists.` });
    }
    db.prepare('DELETE FROM deleted_pods WHERE LOWER(name) = LOWER(?)').run(podName);
    db.prepare('INSERT INTO pods (name, training_days) VALUES (?, ?)').run(podName, days);
    // Pre-create one SOP slot per training day for the new pod
    ensureSopSlots(podName, days);
    snapshotBackup();
    return res.json({ ok: true, name: podName, training_days: days });
  });

// ── Delete a pod ─────────────────────────────────────────────────────────────
app.delete("/api/pods/:name", requireAuth, requireLevel('admin'), (req, res) => {
  const podName = String(req.params.name).trim();
  const existing = db.prepare('SELECT name FROM pods WHERE name = ?').get(podName);
  if (!existing)
    return res.status(404).json({ error: `Pod "${podName}" not found.` });
  db.prepare('INSERT OR REPLACE INTO deleted_pods (name) VALUES (?)').run(podName);
  db.prepare('DELETE FROM pods WHERE name = ?').run(podName);
  db.prepare('DELETE FROM sops WHERE account_id = ? OR account_id LIKE ? ESCAPE ?').run(podName, `${podName.replace(/[\\%_]/g, '\\$&')}\\_Day%`, '\\');
  db.prepare('DELETE FROM day_training WHERE pod = ?').run(podName);
  db.prepare('DELETE FROM pod_sources WHERE pod = ?').run(podName);
  snapshotBackup();
  return res.json({ ok: true, name: podName });
});

  app.post("/api/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie || "");
    const sid = cookies["rc_session"];
    if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sidHash(sid));
    res.setHeader("Set-Cookie", "rc_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
    res.json({ success: true });
  });

  // API Routes
  app.get("/api/sops", requireAuth, requireLevel('admin'), (req, res) => {
    const rows = db.prepare('SELECT * FROM sops').all();
    return res.json(rows);
  });

  app.post("/api/sops", requireAuth, requireLevel('admin'), (req, res) => {
    const session = (req as any).session as Session;
    const { account_id, sop_text, is_locked } = req.body;
    const last_modified_by = session.email;

    if (!account_id || typeof sop_text !== 'string' || typeof is_locked !== 'boolean') {
      return res.status(400).json({ error: "Invalid request body" });
    }

    // Only Super Admin can unlock/modify when SOP is currently locked.
    if (sop_text.length > 2_000_000) {
      return res.status(400).json({ error: "SOP text too large" });
    }
    
    // Check current lock status
    const current = db.prepare('SELECT is_locked FROM sops WHERE account_id = ?').get(account_id) as { is_locked: number } | undefined;
    
    // If currently locked:
    // - allow only Super Admin to unlock (is_locked must be false)
    // - block any other writes
    if (current && current.is_locked === 1) {
      if (session.role !== 'super_admin' || is_locked !== false) {
        return res.status(403).json({ error: "SOP is locked. Only the Super Admin can unlock it." });
      }
    }

    // UPSERT: insert if missing, update if exists
    db.prepare(`
      INSERT INTO sops (account_id, sop_text, is_locked, last_modified_by, last_modified_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id) DO UPDATE SET
        sop_text = excluded.sop_text,
        is_locked = excluded.is_locked,
        last_modified_by = excluded.last_modified_by,
        last_modified_at = CURRENT_TIMESTAMP
    `).run(account_id, sop_text, is_locked ? 1 : 0, last_modified_by);
    res.json({ success: true });
  });

  // There is no password sign-in: everyone, the Super Admin included, signs in with Google
  // (Meesho Workspace, so its MFA applies). The Super Admin is SUPER_ADMIN_EMAIL.

  const pkt = registerPktRoutes(app, { db, requireAuth, requireLevel, snapshotBackup, count: metrics.count, limit: { rateLimiter, byUser } });
  const admin = registerAdminRoutes(app, {
    db, dataDir: DATA_DIR, dbPath: DB_PATH, requireAuth, requireLevel, count: metrics.count, limit: { rateLimiter, byUser },
    prepareQuestions: pkt.prepare, preparable: pkt.preparable, expireSessions: pkt.expireSessions,
  });
  scheduleBackup = admin.scheduleBackup;
  legacyCleanup(admin.importLegacy);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    admin.startScheduler();
    scheduleBackup();
  });
}

startServer();
