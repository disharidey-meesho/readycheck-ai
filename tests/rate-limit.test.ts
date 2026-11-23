// The in-memory rate limiter answers 429 once a key is over its budget, per key.
import test from "node:test";
import assert from "node:assert/strict";
import { rateLimiter } from "../rate-limit";

function run(mw: ReturnType<typeof rateLimiter>, key: string) {
  let status = 200;
  let passed = false;
  const res: any = { setHeader() {}, status(code: number) { status = code; return { json() {} }; } };
  mw({ key } as any, res, () => { passed = true; });
  return passed ? 200 : status;
}

test("over the budget a key gets 429; other keys are not affected", () => {
  const mw = rateLimiter({ name: "test", windowMs: 60_000, max: 3, key: (req: any) => req.key });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => run(mw, "a")), [200, 200, 200, 429, 429]);
  assert.equal(run(mw, "b"), 200);
});

test("a new window starts fresh", async () => {
  const mw = rateLimiter({ name: "test", windowMs: 50, max: 1, key: (req: any) => req.key });
  assert.equal(run(mw, "a"), 200);
  assert.equal(run(mw, "a"), 429);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(run(mw, "a"), 200);
});
