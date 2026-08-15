// Identity & tenancy (v1 foundation). Two auth planes:
//   - Product API keys (machine): a key resolves to a Project (which owns wedges). Server-to-server.
//   - Member sessions (human): a Member logs in and gets a session token the portal forwards.
//     A member sees every Project in their Org.
//
// v1 bootstraps a single default Org + Project + owner Member, so there is exactly one tenant and
// therefore no cross-tenant surface to get wrong. The model is in place; per-project scoping of
// data lands when a second project actually exists. In-memory (note: pg backing next, like domain).
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { loadConfig, databaseUrl } from "./config";
import { resolveBrandKit, type BrandKit, type BrandKitConfig } from "./brandkit";
import { isSuperAdminEmail } from "./superadmin";
import { asSurveyLog, emptySurveyLog, promptById, SURVEY_IDS, type SurveyLog } from "./surveys";
import { audit } from "./audit";

/** A stable, deterministic UUID from a name (UUIDv5-style). The default org/project/owner use
 *  these so their ids survive a restart — otherwise durable rows would be scoped to a dead
 *  project id after every boot. */
function stableUuid(name: string): string {
  const h = createHash("sha1").update(`mycel:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Role = "owner" | "admin" | "operator" | "viewer";

/**
 * Plans and limits.
 *
 * The kernel knows what a plan ALLOWS. It does not know what a plan costs, who took the payment, or
 * that Stripe exists — that lives in the commercial control plane, which calls `PUT /v1/org/plan`
 * with a product key. Two reasons. Anyone running the kernel themselves should never meet a
 * paywall, which is why `self_hosted` is the default and its limits are all null. And a billing
 * provider in the open core would be a commercial dependency in an Apache-2.0 licence.
 *
 * WHICH MADE THE HOSTED PRODUCT FREE. That default is right for the OSS kernel and was applied
 * unconditionally, so every org on Mycel Cloud was `self_hosted` — unlimited seats, unlimited
 * tasks, and `model_spend_usd_per_month: null`, which mints a LiteLLM key with NO budget and makes
 * `spendThisMonth`'s ceiling check unreachable. We paid for the tokens and nothing capped them; the
 * plan ladder, the pricing page and the upgrade path were all decoration.
 *
 * `MYCEL_CLOUD=1` marks a deployment as the hosted product, and only changes this one thing: a new
 * org starts on a sellable plan with no subscription behind it instead of `self_hosted`. It is
 * opt-IN so a self-hoster who never sets it cannot accidentally acquire a paywall — the property the
 * original comment was protecting.
 *
 * ---------------------------------------------------------------------------------------------
 * AND THEN THE HOSTED FREE TIER WENT AWAY.
 *
 * `free` used to be what a new cloud org landed on: one seat, 100 jobs, $2 of model spend, and a
 * minted LiteLLM key to spend it with. That is real money leaving on someone who has signalled
 * nothing, and the signal is the part that mattered more than the dollars — a free tier tells you
 * how many people will click a button, which is not a number any of the decisions here needed.
 *
 * It is replaced by a SEVEN-DAY TRIAL on the paid plans, with a card taken at signup, and the
 * trial has the limits of the plan being trialled (see `limitsFor`). A trial that behaves like the
 * old free tier proves nothing about the product somebody is about to buy.
 *
 * `free` REMAINS in the union and in `PLAN_LIMITS`, deliberately. There are live orgs on it. See
 * the note on `PLAN_LIMITS.free` for why they are grandfathered rather than migrated.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Is this the hosted product rather than someone's own install?
 *
 * Read at call time, not module load, so a test can set it. Deliberately not inferred from anything
 * clever like "is a LiteLLM proxy configured" — a self-hoster may well run one, and guessing wrong
 * in that direction hands a paywall to somebody who never bought one.
 */
export const cloudMode = (): boolean => process.env.MYCEL_CLOUD === "1" || process.env.MYCEL_CLOUD === "true";

/**
 * The plan a brand-new org starts on.
 *
 * On cloud this is `find` — the cheapest thing we sell — and it is paired with
 * `plan_status: "none"` by `createOrgWithOwner`, so the NAME is "the plan you are about to trial"
 * while the ENTITLEMENT is `INACTIVE_LIMITS` until Stripe says a subscription exists. Splitting it
 * that way means the product has something honest to render on the billing screen during the
 * thirty seconds between signup and checkout, without those thirty seconds being a free tier.
 *
 * The pairing is load-bearing: `plan` alone must never be read as an entitlement. `limitsFor` is
 * the only function allowed to answer that question.
 */
export const defaultPlan = (): Plan => (cloudMode() ? "find" : "self_hosted");
export type Plan = "self_hosted" | "free" | "find" | "starter" | "growth" | "scale";

/** `null` means unmetered. Not zero, not Infinity — a number nobody has to remember the meaning of. */
export interface Limits {
  seats: number | null;
  projects: number | null;
  tasks_per_month: number | null;
  /**
   * A ceiling on MODEL SPEND, not just on job count.
   *
   * Counting jobs alone does not protect margin, because the model tiers differ by 35× in price. A
   * Growth customer running their full 20,000 jobs on the deep tier costs about $1,520 of model
   * spend against $380 of revenue — the plan loses over a thousand dollars a month at its own
   * advertised limit. Job counts cap volume; this caps money, which is the thing that actually
   * runs out.
   *
   * Set generously: it is a runaway guard and an honest ceiling, not a throttle customers should
   * feel in normal use.
   */
  model_spend_usd_per_month: number | null;
  /**
   * How many times the join bot may enter a call this calendar month.
   *
   * Counted per join, not per minute: Transcribe minutes are cheap next to Fargate, and a join is
   * the thing the founder clicks. `null` is unmetered (self-hosted / scale). Zero (inactive) stops
   * new joins the same way `tasks_per_month: 0` stops new jobs.
   */
  meeting_joins_per_month: number | null;
  /**
   * How many LinkedIn member sessions this org may hold at once.
   *
   * A session is a connected account behind the proxy, not a one-click sign-in. `null` is unmetered
   * (the OS plans, self-hosted, scale). Zero stops a new connect the same way `meeting_joins_per_month: 0`
   * stops a join. Find sells one; Starter and Growth keep the previous unmetered behaviour.
   */
  linkedin_sessions: number | null;
  /**
   * Delivery: cases that are not outreach, kickoff, Mycel-run jobs on an engagement.
   *
   * Find is pipeline only — they find the client and do the work themselves. A boolean rather than
   * `tasks_per_month: 0` because outreach still creates tasks (find, sequence, reply) and those
   * must keep running. The numeric job cap is a runaway guard; this is the product aisle.
   */
  fulfillment: boolean;
  /** Raising invoices and chasing payment. Find does not include it; Starter and Growth do. */
  invoicing: boolean;
}

/** The OS aisle — Mycel runs delivery. Shared by Starter, Growth, Scale, self-hosted, and the
 *  grandfathered free row so those plans keep doing what they already did. */
const OS: Pick<Limits, "linkedin_sessions" | "fulfillment" | "invoicing"> = {
  linkedin_sessions: null,
  fulfillment: true,
  invoicing: true,
};

export const PLAN_LIMITS: Record<Plan, Limits> = {
  // The operator's own key and own bill. Metering someone else's spend would be rude and pointless.
  self_hosted: {
    seats: null,
    projects: null,
    tasks_per_month: null,
    model_spend_usd_per_month: null,
    meeting_joins_per_month: null,
    ...OS,
  },
  // Every limit below is DERIVED from what a job costs, not chosen and then costed afterwards.
  // A standard-tier run is ~$0.0076 (20k in, 3k out on gpt-5.6-luna); a fast one ~$0.0022.
  //
  /**
   * LEGACY. Nothing lands here any more; `defaultPlan()` stopped returning it when the hosted free
   * tier was removed. It stays because live orgs are on it, and they are GRANDFATHERED.
   *
   * Grandfathered rather than migrated, and the choice is not close. Migrating means one of two
   * things. Move them onto a trial and they get a seven-day clock they never asked for and no card
   * for Stripe to charge at the end of it, so the migration's own success case is a mass
   * cancellation event. Move them to `cancelled` and we take away, with no notice, something they
   * were told was free — from accounts that may have a client portal live on a custom domain.
   *
   * Grandfathering costs us the model spend of a bounded, shrinking, already-known set of orgs, and
   * costs nothing in code: `limitsFor` still finds this row, `PLAN_MAX_TIER` still has an entry, and
   * `keyForOrg` still mints the same key it minted yesterday. Nothing is left in a state no code
   * path expects, which is the actual requirement.
   *
   * Do not delete this row without first checking `SELECT count(*) FROM orgs WHERE plan = 'free'`.
   */
  free: {
    seats: 1,
    projects: 1,
    tasks_per_month: 100,
    model_spend_usd_per_month: 2,
    meeting_joins_per_month: 4,
    ...OS,
  },
  /**
   * $49. Pipeline only: find, enrich, sequence, book. They fulfill the work themselves.
   *
   * `tasks_per_month` is a runaway guard for outreach runs (search, sequence, reply), not an
   * advertised job allowance — fulfillment is off, so a delivery case is refused even with budget
   * left. Meeting joins are zero. One LinkedIn member session. Enrich stays on the existing
   * Firecrawl / FullEnrich credits; nothing here mints extra.
   */
  find: {
    seats: 1,
    projects: 1,
    tasks_per_month: 2_000,
    model_spend_usd_per_month: 10,
    meeting_joins_per_month: 0,
    linkedin_sessions: 1,
    fulfillment: false,
    invoicing: false,
  },
  // $299. The OS: Mycel does the work. 2,000 standard jobs is ~$15, so the ceiling is a runaway
  // guard, not a throttle.
  starter: {
    seats: 3,
    projects: 2,
    tasks_per_month: 2_000,
    model_spend_usd_per_month: 30,
    meeting_joins_per_month: 20,
    ...OS,
  },
  // $899 and 10,000 jobs, NOT the 20,000 this originally carried. That number predated knowing what
  // a job costs: 20,000 standard-tier runs is ~$152, which is a 49% gross margin before a single
  // deep-tier job. At 10,000 it is ~$76 and ~75% even at the old $299. The spend ceiling then caps
  // the deep-tier tail, which would otherwise be $1,520 against the plan fee.
  growth: {
    seats: 10,
    projects: 10,
    tasks_per_month: 10_000,
    model_spend_usd_per_month: 90,
    meeting_joins_per_month: 80,
    ...OS,
  },
  // Negotiated, so metered by the contract rather than by this table.
  scale: {
    seats: null,
    projects: null,
    tasks_per_month: null,
    model_spend_usd_per_month: null,
    meeting_joins_per_month: null,
    ...OS,
  },
};

/**
 * What happens when a subscription lapses.
 *
 * `past_due` deliberately does NOT stop the business, and that is the single most important line in
 * this file. A bookkeeping service that silently stops answering its customers because a card
 * expired does far more damage to the founder than the unpaid invoice does to us; the product nags
 * instead. This covers the failed FIRST charge too — when a seven-day trial ends and the card is
 * declined, Stripe moves the subscription to `past_due` and retries it for weeks, and throughout
 * that window the business keeps running at full plan limits. A founder mid-engagement does not
 * discover a billing problem by way of their client not getting an answer.
 *
 * `none` is ours, not Stripe's: an org that has signed up and never had a subscription at all. It
 * exists so that `plan` can name the plan somebody is about to buy without that name granting
 * anything. Without it, a new cloud org's `plan` field would be indistinguishable from a paid one.
 *
 * `none` and `cancelled` both resolve to `INACTIVE_LIMITS` — readable data, no new work.
 */
export type PlanStatus = "active" | "trialing" | "past_due" | "cancelled" | "none";

/** Every status in the union, for validating an untrusted `status` off the wire in one place. */
export const PLAN_STATUSES: PlanStatus[] = ["active", "trialing", "past_due", "cancelled", "none"];

/**
 * What an org may do with no subscription behind it — never had one (`none`), or had one and it
 * ended (`cancelled`).
 *
 * WHAT THIS DOES NOT DO IS DELETE ANYTHING, and nothing anywhere else does either. There is no code
 * path in the kernel from a plan status to a `DELETE`. Every task, case, artifact, audit entry and
 * project an org ever created is still there and still readable, because the thing a founder is
 * actually afraid of when a card fails is not losing access, it is losing records — and records we
 * destroyed to save $2 of storage are records we cannot give back when they pay.
 *
 * `tasks_per_month: 0` and `model_spend_usd_per_month: 0` stop NEW work. That is deliberate and it
 * is the whole point of removing the free tier: `cancelled` used to fall back to `PLAN_LIMITS.free`,
 * which handed every lapsed org 100 jobs and $2 of model spend every month, forever. That is the
 * free tier under another name, reached by cancelling.
 *
 * Stopping is allowed. Stopping SILENTLY is not — so the task-creation paths check plan status
 * before they check any number and refuse with `code: "plan_inactive"` and a sentence that says
 * what happened and what fixes it, rather than "your plan includes 0 jobs a month", which is what a
 * bare numeric check would have produced. Scheduled work that stops therefore stops with a reason
 * attached to every single refusal.
 *
 * `seats: 1` and `projects: 1` gate CREATION only — `POST /v1/team/invites` and `POST /v1/projects`
 * compare against current usage. An org with ten members and five projects keeps all fifteen; it
 * simply cannot add a sixteenth until it is paying again.
 */
export const INACTIVE_LIMITS: Limits = {
  seats: 1,
  projects: 1,
  tasks_per_month: 0,
  model_spend_usd_per_month: 0,
  meeting_joins_per_month: 0,
  linkedin_sessions: 0,
  fulfillment: false,
  invoicing: false,
};

/**
 * No ceilings at all — what a super-admin org gets. See `superadmin.ts` for why this is not a plan.
 *
 * Structurally identical to `self_hosted`, and written out separately anyway. They mean different
 * things: `self_hosted` is "we are not the ones paying for this", this is "we are, on purpose". A
 * shared constant would make a future change to one of those a silent change to the other.
 */
export const UNLIMITED_LIMITS: Limits = {
  seats: null,
  projects: null,
  tasks_per_month: null,
  model_spend_usd_per_month: null,
  meeting_joins_per_month: null,
  ...OS,
};

/** 402 codes the product keys upgrade prompts off. Named, not inferred from a zero. */
export const PLAN_FULFILLMENT = "plan_fulfillment";
export const PLAN_INVOICING = "plan_invoicing";
export const LINKEDIN_SESSION_LIMIT = "linkedin_session_limit";

export function fulfillmentRefusal(): { error: string; code: string } {
  return {
    error:
      "Find is for filling the pipeline — you do the delivery. Upgrade to Starter when you want Mycel to run the job, sit on the call as Mycel notes, and invoice.",
    code: PLAN_FULFILLMENT,
  };
}

export function invoicingRefusal(): { error: string; code: string } {
  return {
    error: "Find doesn't include invoicing. Upgrade to Starter when you want Mycel to raise and chase invoices.",
    code: PLAN_INVOICING,
  };
}

export function linkedinSessionRefusal(limit: number, used: number): { error: string; code: string } {
  return {
    error:
      limit === 1
        ? "Find includes one LinkedIn member session. Disconnect the one you have, or upgrade to Starter."
        : `your plan includes ${limit} LinkedIn member session${limit === 1 ? "" : "s"}, and ${used} ${used === 1 ? "is" : "are"} connected`,
    code: LINKEDIN_SESSION_LIMIT,
  };
}

export function meetingJoinRefusal(limit: number | null, used: number): string {
  if (limit === 0) {
    return "Find doesn't include Mycel notes on the call. Upgrade to Starter when you want Mycel to sit in.";
  }
  return `your plan includes ${limit} call joins a month, and ${used} have run`;
}

export interface Org {
  id: string;
  name: string;
  created_at: string;
  plan?: Plan;
  plan_status?: PlanStatus;
  /** The billing provider's customer id. Opaque here — stored, echoed, never interpreted. */
  billing_ref?: string;
  /** When the current period ends, for the UI to render. Set by the control plane. */
  plan_renews_at?: string;
  /**
   * Last time we emailed this org a state-of-the-business digest.
   *
   * Written only by `markDigestSent`, which the product cron calls after a successful send.
   * Absent means never sent — the first digest is due as soon as the weekday rule matches.
   */
  last_digest_at?: string;
}
export interface Project {
  id: string;
  org_id: string;
  name: string;
  /** Wedge slugs this project may run. Empty = all wedges on disk. */
  wedges: string[];
  created_at: string;
  /**
   * The subdomain this business's client portal answers on: `acme` → acme.mycelai.dev.
   *
   * Allocated at creation from the project name, and stable afterwards — it ends up in emails sent
   * to a founder's customers, and a link that stops working because someone renamed a project is
   * worse than an ugly slug.
   */
  slug?: string;
  /** A domain the founder owns, once they have proved they own it. */
  custom_domain?: string;
  /**
   * The TXT value that proves it. Present from the moment a custom domain is claimed until it
   * verifies; the domain does not serve traffic until `custom_domain_verified_at` is set.
   */
  domain_verify_token?: string;
  custom_domain_verified_at?: string;
  /**
   * What a customer sees. The business app renders from this — it is the founder's brand, not ours.
   *
   * Widened from `{ display_name, accent, support_email }` to the full `BrandKitConfig`, IN PLACE
   * rather than beside it: the generated website, the client portal, outgoing email and every
   * rendered artifact have to be the same brand, and two columns would eventually be two brands.
   * Every field is optional and the original three are unchanged, so every row written before the
   * kit existed is already valid. `resolveBrandKit` is the only thing allowed to fill the gaps.
   */
  branding?: BrandKitConfig;
}
export type AuthProvider = "password" | "google" | "github";

export interface Member {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  created_at: string;
  /**
   * How they signed in last. Shown on the sign-in screen so someone who used Google three months ago
   * isn't left guessing which of five buttons was theirs — the single biggest cause of accidental
   * duplicate accounts.
   */
  last_provider?: AuthProvider;
  /** Providers this member has ever used. An account reached by two routes is still one account. */
  providers?: AuthProvider[];
  /**
   * When we established that this person actually receives mail at this address, or undefined.
   *
   * ─── Why this is a fact and not a flag ────────────────────────────────────────────────────────
   *
   * The product lets an unverified account straight in — a form standing between a new account and
   * its first result is the worst friction in the funnel, and nothing on the way in touches anyone
   * but the signer-up. What it gates is the small set of actions where an unverified address lets
   * someone use OUR sending domain to reach a THIRD PARTY. So this is read as a permission, and a
   * permission wants a timestamp rather than a boolean: "when did we learn this" is the question
   * asked when an address turns out to be someone else's.
   *
   * FOUR THINGS SET IT, and all four are the same evidence — a message we sent to this address was
   * received by whoever is now holding the session:
   *   1. `confirmVerification` — the link from the verification email.
   *   2. `federated` — an OAuth provider already proved it. Asking Google's user to prove their
   *      Gmail address is a form that teaches the founder the product wasn't paying attention.
   *   3. `confirmReset` — they opened a password reset sent to this address.
   *   4. `acceptInvite` — the invite link was delivered to this address and nowhere else.
   * Missing any of the last three would leave real people staring at a banner they cannot clear,
   * which is how a gate becomes a support queue.
   */
  email_verified_at?: string;
  /**
   * UI state that belongs to a PERSON rather than to a business.
   *
   * Here rather than in a browser cookie because every field in it is a promise about "again":
   * onboarding that never re-shows, a tour that stays finished. A cookie makes that promise per
   * browser, so a founder who signed up on their phone is greeted as a stranger on their laptop —
   * which is exactly the promise broken.
   */
  prefs?: MemberPrefs;
  /**
   * Derived from `MYCEL_SUPERADMIN_EMAILS` at read time. Never stored, never writable.
   * The product uses this to draw the Product panel; the kernel uses the same function
   * (`isSuperAdminMember`) as the actual gate. A boolean on the wire is a hint, not a grant.
   */
  super_admin?: boolean;
}

/**
 * Per-member UI state.
 *
 * Free-form by design — the kernel has no opinion about what the product remembers, and needing a
 * kernel release to remember one more thing would be absurd. The fields the product actually leans
 * on are named anyway, so both ends of the wire can be typed and so this file records what is in
 * there.
 */
export interface MemberPrefs {
  /** What to call them. Asked once, on the first screen after sign-up. */
  name?: string;
  /**
   * Their profile picture, as the OAuth provider serves it.
   *
   * Stored rather than re-fetched because the provider's access token is spent at the callback and
   * deliberately not kept — an avatar is not worth holding a credential for. The kernel does NOT
   * validate this: `prefs` is free-form by design and the value is written by whoever holds the
   * session, so it is a claim, not a fact. The product constrains which hosts it will render from
   * (`cloud/lib/oauth.ts`, `safeAvatarUrl`), which is where that check belongs — at the point where
   * an unconstrained URL would become an outbound request from someone's browser.
   */
  avatar_url?: string;
  /** They finished the post-signup flow. Set once; nothing ever unsets it. */
  onboarded?: boolean;
  /** They finished or dismissed the product tour. */
  tour_done?: boolean;
  /**
   * Per-section "last looked at this room" timestamps (ISO), for the console's sidebar count badges.
   * Free-form by the same rule as the rest of `prefs`: written by the session through PATCH (it is
   * NOT reserved), read back by the console to count only the waiting items newer than the marker.
   * On the member so a cleared badge follows the person across devices, like `changelog_seen_at`.
   */
  nav_seen?: Record<string, string>;
  /**
   * Questionnaire log. Written only by `recordSurvey` — PATCH /v1/me/prefs refuses this key so a
   * session cannot forge the scores the super-admin dashboard aggregates.
   */
  surveys?: SurveyLog;
  [key: string]: unknown;
}

/**
 * Ceilings on what a member may store about themselves.
 *
 * `prefs` is writable by whoever holds the session and read back on every `/v1/me`, so without a
 * bound it is an unbounded, permanently-persisted, self-service key-value store attached to auth —
 * which is a storage-abuse primitive, not a preferences field. These numbers are far above any
 * legitimate use and far below anything worth exploiting.
 */
const PREFS_MAX_KEYS = 32;
const PREFS_MAX_JSON_CHARS = 8_000;
/** Keys a member may not write through PATCH. Kernel methods write them; the session cannot. */
const RESERVED_PREFS = new Set(["surveys"]);

interface StoredMember extends Member {
  /** Empty for accounts that have only ever used OAuth — there is no password to verify. */
  salt: string;
  hash: string;
  /** Single-use password reset. Hashed, because a leaked database shouldn't hand out logins. */
  reset_hash?: string;
  reset_expires?: number;
  /**
   * Single-use email verification, hashed for exactly the reason the reset token is.
   *
   * A verification link is a lower-value credential than a reset link — it grants no session, only
   * the right to send mail from the account it already belongs to — but it is still a credential
   * handed out by email, and there is no version of "store it in the clear" that gets better when
   * the database leaks.
   */
  verify_hash?: string;
  verify_expires?: number;
  /**
   * When verification mail was sent to this address, most recent last, trimmed to the rate window.
   *
   * A list rather than a counter and a reset time. A counter that resets on a fixed boundary lets
   * ten sends through in two seconds either side of the hour; a list of timestamps answers "how
   * many in the last hour" at any instant, which is the question the limit is actually about.
   */
  verify_sends?: number[];
}

/**
 * How often a person may ask us to send them a verification email.
 *
 * Two limits, because they stop two different things. The interval stops the double-click and the
 * impatient reload — every one of those is a real send against our domain's reputation, and mail
 * providers score a burst of identical messages to one inbox as exactly what it looks like. The
 * hourly cap stops a session being used as a small mail cannon aimed at its own owner.
 *
 * Both are per MEMBER, which is only possible because requesting a resend requires a session (see
 * `requestVerification`). A resend endpoint keyed on a submitted email address is an enumeration
 * oracle no matter how carefully it words its reply, so this product does not have one.
 */
const VERIFY_MIN_INTERVAL_MS = 60_000;
const VERIFY_MAX_PER_WINDOW = 5;
const VERIFY_WINDOW_MS = 60 * 60_000;
/**
 * How long a verification link lives.
 *
 * A day, not thirty minutes. This link is not raced by an attacker the way a password reset is, and
 * the person who receives it is a founder who has just been let into the product and is busy using
 * it — they open their mail that evening. An expiry tuned for a credential's blast radius rather
 * than for its user is how you build a flow whose most common outcome is "expired, send it again".
 */
const VERIFY_TTL_MS = 24 * 60 * 60_000;

/**
 * What happened when someone asked for a verification email.
 *
 * A union rather than `token | undefined`, because the caller has to say four different true things
 * and the old shape could only say two. "Already verified" is not "sent" and must not draw a banner
 * saying to check your inbox for a message nobody sent; "throttled" is not a failure and must not
 * be reported as one. Silent conflation of these is the recurring bug this codebase is named after.
 */
export type VerificationRequest =
  | { status: "sent"; token: string; email: string }
  | { status: "already-verified"; email: string }
  | { status: "throttled"; retry_after_ms: number }
  | { status: "unknown-member" };
export interface Session {
  token: string;
  member_id: string;
  org_id: string;
  expires_at: number;
}

/**
 * An outstanding invitation to join an org.
 *
 * Only the token's hash is stored, exactly as for password resets: an invite link is a credential
 * that creates an account with a role, so a stolen database must not hand out working ones.
 */
export interface Invite {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  /** The member who sent it. Shown in the UI so "who let this person in" has an answer. */
  invited_by: string;
  created_at: string;
  expires_at: number;
  accepted_at?: string;
}
interface StoredInvite extends Invite {
  token_hash: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Roles that may change who else is in the org. Deliberately short. */
const CAN_MANAGE_MEMBERS: Role[] = ["owner", "admin"];
export const canManageMembers = (role?: Role | string): boolean =>
  CAN_MANAGE_MEMBERS.includes(role as Role);

// 30 days, and it SLIDES — `resolveSession` pushes the expiry forward on use, so an active founder
// is never logged out mid-work and a returning one is still signed in a week later. Sessions are
// PERSISTED (identity.pg `sessions`), so a deploy or a landing on another instance no longer signs
// everyone out; the in-memory Map is now only a read-through cache in front of Postgres.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Only rewrite the expiry (one Postgres round-trip) once a session is past halfway through its life,
// not on every single request. Sliding does not need to be precise — only to never lapse an active
// session — so this keeps the auth hot path from becoming one write per call.
const SESSION_SLIDE_AFTER_MS = SESSION_TTL_MS / 2;

/**
 * The cache + Postgres key for a session: the token's SHA-256 hash, NEVER the token itself.
 * `resolveSession` hashes the presented token on the way in, so a leaked database (or a heap dump of
 * this process) holds only hashes and hands out nothing usable — the same rule invites and resets
 * already follow.
 */
const sessionKey = (token: string): string => createHash("sha256").update(token).digest("hex");

function hashPassword(pw: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw: string, salt: string, hash: string): boolean {
  const got = scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface AuthScope {
  kind: "key" | "member";
  org_id: string;
  project_id?: string; // set for key auth
  member_id?: string; // set for member auth
  role?: Role;
}

class IdentityStore {
  private orgs = new Map<string, Org>();
  private projects = new Map<string, Project>();
  private members = new Map<string, StoredMember>();
  private apiKeys = new Map<string, { project_id: string; org_id: string }>();
  private sessions = new Map<string, Session>();

  /** Set when a durable backend is attached; writes are mirrored to it. */
  private pg: import("./identity.pg").IdentityPg | null = null;

  constructor() {
    // Bootstrap the default tenant with STABLE ids (see stableUuid) so durable data written in a
    // previous run still resolves to this project. MYCEL_API_KEY is the default project's key.
    const now = new Date().toISOString();
    // Stamped explicitly, because `defaultPlan()` now answers `find` under MYCEL_CLOUD and this
    // org is not a customer — it owns MYCEL_API_KEY, which is the control plane's own credential.
    // Left to the default it would become a starter-limited org on cloud, and the first thing to
    // hit that ceiling would be the machinery that applies everyone else's plans.
    const org: Org = {
      id: stableUuid("default-org"),
      name: "default",
      created_at: now,
      plan: "self_hosted",
      plan_status: "active",
    };
    this.orgs.set(org.id, org);
    const project: Project = {
      id: stableUuid("default-project"), org_id: org.id, name: "default", wedges: [], created_at: now,
      slug: "default",
    };
    this.projects.set(project.id, project);
    this.indexProject(project);
    this.apiKeys.set(loadConfig().apiKey, { project_id: project.id, org_id: org.id });

    // Owner member: from env, or generated + printed (never a blank/known password).
    const email = process.env.MYCEL_OWNER_EMAIL ?? "founder@mycel.local";
    const pw = process.env.MYCEL_OWNER_PASSWORD ?? `own_${randomBytes(9).toString("base64url")}`;
    this.generatedPassword = process.env.MYCEL_OWNER_PASSWORD ? undefined : pw;
    this.ownerEmail = email;
    const { salt, hash } = hashPassword(pw);
    const member: StoredMember = {
      id: stableUuid(`owner:${email.toLowerCase()}`),
      org_id: org.id,
      email: email.toLowerCase(),
      role: "owner",
      created_at: now,
      salt,
      hash,
    };
    this.members.set(member.id, member);
  }

  /** Attach a durable backend: load persisted tenants into the read cache, then mirror writes. */
  async attach(pg: import("./identity.pg").IdentityPg): Promise<void> {
    this.pg = pg;
    const { orgs, projects, members, apiKeys, invites } = await pg.loadAll();
    for (const o of orgs) this.orgs.set(o.id, o);
    for (const p of projects) {
      this.projects.set(p.id, p);
      this.indexProject(p);
    }
    for (const m of members) this.members.set(m.id, m);
    for (const [k, v] of apiKeys) this.apiKeys.set(k, v);
    // Invites outlive a restart deliberately: a link emailed on Friday must still work on Monday.
    for (const i of invites) this.invites.set(i.id, i);
    // persist the bootstrap tenant (idempotent — stable ids)
    for (const o of this.orgs.values()) await pg.upsertOrg(o);
    for (const p of this.projects.values()) await pg.upsertProject(p);
    for (const m of this.members.values()) await pg.upsertMember(m);
    for (const [k, v] of this.apiKeys) await pg.upsertApiKey(k, v);
    // The constructor may have minted a random password because the env var was empty at
    // construct time. After Postgres load, that password is not the login — `loadAll` overwrote
    // the member. Printing it (or upserting it) would rotate a fake `founder@mycel.local` on
    // every boot. Observed on ECS: the secret WAS on the task def, the banner still printed.
    this.generatedPassword = undefined;
  }

  readonly ownerEmail: string;
  generatedPassword?: string;

  resolveApiKey(key: string): AuthScope | undefined {
    const m = this.apiKeys.get(key);
    return m ? { kind: "key", org_id: m.org_id, project_id: m.project_id } : undefined;
  }

  findMemberByEmail(email: string): StoredMember | undefined {
    const wanted = email.trim().toLowerCase();
    return [...this.members.values()].find((m) => m.email === wanted);
  }

  private issue(member: StoredMember, provider: AuthProvider) {
    member.last_provider = provider;
    member.providers = [...new Set([...(member.providers ?? []), provider])];
    const session: Session = {
      token: `msess_${randomBytes(24).toString("base64url")}`,
      member_id: member.id,
      org_id: member.org_id,
      expires_at: Date.now() + SESSION_TTL_MS,
    };
    // Cache keyed by hash (same key Postgres uses), so resolveSession never has to hold the raw
    // token to find a session. Write-through so the session outlives this process and is visible to
    // every other instance — the whole point of persisting them.
    const key = sessionKey(session.token);
    this.sessions.set(key, session);
    if (this.pg) {
      void this.pg.upsertMember(member).catch(() => {});
      void this.pg
        .upsertSession({ token_hash: key, member_id: member.id, org_id: member.org_id, expires_at: session.expires_at })
        .catch(() => {});
    }

    /**
     * A super-admin session is recorded in the hash chain the moment it is minted.
     *
     * An account that can do anything and leaves no trace is the thing you regret, and the trace has
     * to be here rather than at the limit checks. `limitsFor` is a hot synchronous function called on
     * every task creation and every invite; auditing inside it would be an async write on the request
     * path and would produce thousands of identical entries a day, which is not a trail, it is noise
     * that hides one.
     *
     * Every action this session then takes is already audited under `actor: <member_id>`, so one
     * entry per sign-in is enough to join the two: "which of these entries were made by an account
     * with no ceilings, and when did that account exist" both have answers, and the answers are in a
     * chain that cannot be edited without `auditVerify` saying where.
     *
     * `issue()` is the one funnel — login, federated OAuth, invite acceptance and password reset all
     * come through here, so there is no sign-in route that can be added later and miss this.
     */
    if (isSuperAdminEmail(member.email)) {
      // Fire-and-forget: a failure to write the trail must not block a sign-in, and `audit()` already
      // swallows and logs its own errors. The org's first project is the chain to write into —
      // `audit()` no-ops on a falsy project id, which is the correct behaviour for an org whose
      // project creation has not landed yet rather than a reason to throw here.
      void audit({
        project_id: this.listProjects(member.org_id)[0]?.id ?? "",
        actor: member.id,
        action: "superadmin.session",
        entity: "member",
        entity_id: member.id,
        detail: { email: member.email, org_id: member.org_id, provider },
      });
    }
    return { session, member: this.publicMember(member), projects: this.listProjects(member.org_id) };
  }

  login(email: string, pw: string): { session: Session; member: Member; projects: Project[] } | undefined {
    const member = this.findMemberByEmail(email);
    // `!member.hash` means an OAuth-only account. Rejecting here rather than letting an empty
    // password verify against an empty hash is the difference between a guard and a hole.
    if (!member || !member.hash || !verifyPassword(pw, member.salt, member.hash)) return undefined;
    return this.issue(member, "password");
  }

  /**
   * Sign in (or up) someone whose identity a provider has already verified.
   *
   * The kernel never runs the OAuth dance itself — the product does, because that's where the
   * redirect URIs and provider secrets live, and Auth.js already handles the provider zoo. The
   * product then ASSERTS the verified email here, server-to-server with its API key.
   *
   * Which makes the caller's authentication the whole security boundary: this endpoint must never be
   * reachable from a browser, or anyone could claim any email. It is deliberately NOT in the
   * middleware's unauthenticated allowlist.
   *
   * Matching on email means an account reached by password and later by Google is still one account,
   * rather than a silent duplicate the founder can't reconcile.
   */
  federated(args: {
    email: string;
    provider: AuthProvider;
    orgName?: string;
  }): { session: Session; member: Member; projects: Project[]; created: boolean } {
    const existing = this.findMemberByEmail(args.email);
    if (existing) {
      /**
       * An OAuth sign-in verifies the address even when the account was born from a password.
       *
       * `cloud/lib/oauth.ts` refuses a Google identity whose `email_verified` is false and refuses a
       * GitHub address that is not on the account's verified list, so by the time this call is made
       * a provider has already done the thing our own email would be doing — worse, and a day later.
       * Someone who signed up with a password and then pressed "Continue with Google" has proved the
       * address; leaving them looking at a banner that says otherwise would make the product appear
       * to have not noticed.
       */
      this.markEmailVerified(existing);
      return { ...this.issue(existing, args.provider), created: false };
    }
    const { org } = this.createOrgWithOwner(
      args.orgName ?? args.email.split("@")[1] ?? "my business",
      args.email,
      // No password: this account has only ever been reached through a provider. `login()` refuses
      // an empty hash, so this cannot become a password-less way in.
      "",
    );
    const member = this.findMemberByEmail(args.email)!;
    void org;
    // Verified at birth. The requirement is explicit: an OAuth sign-up is never asked to verify an
    // address its provider has already verified.
    this.markEmailVerified(member);
    return { ...this.issue(member, args.provider), created: true };
  }

  /** Register a brand-new org with its own owner. Returns undefined if the email is taken. */
  signup(args: {
    email: string;
    password: string;
    orgName?: string;
  }): { session: Session; member: Member; projects: Project[] } | undefined {
    if (this.findMemberByEmail(args.email)) return undefined;
    this.createOrgWithOwner(args.orgName ?? args.email.split("@")[1] ?? "my business", args.email, args.password);
    return this.issue(this.findMemberByEmail(args.email)!, "password");
  }

  /**
   * Begin a password reset. Returns the token for the product to email.
   *
   * Only the HASH is stored, so a stolen database yields no usable reset links. Returns undefined for
   * an unknown email; the caller must still respond identically either way, or the endpoint becomes
   * an account-enumeration oracle.
   */
  requestReset(email: string, ttlMs = 30 * 60_000): { token: string; email: string } | undefined {
    const member = this.findMemberByEmail(email);
    if (!member) return undefined;
    const token = `mrst_${randomBytes(24).toString("base64url")}`;
    member.reset_hash = createHash("sha256").update(token).digest("hex");
    member.reset_expires = Date.now() + ttlMs;
    if (this.pg) void this.pg.upsertMember(member).catch(() => {});
    return { token, email: member.email };
  }

  /** Complete a reset. Single-use and time-bound; consuming it also signs them in. */
  confirmReset(
    token: string,
    password: string,
  ): { session: Session; member: Member; projects: Project[] } | undefined {
    const digest = createHash("sha256").update(token).digest("hex");
    const member = [...this.members.values()].find((m) => m.reset_hash === digest);
    if (!member || !member.reset_expires || member.reset_expires < Date.now()) return undefined;
    const { salt, hash } = hashPassword(password);
    member.salt = salt;
    member.hash = hash;
    // Cleared immediately: a reset link that works twice is a reset link an attacker can reuse from
    // a mailbox they briefly saw.
    member.reset_hash = undefined;
    member.reset_expires = undefined;
    // Completing a reset proves the address as thoroughly as a verification link does: the token
    // being spent here was delivered to that inbox and nowhere else. Not marking it would mean a
    // founder who verified by the harder route still saw the banner.
    this.markEmailVerified(member);
    // A reset is a credential change. Old sessions stay valid unless we drop them — that is how a
    // stolen cookie survives a password the founder just rotated. Drop from BOTH the cache and
    // Postgres: the cache only holds sessions this instance has seen, so Postgres is the real revoke.
    for (const [tok, s] of this.sessions) if (s.member_id === member.id) this.sessions.delete(tok);
    if (this.pg) void this.pg.deleteSessionsForMember(member.id).catch(() => {});
    return this.issue(member, "password");
  }

  /**
   * Mint a verification link for a member who is ALREADY SIGNED IN.
   *
   * ─── Why the argument is a member id and never an email ───────────────────────────────────────
   *
   * The obvious API is `requestVerification(email)`, and it is an account-enumeration oracle. Every
   * defence against that — answer `ok` regardless, keep the timing flat — is a promise the whole
   * call chain has to keep, and `requestReset` above shows how much comment it takes to keep it.
   * There is no need to take on that promise here: the only person who ever needs a verification
   * email is the person holding the session for the account, and they are by definition
   * authenticated. An unauthenticated caller cannot name a member id it does not already have, so
   * this endpoint cannot be asked "does bob@acme.com exist" at all. That is a stronger property
   * than answering carefully, and it is free.
   *
   * Returns the token for the PRODUCT to email. The kernel does not send mail — see `cloud/lib/mail.ts`
   * for why delivery belongs to the product.
   */
  requestVerification(
    memberId: string,
    opts?: { ttlMs?: number; now?: number },
  ): VerificationRequest {
    const now = opts?.now ?? Date.now();
    const member = this.members.get(memberId);
    if (!member) return { status: "unknown-member" };
    // Checked BEFORE the rate limit. Someone whose address is already verified asking again is not
    // abuse and must not be told to wait a minute for a message that was never going to be sent.
    if (member.email_verified_at) return { status: "already-verified", email: member.email };

    const sends = (member.verify_sends ?? []).filter((t) => now - t < VERIFY_WINDOW_MS);
    const last = sends[sends.length - 1];
    if (last !== undefined && now - last < VERIFY_MIN_INTERVAL_MS) {
      return { status: "throttled", retry_after_ms: VERIFY_MIN_INTERVAL_MS - (now - last) };
    }
    if (sends.length >= VERIFY_MAX_PER_WINDOW) {
      // Wait until the OLDEST send in the window falls out of it, which is the moment a further
      // send becomes allowed. Reporting the interval instead would invite a retry that fails again.
      return { status: "throttled", retry_after_ms: VERIFY_WINDOW_MS - (now - sends[0]) };
    }

    const token = `mver_${randomBytes(24).toString("base64url")}`;
    member.verify_hash = createHash("sha256").update(token).digest("hex");
    member.verify_expires = now + (opts?.ttlMs ?? VERIFY_TTL_MS);
    // Recorded at MINT rather than after a successful send. The product's send is fire-and-forget
    // over a third party's API and can hang; a limit that only counts confirmed deliveries is a
    // limit a retry loop walks straight through.
    member.verify_sends = [...sends, now];
    if (this.pg) void this.pg.upsertMember(member).catch(() => {});
    return { status: "sent", token, email: member.email };
  }

  /**
   * Spend a verification link.
   *
   * Single-use and time-bound, exactly like `confirmReset`, and for the same reason: a link that
   * works twice is a link that still works from a mailbox someone briefly had sight of.
   *
   * It deliberately does NOT issue a session. A reset link has to sign you in because you have just
   * chosen a password and typing it again immediately would be absurd; a verification link has no
   * such excuse, and a GET in an email that mints a session is a much larger thing to hand to
   * whatever fetched it. The person clicking this is, almost always, already signed in in the tab
   * behind it.
   */
  confirmVerification(token: string, now = Date.now()): { member: Member } | undefined {
    if (!token) return undefined;
    const digest = createHash("sha256").update(token).digest("hex");
    const member = [...this.members.values()].find((m) => m.verify_hash === digest);
    if (!member || !member.verify_expires || member.verify_expires < now) return undefined;
    return { member: this.markEmailVerified(member, now) };
  }

  /**
   * Record that this address is real, and clear anything outstanding that was trying to prove it.
   *
   * One funnel with four callers (see `Member.email_verified_at`) so that no future route can set
   * the timestamp and leave a live token behind it — a spent proof whose link still works is a
   * credential nobody is watching any more.
   *
   * Idempotent on the TIMESTAMP: re-verifying keeps the first one. When we learned this is a fact
   * about the past, and overwriting it with "now" on every subsequent OAuth sign-in would quietly
   * destroy the only evidence there is.
   */
  private markEmailVerified(member: StoredMember, now = Date.now()): Member {
    if (!member.email_verified_at) member.email_verified_at = new Date(now).toISOString();
    member.verify_hash = undefined;
    member.verify_expires = undefined;
    member.verify_sends = undefined;
    if (this.pg) void this.pg.upsertMember(member).catch(() => {});
    return this.publicMember(member);
  }

  async resolveSession(token: string): Promise<AuthScope | undefined> {
    const key = sessionKey(token);
    const now = Date.now();

    // Cache first. A hit is the common case and costs nothing.
    let s = this.sessions.get(key);

    // Miss → read through to Postgres. THIS is what makes a session valid on an instance that did
    // not mint it: at millions of users behind many replicas, the process that created the session
    // is almost never the one answering the next request. A miss on a store with no backend just
    // 401s a logged-in founder; a miss here asks the source of truth.
    if (!s && this.pg) {
      const row = await this.pg.getSession(key).catch(() => undefined);
      if (row) {
        s = { token: "", member_id: row.member_id, org_id: row.org_id, expires_at: row.expires_at };
        this.sessions.set(key, s);
      }
    }
    if (!s) return undefined;

    if (now > s.expires_at) {
      this.sessions.delete(key);
      if (this.pg) void this.pg.deleteSession(key).catch(() => {});
      return undefined;
    }

    // Slide the expiry forward on use so an active session never lapses, throttled to once past
    // halfway through its life so a busy request path is not one Postgres write per call.
    if (s.expires_at - now < SESSION_SLIDE_AFTER_MS) {
      s.expires_at = now + SESSION_TTL_MS;
      if (this.pg)
        void this.pg
          .upsertSession({ token_hash: key, member_id: s.member_id, org_id: s.org_id, expires_at: s.expires_at })
          .catch(() => {});
    }

    const member = this.members.get(s.member_id);
    return { kind: "member", org_id: s.org_id, member_id: s.member_id, role: member?.role };
  }

  getMember(id: string): Member | undefined {
    const m = this.members.get(id);
    return m ? this.publicMember(m) : undefined;
  }

  /**
   * Merge a patch into a member's own preferences.
   *
   * MERGE, not replace, and shallow. Two tabs — the onboarding flow in one and the product tour in
   * the other — must not be able to erase each other's field by each PUTting the whole object it
   * happened to have read. Shallow because these are flat scalars; a deep merge would introduce a
   * "how do I delete a nested key" question that nothing here needs to ask.
   *
   * `null` deletes, which is the only way to remove a key at all under a merge. `undefined` is
   * absent-from-JSON and therefore means "don't touch this one", which is what a partial patch from
   * a form with three fields and one filled in actually means.
   *
   * Returns the member as the caller may see it, so the route has nothing to re-read.
   */
  setMemberPrefs(id: string, patch: Record<string, unknown>): Member | undefined {
    const m = this.members.get(id);
    if (!m) return undefined;
    const next: MemberPrefs = { ...(m.prefs ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (RESERVED_PREFS.has(k)) continue;
      if (v === undefined) continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    // Refuse the whole write rather than silently truncating. A pref that came back different from
    // what was sent is worse than one that visibly failed: the product would render the truncated
    // value believing it had stored the real one.
    if (Object.keys(next).length > PREFS_MAX_KEYS) return undefined;
    if (JSON.stringify(next).length > PREFS_MAX_JSON_CHARS) return undefined;
    m.prefs = next;
    // Fire-and-forget mirroring, exactly like `issue()` above. A preference is not worth making the
    // caller wait on a database round trip, and the read cache is already correct.
    if (this.pg) void this.pg.upsertMember(m).catch(() => {});
    return this.publicMember(m);
  }

  /**
   * Record a questionnaire answer. The only writer of `prefs.surveys`.
   *
   * PATCH cannot reach that key (see `RESERVED_PREFS`), so the scores on the Product page are
   * answers this method accepted — a valid prompt id, a 1–5 or a skip — not a bag a session stuffed.
   */
  recordSurvey(
    id: string,
    body: { prompt_id: string; score?: number; skip?: boolean; comment?: string },
  ): Member | { error: string } | undefined {
    const m = this.members.get(id);
    if (!m) return undefined;
    if (!SURVEY_IDS.has(body.prompt_id) || !promptById(body.prompt_id)) {
      return { error: "unknown prompt" };
    }
    const skip = body.skip === true;
    const score = body.score;
    const comment =
      typeof body.comment === "string" ? body.comment.trim().slice(0, 500) || undefined : undefined;
    if (!skip) {
      const hasScore = typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 5;
      if (!hasScore && !comment) {
        return { error: "score must be an integer from 1 to 5, or write a sentence" };
      }
      if (score !== undefined && !hasScore) {
        return { error: "score must be an integer from 1 to 5" };
      }
    }
    const at = new Date().toISOString();
    const log = asSurveyLog(m.prefs?.surveys);
    log.answers[body.prompt_id] = {
      at,
      score: skip ? undefined : typeof score === "number" ? score : undefined,
      skip: skip || undefined,
      comment,
    };
    log.last_at = at;
    const next: MemberPrefs = { ...(m.prefs ?? {}), surveys: log };
    if (JSON.stringify(next).length > PREFS_MAX_JSON_CHARS) return { error: "preferences are too large" };
    m.prefs = next;
    if (this.pg) void this.pg.upsertMember(m).catch(() => {});
    return this.publicMember(m);
  }

  surveyLog(id: string) {
    const m = this.members.get(id);
    return m ? asSurveyLog(m.prefs?.surveys) : emptySurveyLog();
  }

  listOrgs(): Org[] {
    return [...this.orgs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listAllMembers(): Member[] {
    return [...this.members.values()].map((m) => this.publicMember(m));
  }

  listAllProjects(): Project[] {
    return [...this.projects.values()];
  }

  markDigestSent(orgId: string, at = new Date().toISOString()): Org | undefined {
    const org = this.orgs.get(orgId);
    if (!org) return undefined;
    org.last_digest_at = at;
    if (this.pg) void this.pg.upsertOrg(org).catch(() => {});
    return org;
  }

  listProjects(orgId: string): Project[] {
    return [...this.projects.values()].filter((p) => p.org_id === orgId);
  }
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /**
   * The org that owns this project, reading through to the database on a cache miss.
   *
   * ═══ THE PRODUCTION FAILURE THIS EXISTS FOR ═══
   *
   * The read cache is filled at boot and never refreshed. The API container creates the org, so it
   * has it; the WORKER container — a separate process that runs every task off the queue — booted
   * earlier and does not. So for any org created since the last deploy, the run's own
   * `getProject(task.project_id)` was undefined, which made the org id undefined, which meant
   * `keyForOrg` was never called and no LiteLLM virtual key ever existed. The run then fell back to
   * OpenAI direct with an empty key and the founder was shown OpenAI's 401 telling him to go and get
   * an API key. Verified on app.mycelai.dev: worker up at 18:41:12Z, project created 18:43:41Z, run
   * failed 18:44:51Z at $0.00, and LiteLLM's log group showed only health checks.
   *
   * A read-through on miss rather than a refresh timer: a timer picks a staleness window and is
   * wrong for everything inside it, and it would also re-read the whole tenant table on every tick.
   * The miss is the exact moment the answer is needed and the only moment it costs a query.
   *
   * Hydrates the ORG AND ITS MEMBERS too, not just the project. `limitsFor` on an org missing from
   * the cache returns `PLAN_LIMITS[self_hosted]`, whose model budget is unmetered, and
   * `orgIsUnlimited` scans members — so half a hydration would have swapped "no key at all" for
   * "an uncapped key for a stranger", which is worse.
   *
   * Async by necessity, so callers on the hot synchronous auth path keep using `getProject`; this is
   * for the run path, which is already awaiting everything.
   */
  async loadProject(projectId: string): Promise<Project | undefined> {
    const cached = this.projects.get(projectId);
    if (cached) return cached;
    if (!this.pg) return undefined;
    try {
      const { project, org, members } = await this.pg.loadProjectScope(projectId);
      if (!project) return undefined;
      this.projects.set(project.id, project);
      this.indexProject(project);
      if (org) this.orgs.set(org.id, org);
      for (const m of members) this.members.set(m.id, m);
      return project;
    } catch (e) {
      // Reported, never thrown. The caller's answer to "no project" is now an honest refusal (see
      // runtime.ts), so a database blip surfaces as a named failure rather than as a provider 401.
      console.error("[mycel] identity read-through failed:", (e as Error).message);
      return undefined;
    }
  }

  /** The org that owns this project. See `loadProject` — same read-through, same reason. */
  async orgIdForProject(projectId: string): Promise<string | undefined> {
    return (await this.loadProject(projectId))?.org_id;
  }

  /** The set of project ids a scope may read. Key → its one project; member → all in its org. */
  /**
   * The projects a READ may see.
   *
   * `requested` is the `X-Mycel-Project` header. Supplying it NARROWS the result to that one
   * project; omitting it means "everything I can see", which is what a fleet-wide view wants.
   *
   * This is the single chokepoint every read route filters through, so narrowing here is what makes
   * a per-project view possible at all. Without it a member in an org with two projects gets both
   * businesses blended into one list — two clients' tasks in one timeline, with nothing marking
   * which is which.
   *
   * Fails closed: a header naming a project outside the caller's scope yields an EMPTY set, not the
   * full one. Asking for something you can't have must never widen what you get.
   */
  accessibleProjectIds(scope: AuthScope, requested?: string): Set<string> {
    const all =
      scope.kind === "key" && scope.project_id
        ? new Set([scope.project_id])
        : new Set(this.listProjects(scope.org_id).map((p) => p.id));
    if (!requested) return all;
    return all.has(requested) ? new Set([requested]) : new Set<string>();
  }

  /** The project a write lands in. Key → fixed. Member → the requested one (if in org), else the
   *  org's sole project, else undefined (the caller must then 400 asking which project). */
  resolveWriteProject(scope: AuthScope, requested?: string): string | undefined {
    if (scope.kind === "key") return scope.project_id;
    const inOrg = this.listProjects(scope.org_id);
    if (requested && inOrg.some((p) => p.id === requested)) return requested;
    if (inOrg.length === 1) return inOrg[0].id;
    return undefined;
  }

  /** A project may run a wedge if its allowlist is empty (all) or contains the slug. */
  projectAllowsWedge(projectId: string, wedge: string): boolean {
    const p = this.projects.get(projectId);
    if (!p) return false;
    return p.wedges.length === 0 || p.wedges.includes(wedge);
  }

  // ---------------------------------------------------------------------------------------------
  // Where a business answers
  //
  // One deployment serves every founder's client portal, resolved by hostname. Deliberately not a
  // container per tenant: the business app holds no data — it renders and forwards a client session,
  // and the KERNEL decides what comes back from that session, not from the hostname. So the worst a
  // host-resolution bug can do is show the wrong logo, where a container per tenant would buy that
  // same isolation at the cost of N deployments to patch on every security fix and a provisioning
  // wait at signup.
  //
  // The hazard that IS real is cookie scope: portal sessions must be scoped to the exact host, never
  // to the parent domain, or a client of one business could carry their session onto another's.
  // ---------------------------------------------------------------------------------------------

  /** Reserved because they are, or will be, ours. A founder claiming `app` would be a phishing kit. */
  private static RESERVED = new Set([
    "app", "platform", "cloud", "www", "docs", "api", "admin", "mail", "status",
    "blog", "help", "support", "static", "assets", "cdn", "auth", "login", "portal",
  ]);

  /** A hostname-safe slug: lowercase, alphanumeric and hyphens, never leading/trailing hyphen. */
  static slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  /** Allocate a free slug near `name`, suffixing only when it has to. */
  allocateSlug(name: string): string {
    const base = IdentityStore.slugify(name) || "business";
    const taken = (s: string) => IdentityStore.RESERVED.has(s) || this.bySlug.has(s);
    if (!taken(base)) return base;
    for (let n = 2; n < 500; n++) {
      const candidate = `${base}-${n}`;
      if (!taken(candidate)) return candidate;
    }
    return `${base}-${randomBytes(3).toString("hex")}`;
  }

  /**
   * Which project serves this hostname.
   *
   * A verified custom domain wins over the subdomain, so a founder who has moved to their own
   * domain keeps working on both. An UNVERIFIED custom domain resolves to nothing — otherwise
   * claiming a domain you don't own would let you serve a portal on it the moment DNS happened to
   * point your way.
   */
  projectForHost(host: string, rootDomain: string | string[]): Project | undefined {
    const h = (host ?? "").toLowerCase().split(":")[0].replace(/\.$/, "");
    if (!h) return undefined;
    const customId = this.byDomain.get(h);
    const byCustom = customId ? this.projects.get(customId) : undefined;
    if (byCustom?.custom_domain_verified_at) return byCustom;
    // MORE THAN ONE ROOT, because a tenant site is served at `<slug>.apps.mycelai.dev` while the
    // console and the docs live at `<x>.mycelai.dev`. With a single "mycelai.dev" root the tenant
    // host `northstar-studio.apps.mycelai.dev` left the sub-label `northstar-studio.apps`, which has
    // a dot and was rejected — so EVERY generated site's runtime brand lookup 404'd and the site
    // fell back to house defaults (green, "Your business"). Try each candidate root; the first whose
    // sub-label is a single slug wins. Longest root first so `apps.mycelai.dev` is tried before the
    // bare `mycelai.dev` and the extra label is consumed rather than left dangling.
    const roots = (Array.isArray(rootDomain) ? rootDomain : [rootDomain])
      .map((r) => r.toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const root of roots) {
      if (!h.endsWith(`.${root}`)) continue;
      const sub = h.slice(0, -(root.length + 1));
      // Only one level. `a.b.apps.mycelai.dev` must not resolve as `a` — a wildcard certificate
      // covers one label, and treating deeper names as a match would make the boundary fuzzy.
      if (!sub || sub.includes(".")) continue;
      const id = this.bySlug.get(sub);
      if (id) return this.projects.get(id);
    }
    return undefined;
  }

  /** Claim a domain the founder says they own. Returns the TXT record they must publish. */
  claimDomain(projectId: string, domain: string): { record: { name: string; value: string } } | { error: string } {
    const p = this.projects.get(projectId);
    if (!p) return { error: "no such project" };
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { error: "that doesn't look like a domain" };
    const clash = [...this.projects.values()].find((x) => x.custom_domain === d && x.id !== projectId);
    if (clash) return { error: "that domain is already claimed" };
    // Re-indexed below: claiming a NEW domain must drop the old one from the routing table, or a
    // founder who moves domains keeps serving on the one they abandoned.
    if (p.custom_domain && p.custom_domain !== d) this.byDomain.delete(p.custom_domain);
    p.custom_domain = d;
    p.custom_domain_verified_at = undefined;
    this.byDomain.delete(d);
    p.domain_verify_token = `mycel-verify=${randomBytes(16).toString("hex")}`;
    if (this.pg) void this.pg.upsertProject(p).catch(() => {});
    return { record: { name: `_mycel.${d}`, value: p.domain_verify_token } };
  }

  /**
   * Record that a claim checked out. The DNS lookup itself lives in the server layer, because the
   * store has no business doing network I/O.
   */
  markDomainVerified(projectId: string): Project | undefined {
    const p = this.projects.get(projectId);
    if (!p || !p.custom_domain) return undefined;
    p.custom_domain_verified_at = new Date().toISOString();
    p.domain_verify_token = undefined;
    this.indexProject(p);
    if (this.pg) void this.pg.upsertProject(p).catch(() => {});
    return p;
  }

  /** Branding is what a customer sees, so it belongs to the founder, not to us. */
  setBranding(projectId: string, branding: Project["branding"]): Project | undefined {
    const p = this.projects.get(projectId);
    if (!p) return undefined;
    p.branding = { ...p.branding, ...branding };
    if (this.pg) void this.pg.upsertProject(p).catch(() => {});
    return p;
  }

  /**
   * This project's brand, resolved — the single input every artifact renderer takes.
   *
   * Keyed by project id and returning `undefined` for a project that does not exist, rather than a
   * default kit: an unknown id must not quietly get house branding, because the caller that passed a
   * bad id is exactly the caller that would then render one tenant's invoice under another's brand.
   * Fail closed, like every other project-scoped read in this file.
   */
  brandKit(projectId: string): BrandKit | undefined {
    const p = this.projects.get(projectId);
    return p ? resolveBrandKit(p.branding, p.name) : undefined;
  }

  /** Create a project (+ its own product API key) in an org. Mirrored to the durable backend. */
  createProject(orgId: string, name: string, wedges: string[] = []): { project: Project; apiKey: string } {
    const project: Project = {
      id: randomUUID(),
      org_id: orgId,
      name,
      wedges,
      created_at: new Date().toISOString(),
      // Allocated now and never changed. It ends up in emails to a founder's customers, and a link
      // that breaks because someone renamed a project is worse than an ugly slug.
      slug: this.allocateSlug(name),
    };
    this.projects.set(project.id, project);
    this.indexProject(project);
    const apiKey = `msk_${randomBytes(24).toString("base64url")}`;
    this.apiKeys.set(apiKey, { project_id: project.id, org_id: orgId });
    if (this.pg) {
      const pg = this.pg;
      void pg.upsertProject(project).then(() => pg.upsertApiKey(apiKey, { project_id: project.id, org_id: orgId }))
        .catch((e) => console.error("[mycel] persist project error:", e));
    }
    return { project, apiKey };
  }

  /** Create a fresh org with an owner member (used to add tenants; also lets tests prove isolation). */
  createOrgWithOwner(orgName: string, email: string, password: string): { org: Org; project: Project; apiKey: string } {
    /**
     * Stamped at creation rather than left undefined, so that "what is this org entitled to" has an
     * answer written down instead of one inferred from two absent fields.
     *
     * On cloud: the plan they are about to be sold, with NO subscription behind it. `limitsFor`
     * reads the status, sees `none`, and hands back `INACTIVE_LIMITS` — so the window between
     * "signed up" and "card accepted" grants nothing. That window used to be the free tier, which
     * is how we ended up paying for model spend on accounts that had signalled nothing.
     *
     * Off cloud: unchanged. A self-hoster's org is `self_hosted`/`active` and meets no ceiling,
     * which is the property `MYCEL_CLOUD` being opt-in exists to protect.
     */
    const cloud = cloudMode();
    const org: Org = {
      id: randomUUID(),
      name: orgName,
      created_at: new Date().toISOString(),
      plan: defaultPlan(),
      plan_status: cloud ? "none" : "active",
    };
    this.orgs.set(org.id, org);
    /**
     * The org's first project takes the ORG'S NAME, not the literal string "default".
     *
     * A project name is not internal. It is what the product's own switcher and sidebar print, so
     * every account created through the sign-up form was greeted with "default business" in the
     * sidebar moments after onboarding had spent six screens establishing what the business is
     * actually called. `orgName` is already whatever the founder typed (or the fallback derived from
     * their email), which makes it the only honest label available at this point.
     */
    const { project, apiKey } = this.createProject(org.id, orgName || "default");
    // An empty password means "no password login", NOT "the password is the empty string".
    // `hashPassword("")` returns a perfectly valid 64-byte hash, so without this an OAuth-only
    // account created with `""` could be signed into by anyone submitting a blank password.
    const { salt, hash } = password ? hashPassword(password) : { salt: "", hash: "" };
    const member: StoredMember = {
      id: randomUUID(), org_id: org.id, email: email.toLowerCase(), role: "owner",
      created_at: new Date().toISOString(), salt, hash,
    };
    this.members.set(member.id, member);
    if (this.pg) {
      const pg = this.pg;
      void pg.upsertOrg(org).then(() => pg.upsertMember(member)).catch((e) => console.error("[mycel] persist org error:", e));
    }
    return { org, project, apiKey };
  }
  // ---------------------------------------------------------------------------------------------
  // Team
  //
  // A member belongs to exactly one org. That's the constraint everything below is shaped by: an
  // invite doesn't "add an org" to an existing account, it creates an account. An email that already
  // exists anywhere is therefore refused rather than silently moved, because moving someone between
  // orgs would take their old org's data access away without anyone asking for that.
  // ---------------------------------------------------------------------------------------------

  private invites = new Map<string, StoredInvite>();

  /**
   * Hostname → project, maintained alongside `projects`.
   *
   * `projectForHost` runs on EVERY request to the customer-facing app — it is how the page knows
   * whose brand to render — and it used to scan every project in the process to answer. That is
   * O(tenants) per page load, on the hottest path in the product. These two indexes make it O(1).
   *
   * Rebuilt wholesale on attach and patched on every write, because a stale index here serves one
   * founder's branding to another's customers.
   */
  private bySlug = new Map<string, string>();
  private byDomain = new Map<string, string>();

  private indexProject(p: Project): void {
    if (p.slug) this.bySlug.set(p.slug, p.id);
    // Only a VERIFIED domain is routable. Indexing an unverified claim would serve a portal on a
    // domain nobody has proved they own.
    if (p.custom_domain && p.custom_domain_verified_at) this.byDomain.set(p.custom_domain, p.id);
    else if (p.custom_domain) this.byDomain.delete(p.custom_domain);
  }

  listMembers(orgId: string): Member[] {
    return [...this.members.values()]
      .filter((m) => m.org_id === orgId)
      .map((m) => this.publicMember(m))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Invite someone. Returns the raw token exactly once — the product emails it and cannot recover
   * it afterwards, which is the point.
   *
   * Re-inviting the same address replaces the outstanding invite instead of accumulating a pile of
   * live links to the same mailbox.
   */
  invite(args: {
    orgId: string;
    email: string;
    role: Role;
    invitedBy: string;
    ttlMs?: number;
  }): { invite: Invite; token: string } | { error: "taken" | "already_invited_elsewhere" } {
    const email = args.email.trim().toLowerCase();
    if (this.findMemberByEmail(email)) return { error: "taken" };
    const clash = [...this.invites.values()].find(
      (i) => i.email === email && !i.accepted_at && i.org_id !== args.orgId && i.expires_at > Date.now(),
    );
    if (clash) return { error: "already_invited_elsewhere" };

    for (const [id, i] of this.invites) {
      if (i.org_id === args.orgId && i.email === email && !i.accepted_at) this.invites.delete(id);
    }
    const token = `minv_${randomBytes(24).toString("base64url")}`;
    const invite: StoredInvite = {
      id: randomUUID(),
      org_id: args.orgId,
      email,
      // Nobody can mint a second owner by invitation. There is one owner per org and it is the
      // account that created it; an invited administrator can do everything else.
      role: args.role === "owner" ? "admin" : args.role,
      invited_by: args.invitedBy,
      created_at: new Date().toISOString(),
      expires_at: Date.now() + (args.ttlMs ?? INVITE_TTL_MS),
      token_hash: createHash("sha256").update(token).digest("hex"),
    };
    this.invites.set(invite.id, invite);
    if (this.pg) void this.pg.upsertInvite(invite).catch(() => {});
    return { invite: this.publicInvite(invite), token };
  }

  /** Outstanding invitations, newest first. Expired ones are shown — the fix is to resend, and
   *  hiding them makes "I never got it" impossible to diagnose. */
  listInvites(orgId: string): (Invite & { expired: boolean })[] {
    return [...this.invites.values()]
      .filter((i) => i.org_id === orgId && !i.accepted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((i) => ({ ...this.publicInvite(i), expired: i.expires_at < Date.now() }));
  }

  revokeInvite(orgId: string, id: string): boolean {
    const i = this.invites.get(id);
    // Scoped by org, not just by id: an id from another tenant must miss, not delete.
    if (!i || i.org_id !== orgId) return false;
    this.invites.delete(id);
    if (this.pg) void this.pg.deleteInvite(id).catch(() => {});
    return true;
  }

  /** What an invite link shows before anyone commits to anything — no session required. */
  peekInvite(token: string): { email: string; org_name: string; role: Role } | undefined {
    const i = this.findInvite(token);
    if (!i) return undefined;
    return { email: i.email, org_name: this.orgs.get(i.org_id)?.name ?? "a team", role: i.role };
  }

  /**
   * Accept an invitation.
   *
   * `password` may be empty for someone arriving via OAuth — `login()` refuses an empty hash, so
   * that cannot become a password-less way in.
   */
  acceptInvite(
    token: string,
    password: string,
    provider: AuthProvider = "password",
  ): { session: Session; member: Member; projects: Project[] } | undefined {
    const invite = this.findInvite(token);
    if (!invite) return undefined;
    // Between sending and accepting, someone may have signed up with that address directly.
    if (this.findMemberByEmail(invite.email)) return undefined;
    const { salt, hash } = password ? hashPassword(password) : { salt: "", hash: "" };
    const member: StoredMember = {
      id: randomUUID(),
      org_id: invite.org_id,
      email: invite.email,
      role: invite.role,
      created_at: new Date().toISOString(),
      salt,
      hash,
      /**
       * An invited teammate arrives verified, and the invite link is the proof.
       *
       * `createInvite` writes the address; the person accepting could only have the token because it
       * was delivered to that address. Sending a second email to confirm what the first email just
       * demonstrated would be the product asking a question it has already been answered — and it
       * would gate a new colleague out of inviting the next one on their first afternoon.
       */
      email_verified_at: new Date().toISOString(),
    };
    this.members.set(member.id, member);
    invite.accepted_at = new Date().toISOString();
    if (this.pg) {
      const pg = this.pg;
      void pg.upsertMember(member).then(() => pg.upsertInvite(invite)).catch(() => {});
    }
    return this.issue(member, provider);
  }

  /** Change a member's role. The org's owner cannot be demoted — that would leave it unadministrable. */
  setMemberRole(orgId: string, memberId: string, role: Role): Member | { error: string } {
    const m = this.members.get(memberId);
    if (!m || m.org_id !== orgId) return { error: "no such member" };
    if (m.role === "owner") return { error: "the owner's role cannot be changed" };
    if (role === "owner") return { error: "an org has one owner" };
    m.role = role;
    if (this.pg) void this.pg.upsertMember(m).catch(() => {});
    return this.publicMember(m);
  }

  /** Remove a member and every session they hold, so revoking access takes effect now. */
  removeMember(orgId: string, memberId: string): { ok: true } | { error: string } {
    const m = this.members.get(memberId);
    if (!m || m.org_id !== orgId) return { error: "no such member" };
    if (m.role === "owner") return { error: "the owner cannot be removed" };
    this.members.delete(memberId);
    for (const [token, s] of this.sessions) if (s.member_id === memberId) this.sessions.delete(token);
    if (this.pg) {
      void this.pg.deleteSessionsForMember(memberId).catch(() => {});
      void this.pg.deleteMember(memberId).catch(() => {});
    }
    return { ok: true };
  }

  private findInvite(token: string): StoredInvite | undefined {
    const digest = createHash("sha256").update(token).digest("hex");
    const i = [...this.invites.values()].find((x) => x.token_hash === digest);
    if (!i || i.accepted_at || i.expires_at < Date.now()) return undefined;
    return i;
  }

  /** Allowlist, for the same reason `publicMember` is one: a subtractive spread leaks whatever
   *  field someone adds to StoredInvite next, and the next one is as likely to be a secret. */
  private publicInvite(i: StoredInvite): Invite {
    return {
      id: i.id,
      org_id: i.org_id,
      email: i.email,
      role: i.role,
      invited_by: i.invited_by,
      created_at: i.created_at,
      expires_at: i.expires_at,
      accepted_at: i.accepted_at,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Plan & limits
  // ---------------------------------------------------------------------------------------------

  getOrg(id: string): Org | undefined {
    return this.orgs.get(id);
  }

  /**
   * Is this member one of the uncapped accounts?
   *
   * The email is the identity, and it comes from the member row rather than from anything the
   * caller supplied — a session resolves to a member id, and the id resolves to the address we
   * stored. Nothing on the wire is compared against the allowlist.
   */
  isSuperAdminMember(memberId?: string): boolean {
    if (!memberId) return false;
    return isSuperAdminEmail(this.members.get(memberId)?.email);
  }

  /**
   * Does this org run without ceilings?
   *
   * THE ORG'S OWNER, not "any member of the org", and the difference is a cross-tenant leak waiting
   * to happen. If any member sufficed, then the moment a super-admin accepted an invitation into a
   * customer's org — to debug something, which is exactly why they would — that customer's limits
   * would silently come off and stay off, and their bill would be whatever their agents felt like
   * spending. The owner is the account that created the org and cannot be changed or removed
   * (`setMemberRole`, `removeMember`), so this is a stable property of the tenant rather than of
   * whoever happens to be in the room.
   *
   * This is THE answer to "is this actor unlimited". Everything that enforces a numeric ceiling goes
   * through `limitsFor`, which calls this; the model-tier ceiling calls it too (see `models.ts`).
   * There is no second copy of this question anywhere.
   */
  orgIsUnlimited(orgId: string): boolean {
    const owner = [...this.members.values()].find((m) => m.org_id === orgId && m.role === "owner");
    return isSuperAdminEmail(owner?.email);
  }

  /**
   * May this org start new work at all, and if not, why not?
   *
   * Returns the blocking status, or `null` when work may proceed. Separate from `limitsFor` because
   * a REASON and a NUMBER are different things: `INACTIVE_LIMITS` would refuse a task anyway, but it
   * would refuse it with "your plan includes 0 jobs a month", and a founder whose scheduled work
   * just stopped deserves the sentence rather than the arithmetic.
   *
   * Routed through `orgIsUnlimited` for the same reason `limitsFor` is — this is a ceiling, and a
   * super-admin has none. Without that first line the founder's own org, which has no subscription
   * and never will, would be refused every task by the check that exists to catch lapsed customers.
   * It is exactly the sort of thing that gets discovered in a demo.
   */
  workBlockedBy(orgId: string): "none" | "cancelled" | null {
    if (this.orgIsUnlimited(orgId)) return null;
    const status = this.orgs.get(orgId)?.plan_status;
    return status === "none" || status === "cancelled" ? status : null;
  }

  /**
   * The limits in force. The single chokepoint every numeric ceiling in the system reads from.
   *
   * Order matters. Super-admin wins over everything, including plan status — an uncapped account
   * with no subscription is the normal state for the accounts this exists for. Then plan status,
   * then the plan itself.
   *
   * `trialing` deliberately falls through to `PLAN_LIMITS[plan]`, so A TRIALLING ORG HAS THE FULL
   * LIMITS OF THE PLAN IT IS TRIALLING. It is not a hidden fourth tier. Someone evaluating Growth
   * for seven days is evaluating ten businesses, ten seats and 10,000 jobs, because a trial that
   * quietly capped them at the old free tier's hundred jobs would answer a question nobody asked
   * and lose the deal on a number we invented.
   *
   * `past_due` also falls through, on purpose — see `PlanStatus`. That is the failed-first-charge
   * path and it keeps the business running.
   */
  limitsFor(orgId: string): Limits {
    if (this.orgIsUnlimited(orgId)) return UNLIMITED_LIMITS;
    const org = this.orgs.get(orgId);
    const status = org?.plan_status;
    // An absent status means a row written before plan status existed, or a self-hosted install
    // that has never been told anything. Both are "active" — never "none", which would paywall
    // every self-hoster on the next release.
    if (status === "cancelled" || status === "none") return INACTIVE_LIMITS;
    const plan = org?.plan ?? defaultPlan();
    return PLAN_LIMITS[plan] ?? PLAN_LIMITS.self_hosted;
  }

  /** Set by the commercial control plane after a payment event. The kernel takes it on trust,
   *  which is why the route behind it demands a product key. */
  setPlan(
    orgId: string,
    patch: { plan?: Plan; status?: PlanStatus; billing_ref?: string; renews_at?: string },
  ): Org | undefined {
    const org = this.orgs.get(orgId);
    if (!org) return undefined;
    if (patch.plan) org.plan = patch.plan;
    if (patch.status) org.plan_status = patch.status;
    if (patch.billing_ref) org.billing_ref = patch.billing_ref;
    if (patch.renews_at) org.plan_renews_at = patch.renews_at;
    if (this.pg) void this.pg.upsertOrg(org).catch(() => {});
    return org;
  }

  /**
   * Seats in use: members plus outstanding invitations.
   *
   * Counting invites is the difference between a seat limit and a suggestion — otherwise you send
   * twenty invites on a three-seat plan and the enforcement happens to twenty confused people at
   * accept time instead of once, to you, at invite time.
   */
  seatsUsed(orgId: string): number {
    const members = [...this.members.values()].filter((m) => m.org_id === orgId).length;
    const pending = [...this.invites.values()].filter(
      (i) => i.org_id === orgId && !i.accepted_at && i.expires_at > Date.now(),
    ).length;
    return members + pending;
  }

  /** Which provider this email used last — for the sign-in screen, before anyone is authenticated. */
  lastProviderFor(email: string): AuthProvider | undefined {
    return this.findMemberByEmail(email)?.last_provider;
  }

  /**
   * The member as the API may return it.
   *
   * Allowlist, not denylist. This used to spread everything except salt/hash, so the reset-token
   * hash and its expiry — added later — would have been served from /v1/me to anyone with a session.
   * A subtractive filter silently leaks every field someone adds afterwards; naming the public ones
   * fails safe instead.
   */
  private publicMember(m: StoredMember): Member {
    return {
      id: m.id,
      org_id: m.org_id,
      email: m.email,
      role: m.role,
      created_at: m.created_at,
      last_provider: m.last_provider,
      providers: m.providers,
      // Public because the PRODUCT is what draws the banner and refuses the gated action, and it
      // has no other way to know. It is a timestamp, not a credential — `verify_hash` and
      // `verify_expires` are deliberately absent from this allowlist for the same reason
      // `reset_hash` is.
      email_verified_at: m.email_verified_at,
      // Safe to serve: it is the member's own UI state, written by the member, read back by the
      // member's own product. Nothing in here is a credential, and the ceilings above are what stop
      // it becoming a place to hide one.
      prefs: m.prefs,
      super_admin: isSuperAdminEmail(m.email) || undefined,
    };
  }
}

let cached: IdentityStore | null = null;
export function getIdentityStore(): IdentityStore {
  if (!cached) cached = new IdentityStore();
  return cached;
}

/** Boot-time: attach durable identity when MYCEL_DATABASE_URL is set (tenants survive restarts). */
export async function initIdentityStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  const store = getIdentityStore();
  if (!url) return { backend: "memory" };
  const { IdentityPg } = await import("./identity.pg");
  await store.attach(await IdentityPg.connect(url));
  return { backend: "postgres" };
}

export type { StoredInvite, StoredMember };
