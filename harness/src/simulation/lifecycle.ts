// The whole life of an engagement, as stages that can be OBSERVED rather than asserted.
//
// ═══ WHY STAGES, AND WHY OBSERVED ═══
//
// "Does the product work end to end?" was answered all session by running one thing and looking. It
// found nineteen failures, every one of them a stage that had never been reached by anything, in a
// system where every individual piece had tests and passed them.
//
// The reason tests could not find them is that a test asserts a TRANSITION — given a deliverable in
// review, accepting it produces an invoice. That is true, and it was true throughout the period when
// no deliverable had ever been produced at all. A suite of true statements about transitions tells
// you nothing about whether the path is connected.
//
// So this models the path itself, as an ordered list of stages, and reports the FURTHEST ONE
// REACHED. That number is the product's actual state, and it is the only number that would have
// been honest at any point today: "eleven stages exist, we have ever reached four".
//
// ═══ WHY THE LATE STAGES ARE THE INTERESTING ONES ═══
//
// The stages before `delivered` are the ones every demo shows and every test covers. The ones after
// it are where a service business actually lives:
//
//   revision_requested → revised → revision_accepted
//
// A business that can deliver but cannot revise has no retainer, because the second month is
// entirely revisions. Those three stages had never been executed once when this file was written —
// not in production, not in the simulation, not in a test. `scripts/simulate.ts` drives a verdict,
// but its client is scripted, so `revised` is reached without anybody ever checking that the
// revision addressed anything.
//
// ═══ WHY `ever` AND `now` ARE DIFFERENT QUESTIONS ═══
//
// An engagement sitting at `awaiting_client` today may have passed through `delivered` last week.
// Reporting only the current stage would say the product cannot deliver; reporting the high-water
// mark says it can, and is currently waiting. The first is the more alarming number and the second
// is the true one, so both are kept and the report shows both.

/** Every stage an engagement passes through, in order. The index IS the depth. */
export const STAGES = [
  "prospect_found",       // the GTM machine found a business worth contacting
  "outreach_sent",        // and actually contacted them
  "replied",              // they answered — the first thing outside our control
  "client_created",       // they became a client record
  "case_opened",          // with a named piece of work
  "kicked_off",           // intake asks raised, money plan set
  "materials_received",   // THEY sent us what the work needs — the loop that was never wired
  "work_ran",             // a fulfilment run executed
  "delivered",            // and produced something a client can actually read
  "revision_requested",   // they came back with a specific objection
  "revised",              // we sent a new version
  "revision_accepted",    // and they accepted it — the retainer stage
  "invoiced",             // the accepted work became money owed
  "paid",                 // and money received
  "renewed",              // and they came back for the next cycle
] as const;

export type Stage = (typeof STAGES)[number];

export const depthOf = (s: Stage): number => STAGES.indexOf(s);

/** One thing that happened, with enough context to say which stage it proves. */
export interface Observation {
  stage: Stage;
  at: number;
  /** What was seen — a row, an event, a status. Quoted in the report so a claim can be checked. */
  evidence: string;
}

export interface Report {
  /** The furthest stage ever reached. The product's real state. */
  furthest?: Stage;
  /** Where it sits now, which may be earlier. */
  current?: Stage;
  /** Stages never reached at all, in order — the honest to-do list. */
  neverReached: Stage[];
  /**
   * The first gap: the earliest unreached stage that has a reached stage AFTER it.
   *
   * A stage that is simply "not there yet" is not a bug. A stage that was SKIPPED — reached 8 and 9
   * without ever reaching 7 — is either a broken observation or a path that bypassed a step it
   * should not have, and both are worth surfacing. This is how `materials_received` being dead was
   * visible while deliveries were happening.
   */
  skipped: Stage[];
  /** Every observation, newest first, for the founder who wants to check the claim. */
  timeline: Observation[];
}

export function report(observations: readonly Observation[]): Report {
  const seen = new Map<Stage, Observation>();
  for (const o of observations) {
    const prev = seen.get(o.stage);
    if (!prev || o.at < prev.at) seen.set(o.stage, o); // keep the FIRST time each stage happened
  }

  const reached = [...seen.keys()].sort((a, b) => depthOf(a) - depthOf(b));
  const furthest = reached[reached.length - 1];
  const neverReached = STAGES.filter((s) => !seen.has(s));

  const maxDepth = furthest ? depthOf(furthest) : -1;
  const skipped = neverReached.filter((s) => depthOf(s) < maxDepth);

  // `current` is where it stands: the latest stage by TIME, not by depth. An engagement that
  // delivered and then went back to awaiting materials is currently earlier than its high-water
  // mark, and saying so is the point of having two numbers.
  const byTime = [...observations].sort((a, b) => b.at - a.at);
  const current = byTime[0]?.stage;

  return { furthest, current, neverReached, skipped, timeline: byTime };
}

/**
 * The one line a founder reads.
 *
 * ═══ IT COUNTS STAGES REACHED, NOT DEPTH, AND THE FIRST VERSION DID NOT ═══
 *
 * `depthOf(furthest) + 1` was the obvious formula and it lies. Run against production the first
 * time, it printed "14/15 stages reached" for an engagement that had reached SEVEN — because one
 * invoice happened to be marked paid, and depth counts everything below the high-water mark as
 * though it had happened.
 *
 * That is the same flattering-metric failure as grading time-to-value against finishers instead of
 * signups, and it is worse here: this number exists specifically to be the honest answer to "does
 * the product work end to end", so a version of it that rounds seven up to fourteen defeats the
 * entire file. Counting what was actually observed makes skipped stages cost something.
 */
export function headline(r: Report): string {
  const reached = STAGES.length - r.neverReached.length;
  const bits = [`${reached}/${STAGES.length} stages reached`];
  if (r.furthest) bits.push(`furthest: ${r.furthest}`);
  if (r.current && r.current !== r.furthest) bits.push(`now sitting at: ${r.current}`);
  if (r.skipped.length) bits.push(`SKIPPED: ${r.skipped.join(", ")}`);
  const nextGap = r.neverReached[0];
  if (nextGap) bits.push(`next unreached: ${nextGap}`);
  return bits.join(" — ");
}

/**
 * Turn the rows and events a run produced into observations.
 *
 * Deliberately takes plain shapes rather than the store types: the observer must be able to read a
 * database dump, a test fixture or a live API response without any of them having to agree on a
 * class. Every rule here is "what would prove this stage happened", and the evidence string is
 * mandatory so a report can never claim a stage without saying why.
 */
export function observe(input: {
  prospects?: { created_at: string }[];
  outreach?: { sent_at?: string; status?: string }[];
  replies?: { at: string }[];
  clients?: { created_at: string }[];
  cases?: { created_at: string; data?: Record<string, unknown> }[];
  requests?: { created_at: string; status: string; resolved_at?: string; response_artifact_ids?: string[] }[];
  tasks?: { created_at: string; status: string; task_type: string }[];
  deliverables?: { created_at: string; status: string }[];
  versions?: { created_at: string; version: number }[];
  verdicts?: { at: string; decision: string; version?: number }[];
  invoices?: { created_at: string; status: string; paid_at?: string }[];
}): Observation[] {
  const out: Observation[] = [];
  const t = (s?: string) => (s ? Date.parse(s) : NaN);
  const add = (stage: Stage, at: number, evidence: string) => {
    if (Number.isFinite(at)) out.push({ stage, at, evidence });
  };

  for (const p of input.prospects ?? []) add("prospect_found", t(p.created_at), "a prospect row exists");
  for (const o of input.outreach ?? []) {
    if (o.sent_at) add("outreach_sent", t(o.sent_at), `outreach sent (${o.status ?? "sent"})`);
  }
  for (const r of input.replies ?? []) add("replied", t(r.at), "an inbound reply");
  for (const c of input.clients ?? []) add("client_created", t(c.created_at), "a client row exists");
  for (const k of input.cases ?? []) {
    add("case_opened", t(k.created_at), "a case row exists");
    // Kickoff stamps the case rather than creating a row, so it is read off the data blob.
    const at = k.data?.kickoff_at;
    if (typeof at === "string") add("kicked_off", t(at), "case.data.kickoff_at is stamped");
    const ra = k.data?.revision_accepted_at;
    if (typeof ra === "string") add("revision_accepted", t(ra), "case.data.revision_accepted_at is stamped");
  }
  for (const r of input.requests ?? []) {
    // THE LOOP THAT WAS NEVER WIRED. A resolved request WITH FILES is the only proof that a client
    // handed something over and the product could read it. `resolved` alone is not enough: a client
    // can answer a document ask with a sentence, and that does not exercise the mount path.
    if (r.status === "resolved" && (r.response_artifact_ids?.length ?? 0) > 0) {
      add("materials_received", t(r.resolved_at ?? r.created_at), `a resolved request carries ${r.response_artifact_ids!.length} file(s)`);
    }
  }
  for (const k of input.tasks ?? []) {
    if (k.status === "succeeded") add("work_ran", t(k.created_at), `${k.task_type} succeeded`);
  }
  for (const d of input.deliverables ?? []) add("delivered", t(d.created_at), `a deliverable exists (${d.status})`);
  for (const v of input.versions ?? []) {
    if (v.version >= 2) add("revised", t(v.created_at), `version ${v.version} exists`);
  }
  for (const v of input.verdicts ?? []) {
    const decision = String(v.decision ?? "").toLowerCase();
    if (decision === "changes" || decision === "changes_requested") {
      add("revision_requested", t(v.at), "a client asked for changes");
    }
    // An acceptance on version 2+ is the retainer stage: they objected, we fixed it, they signed off.
    // Live portal verdicts say `accepted`; the simulation used `accept`. Both count.
    if ((decision === "accept" || decision === "accepted") && (v.version ?? 1) >= 2) {
      add("revision_accepted", t(v.at), `version ${v.version} accepted after a revision`);
    }
  }
  for (const i of input.invoices ?? []) {
    add("invoiced", t(i.created_at), `invoice ${i.status}`);
    if (i.paid_at) add("paid", t(i.paid_at), "invoice paid");
  }

  return out;
}
