// WHEN A RUN NEVER STARTED, AND WHY THAT IS A DIFFERENT KIND OF FAILURE.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE RULE `maxAttempts: 1` IS PROTECTING, AND THE CASE IT DOES NOT COVER
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `queue.ts` enqueues every task with `maxAttempts: 1`, and the reason is right: "a task that
// reached the human approval gate and failed afterwards may have already sent an email or moved
// money, and silently re-running it would do that twice."
//
// That argument is about a run that DID SOMETHING. It says nothing about a run that never got a
// sandbox — which has executed no turn, called no tool, taken no gated action and sent nothing. For
// that run the premise of the rule is simply absent, and refusing to retry it is not caution, it is
// a founder's job dying because a provider was briefly full.
//
// It has already happened here. Task f8944816 (2026-08-22) failed with, verbatim:
//
//     Total disk limit exceeded. Maximum allowed: 300GiB.
//
// Twenty-eight abandoned sandboxes from interrupted deploys had reached the organisation cap.
// `reapStoppedSandboxes` now prevents the cause, and the task that hit it still died permanently for
// a capacity blip on somebody else's side.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE TAXONOMY IS SUNA'S
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `session-lifecycle/types.ts` splits a hand-off's outcome by RETRY CLASS, and names the bug that
// forced it:
//
//     "`unreachable` exists because everything that produced `failed` on this path was in fact a
//      down runtime, and the drain treated it as terminal: a queued prompt delivered while the box
//      was unreachable went `dead_lettered` on its FIRST attempt and was never re-tried when the box
//      came back minutes later."
//
// Their `unreachable` is exactly this: "Nothing about the prompt is wrong; it must wait for the
// runtime to come back rather than be given up on. Bounded."
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT MAKES THIS SAFE, STATED AS A PROOF RATHER THAN A HOPE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The classifier below is only ever consulted for a failure raised by `createSandbox()`, which the
// orchestrator calls BETWEEN `setStatus("provisioning")` and `setStatus("running")` — before the
// agent's first prompt, before any action grant is minted, before a single tool call. So the
// retry-safety question is not "do we believe this was transient", it is "could anything have
// happened yet", and the answer is structurally no.
//
// That is why this file classifies the PROVIDER's answer and nothing else. A failure from anywhere
// later in the run stays terminal, exactly as before.

/**
 * Failures that name a mistake rather than a moment. Checked FIRST, because several of them contain
 * words the availability pattern would otherwise match — an "unauthorized" body that mentions a
 * quota, for instance — and a retry of any of these is the same failure at a slower cadence.
 */
const PERMANENT = /unauthor|forbidden|invalid api key|not found|no such image|does not exist|invalid/i;

/**
 * A provider that could not give us a sandbox RIGHT NOW, as distinct from one that will never give
 * us this sandbox.
 *
 * Capacity, rate limits, and the provider's own 5xx. Deliberately NOT: an unknown image (a real
 * configuration error a retry repeats forever), an auth failure (the key is wrong now and in five
 * minutes), or a quota that is structural rather than momentary.
 */
const UNAVAILABLE =
  /disk limit|quota exceeded|capacity|rate.?limit|too many requests|\b429\b|\b50[0234]\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|temporarily unavailable|try again/i;

/** Could the provider plausibly answer differently in a minute? */
export function provisioningUnavailable(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error ?? "");
  if (!text.trim()) return false;
  if (PERMANENT.test(text)) return false;
  return UNAVAILABLE.test(text);
}

/**
 * How many times a task may wait for the provider.
 *
 * Three, spread over roughly seven minutes. Long enough to outlast a deploy-induced capacity spike
 * or a provider hiccup; short enough that a founder watching a job is told it failed rather than
 * left watching a spinner. Past it the task fails with the provider's own words, which is what it
 * did before this existed.
 */
export const MAX_PROVISION_RETRIES = 3;

/** Backoff before each retry. Deliberately minutes, not seconds: capacity frees on a human scale. */
export const PROVISION_BACKOFF_MS = [45_000, 120_000, 240_000] as const;

export function provisionBackoffMs(attempt: number): number {
  return PROVISION_BACKOFF_MS[Math.min(attempt, PROVISION_BACKOFF_MS.length - 1)]!;
}

/**
 * Raised when provisioning failed and nothing has happened yet.
 *
 * A distinct type rather than a flag on the message, so the queue's handler cannot mistake a run
 * that failed LATER — and may have sent something — for one that never started.
 */
export class ProvisioningUnavailable extends Error {
  readonly attempt: number;
  constructor(message: string, attempt: number) {
    super(message);
    this.name = "ProvisioningUnavailable";
    this.attempt = attempt;
  }
}
