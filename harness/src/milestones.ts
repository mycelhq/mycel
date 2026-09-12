// The moments worth marking, and the one thing to ask at each — later, and never twice.
//
// ═══ WHY A MODULE AND NOT A DRIP CAMPAIGN ═══
//
// A drip is a guess about a calendar: day 3, day 7, day 14. It fires at somebody mid-migration and
// at somebody who has not opened the product since Tuesday, and it says the same thing to both. The
// unsubscribe rate is the product telling you it was not listening.
//
// A milestone is a guess about a PERSON: the day their first client's money actually landed is the
// day they believe this works, and it is the only day they will happily answer a question. There is
// no calendar that can find it.
//
// ═══ NOT INSTANTLY, AND THIS IS THE WHOLE DESIGN ═══
//
// The obvious build is: webhook fires, email sends. It is wrong every time.
//
// At the moment the payment lands the founder is looking at the SCREEN, not at their inbox — an
// email that arrives in the same second is a notification about something they are already looking
// at. And a request for a favour, sent by a machine, one second after money moved, reads as a system
// that was waiting for it rather than a business that is pleased for them.
//
// So every ask has an `after`. The milestone is recorded the instant it happens (that is a fact, and
// facts are recorded when they occur); the ask is due later, and the delay is chosen per ask from
// what the moment is actually for.
//
// ═══ AND NEVER TWO AT ONCE ═══
//
// `QUIET_DAYS` is the floor between any two asks from this system, whatever they are. Without it,
// a founder who signs their first client, gets paid and ships their first deliverable in one good
// week receives three emails from us about it — which is the exact behaviour that teaches somebody
// to filter your domain, and it would land on the best week they have had.
import type { DomainStore } from "./domain";

/** Days between any two asks, no matter which. See the header. */
export const QUIET_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The closed vocabulary. A milestone is a thing that HAPPENED, not a thing we decided.
 *
 * Each is first-only for a business: `first_client_paid` fires on the first invoice ever settled and
 * never again, because the tenth is not the moment — the first is.
 */
export type MilestoneKind =
  /** An invoice this business raised was settled. Their money, from their client. */
  | "first_client_paid"
  /** A client signed off work we produced. The first time the loop closed on quality. */
  | "first_deliverable_accepted"
  /** An engagement was executed — both parties signed. The first time it closed on paper. */
  | "first_engagement_signed";

export interface Milestone {
  kind: MilestoneKind;
  /** ISO-8601, when it actually happened. */
  at: string;
  /** What it was about, so the ask can name it. An invoice number, a client's name. */
  subject?: string;
}

export type AskKind = "referral" | "satisfaction";

export interface AskSpec {
  kind: AskKind;
  /** Which milestone opens it. */
  after_milestone: MilestoneKind;
  /** How long after. See the header for why this is never zero. */
  after_days: number;
  /**
   * How long the moment stays warm.
   *
   * An ask has a window, not just a start. "How did your first month go?" asked eleven weeks later
   * is not a late version of the same question — it is a different, worse question from somebody who
   * has not been paying attention. Past the window, the ask is dropped rather than delivered late.
   */
  window_days: number;
}

/**
 * ═══ TWO ASKS, AND WHY THERE ARE NOT MORE ═══
 *
 * Every additional ask costs the same thing: the founder's willingness to answer the NEXT one. Two
 * is what the current product has earned.
 *
 * REFERRAL, three days after their first client's money lands. Three rather than zero because of the
 * header, and rather than thirty because the feeling fades — by then it is a fact about last month
 * instead of the best thing that happened this week.
 *
 * SATISFACTION, three weeks after the first deliverable a client signed off. Three weeks is when
 * they know whether the SECOND one was as good, which is the question that actually predicts whether
 * they stay. Asked on the day of the first, everybody says nine.
 */
export const ASKS: readonly AskSpec[] = [
  { kind: "referral", after_milestone: "first_client_paid", after_days: 3, window_days: 21 },
  { kind: "satisfaction", after_milestone: "first_deliverable_accepted", after_days: 21, window_days: 28 },
];

export interface AskState {
  kind: AskKind;
  /** When it was sent. Absent means never. */
  sent_at?: string;
}

export interface DueAsk {
  kind: AskKind;
  milestone: Milestone;
  /** When it became due, for the record. */
  due_at: string;
}

/**
 * What to ask this business right now — at most one, ever.
 *
 * Pure: every input is an argument and the answer is a decision, so the judgement in this file can
 * be tested without a store, a clock or a mailbox. The sweep that calls it does the sending.
 *
 * Returns `undefined` far more often than not, and that is the intended shape of the thing.
 */
export function dueAsk(args: {
  milestones: readonly Milestone[];
  sent: readonly AskState[];
  now?: Date;
}): DueAsk | undefined {
  const now = (args.now ?? new Date()).getTime();
  const sentAt = (k: AskKind) => args.sent.find((s) => s.kind === k)?.sent_at;

  // THE QUIET FLOOR, checked before anything else. A founder who had a very good week must not hear
  // from us three times about it.
  const lastSent = args.sent
    .map((s) => (s.sent_at ? Date.parse(s.sent_at) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (lastSent !== undefined && now - lastSent < QUIET_DAYS * DAY_MS) return undefined;

  for (const spec of ASKS) {
    // Once. An ask that has been sent is never sent again, whatever happens afterwards.
    if (sentAt(spec.kind)) continue;
    const m = args.milestones.find((x) => x.kind === spec.after_milestone);
    if (!m) continue;
    const happened = Date.parse(m.at);
    if (!Number.isFinite(happened)) continue;

    const due = happened + spec.after_days * DAY_MS;
    if (now < due) continue;
    // Past the window it is dropped, not delivered late. See `window_days`.
    if (now > happened + spec.window_days * DAY_MS) continue;

    return { kind: spec.kind, milestone: m, due_at: new Date(due).toISOString() };
  }
  return undefined;
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────────
//
// On the record store, in the kernel's own collection, keyed by kind. `upsertRecord` is idempotent
// on the key, which is what makes "first" first: the tenth settled invoice writes the same key and
// the read below keeps the earliest `at`.

const WEDGE = "kernel";
const COLLECTION = "milestones";
const ASKS_COLLECTION = "milestone_asks";

/**
 * Record a milestone, first-occurrence-wins.
 *
 * Reads before writing rather than relying on the upsert, because the upsert would overwrite the
 * ORIGINAL timestamp with the latest one — and the whole value of this row is the date the thing
 * first happened. A tenth payment must not move the referral ask back into its window.
 */
export async function reachMilestone(
  domain: DomainStore,
  args: { project_id: string; kind: MilestoneKind; at?: string; subject?: string },
): Promise<Milestone | undefined> {
  if (!args.project_id) return undefined;
  const at = args.at ?? new Date().toISOString();
  const existing = await listMilestones(domain, args.project_id).catch(() => [] as Milestone[]);
  const already = existing.find((m) => m.kind === args.kind);
  if (already) return already;

  const row: Milestone = { kind: args.kind, at, ...(args.subject ? { subject: args.subject } : {}) };
  await domain.upsertRecord({
    project_id: args.project_id,
    wedge: WEDGE,
    collection: COLLECTION,
    key: args.kind,
    data: { ...row },
    observed_at: at,
  });
  return row;
}

const rowsOf = async (domain: DomainStore, projectId: string, collection: string): Promise<Record<string, unknown>[]> => {
  const found = await domain.queryRecords({ project_id: projectId, wedge: WEDGE, collection });
  return (found ?? []).map((r) => (r as { data?: Record<string, unknown> }).data ?? {});
};

export async function listMilestones(domain: DomainStore, projectId: string): Promise<Milestone[]> {
  const rows = await rowsOf(domain, projectId, COLLECTION);
  return rows
    .filter((d): d is Milestone & Record<string, unknown> => typeof d.kind === "string" && typeof d.at === "string")
    .map((d) => ({ kind: d.kind as MilestoneKind, at: d.at as string, ...(d.subject ? { subject: String(d.subject) } : {}) }));
}

export async function listAsks(domain: DomainStore, projectId: string): Promise<AskState[]> {
  const rows = await rowsOf(domain, projectId, ASKS_COLLECTION);
  return rows
    .filter((d) => typeof d.kind === "string")
    .map((d) => ({ kind: d.kind as AskKind, ...(d.sent_at ? { sent_at: String(d.sent_at) } : {}) }));
}

/** Mark an ask as sent. Written BEFORE the send — see the note at the call site. */
export async function markAskSent(
  domain: DomainStore,
  args: { project_id: string; kind: AskKind; at?: string },
): Promise<void> {
  await domain.upsertRecord({
    project_id: args.project_id,
    wedge: WEDGE,
    collection: ASKS_COLLECTION,
    key: args.kind,
    data: { kind: args.kind, sent_at: args.at ?? new Date().toISOString() },
    observed_at: args.at ?? new Date().toISOString(),
  });
}

// ── the ask, as the founder meets it ────────────────────────────────────────────────────────────

export interface AskCopy {
  kind: AskKind;
  /** The line that opens it. Says what happened, not what we want. */
  headline: string;
  body: string;
  /** What pressing it does. */
  cta: string;
  href: string;
}

/**
 * THE ASK IS A TOOL, NOT A FAVOUR — and that is the whole difference in whether it works.
 *
 * "Do you know anyone who needs this?" converts on goodwill, which is a thing you spend rather than
 * earn. The version below hands them something to go and use: run the free report on a prospect's
 * domain and it comes back with THEIR name on it, ready to send.
 *
 * Every one of those is a warm lead for them and a real finding in front of somebody who has never
 * heard of us. That is the trade, and it is a better one for both sides than an email asking for a
 * name.
 */
export function askCopy(ask: DueAsk): AskCopy {
  if (ask.kind === "referral") {
    const named = ask.milestone.subject ? ` (${ask.milestone.subject})` : "";
    return {
      kind: "referral",
      headline: `Your first invoice got paid${named}.`,
      body:
        "Worth doing again. Put a prospect's domain in and you get a report on what AI assistants say " +
        "about them, with your name at the top — something to send that is about them rather than about you.",
      cta: "Run one on a prospect",
      href: "/gtm",
    };
  }
  return {
    kind: "satisfaction",
    headline: "Three weeks in. Is the work any good?",
    body:
      "Not the first one — the ones after it. If something has slipped, we would rather fix the way it " +
      "gets made than hear about it when you leave.",
    cta: "Tell us in a line",
    href: "/knowledge",
  };
}
