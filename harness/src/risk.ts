// What kind of decision is this, actually?
//
// ═══ THE BUG THIS FIXES ═══
//
// The action proxy called `awaitApproval` with `risk: "high"` — a string literal, for every action
// this product has ever taken. A first polite reminder on a $180 invoice and a $12,000 refund
// arrived in the founder's queue as the same red pill with the same words on it. So did a
// scope-change proposal carrying a fee, and a "thanks, Tuesday works" on a thread the client
// started.
//
// That is not a cosmetic problem. The product's whole claim is "nothing reaches a client without
// you", and that claim is only worth anything if the founder is actually reading the cards. A queue
// where every item is maximum severity teaches exactly one behaviour — approve, approve, approve —
// and the one card that genuinely needed thirty seconds of thought gets the same reflex as the
// forty before it. Undifferentiated urgency is indistinguishable from no urgency, and it is worse
// than no urgency because it looks like diligence.
//
// So risk is COMPUTED here, from what the action is and what is in it, and every verdict carries
// the sentence that explains it. The sentence is the actual product: "This moves money" and "A
// follow-up on a conversation already under way" are different decisions and now they look like it.
//
// ═══ WHAT THIS DOES NOT DO ═══
//
// It does not decide whether a human is needed. Every level here still stops at the gate. Lowering
// a risk score has never, on its own, sent anything: the only thing that skips a human is a wedge
// policy envelope (policy.ts) or a standing grant the founder wrote by hand (standing.ts). This
// module ranks the queue; it does not shorten it.
import type { Risk } from "./contract";
import { minorUnitExponent } from "./billing";
import type { WedgeManifest } from "./wedge";

/** A risk verdict, and the sentence a founder reads on the card. */
export interface RiskVerdict {
  risk: Risk;
  /**
   * Why, in one sentence, in the second person, with no jargon.
   *
   * Persisted onto the approval preview and rendered. It is written for the founder at 7am on a
   * phone, not for a log: "This moves money out of the business" beats
   * `rule=money_capability match=refund`.
   */
  why: string;
}

const ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** The more severe of two verdicts. Ties keep the first — callers pass the more specific one first. */
function worse(a: RiskVerdict, b: RiskVerdict): RiskVerdict {
  return ORDER[b.risk] > ORDER[a.risk] ? b : a;
}

/**
 * Money at or above this — in MAJOR units of the action's own currency — is always a high-risk
 * decision regardless of what it is called.
 *
 * Two thousand, matching the ceiling the autonomy docs use in their worked example ("chase overdue
 * invoices under $2,000 on your own"). It is a magnitude, not a converted amount: FX is not
 * modelled anywhere in this kernel and inventing a rate here would make a founder's risk score
 * depend on a number nobody in the business can see. Within a currency it is exact.
 */
export const HIGH_AMOUNT_MAJOR = 2000;

/**
 * Capability fragments that MOVE MONEY. Always high, at any amount, in any wedge.
 *
 * Substring match on the capability, deliberately generous: a brokered tool slug is vendor-shaped
 * (`STRIPE_CREATE_REFUND`, `XERO_CREATE_PAYMENT`) and the cost of matching one thing too many is a
 * founder reading a card they would have read anyway. The cost of missing one is a refund that went
 * out looking routine.
 */
const MONEY_MOVES = [
  "charge", "refund", "payout", "transfer", "capture", "debit", "chargeback",
  "payment", "subscription", "invoice_pay", "wire", "disburse",
];

/**
 * Capability fragments that COMMIT THE BUSINESS — a price, a scope, a signature, a date it now owes.
 *
 * This is the category the founder named: "a scope-change proposal carrying a fee". No money leaves
 * the bank when one goes out, which is exactly why an amount-only rule scores it as harmless, and
 * it is the single most expensive email a services business sends.
 */
const COMMITMENTS = [
  "contract", "proposal", "quote", "estimate", "sow", "scope", "agreement",
  "sign", "send_invoice", "create_invoice", "issue_invoice", "change_order",
];

/**
 * Capability fragments that PUBLISH or CHANGE PAID MEDIA under the business's name.
 *
 * Not money leaving the bank, but irreversible reputation: a live page, an ad that spends, a CRM
 * write that a sales team will treat as truth. Always high — the founder named these as the other
 * half of "send, charge, publish, change scope".
 */
const PUBLIC_IRREVERSIBLE = [
  "publish_content", "publish", "write_ads", "book_calendar", "write_crm",
];

/**
 * Capability fragments that DESTROY something in a system we do not own.
 *
 * Undoable by us: never. A `delete` through a brokered connection is somebody else's database.
 */
const DESTRUCTIVE = ["delete", "remove", "cancel", "terminate", "revoke", "close_account", "unsubscribe"];

/**
 * Capability fragments naming an ORDINARY outward message — a nudge, an update, a reply.
 *
 * The basis on which this module is willing to say "low", and the reason `low` is a recognition
 * rather than a default. `clientFacing` alone is not enough: the action proxy can tell us a send is
 * going to a person, but the plugin gate (`/v1/internal/gate`) has a tool NAME and nothing else,
 * and it must still be able to distinguish "chase the timesheet again" from a capability nobody has
 * ever classified. Recognising the first is safe. Assuming the second is not — see `assessRisk`.
 */
const ROUTINE_MESSAGE = [
  "send_reminder", "send_update", "send_status", "status_update", "follow_up", "followup",
  "nudge", "chase", "reply", "send_message", "send_email", "send_note", "check_in", "thank",
];

const hit = (haystack: string, needles: string[]): string | undefined =>
  needles.find((n) => haystack.includes(n));

/**
 * The money on this action, as MINOR units plus a currency, when the payload states it that way.
 *
 * Two shapes are accepted because two exist in this codebase: `amount_minor` (+ `currency`), which
 * is what everything invoice-shaped speaks, and a bare `amount`/`amount_usd`/`total`, which is what
 * an agent writes into a free-form payload. They are NOT interchangeable — 1500 minor units is
 * fifteen dollars and 1500 major units is fifteen hundred — and reading one as the other in either
 * direction produces a risk score that is wrong by a hundred times.
 *
 * So they are kept apart all the way to the comparison, and the comparison MULTIPLIES the threshold
 * up into minor units rather than dividing the amount down into major ones. Dividing is where the
 * rounding lives, and a threshold comparison that rounds is a threshold that is wrong at the edge.
 */
function amountAtOrAbove(payload: Record<string, unknown>, thresholdMajor: number): { over: boolean; label?: string } {
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  const currency = typeof payload.currency === "string" ? payload.currency : "USD";

  const minor = num(payload.amount_minor) ?? num(payload.total_minor) ?? num(payload.amount_due_minor);
  if (minor !== undefined) {
    const exp = minorUnitExponent(currency);
    const thresholdMinor = thresholdMajor * 10 ** exp;
    return { over: Math.abs(minor) >= thresholdMinor, label: `${currency} ${formatMinor(minor, exp)}` };
  }

  for (const k of ["amount_usd", "amount", "total", "value"]) {
    const v = num(payload[k]);
    if (v !== undefined) return { over: Math.abs(v) >= thresholdMajor, label: `${currency} ${v}` };
  }
  return { over: false };
}

/**
 * `250000` + exponent 2 → `"2500.00"`. For the founder's eyes only; nothing decides on it.
 *
 * Done by moving the decimal point through the DIGIT STRING rather than by dividing, because this
 * label sits next to a sentence telling somebody a number is large enough to worry about, and a
 * float division is exactly how such a label ends up reading `2499.9999999999995`. A zero-exponent
 * currency (JPY) has no point to move and gets the integer back unchanged.
 */
function formatMinor(minor: number, exp: number): string {
  const neg = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exp + 1, "0");
  const body = exp === 0 ? digits : `${digits.slice(0, digits.length - exp)}.${digits.slice(digits.length - exp)}`;
  return neg ? `-${body}` : body;
}

export interface RiskInput {
  /** `${connection.kind}:${capability}`, exactly as the approval records it. */
  action: string;
  capability: string;
  payload: Record<string, unknown>;
  /** The wedge's manifest, whose `approvals[]` can RAISE a verdict and never lower one. */
  manifest?: WedgeManifest;
  /**
   * True when this send reaches somebody who has not written to us on this thread.
   *
   * The single most useful signal on the whole card, and the proxy already computes it for the
   * reply-window guard. "Replying to a client who asked a question" and "opening a conversation
   * with a stranger" are not the same act, and until now the queue could not tell them apart.
   */
  firstContact?: boolean;
  /** The outreach guard demanded a human (ban-risk cold initiate). Nothing may lower this. */
  forcedHuman?: boolean;
  /** This action reaches a person outside the business. See `assessRisk` for why it never goes low. */
  clientFacing?: boolean;
}

/**
 * Declared risk from the wedge manifest — a FLOOR, never a ceiling.
 *
 * A wedge author writing `{ action: "charge", risk: "high" }` is stating something the heuristics
 * here cannot know, and it must win. A wedge author writing `low` is not: they cannot see the
 * payload, and letting a manifest talk a live refund down to "low" would put the queue's honesty in
 * a JSON file that ships with the product. Raise only.
 *
 * Matched by substring on the action for the same reason `buildGatePatterns` does: a manifest says
 * `send`, the live action is `email:send_reminder`.
 */
export function declaredRisk(manifest: WedgeManifest | undefined, action: string): Risk | undefined {
  const a = action.toLowerCase();
  let found: Risk | undefined;
  for (const d of manifest?.approvals ?? []) {
    if (!d?.action || !a.includes(d.action.toLowerCase())) continue;
    if (!found || ORDER[d.risk] > ORDER[found]) found = d.risk;
  }
  return found;
}

/**
 * Score one action.
 *
 * The ladder is ordered by severity and the FIRST match at the top wins, because the top rungs are
 * facts about the action ("this is a refund") and the lower ones are inferences about its context
 * ("nobody has replied on this thread yet"). A fact beats an inference.
 *
 * ═══ WHY THERE IS NO "UNKNOWN → LOW" ═══
 *
 * An action this module does not recognise scores MEDIUM, never low. Low is a claim — "you can skim
 * this one" — and the only honest basis for making it is recognising the action and finding nothing
 * in it. A capability added next month that nobody thought to classify must not quietly arrive in
 * the founder's queue wearing the badge that means "safe to wave through". Unknown is not safe; it
 * is unknown, and the queue should say so by making them look at it.
 */
export function assessRisk(input: RiskInput): RiskVerdict {
  const cap = input.capability.toLowerCase();
  const act = input.action.toLowerCase();
  const hay = `${act} ${cap}`;
  const payload = input.payload ?? {};

  let v: RiskVerdict;

  const money = hit(hay, MONEY_MOVES);
  const commitment = hit(hay, COMMITMENTS);
  const destructive = hit(hay, DESTRUCTIVE);
  const big = amountAtOrAbove(payload, HIGH_AMOUNT_MAJOR);

  if (input.forcedHuman) {
    v = {
      risk: "high",
      why: "First approach on an account that can be restricted — this one has to be sent by a person.",
    };
  } else if (money) {
    v = {
      risk: "high",
      why: big.label
        ? `This moves money — ${big.label}. Nothing here is reversible by us.`
        : "This moves money. Nothing here is reversible by us.",
    };
  } else if (commitment) {
    v = {
      risk: "high",
      why: big.label
        ? `This commits the business to a price — ${big.label}. Read the number before you send it.`
        : "This commits the business — a price, a scope or a signature the client can hold you to.",
    };
  } else if (hit(hay, PUBLIC_IRREVERSIBLE)) {
    v = {
      risk: "high",
      why: "This publishes, books, or writes into a system your clients or spend will see. Read it before it goes out.",
    };
  } else if (destructive) {
    v = { risk: "high", why: "This deletes or cancels something in a system we don't own. We can't undo it." };
  } else if (big.over) {
    v = { risk: "high", why: `This names ${big.label}. Anything at that size gets read properly.` };
  } else if (input.firstContact) {
    v = { risk: "medium", why: "First message to someone who hasn't written back yet — your reputation, not just your words." };
  } else if (big.label) {
    v = { risk: "medium", why: `A reply on a live conversation that quotes ${big.label}. Check the figure.` };
  } else if (input.clientFacing || hit(hay, ROUTINE_MESSAGE)) {
    // Recognised AND empty: an ordinary message, on a thread that already exists, with no money and
    // no commitment anywhere in it. Both halves are required — see `ROUTINE_MESSAGE`.
    v = { risk: "low", why: "A follow-up on a conversation already under way, with no money and no commitment in it." };
  } else {
    v = { risk: "medium", why: "Not an action this build recognises, so it comes to you. Unknown isn't the same as safe." };
  }

  // The manifest can only make it worse. See `declaredRisk`.
  const declared = declaredRisk(input.manifest, input.action);
  if (declared) {
    v = worse(v, {
      risk: declared,
      why: `The ${input.manifest?.wedge ?? "wedge"} playbook marks "${input.capability}" as ${declared} risk and always asks.`,
    });
  }

  return v;
}
