// A synthetic client who REMEMBERS — and therefore one who can be disappointed twice.
//
// ═══ WHY THE EXISTING SIMULATION IS NOT ENOUGH ═══
//
// `scripts/simulate.ts` drives both sides of an engagement through the public API and it is a good
// artifact: it catches tenancy leaks, it fails loudly, it runs in CI. But every client in it is
// SCRIPTED. It accepts when the script says accept and requests changes when the script says
// request changes, so the only thing it can prove is that the transitions exist.
//
// The transitions were never the risk. This session found nineteen failures and not one was a
// missing transition — they were all correct machinery that nothing invoked, or invoked into a
// closed door. A scripted client cannot find those, because it never forms an expectation that the
// product can disappoint.
//
// ═══ THE LOOP NOTHING TESTS ═══
//
// The engagement that actually earns a retainer is not "deliver, accept". It is:
//
//   v1 goes out → the client objects to ONE SPECIFIC THING → v2 comes back → the client reads v2
//   WHILE REMEMBERING v1 → and asks the only question that matters: *did they fix the thing I
//   said?*
//
// That last step is the entire product. A business that ships a polished v2 which ignores the one
// objection is worse than one that ships a rough v2 which addresses it — the first is not listening
// and the second is. No test in this repo has ever exercised it, because asserting it requires the
// client to carry state across the revision, and a scripted client has no state to carry.
//
// So this is a client with a memory, a standard, and a limited amount of patience. It can:
//
//   - accept work that meets its standard
//   - object, SPECIFICALLY, and remember what it objected to
//   - notice when a revision ignored the objection, and escalate rather than repeat itself
//   - go quiet, which is what real clients do instead of complaining
//   - churn, which is the only verdict that actually costs money
//
// ═══ WHY THE RULES ARE CODE AND THE JUDGEMENT IS NOT ═══
//
// Whether a deliverable "addresses the objection" is a judgement, and judgement belongs to a model.
// Everything around it — how memory accumulates, when patience runs out, what escalation means, what
// counts as the same complaint twice — is a rule, and a rule belongs in code where it can be tested
// without a model in the loop.
//
// Getting that split wrong in the other direction is how simulations become unfalsifiable: if the
// model decides both what it thinks AND whether that means churn, every run produces a plausible
// story and no run produces a signal.

/** What the client is reacting to. One version of one deliverable. */
export interface Received {
  /** Which revision this is, 1-indexed. */
  version: number;
  /** What the client can actually read — the client-facing summary, never the run's output. */
  body: string;
  /** How long they waited for it, in hours. Lateness is a complaint in its own right. */
  waitedHours: number;
  /** Files they were given. An empty set is its own kind of failure. */
  files: string[];
}

/** One thing the client said was wrong, kept so a later version can be judged against it. */
export interface Objection {
  /** The version that prompted it. */
  version: number;
  /** In the client's own words — this is what gets sent, and what gets checked later. */
  text: string;
  /** How many versions have gone by without this being addressed. */
  ignoredCount: number;
}

export type Verdict =
  | { kind: "accept"; why: string }
  | { kind: "request_changes"; objection: string; why: string }
  | { kind: "escalate"; objection: string; why: string }
  | { kind: "go_quiet"; why: string }
  | { kind: "churn"; why: string };

/** Everything the client carries between interactions. This is the part a scripted client lacks. */
export interface Memory {
  /** Every version they have seen, oldest first. */
  seen: Received[];
  /** Every objection they have raised, including ones already resolved. */
  objections: Objection[];
  /** Times they have been asked for something. Real clients get tired of homework. */
  asksReceived: number;
  /** Patience remaining, 0–100. Spent by lateness, ignored objections and being asked for things. */
  patience: number;
  /** Set once they have stopped engaging, so nothing "recovers" them by accident. */
  gone?: boolean;
}

export function freshMemory(patience = 100): Memory {
  return { seen: [], objections: [], asksReceived: 0, patience };
}

/** The one open objection a new version will be judged against, if there is one. */
export function openObjection(m: Memory): Objection | undefined {
  return m.objections.find((o) => o.ignoredCount >= 0 && !isResolved(m, o));
}

function isResolved(m: Memory, o: Objection): boolean {
  return (o as Objection & { resolved?: boolean }).resolved === true;
}

/**
 * What each disappointment costs.
 *
 * The weights are the opinion in this file, so they are named rather than inlined. The ordering is
 * what matters and it is not arbitrary:
 *
 *   IGNORED_OBJECTION is the most expensive thing on this list — more than being late, more than
 *   being asked for documents. A client who is a week late but was listened to renews. A client who
 *   got a fast, polished v2 that ignored the one thing they said does not, and they usually cannot
 *   articulate why. Being ignored is the churn cause that never appears in a support ticket.
 *
 *   LATE is real but survivable, and it scales: two days is a shrug, two weeks is a decision.
 *
 *   EACH_ASK is small and relentless. It is here because the product can generate asks
 *   automatically and a system with no cost attached to asking will ask for ever — which is exactly
 *   the failure the open-ask ceiling was added for, priced so a simulation can feel it.
 */
export const COST = {
  IGNORED_OBJECTION: 35,
  LATE_PER_DAY: 6,
  EACH_ASK: 8,
  EMPTY_DELIVERY: 25,
} as const;

/** Patience below this and the client stops giving feedback; below zero and they are gone. */
export const QUIET_THRESHOLD = 25;

/**
 * The judgement a model makes, handed in rather than computed here.
 *
 * Injected because "does this version address the objection?" is the one question in this file that
 * genuinely needs reading comprehension. Everything else is arithmetic on memory, and keeping the
 * arithmetic model-free is what makes the simulation falsifiable: the same memory always produces
 * the same verdict for the same judgement.
 */
export interface Judgement {
  /** Does this version address the open objection? Absent when there was no open objection. */
  addressesObjection?: boolean;
  /** Is the work itself up to standard, ignoring history? */
  meetsStandard: boolean;
  /** If not, the ONE thing wrong with it, in the client's words. */
  complaint?: string;
}

/**
 * Read a new version, in the light of everything that came before.
 *
 * The ORDER of these checks is the design. Being ignored is tested before quality, because a client
 * who was ignored does not care that the new version is prettier — and a simulation that checks
 * quality first would let a polished v2 paper over the exact failure this file exists to catch.
 */
export function receive(memory: Memory, got: Received, judged: Judgement): { memory: Memory; verdict: Verdict } {
  const m: Memory = {
    ...memory,
    seen: [...memory.seen, got],
    objections: memory.objections.map((o) => ({ ...o })),
  };

  if (m.gone) {
    return { memory: m, verdict: { kind: "churn", why: "this client already left; nothing sent now is read" } };
  }

  // Lateness, priced per day and rounded down — nobody notices six hours.
  const lateDays = Math.floor(got.waitedHours / 24);
  if (lateDays > 0) m.patience -= lateDays * COST.LATE_PER_DAY;

  // A delivery with no files and no body is not a delivery. Cheap to check, and it is what a
  // refusal wrapped as work looks like from the outside.
  if (!got.body.trim() && got.files.length === 0) {
    m.patience -= COST.EMPTY_DELIVERY;
  }

  const open = openObjection(m);

  // ── THE CHECK THIS FILE EXISTS FOR ────────────────────────────────────────────────────────
  if (open && judged.addressesObjection === false) {
    open.ignoredCount += 1;
    m.patience -= COST.IGNORED_OBJECTION;

    if (m.patience <= 0) {
      m.gone = true;
      return {
        memory: m,
        verdict: {
          kind: "churn",
          why: `asked twice for "${open.text}" and it was not done — this is the cause that never reaches a support ticket`,
        },
      };
    }
    // Escalation is a change of PERSON, not of tone — the same rule invoice-chaser teaches. A
    // client repeating themselves louder is a client about to leave; one asking for someone else is
    // still recoverable.
    return {
      memory: m,
      verdict: {
        kind: "escalate",
        objection: open.text,
        why: `v${got.version} did not address the objection raised on v${open.version}; repeating it is not the move`,
      },
    };
  }

  if (open && judged.addressesObjection === true) {
    (open as Objection & { resolved?: boolean }).resolved = true;
  }

  if (m.patience < QUIET_THRESHOLD) {
    // Real clients do not send a final email. They stop replying, and the business finds out at
    // renewal. A simulation that only models explicit rejection never sees this coming.
    return {
      memory: m,
      verdict: { kind: "go_quiet", why: `patience at ${m.patience}; still nominally a client, no longer engaged` },
    };
  }

  if (!judged.meetsStandard) {
    const text = judged.complaint?.trim() || "this is not what we agreed";
    // Saying the same thing twice in different words is still saying it twice. Matching on the
    // TEXT would let a reworded complaint reset the counter, which is precisely the paraphrase
    // problem that let one production case accumulate the same question three times.
    const already = m.objections.find((o) => !isResolved(m, o));
    if (already) {
      already.ignoredCount += 1;
      return {
        memory: m,
        verdict: { kind: "escalate", objection: already.text, why: "same problem, second time of asking" },
      };
    }
    m.objections.push({ version: got.version, text, ignoredCount: 0 });
    return { memory: m, verdict: { kind: "request_changes", objection: text, why: "one specific thing is wrong" } };
  }

  return {
    memory: m,
    verdict: {
      kind: "accept",
      why: open ? `the objection from v${open.version} was addressed` : "the work is what was agreed",
    },
  };
}

/**
 * The business asks the client for something. Not free.
 *
 * Modelled separately from `receive` because asks and deliveries arrive on different schedules and
 * the whole point of the open-ask ceiling is that they COMPETE for the same finite patience. A
 * simulation where only deliverables cost anything would rate a system that asks fifteen questions
 * identically to one that asks three.
 */
export function asked(memory: Memory, count = 1): { memory: Memory; answers: boolean } {
  const m: Memory = { ...memory, objections: memory.objections.map((o) => ({ ...o })) };
  if (m.gone) return { memory: m, answers: false };
  m.asksReceived += count;
  m.patience -= COST.EACH_ASK * count;
  // A client below the quiet line stops doing homework first. This is the failure that looks like
  // the product being blocked on the customer, when it is really the customer having given up.
  return { memory: m, answers: m.patience >= QUIET_THRESHOLD };
}

/** A one-line account of this relationship, for the report at the end of a run. */
export function summarise(m: Memory): string {
  const versions = m.seen.length;
  const unresolved = m.objections.filter((o) => !isResolved(m, o));
  const ignored = m.objections.reduce((n, o) => n + o.ignoredCount, 0);
  return [
    `${versions} version(s)`,
    `${m.objections.length} objection(s)`,
    unresolved.length ? `${unresolved.length} unresolved` : "all resolved",
    ignored ? `${ignored} ignored` : "none ignored",
    `${m.asksReceived} ask(s)`,
    `patience ${Math.max(0, m.patience)}`,
    m.gone ? "GONE" : m.patience < QUIET_THRESHOLD ? "quiet" : "engaged",
  ].join(", ");
}
