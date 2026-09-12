// Whether a message may be sent, which mailbox sends it, and what a bounce costs.
//
// ═══ WHY THIS PACKAGE EXISTS ═══
//
// Two sending systems live in this repo. `growth/` sends cold mail for us, selling Mycel, and it has
// a full deliverability stack that took real incidents to get right: a warm-up ramp that steps down
// on complaints, inbox rotation with per-domain ceilings, a suppression list with no override, and
// bounce feedback wired into all three.
//
// `kernel/` — the product an agency actually runs their business on — had none of it. It could send
// mail all day from a brand-new mailbox, mail an address that hard-bounced an hour earlier, and mail
// somebody who had marked the last message as spam. The targeting work in `@mycel/gtm-math` is worth
// nothing delivered into a spam folder, and the first agency to burn their own domain would rightly
// blame the platform that let them.
//
// The two apps stay independent (`growth/lib/db.ts` says so, deliberately), which leaves the same
// honest option the arithmetic took: a small pure package both depend on. `@mycel/linkedin`,
// `@mycel/insight` and `@mycel/gtm-math` set the pattern.
//
// ═══ WHAT BELONGS HERE ═══
//
// Pure functions over plain data. No I/O, no clock it was not handed, no randomness it was not
// handed, no database, no vendor SDK. A transport belongs in an app; the RULES a transport must obey
// belong here, because the failure mode of duplicating them is two systems disagreeing about whether
// a domain may send today — and the one that is wrong is the one that gets blocked.
export * from "./address";
export * from "./ramp";
export * from "./rotation";
export * from "./suppression";
export * from "./verdict";
