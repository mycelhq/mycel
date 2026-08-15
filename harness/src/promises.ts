// A run's CLAIM, checked against what the run actually did.
//
// ═══ THE FAILURE THIS EXISTS FOR — OBSERVED IN PRODUCTION ═══
//
// A `chase_invoice` run completed, reported success, and told the founder "the draft will be waiting
// for you in Approvals before anything leaves". Zero approvals were created. Nothing was sent. The
// $4,800 invoice stayed unpaid, and because `startChase` had already stamped `last_chased_at` to win
// the claim, `chaseMove` stopped proposing it — so the only affordance to try again disappeared too.
//
// Three things had to be true at once for that to happen, and only the third is general:
//
//   1. THE RUN WAS NEVER TOLD TO SEND. `wedges/invoice-chaser/skills/chase-politely.md` gated its
//      action-proxy call behind "Only when instructed to actually send/charge", and nothing in the
//      prompt, the input or the schema ever instructed. So the agent drafted, replied with the JSON
//      its schema demands, and stopped. Fixed in that file.
//   2. IT COULD NOT HAVE SENT ANYWAY. The project had zero connection rows, so
//      `capabilityConnections` resolved `send_email` to nothing and `runOpenCodeTask` never printed
//      its "Taking real-world actions" block — the agent was not even told the proxy existed.
//      `startChase` now refuses that case before it claims anything; see `cannot_send` in dunning.ts.
//   3. NOTHING IN THE KERNEL EVER CHECKED. `runTask` validated the output against the task's own
//      JSON schema — a check that the model produced the right SHAPE — and then set `succeeded`. A
//      draft with `{"step":"final_notice","channel":"email","message":"..."}` passes that schema
//      perfectly while having done nothing at all.
//
// (1) and (2) are this wedge's and this install's. (3) is the reason a founder could not tell, and
// it is the one that would have caught the other two on the first run. This module is (3).
//
// ═══ WHY THE EVENT LOG, AND NOT THE OUTPUT ═══
//
// The same argument `assertRemoteBuildSucceeded` makes one screen down in orchestrator.ts, and it is
// the argument: a run's summary is written by the model, so a summary saying "I have queued this for
// your approval" is a CLAIM, not evidence. `approval.requested` and `approval.resolved` are written
// by `awaitApproval` — kernel-side, in the API process, from a code path the sandbox cannot reach
// (it holds an action nonce that opens the proxy, not an event writer). An agent cannot manufacture
// them. So the question "did this run put a human in the loop?" has an answer that is a fact about
// the run's history rather than a sentence about its intentions.
//
// ═══ WHY THE PROMISE IS DECLARED AND NOT INFERRED ═══
//
// Every structural signal for "this run was supposed to send something" is a coincidence of the
// current wedge set. `capabilities: ["send_email"]` also describes a wedge that only reads a
// mailbox. An `output_schema` with a `channel` enum also describes a run that reports which channel
// a client PREFERS. Guessing here fails in the expensive direction: a wedge that legitimately only
// drafts would start failing every run.
//
// So a task type states it, once, in its own manifest — the same shape as `provides` and `internal`:
//
//   "promises": { "send": { "unless": { "step": ["hold"], "channel": ["none"] } } }
//
// Read as: a successful run of this type must have reached the human gate for an outward action,
// UNLESS its own validated output says `step: "hold"` or `channel: "none"` — the two ways this
// wedge's ladder legitimately decides to say nothing at all. A task type that declares nothing is
// byte-for-byte unchanged, which is every task type in the repo except `chase_invoice` today.
//
// ═══ WHAT IT DOES ON A BROKEN PROMISE ═══
//
// It throws, so the run ends `failed` with a sentence the founder can read. Deliberately not a
// warning event on a succeeded run: the whole class of bug this repo keeps shipping is something
// failing while reporting success, and "succeeded, with a note" is that bug with better telemetry.
// A chase that drafted but never asked anybody anything did not chase the invoice.
import type { Task, TaskEvent } from "./contract";

// ── The other half: a run that ends without keeping its promise must give the work back ──────────
//
// ═══ THE SECOND HALF OF THE PRODUCTION FAILURE ═══
//
// `startChase` wins the right to chase an invoice by stamping `last_chased_at` — a compare-and-set,
// and it has to happen BEFORE the run is spawned, or four worker replicas would race the same
// invoice into four dunning emails. In production that stamp landed 37ms before the task row
// existed and was never revisited. The run then produced nothing, and `chaseMove` — which asks the
// ladder, and the ladder reads `last_chased_at` — stopped proposing a $4,800 unpaid invoice for
// three days. The failure removed its own retry.
//
// A claim is a LOAN, not a record. Taken to serialise workers, it has to be returned when the work
// it was taken for did not happen.
//
// ═══ WHY A REGISTRY AND NOT AN `IF` IN THE ORCHESTRATOR ═══
//
// The alternative was `if (task.task_type === "chase_invoice")` in `runTask`, which is the
// `switch (wedge)` shape this codebase argues against everywhere else: the kernel would hold a list
// of the three task types it knows take claims, and the fourth — written by a founder, or authored
// by the shaper — would silently keep the bug. Whoever TAKES a claim registers how to give it back,
// next to the code that takes it, and the orchestrator stays general.

/** Give back whatever this run claimed. Returns a sentence when something was released. */
export type ClaimRelease = (task: Task) => Promise<string | undefined>;

const releases = new Map<string, ClaimRelease>();

/** Register the undo for one task type's claim. Called from the module that takes the claim. */
export function registerClaimRelease(taskType: string, fn: ClaimRelease): void {
  releases.set(taskType, fn);
}

/** Test seam — the registry is process-wide, like every other registry here. */
export function clearClaimReleases(): void {
  releases.clear();
}

/**
 * Release the claim a failed run was holding, if its task type takes one.
 *
 * NEVER THROWS. It runs inside the orchestrator's failure path, where something has already gone
 * wrong; a store blip here must not replace the real failure reason with a second one, because the
 * real one is what the founder needs to read. A release that could not happen is logged and the
 * invoice waits out one ladder interval — the behaviour before this existed.
 */
export async function releaseClaimFor(task: Task): Promise<string | undefined> {
  const fn = releases.get(task.task_type);
  if (!fn) return undefined;
  try {
    return await fn(task);
  } catch (e) {
    console.error(`[mycel] could not release the claim held by ${task.id} (${task.task_type}):`, e);
    return undefined;
  }
}

/** One promise: an outward action that must have passed the gate before this run may succeed. */
export interface SendPromise {
  /**
   * Output field values that EXCUSE the promise — the run legitimately decided to do nothing.
   *
   * A map of output field name to the set of values that mean "no send was owed". Matched
   * case-insensitively against the run's validated output, top level only: a nested escape hatch
   * would be a second place for a wedge author to accidentally excuse every run.
   */
  unless?: Record<string, string[]>;
}

export interface TaskPromises {
  send?: SendPromise;
}

/**
 * Read the `promises` block off a task type, dropping anything malformed.
 *
 * Fails toward NO PROMISE rather than toward a promise nobody can keep. A wedge author who
 * mistypes the block gets today's behaviour (a run that is not checked), not every run of their
 * wedge failing on a schema they cannot see. The check is the safety net; a safety net that
 * collapses the product when it is misconfigured is not one.
 */
export function readPromises(raw: unknown): TaskPromises | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const send = r.send;
  if (!send || typeof send !== "object" || Array.isArray(send)) return undefined;
  const unlessRaw = (send as Record<string, unknown>).unless;
  const unless: Record<string, string[]> = {};
  if (unlessRaw && typeof unlessRaw === "object" && !Array.isArray(unlessRaw)) {
    for (const [k, v] of Object.entries(unlessRaw as Record<string, unknown>)) {
      const vals = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      if (vals.length) unless[k] = vals;
    }
  }
  return { send: Object.keys(unless).length ? { unless } : {} };
}

/** JSON out of a run's final message, fenced or bare. `null` when it is prose. */
export function parseRunOutput(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  try {
    const v = JSON.parse((fenced?.[1] ?? text).trim());
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Did the run's own output excuse it from sending?
 *
 * Returns the sentence describing the excuse, or undefined when a send was owed.
 *
 * UNPARSEABLE OUTPUT IS NOT AN EXCUSE. A run whose final message is not the JSON its schema demands
 * has already failed `validateOutput` and never reaches here; if it somehow does, "we could not read
 * what it decided" must not resolve to "it decided to do nothing" — that is the swallow this module
 * exists to close.
 */
export function excusedFrom(promise: SendPromise, output: Record<string, unknown> | null): string | undefined {
  const unless = promise.unless ?? {};
  if (!output) return undefined;
  for (const [field, values] of Object.entries(unless)) {
    const actual = output[field];
    if (typeof actual !== "string") continue;
    const hit = values.find((v) => v.toLowerCase() === actual.toLowerCase());
    if (hit) return `it decided the right answer here was "${hit}"`;
  }
  return undefined;
}

/**
 * Did this run put an outward action in front of the gate?
 *
 * BOTH settlement paths count, and that distinction is the second half of the production bug. An
 * action a wedge envelope or a standing grant auto-approved never becomes a pending row a founder
 * can click — it lands in the batch-review queue as `auto_approved`. Counting only pending
 * approvals would fail exactly the runs that behaved correctly and autonomously, and would push
 * whoever debugged it next toward turning the envelope off.
 *
 * `approval.requested` is the human path; `approval.resolved` covers the auto-approved path, which
 * emits only the latter. Either one proves `awaitApproval` was reached.
 */
export function gateReached(events: Pick<TaskEvent, "type">[]): boolean {
  return events.some((e) => e.type === "approval.requested" || e.type === "approval.resolved");
}

/**
 * Was a human ASKED, or did a rule the founder had already written answer for them?
 *
 * The difference decides the sentence, and getting it wrong is a small version of the same bug.
 * "Waiting for your approval; nothing has been sent" is true on the human path and FALSE on the
 * auto-approved one, where the envelope said yes and the email left — so a single sentence for both
 * would tell a founder nothing had gone out at the exact moment something had.
 *
 * `approval.requested` is emitted only when the run suspends on a person. Its absence, with a
 * `resolved` present, is the auto-approved path.
 */
function humanWasAsked(events: Pick<TaskEvent, "type">[]): boolean {
  return events.some((e) => e.type === "approval.requested");
}

/**
 * "This run completes only if it actually asked."
 *
 * Throws with a founder-readable sentence when a task type that promised a send finished without
 * one. The wording names no machinery — a founder has no mental model of an action proxy, and
 * telling them about one is not an explanation. It names the two things they can act on: nothing
 * was sent, and nothing is waiting for them.
 */
export function assertSendPromiseKept(args: {
  promised: TaskPromises | undefined;
  output: string;
  events: Pick<TaskEvent, "type">[];
}): { kept: true; note: string } | { kept: false } {
  const promise = args.promised?.send;
  if (!promise) return { kept: false };

  const parsed = parseRunOutput(args.output);
  const excuse = excusedFrom(promise, parsed);
  if (excuse) return { kept: true, note: `nothing was owed to the client on this one — ${excuse}.` };

  if (gateReached(args.events)) {
    return {
      kept: true,
      note: humanWasAsked(args.events)
        ? "the message it wrote is waiting for your approval; nothing has been sent."
        : "the message it wrote went out under a rule you set in advance, and is on the record for review.",
    };
  }

  throw new Error(
    "this run wrote a message for your client and then never asked to send it, so there is nothing " +
      "waiting for you to approve and your client has heard nothing. Rather than report that as done, " +
      "it is recorded as failed — the work is still owed.",
  );
}
