// Fixed-window counters.
//
// TWO OF THEM, and the difference is the point. `rateLimited` is in-process and cheap, which is the
// right trade for shedding load. `rateLimitedDurable` is backed by the shared counter store, which
// is the only honest choice for a credential check — see there.

const windows = new Map<string, { n: number; resetAt: number }>();

/**
 * Evict expired windows.
 *
 * The map had no eviction and one entry per client key, for the lifetime of the process. That is the
 * same leak `policy_counters` was built to fix, named in its own header: "`perTask` was never
 * evicted either — one entry per (task, rule) for the lifetime of the process." A per-IP key on a
 * public endpoint makes that unbounded by design rather than by accident.
 *
 * Swept on write rather than on a timer: a module every test imports must not arm an interval, and
 * a counter nobody is writing to is a counter nobody is growing.
 */
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, v] of windows) if (now > v.resetAt) windows.delete(k);
}

export function rateLimited(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  sweep(now);
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

/**
 * ═══ THE ONE THAT COUNTS ACROSS REPLICAS, FOR THE ENDPOINTS WHERE THAT MATTERS ═══
 *
 * `rateLimited` above holds its windows in a process-local `Map`. On this deployment that is two API
 * replicas, so a limit of N is really 2N; the budget resets on every deploy, which is several times
 * on a working day; and an attacker gets a fresh allowance each time.
 *
 * For shedding load that is fine and the cheapness is the point. For a PASSWORD CHECK it is not:
 * doubling how fast someone can guess, and handing them a reset whenever we ship, is the whole
 * difference between a rate limit and the appearance of one.
 *
 * This is the same bug `policy_counters` exists for, in its own words: "this is a SECURITY control
 * that failed OPEN. With 2 API replicas and 2 workers each holding their own counter, a
 * `max_per_day: 40` envelope permitted roughly 160 auto-approved real-world actions per day." The
 * store that fixed it is atomic, durable and already running, so this reuses it rather than
 * inventing a second answer to one question.
 *
 * FAILS CLOSED, unlike the image cap. A counter we cannot reach means we cannot say whether this is
 * the first attempt or the thousandth, and for a credential the safe answer is to refuse — a founder
 * retrying a login in a minute costs them a minute, where guessing unmetered costs them the account.
 * That is the opposite of the call `images_per_month` makes, deliberately: one is a margin control
 * and this is a security boundary.
 *
 * THE NAMESPACE IS RESERVED, NOT A TENANT. The counter store keys on `project_id` because everything
 * else it counts belongs to a project; a login attempt does not have one yet, and inventing a
 * plausible id would put untrusted input in a tenant column. `~auth` cannot collide with a real
 * project id — no id this system mints begins with a tilde — and it is never read as a tenant.
 */
export async function rateLimitedDurable(key: string, max: number, windowMs = 60_000): Promise<boolean> {
  const { getPolicyCounters } = await import("./store");
  // The window is part of the KEY rather than a decaying value, so a fixed window falls out of the
  // arithmetic instead of needing a sweep: every request in the same slice bumps the same row, and
  // the next slice is a different row that expires on its own.
  const slice = Math.floor(Date.now() / windowMs);
  try {
    const n = await (await getPolicyCounters()).bump(
      "~auth",
      "day",
      `${key}:${slice}`,
      new Date((slice + 2) * windowMs),
    );
    return n > max;
  } catch {
    return true;
  }
}
