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

// Counters. In-process, consistent with the rest of the single-instance registries; a shared store
// is what this needs for multi-instance and lands with the Redis work.
const perTask = new Map<string, number>(); // `${taskId}|${rule.action}`
const perDay: { day: string; counts: Map<string, number> } = { day: "", counts: new Map() };

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function bumpDay(key: string, now: Date): number {
  const d = dayKey(now);
  if (perDay.day !== d) {
    perDay.day = d;
    perDay.counts.clear();
  }
  const n = (perDay.counts.get(key) ?? 0) + 1;
  perDay.counts.set(key, n);
  return n;
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
 */
export function evaluatePolicy(
  manifest: WedgeManifest | undefined,
  args: {
    action: string;
    payload?: Record<string, unknown>;
    taskId: string;
    projectId?: string;
    now?: Date;
    commit?: boolean;
  },
): PolicyDecision {
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
  const taskKey = `${args.taskId}|${rule.action}`;
  const dayK = `${args.projectId ?? "-"}|${rule.action}`;

  // Peek first so a refusal never consumes budget.
  if (rule.max_per_task !== undefined && (perTask.get(taskKey) ?? 0) >= rule.max_per_task) {
    return { auto: false, reason: `per-task limit of ${rule.max_per_task} reached`, rule };
  }
  if (rule.max_per_day !== undefined) {
    const d = dayKey(now);
    const used = perDay.day === d ? (perDay.counts.get(dayK) ?? 0) : 0;
    if (used >= rule.max_per_day) {
      return { auto: false, reason: `daily limit of ${rule.max_per_day} reached`, rule };
    }
  }

  if (args.commit !== false) {
    if (rule.max_per_task !== undefined) perTask.set(taskKey, (perTask.get(taskKey) ?? 0) + 1);
    if (rule.max_per_day !== undefined) bumpDay(dayK, now);
  }

  const bits = [`matched "${rule.action}"`];
  if (amount !== undefined) bits.push(`amount ${amount} within ${rule.max_amount_usd}`);
  if (rule.max_per_task !== undefined) bits.push(`${perTask.get(taskKey)}/${rule.max_per_task} this task`);
  if (rule.max_per_day !== undefined) bits.push(`${perDay.counts.get(dayK)}/${rule.max_per_day} today`);
  return { auto: true, reason: `auto-approved: ${bits.join(", ")}`, rule };
}

/** Test hook — resets the in-process counters. */
export function resetPolicyCounters(): void {
  perTask.clear();
  perDay.day = "";
  perDay.counts.clear();
}
