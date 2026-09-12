// The sign-in routes — signup, login, password reset, email verification.
//
// ═══ WHAT IS HERE AND WHAT DELIBERATELY IS NOT ═══
//
// Six of the nine `/v1/auth*` routes. `federated` and `verify/request` stayed in `server.ts`, and
// the reason is worth stating because it is the one thing that makes this kind of extraction
// dangerous: they sit immediately after an `app.use("/v1/*")` middleware, and in Hono the ORDER of
// a `use` relative to the routes around it decides what runs against what. Moving routes across
// that line changes behaviour in a way no type checker and no unit test would catch. They can move
// once somebody has read that middleware properly; today they stay where they are.
//
// ═══ WHY THESE SIX BELONG TOGETHER ═══
//
// Every one of them is the same decision — is this person who they say they are — and each has a
// rate limit and a deliberately vague failure. They were spread through the top of a 10,000-line
// file next to project and task routes that share none of that.
import type { Hono } from "hono";
import { getIdentityStore, signupInviteOnly } from "./identity";
// `rateLimited` is aliased to `limited` in server.ts and the routes below use that name; kept the
// alias so the moved bodies read identically to what they replaced.
import { clientKey, rateLimitedDurable as limitedDurable } from "./rate-limit";

export interface AuthRouteDeps {
  /** Members, sessions, invites. A process-wide singleton; injected so a test can hand over another. */
  identity: ReturnType<typeof getIdentityStore>;
}

/**
 * A tighter limit than the general one, because these are the routes worth guessing at.
 *
 * Moved here with its only readers. It sat next to RATE_MAX in server.ts, which made the pair look
 * like one policy when they answer different questions — RATE_MAX bounds how much WORK a caller can
 * ask for, this bounds how many times they may try to become somebody.
 */
const AUTH_RATE_MAX = Number(process.env.MYCEL_AUTH_RATE_MAX ?? 20);

export function mountAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const { identity } = deps;

app.post("/v1/auth/signup", async (c) => {
  if (await limitedDurable(clientKey(c, "auth"), AUTH_RATE_MAX)) return c.json({ error: "rate limited" }, 429);
  const b = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    org_name?: string;
    invite_token?: string;
  };
  const email = (b.email ?? "").trim().toLowerCase();
  const password = b.password ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "a valid email is required" }, 400);
  if (password.length < 10) return c.json({ error: "password must be at least 10 characters" }, 400);
  const identity = getIdentityStore();
  // The invite-only gate, when the deployment asks for one. `code` is stable so the product can
  // render a calm gate state rather than a red toast. Check → create → consume runs synchronously,
  // so a link cannot be spent twice in-process and is marked used only once the account exists.
  const gate = signupInviteOnly()
    ? identity.signupPermitted(email, typeof b.invite_token === "string" ? b.invite_token : undefined)
    : { ok: true as const };
  if (!gate.ok) return c.json({ error: "sign-ups are invite-only right now", code: "invite_only" }, 403);
  const out = identity.signup({ email, password, orgName: b.org_name });
  // Deliberately explicit: someone signing up with an email that exists needs to be told, unlike
  // the reset flow where the same honesty would be an enumeration oracle for a stranger.
  if (!out) return c.json({ error: "that email already has an account — sign in instead" }, 409);
  if ("entry" in gate && gate.entry) identity.consumeSignupAccess(gate.entry);
  return c.json({ token: out.session.token, member: out.member, projects: out.projects }, 201);
});

/**
 * Which provider this email used last, so the sign-in screen can point at the right button.
 *
 * Answers identically for unknown emails — `{ provider: null }` — because a true/false answer here
 * would let anyone check whether a given person has an account.
 */
app.post("/v1/auth/hint", async (c) => {
  /**
   * AN ENUMERATION ORACLE, and it had no limit at all.
   *
   * This answers "which provider did this address last sign in with", which is a real affordance —
   * a founder who used Google in March should not be made to guess. It is also, unmetered, a way to
   * test an address list against this system and learn both that an account exists AND how it is
   * reached, which is the first half of a targeted phish.
   *
   * The feature is worth keeping and the rate is what makes it a convenience rather than a service.
   */
  if (await limitedDurable(clientKey(c, "auth"), AUTH_RATE_MAX)) return c.json({ error: "rate limited" }, 429);
  const b = (await c.req.json().catch(() => ({}))) as { email?: string };
  const provider = getIdentityStore().lastProviderFor((b.email ?? "").trim().toLowerCase());
  return c.json({ provider: provider ?? null });
});

app.post("/v1/auth/reset/request", async (c) => {
  if (await limitedDurable(clientKey(c, "auth"), AUTH_RATE_MAX)) return c.json({ error: "rate limited" }, 429);
  const b = (await c.req.json().catch(() => ({}))) as { email?: string };
  const out = getIdentityStore().requestReset((b.email ?? "").trim().toLowerCase());
  // ALWAYS ok:true. Saying "no such account" would turn this into a way to enumerate customers,
  // and the product sends the mail only when a token comes back.
  return c.json({ ok: true, ...(out ? { token: out.token, email: out.email } : {}) });
});

app.post("/v1/auth/reset/confirm", async (c) => {
  /**
   * THIS ONE MINTS A SESSION, and it had no limit at all.
   *
   * A correct token here returns a live session for the account — it is the single highest-value
   * guess in the system, and it was the one endpoint nothing counted. The token is high-entropy, so
   * this is a depth-in-defence rather than the only thing standing there, but "the secret is long"
   * is an argument that stops being true the day somebody shortens it.
   */
  if (await limitedDurable(clientKey(c, "auth"), AUTH_RATE_MAX)) return c.json({ error: "rate limited" }, 429);
  const b = (await c.req.json().catch(() => ({}))) as { token?: string; password?: string };
  if ((b.password ?? "").length < 10) return c.json({ error: "password must be at least 10 characters" }, 400);
  const out = getIdentityStore().confirmReset(b.token ?? "", b.password ?? "");
  if (!out) return c.json({ error: "that reset link is invalid or has expired" }, 400);
  return c.json({ token: out.session.token, member: out.member, projects: out.projects });
});

/**
 * Spend an email-verification link.
 *
 * PUBLIC, and it has to be: the link is opened from a mail client, which may be on a phone that
 * has never held a session for this account. Requiring one would mean the most common way to open
 * an email — the phone — was the one way the link could not work.
 *
 * That is safe because the token IS the credential and it grants exactly one thing: the statement
 * that this address receives mail. It mints no session (`confirmVerification` explains why), so a
 * leaked link cannot be turned into access.
 *
 * A POST rather than a GET, deliberately. The GET lives in the PRODUCT (`cloud/app/verify/route.ts`),
 * where `enterVerdict` decides whether the requester is a person before this is ever called — the
 * same guard the portal link uses, for the same reason: a corporate link scanner fetching the URL
 * to score it would otherwise spend a one-time token on the recipient's behalf.
 */
app.post("/v1/auth/verify/confirm", async (c) => {
  // Same shape as the reset above: a token guess, unmetered. It mints no session, so the prize is
  // smaller — but an endpoint that says "this token is real" is still an oracle, and the limit costs
  // one row.
  if (await limitedDurable(clientKey(c, "auth"), AUTH_RATE_MAX)) return c.json({ error: "rate limited" }, 429);
  const b = (await c.req.json().catch(() => ({}))) as { token?: string };
  const out = getIdentityStore().confirmVerification(b.token ?? "");
  // Named, not generic. "Invalid or expired" is the honest union — the store cannot tell a forged
  // token from a spent one and must not guess, but the product turns this into a screen that
  // offers a resend rather than a dead end.
  if (!out) return c.json({ error: "that verification link is invalid, already used, or has expired" }, 400);
  return c.json({ ok: true, member: out.member });
});

app.post("/v1/auth/login", async (c) => {
  /**
   * DURABLE, because this one is a credential check.
   *
   * The in-process limiter is right for shedding load and wrong here: with two API replicas a limit
   * of N is really 2N, and it resets on every deploy — several times on a working day — handing a
   * guesser a fresh allowance each time. That is the difference between a rate limit and the
   * appearance of one, and it is the same failure `policy_counters` was built to fix.
   *
   * It fails CLOSED. A counter we cannot read means we cannot tell a first attempt from a
   * thousandth, and for a password the safe answer is to refuse: a founder retrying in a minute
   * loses a minute, where guessing unmetered loses the account.
   */
  if (await limitedDurable(clientKey(c, "auth"), AUTH_RATE_MAX)) {
    return c.json({ error: "rate limited" }, 429);
  }
  const b = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!b.email || !b.password) return c.json({ error: "email and password required" }, 400);
  const r = getIdentityStore().login(b.email, b.password);
  if (!r) return c.json({ error: "invalid credentials" }, 401);
  return c.json({ token: r.session.token, member: r.member, projects: r.projects, expires_at: r.session.expires_at });
});
}
