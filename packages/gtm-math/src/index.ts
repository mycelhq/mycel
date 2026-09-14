// Everything both sides of the repo need. See README for what belongs here.
export { signalBacktest } from "./backtest";
export type {
  BacktestAccount,
  BacktestArgs,
  BacktestResult,
  BacktestSource,
  BacktestVerdict,
} from "./backtest";

/**
 * THE COPY GATE, shared because both sides draft cold messages and only one of them checked them.
 *
 * `growth/` has refused drafts on these rules since August — in one week it rejected 263 against
 * 200 sent — while `kernel/`, which drafts the same kind of message for a paying customer, had no
 * gate at all. Everything the cold-email skill knows was advice the engine could not enforce.
 *
 * It qualifies under this package's own rule: pure functions over plain data, no I/O, no clock. And
 * it is exactly the case the README names — "if two apps would otherwise each write their own
 * version of the same measure, it belongs here", because the failure of duplicated judgement is two
 * products disagreeing about what a sendable message is.
 */
export { lint, BANNED_PHRASES, maskQuotes } from "./copy-gate";
export type { Violation, LintOptions } from "./copy-gate";
export { lintTells } from "./copy-tells";
export { lintFrame, subjectForms } from "./copy-frame";

/**
 * THE LAST MESSAGE, shared because both sides send cadences and only one of them ever ended.
 *
 * growth/ ships a breakup step; kernel/ documents one in its cold-email skill, cites the published
 * 10-15% response rate, says "if you send one, honor it" — and had no way to send it. Same split as
 * the copy gate: the knowledge was there and the mechanism was not.
 */
export { BREAKUP_BRIEF, isBreakupStep } from "./breakup";
