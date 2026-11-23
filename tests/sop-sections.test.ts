// SOP section splitting and manual day slicing (local steps of the fast day-wise SOP build).
import test from "node:test";
import assert from "node:assert/strict";
import { splitSopSections, sliceManualByDay } from "../sop-sections";

const sop = [
  "ACME SUPPORT SOP",
  "1. Greeting and verification",
  "Greet the customer by name. Verify the order ID and the registered mobile number before sharing any order details. ".repeat(3),
  "2. Refunds",
  "Refunds are allowed within 7 days of delivery. Ask for an unboxing photo for damaged items before raising a refund ticket. ".repeat(3),
  "3. Delivery delays",
  "Under 2 days late, share the new expected date from tracking. More than 5 days late, raise an escalation tagged Delay-5D. ".repeat(3),
].join("\n");

test("splits an SOP at its headings and keeps every word", () => {
  const sections = splitSopSections(sop);
  assert.ok(sections.length >= 3, `got ${sections.length}`);
  assert.deepEqual(sections.map((s) => s.id), sections.map((_, i) => i + 1));
  assert.equal(sections.map((s) => s.text).join("\n").replace(/\s+/g, " "), sop.replace(/\s+/g, " ").trim());
  assert.ok(sections.some((s) => s.text.startsWith("2. Refunds")));
});

test("long unbroken text is split into pieces of at most ~1800 characters", () => {
  const long = Array.from({ length: 200 }, (_, i) => `Rule ${i}: agents must follow step ${i} exactly as written.`).join("\n");
  const sections = splitSopSections(long);
  assert.ok(sections.length > 3);
  assert.ok(sections.every((s) => s.text.length <= 1900));
});

test("cuts the manual into days from start markers, tolerating punctuation and case", () => {
  const manual = "Intro text.\nDAY 1 – Basics: greeting, verification.\nSlide text one.\nDay 2 - Orders & refunds\nSlide text two.\nDay 3: Escalations\nLast slide.";
  const parts = sliceManualByDay(manual, ["Day 1 Basics greeting", "day 2 orders refunds", "Day 3: Escalations", "not in the manual at all"]);
  assert.match(parts[0], /^DAY 1 – Basics/);
  assert.ok(!parts[0].includes("Day 2"));
  assert.match(parts[1], /^Day 2 - Orders/);
  assert.match(parts[2], /^Day 3: Escalations\nLast slide\.$/);
  assert.equal(parts[3], "");
});
