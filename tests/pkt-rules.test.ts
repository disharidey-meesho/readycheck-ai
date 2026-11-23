// PKT rules: timing, retries, refresher cool-down, overdue, old-agent cycles, the question plan
// and the Super Admin's dynamic settings. Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { computeState, questionPlan, periodStart, isChatWebhook, COOL_DOWN_MS, type Attempt } from "../pkt";
import { DEFAULT_CONFIG, releaseLabel, sanitizeConfig } from "../src/app-config";

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const newBatch = { kind: "new" as const, start_date: "2026-11-02" };
const oldBatch = { kind: "old" as const, start_date: "2026-11-02" };
let id = 0;
const attempt = (unit: number, n: number, percent: number, opts: Partial<Attempt> = {}): Attempt => ({
  id: ++id, trainee_id: 1, unit, attempt_no: n, score: 0, total: 20, percent,
  passed: percent >= 85 ? 1 : 0, refresher_done_at: null, created_at: "2026-11-03 12:00:00", legacy: 0, ...opts,
});
const oldAttempt = (unit: number, n: number, percent: number, opts: Partial<Attempt> = {}) => attempt(unit, n, percent, { passed: percent >= 90 ? 1 : 0, ...opts });

test("Day 1 opens at 5 PM IST on the start date", () => {
  assert.equal(computeState(newBatch, [], 3, at("2026-11-02T11:29:00Z")).canStart, false);
  const s = computeState(newBatch, [], 3, at("2026-11-02T11:30:00Z"));
  assert.equal(s.canStart, true);
  assert.equal(s.unitLabel, "Day 1");
  assert.equal(s.threshold, 85);
  assert.equal(s.maxAttempts, 3);
});

test("passing a day unlocks the next one at its own 5 PM", () => {
  const passed = [attempt(1, 1, 90)];
  assert.equal(computeState(newBatch, passed, 3, at("2026-11-02T14:00:00Z")).canStart, false);
  const s = computeState(newBatch, passed, 3, at("2026-11-03T11:30:00Z"));
  assert.equal(s.unitLabel, "Day 2");
  assert.equal(s.canStart, true);
});

test("a fail needs the refresher, then a 4-hour cool-down", () => {
  const failed = [attempt(1, 1, 90), attempt(2, 1, 70)];
  const before = computeState(newBatch, failed, 3, at("2026-11-03T13:00:00Z"));
  assert.equal(before.status, "reattempt");
  assert.equal(before.needsRefresher, true);
  assert.equal(before.canStart, false);

  const done = at("2026-11-03T14:00:00Z");
  const withRefresher = [attempt(1, 1, 90), attempt(2, 1, 70, { refresher_done_at: done })];
  assert.equal(computeState(newBatch, withRefresher, 3, done + COOL_DOWN_MS - 60_000).canStart, false);
  const open = computeState(newBatch, withRefresher, 3, done + COOL_DOWN_MS);
  assert.equal(open.canStart, true);
  assert.equal(open.attemptNo, 2);
});

test("three fails on a day is an Exit", () => {
  const r = at("2026-11-03T14:00:00Z");
  const s = computeState(newBatch, [attempt(1, 1, 90), attempt(2, 1, 70, { refresher_done_at: r }), attempt(2, 2, 80, { refresher_done_at: r }), attempt(2, 3, 84)], 3, r + 10 * H);
  assert.equal(s.status, "exit");
  assert.equal(s.exitReason, "failed");
});

test("85% on any attempt passes the day; all days passed = passed", () => {
  const r = at("2026-11-03T14:00:00Z");
  const s = computeState(newBatch, [attempt(1, 1, 90), attempt(2, 1, 70, { refresher_done_at: r }), attempt(2, 2, 85), attempt(3, 1, 95)], 3, at("2026-11-05T00:00:00Z"));
  assert.equal(s.status, "passed");
});

test("proctoring is gone: an old 'proctoring' exit no longer locks the agent", () => {
  const s = computeState(newBatch, [attempt(1, 1, 95)], 3, at("2026-11-03T12:00:00Z"), "proctoring");
  assert.notEqual(s.status, "exit");
  assert.equal(s.unitLabel, "Day 2");
  assert.equal(s.canStart, true);
});

// ── dynamic settings ─────────────────────────────────────────────────────────

test("pass mark, attempts and opening time follow the settings", () => {
  const cfg = { ...DEFAULT_CONFIG, passMarkNew: 70, attemptsNew: 2, releaseTimeIst: "09:30" };
  // 09:30 IST = 04:00 UTC
  assert.equal(computeState(newBatch, [], 3, at("2026-11-02T03:59:00Z"), null, cfg).canStart, false);
  const s = computeState(newBatch, [], 3, at("2026-11-02T04:00:00Z"), null, cfg);
  assert.equal(s.canStart, true);
  assert.equal(s.threshold, 70);
  assert.equal(s.maxAttempts, 2);
  // 2 attempts: a second fail is an Exit
  const r = at("2026-11-02T06:00:00Z");
  const two = [attempt(1, 1, 60, { passed: 0, refresher_done_at: r }), attempt(1, 2, 65, { passed: 0 })];
  assert.equal(computeState(newBatch, two, 3, r + 10 * H, null, cfg).status, "exit");
});

test("refresher optional: the waiting time counts from the fail", () => {
  const cfg = { ...DEFAULT_CONFIG, refresherRequired: false, coolDownHours: 2 };
  const failed = [attempt(1, 1, 60, { created_at: "2026-11-02 12:00:00" })];
  const waiting = computeState(newBatch, failed, 3, at("2026-11-02T13:30:00Z"), null, cfg);
  assert.equal(waiting.needsRefresher, false);
  assert.equal(waiting.canStart, false);
  assert.equal(waiting.reattemptAt, at("2026-11-02T14:00:00Z"));
  assert.equal(computeState(newBatch, failed, 3, at("2026-11-02T14:00:00Z"), null, cfg).canStart, true);
  // no waiting time at all
  assert.equal(computeState(newBatch, failed, 3, at("2026-11-02T12:00:01Z"), null, { ...cfg, coolDownHours: 0 }).canStart, true);
});

test("production cycle and overdue limits follow the settings", () => {
  const cfg = { ...DEFAULT_CONFIG, productionCycleDays: 7, overdueOldDays: 1 };
  const passed = computeState(oldBatch, [oldAttempt(1, 1, 92)], 3, at("2026-11-05T00:00:00Z"), null, cfg);
  assert.equal(passed.nextPktAt, at("2026-11-09T11:30:00Z"));
  assert.equal(computeState(oldBatch, [], 3, at("2026-11-03T12:00:00Z"), null, cfg).overdue, true);
  assert.equal(computeState(newBatch, [], 3, at("2026-11-02T20:00:00Z"), null, { ...DEFAULT_CONFIG, overdueNewHours: 6 }).overdue, true);
});

test("question plan follows the question count", () => {
  const total = (p: Array<{ count: number }>) => p.reduce((s, x) => s + x.count, 0);
  for (const n of [5, 12, 30]) {
    for (let d = 1; d <= 5; d++) assert.equal(total(questionPlan("new", d, 5, n)), n, `new ${d}/5 with ${n}`);
    assert.equal(total(questionPlan("old", 1, 5, n)), n);
  }
  assert.deepEqual(questionPlan("new", 3, 5, 12), [{ day: 2, count: 3 }, { day: 3, count: 9 }]);
});

test("settings are cleaned: bad values fall back, numbers are kept in range", () => {
  const c = sanitizeConfig({ passMarkNew: 150, attemptsOld: 0, releaseTimeIst: "25:00", featureLeaderboard: "yes", testMinutes: 30.4, unknown: 1 });
  assert.equal(c.passMarkNew, 100);
  assert.equal(c.attemptsOld, 1);
  assert.equal(c.releaseTimeIst, DEFAULT_CONFIG.releaseTimeIst);
  assert.equal(c.featureLeaderboard, true);
  assert.equal(c.testMinutes, 30);
  assert.equal("unknown" in c, false);
  assert.equal(releaseLabel({ ...DEFAULT_CONFIG, releaseTimeIst: "17:00" }), "5 PM");
  assert.equal(releaseLabel({ ...DEFAULT_CONFIG, releaseTimeIst: "09:30" }), "9:30 AM");
});

test("overdue after 24 hours untaken, and after 24 hours with the refresher pending", () => {
  assert.equal(computeState(newBatch, [], 3, at("2026-11-03T11:00:00Z")).overdue, false);
  assert.equal(computeState(newBatch, [], 3, at("2026-11-03T11:31:00Z")).overdue, true);
  const failed = [attempt(1, 1, 60, { created_at: "2026-11-02 12:00:00" })];
  assert.equal(computeState(newBatch, failed, 3, at("2026-11-03T11:00:00Z")).overdue, false);
  assert.equal(computeState(newBatch, failed, 3, at("2026-11-03T12:30:00Z")).overdue, true);
  // during the cool-down the wait is on the system, not the agent
  const cooling = [attempt(1, 1, 60, { created_at: "2026-11-02 12:00:00", refresher_done_at: at("2026-11-03T12:00:00Z") })];
  assert.equal(computeState(newBatch, cooling, 3, at("2026-11-03T13:00:00Z")).overdue, false);
});

test("imported old-system agents are closed history: nothing to take, never overdue", () => {
  const s = computeState(newBatch, [attempt(1, 1, 40, { legacy: 1 })], 3, at("2026-12-01T12:00:00Z"), "legacy");
  assert.equal(s.status, "exit");
  assert.equal(s.exitReason, "legacy");
  assert.equal(s.canStart, false);
  assert.equal(s.overdue, false);
});

test("a reattempt is not overdue the moment its cool-down ends", () => {
  // fail 18:00 IST, refresher done 20.5 h later, cool-down ends 4 h after that
  const failedAt = "2026-11-02 12:30:00";
  const done = at("2026-11-03T09:00:00Z");
  const a = [attempt(1, 1, 60, { created_at: failedAt, refresher_done_at: done })];
  assert.equal(computeState(newBatch, a, 3, done + COOL_DOWN_MS + 60_000).overdue, false);
  assert.equal(computeState(newBatch, a, 3, done + COOL_DOWN_MS + 25 * H).overdue, true);
});

test("legacy (imported) attempts never count toward today's rules", () => {
  const s = computeState(newBatch, [attempt(1, 1, 10, { legacy: 1 }), attempt(1, 2, 10, { legacy: 1 }), attempt(1, 3, 10, { legacy: 1 })], 3, at("2026-11-02T12:00:00Z"));
  assert.equal(s.status, "not_started");
  assert.equal(s.canStart, true);
});

test("old agents: 90% pass mark, a PKT every 14 days, one reattempt", () => {
  const first = computeState(oldBatch, [], 3, at("2026-11-02T11:30:00Z"));
  assert.equal(first.canStart, true);
  assert.equal(first.threshold, 90);
  assert.equal(first.maxAttempts, 2);
  const passed = computeState(oldBatch, [oldAttempt(1, 1, 92)], 3, at("2026-11-05T00:00:00Z"));
  assert.equal(passed.status, "passed");
  assert.equal(passed.nextPktAt, at("2026-11-16T11:30:00Z"));
  assert.equal(computeState(oldBatch, [oldAttempt(1, 1, 92)], 3, at("2026-11-16T11:30:00Z")).unitLabel, "PKT 2");
  assert.equal(computeState(oldBatch, [oldAttempt(1, 1, 89), oldAttempt(1, 2, 80)], 3, at("2026-11-05T00:00:00Z")).status, "exit");
});

test("old agents: a missed fortnight is counted and the current PKT is overdue after 3 days", () => {
  const s = computeState(oldBatch, [], 3, at("2026-11-20T12:00:00Z"));
  assert.equal(s.unitLabel, "PKT 2");
  assert.equal(s.missedPkts, 1);
  assert.equal(s.overdue, true);
});

test("question plan: 20 questions, day-wise mix", () => {
  const total = (p: Array<{ count: number }>) => p.reduce((s, x) => s + x.count, 0);
  for (let days = 1; days <= 10; days++) {
    for (let d = 1; d <= days; d++) assert.equal(total(questionPlan("new", d, days)), 20, `new ${d}/${days}`);
    assert.equal(total(questionPlan("old", 1, days)), 20, `old ${days}`);
  }
  assert.deepEqual(questionPlan("new", 1, 5), [{ day: 1, count: 20 }]);
  assert.deepEqual(questionPlan("new", 3, 5), [{ day: 2, count: 5 }, { day: 3, count: 15 }]);
  assert.equal(questionPlan("new", 5, 5).length, 5);
});

test("leaderboard periods start on IST Monday / the 1st", () => {
  const wed = at("2026-11-04T10:00:00Z");
  assert.equal(new Date(periodStart("week", wed)).toISOString(), "2026-11-01T18:30:00.000Z");
  assert.equal(new Date(periodStart("month", wed)).toISOString(), "2026-10-31T18:30:00.000Z");
});

test("only Google Chat webhook URLs are accepted", () => {
  assert.equal(isChatWebhook("https://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=abc-DEF_1&token=xyz%3D"), true);
  assert.equal(isChatWebhook("https://evil.example.com/v1/spaces/AAAA/messages?key=x"), false);
  assert.equal(isChatWebhook("http://chat.googleapis.com/v1/spaces/AAAA/messages?key=x"), false);
  assert.equal(isChatWebhook("https://chat.googleapis.com.evil.com/v1/spaces/AAAA/messages?key=x"), false);
});
