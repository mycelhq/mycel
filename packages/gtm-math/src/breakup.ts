// THE LAST MESSAGE, WHICH IS THE ONE MOST LIKELY TO BE ANSWERED.
//
// ═══ WE HAVE NEVER SENT ONE ═══
//
// Zero of the first 329 sends were a breakup. Every cadence in the database ends on an email that
// asks for something, and when that one is ignored the enrollment completes in silence. 155 people
// have gone through that ending and not one of them ever said no.
//
// Christina Gilbert's talk (YC, 12 September) is specific about why that is a loss rather than a
// neutral outcome: reply rates on the breakup are HIGHER than on anything before it, "because it
// makes it really low pressure for them to say no", and "a real no is actually very useful to you.
// In aggregate, the many nos improve who you target in the future."
//
// That second sentence is the one that matters here. This system has a targeting model, an intent
// scorer and a segment proposer, and all three are reasoning from 329 sends and zero outcomes. A no
// is the only cheap label any of them have ever been able to get. Silence is not data; it is the
// absence of data wearing the same clothes.
//
// ═══ WHAT MAKES IT A BREAKUP AND NOT A FOURTH NUDGE ═══
//
// Three properties, and a message missing any of them is just another follow-up:
//
//   1. IT ASKS FOR A NO. Every other message in the ladder asks for a yes and treats a no as
//      failure. This one names the no as the easy answer and means it.
//   2. IT ENDS SOMETHING. "I will stop writing" has to be TRUE — the enrollment really does
//      complete here — because a breakup followed by another email is a manipulation, and the
//      recipient who catches it has caught us lying about our own intentions.
//   3. IT OFFERS NOTHING NEW. No new argument, no new artifact, no discount, no "before I go, one
//      last idea". Adding an offer converts the low-pressure exit back into a pitch, which is
//      precisely the pressure that makes the breakup work when it is absent.
//
// ═══ AND WHAT IT MUST NOT DO ═══
//
// The failure mode is guilt. "I guess you're not interested", "sorry to have bothered you", "I'll
// take the hint" — all three make the reader responsible for a feeling, and the register of this
// whole system (lib/copy/shape.ts: "unbothered") is the opposite of that. The person did not owe us
// a reply. Nothing here should imply otherwise.

/**
 * What the drafter is told when the step is the last one.
 *
 * Written as instructions rather than as copy, for the reason lib/copy/product.ts learned the
 * expensive way: anything in a prompt that reads like a finished sentence eventually gets pasted
 * into a real message. There is no example sentence anywhere in this file.
 */
export const BREAKUP_BRIEF: readonly string[] = [
  "THIS IS THE LAST MESSAGE. Nothing follows it, and that is the whole point of it.",
  "",
  "Say, in your own words and without apology, that you have not heard back and are going to stop",
  "writing. Make the easy answer a NO: a single word back closes it, and that is genuinely fine.",
  "Asking for a no is the ask — do not slip a yes in beside it.",
  "",
  "OFFER NOTHING NEW. No fresh argument, no second piece of work, no discount, no last idea. The",
  "message is short because there is nothing left to add, and adding something turns an exit back",
  "into a pitch.",
  "",
  "NO GUILT. Not 'I guess this isn't a priority', not 'sorry to bother you', not 'I'll take the",
  "hint'. They never owed you a reply. Write it like someone who is fine either way, because the",
  "only thing being asked for here is one word that costs them nothing.",
  "",
  "WHERE THIS CONTRADICTS THE STEP INSTRUCTION ABOVE, THIS WINS. Most of those were written before",
  "any cadence had a last message, so several ask for a fresh argument or a yes. Keep the topic",
  "from it and drop the ask.",
];

/**
 * Is this step the end of the road?
 *
 * Reads the explicit flag first and falls back to position, because the two sources disagree in
 * exactly one direction that matters. A cadence proposed by the model (lib/campaigns/propose.model.ts)
 * carries `breakup: true` on the touch it intends as the last one. A cadence written before this
 * existed carries nothing — and for those, the final touch IS the breakup whether or not anybody
 * marked it, because it is the last thing the person will ever hear from us.
 *
 * `total` is the number of steps in the shaped definition, not the original: the shaper drops steps
 * a person cannot receive (lib/sequence/shape.ts), so the last step for somebody with no LinkedIn
 * is a different index from the last step for somebody with both channels. Asking the wrong one
 * would put a breakup in the middle of a live ladder, which is the one error here with a cost —
 * it promises to stop writing and then writes again.
 */
export function isBreakupStep(step: { breakup?: unknown }, index: number, total: number): boolean {
  if (typeof step.breakup === "boolean") return step.breakup;
  return total > 1 && index === total - 1;
}
