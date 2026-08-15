/**
 * The bits of `seed-demo.ts` that were worth having twice.
 *
 * WHY THIS FILE EXISTS. `seed-demo.ts` had, inline, the two safety guards that make a local-only
 * fixture builder safe to own, plus a transport, plus the money and date helpers. `simulate.ts`
 * needs every one of those, and the guards ESPECIALLY: a second script with its own hand-copied
 * `assertLoopback` is one edit away from being a script with a subtly weaker one, and the whole
 * argument for these guards is that there is no way to talk them round. One copy, both callers.
 *
 * The one structural change against the original is `Session`. The seed had a single module-level
 * `TOKEN`/`PROJECT` pair, which is correct for a script with exactly one credential. The simulation
 * has SEVEN at once — a founder, a second founder-project scope, and one portal session per client
 * — and the whole point of beat 6 is asserting that they cannot see each other. Module-level
 * mutable auth state in a script whose job is proving credential isolation is the wrong shape: one
 * missed reassignment and the "client A cannot read client B" assertion passes because both calls
 * went out as the founder. So a credential is an object you hold, and every request names which one
 * it went out as.
 */
import { env, exit } from "node:process";

// ── Guards ───────────────────────────────────────────────────────────────────────────────────────
//
// Both moved here VERBATIM from seed-demo.ts, including the rule that there is no `--force`. See the
// original comments, reproduced because they are the argument for the code rather than a description
// of it.

/**
 * The loopback allowlist, with NO escape hatch — not a flag, not an env var, not a `--force`.
 *
 * Every "are you sure?" prompt is eventually answered yes by someone in a hurry, and the blast
 * radius here is a production tenant's ledger silently gaining invented customers and an overdue
 * invoice for money nobody owes. Since these scripts are by definition local, refusing every
 * non-loopback host costs literally nothing and cannot be talked around. If you genuinely need this
 * somewhere else, port-forward that kernel to localhost and you have made the decision explicitly,
 * at the shell, where it is visible.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function assertLoopback(base: string): void {
  const url = new URL(base);
  if (!LOOPBACK.has(url.hostname)) {
    die(
      `refusing to write to ${url.origin}\n` +
        `  This script only ever writes to a loopback address (${[...LOOPBACK].join(", ")}).\n` +
        `  There is no override. Port-forward the target to localhost if you really mean it.`,
    );
  }
}

/**
 * The second guard, and the one that catches the case the first cannot: a production kernel
 * port-forwarded to localhost, which satisfies `assertLoopback` completely. `GET /v1/meta` reports
 * which store backend booted, and `memory` means every row in it dies with the process — which is
 * exactly what a demo kernel is and exactly what a real business's kernel is not. A durable store is
 * refused whether it is a laptop Postgres or a customer's.
 *
 * Takes the SESSION rather than reading a module global, because it must run AFTER sign-in and
 * BEFORE the first write: `/v1/meta` is authenticated, and checking it unauthenticated only ever
 * produced `store=unknown` from a 401 body — a guard that fires on everything protects nothing.
 */
export async function assertMemoryStore(s: Session): Promise<void> {
  const meta = await s.get<{ store?: string }>("meta");
  if (meta.store !== "memory") {
    die(
      `refusing to write to a kernel with a durable store (store=${meta.store ?? "unknown"})\n` +
        `  Demo data belongs in an in-memory kernel, which loses it on restart — that is the point.\n` +
        `  Unset MYCEL_DATABASE_URL / MYCEL_DATABASE_POOLED_URL and boot again.`,
    );
  }
}

export function die(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  exit(1);
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────────

export interface Attempt<T> {
  ok: boolean;
  status: number;
  body: T | undefined;
  text: string;
}

/**
 * One credential, one project scope, and every request it makes.
 *
 * A founder session carries a bearer token and an `x-mycel-project` header; a portal session carries
 * only a bearer token, because a client session IS its project scope and the kernel refuses to take
 * one from the caller. Modelling that as "project is optional on the session" rather than "the
 * caller passes a header sometimes" is deliberate: it makes it impossible for a portal call in this
 * script to carry a project header that the kernel would be right to ignore but a reader would take
 * as meaningful.
 */
export class Session {
  constructor(
    /** Origin, no trailing slash, already checked by `assertLoopback`. */
    readonly base: string,
    /** What this credential is, for error messages. "founder", "portal:Harborline Ceramics". */
    readonly label: string,
    public token = "",
    public project = "",
  ) {}

  /** Never throws on a non-2xx. The caller decides — used for capability probes and for the
   *  cross-tenant assertions, where a 404 is the PASSING outcome and a fatal helper cannot express
   *  that. */
  async attempt<T>(path: string, init: RequestInit = {}): Promise<Attempt<T>> {
    const res = await fetch(`${this.base}/v1/${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.project ? { "x-mycel-project": this.project } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: T | undefined;
    try {
      body = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      body = undefined; // hono's own 404 is text/plain, and that is a legitimate answer to a probe
    }
    return { ok: res.ok, status: res.status, body, text };
  }

  /**
   * Fatal on a non-2xx, which is the right default for a fixture builder: a script that shrugs off a
   * 400 leaves a half-built business whose missing half is discovered on camera.
   */
  async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.attempt<T>(path, init);
    if (!r.ok) {
      die(`[${this.label}] ${init.method ?? "GET"} /v1/${path} → ${r.status}\n    ${r.text.slice(0, 400)}`);
    }
    return r.body as T;
  }

  get = <T,>(path: string) => this.call<T>(path);
  post = <T,>(path: string, body: unknown) => this.call<T>(path, { method: "POST", body: JSON.stringify(body) });
  patch = <T,>(path: string, body: unknown) => this.call<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  put = <T,>(path: string, body: unknown) => this.call<T>(path, { method: "PUT", body: JSON.stringify(body) });

  /** The soft POST, for the one caller that legitimately tolerates a refusal. */
  tryPost = <T,>(path: string, body: unknown) => this.attempt<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** The base URL both scripts talk to, loopback-checked by the caller. */
export const baseUrl = (): string => (env.MYCEL_URL ?? "http://localhost:4000").replace(/\/+$/, "");

// ── Money ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Money is integer minor units everywhere in this kernel. NOTHING here divides by 100 — see
 * contract.ts. `Math.round` and not a cast, because `19.99 * 100` is `1998.9999999999998` in IEEE
 *754 and a truncating cast would quietly bill a cent short on every fractional amount.
 */
export const usd = (dollars: number): number => Math.round(dollars * 100);

/** Minor units → the string a narrative line prints. Display only; never fed back into a request. */
export const money = (minor: number, currency = "USD"): string =>
  `${currency === "USD" ? "$" : `${currency} `}${(minor / 100).toFixed(2)}`;

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────
//
// Everything is relative to the moment you run it, never a hardcoded calendar date. A fixture with
// literal dates in it looks correct for a week and then shows an audience an invoice that is four
// hundred days overdue, which reads as a broken product rather than a stale fixture.

const DAY_MS = 86_400_000;

export interface Clock {
  /** Full ISO instant, `days` from now (negative for the past). */
  iso(days: number): string;
  /** `YYYY-MM-DD` — the only date shape `POST /v1/invoices` accepts. See `normalizeDate`. */
  day(days: number): string;
  /** Fractional hours, for anything the UI prints to the minute. */
  hour(hours: number): string;
}

export function clockFrom(now = Date.now()): Clock {
  const iso = (days: number) => new Date(now + days * DAY_MS).toISOString();
  return { iso, day: (d) => iso(d).slice(0, 10), hour: (h) => new Date(now + h * 3_600_000).toISOString() };
}

// ── Determinism ──────────────────────────────────────────────────────────────────────────────────

/**
 * A seeded PRNG, so a run that picks "which client goes quiet" picks the same one twice.
 *
 * `Math.random` in a simulation is how you get a script that fails once a fortnight and cannot be
 * reproduced from the failure output. mulberry32 is thirty characters of arithmetic with a period
 * long enough for anything a fixture does, and the seed is printed in the run header so a failing
 * run can be replayed exactly.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic pick from a non-empty list. Throws rather than returning undefined. */
export function pick<T>(r: () => number, xs: readonly T[]): T {
  if (!xs.length) throw new Error("pick() on an empty list");
  return xs[Math.floor(r() * xs.length)] as T;
}
