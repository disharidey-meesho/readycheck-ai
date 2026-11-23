// Vendor from agent emails, and the week-of-month periods used by Google Chat and the leaderboard.
import test from "node:test";
import assert from "node:assert/strict";
import { vendorFromEmail, vendorKeyFromEmail } from "../src/vendor-email";
import { weekOfMonth, periodRange, leaderboardPeriods } from "../pkt";

const vendors = ["Technotask", "Teleperformance India", "iEnergizer"];

test("vendor is read from agentname_vendorname@meesho.com", () => {
  assert.equal(vendorKeyFromEmail("babulal.verma_technotask@meesho.com"), "technotask");
  assert.deepEqual(vendorFromEmail("babulal.verma_technotask@meesho.com", vendors), { vendor: "Technotask", internal: false });
  assert.deepEqual(vendorFromEmail("Ravi_Kumar_TeleperformanceIndia@meesho.com", vendors), { vendor: "Teleperformance India", internal: false });
  assert.deepEqual(vendorFromEmail("a.b_i-energizer@meesho.com", vendors), { vendor: "iEnergizer", internal: false });
});

test("any other @meesho.com email is a Meesho agent", () => {
  const meesho = { vendor: "Meesho", internal: true };
  assert.deepEqual(vendorFromEmail("dishari.dey@meesho.com", vendors), meesho);
  assert.deepEqual(vendorFromEmail("_technotask@meesho.com", vendors), meesho);
  assert.deepEqual(vendorFromEmail("ravi_kumar@meesho.com", vendors), meesho);
  assert.deepEqual(vendorFromEmail("x_unknownbpo@meesho.com", vendors), meesho);
});

test("weeks of the month: days 1–7 are the 1st week, 29–31 the 5th", () => {
  assert.deepEqual(weekOfMonth("2026-08-09"), { start: "2026-08-08", end: "2026-08-14", label: "2nd week of August" });
  assert.deepEqual(weekOfMonth("2026-08-01"), { start: "2026-08-01", end: "2026-08-07", label: "1st week of August" });
  assert.deepEqual(weekOfMonth("2026-02-28"), { start: "2026-02-22", end: "2026-02-28", label: "4th week of February" });
  assert.deepEqual(weekOfMonth("2026-08-31"), { start: "2026-08-29", end: "2026-08-31", label: "5th week of August" });
});

test("leaderboard periods and their IST ranges", () => {
  const now = Date.parse("2026-11-09T06:00:00Z"); // 9 Nov, 11:30 IST
  const p = leaderboardPeriods(now, 3, 2);
  assert.deepEqual(p.map((x) => x.id), ["w:2026-11-08", "w:2026-11-01", "w:2026-10-29", "m:2026-11", "m:2026-10"]);
  assert.equal(p[0].label, "2nd week of November 2026 (this week)");
  const w = periodRange("w:2026-10-29");
  assert.equal(new Date(w.from).toISOString(), "2026-10-28T18:30:00.000Z");
  assert.equal(new Date(w.to).toISOString(), "2026-10-31T18:30:00.000Z");
  const m = periodRange("m:2026-10");
  assert.equal(m.label, "Whole of October 2026");
  assert.equal(new Date(m.to).toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(periodRange("nonsense", now).label, "2nd week of November 2026");
});
