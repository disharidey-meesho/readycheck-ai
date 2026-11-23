// Admin-side services: Google Drive (SOP + training manual sync, backup copies), Google Chat
// notifications, database backups that never touch the live database, the one-time import of
// the old system's data, and the background scheduler that runs them.
import type BetterSqlite3 from "better-sqlite3";
import Database from "better-sqlite3";
import type express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { planTrainingDays, extractPdfText, extractSopTopics } from "./src/services/geminiService";
import { splitSopSections, sliceManualByDay } from "./sop-sections";
import type { rateLimiter, byUser } from "./rate-limit";
import { computeState, getConfig, istDate, isChatWebhook, opensAt, pktData, rulesFor, weekOfMonth, type Batch, type Kind } from "./pkt";

type Role = "agent" | "trainer" | "admin" | "super_admin";
const DAY_MS = 86_400_000;
const MAX_TRAINING_DAYS = 10;

interface Deps {
  db: BetterSqlite3.Database;
  dataDir: string;
  dbPath: string;
  requireAuth: express.RequestHandler;
  requireLevel: (min: Role) => express.RequestHandler;
  count: (name: string, help?: string, labels?: Record<string, string>) => void;
  prepareQuestions: (traineeId: number) => Promise<void>;
  preparable: (traineeId: number) => unknown;
  expireSessions: () => void;
  limit: { rateLimiter: typeof rateLimiter; byUser: typeof byUser };
}

// ── settings (app_meta) and the encrypted Drive token ────────────────────────

function settings(db: BetterSqlite3.Database) {
  const get = (key: string) => (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const set = (key: string, value: string | null) => {
    if (value === null) db.prepare("DELETE FROM app_meta WHERE key = ?").run(key);
    else db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)").run(key, value);
  };
  return { get, set };
}

// the refresh token is encrypted with a key derived from the OAuth client secret
const tokenKey = () => crypto.createHash("sha256").update(`${process.env.GOOGLE_CLIENT_SECRET || ""}:readycheck-drive`).digest();
function seal(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function unseal(sealed: string): string | null {
  try {
    const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", tokenKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const DRIVE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

// Drive is connected by the Super Admin with a verified @meesho.com account (checked in the OAuth
// callback). drive.readonly is used only for files inside the one SOP folder the Super Admin
// approves in Settings: every file's folder is checked before anything in it is read.
export function saveDriveConnection(db: BetterSqlite3.Database, refreshToken: string, email: string, by: string) {
  const s = settings(db);
  s.set("drive_refresh_token", seal(refreshToken));
  s.set("drive_connected_email", email);
  s.set("drive_connected_by", by);
  s.set("drive_connected_at", String(Date.now()));
}

// ── Google Drive ─────────────────────────────────────────────────────────────

function drive(db: BetterSqlite3.Database) {
  const s = settings(db);
  const connected = () => !!s.get("drive_refresh_token");

  const accessToken = async (): Promise<string> => {
    const sealed = s.get("drive_refresh_token");
    const refresh = sealed ? unseal(sealed) : null;
    if (!refresh) throw new Error("Google Drive is not connected. An admin needs to click “Connect Google Drive” in Settings.");
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    client.setCredentials({ refresh_token: refresh });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Google Drive refused the saved connection. Please reconnect Google Drive in Settings.");
    return token;
  };

  const call = async (url: string, init: RequestInit = {}) => {
    const token = await accessToken();
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404) throw new Error("File not found. Check the link and that the connected Google account can open it.");
      if (res.status === 403) throw new Error("The connected Google account doesn't have access to this file.");
      throw new Error(`Google Drive answered ${res.status}: ${body.slice(0, 160)}`);
    }
    return res;
  };

  const meta = async (id: string) =>
    (await (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`)).json()) as {
      id: string; name: string; mimeType: string; modifiedTime: string;
    };

  // the folders a file sits in, walking up to the top of its drive
  const insideFolder = async (id: string, folderId: string) => {
    let level = [id];
    const seen = new Set<string>();
    for (let depth = 0; depth < 12 && level.length; depth++) {
      const next: string[] = [];
      for (const fid of level) {
        if (seen.has(fid)) continue;
        seen.add(fid);
        const r = (await (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fid)}?fields=parents&supportsAllDrives=true`)).json()) as { parents?: string[] };
        for (const p of r.parents ?? []) {
          if (p === folderId) return true;
          next.push(p);
        }
      }
      level = next;
    }
    return false;
  };

  const folderMeta = async (id: string) =>
    (await (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`)).json()) as { id: string; name: string; mimeType: string };

  const text = async (id: string, mimeType: string) => {
    if (mimeType === "application/vnd.google-apps.document" || mimeType === "application/vnd.google-apps.presentation") {
      return (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/plain`)).text();
    }
    if (mimeType.startsWith("text/")) {
      return (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)).text();
    }
    throw new Error("Only Google Docs and Google Slides can be synced. Open the file in Google Drive and use File → Save as Google Docs / Slides.");
  };

  const backupFolder = async () => {
    const q = encodeURIComponent("name = 'ReadyCheck backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
    const found = (await (await call(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`)).json()) as { files: { id: string }[] };
    if (found.files?.[0]) return found.files[0].id;
    const created = (await (await call("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ReadyCheck backups", mimeType: "application/vnd.google-apps.folder" }),
    })).json()) as { id: string };
    return created.id;
  };

  const upload = async (filePath: string, name: string) => {
    const folder = await backupFolder();
    const boundary = `rc${crypto.randomBytes(8).toString("hex")}`;
    const metaPart = JSON.stringify({ name, parents: [folder] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaPart}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fs.readFileSync(filePath),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  };

  return { connected, meta, text, upload, insideFolder, folderMeta };
}

export function folderIdFromUrl(url: string): string | null {
  const m = url.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

export function fileIdFromUrl(url: string): string | null {
  const m = url.match(/\/d\/([A-Za-z0-9_-]{20,})/) || url.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}

// ── backups: online copies of the live database, never touching it ───────────

// Copies that leave the live database never hold sign-in sessions, PKT test sessions (their answer
// keys) or the Drive connection; VACUUM rewrites the file so the deleted rows are really gone.
function scrub(file: string) {
  const copy = new Database(file);
  try {
    for (const t of ["sessions", "pkt_sessions"]) {
      if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) copy.exec(`DELETE FROM ${t}`);
    }
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get()) {
      copy.prepare("DELETE FROM app_meta WHERE key IN ('drive_refresh_token')").run();
    }
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

function backups(db: BetterSqlite3.Database, dataDir: string, dbPath: string) {
  const dir = path.join(dataDir, "backups");
  const KEEP = 30;
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const list = () => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /^readycheck-\d{8}-\d{6}\.db$/.test(f))
      .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size, created_at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.created_at - a.created_at);
  };

  const snapshot = async (): Promise<string> => {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(Date.now() + 5.5 * 3600_000).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const file = path.join(dir, `readycheck-${stamp}.db`);
    // SQLite's online backup API copies page by page while the app keeps running
    await db.backup(file);
    scrub(file);
    fs.copyFileSync(file, `${dbPath}.bak`);
    for (const old of list().slice(KEEP)) fs.rmSync(path.join(dir, old.name), { force: true });
    last = Date.now();
    return file;
  };

  // called after every change; takes at most one snapshot every 15 minutes
  const schedule = () => {
    if (timer || running) return;
    const wait = Math.max(0, last + 15 * 60_000 - Date.now());
    timer = setTimeout(async () => {
      timer = null;
      running = true;
      try { await snapshot(); } catch (err) { console.error("[backup] snapshot failed:", (err as Error).message); }
      finally { running = false; }
    }, wait);
    timer.unref?.();
  };

  return { dir, list, snapshot, schedule };
}

// ── the one-time import of the old system's data ─────────────────────────────

function importLegacy(db: BetterSqlite3.Database, src: BetterSqlite3.Database) {
  const has = (table: string) => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const cols = (table: string) => (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const out = { pods: 0, sops: 0, admins: 0, agents: 0, results: 0 };

  db.transaction(() => {
    if (has("pods")) {
      const withDays = cols("pods").includes("training_days");
      for (const p of src.prepare(`SELECT name${withDays ? ", training_days" : ""} FROM pods`).all() as any[]) {
        out.pods += db.prepare("INSERT OR IGNORE INTO pods (name, training_days) VALUES (?, ?)").run(p.name, p.training_days ?? 5).changes;
      }
    }
    if (has("sops")) {
      for (const s of src.prepare("SELECT * FROM sops WHERE account_id LIKE '%\\_Day%' ESCAPE '\\' AND length(trim(coalesce(sop_text, ''))) > 0").all() as any[]) {
        const cur = db.prepare("SELECT sop_text FROM sops WHERE account_id = ?").get(s.account_id) as { sop_text: string } | undefined;
        if (cur?.sop_text?.trim()) continue;
        db.prepare(`INSERT INTO sops (account_id, sop_text, is_locked, last_modified_by, last_modified_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET sop_text = excluded.sop_text, is_locked = excluded.is_locked, last_modified_by = excluded.last_modified_by, last_modified_at = excluded.last_modified_at`)
          .run(s.account_id, s.sop_text, s.is_locked ?? 0, s.last_modified_by ?? "imported", s.last_modified_at ?? null);
        out.sops++;
      }
    }
    if (has("user_admins")) {
      for (const u of src.prepare("SELECT email FROM user_admins").all() as any[]) {
        out.admins += db.prepare("INSERT OR IGNORE INTO user_roles (email, role, added_by) VALUES (?, 'admin', 'imported')").run(String(u.email).toLowerCase()).changes;
      }
    }

    // old assignments and results go into one "LEGACY-<pod>" batch per pod; old results are
    // kept for history and analytics but don't count toward today's attempts or Exit rules
    const legacyBatch = (pod: string, start: string) => {
      const batchNo = `LEGACY-${pod.replace(/\s+/g, "")}`;
      let b = db.prepare("SELECT * FROM batches WHERE batch_no = ?").get(batchNo) as Batch | undefined;
      if (!b) {
        db.prepare("INSERT OR IGNORE INTO pods (name) VALUES (?)").run(pod);
        db.prepare("INSERT INTO batches (batch_no, vendor, pod, start_date, kind, created_by) VALUES (?, 'Legacy', ?, ?, 'new', 'imported')").run(batchNo, pod, start);
        b = db.prepare("SELECT * FROM batches WHERE batch_no = ?").get(batchNo) as Batch;
      }
      return b;
    };
    const firstDate = (pod: string) => {
      if (!has("test_results")) return istDate();
      const r = src.prepare("SELECT MIN(date(timestamp)) AS d FROM test_results WHERE account_id = ?").get(pod) as { d: string | null };
      return r.d || istDate();
    };
    const trainee = (pod: string, email: string, name: string | null) => {
      const b = legacyBatch(pod, firstDate(pod));
      const info = db.prepare("INSERT OR IGNORE INTO trainees (batch_id, agent_email, agent_name, exit_reason) VALUES (?, ?, ?, 'legacy')").run(b.id, email.toLowerCase(), name || email);
      if (info.changes) out.agents++;
      return (db.prepare("SELECT id FROM trainees WHERE batch_id = ? AND agent_email = ?").get(b.id, email.toLowerCase()) as { id: number }).id;
    };
    if (has("agent_assignments")) {
      for (const a of src.prepare("SELECT DISTINCT client_name, agent_email, agent_name FROM agent_assignments WHERE agent_email IS NOT NULL").all() as any[]) {
        trainee(a.client_name, a.agent_email, a.agent_name);
      }
    }
    if (has("test_results")) {
      const withDay = cols("test_results").includes("day_no");
      for (const r of src.prepare("SELECT * FROM test_results ORDER BY timestamp").all() as any[]) {
        if (!r.sso_id || !r.account_id || !r.total_questions) continue;
        const tid = trainee(r.account_id, r.sso_id, null);
        const unit = withDay ? r.day_no || 1 : 1;
        const next = ((db.prepare("SELECT MAX(attempt_no) AS m FROM pkt_attempts WHERE trainee_id = ? AND unit = ?").get(tid, unit) as { m: number | null }).m ?? 0) + 1;
        const percent = Math.round((r.score / r.total_questions) * 1000) / 10;
        out.results += db.prepare(`INSERT OR IGNORE INTO pkt_attempts (trainee_id, unit, attempt_no, score, total, percent, passed, details, created_at, legacy)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(tid, unit, next, r.score, r.total_questions, percent, percent >= 90 ? 1 : 0, r.details ?? "[]", r.timestamp ?? null).changes;
      }
    }
  })();
  return out;
}

// ── Google Chat ──────────────────────────────────────────────────────────────

async function postChat(webhook: string, text: string) {
  if (!isChatWebhook(webhook)) throw new Error("Not a Google Chat webhook URL.");
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google Chat answered ${res.status}`);
}

// ── routes and scheduler ─────────────────────────────────────────────────────

export function registerAdminRoutes(app: express.Express, deps: Deps) {
  const { db, dataDir, dbPath, requireAuth, requireLevel, count, prepareQuestions, preparable, expireSessions } = deps;
  const perUser = (name: string, max: number, windowMs = 60 * 60_000) => deps.limit.rateLimiter({ name, max, windowMs, key: deps.limit.byUser });
  const buildLimit = perUser("sop-build", 15);
  const pdfLimit = perUser("pdf-read", 20);
  const sourceLimit = perUser("pod-source", 30);
  const backupLimit = perUser("backup", 20);
  const chatLimit = perUser("chat-test", 20);
  const s = settings(db);
  const d = drive(db);
  const bk = backups(db, dataDir, dbPath);
  const { trainingDaysOf, attemptsOf } = pktData(db);
  const appUrl = () => (process.env.APP_URL || "").replace(/\/$/, "");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pod_sources (
      pod TEXT PRIMARY KEY,
      sop_url TEXT,
      manual_url TEXT,
      sop_modified TEXT,
      manual_modified TEXT,
      last_synced_at INTEGER,
      status TEXT,
      message TEXT,
      set_by TEXT,
      set_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS notifications_sent (
      key TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL
    );
  `);

  for (const col of ["set_by TEXT", "set_at INTEGER"]) {
    try { db.exec(`ALTER TABLE pod_sources ADD COLUMN ${col}`); } catch {}
  }

  // ── SOP + training manual → day-wise SOP ──────────────────────────────────

  const syncing = new Set<string>();

  const setStatus = (pod: string, status: string, message: string) =>
    db.prepare("INSERT INTO pod_sources (pod, status, message) VALUES (?, ?, ?) ON CONFLICT(pod) DO UPDATE SET status = excluded.status, message = excluded.message").run(pod, status, message);

  // One AI call maps the manual's days to numbered SOP sections; each day's SOP is then put
  // together locally from those sections (the SOP's exact wording). Afterwards the topic list
  // for each day is fetched in parallel and question sets are prepared for the pod's agents.
  const applyDays = async (pod: string, sopText: string, manualText: string, by: string) => {
    if (sopText.trim().length < 50) throw new Error("The SOP looks empty.");
    if (manualText.trim().length < 50) throw new Error("The training manual looks empty.");
    const t0 = Date.now();
    const sections = splitSopSections(sopText);
    setStatus(pod, "syncing", `Matching the training manual to ${sections.length} SOP sections…`);
    const days = await planTrainingDays(sections, manualText, MAX_TRAINING_DAYS);
    if (!days.length) throw new Error("Couldn't find day-wise topics in the training manual.");
    const empty = days.filter((d) => !d.sections.length);
    if (empty.length) throw new Error(`Couldn't find the ${empty.map((d) => `Day ${d.day}`).join(", ")} topics (${empty[0].topics.slice(0, 3).join(", ")}) in the SOP.`);
    const byId = new Map(sections.map((s) => [s.id, s.text]));
    const manualParts = sliceManualByDay(manualText, days.map((d) => d.manualStart));
    const dayTexts = days.map((d) => `Day ${d.day}: ${d.title}\nTopics: ${d.topics.join("; ")}\n\n${d.sections.map((id) => byId.get(id)).join("\n\n")}`);

    db.transaction(() => {
      db.prepare("UPDATE pods SET training_days = ? WHERE name = ?").run(days.length, pod);
      for (const [i, day] of days.entries()) {
        db.prepare(`INSERT INTO sops (account_id, sop_text, is_locked, last_modified_by, last_modified_at) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(account_id) DO UPDATE SET sop_text = excluded.sop_text, is_locked = 1, last_modified_by = excluded.last_modified_by, last_modified_at = CURRENT_TIMESTAMP`)
          .run(`${pod}_Day${day.day}`, dayTexts[i], by);
        db.prepare("INSERT OR REPLACE INTO day_training (pod, day, title, topics, content) VALUES (?, ?, ?, ?, ?)")
          .run(pod, day.day, day.title, JSON.stringify(day.topics), manualParts[i] || `${day.title}\n${day.topics.join("\n")}`);
      }
      db.prepare("DELETE FROM day_training WHERE pod = ? AND day > ?").run(pod, days.length);
      // prepared question sets were made from the old SOP
      db.prepare("DELETE FROM pkt_prepared WHERE trainee_id IN (SELECT t.id FROM trainees t JOIN batches b ON b.id = t.batch_id WHERE b.pod = ?)").run(pod);
    })();
    count("sop_syncs_total", "SOP and training manual syncs", { result: "ok" });
    bk.schedule();

    // warm-up in the background: topic names per day (used to tag questions), then question
    // sets for agents whose PKT is open or opens soon
    void (async () => {
      await Promise.all(dayTexts.map(async (text) => {
        const hash = crypto.createHash("sha256").update(text).digest("hex");
        if (db.prepare("SELECT 1 FROM sop_topics WHERE sop_hash = ?").get(hash)) return;
        try {
          const topics = await extractSopTopics(text);
          if (topics.length) db.prepare("INSERT OR IGNORE INTO sop_topics (sop_hash, topics) VALUES (?, ?)").run(hash, JSON.stringify(topics));
        } catch {}
      }));
      const trainees = db.prepare("SELECT t.id FROM trainees t JOIN batches b ON b.id = t.batch_id WHERE b.pod = ? AND t.exit_reason IS NULL").all(pod) as { id: number }[];
      for (const { id } of trainees.slice(0, 6)) if (preparable(id)) await prepareQuestions(id);
    })().catch((err) => console.error("[sync] warm-up:", (err as Error).message));
    return { days: days.length, seconds: Math.round((Date.now() - t0) / 1000) };
  };

  const syncPod = async (pod: string, force: boolean) => {
    if (syncing.has(pod)) return;
    const src = db.prepare("SELECT * FROM pod_sources WHERE pod = ?").get(pod) as any;
    if (!src?.sop_url || !src?.manual_url) return;
    syncing.add(pod);
    try {
      const sopId = fileIdFromUrl(src.sop_url)!;
      const manualId = fileIdFromUrl(src.manual_url)!;
      // nothing is read from a file outside the approved SOP folder (not even its name)
      const folder = s.get("drive_sop_folder_id");
      if (!folder) throw new Error("The Super Admin needs to choose the approved SOP folder in Settings before Google sync can run.");
      const [sopOk, manualOk] = await Promise.all([d.insideFolder(sopId, folder), d.insideFolder(manualId, folder)]);
      if (!sopOk || !manualOk) {
        console.warn(`[sync] ${pod}: refused a file outside the approved SOP folder (set by ${src.set_by || "unknown"})`);
        throw new Error(`Only files inside the approved SOP folder “${s.get("drive_sop_folder_name") || "SOP folder"}” can be synced. Move the ${!sopOk ? "SOP" : "training manual"} into that folder, or upload the files instead.`);
      }
      const [sm, mm] = await Promise.all([d.meta(sopId), d.meta(manualId)]);
      if (!force && src.status === "ok" && sm.modifiedTime === src.sop_modified && mm.modifiedTime === src.manual_modified) return;
      setStatus(pod, "syncing", `Reading "${sm.name}" and "${mm.name}"…`);
      const [sopText, manualText] = await Promise.all([d.text(sopId, sm.mimeType), d.text(manualId, mm.mimeType)]);
      const r = await applyDays(pod, sopText, manualText, `Google sync: ${sm.name}`);
      db.prepare("UPDATE pod_sources SET sop_modified = ?, manual_modified = ?, last_synced_at = ?, status = 'ok', message = ? WHERE pod = ?")
        .run(sm.modifiedTime, mm.modifiedTime, Date.now(), `Synced ${r.days} training day${r.days > 1 ? "s" : ""} from "${mm.name}" in ${r.seconds}s.`, pod);
    } catch (err) {
      console.error("[sync] %s: %s", pod, (err as Error).message);
      count("sop_syncs_total", "SOP and training manual syncs", { result: "error" });
      setStatus(pod, "error", (err as Error).message);
    } finally {
      syncing.delete(pod);
    }
  };

  app.get("/api/admin/pod-sources", requireAuth, requireLevel("admin"), (_req, res) => {
    res.json({
      drive_connected: d.connected(),
      sop_folder: s.get("drive_sop_folder_id") ? { id: s.get("drive_sop_folder_id"), name: s.get("drive_sop_folder_name") } : null,
      sources: db.prepare("SELECT * FROM pod_sources").all(),
    });
  });

  app.put("/api/admin/pod-sources/:pod", requireAuth, requireLevel("admin"), sourceLimit, async (req, res) => {
    const pod = String(req.params.pod);
    if (!db.prepare("SELECT 1 FROM pods WHERE name = ?").get(pod)) return res.status(404).json({ error: "Pod not found." });
    const { sop_url, manual_url } = req.body as { sop_url?: unknown; manual_url?: unknown };
    const check = (u: unknown) => typeof u === "string" && /^https:\/\/(docs|drive)\.google\.com\//.test(u.trim()) && !!fileIdFromUrl(u.trim());
    if (!check(sop_url) || !check(manual_url)) return res.status(400).json({ error: "Paste the Google Docs / Slides links for both the SOP and the training manual." });
    const folder = s.get("drive_sop_folder_id");
    if (!d.connected() || !folder) return res.status(400).json({ error: "Google sync isn't set up yet: the Super Admin connects Google Drive and chooses the approved SOP folder in Settings. You can upload the files instead." });
    const session = (req as any).session as { email: string };
    // the files must be in the approved folder before the link is even saved
    try {
      const ok = await Promise.all([d.insideFolder(fileIdFromUrl(String(sop_url).trim())!, folder), d.insideFolder(fileIdFromUrl(String(manual_url).trim())!, folder)]);
      if (!ok[0] || !ok[1]) {
        console.warn(`[sync] ${pod}: ${session.email} tried a link outside the approved SOP folder`);
        return res.status(403).json({ error: `Only files inside the approved SOP folder “${s.get("drive_sop_folder_name") || "SOP folder"}” can be linked. Move the file there, or upload it instead.` });
      }
    } catch {
      return res.status(403).json({ error: `Only files inside the approved SOP folder “${s.get("drive_sop_folder_name") || "SOP folder"}” can be linked.` });
    }
    db.prepare(`INSERT INTO pod_sources (pod, sop_url, manual_url, status, message, set_by, set_at) VALUES (?, ?, ?, 'pending', 'Waiting for first sync', ?, ?)
      ON CONFLICT(pod) DO UPDATE SET sop_url = excluded.sop_url, manual_url = excluded.manual_url, sop_modified = NULL, manual_modified = NULL, status = 'pending', message = 'Waiting for first sync', set_by = excluded.set_by, set_at = excluded.set_at`)
      .run(pod, String(sop_url).trim(), String(manual_url).trim(), session.email, Date.now());
    console.log(`[sync] ${pod}: links set by ${session.email}`);
    void syncPod(pod, true);
    res.json({ ok: true, message: "Saved. Syncing now — this takes about a minute." });
  });

  app.post("/api/admin/pod-sources/:pod/sync", requireAuth, requireLevel("admin"), buildLimit, (req, res) => {
    const pod = String(req.params.pod);
    if (!d.connected()) return res.status(400).json({ error: "Connect Google Drive in Settings first." });
    void syncPod(pod, true);
    res.json({ ok: true });
  });

  // uploaded PDFs (downloaded from Google) are read by the AI; other formats are read in the browser
  app.post("/api/admin/extract-pdf", requireAuth, requireLevel("admin"), pdfLimit, async (req, res) => {
    const { data } = req.body as { data?: unknown };
    if (typeof data !== "string" || !data.length || data.length > 1_000_000) return res.status(400).json({ error: "Upload a PDF under 700 KB, or download the file as .docx / .pptx instead." });
    if (!Buffer.from(data.slice(0, 16), "base64").toString("latin1").startsWith("%PDF")) return res.status(400).json({ error: "That file isn't a PDF." });
    try {
      const text = await extractPdfText(data);
      if (text.length < 50) return res.status(422).json({ error: "Almost no text was found in this PDF. Download it from Google as .docx instead." });
      res.json({ text });
    } catch (err) {
      console.error("[pdf] extract failed:", (err as Error).message);
      res.status(502).json({ error: "Couldn't read this PDF right now. Try again, or download the file as .docx / .pptx." });
    }
  });

  // without Google Drive: the full SOP and training manual as uploaded files (read to text) or pasted text
  app.post("/api/admin/pod-sources/:pod/paste", requireAuth, requireLevel("admin"), buildLimit, async (req, res) => {
    const pod = String(req.params.pod);
    if (!db.prepare("SELECT 1 FROM pods WHERE name = ?").get(pod)) return res.status(404).json({ error: "Pod not found." });
    const { sop_text, manual_text } = req.body as { sop_text?: unknown; manual_text?: unknown };
    if (typeof sop_text !== "string" || typeof manual_text !== "string") return res.status(400).json({ error: "Paste both the SOP and the training manual." });
    if (syncing.has(pod)) return res.status(409).json({ error: "This pod is already being processed." });
    const session = (req as any).session as { email: string };
    syncing.add(pod);
    setStatus(pod, "syncing", "Reading the SOP and training manual…");
    res.json({ ok: true });
    try {
      const r = await applyDays(pod, sop_text, manual_text, `Uploaded by ${session.email}`);
      db.prepare("UPDATE pod_sources SET last_synced_at = ?, status = 'ok', message = ? WHERE pod = ?").run(Date.now(), `Built ${r.days} training day${r.days > 1 ? "s" : ""} in ${r.seconds}s. Questions are being prepared for this pod's agents.`, pod);
    } catch (err) {
      setStatus(pod, "error", (err as Error).message);
    } finally {
      syncing.delete(pod);
    }
  });

  // ── settings ──────────────────────────────────────────────────────────────

  app.get("/api/admin/settings", requireAuth, requireLevel("admin"), (_req, res) => {
    res.json({
      chat_default_webhook: s.get("chat_default_webhook") ? "set" : null,
      drive_connected: d.connected(),
      drive_connected_email: s.get("drive_connected_email"),
      drive_connected_by: s.get("drive_connected_by"),
      drive_connected_at: Number(s.get("drive_connected_at")) || null,
      sop_folder: s.get("drive_sop_folder_id") ? { id: s.get("drive_sop_folder_id"), name: s.get("drive_sop_folder_name"), set_by: s.get("drive_sop_folder_by") } : null,
      last_drive_backup: s.get("last_drive_backup"),
    });
  });

  app.put("/api/admin/settings", requireAuth, requireLevel("admin"), (req, res) => {
    const { chat_default_webhook } = req.body as { chat_default_webhook?: unknown };
    if (chat_default_webhook !== undefined) {
      if (chat_default_webhook === "" || chat_default_webhook === null) s.set("chat_default_webhook", null);
      else if (isChatWebhook(chat_default_webhook)) s.set("chat_default_webhook", String(chat_default_webhook).trim());
      else return res.status(400).json({ error: "The Google Chat webhook must be a https://chat.googleapis.com/v1/spaces/... URL." });
    }
    bk.schedule();
    res.json({ ok: true });
  });

  app.post("/api/admin/settings/drive/disconnect", requireAuth, requireLevel("super_admin"), (req, res) => {
    for (const k of ["drive_refresh_token", "drive_connected_email", "drive_connected_by", "drive_connected_at"]) s.set(k, null);
    console.log(`[drive] disconnected by ${((req as any).session as { email: string }).email}`);
    res.json({ ok: true });
  });

  // the one Drive folder SOP links may point into (Super Admin)
  app.put("/api/admin/settings/drive/folder", requireAuth, requireLevel("super_admin"), sourceLimit, async (req, res) => {
    const session = (req as any).session as { email: string };
    const { folder_url } = req.body as { folder_url?: unknown };
    if (folder_url === "" || folder_url === null) {
      for (const k of ["drive_sop_folder_id", "drive_sop_folder_name", "drive_sop_folder_by"]) s.set(k, null);
      return res.json({ ok: true });
    }
    const id = typeof folder_url === "string" && /^https:\/\/drive\.google\.com\//.test(folder_url.trim()) ? folderIdFromUrl(folder_url.trim()) : null;
    if (!id) return res.status(400).json({ error: "Paste the link of a Google Drive folder (https://drive.google.com/drive/folders/…)." });
    if (!d.connected()) return res.status(400).json({ error: "Connect Google Drive first." });
    try {
      const f = await d.folderMeta(id);
      if (f.mimeType !== "application/vnd.google-apps.folder") return res.status(400).json({ error: "That link is a file, not a folder." });
      s.set("drive_sop_folder_id", f.id);
      s.set("drive_sop_folder_name", f.name);
      s.set("drive_sop_folder_by", session.email);
      console.log(`[drive] SOP folder set to ${f.id} by ${session.email}`);
      res.json({ ok: true, name: f.name });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/chat/test", requireAuth, requireLevel("admin"), chatLimit, async (req, res) => {
    const { webhook } = req.body as { webhook?: unknown };
    const target = typeof webhook === "string" && webhook ? webhook : s.get("chat_default_webhook");
    if (!target) return res.status(400).json({ error: "Add a Google Chat webhook first." });
    try {
      await postChat(target, `✅ ReadyCheck is connected to this space. PKT reminders will appear here.${appUrl() ? `\n${appUrl()}` : ""}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ── backups (Super Admin) ─────────────────────────────────────────────────

  app.get("/api/admin/backups", requireAuth, requireLevel("super_admin"), (_req, res) => {
    res.json({ backups: bk.list(), drive_connected: d.connected(), last_drive_backup: s.get("last_drive_backup") });
  });

  app.post("/api/admin/backups", requireAuth, requireLevel("super_admin"), backupLimit, async (req, res) => {
    try {
      const file = await bk.snapshot();
      let drive = false;
      if ((req.body as { to_drive?: boolean }).to_drive && d.connected()) {
        await d.upload(file, path.basename(file));
        s.set("last_drive_backup", String(Date.now()));
        drive = true;
      }
      res.json({ ok: true, name: path.basename(file), drive });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/backups/:name/download", requireAuth, requireLevel("super_admin"), backupLimit, (req, res) => {
    const name = String(req.params.name);
    if (!/^readycheck-\d{8}-\d{6}\.db$/.test(name)) return res.status(400).json({ error: "Bad backup name." });
    const file = path.join(bk.dir, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Backup not found." });
    // copies made before sessions were scrubbed are cleaned before they leave the server
    scrub(file);
    console.log(`[backup] ${name} downloaded by ${((req as any).session as { email: string }).email}`);
    count("backup_downloads_total", "backup downloads");
    res.download(file, name);
  });

  // ── old data import (Super Admin) ─────────────────────────────────────────
  // the old readycheck.db is sent in chunks (the platform caps each request at 1 MB)

  const tmpDir = path.join(dataDir, "tmp");
  app.post("/api/admin/legacy/chunk", requireAuth, requireLevel("super_admin"), (req, res) => {
    const { upload_id, index, data } = req.body as { upload_id?: unknown; index?: unknown; data?: unknown };
    if (typeof upload_id !== "string" || !/^[a-f0-9-]{36}$/.test(upload_id) || !Number.isInteger(index) || (index as number) < 0 || (index as number) > 200 || typeof data !== "string") {
      return res.status(400).json({ error: "Bad chunk." });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `${upload_id}.${index}`), Buffer.from(data, "base64"));
    res.json({ ok: true });
  });

  app.post("/api/admin/legacy/import", requireAuth, requireLevel("super_admin"), (req, res) => {
    const { upload_id, total } = req.body as { upload_id?: unknown; total?: unknown };
    if (typeof upload_id !== "string" || !/^[a-f0-9-]{36}$/.test(upload_id) || !Number.isInteger(total) || (total as number) < 1 || (total as number) > 200) {
      return res.status(400).json({ error: "Bad upload." });
    }
    const parts = Array.from({ length: total as number }, (_, i) => path.join(tmpDir, `${upload_id}.${i}`));
    const file = path.join(tmpDir, `${upload_id}.db`);
    try {
      if (parts.some((p) => !fs.existsSync(p))) return res.status(400).json({ error: "Some parts of the file are missing. Please upload again." });
      fs.writeFileSync(file, Buffer.concat(parts.map((p) => fs.readFileSync(p))));
      if (fs.readFileSync(file).subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") return res.status(400).json({ error: "That isn't a ReadyCheck database file (.db)." });
      bk.schedule();
      const src = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const out = importLegacy(db, src);
        res.json({ ok: true, ...out });
      } finally {
        src.close();
      }
    } catch (err) {
      res.status(400).json({ error: `Import failed: ${(err as Error).message}` });
    } finally {
      for (const p of [...parts, file]) fs.rmSync(p, { force: true });
    }
  });

  // ── scheduler ─────────────────────────────────────────────────────────────

  const alreadySent = (key: string) => !!db.prepare("SELECT 1 FROM notifications_sent WHERE key = ?").get(key);
  const markSent = (key: string) => db.prepare("INSERT OR IGNORE INTO notifications_sent (key, sent_at) VALUES (?, ?)").run(key, Date.now());

  const notifyTick = async (now = Date.now()) => {
    const cfg = getConfig();
    if (!cfg.featureChatReleaseMessages && !cfg.featureChatOverdueDigest) return;
    const CYCLE_DAYS = cfg.productionCycleDays;
    const fallback = s.get("chat_default_webhook");
    const batches = db.prepare("SELECT * FROM batches").all() as Batch[];
    const istHour = new Date(now + 5.5 * 3600_000).getUTCHours();
    for (const b of batches) {
      const webhook = b.chat_webhook || fallback;
      if (!webhook) continue;
      const days = trainingDaysOf(b.pod, (b as any).training_days);
      const trainees = db.prepare("SELECT id, agent_name, agent_email, exit_reason FROM trainees WHERE batch_id = ? AND (exit_reason IS NULL OR exit_reason != 'legacy')").all(b.id) as any[];
      if (!trainees.length) continue;
      const states = trainees.map((t) => ({ t, st: computeState(b, attemptsOf(t.id), days, now, t.exit_reason) }));
      const link = appUrl() ? `\nOpen ReadyCheck: ${appUrl()}` : "";
      // "PKT is open" once per unit, only for units that opened in the last 20 hours
      const units = b.kind === "new"
        ? Array.from({ length: days }, (_, i) => ({ unit: i + 1, open: opensAt(b.start_date, i) }))
        : (() => {
            const first = opensAt(b.start_date, 0);
            if (now < first) return [];
            const c = Math.floor((now - first) / (CYCLE_DAYS * DAY_MS)) + 1;
            return [{ unit: c, open: opensAt(b.start_date, (c - 1) * CYCLE_DAYS) }];
          })();
      for (const { unit, open } of cfg.featureChatReleaseMessages ? units : []) {
        if (now < open || now - open > 20 * 3600_000) continue;
        const who = states.filter(({ st }) => st.unit === unit && st.canStart).map(({ t }) => t.agent_name || t.agent_email);
        const key = `open:${b.id}:${unit}`;
        if (!who.length || alreadySent(key)) continue;
        const week = weekOfMonth(istDate(open)).label;
        const title = b.kind === "new" ? `Day ${unit} PKT for the ${week}` : `PKT for the ${week}`;
        const cta = appUrl() ? `👉 <${appUrl()}|Click here to attempt the PKT>` : "Open ReadyCheck to attempt the PKT.";
        try {
          await postChat(webhook, [
            `📢 *${title} has been released.*`,
            `${b.pod} · batch ${b.batch_no} · ${b.vendor}`,
            `${who.length} agent(s): ${who.join(", ")}`,
            "",
            cta,
            `Please take it today. You have ${cfg.testMinutes} minutes for ${cfg.questionsPerPkt} questions. Pass mark: ${rulesFor(b.kind).threshold}%.`,
          ].join("\n"));
          markSent(key);
          count("chat_messages_total", "Google Chat messages sent", { type: "pkt_open" });
        } catch (err) {
          console.error("[chat] %s: %s", b.batch_no, (err as Error).message);
        }
      }
      // morning digest of overdue agents
      if (cfg.featureChatOverdueDigest && istHour >= 10) {
        const late = states.filter(({ st }) => st.overdue).map(({ t, st }) => `${t.agent_name || t.agent_email} (${st.unitLabel}${st.needsRefresher ? ", refresher pending" : ""})`);
        const key = `overdue:${b.id}:${istDate(now)}`;
        if (late.length && !alreadySent(key)) {
          try {
            await postChat(webhook, `⏰ *Overdue PKTs* — ${b.pod} · batch ${b.batch_no}\n${late.join("\n")}${link}`);
            markSent(key);
            count("chat_messages_total", "Google Chat messages sent", { type: "overdue" });
          } catch (err) {
            console.error("[chat] %s: %s", b.batch_no, (err as Error).message);
          }
        }
      }
    }
  };

  // personal question sets for PKTs that are open or open within 6 hours (a few per tick)
  const prepareTick = async (now = Date.now()) => {
    const rows = db.prepare("SELECT t.id FROM trainees t WHERE t.exit_reason IS NULL").all() as { id: number }[];
    const { stateOf } = pktData(db);
    const due = rows.filter(({ id }) => {
      if (!preparable(id)) return false;
      const s = stateOf(id, now);
      if (!s || !s.state.unit) return false;
      if (db.prepare("SELECT 1 FROM pkt_prepared WHERE trainee_id = ? AND unit = ? AND attempt_no = ?").get(id, s.state.unit, s.state.attemptNo)) return false;
      const opens = s.state.reattemptAt ?? s.state.opensAt ?? now;
      return !s.state.needsRefresher && opens - now < 6 * 3600_000;
    });
    for (const { id } of due.slice(0, 4)) await prepareQuestions(id);
  };

  const syncTick = async () => {
    if (!d.connected()) return;
    for (const { pod } of db.prepare("SELECT pod FROM pod_sources WHERE sop_url IS NOT NULL AND manual_url IS NOT NULL").all() as { pod: string }[]) {
      await syncPod(pod, false);
    }
  };

  const driveBackupTick = async () => {
    if (!d.connected()) return;
    const lastAt = Number(s.get("last_drive_backup")) || 0;
    if (istDate(lastAt) === istDate()) return;
    try {
      const file = await bk.snapshot();
      await d.upload(file, path.basename(file));
      s.set("last_drive_backup", String(Date.now()));
    } catch (err) {
      console.error("[backup] Drive copy failed:", (err as Error).message);
    }
  };

  let ticks = 0;
  let running = false;
  const tick = async () => {
    if (running) return; // a slow tick (sync, AI calls) must not overlap the next one
    running = true;
    ticks++;
    try {
      expireSessions();
    } catch (err) {
      console.error("[scheduler] expire:", (err as Error).message);
    }
    for (const [name, fn] of [["notify", notifyTick], ["prepare", prepareTick]] as const) {
      try { await fn(); } catch (err) { console.error("[scheduler] %s: %s", name, (err as Error).message); }
    }
    // Drive sync and backup copy roughly hourly
    if (ticks % 12 === 1) {
      for (const [name, fn] of [["sync", syncTick], ["drive-backup", driveBackupTick]] as const) {
        try { await fn(); } catch (err) { console.error("[scheduler] %s: %s", name, (err as Error).message); }
      }
    }
    running = false;
  };
  const startScheduler = () => {
    setTimeout(tick, 20_000).unref?.();
    setInterval(tick, 5 * 60_000).unref?.();
  };

  return { scheduleBackup: bk.schedule, snapshot: bk.snapshot, startScheduler, importLegacy: (src: BetterSqlite3.Database) => importLegacy(db, src), notifyTick };
}
