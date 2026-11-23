// Small in-memory rate limits (one Node process). Each limiter counts hits per key in a fixed
// window and answers 429 once the key is over its budget; old keys are swept every minute.
import type express from "express";

export function rateLimiter(opts: { windowMs: number; max: number; name: string; key: (req: express.Request) => string }) {
  const hits = new Map<string, { start: number; n: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > opts.windowMs) hits.delete(k);
  }, 60_000);
  sweep.unref?.();

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = opts.key(req);
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now - cur.start > opts.windowMs) {
      hits.set(key, { start: now, n: 1 });
      return next();
    }
    cur.n++;
    if (cur.n > opts.max) {
      if (cur.n === opts.max + 1) console.warn(`[rate-limit] ${opts.name}: ${key} went over ${opts.max} requests in ${Math.round(opts.windowMs / 1000)}s`);
      res.setHeader("Retry-After", String(Math.ceil((cur.start + opts.windowMs - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Please wait a little and try again." });
    }
    return next();
  };
}

// the caller's address (the platform's proxy sets X-Forwarded-For; trust proxy is on)
export const byIp = (req: express.Request) => `ip:${req.ip || "unknown"}`;
// the signed-in user (requireAuth runs first), falling back to the address
export const byUser = (req: express.Request) => {
  const s = (req as any).session as { email?: string } | undefined;
  return s?.email ? `user:${s.email.toLowerCase()}` : byIp(req);
};
