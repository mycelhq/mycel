// The composed answer — the tests.
//
// exposure.ts derives ONE number from TWO policies that have never been read together, and the ways
// that goes wrong are specific, so the tests are organised around them rather than around functions:
//
//   1. IT PICKS THE WRONG CEILING. The real limit is the MINIMUM of initiative and consequence, and
//      a view that showed either one alone, or their sum, would tell a founder a number that is not
//      true. It must also NAME which one binds, or the number is unactionable.
//   2. IT REASSURES WHEN IT SHOULD NOT. An unreadable policy rendering as a blank is "no limits
//      found" wearing the face of "no risk". Every unknown must survive to the surface as unknown.
//   3. IT LEAKS. A view of one business's permissions drawn under another's project.
//   4. IT GRANTS SOMETHING. This is a read. If it ever wrote — a policy row, a counter bump, a
//      schedule — autonomy would have a second, invisible author.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore, type DomainStore } from "../src/domain";
import {
  HARD_MAX_PER_DAY,
  HARD_MAX_PER_SWEEP,
  saveAutonomyPolicy,
  type AutonomyPolicy,
} from "../src/autonomy";
import {
  carriersFor,
  composeAction,
  composeExposure,
  composeKind,
  exposureView,
  readEnvelope,
  startsPerDay,
} from "../src/exposure";
import { moveAuthorityForProject } from "../src/moves";
import type { LoadedWedge, WedgeManifest } from "../src/wedge";

const NOW = new Date();
const project = () => `proj-exp-${randomUUID().slice(0, 8)}`;

/** A fake wedge loader, so the tests state the envelope they are composing against rather than
 *  depending on whatever `kernel/wedges/*.json` happens to say this month. The REAL manifests are
 *  exercised separately at the bottom, which is the test that catches somebody widening one. */
const loader =
  (policies: Record<string, WedgeManifest["policy"] | "corrupt">) =>
  (slug: string): LoadedWedge | null => {
    const p = policies[slug];
    // `null` is `loadWedge`'s answer for BOTH "not installed" and "unparseable", and `readEnvelope`
    // then asks the filesystem to tell them apart. A test that wants the corrupt branch has to say
    // so; a slug the test simply did not mention is a wedge that installs cleanly with no envelope.
    if (p === "corrupt") return null;
    return { manifest: { wedge: slug, policy: p }, dir: `/fake/${slug}`, skills: [], knowledge: [] };
  };

const policy = (over: Partial<AutonomyPolicy> = {}): AutonomyPolicy => ({
  v: 1,
  paused: false,
  allow: [],
  max_starts_per_sweep: HARD_MAX_PER_SWEEP,
  max_starts_per_day: HARD_MAX_PER_DAY,
  utc_offset_minutes: 0,
  ...over,
});

// ═══ 1. THE BINDING CEILING ═══════════════════════════════════════════════════════════════════════

// BUG: showing the connector envelope's 50-a-day as "what can happen without you", when the founder
// only allowed three chases to start. The composed number is the MINIMUM of the two policies, never
// either one alone and never their sum.
test("the binding ceiling is the minimum of the two policies, not either one alone", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ allow: [{ kind: "chase_invoice", max_per_day: 3 }] }),
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3, max_per_day: 50 }] } }),
  });
  const chase = view.kinds.find((k) => k.kind === "chase_invoice")!;

  assert.equal(chase.starts.value, 3, "three starts a day, as granted");
  const send = chase.actions.find((a) => a.action === "email:send_reminder")!;
  // 3 starts × 3 per run = 9. NOT 50 (the envelope alone), NOT 3 (the grant alone), NOT 53 (a sum).
  assert.equal(send.ceiling.value, 9);
  assert.equal(send.ceiling.binder, "envelope_per_run");
});

// BUG: "at most 9 a day" with no attribution. A founder cannot act on that — they do not know
// whether to lower their grant or tighten the envelope. The sentence must name the rule that binds.
test("the ceiling names WHICH rule binds, and the sentence says both numbers", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ allow: [{ kind: "chase_invoice", max_per_day: 3 }] }),
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3, max_per_day: 50 }] } }),
  });
  const s = view.kinds.find((k) => k.kind === "chase_invoice")!.sentence;
  assert.match(s, /up to 3 runs a day/);
  assert.match(s, /you allowed at most 3 of these a day/);
  assert.match(s, /up to 9 "email:send_reminder" a day/);
  // The forgotten half, named with its own number, so the founder knows which dial is loose.
  assert.match(s, /50 a day/);
});

// BUG: the other direction. When the envelope's own day cap is the tighter one, naming the founder's
// grant would send them to tighten a dial that is already tighter than the thing stopping them.
test("when the envelope's day cap is tighter, IT is named — not the grant", () => {
  const starts = startsPerDay(policy({ max_starts_per_day: 20 }), { kind: "chase_invoice" });
  assert.equal(starts.value, 20);
  const a = composeAction({ action: "email:send", max_per_task: 5, max_per_day: 12 }, "invoice-chaser", starts);
  assert.equal(a.ceiling.value, 12, "20 × 5 = 100 is available; the envelope's 12 is what binds");
  assert.equal(a.ceiling.binder, "envelope_per_day");
  assert.match(a.ceiling.because, /12 "email:send" a day across this whole business/);
});

// BUG: the brief's own example. A business with autonomy but no envelope must read LOWER than one
// with both — because without an envelope nothing at all reaches a customer unattended.
test("autonomy without a connector envelope is a lower ceiling than autonomy with one", () => {
  const grant = policy({ allow: [{ kind: "chase_invoice", max_per_day: 3 }] });
  const withEnvelope = composeExposure({
    project_id: project(),
    policy: grant,
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3, max_per_day: 50 }] } }),
  });
  const without = composeExposure({
    project_id: project(),
    policy: grant,
    projectWedges: [],
    load: loader({ "invoice-chaser": undefined }),
  });

  assert.equal(withEnvelope.worst_case.actions.value, 9);
  assert.equal(without.worst_case.actions.value, 0);
  assert.ok((without.worst_case.actions.value ?? 0) < (withEnvelope.worst_case.actions.value ?? 0));
  // Same number of STARTS. Only the consequence half differs, and the copy has to say so — "it can
  // still start three runs a day" is a true and load-bearing part of "and send nothing".
  assert.equal(without.kinds.find((k) => k.kind === "chase_invoice")!.starts.value, 3);
});

// BUG: a rule with neither ceiling silently reported as a small number. `evaluatePolicy` consults no
// counter for such a rule, so it auto-approves every matching action for ever. "Unbounded" is the
// only honest word and it must not be rendered as a figure.
test("an envelope rule with no ceiling at all reads as unbounded, never as a number", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ allow: [{ kind: "chase_invoice" }] }),
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send" }] } }),
  });
  const a = view.kinds.find((k) => k.kind === "chase_invoice")!.actions[0]!;
  assert.equal(a.ceiling.unbounded, true);
  assert.equal(a.ceiling.value, undefined);
  assert.equal(view.worst_case.actions.unbounded, true);
  assert.match(view.worst_case.sentence, /no bound anybody set|without limit/);
});

// BUG: the per-sweep cap treated as a per-day cap, or ignored entirely. An hours window genuinely
// removes ticks from the day, and a worst case that ignored it would exaggerate — which is how a
// founder learns to stop believing this screen.
test("an hours window lowers the ceiling by removing sweeps, and says so", () => {
  const wide = startsPerDay(policy({ max_starts_per_sweep: 1 }), { kind: "chase_invoice" });
  assert.equal(wide.value, 20, "96 sweeps × 1 is above the kernel's hard 20, so the hard cap binds");

  // One hour of window at 15-minute sweeps = 4 ticks × 1 start = 4, below every other ceiling.
  const narrow = startsPerDay(policy({ max_starts_per_sweep: 1 }), {
    kind: "chase_invoice",
    hours: { from: 9, to: 10 },
  });
  assert.equal(narrow.value, 4);
  assert.equal(narrow.binder, "sweep_rate");
  assert.match(narrow.because, /9:00–10:00/);
});

// BUG: the kernel's own hard cap invisible. A founder who wrote `max_per_day: 999` had it clamped to
// 20 by `sanitisePolicy`; if the composed view showed 999 it would be describing a policy that does
// not exist.
test("the kernel's hard caps bind when nothing tighter does, and are named", () => {
  // `sanitisePolicy` always writes a `max_starts_per_day`, defaulting it to the hard cap — so on a
  // real policy the founder's own project-wide dial is what a founder should be pointed at, and it
  // is named ahead of the kernel's, which they cannot turn. Same number, actionable attribution.
  const written = startsPerDay(policy(), { kind: "chase_invoice" });
  assert.equal(written.value, HARD_MAX_PER_DAY);
  assert.equal(written.binder, "project_day");

  // A document with the field absent (an older row, or a hand-written one) still cannot exceed the
  // ceiling nobody can raise, and then THAT is the honest name for it.
  const bare = startsPerDay({ v: 1, allow: [] }, { kind: "chase_invoice" });
  assert.equal(bare.value, HARD_MAX_PER_DAY);
  assert.equal(bare.binder, "kernel_day");
});

// ═══ 2. IT MUST NOT REASSURE ══════════════════════════════════════════════════════════════════════

// BUG, and the one this module exists for: the record store throws, the view renders "nothing runs
// on its own", and the founder goes away reassured by a screen that knows nothing. "No limits found"
// must never look like "no risk".
test("an unreadable autonomy policy renders as UNKNOWN, never as zero", () => {
  const view = composeExposure({
    project_id: project(),
    policyUnreadable: "the record store timed out",
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_day: 50 }] } }),
  });
  assert.equal(view.readable, false);
  assert.equal(view.worst_case.actions.unknown, true);
  assert.equal(view.worst_case.actions.value, undefined, "unknown is NOT zero");
  assert.equal(view.worst_case.starts.unknown, true);
  assert.match(view.worst_case.sentence, /cannot tell you the worst case/);
  assert.match(view.worst_case.sentence, /not the same as nothing/);
  assert.ok(view.unknowns.some((u) => /timed out/.test(u)), "the reason survives to the surface");
  for (const k of view.kinds) {
    assert.equal(k.starts.unknown, true, `${k.kind} must be unknown, not zero`);
    assert.match(k.sentence, /unknown, not as nothing/);
  }
});

// BUG: a corrupt `wedge.json` is `loadWedge(...) === null`, which is the SAME value as "no such
// wedge" — so a business whose envelope became unparseable would be told "nothing can be sent". A
// corrupt manifest is the case where an envelope is most likely to be something other than empty.
test("an unparseable wedge manifest renders as unknown, not as 'no envelope'", (t) => {
  // `readEnvelope` distinguishes the two by asking the filesystem, so the corrupt case is proved
  // against a slug that really is on disk with a real manifest beside it.
  const real = readEnvelope("invoice-chaser");
  assert.equal(real.status, "envelope", "baseline: this wedge is on disk and parses");

  const corrupt = readEnvelope("invoice-chaser", () => null);
  assert.equal(corrupt.status, "unreadable");

  const absent = readEnvelope(`no-such-wedge-${randomUUID().slice(0, 6)}`, () => null);
  assert.equal(absent.status, "missing", "a wedge that is not installed is not a corruption");
  t.diagnostic(`corrupt: ${JSON.stringify(corrupt)}`);
});

// BUG: an unreadable envelope swallowed into a confident total. One wedge we cannot parse makes the
// whole worst case unknown, because a total that quietly omits a term is worse than no total.
test("one unreadable envelope makes the whole worst case unknown", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ allow: [{ kind: "chase_invoice", max_per_day: 2 }] }),
    projectWedges: [],
    // `loader` returns null for "corrupt"; `readEnvelope` then asks the filesystem, and
    // `invoice-chaser` really is on disk — so this is the corrupt branch, not the missing one.
    load: loader({ "invoice-chaser": "corrupt" }),
  });
  assert.equal(view.readable, false);
  assert.equal(view.worst_case.actions.unknown, true);
  assert.ok(view.unknowns.some((u) => /invoice-chaser/.test(u)));
  assert.match(view.kinds.find((k) => k.kind === "chase_invoice")!.sentence, /unknown, not as none/);
});

// BUG: pausing read as revoking, or as no change. Paused is a real third state — zero today, and the
// grant comes back intact — and the surface has to be able to say that.
test("paused reads as zero today while the grant is still shown as granted", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ paused: true, allow: [{ kind: "chase_invoice", max_per_day: 3 }] }),
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3 }] } }),
  });
  assert.equal(view.paused, true);
  const chase = view.kinds.find((k) => k.kind === "chase_invoice")!;
  assert.equal(chase.granted, true, "the rule is kept — pausing must be reversible");
  assert.equal(chase.starts.value, 0);
  assert.equal(view.worst_case.actions.value, 0);
  assert.match(chase.sentence, /paused/);
});

// BUG: "nothing granted" rendered with the same words as "we do not know". The default state is the
// safe one and it should read as calm, not as an alarm.
test("a business that granted nothing reads as a confident nothing", () => {
  const view = composeExposure({ project_id: project(), projectWedges: [], load: loader({}) });
  assert.equal(view.readable, true);
  assert.equal(view.worst_case.actions.value, 0);
  assert.equal(view.worst_case.actions.unknown, false);
  assert.match(view.worst_case.sentence, /Nothing can happen without you/);
});

// ═══ 3. WORST CASE, HONESTLY ══════════════════════════════════════════════════════════════════════

// BUG: a number with no account of what is in it. The dunning ladder and connection pacing further
// constrain reality; a worst case that assumed them away would be negligent, and one that claimed to
// include them would be lying. The view must state both lists.
test("the worst case declares what it included and what it could not", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ allow: [{ kind: "chase_invoice", max_per_day: 3 }] }),
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3, max_per_day: 50 }] } }),
  });
  assert.ok(view.worst_case.included.length >= 3);
  assert.ok(view.worst_case.excluded.some((e) => /dunning ladder/.test(e)), "the ladder is named");
  assert.ok(view.worst_case.excluded.some((e) => /pacing/.test(e)), "connection pacing is named");
  assert.ok(
    view.worst_case.excluded.some((e) => /scheduled sweeps/.test(e)),
    "the sweeps start work without asking autonomy, and share the same envelope — said out loud",
  );
});

// BUG: totalling across kinds by taking a maximum, or by double-counting a shared envelope day cap.
test("the worst case sums across kinds and reads as customer-visible actions", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({
      allow: [
        { kind: "chase_invoice", max_per_day: 2 },
        { kind: "check_in_case", max_per_day: 4 },
      ],
    }),
    projectWedges: ["books-keeper"],
    load: loader({
      "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3, max_per_day: 50 }] },
      "books-keeper": { auto_approve: [{ action: "email:send_receipt_chase", max_per_task: 1, max_per_day: 20 }] },
    }),
  });
  // chase: 2 × 3 = 6. check_in via books-keeper: 4 × 1 = 4. Starts: 2 + 4 = 6.
  assert.equal(view.worst_case.actions.value, 10);
  assert.equal(view.worst_case.starts.value, 6);
  assert.match(view.worst_case.sentence, /reach your customers 10 times/);
});

// BUG: for the three kinds whose carrier is the ENGAGEMENT's wedge, picking the first wedge in
// whatever order a Set iterated — the exact bug `nudgeWedgeFor` was written to fix. A worst case
// must take the WIDEST envelope among the wedges the project actually runs.
test("a case-carried kind composes against the widest envelope the project runs", () => {
  const k = composeKind({
    kind: "advance_case",
    policy: policy({ allow: [{ kind: "advance_case", max_per_day: 5 }] }),
    projectWedges: ["harness-operator", "books-keeper"],
    load: loader({
      "harness-operator": undefined,
      "books-keeper": { auto_approve: [{ action: "email:send_receipt_chase", max_per_task: 2, max_per_day: 20 }] },
    }),
  });
  assert.deepEqual(k.carriers, ["books-keeper", "harness-operator"]);
  assert.equal(k.actions[0]!.ceiling.value, 10, "5 starts × 2 per run, from the wedge that has one");
});

test("chase_invoice and gtm_next_touch have fixed carriers, whatever the project runs", () => {
  assert.deepEqual(carriersFor("chase_invoice", ["books-keeper"]), ["invoice-chaser"]);
  assert.deepEqual(carriersFor("gtm_next_touch", ["books-keeper"]), ["gtm-operator"]);
});

// BUG, and the reason this whole module was asked for: a founder presses "Let it run" having read a
// tooltip that says anything it sends "still waits for you in Approvals", and is wrong — because the
// invoice-chaser envelope they approved weeks ago auto-sends three reminders per run. The number has
// to be on screen BEFORE the press, not in the receipt afterwards.
test("an ungranted kind previews exactly what pressing 'Let it run' would authorise", () => {
  const view = composeExposure({
    project_id: project(),
    policy: policy({ allow: [] }),
    projectWedges: [],
    load: loader({ "invoice-chaser": { auto_approve: [{ action: "email:send_reminder", max_per_task: 3, max_per_day: 50 }] } }),
  });
  const chase = view.kinds.find((k) => k.kind === "chase_invoice")!;
  assert.equal(chase.granted, false);
  assert.equal(chase.starts.value, 0, "not granted means nothing today");

  const preview = chase.if_granted!;
  // The button sends `{ kind }` with no ceiling, so the preview is against the project's own 20/day.
  assert.equal(preview.starts.value, HARD_MAX_PER_DAY);
  assert.equal(preview.actions[0]!.ceiling.value, 50, "20 × 3 = 60 is over the envelope's own 50 a day");
  assert.match(preview.sentence, /50 "email:send_reminder" a day/);
  assert.match(preview.sentence, /without asking you/);
});

// BUG: a preview promising sends where there is no envelope, or inventing one during an outage.
test("the preview is honest about no envelope, and is absent when the policy is unreadable", () => {
  const clean = composeExposure({ project_id: project(), policy: policy(), projectWedges: [], load: loader({}) });
  const chase = clean.kinds.find((k) => k.kind === "chase_invoice")!;
  assert.match(chase.if_granted!.sentence, /every send stops at Approvals/);
  assert.equal(chase.if_granted!.actions.length, 0);

  const blind = composeExposure({ project_id: project(), policyUnreadable: "store down", projectWedges: [], load: loader({}) });
  for (const k of blind.kinds) {
    assert.equal(k.if_granted, undefined, "no invented number while a policy cannot be read");
  }
});

// ═══ 4. IT IS A READ ══════════════════════════════════════════════════════════════════════════════

// BUG: the view widening what it describes. Every number here is derived from policies written
// elsewhere; if this call could write a policy row, bump a counter or create a schedule, autonomy
// would have a second author that no audit trail names.
test("the composed view makes no writes at all", async () => {
  const p = project();
  const domain = getDomainStore();
  await saveAutonomyPolicy(domain, p, { v: 1, allow: [{ kind: "chase_invoice", max_per_day: 3 }] } as AutonomyPolicy, "m", NOW);

  const writes: string[] = [];
  const trap = new Proxy(domain, {
    get(target, prop: string) {
      const v = Reflect.get(target, prop) as unknown;
      if (typeof v !== "function") return v;
      // Everything that could persist, including the schedule the grant route ensures.
      if (/^(upsert|create|update|delete|set|record|save|claim|append|insert|remove)/i.test(prop)) {
        return (...args: unknown[]) => {
          writes.push(prop);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  }) as DomainStore;

  const auth = await moveAuthorityForProject(trap, p);
  const view = await exposureView(trap, auth);

  assert.equal(view.project_id, p);
  assert.deepEqual(writes, [], `the exposure view wrote: ${writes.join(", ")}`);
  assert.equal(view.kinds.find((k) => k.kind === "chase_invoice")!.starts.value, 3);
});

// BUG: the shape of both cross-tenant leaks this codebase has shipped. One founder's grants
// appearing in another founder's exposure would be a permission they never wrote, described as
// theirs, on the screen where they decide whether to go on holiday.
test("one business's permissions never appear in another's exposure", async () => {
  const a = project();
  const b = project();
  const domain = getDomainStore();
  await saveAutonomyPolicy(domain, a, { v: 1, allow: [{ kind: "chase_invoice", max_per_day: 3 }] } as AutonomyPolicy, "m", NOW);
  // b grants nothing at all.

  const viewB = await exposureView(domain, await moveAuthorityForProject(domain, b));
  assert.equal(viewB.project_id, b);
  assert.equal(viewB.readable, true, "b's own policy is absent, not unreadable");
  assert.equal(viewB.worst_case.starts.value, 0);
  assert.equal(viewB.worst_case.actions.value, 0);
  for (const k of viewB.kinds) assert.equal(k.granted, false, `${k.kind} was granted in A, not in B`);

  const viewA = await exposureView(domain, await moveAuthorityForProject(domain, a));
  assert.equal(viewA.kinds.find((k) => k.kind === "chase_invoice")!.starts.value, 3);
});

test("an exposure view refuses to be built without a tenant", () => {
  assert.throws(() => composeExposure({ project_id: "", projectWedges: [] }), /scoped to a project/);
});

// ═══ THE REAL MANIFESTS ═══════════════════════════════════════════════════════════════════════════

// BUG: somebody widens a shipped envelope and nobody notices, because every other test uses a fake
// loader. This one reads the manifests on disk and pins the exposure a founder granting
// `chase_invoice` at the kernel's default ceiling actually gets.
test("the shipped invoice-chaser envelope composes to a real, pinned number", () => {
  const env = readEnvelope("invoice-chaser");
  assert.equal(env.status, "envelope");

  const view = composeExposure({
    project_id: project(),
    // No `max_per_day` on the rule: the kernel's hard 20 a day is what binds the starts.
    policy: policy({ allow: [{ kind: "chase_invoice" }] }),
    projectWedges: [],
  });
  const chase = view.kinds.find((k) => k.kind === "chase_invoice")!;
  assert.equal(chase.starts.value, HARD_MAX_PER_DAY);
  const send = chase.actions.find((a) => a.action === "email:send_reminder")!;
  // 20 starts × 3 per run = 60, above the envelope's own 50 a day — so the ENVELOPE binds here, and
  // 50 client emails a day with nobody looking is the sentence a founder is owed before granting.
  assert.equal(send.ceiling.value, 50);
  assert.equal(send.ceiling.binder, "envelope_per_day");
});
