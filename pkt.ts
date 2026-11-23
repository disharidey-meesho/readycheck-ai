// PKT (product knowledge test) engine: batches of agents, day-wise / fortnightly tests,
// a timed test, coaching after a fail, reattempts, exit, certificates, the leaderboard and the
// trainer's report.
//
// The numbers below are the defaults; the Super Admin changes them under Dynamic settings
// (src/app-config.ts), and every rule here reads the live value.
// New agents (pre-production): Day N of a batch opens at 5 PM IST on start date + (N-1) days.
//   Pass mark 85%. Below it: coaching, then up to 2 reattempts. Still below after the 2nd: Exit.
// Old agents (production): a PKT opens every 14 days from the start date, 5 PM IST.
//   Pass mark 90%. Below it: coaching, then 1 reattempt. Still below: Exit.
// Cool-down: after a fail the agent must finish the training refresher (the coaching, with
//   every practice question answered correctly); the reattempt unlocks 4 hours later.
// A test left unfinished (closed tab, lost connection) can be resumed until its time runs out;
//   after that it is dropped without using up an attempt.
import type BetterSqlite3 from "better-sqlite3";
import type express from "express";
import crypto from "node:crypto";
import {
  extractSopTopics,
  generatePktQuestions,
  generateCoaching,
  type Question,
  type Coaching,
  type MissedQuestion,
  type PlanPart,
} from "./src/services/geminiService";
import { vendorFromEmail, INTERNAL_VENDOR } from "./src/vendor-email";
import { DEFAULT_CONFIG, CONFIG_FIELDS, hoursLabel, releaseMinutes, sanitizeConfig, type AppConfig } from "./src/app-config";
import { setAiDailyLimit } from "./src/services/geminiService";
import type { rateLimiter, byUser } from "./rate-limit";

export type Kind = "new" | "old";
type Role = "agent" | "trainer" | "admin" | "super_admin";
interface SessionLike { email: string; role: Role; view?: Role }

// ── dynamic settings ─────────────────────────────────────────────────────────

// the live settings: the defaults until the saved ones are loaded (registerPktRoutes)
let current: AppConfig = DEFAULT_CONFIG;
export const getConfig = () => current;
export function setConfig(c: AppConfig) {
  current = c;
  setAiDailyLimit(c.aiDailyCallLimit);
}

export const rulesFor = (kind: Kind, c: AppConfig = current) =>
  kind === "new" ? { threshold: c.passMarkNew, maxAttempts: c.attemptsNew } : { threshold: c.passMarkOld, maxAttempts: c.attemptsOld };
// the default 4-hour cool-down (used by the tests)
export const COOL_DOWN_MS = DEFAULT_CONFIG.coolDownHours * 3600_000;
const coolDownMs = (c: AppConfig) => c.coolDownHours * 3600_000;
const testTimeMs = (c: AppConfig = current) => c.testMinutes * 60_000;
const SUBMIT_GRACE_MS = 3 * 60 * 1000;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface Batch {
  id: number;
  batch_no: string;
  vendor: string;
  pod: string;
  start_date: string;
  kind: Kind;
  chat_webhook?: string | null;
  created_by: string | null;
  created_at: string;
}

interface Trainee {
  id: number;
  batch_id: number;
  agent_email: string;
  agent_name: string | null;
  exited_at: string | null;
  exit_reason: string | null;
  created_at: string;
}

export interface Attempt {
  id: number;
  trainee_id: number;
  unit: number;
  attempt_no: number;
  score: number;
  total: number;
  percent: number;
  passed: number;
  details?: string | null;
  coaching?: string | null;
  refresher_done_at?: number | null;
  duration_ms?: number | null;
  legacy?: number;
  created_at: string;
}

interface GradedQuestion extends Question {
  userAnswer: number;
}

const tryExec = (db: BetterSqlite3.Database, sql: string) => {
  try { db.exec(sql); } catch {}
};

export function initPktSchema(db: BetterSqlite3.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
      vendor TEXT NOT NULL,
      pod TEXT NOT NULL,
      start_date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'new',
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS trainees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      agent_email TEXT NOT NULL COLLATE NOCASE,
      agent_name TEXT,
      exited_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(batch_id, agent_email)
    );
    CREATE TABLE IF NOT EXISTS pkt_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trainee_id INTEGER NOT NULL,
      unit INTEGER NOT NULL,
      attempt_no INTEGER NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      percent REAL NOT NULL,
      passed INTEGER NOT NULL,
      details TEXT,
      coaching TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(trainee_id, unit, attempt_no)
    );
    CREATE TABLE IF NOT EXISTS pkt_sessions (
      token TEXT PRIMARY KEY,
      trainee_id INTEGER NOT NULL,
      unit INTEGER NOT NULL,
      attempt_no INTEGER NOT NULL,
      questions TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- a personal question set prepared ahead of time so "Start" doesn't wait for the AI
    CREATE TABLE IF NOT EXISTS pkt_prepared (
      trainee_id INTEGER NOT NULL,
      unit INTEGER NOT NULL,
      attempt_no INTEGER NOT NULL,
      sop_hash TEXT NOT NULL,
      questions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (trainee_id, unit, attempt_no)
    );
    CREATE TABLE IF NOT EXISTS proctor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trainee_id INTEGER NOT NULL,
      unit INTEGER NOT NULL,
      attempt_no INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ist_date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- fixed topic names per SOP text, so every PKT on that SOP tags mistakes the same way
    CREATE TABLE IF NOT EXISTS sop_topics (
      sop_hash TEXT PRIMARY KEY,
      topics TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- vendors (BPOs) added by the Super Admin; an agent's vendor is read from their email
    CREATE TABLE IF NOT EXISTS vendors (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- which vendors / pods a trainer can see ('*' = all)
    CREATE TABLE IF NOT EXISTS trainer_scopes (
      email TEXT NOT NULL COLLATE NOCASE,
      vendor TEXT NOT NULL,
      pod TEXT NOT NULL,
      PRIMARY KEY (email, vendor, pod)
    );
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      trainee_id INTEGER NOT NULL UNIQUE,
      agent_name TEXT,
      agent_email TEXT NOT NULL,
      vendor TEXT,
      pod TEXT NOT NULL,
      batch_no TEXT,
      training_days INTEGER,
      avg_score REAL,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- what the training manual teaches on each day of a pod (filled by the Google sync)
    CREATE TABLE IF NOT EXISTS day_training (
      pod TEXT NOT NULL,
      day INTEGER NOT NULL,
      title TEXT,
      topics TEXT,
      content TEXT,
      PRIMARY KEY (pod, day)
    );
    CREATE INDEX IF NOT EXISTS idx_trainees_email ON trainees(agent_email);
    CREATE INDEX IF NOT EXISTS idx_attempts_trainee ON pkt_attempts(trainee_id);
    CREATE INDEX IF NOT EXISTS idx_proctor_trainee ON proctor_events(trainee_id, ist_date);
  `);
  tryExec(db, "ALTER TABLE pkt_attempts ADD COLUMN refresher_done_at INTEGER");
  tryExec(db, "ALTER TABLE pkt_attempts ADD COLUMN duration_ms INTEGER");
  tryExec(db, "ALTER TABLE pkt_attempts ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
  tryExec(db, "ALTER TABLE trainees ADD COLUMN exit_reason TEXT");
  tryExec(db, "ALTER TABLE batches ADD COLUMN chat_webhook TEXT");
  // a batch keeps the number of training days its pod had when it was created
  tryExec(db, "ALTER TABLE batches ADD COLUMN training_days INTEGER");
  // vendors already used by batches stay valid
  db.exec("INSERT OR IGNORE INTO vendors (name) SELECT DISTINCT vendor FROM batches WHERE vendor != ''");
  // proctoring was removed: agents it had locked out (Exit – proctoring) can take PKTs again
  db.exec("UPDATE trainees SET exit_reason = NULL, exited_at = NULL WHERE exit_reason = 'proctoring'");
}

// ── dates (all PKT timing is in IST) ─────────────────────────────────────────

export function istDate(ms = Date.now()): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export const todayIST = () => istDate();

export function isDateOnly(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// the PKT opening time (default 5 PM IST = 11:30 UTC) on startDate + offsetDays
export function opensAt(startDate: string, offsetDays: number, c: AppConfig = current): number {
  const [y, m, d] = startDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d + offsetDays, 0, releaseMinutes(c) - 330);
}
const opensAtFor = opensAt;

// start of the IST week (Monday 00:00 IST) / month, as UTC ms
export function periodStart(period: "week" | "month", now = Date.now()): number {
  const ist = new Date(now + IST_OFFSET_MS);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  const startIst = period === "month" ? Date.UTC(y, m, 1) : Date.UTC(y, m, d - ((ist.getUTCDay() + 6) % 7));
  return startIst - IST_OFFSET_MS;
}

// weeks of a month as people say them: days 1–7 are the 1st week, 8–14 the 2nd, … 29–31 the 5th
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
export function weekOfMonth(date: string): { start: string; end: string; label: string } {
  const [y, m, d] = date.split("-").map(Number);
  const w = Math.ceil(d / 7);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${y}-${pad(m)}-${pad((w - 1) * 7 + 1)}`,
    end: `${y}-${pad(m)}-${pad(Math.min(w * 7, last))}`,
    label: `${ordinal(w)} week of ${MONTHS[m - 1]}`,
  };
}

// leaderboard periods: the weeks of the month (1st week = days 1–7, …) and whole months, newest
// first. id "w:YYYY-MM-DD" (the week's first day) or "m:YYYY-MM".
export function leaderboardPeriods(now = Date.now(), weeks = 12, months = 3): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  let day = istDate(now);
  for (let i = 0; i < weeks; i++) {
    const w = weekOfMonth(day);
    out.push({ id: `w:${w.start}`, label: `${w.label} ${w.start.slice(0, 4)}${i === 0 ? " (this week)" : ""}` });
    day = istDate(Date.UTC(+w.start.slice(0, 4), +w.start.slice(5, 7) - 1, +w.start.slice(8, 10) - 1, 12) - IST_OFFSET_MS);
  }
  const [y, m] = istDate(now).split("-").map(Number);
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push({ id: `m:${d.toISOString().slice(0, 7)}`, label: `Whole of ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}${i === 0 ? " (this month)" : ""}` });
  }
  return out;
}

// UTC ms range of a leaderboard period id; anything unknown means this week
export function periodRange(id: string | undefined, now = Date.now()): { from: number; to: number; label: string } {
  const at = (date: string) => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
  const mm = /^m:(\d{4})-(\d{2})$/.exec(id ?? "");
  if (mm) {
    const y = +mm[1], m = +mm[2];
    if (m >= 1 && m <= 12) return { from: Date.UTC(y, m - 1, 1) - IST_OFFSET_MS, to: Date.UTC(y, m, 1) - IST_OFFSET_MS, label: `Whole of ${MONTHS[m - 1]} ${y}` };
  }
  const wm = /^w:(\d{4}-\d{2}-\d{2})$/.exec(id ?? "");
  const w = weekOfMonth(wm && isDateOnly(wm[1]) ? wm[1] : istDate(now));
  return { from: at(w.start), to: at(w.end) + DAY_MS, label: `${w.label} ${w.start.slice(0, 4)}` };
}

const sqliteTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const parseSqliteTime = (s: string) => Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

// ── question plan ────────────────────────────────────────────────────────────

function spread(days: number[], total: number): Array<{ day: number; count: number }> {
  const base = Math.floor(total / days.length);
  let extra = total - base * days.length;
  // remainder goes to the latest days, which the agent has just been trained on
  return days
    .slice()
    .reverse()
    .map((day) => ({ day, count: base + (extra-- > 0 ? 1 : 0) }))
    .reverse()
    .filter((p) => p.count > 0);
}

export function questionPlan(kind: Kind, unit: number, trainingDays: number, total = current.questionsPerPkt) {
  const all = Array.from({ length: trainingDays }, (_, i) => i + 1);
  if (kind === "old") return spread(all, total);
  if (trainingDays === 1 || unit === 1) return [{ day: 1, count: total }];
  if (unit === trainingDays) return spread(all, total);
  // a quarter from the day before (5 of 20), the rest from today
  const fromYesterday = Math.round(total / 4);
  return [
    { day: unit - 1, count: fromYesterday },
    { day: unit, count: total - fromYesterday },
  ];
}

// ── state machine ────────────────────────────────────────────────────────────

export type Status = "not_started" | "in_progress" | "reattempt" | "passed" | "exit";

export const STATUS_LABEL: Record<Status, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  reattempt: "Failed – refresher / reattempt pending",
  passed: "Passed",
  exit: "Exit",
};

export interface UnitState {
  unit: number;
  label: string;
  state: "passed" | "failed" | "open" | "locked" | "upcoming" | "missed";
  opensAt: number;
  best: number | null;
  attempts: number;
}

export interface TraineeState {
  status: Status;
  unit: number | null;
  unitLabel: string;
  canStart: boolean;
  opensAt: number | null;
  attemptNo: number;
  attemptsUsed: number;
  maxAttempts: number;
  threshold: number;
  lastFailedAttemptId: number | null;
  // after a fail: the refresher must be finished, then the reattempt opens at reattemptAt
  needsRefresher: boolean;
  reattemptAt: number | null;
  nextPktAt: number | null;
  // the current PKT has been open too long without being cleared
  overdue: boolean;
  overdueSince: number | null;
  missedPkts: number;
  exitReason: "failed" | "legacy" | null;
  units: UnitState[];
}

export const unitName = (kind: Kind, unit: number) => (kind === "new" ? `Day ${unit}` : `PKT ${unit}`);

export function computeState(
  batch: Pick<Batch, "kind" | "start_date">,
  allAttempts: Attempt[],
  trainingDays: number,
  now = Date.now(),
  exitReason: string | null = null,
  cfg: AppConfig = current
): TraineeState {
  const { threshold, maxAttempts } = rulesFor(batch.kind, cfg);
  const opensAt = (startDate: string, offsetDays: number) => opensAtFor(startDate, offsetDays, cfg);
  const CYCLE_DAYS = cfg.productionCycleDays;
  const attempts = allAttempts.filter((a) => !a.legacy);
  const byUnit = new Map<number, Attempt[]>();
  for (const a of [...attempts].sort((x, y) => x.attempt_no - y.attempt_no)) {
    if (!byUnit.has(a.unit)) byUnit.set(a.unit, []);
    byUnit.get(a.unit)!.push(a);
  }
  const best = (list: Attempt[]) => (list.length ? Math.max(...list.map((a) => a.percent)) : null);
  const units: UnitState[] = [];
  const anyAttempt = attempts.length > 0;
  let missedPkts = 0;

  const result = (status: Status, unit: number | null, extra: Partial<TraineeState> = {}): TraineeState => {
    const list = unit ? byUnit.get(unit) ?? [] : [];
    const last = list.length ? list[list.length - 1] : null;
    const lastFailed = last && !last.passed ? last : null;
    const state: TraineeState = {
      status,
      unit,
      unitLabel: unit ? unitName(batch.kind, unit) : "",
      canStart: false,
      opensAt: null,
      attemptNo: list.length + 1,
      attemptsUsed: list.length,
      maxAttempts,
      threshold,
      lastFailedAttemptId: lastFailed ? lastFailed.id : null,
      needsRefresher: false,
      reattemptAt: null,
      nextPktAt: null,
      overdue: false,
      overdueSince: null,
      missedPkts,
      exitReason: status === "exit" ? (exitReason === "legacy" ? exitReason : "failed") : null,
      units,
      ...extra,
    };
    // cool-down applies only while a reattempt is pending
    if (status === "reattempt" && lastFailed) {
      if (cfg.refresherRequired && !lastFailed.refresher_done_at) {
        state.needsRefresher = true;
        state.canStart = false;
      } else {
        // with the refresher optional, the waiting time counts from the fail
        const from = cfg.refresherRequired ? lastFailed.refresher_done_at! : parseSqliteTime(lastFailed.created_at);
        state.reattemptAt = from + coolDownMs(cfg);
        if (now < state.reattemptAt) state.canStart = false;
      }
    }
    // overdue: the PKT (or the refresher after a fail) has waited too long
    if ((status === "not_started" || status === "in_progress" || status === "reattempt") && state.opensAt && now >= state.opensAt) {
      const limit = batch.kind === "new" ? cfg.overdueNewHours * 3600_000 : cfg.overdueOldDays * DAY_MS;
      const since = !lastFailed ? state.opensAt : state.reattemptAt ?? parseSqliteTime(lastFailed.created_at);
      const waitingOnAgent = !lastFailed || state.needsRefresher || (state.reattemptAt !== null && now >= state.reattemptAt);
      if (waitingOnAgent && now - since > limit) {
        state.overdue = true;
        state.overdueSince = since + limit;
      }
    }
    return state;
  };

  // imported old-system agents are closed: nothing to take, nothing overdue
  if (exitReason === "legacy") {
    for (let d = 1; d <= (batch.kind === "new" ? trainingDays : 1); d++) {
      const list = byUnit.get(d) ?? [];
      units.push({ unit: d, label: unitName(batch.kind, d), state: list.some((a) => a.passed) ? "passed" : "upcoming", opensAt: opensAt(batch.start_date, d - 1), best: best(list), attempts: list.length });
    }
    return result("exit", Math.max(1, ...attempts.map((a) => a.unit)));
  }

  if (batch.kind === "new") {
    let current: number | null = null;
    let exitedAt: number | null = null;
    for (let d = 1; d <= trainingDays; d++) {
      const list = byUnit.get(d) ?? [];
      const open = opensAt(batch.start_date, d - 1);
      const u: UnitState = { unit: d, label: unitName("new", d), state: "upcoming", opensAt: open, best: best(list), attempts: list.length };
      units.push(u);
      if (exitedAt !== null || current !== null) continue;
      if (list.some((a) => a.passed)) { u.state = "passed"; continue; }
      if (list.length >= maxAttempts) { u.state = "failed"; exitedAt = d; continue; }
      current = d;
      u.state = now >= open ? "open" : "locked";
    }
    if (exitedAt !== null) return result("exit", exitedAt);
    if (current === null) return result("passed", trainingDays);
    const list = byUnit.get(current) ?? [];
    const open = opensAt(batch.start_date, current - 1);
    const isOpen = now >= open;
    const status: Status = list.length ? "reattempt" : anyAttempt ? "in_progress" : "not_started";
    return result(status, current, { canStart: isOpen, opensAt: open });
  }

  // old agents: one PKT every CYCLE_DAYS
  const first = opensAt(batch.start_date, 0);
  if (now < first) {
    units.push({ unit: 1, label: unitName("old", 1), state: "locked", opensAt: first, best: null, attempts: 0 });
    return result("not_started", 1, { opensAt: first });
  }
  const latest = Math.floor((now - first) / (CYCLE_DAYS * DAY_MS)) + 1;
  let current = latest;
  for (let c = 1; c <= latest; c++) {
    const list = byUnit.get(c) ?? [];
    const passed = list.some((a) => a.passed);
    const u: UnitState = { unit: c, label: unitName("old", c), state: "missed", opensAt: opensAt(batch.start_date, (c - 1) * CYCLE_DAYS), best: best(list), attempts: list.length };
    units.push(u);
    if (passed) { u.state = "passed"; continue; }
    if (list.length >= maxAttempts) { u.state = "failed"; return result("exit", c); }
    // a failed PKT must be cleared before the next fortnightly one
    if (list.length > 0 && c < current) current = c;
    if (c === latest) u.state = "open";
    else if (list.length === 0) missedPkts++;
  }
  const list = byUnit.get(current) ?? [];
  const nextPktAt = opensAt(batch.start_date, latest * CYCLE_DAYS);
  if (list.some((a) => a.passed)) {
    return result("passed", current, { nextPktAt });
  }
  units[current - 1].state = "open";
  const status: Status = list.length ? "reattempt" : anyAttempt ? "in_progress" : "not_started";
  return result(status, current, { canStart: true, opensAt: opensAt(batch.start_date, (current - 1) * CYCLE_DAYS), nextPktAt });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fallbackCoaching(missed: MissedQuestion[]): Coaching {
  return {
    summary: "Go through each point below. They are the SOP rules you missed in this attempt. Read the correct steps, then reattempt.",
    focusAreas: missed.slice(0, 8).map((q) => ({
      topic: q.sopPoint || q.category,
      yourMistake: `For "${q.scenario.slice(0, 160)}", you chose "${q.options[q.userAnswer] ?? "no answer"}".`,
      correctSop: `The correct answer is "${q.options[q.correctAnswerIndex]}".`,
      sopExcerpt: q.sopPoint,
      howToHandle: q.explanation,
    })),
    quiz: [],
  };
}

const topicOf = (q: Partial<Question>) => (q.topic || q.sopPoint || q.category || "General").trim();

function parseDetails(raw: string | null | undefined): GradedQuestion[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function sanitizeName(s: unknown, max = 120): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

const isStaff = (s: SessionLike) => s.role === "trainer" || s.role === "admin" || s.role === "super_admin";
const isAdmin = (s: SessionLike) => s.role === "admin" || s.role === "super_admin";

// Google Chat incoming webhook URLs only; anything else could be used to make the server call out
export function isChatWebhook(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[A-Za-z0-9_-]+\/messages\?[A-Za-z0-9_=&%.-]+$/.test(url.trim());
}

// ── data access shared with the scheduler ────────────────────────────────────

export function pktData(db: BetterSqlite3.Database) {
  const podDays = (pod: string) =>
    (db.prepare("SELECT training_days FROM pods WHERE name = ?").get(pod) as { training_days: number } | undefined)?.training_days ?? 5;
  // batches created before per-batch day counts fall back to the pod's
  const trainingDaysOf = (pod: string, batchDays?: number | null) => batchDays || podDays(pod);
  const attemptsOf = (traineeId: number) =>
    db.prepare("SELECT id, trainee_id, unit, attempt_no, score, total, percent, passed, created_at, refresher_done_at, duration_ms, legacy, coaching IS NOT NULL AS has_coaching FROM pkt_attempts WHERE trainee_id = ? ORDER BY unit, attempt_no").all(traineeId) as (Attempt & { has_coaching: number })[];
  const loadTrainee = (id: number) =>
    db.prepare(`
      SELECT t.*, b.batch_no, b.vendor, b.pod, b.start_date, b.kind, b.chat_webhook, b.created_by, b.created_at AS batch_created_at, b.training_days AS batch_days
      FROM trainees t JOIN batches b ON b.id = t.batch_id WHERE t.id = ?
    `).get(id) as (Trainee & Omit<Batch, "id" | "created_at"> & { batch_created_at: string; batch_days: number | null }) | undefined;
  const batchOf = (t: NonNullable<ReturnType<typeof loadTrainee>>): Batch => ({
    id: t.batch_id, batch_no: t.batch_no, vendor: t.vendor, pod: t.pod, start_date: t.start_date,
    kind: t.kind, chat_webhook: t.chat_webhook, created_by: t.created_by, created_at: t.batch_created_at,
  });
  const stateOf = (traineeId: number, now = Date.now()) => {
    const t = loadTrainee(traineeId);
    if (!t) return null;
    return { t, state: computeState(batchOf(t), attemptsOf(t.id), trainingDaysOf(t.pod, t.batch_days), now, t.exit_reason) };
  };
  const dayTraining = (pod: string, day: number) =>
    (db.prepare("SELECT content FROM day_training WHERE pod = ? AND day = ?").get(pod, day) as { content: string } | undefined)?.content || "";
  const hasActiveSession = (traineeId: number) => !!db.prepare("SELECT 1 FROM pkt_sessions WHERE trainee_id = ?").get(traineeId);
  return { trainingDaysOf, podDays, attemptsOf, loadTrainee, batchOf, stateOf, dayTraining, hasActiveSession };
}

// ── question preparation (personal, fresh, ahead of time) ────────────────────

export function questionPrep(db: BetterSqlite3.Database) {
  const { loadTrainee, stateOf, trainingDaysOf, dayTraining, hasActiveSession } = pktData(db);
  // preparations in progress, so Start can wait for one instead of generating a second set
  const preparing = new Map<string, Promise<void>>();
  // a failed preparation is not retried for a while (each try costs several Gemini calls)
  const failedUntil = new Map<string, number>();

  const topicsFor = async (sopText: string): Promise<string[]> => {
    const hash = crypto.createHash("sha256").update(sopText).digest("hex");
    const row = db.prepare("SELECT topics FROM sop_topics WHERE sop_hash = ?").get(hash) as { topics: string } | undefined;
    if (row) return JSON.parse(row.topics);
    try {
      const topics = await extractSopTopics(sopText);
      if (topics.length) db.prepare("INSERT OR IGNORE INTO sop_topics (sop_hash, topics) VALUES (?, ?)").run(hash, JSON.stringify(topics));
      return topics;
    } catch (err) {
      console.error("topic extraction error:", err);
      return [];
    }
  };

  // the SOP parts a PKT draws from; throws a readable error when a day's SOP isn't ready
  const planParts = (pod: string, kind: Kind, unit: number, batchDays?: number | null) => {
    const days = trainingDaysOf(pod, batchDays);
    const parts: Array<{ day: number; sopText: string; count: number; trainingText: string }> = [];
    for (const { day, count } of questionPlan(kind, unit, days)) {
      const sop = db.prepare("SELECT sop_text, is_locked FROM sops WHERE account_id = ?").get(`${pod}_Day${day}`) as { sop_text: string; is_locked: number } | undefined;
      if (!sop?.sop_text?.trim() || sop.is_locked !== 1) {
        throw Object.assign(new Error(`The Day ${day} SOP for ${pod} isn't ready yet. Please ask your admin to finish it.`), { sopMissing: true });
      }
      parts.push({ day, sopText: sop.sop_text, count, trainingText: dayTraining(pod, day) });
    }
    const hash = crypto.createHash("sha256").update(parts.map((p) => p.sopText + "\u0000" + p.trainingText).join("\u0001")).digest("hex");
    return { parts, hash };
  };

  // situations this agent has already seen, plus a few other agents got today for the same PKT
  const avoidFor = (traineeId: number, pod: string, unit: number) => {
    const own = db.prepare("SELECT details FROM pkt_attempts WHERE trainee_id = ? ORDER BY id DESC LIMIT 6").all(traineeId) as { details: string }[];
    const others = db.prepare(`
      SELECT a.details FROM pkt_attempts a JOIN trainees t ON t.id = a.trainee_id JOIN batches b ON b.id = t.batch_id
      WHERE b.pod = ? AND a.unit = ? AND a.trainee_id != ? AND a.created_at >= ? ORDER BY a.id DESC LIMIT 3
    `).all(pod, unit, traineeId, sqliteTime(Date.now() - DAY_MS)) as { details: string }[];
    const pick = (rows: { details: string }[], n: number) => rows.flatMap((r) => parseDetails(r.details).map((q) => q.scenario.slice(0, 140))).slice(0, n);
    return [...pick(own, 60), ...pick(others, 20)];
  };

  const generateFor = async (traineeId: number, unit: number) => {
    const t = loadTrainee(traineeId)!;
    const { parts, hash } = planParts(t.pod, t.kind, unit, t.batch_days);
    const withTopics: PlanPart[] = await Promise.all(parts.map(async (p) => ({ ...p, topics: await topicsFor(p.sopText) })));
    const questions = await generatePktQuestions(withTopics, avoidFor(traineeId, t.pod, unit), t.agent_email);
    if (questions.length < Math.min(10, getConfig().questionsPerPkt)) throw new Error("not enough verified questions");
    return { questions, hash };
  };

  // can a set be prepared right now? (SOP ready, not mid-test, not recently failed)
  const preparable = (traineeId: number) => {
    const s = stateOf(traineeId);
    if (!s || !s.state.unit || s.state.status === "exit" || s.state.status === "passed") return null;
    if (hasActiveSession(traineeId)) return null;
    const key = `${traineeId}:${s.state.unit}:${s.state.attemptNo}`;
    if (preparing.has(key) || (failedUntil.get(key) ?? 0) > Date.now()) return null;
    try {
      planParts(s.t.pod, s.t.kind, s.state.unit, s.t.batch_days);
    } catch {
      return null; // SOP not ready yet
    }
    return { s, key };
  };

  // prepare the next personal question set in the background; safe to call often
  const prepare = async (traineeId: number) => {
    const ready = preparable(traineeId);
    if (!ready) return;
    const { s, key } = ready;
    const { unit, attemptNo } = s.state;
    const existing = db.prepare("SELECT sop_hash FROM pkt_prepared WHERE trainee_id = ? AND unit = ? AND attempt_no = ?").get(traineeId, unit, attemptNo) as { sop_hash: string } | undefined;
    const hash = planParts(s.t.pod, s.t.kind, unit!, s.t.batch_days).hash;
    if (existing && existing.sop_hash === hash) return;
    const job = (async () => {
      try {
        const out = await generateFor(traineeId, unit!);
        db.prepare("INSERT OR REPLACE INTO pkt_prepared (trainee_id, unit, attempt_no, sop_hash, questions, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(traineeId, unit, attemptNo, out.hash, JSON.stringify(out.questions), Date.now());
      } catch (err) {
        failedUntil.set(key, Date.now() + 2 * 3600_000);
        console.error("prepare questions %s: %s", key, (err as Error).message);
      } finally {
        preparing.delete(key);
      }
    })();
    preparing.set(key, job);
    await job;
  };

  // use the prepared set if it is still for the current SOP, otherwise generate now
  const takeQuestions = async (traineeId: number, unit: number, attemptNo: number) => {
    const t = loadTrainee(traineeId)!;
    const { hash } = planParts(t.pod, t.kind, unit, t.batch_days);
    // a background preparation for this exact attempt is running: wait for it rather than start another
    const inFlight = preparing.get(`${traineeId}:${unit}:${attemptNo}`);
    if (inFlight) await inFlight;
    const row = db.prepare("SELECT sop_hash, questions FROM pkt_prepared WHERE trainee_id = ? AND unit = ? AND attempt_no = ?").get(traineeId, unit, attemptNo) as { sop_hash: string; questions: string } | undefined;
    db.prepare("DELETE FROM pkt_prepared WHERE trainee_id = ? AND unit = ? AND attempt_no = ?").run(traineeId, unit, attemptNo);
    if (row && row.sop_hash === hash) return JSON.parse(row.questions) as Question[];
    return (await generateFor(traineeId, unit)).questions;
  };

  return { prepare, preparable, takeQuestions, planParts };
}

// ── trainer scope ────────────────────────────────────────────────────────────

// SQL condition limiting batches (alias b) to what this user may see
export function scopeClause(s: SessionLike, alias = "b"): { sql: string; params: unknown[] } {
  if (isAdmin(s)) return { sql: "1 = 1", params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM trainer_scopes ts WHERE ts.email = ? AND (ts.vendor = '*' OR ts.vendor = ${alias}.vendor COLLATE NOCASE) AND (ts.pod = '*' OR ts.pod = ${alias}.pod))`,
    params: [s.email.toLowerCase()],
  };
}

// ── routes ───────────────────────────────────────────────────────────────────

interface Deps {
  db: BetterSqlite3.Database;
  requireAuth: express.RequestHandler;
  requireLevel: (min: Role) => express.RequestHandler;
  snapshotBackup: () => void;
  count: (name: string, help?: string, labels?: Record<string, string>) => void;
  limit: { rateLimiter: typeof rateLimiter; byUser: typeof byUser };
}

export function registerPktRoutes(app: express.Express, deps: Deps) {
  const { db, requireAuth, requireLevel, snapshotBackup, count } = deps;
  const perUser = (name: string, max: number, windowMs = 60 * 60_000) => deps.limit.rateLimiter({ name, max, windowMs, key: deps.limit.byUser });
  const startLimit = perUser("pkt-start", 30);
  const submitLimit = perUser("pkt-submit", 40);
  const quizLimit = perUser("pkt-quiz", 300);
  const importLimit = perUser("trainer-import", 60);
  const configLimit = perUser("config-save", 60);
  const sessionOf = (req: express.Request) => (req as any).session as SessionLike;
  const { trainingDaysOf, attemptsOf, loadTrainee, batchOf, stateOf, dayTraining } = pktData(db);
  const prep = questionPrep(db);
  // trainees whose Start is still preparing questions (a second Start must not open a second test)
  const starting = new Set<number>();

  // ── dynamic settings (saved in app_meta) ───────────────────────────────────
  const savedConfig = () => {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'app_config'").get() as { value: string } | undefined;
    const base = { ...DEFAULT_CONFIG, aiDailyCallLimit: Number(process.env.GEMINI_DAILY_CALL_LIMIT) || DEFAULT_CONFIG.aiDailyCallLimit };
    try { return sanitizeConfig(row ? JSON.parse(row.value) : {}, base); } catch { return base; }
  };
  setConfig(savedConfig());

  // the settings every signed-in screen needs (nothing secret in them)
  app.get("/api/config", requireAuth, (_req, res) => res.json(getConfig()));

  app.get("/api/admin/config", requireAuth, requireLevel("super_admin"), (_req, res) => {
    const meta = (key: string) => (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
    res.json({ config: getConfig(), defaults: DEFAULT_CONFIG, updated_by: meta("app_config_by"), updated_at: Number(meta("app_config_at")) || null });
  });

  app.put("/api/admin/config", requireAuth, requireLevel("super_admin"), configLimit, (req, res) => {
    const before = getConfig();
    const next = sanitizeConfig((req.body as { config?: unknown })?.config, before);
    const changed = CONFIG_FIELDS.filter((f) => next[f.key] !== before[f.key]).map((f) => `${f.key}: ${before[f.key]} → ${next[f.key]}`);
    const by = sessionOf(req).email;
    db.transaction(() => {
      const put = db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)");
      put.run("app_config", JSON.stringify(next));
      put.run("app_config_by", by);
      put.run("app_config_at", String(Date.now()));
    })();
    setConfig(next);
    // question sets prepared under the old rules (e.g. a different question count) are rebuilt
    if (next.questionsPerPkt !== before.questionsPerPkt) db.prepare("DELETE FROM pkt_prepared").run();
    if (changed.length) console.log("[config] %s changed %d setting(s): %s", by, changed.length, changed.join("; "));
    snapshotBackup();
    res.json({ ok: true, config: next, changed: changed.length });
  });

  // a test left open past its time (and the grace for a slow connection) is dropped; the attempt
  // isn't used up and the agent can start again
  const expireSessions = () => {
    db.prepare("DELETE FROM pkt_sessions WHERE created_at < ?").run(Date.now() - testTimeMs() - SUBMIT_GRACE_MS);
  };

  const canSeeTrainee = (s: SessionLike, traineeId: number) => {
    const { sql, params } = scopeClause(s);
    return !!db.prepare(`SELECT 1 FROM trainees t JOIN batches b ON b.id = t.batch_id WHERE t.id = ? AND ${sql}`).get(traineeId, ...params);
  };
  const canSeeBatch = (s: SessionLike, batchId: number) => {
    const { sql, params } = scopeClause(s);
    return !!db.prepare(`SELECT 1 FROM batches b WHERE b.id = ? AND ${sql}`).get(batchId, ...params);
  };
  const vendorList = () => (db.prepare("SELECT name FROM vendors ORDER BY name COLLATE NOCASE").all() as { name: string }[]).map((v) => v.name);
  const inScope = (s: SessionLike, vendor: string, pod: string) => {
    if (isAdmin(s)) return true;
    return !!db.prepare(`SELECT 1 FROM trainer_scopes WHERE email = ? AND (vendor = '*' OR vendor = ? COLLATE NOCASE) AND (pod = '*' OR pod = ?)`).get(s.email.toLowerCase(), vendor, pod);
  };

  const issueCertificate = (traineeId: number) => {
    const t = loadTrainee(traineeId);
    if (!t || t.kind !== "new") return;
    const avg = (db.prepare("SELECT AVG(percent) AS a FROM pkt_attempts WHERE trainee_id = ? AND passed = 1 AND legacy = 0").get(traineeId) as { a: number | null }).a;
    const id = `RC-${istDate().replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    db.prepare("INSERT OR IGNORE INTO certificates (id, trainee_id, agent_name, agent_email, vendor, pod, batch_no, training_days, avg_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, traineeId, t.agent_name, t.agent_email, t.vendor, t.pod, t.batch_no, trainingDaysOf(t.pod, t.batch_days), avg === null ? null : Math.round(avg * 10) / 10);
  };

  // ── agent ──────────────────────────────────────────────────────────────────

  app.get("/api/my/pkts", requireAuth, (req, res) => {
    const { email } = sessionOf(req);
    const rows = db.prepare(`
      SELECT t.id FROM trainees t JOIN batches b ON b.id = t.batch_id
      WHERE t.agent_email = ? AND (t.exit_reason IS NULL OR t.exit_reason != 'legacy') ORDER BY b.start_date DESC, t.id DESC
    `).all(email) as { id: number }[];
    const out = rows.map(({ id }) => {
      const t = loadTrainee(id)!;
      const attempts = attemptsOf(id);
      const days = trainingDaysOf(t.pod, t.batch_days);
      const state = computeState(batchOf(t), attempts, days, Date.now(), t.exit_reason);
      // warm up the next question set so Start doesn't wait
      if (state.unit && !state.needsRefresher && (state.canStart || ((state.reattemptAt ?? state.opensAt ?? 0) - Date.now() < 6 * 3600_000))) void prep.prepare(id);
      const cert = db.prepare("SELECT id FROM certificates WHERE trainee_id = ?").get(id) as { id: string } | undefined;
      return {
        trainee_id: id,
        batch_no: t.batch_no,
        vendor: t.vendor,
        pod: t.pod,
        kind: t.kind,
        start_date: t.start_date,
        training_days: days,
        state,
        certificate_id: getConfig().featureCertificates ? cert?.id ?? null : null,
        attempts: attempts.filter((a) => !a.legacy).map((a) => ({
          id: a.id, unit: a.unit, attempt_no: a.attempt_no, percent: a.percent,
          passed: !!a.passed, created_at: a.created_at, has_coaching: !!a.has_coaching,
          refresher_done_at: a.refresher_done_at ?? null,
        })),
      };
    });
    res.json({ show_leaderboard: agentLeaderboardOn() && agentLeaderboardBatch(email) !== null, items: out });
  });

  app.post("/api/pkt/start", requireAuth, startLimit, async (req, res) => {
    const { email } = sessionOf(req);
    const traineeId = Number((req.body as { trainee_id?: unknown }).trainee_id);
    const t = Number.isInteger(traineeId) ? loadTrainee(traineeId) : undefined;
    if (!t || t.agent_email.toLowerCase() !== email.toLowerCase()) {
      return res.status(404).json({ error: "PKT not found." });
    }
    if (starting.has(t.id)) return res.status(409).json({ error: "Your PKT is already being prepared. Please wait." });
    expireSessions();

    const state = computeState(batchOf(t), attemptsOf(t.id), trainingDaysOf(t.pod, t.batch_days), Date.now(), t.exit_reason);
    const testPayload = (token: string, startedAt: number, questions: Question[]) => ({
      token,
      unit: state.unit,
      unitLabel: state.unitLabel,
      attemptNo: state.attemptNo,
      maxAttempts: state.maxAttempts,
      threshold: state.threshold,
      pod: t.pod,
      startedAt,
      deadline: startedAt + testTimeMs(),
      // answers and explanations stay on the server until the agent submits
      questions: questions.map((q) => ({ id: q.id, scenario: q.scenario, options: q.options })),
    });

    // a test left unfinished (closed tab, lost connection) carries on with the same questions and
    // the time it had left
    const open = db.prepare("SELECT token, unit, attempt_no, questions, created_at FROM pkt_sessions WHERE trainee_id = ? ORDER BY created_at DESC").get(t.id) as
      | { token: string; unit: number; attempt_no: number; questions: string; created_at: number }
      | undefined;
    if (open) {
      if (open.unit === state.unit && open.attempt_no === state.attemptNo && state.canStart && Date.now() < open.created_at + testTimeMs()) {
        return res.json({ ...testPayload(open.token, open.created_at, JSON.parse(open.questions) as Question[]), resumed: true });
      }
      db.prepare("DELETE FROM pkt_sessions WHERE trainee_id = ?").run(t.id);
    }

    if (!state.canStart || !state.unit) {
      const wait = hoursLabel(getConfig().coolDownHours);
      const error =
        state.status === "exit" ? "You have been marked Exit for this batch."
        : state.needsRefresher ? `Finish your training refresher first. The reattempt opens ${wait === "straight away" ? "as soon as you complete it" : `${wait} after you complete it`}.`
        : state.reattemptAt && Date.now() < state.reattemptAt ? "Your reattempt isn't open yet. Check the time on your PKT page."
        : "This PKT is not open yet.";
      return res.status(409).json({ error, state });
    }

    starting.add(t.id);
    try {
      const questions = await prep.takeQuestions(t.id, state.unit, state.attemptNo);
      const token = crypto.randomUUID();
      const startedAt = Date.now();
      db.prepare("INSERT INTO pkt_sessions (token, trainee_id, unit, attempt_no, questions, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(token, t.id, state.unit, state.attemptNo, JSON.stringify(questions), startedAt);
      return res.json(testPayload(token, startedAt, questions));
    } catch (err: any) {
      if (err?.sopMissing) return res.status(400).json({ error: err.message });
      console.error("pkt start error:", err);
      return res.status(502).json({ error: "Could not prepare your PKT right now. Please try again in a minute." });
    } finally {
      starting.delete(t.id);
    }
  });

  app.post("/api/pkt/submit", requireAuth, submitLimit, async (req, res) => {
    const { email } = sessionOf(req);
    const { token, answers } = req.body as { token?: unknown; answers?: unknown };
    if (typeof token !== "string" || !Array.isArray(answers)) return res.status(400).json({ error: "Invalid submission." });
    const s = db.prepare("SELECT * FROM pkt_sessions WHERE token = ?").get(token) as
      | { token: string; trainee_id: number; unit: number; attempt_no: number; questions: string; created_at: number }
      | undefined;
    if (!s) return res.status(410).json({ error: "This PKT session is no longer active. Please start again from your PKT page." });
    const t = loadTrainee(s.trainee_id);
    if (!t || t.agent_email.toLowerCase() !== email.toLowerCase()) return res.status(404).json({ error: "PKT not found." });

    const elapsed = Date.now() - s.created_at;
    if (elapsed > testTimeMs() + SUBMIT_GRACE_MS) {
      db.prepare("DELETE FROM pkt_sessions WHERE token = ?").run(token);
      return res.status(409).json({ error: "The time limit passed before your answers reached us. This attempt wasn't counted: start the PKT again from your PKT page." });
    }

    const days = trainingDaysOf(t.pod, t.batch_days);
    const state = computeState(batchOf(t), attemptsOf(t.id), days, Date.now(), t.exit_reason);
    if (state.unit !== s.unit || state.attemptNo !== s.attempt_no || state.status === "exit") {
      db.prepare("DELETE FROM pkt_sessions WHERE token = ?").run(token);
      return res.status(409).json({ error: "This attempt was already submitted." });
    }

    const questions = JSON.parse(s.questions) as Question[];
    const graded: GradedQuestion[] = questions.map((q, i) => ({
      ...q,
      userAnswer: Number.isInteger(answers[i]) ? (answers[i] as number) : -1,
    }));
    const score = graded.filter((q) => q.userAnswer === q.correctAnswerIndex).length;
    const total = graded.length;
    const percent = Math.round((score / total) * 1000) / 10;
    const { threshold, maxAttempts } = rulesFor(t.kind);
    const passed = percent >= threshold;
    const exited = !passed && s.attempt_no >= maxAttempts;
    const canReattempt = !passed && !exited;

    let coaching: Coaching | null = null;
    if (canReattempt) {
      const missed: MissedQuestion[] = graded.filter((q) => q.userAnswer !== q.correctAnswerIndex);
      const plan = questionPlan(t.kind, s.unit, days);
      const sopText = plan
        .map(({ day }) => (db.prepare("SELECT sop_text FROM sops WHERE account_id = ?").get(`${t.pod}_Day${day}`) as { sop_text: string } | undefined)?.sop_text || "")
        .join("\n\n");
      const trainingText = plan.map(({ day }) => dayTraining(t.pod, day)).filter(Boolean).join("\n\n");
      try {
        coaching = await generateCoaching(missed, sopText, percent, threshold, trainingText);
        if (!coaching.focusAreas.length) coaching = fallbackCoaching(missed);
      } catch (err) {
        console.error("coaching error:", err);
        coaching = fallbackCoaching(missed);
      }
    }

    const insert = db.transaction(() => {
      const info = db.prepare(
        "INSERT INTO pkt_attempts (trainee_id, unit, attempt_no, score, total, percent, passed, details, coaching, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(t.id, s.unit, s.attempt_no, score, total, percent, passed ? 1 : 0, JSON.stringify(graded), coaching ? JSON.stringify(coaching) : null, Math.min(elapsed, testTimeMs()));
      if (exited) db.prepare("UPDATE trainees SET exited_at = CURRENT_TIMESTAMP, exit_reason = 'failed' WHERE id = ?").run(t.id);
      db.prepare("DELETE FROM pkt_sessions WHERE trainee_id = ?").run(t.id);
      return Number(info.lastInsertRowid);
    });
    let attemptId: number;
    try {
      attemptId = insert();
    } catch {
      return res.status(409).json({ error: "This attempt was already submitted." });
    }
    count("pkt_attempts_total", "PKT attempts submitted", { result: passed ? "passed" : exited ? "exit" : "failed", kind: t.kind });

    const after = computeState(batchOf(t), attemptsOf(t.id), days, Date.now(), null);
    const certificatesOn = getConfig().featureCertificates;
    if (after.status === "passed" && t.kind === "new" && certificatesOn) issueCertificate(t.id);
    snapshotBackup();
    void prep.prepare(t.id);
    const cert = certificatesOn ? db.prepare("SELECT id FROM certificates WHERE trainee_id = ?").get(t.id) as { id: string } | undefined : undefined;
    return res.json({
      attempt_id: attemptId,
      unitLabel: state.unitLabel,
      attemptNo: s.attempt_no,
      maxAttempts,
      threshold,
      score,
      total,
      percent,
      passed,
      exited,
      canReattempt,
      // practice answers stay on the server; the refresher checks them one by one
      coaching: coaching && { ...coaching, quiz: coaching.quiz.map(({ question, options }) => ({ question, options, correctIndex: -1, why: "" })) },
      details: graded,
      next: after,
      certificate_id: cert?.id ?? null,
    });
  });

  // the agent finished the refresher (every practice question answered correctly): the
  // 4-hour cool-down starts now
  app.post("/api/pkt/attempts/:id/refresher-done", requireAuth, (req, res) => {
    const { email } = sessionOf(req);
    const a = db.prepare("SELECT * FROM pkt_attempts WHERE id = ?").get(Number(req.params.id)) as Attempt | undefined;
    const t = a ? loadTrainee(a.trainee_id) : undefined;
    if (!a || !t || t.agent_email.toLowerCase() !== email.toLowerCase()) return res.status(404).json({ error: "Attempt not found." });
    if (a.passed || !a.coaching) return res.status(400).json({ error: "There is no refresher for this attempt." });
    const coaching = JSON.parse(a.coaching) as Coaching;
    const answers = (req.body as { quiz_answers?: unknown }).quiz_answers;
    if (coaching.quiz.length && (!Array.isArray(answers) || coaching.quiz.some((q, i) => answers[i] !== q.correctIndex))) {
      return res.status(400).json({ error: "Answer every practice question correctly before completing the refresher." });
    }
    let doneAt = a.refresher_done_at ?? null;
    if (!doneAt) {
      doneAt = Date.now();
      db.prepare("UPDATE pkt_attempts SET refresher_done_at = ? WHERE id = ? AND refresher_done_at IS NULL").run(doneAt, a.id);
      count("pkt_refreshers_completed_total", "training refreshers completed after a failed PKT", { kind: t.kind });
      snapshotBackup();
    }
    const st = stateOf(t.id)?.state;
    res.json({ ok: true, refresher_done_at: doneAt, reattempt_at: st?.reattemptAt ?? doneAt + coolDownMs(getConfig()) });
  });

  // check one practice answer of a refresher; returns right/wrong and the reason
  app.post("/api/pkt/attempts/:id/quiz-check", requireAuth, quizLimit, (req, res) => {
    const { email } = sessionOf(req);
    const a = db.prepare("SELECT * FROM pkt_attempts WHERE id = ?").get(Number(req.params.id)) as Attempt | undefined;
    const t = a ? loadTrainee(a.trainee_id) : undefined;
    if (!a || !t || t.agent_email.toLowerCase() !== email.toLowerCase() || !a.coaching) return res.status(404).json({ error: "Attempt not found." });
    const { index, answer } = req.body as { index?: unknown; answer?: unknown };
    const q = (JSON.parse(a.coaching) as Coaching).quiz[Number(index)];
    if (!q || !Number.isInteger(answer)) return res.status(400).json({ error: "Bad question." });
    const correct = answer === q.correctIndex;
    res.json({ correct, why: correct ? q.why : null });
  });

  app.get("/api/pkt/attempts/:id", requireAuth, (req, res) => {
    const session = sessionOf(req);
    const a = db.prepare("SELECT * FROM pkt_attempts WHERE id = ?").get(Number(req.params.id)) as Attempt | undefined;
    const t = a ? loadTrainee(a.trainee_id) : undefined;
    const allowed = a && t && (t.agent_email.toLowerCase() === session.email.toLowerCase() || (isStaff(session) && canSeeTrainee(session, t.id)));
    if (!allowed) return res.status(404).json({ error: "Attempt not found." });
    const { threshold, maxAttempts } = rulesFor(t!.kind);
    res.json({
      attempt_id: a!.id,
      unitLabel: unitName(t!.kind, a!.unit),
      attemptNo: a!.attempt_no,
      maxAttempts,
      threshold,
      score: a!.score,
      total: a!.total,
      percent: a!.percent,
      passed: !!a!.passed,
      coaching: (() => {
        if (!a!.coaching) return null;
        const c = JSON.parse(a!.coaching) as Coaching;
        // until the agent has done the refresher, practice answers are checked one by one on the server
        if (!a!.refresher_done_at && t!.agent_email.toLowerCase() === session.email.toLowerCase()) {
          return { ...c, quiz: c.quiz.map(({ question, options }) => ({ question, options, correctIndex: -1, why: "" })) };
        }
        return c;
      })(),
      refresher_done_at: a!.refresher_done_at ?? null,
      reattempt_at: a!.refresher_done_at ? a!.refresher_done_at + coolDownMs(getConfig()) : null,
      details: parseDetails(a!.details),
    });
  });

  app.get("/api/certificates/:id", requireAuth, (req, res) => {
    const session = sessionOf(req);
    const c = db.prepare("SELECT * FROM certificates WHERE id = ?").get(String(req.params.id)) as any;
    const allowed = c && getConfig().featureCertificates && (c.agent_email.toLowerCase() === session.email.toLowerCase() || (isStaff(session) && canSeeTrainee(session, c.trainee_id)));
    if (!allowed) return res.status(404).json({ error: "Certificate not found." });
    res.json(c);
  });

  // leaderboard. Staff filter by agent type, vendor, pod, batch, training start date (new agents),
  // week / month (old agents) and status. New agents see their own batch while they are in training.
  const trainingEnd = (startDate: string, days: number) => istDate(opensAt(startDate, days - 1));
  const agentLeaderboardOn = () => getConfig().featureLeaderboard && getConfig().featureAgentLeaderboard;
  const agentLeaderboardBatch = (email: string, now = Date.now()) => {
    const rows = db.prepare(`
      SELECT b.id, b.pod, b.start_date, b.training_days FROM trainees t JOIN batches b ON b.id = t.batch_id
      WHERE t.agent_email = ? AND b.kind = 'new' AND (t.exit_reason IS NULL OR t.exit_reason != 'legacy')
      ORDER BY b.start_date DESC
    `).all(email) as Array<{ id: number; pod: string; start_date: string; training_days: number | null }>;
    const today = istDate(now);
    return rows.find((b) => b.start_date <= today && today <= trainingEnd(b.start_date, trainingDaysOf(b.pod, b.training_days)))?.id ?? null;
  };

  app.get("/api/leaderboard", requireAuth, (req, res) => {
    const session = sessionOf(req);
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === "string" ? v : undefined])) as Record<string, string | undefined>;
    const staffView = isStaff(session) && session.view !== "agent";
    if (!getConfig().featureLeaderboard || (!staffView && !agentLeaderboardOn())) return res.json({ hidden: true, rows: [] });
    const type: "all" | Kind = staffView && (q.type === "new" || q.type === "old") ? q.type : staffView ? "all" : "new";
    const where: string[] = ["a.legacy = 0"];
    const params: unknown[] = [];
    let window: string;
    if (staffView) {
      const sc = scopeClause(session);
      where.push(sc.sql);
      params.push(...sc.params);
      if (type !== "all") { where.push("b.kind = ?"); params.push(type); }
      if (q.vendor) { where.push("b.vendor = ? COLLATE NOCASE"); params.push(q.vendor); }
      if (q.pod) { where.push("b.pod = ?"); params.push(q.pod); }
      if (q.batch_no) { where.push("b.batch_no = ?"); params.push(q.batch_no); }
      if (type === "new" && q.start_date && isDateOnly(q.start_date)) { where.push("b.start_date = ?"); params.push(q.start_date); }
      if (type === "new") {
        window = q.start_date ? `Training that started ${q.start_date}, Day 1 to the last day` : "Whole training, Day 1 to the last day";
      } else {
        const range = periodRange(q.period);
        where.push("a.created_at >= ? AND a.created_at < ?");
        params.push(sqliteTime(range.from), sqliteTime(range.to));
        window = range.label;
      }
    } else {
      const batchId = agentLeaderboardBatch(session.email);
      if (!batchId) return res.json({ hidden: true, rows: [] });
      where.push("b.id = ?");
      params.push(batchId);
      window = "Your batch, Day 1 to today";
    }
    const raw = db.prepare(`
      SELECT t.id AS trainee_id, t.agent_email, t.agent_name, b.vendor, b.pod, b.batch_no, b.kind, b.start_date,
             COUNT(*) AS attempts, ROUND(AVG(a.percent), 1) AS avg_score, MAX(a.percent) AS best_score,
             SUM(CASE WHEN a.passed = 1 AND a.attempt_no = 1 THEN 1 ELSE 0 END) AS first_try_passes,
             ROUND(AVG(a.duration_ms) / 60000.0, 1) AS avg_minutes
      FROM pkt_attempts a JOIN trainees t ON t.id = a.trainee_id JOIN batches b ON b.id = t.batch_id
      WHERE ${where.join(" AND ")}
      GROUP BY t.id
      ORDER BY avg_score DESC, first_try_passes DESC, avg_minutes ASC
    `).all(...params) as any[];
    const status = staffView && ["active", "passed", "exit"].includes(q.status ?? "") ? q.status : "all";
    const withStatus = raw.map((r) => {
      const st = stateOf(r.trainee_id)!.state;
      const group = st.status === "passed" ? "passed" : st.status === "exit" ? "exit" : "active";
      return { ...r, status: group, status_label: STATUS_LABEL[st.status] };
    }).filter((r) => status === "all" || r.status === status);
    const ranked = withStatus.map(({ trainee_id, ...r }, i) => ({ rank: i + 1, ...r, me: r.agent_email.toLowerCase() === session.email.toLowerCase() }));
    const rows = staffView ? ranked : ranked.map(({ agent_email, ...r }) => r);

    let options = undefined;
    if (staffView) {
      const sc = scopeClause(session);
      const batches = db.prepare(`SELECT batch_no, vendor, pod, start_date, kind FROM batches b WHERE ${sc.sql} ORDER BY start_date DESC`).all(...sc.params) as Batch[];
      const vendors = new Set(vendorList());
      for (const b of batches) vendors.add(b.vendor);
      options = {
        vendors: [...vendors].sort((x, y) => x.localeCompare(y)),
        pods: [...new Set(batches.map((b) => b.pod))].sort(),
        batches: batches.map((b) => ({ batch_no: b.batch_no, vendor: b.vendor, pod: b.pod, kind: b.kind, start_date: b.start_date })),
        start_dates: [...new Set(batches.filter((b) => b.kind === "new").map((b) => b.start_date))],
        periods: leaderboardPeriods(),
      };
    }
    res.json({ type, window, rows, podium: rows.slice(0, 3), options });
  });

  // ── vendors ────────────────────────────────────────────────────────────────

  app.get("/api/vendors", requireAuth, requireLevel("trainer"), (_req, res) => {
    const rows = db.prepare(`
      SELECT v.name, v.created_by, v.created_at,
             (SELECT COUNT(*) FROM batches b WHERE b.vendor = v.name COLLATE NOCASE) AS batches
      FROM vendors v ORDER BY v.name COLLATE NOCASE
    `).all();
    res.json(rows);
  });

  app.post("/api/admin/vendors", requireAuth, requireLevel("super_admin"), (req, res) => {
    const name = sanitizeName((req.body as { name?: unknown })?.name, 60).replace(/\s+/g, " ");
    if (!/[A-Za-z0-9]/.test(name)) return res.status(400).json({ error: "Write the vendor name, e.g. Technotask." });
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const clash = vendorList().find((v) => v.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
    if (clash) return res.status(409).json({ error: `${clash} is already in the list.` });
    db.prepare("INSERT INTO vendors (name, created_by) VALUES (?, ?)").run(name, sessionOf(req).email);
    snapshotBackup();
    res.json({ ok: true, name, email_part: key });
  });

  app.delete("/api/admin/vendors/:name", requireAuth, requireLevel("super_admin"), (req, res) => {
    const name = decodeURIComponent(String(req.params.name));
    const used = db.prepare("SELECT COUNT(*) AS n FROM batches WHERE vendor = ? COLLATE NOCASE").get(name) as { n: number };
    if (used.n) return res.status(409).json({ error: `${name} has ${used.n} batch(es). Move or delete them before removing the vendor.` });
    const info = db.prepare("DELETE FROM vendors WHERE name = ? COLLATE NOCASE").run(name);
    if (!info.changes) return res.status(404).json({ error: "Vendor not found." });
    snapshotBackup();
    res.json({ ok: true });
  });

  // ── trainer: assign ────────────────────────────────────────────────────────

  app.post("/api/trainer/import", requireAuth, requireLevel("trainer"), importLimit, (req, res) => {
    const session = sessionOf(req);
    const { kind, rows, chat_webhook } = req.body as { kind?: unknown; rows?: unknown; chat_webhook?: unknown };
    const cfg = getConfig();
    if (kind !== "new" && kind !== "old") return res.status(400).json({ error: "kind must be new or old." });
    if (kind === "old" && !cfg.featureOldAgents) return res.status(400).json({ error: "Assigning production agents is switched off. Ask the Super Admin." });
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "Add at least one agent." });
    if (rows.length > cfg.maxUploadRows) return res.status(400).json({ error: `Upload at most ${cfg.maxUploadRows} rows at a time.` });
    if (chat_webhook && !isChatWebhook(chat_webhook)) return res.status(400).json({ error: "The Google Chat webhook must be a https://chat.googleapis.com/v1/spaces/... URL." });

    const pods = db.prepare("SELECT name FROM pods").all() as { name: string }[];
    const podByLower = new Map(pods.map((p) => [p.name.toLowerCase(), p.name]));
    // with "any @meesho.com email" on, the internal vendor is always available
    if (cfg.assignAnyMeeshoEmail) db.prepare("INSERT OR IGNORE INTO vendors (name, created_by) VALUES (?, 'system')").run(INTERNAL_VENDOR);
    const vendorNames = vendorList();
    const errors: Array<{ row: number; message: string }> = [];
    let added = 0;
    let alreadyThere = 0;
    const newBatches = new Set<string>();
    const addedIds: number[] = [];

    db.transaction(() => {
      rows.forEach((raw: any, i: number) => {
        const row = i + 1;
        const podIn = sanitizeName(raw?.pod);
        const agentName = sanitizeName(raw?.agent_name);
        const agentEmail = sanitizeName(raw?.agent_email, 200).toLowerCase();
        let startDate = sanitizeName(raw?.start_date, 10);
        let batchNo = sanitizeName(raw?.batch_no, 60);
        const pod = podByLower.get(podIn.toLowerCase());

        if (!agentEmail || !/^[^\s@]+@meesho\.com$/.test(agentEmail)) return errors.push({ row, message: "Agent email must be a valid @meesho.com address." });
        const match = vendorFromEmail(agentEmail, vendorNames);
        if (match.internal && !cfg.assignAnyMeeshoEmail) {
          return errors.push({ row, message: "The email has no vendor from the Vendors list. Use agentname_vendorname@meesho.com, or ask the Super Admin to allow any @meesho.com email." });
        }
        const vendor = match.vendor;
        if (!pod) return errors.push({ row, message: podIn ? `Pod "${podIn}" doesn't exist. Ask an admin to create it first.` : "Pod is missing." });
        if (!inScope(session, vendor, pod)) return errors.push({ row, message: `You don't have access to ${vendor} / ${pod}. Ask an admin to add it to your trainer scope.` });
        if (kind === "old") {
          if (!startDate) startDate = todayIST();
          if (!batchNo) batchNo = `PROD-${pod.replace(/\s+/g, "")}-${startDate}`;
        }
        if (!batchNo) return errors.push({ row, message: "Batch number is missing." });
        if (!isDateOnly(startDate)) return errors.push({ row, message: "Training start date must be a date (YYYY-MM-DD)." });

        let batch = db.prepare("SELECT * FROM batches WHERE batch_no = ?").get(batchNo) as Batch | undefined;
        if (batch) {
          if (batch.kind !== kind || batch.pod !== pod || batch.vendor.toLowerCase() !== vendor.toLowerCase() || batch.start_date !== startDate) {
            return errors.push({ row, message: batch.vendor.toLowerCase() !== vendor.toLowerCase() && batch.pod === pod && batch.start_date === startDate
              ? `Batch ${batch.batch_no} is a ${batch.vendor} batch, but this agent's email says ${vendor}. Use a separate batch number for ${vendor} agents.`
              : `Batch ${batch.batch_no} already exists for ${batch.vendor} / ${batch.pod} starting ${batch.start_date}. Use a new batch number.` });
          }
        } else {
          db.prepare("INSERT INTO batches (batch_no, vendor, pod, start_date, kind, chat_webhook, created_by, training_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(batchNo, vendor, pod, startDate, kind, chat_webhook ? String(chat_webhook).trim() : null, session.email, trainingDaysOf(pod));
          batch = db.prepare("SELECT * FROM batches WHERE batch_no = ?").get(batchNo) as Batch;
          newBatches.add(batch.batch_no);
        }
        const info = db.prepare("INSERT OR IGNORE INTO trainees (batch_id, agent_email, agent_name) VALUES (?, ?, ?)")
          .run(batch.id, agentEmail, agentName || agentEmail);
        if (info.changes) { added++; addedIds.push(Number(info.lastInsertRowid)); }
        else alreadyThere++;
      });
    })();
    if (added) snapshotBackup();
    res.json({ added, already_there: alreadyThere, new_batches: [...newBatches], errors });
  });

  // ── trainer: batch management ──────────────────────────────────────────────

  app.get("/api/trainer/batches", requireAuth, requireLevel("trainer"), (req, res) => {
    const session = sessionOf(req);
    const sc = scopeClause(session);
    const batches = db.prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM trainees t WHERE t.batch_id = b.id) AS agents
      FROM batches b WHERE ${sc.sql} ORDER BY b.start_date DESC, b.batch_no
    `).all(...sc.params) as (Batch & { agents: number })[];
    const out = batches.map((b) => ({
      ...b,
      chat_webhook: b.chat_webhook ? "set" : null,
      trainees: (db.prepare("SELECT id, agent_name, agent_email, exit_reason FROM trainees WHERE batch_id = ? ORDER BY agent_name").all(b.id) as any[]).map((t) => {
        const s = stateOf(t.id)!;
        return { ...t, status: s.state.status, status_label: s.state.exitReason === "legacy" ? "Imported (old system)" : STATUS_LABEL[s.state.status], current: s.state.unitLabel, overdue: s.state.overdue };
      }),
    }));
    res.json(out);
  });

  app.patch("/api/trainer/batches/:id", requireAuth, requireLevel("trainer"), (req, res) => {
    const session = sessionOf(req);
    const id = Number(req.params.id);
    const b = db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as Batch | undefined;
    if (!b || !canSeeBatch(session, id)) return res.status(404).json({ error: "Batch not found." });
    const body = req.body as { batch_no?: unknown; vendor?: unknown; start_date?: unknown; chat_webhook?: unknown };
    const batchNo = body.batch_no === undefined ? b.batch_no : sanitizeName(body.batch_no, 60);
    const vendor = body.vendor === undefined ? b.vendor : sanitizeName(body.vendor);
    const startDate = body.start_date === undefined ? b.start_date : sanitizeName(body.start_date, 10);
    if (!batchNo) return res.status(400).json({ error: "Batch number can't be empty." });
    if (!vendor) return res.status(400).json({ error: "Vendor name can't be empty." });
    const listed = vendorList().find((v) => v.toLowerCase() === vendor.toLowerCase());
    if (!listed) return res.status(400).json({ error: `${vendor} isn't in the vendor list. Ask the Super Admin to add it.` });
    if (!isDateOnly(startDate)) return res.status(400).json({ error: "Start date must be a date (YYYY-MM-DD)." });
    if (!inScope(session, vendor, b.pod)) return res.status(403).json({ error: `You don't have access to ${vendor} / ${b.pod}.` });
    let webhook = b.chat_webhook ?? null;
    if (body.chat_webhook !== undefined) {
      if (body.chat_webhook === "" || body.chat_webhook === null) webhook = null;
      else if (isChatWebhook(body.chat_webhook)) webhook = String(body.chat_webhook).trim();
      else return res.status(400).json({ error: "The Google Chat webhook must be a https://chat.googleapis.com/v1/spaces/... URL." });
    }
    const clash = db.prepare("SELECT 1 FROM batches WHERE batch_no = ? AND id != ?").get(batchNo, id);
    if (clash) return res.status(409).json({ error: `Batch number ${batchNo} is already used.` });
    db.prepare("UPDATE batches SET batch_no = ?, vendor = ?, start_date = ?, chat_webhook = ? WHERE id = ?").run(batchNo, vendor, startDate, webhook, id);
    if (startDate !== b.start_date) db.prepare("DELETE FROM pkt_prepared WHERE trainee_id IN (SELECT id FROM trainees WHERE batch_id = ?)").run(id);
    snapshotBackup();
    res.json({ ok: true });
  });

  // move an agent (with their PKT history) to another batch of the same pod and type
  app.post("/api/trainer/trainees/:id/move", requireAuth, requireLevel("trainer"), (req, res) => {
    const session = sessionOf(req);
    const id = Number(req.params.id);
    const target = Number((req.body as { batch_id?: unknown }).batch_id);
    const t = Number.isInteger(id) ? loadTrainee(id) : undefined;
    const to = db.prepare("SELECT * FROM batches WHERE id = ?").get(target) as Batch | undefined;
    if (!t || !canSeeTrainee(session, id)) return res.status(404).json({ error: "Agent not found." });
    if (!to || !canSeeBatch(session, target)) return res.status(404).json({ error: "Target batch not found." });
    if (to.pod !== t.pod || to.kind !== t.kind) return res.status(400).json({ error: "You can only move an agent to a batch of the same pod and type." });
    if (db.prepare("SELECT 1 FROM trainees WHERE batch_id = ? AND agent_email = ?").get(target, t.agent_email)) {
      return res.status(409).json({ error: "This agent is already in that batch." });
    }
    db.prepare("UPDATE trainees SET batch_id = ? WHERE id = ?").run(target, id);
    db.prepare("DELETE FROM pkt_prepared WHERE trainee_id = ?").run(id);
    snapshotBackup();
    res.json({ ok: true });
  });

  app.delete("/api/trainer/trainees/:id", requireAuth, requireLevel("trainer"), (req, res) => {
    const session = sessionOf(req);
    const id = Number(req.params.id);
    const t = Number.isInteger(id) ? loadTrainee(id) : undefined;
    if (!t || !canSeeTrainee(session, id)) return res.status(404).json({ error: "Agent not found." });
    db.transaction(() => {
      for (const table of ["pkt_sessions", "pkt_prepared", "pkt_attempts", "proctor_events"]) db.prepare(`DELETE FROM ${table} WHERE trainee_id = ?`).run(id);
      db.prepare("DELETE FROM certificates WHERE trainee_id = ?").run(id);
      db.prepare("DELETE FROM trainees WHERE id = ?").run(id);
      db.prepare("DELETE FROM batches WHERE id = ? AND NOT EXISTS (SELECT 1 FROM trainees WHERE batch_id = ?)").run(t.batch_id, t.batch_id);
    })();
    snapshotBackup();
    res.json({ ok: true });
  });

  // ── admin: trainer scope ───────────────────────────────────────────────────

  app.get("/api/admin/trainer-scopes", requireAuth, requireLevel("admin"), (_req, res) => {
    const trainers = db.prepare("SELECT email FROM user_roles WHERE role = 'trainer' ORDER BY email").all() as { email: string }[];
    const vendors = vendorList();
    const pods = (db.prepare("SELECT name FROM pods ORDER BY name").all() as { name: string }[]).map((p) => p.name);
    res.json({
      vendors,
      pods,
      trainers: trainers.map((t) => ({ email: t.email, scopes: db.prepare("SELECT vendor, pod FROM trainer_scopes WHERE email = ? ORDER BY vendor, pod").all(t.email) })),
    });
  });

  app.put("/api/admin/trainer-scopes/:email", requireAuth, requireLevel("admin"), (req, res) => {
    const email = String(req.params.email).trim().toLowerCase();
    const scopes = (req.body as { scopes?: unknown }).scopes;
    if (!db.prepare("SELECT 1 FROM user_roles WHERE email = ? AND role = 'trainer'").get(email)) return res.status(404).json({ error: "That person isn't a Trainer." });
    if (!Array.isArray(scopes) || scopes.length > 200) return res.status(400).json({ error: "scopes must be a list." });
    const clean = scopes.map((s: any) => ({ vendor: sanitizeName(s?.vendor) || "*", pod: sanitizeName(s?.pod) || "*" }));
    db.transaction(() => {
      db.prepare("DELETE FROM trainer_scopes WHERE email = ?").run(email);
      for (const s of clean) db.prepare("INSERT OR IGNORE INTO trainer_scopes (email, vendor, pod) VALUES (?, ?, ?)").run(email, s.vendor, s.pod);
    })();
    snapshotBackup();
    res.json({ ok: true });
  });

  // ── trainer: report and analytics ──────────────────────────────────────────

  app.get("/api/trainer/report", requireAuth, requireLevel("trainer"), (req, res) => {
    const session = sessionOf(req);
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === "string" ? v : undefined])) as Record<string, string | undefined>;
    const sc = scopeClause(session);
    const where: string[] = [sc.sql];
    const params: unknown[] = [...sc.params];
    if (q.kind === "new" || q.kind === "old") { where.push("b.kind = ?"); params.push(q.kind); }
    if (q.vendor) { where.push("b.vendor = ? COLLATE NOCASE"); params.push(q.vendor); }
    if (q.pod) { where.push("b.pod = ?"); params.push(q.pod); }
    if (q.batch_no) { where.push("b.batch_no = ?"); params.push(q.batch_no); }
    if (q.start_date) { where.push("b.start_date = ?"); params.push(q.start_date); }
    if (q.agent) {
      where.push("(t.agent_name LIKE ? ESCAPE '\\' OR t.agent_email LIKE ? ESCAPE '\\')");
      const like = `%${q.agent.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(like, like);
    }
    const trainees = db.prepare(`
      SELECT t.id, t.agent_email, t.agent_name, t.exited_at, t.exit_reason, b.id AS batch_id, b.batch_no, b.vendor, b.pod, b.start_date, b.kind, b.created_by, b.created_at AS batch_created_at, b.training_days AS batch_days
      FROM trainees t JOIN batches b ON b.id = t.batch_id
      WHERE ${where.join(" AND ")}
      ORDER BY b.start_date DESC, b.batch_no, t.agent_name
      LIMIT 5000
    `).all(...params) as any[];

    const statusFilter = q.status;
    const rows: any[] = [];
    const counts: Record<Status | "overdue" | "imported", number> = { not_started: 0, in_progress: 0, reattempt: 0, passed: 0, exit: 0, overdue: 0, imported: 0 };
    let failedOnce = 0;
    const allAttempts: Array<Attempt & { email: string; agent: string; batch_no: string; vendor: string; pod: string }> = [];
    const daysByPod = new Map<string, number>();

    for (const t of trainees) {
      if (!daysByPod.has(t.pod)) daysByPod.set(t.pod, trainingDaysOf(t.pod));
      const days = t.batch_days || daysByPod.get(t.pod)!;
      const attempts = db.prepare("SELECT * FROM pkt_attempts WHERE trainee_id = ? ORDER BY unit, attempt_no").all(t.id) as Attempt[];
      const state = computeState({ kind: t.kind, start_date: t.start_date }, attempts, days, Date.now(), t.exit_reason);
      if (statusFilter === "overdue" ? !state.overdue : statusFilter && state.status !== statusFilter) continue;
      if (state.exitReason === "legacy") counts.imported++;
      else counts[state.status]++;
      if (state.overdue) counts.overdue++;
      if (attempts.some((a) => !a.passed)) failedOnce++;
      const last = attempts.length ? attempts.reduce((x, y) => (x.created_at >= y.created_at ? x : y)) : null;
      const avg = attempts.length ? Math.round((attempts.reduce((s, a) => s + a.percent, 0) / attempts.length) * 10) / 10 : null;
      for (const a of attempts) allAttempts.push({ ...a, email: t.agent_email, agent: t.agent_name || t.agent_email, batch_no: t.batch_no, vendor: t.vendor, pod: t.pod });
      const cert = db.prepare("SELECT id FROM certificates WHERE trainee_id = ?").get(t.id) as { id: string } | undefined;
      rows.push({
        trainee_id: t.id,
        type: t.kind === "new" ? "New (pre-production)" : "Old (production)",
        kind: t.kind,
        vendor: t.vendor,
        pod: t.pod,
        batch_no: t.batch_no,
        start_date: t.start_date,
        agent_name: t.agent_name,
        agent_email: t.agent_email,
        status: state.status,
        status_label: state.exitReason === "legacy" ? "Imported (old system)" : STATUS_LABEL[state.status],
        overdue: state.overdue,
        overdue_since: state.overdueSince,
        missed_pkts: state.missedPkts,
        current: state.unitLabel,
        attempts_used: state.attemptsUsed,
        max_attempts: state.maxAttempts,
        refresher:
          state.status !== "reattempt" ? "" : state.needsRefresher ? "Not done yet"
          : state.reattemptAt && Date.now() < state.reattemptAt ? "Done – cool-down" : "Done – can reattempt",
        reattempt_at: state.reattemptAt,
        certificate_id: getConfig().featureCertificates ? cert?.id ?? null : null,
        avg_score: avg,
        last_score: last ? last.percent : null,
        last_attempt_at: last ? last.created_at : null,
        exited_at: t.exited_at,
        units: state.units.map((u) => ({ label: u.label, best: u.best, attempts: u.attempts, state: u.state })),
      });
    }

    // ── scores, TNI, SOP points, charts ──────────────────────────────────────
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const avgOf = (list: { percent: number }[]) => (list.length ? round1(list.reduce((s, a) => s + a.percent, 0) / list.length) : null);
    const passRate = (list: { passed: number }[]) => (list.length ? round1((list.filter((a) => a.passed).length / list.length) * 100) : null);
    const firstAttempts = allAttempts.filter((a) => a.attempt_no === 1);
    const accuracy = (s: { asked: number; wrong: number }) => round1(((s.asked - s.wrong) / s.asked) * 100);

    const topicStats = new Map<string, { asked: number; wrong: number }>();
    const pointStats = new Map<string, { topic: string; sopPoint: string; asked: number; wrong: number; agents: Set<string>; example: string; commonWrong: Map<string, number> }>();
    const agentTopic = new Map<string, Map<string, { asked: number; wrong: number }>>();
    for (const a of allAttempts) {
      for (const qd of parseDetails(a.details)) {
        const topic = topicOf(qd);
        const wrong = qd.userAnswer !== qd.correctAnswerIndex;
        const ts = topicStats.get(topic) ?? { asked: 0, wrong: 0 };
        ts.asked++; if (wrong) ts.wrong++;
        topicStats.set(topic, ts);
        const perAgent = agentTopic.get(a.email) ?? new Map();
        const at = perAgent.get(topic) ?? { asked: 0, wrong: 0 };
        at.asked++; if (wrong) at.wrong++;
        perAgent.set(topic, at);
        agentTopic.set(a.email, perAgent);
        const key = (qd.sopPoint || topic).trim().toLowerCase().slice(0, 200);
        const ps = pointStats.get(key) ?? { topic, sopPoint: qd.sopPoint || topic, asked: 0, wrong: 0, agents: new Set<string>(), example: qd.scenario, commonWrong: new Map() };
        ps.asked++;
        if (wrong) {
          ps.wrong++;
          ps.agents.add(a.email);
          ps.example = qd.scenario;
          const chosen = qd.options?.[qd.userAnswer];
          if (chosen) ps.commonWrong.set(chosen, (ps.commonWrong.get(chosen) ?? 0) + 1);
        }
        pointStats.set(key, ps);
      }
    }
    const tni = [...topicStats.entries()]
      .map(([topic, s]) => ({ topic, asked: s.asked, wrong: s.wrong, accuracy: accuracy(s) }))
      .sort((x, y) => x.accuracy - y.accuracy || y.wrong - x.wrong);

    const sopPoints = [...pointStats.values()]
      .map((p) => ({
        topic: p.topic, sopPoint: p.sopPoint, asked: p.asked, wrong: p.wrong, accuracy: accuracy(p), agents: p.agents.size,
        example: p.example, common_wrong_answer: [...p.commonWrong.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
      }))
      .sort((x, y) => y.wrong - x.wrong || x.accuracy - y.accuracy);

    const byAgent = new Map<string, typeof allAttempts>();
    for (const a of allAttempts) {
      if (!byAgent.has(a.email)) byAgent.set(a.email, []);
      byAgent.get(a.email)!.push(a);
    }
    const laScores = rows.map((r) => {
      const list = byAgent.get(r.agent_email) ?? [];
      const weak = [...(agentTopic.get(r.agent_email) ?? new Map()).entries()]
        .map(([topic, s]) => ({ topic, accuracy: accuracy(s), wrong: s.wrong }))
        .filter((x) => x.wrong > 0)
        .sort((x, y) => x.accuracy - y.accuracy || y.wrong - x.wrong)
        .slice(0, 3);
      return {
        agent_name: r.agent_name, agent_email: r.agent_email, batch_no: r.batch_no, pod: r.pod,
        attempts: list.length, avg_score: avgOf(list),
        best_score: list.length ? Math.max(...list.map((a) => a.percent)) : null,
        status_label: r.status_label, tni: weak,
      };
    });

    const groupBy = <K extends string>(keyOf: (a: (typeof allAttempts)[number]) => K) => {
      const m = new Map<K, typeof allAttempts>();
      for (const a of allAttempts) {
        const k = keyOf(a);
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(a);
      }
      return m;
    };
    const summarize = <K extends string>(m: Map<K, typeof allAttempts>) =>
      [...m.entries()].map(([label, list]) => ({ label, attempts: list.length, avg_score: avgOf(list), pass_rate: passRate(list) }));
    const trend = summarize(groupBy((a) => istDate(parseSqliteTime(a.created_at)))).sort((x, y) => x.label.localeCompare(y.label)).slice(-30);
    const byUnit = summarize(groupBy((a) => `${rows.find((r) => r.agent_email === a.email)?.kind === "old" ? "PKT" : "Day"} ${a.unit}`)).sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
    const byBatch = summarize(groupBy((a) => a.batch_no)).sort((x, y) => (y.avg_score ?? 0) - (x.avg_score ?? 0));
    const byVendor = summarize(groupBy((a) => a.vendor)).sort((x, y) => (y.avg_score ?? 0) - (x.avg_score ?? 0));

    // agent × SOP area accuracy, for the heatmap
    const heatTopics = tni.slice(0, 8).map((t) => t.topic);
    const heatmap = {
      topics: heatTopics,
      rows: laScores
        .filter((l) => l.attempts > 0)
        .slice(0, 40)
        .map((l) => ({
          agent: l.agent_name,
          cells: heatTopics.map((topic) => {
            const s = agentTopic.get(l.agent_email)?.get(topic);
            return s ? accuracy(s) : null;
          }),
        })),
    };

    const sco = scopeClause(session);
    const options = db.prepare(`SELECT DISTINCT vendor, pod, batch_no, start_date, kind FROM batches b WHERE ${sco.sql} ORDER BY start_date DESC`).all(...sco.params) as Batch[];
    const noScope = !isAdmin(session) && !db.prepare("SELECT 1 FROM trainer_scopes WHERE email = ?").get(session.email.toLowerCase());
    res.json({
      no_scope: noScope,
      rows,
      summary: { total: rows.length, ...counts, failed_once: failedOnce },
      scores: {
        overall_avg: avgOf(allAttempts),
        first_attempt_avg: avgOf(firstAttempts),
        attempts: allAttempts.length,
        pass_rate: passRate(allAttempts),
      },
      la_scores: laScores,
      tni,
      top_issues: sopPoints.filter((p) => p.wrong > 0).slice(0, 10).map((p) => ({ topic: p.topic, sopPoint: p.sopPoint, wrong: p.wrong, agents: p.agents })),
      sop_points: sopPoints.slice(0, 100),
      charts: { trend, by_unit: byUnit, by_batch: byBatch, by_vendor: byVendor, heatmap },
      options: {
        vendors: [...new Set(options.map((o) => o.vendor))],
        pods: [...new Set(options.map((o) => o.pod))],
        batches: options.map((o) => ({ batch_no: o.batch_no, kind: o.kind, vendor: o.vendor, pod: o.pod })),
        start_dates: [...new Set(options.map((o) => o.start_date))],
      },
    });
  });

  return { prepare: prep.prepare, preparable: prep.preparable, expireSessions };
}
