// Policy-bounded autonomy — the fix for approval fatigue.
//
// The kernel's default rule is: every outward action passes a human. That is exactly right for
// "send this email to a client" and exactly wrong for "make 40 budget tweaks today." A founder
// will not click 40 approvals per client per day — they will switch the gate off, and the whole
// trust primitive dies with it.
//
// So a wedge can declare an ENVELOPE: inside it, actions auto-approve and are queued for BATCH
// REVIEW; outside it, the human gate applies exactly as before. Autonomy is granted deliberately,
// per action, with ceilings — never assumed.
//
// Defaults are deliberately closed: no policy means everything is gated, i.e. today's behaviour.
import { getPolicyCounters, resetInMemoryPolicyCounters } from "./store";
import type { PolicyCounterStore } from "./store";
import type { WedgeManifest } from "./wedge";

export interface PolicyRule {
  /** Action to match, e.g. "email:send_email" or a prefix like "stripe:" (case-insensitive). */
  action: string;
  /** Ceiling on a money amount found in the payload (amount / amount_usd / total / value). */
  max_amount_usd?: number;
  /** Ceiling on auto-approvals for this rule within one task. */
  max_per_task?: number;
  /** Ceiling on auto-approvals for this rule within a rolling 24h, per project. */
  max_per_day?: number;
}

export interface WedgePolicy {
  auto_approve?: PolicyRule[];
}

export interface PolicyDecision {
  /** True when the action fits the envelope and may proceed without a human. */
  auto: boolean;
  /** Why — recorded on the approval + the timeline, so a batch review can be audited. */
  reason: string;
  rule?: PolicyRule;
}

// Counters live in a SHARED store (store.ts / store.pg.ts), not in this process.
//
// They used to be `Map`s, and the deployment runs two API replicas and two workers. Four processes
// each counting to the same ceiling means a `max_per_day: 40` envelope actually permitted about
// 160 auto-approved real-world actions a day — a security control failing OPEN, by four times,
// only in production, where nobody is counting emails by hand. `perTask` was never evicted either.
//
// Postgres when a database is configured, in-memory otherwise, exactly like every other store here.

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Sentinel for "no project". Never NULL — see `peek` in store.pg.ts for why that matters. */
function scopeOf(projectId?: string): string {
  return projectId ?? "-";
}

/**
 * When a per-day counter stops counting: the end of its own UTC day.
 *
 * The day is already in the key, so a new day is a new row rather than a reset of an old one; the
 * expiry exists so yesterday's rows can be reclaimed and so a clock skew between replicas cannot
 * resurrect one.
 */
function dayExpiry(now: Date): Date {
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return end;
}

/**
 * When a per-task counter stops counting.
 *
 * A task's budget only has to outlive the task. A day is far longer than any run (the runtime
 * ceiling is 30 minutes) and is what makes this evict instead of accumulating one row per task per
 * rule forever, which is what the old `Map` did.
 */
function taskExpiry(now: Date): Date {
  return new Date(now.getTime() + 86_400_000);
}

/** Pull a money amount out of an action payload, if there is one. */
export function payloadAmount(payload: Record<string, unknown>): number | undefined {
  for (const k of ["amount_usd", "amount", "total", "value"]) {
    const v = payload?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function matches(rule: PolicyRule, action: string): boolean {
  const a = action.toLowerCase();
  const r = rule.action.toLowerCase();
  if (r === "*") return true;
  return r.endsWith(":") || r.endsWith("*") ? a.startsWith(r.replace(/\*$/, "")) : a === r;
}

/**
 * Decide whether an action may skip the human gate.
 *
 * `commit: false` evaluates without consuming budget (used for previews/tests). The action proxy
 * calls it with `commit: true` exactly once per attempt.
 *
 * Async because the ceilings are shared state now. It is consulted once per action, not per model
 * call, and only for rules that actually declare a ceiling — a rule with neither `max_per_task` nor
 * `max_per_day` costs no round trips at all.
 */
export async function evaluatePolicy(
  manifest: WedgeManifest | undefined,
  args: {
    action: string;
    payload?: Record<string, unknown>;
    taskId: string;
    projectId?: string;
    now?: Date;
    commit?: boolean;
  },
): Promise<PolicyDecision> {
  const rules = (manifest?.policy as WedgePolicy | undefined)?.auto_approve ?? [];
  if (!rules.length) return { auto: false, reason: "no auto-approve policy — human gate applies" };

  const rule = rules.find((r) => matches(r, args.action));
  if (!rule) return { auto: false, reason: `no policy rule matches "${args.action}"` };

  const amount = payloadAmount(args.payload ?? {});
  if (rule.max_amount_usd !== undefined) {
    if (amount === undefined) {
      return { auto: false, reason: "policy caps an amount but none was found in the payload", rule };
    }
    if (amount > rule.max_amount_usd) {
      return { auto: false, reason: `amount ${amount} exceeds the ${rule.max_amount_usd} envelope`, rule };
    }
  }

  const now = args.now ?? new Date();
  const project = scopeOf(args.projectId);
  const taskKey = `${args.taskId}|${rule.action}`;
  // The day is IN the key, so midnight rolls a new row rather than mutating an old one — no
  // "current day" variable that two replicas could disagree about.
  const dayK = `${dayKey(now)}|${rule.action}`;
  const capped = rule.max_per_task !== undefined || rule.max_per_day !== undefined;

  let counters: PolicyCounterStore | undefined;
  if (capped) {
    try {
      counters = await getPolicyCounters();
    } catch (e) {
      return { auto: false, reason: `${UNAVAILABLE}: ${(e as Error)?.message ?? e}`, rule };
    }
  }

  let taskUsed = 0;
  let dayUsed = 0;
  if (counters) {
    try {
      // Peek first so a REFUSAL never consumes budget. This is advisory under concurrency — the
      // commit below is what actually enforces the ceiling.
      if (rule.max_per_task !== undefined) {
        taskUsed = await counters.peek(project, "task", taskKey);
        if (taskUsed >= rule.max_per_task) {
          return { auto: false, reason: `per-task limit of ${rule.max_per_task} reached`, rule };
        }
      }
      if (rule.max_per_day !== undefined) {
        dayUsed = await counters.peek(project, "day", dayK);
        if (dayUsed >= rule.max_per_day) {
          return { auto: false, reason: `daily limit of ${rule.max_per_day} reached`, rule };
        }
      }

      if (args.commit !== false) {
        // COMMIT, then re-check what the increment actually returned.
        //
        // The peek above is a read, and between it and this line another replica may have spent the
        // last of the budget. The increment is atomic and returns the caller's own position in the
        // sequence, so "did I get a slot" is answered by that number and nothing else: the callers
        // holding 1..limit proceed, everyone beyond is refused. Exactly `limit` auto-approvals, no
        // matter how many processes raced.
        if (rule.max_per_task !== undefined) {
          taskUsed = await counters.bump(project, "task", taskKey, taskExpiry(now));
          if (taskUsed > rule.max_per_task) {
            return { auto: false, reason: `per-task limit of ${rule.max_per_task} reached`, rule };
          }
        }
        // Only reached when the per-task slot was won, so a per-day refusal below can burn one
        // per-task slot that was never used. That direction is safe: it under-counts autonomy, and
        // the alternative is a two-phase reservation over two counters for a ceiling that exists to
        // be conservative in the first place.
        if (rule.max_per_day !== undefined) {
          dayUsed = await counters.bump(project, "day", dayK, dayExpiry(now));
          if (dayUsed > rule.max_per_day) {
            return { auto: false, reason: `daily limit of ${rule.max_per_day} reached`, rule };
          }
        }
      } else {
        // A peek reports the position this call WOULD have taken, so the reason string reads the
        // same whether or not it committed.
        taskUsed += 1;
        dayUsed += 1;
      }
    } catch (e) {
      // FAIL CLOSED.
      //
      // This gates auto-approval of real-world actions — sending client email, moving money. Fail
      // open and an unreachable database means every ceiling in the system evaporates at once and
      // the agent acts without limit, which is the exact failure this whole change exists to
      // prevent, arriving through a different door. Fail closed and the action goes to the human
      // gate, which is the kernel's documented default ("no policy means everything is gated") and
      // what every wedge behaves like before it declares an envelope. The cost is approval fatigue
      // during an outage; the cost the other way is unbounded autonomous spend. Not a close call.
      return { auto: false, reason: `${UNAVAILABLE}: ${(e as Error)?.message ?? e}`, rule };
    }
  }

  const bits = [`matched "${rule.action}"`];
  if (amount !== undefined) bits.push(`amount ${amount} within ${rule.max_amount_usd}`);
  if (rule.max_per_task !== undefined) bits.push(`${taskUsed}/${rule.max_per_task} this task`);
  if (rule.max_per_day !== undefined) bits.push(`${dayUsed}/${rule.max_per_day} today`);
  return { auto: true, reason: `auto-approved: ${bits.join(", ")}`, rule };
}

/** The one refusal reason that is an outage rather than a policy verdict. Kept greppable. */
const UNAVAILABLE = "policy counters unavailable — human gate applies";

/**
 * Test hook — resets the counters.
 *
 * Stays synchronous, and only touches the in-memory backend: callers do not await it, and a shared
 * Postgres is not something a test may truncate out from under a concurrent run. A live-database
 * test scopes itself with unique project/task ids instead.
 */
export function resetPolicyCounters(): void {
  resetInMemoryPolicyCounters();
}
