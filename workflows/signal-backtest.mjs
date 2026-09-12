// Did this signal source predict your wins, or is it reading your pipeline back to you?
//
// ═══ THIS FILE IS AN ADAPTER, AND THAT IS THE POINT ═══
//
// The arithmetic lives in `@mycel/gtm-math` because BOTH sides of this repo need it. The kernel runs
// go-to-market for a customer's agency; `growth/` runs it for us, selling Mycel. They ask the same
// question — which source actually produced customers — and `growth/lib/db.ts` states the constraint
// plainly: "this app is deliberately independent of the kernel."
//
// That independence is worth keeping, and it leaves one honest option. Not growth importing the
// kernel, and not the same hundred lines living twice: a small package both depend on, which is the
// pattern `@mycel/linkedin` and `@mycel/insight` already set.
//
// The failure mode of duplicated arithmetic is not a bug. It is two dashboards disagreeing about the
// same quarter and nobody knowing which is right.
//
// Everything worth reading about WHY the verdict leads on lead time rather than precision is in
// `packages/gtm-math/src/backtest.ts`.

import { signalBacktest } from "@mycel/gtm-math/backtest";

export default function backtest(args) {
  return signalBacktest(args);
}
