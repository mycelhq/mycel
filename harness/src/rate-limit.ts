// Fixed-window counters. In-process — same honesty as the task limiter in server.ts.

const windows = new Map<string, { n: number; resetAt: number }>();

export function rateLimited(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = windows.get(key);
  if (!b || now > b.resetAt) {
    windows.set(key, { n: 1, resetAt: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > max;
}

export function clientKey(
  c: { req: { header(name: string): string | undefined } },
  prefix: string,
): string {
  const forwarded = (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim();
  const ip = forwarded || c.req.header("x-real-ip") || "anon";
  return `${prefix}:${ip}`;
}
