// Services Mycel writes for one business, and the six ways that could go badly wrong.
//
// Every test here names the bug it stops. They are, in order of how much they would cost:
//
//   1. A service written for project A is loadable, spawnable or listable from project B.
//   2. A service runs before a human agreed to it.
//   3. A definition claiming a capability nothing provides, a role, or a job with no output schema
//      is stored, and the failure is discovered on a live run instead of at authoring.
//   4. A written service claims a singleton role that an installed service already holds.
//   5. The seven hand-written services change behaviour because of any of the above.
//   6. The autonomy ceilings move.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _resetAuthored,
  getAuthoredStore,
  loadProjectWedge,
  promotedSlugs,
  type NewAuthoredWedge,
} from "../src/authored";
import { authoredSlug, isAuthoredSlug, loadWedge, type WedgeManifest } from "../src/wedge";
import { authorWedgeFromOutput, authoredFaults, repairAuthoredManifest, reviewDraft, AUTHOR_LIMITS, AUTHORABLE_SHAPES } from "../src/wedgeauthor";
import { buildWedgeRoleIndex, manifestFaults } from "../src/roles";
import { HARD_MAX_PER_DAY, HARD_MAX_PER_SWEEP } from "../src/autonomy";
import { api, freshProjectId, makeFreshApp, waitTask } from "./helpers";
import { getDomainStore } from "../src/domain";

/**
 * A definition that passes every rule. Every "this is refused" test below is this, broken in ONE
 * place — otherwise a test can pass because of a fault it was not testing for, which is how a
 * validator ends up with a rule nothing actually exercises.
 */
function goodManifest(slug: string): Record<string, unknown> {
  return {
    wedge: slug,
    title: "Proposals and sign-off",
    task_types: {
      draft_scope: {
        description: "Turn what the client asked for into a scope with deliverables and a price.",
        output_schema: {
          type: "object",
          properties: {
            deliverables: { type: "array", items: { type: "string" } },
            price_minor_units: { type: "integer" },
          },
          required: ["deliverables", "price_minor_units"],
        },
      },
      chase_signoff: {
        description: "The proposal has been out a week and nobody has replied.",
        output_schema: { type: "object", properties: { sent: { type: "boolean" } } },
      },
    },
    capabilities: ["send_email"],
    approvals: [{ action: "email.send", risk: "medium", required: true }],
    cases: { stages: ["scoping", "proposed", "signed"], initial: "scoping" },
    intake: [{ id: "day-rate", ask: "What's your day rate, and does it change for retainers?" }],
    /**
     * HOW IT TRANSACTS, because a service without this can think and cannot trade.
     *
     * Added when `cannot-transact` became blocking. The fixture is named `goodManifest` and until
     * then it modelled a service that would raise no asks, draft no invoice and never start
     * production — which is what the first authored service in production actually did, five times.
     * A fixture called good has to be good.
     */
    fulfillment: {
      client_connections: [],
      intake_asks: [
        { kind: "document", ask: "Anything you have already written about the project" },
        { kind: "decision", ask: "Confirm the scope and price before we start" },
      ],
      money_plan: {
        currency: "USD",
        lines: [{ label: "Deposit", amount_minor: 50_000, kind: "deposit" }],
      },
      deliverable_shapes: ["document"],
      production_task_type: "draft_scope",
    },
  };
}

const goodOutput = (name = "Proposals and sign-off") => ({
  slug: name,
  manifest: goodManifest("ignored — overwritten by the caller's slug"),
  skills: [{ name: "write-a-scope", content: "# Writing a scope\n\nStart from the deliverable.\n\n## Never\n\n- Never invent a client, a price, or a scope they did not ask for.\n" }],
});

function draftRow(projectId: string, slug: string): NewAuthoredWedge {
  return {
    project_id: projectId,
    slug,
    title: "Proposals and sign-off",
    manifest: goodManifest(slug) as unknown as WedgeManifest,
    skills: [{ name: "write-a-scope.md", content: "# Writing a scope\n\n## Never\n\n- Never invent a client.\n" }],
    knowledge: [],
    described_as: "I run a design studio",
  };
}

// ═══════════════════════════ 1. TENANCY ═══════════════════════════

test("a service written in one project cannot be loaded from another", async () => {
  // THE BUG: `loadWedge(slug)` takes no project id and has ~50 callers. If an authored service were
  // reachable through any of them, project B would run project A's definition — A's jobs, A's policy
  // envelope, A's knowledge — against B's clients. Two cross-tenant leaks have shipped in this repo
  // and both were an identifier that was optional or defaulted.
  _resetAuthored();
  const a = freshProjectId("a");
  const b = freshProjectId("b");
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(a, slug));
  await getAuthoredStore().decide(a, slug, "promoted", "founder-a");

  assert.ok(await loadProjectWedge(a, slug), "the project that authored it can load it");
  assert.equal(await loadProjectWedge(b, slug), null, "another project cannot");
  assert.deepEqual(await promotedSlugs(b), []);
});

test("no caller of loadWedge can reach a written service, whatever the slug", () => {
  // THE BUG, one layer deeper: the test above proves the RESOLVER is scoped, which only helps the
  // handful of call sites that use it. This proves the other forty-odd cannot see an authored
  // service at all, because `loadWedge` refuses the slug shape outright. That is what makes the
  // tenancy property total rather than a list of places somebody remembered to fix.
  for (const base of ["proposals", "invoice-chaser", "books-keeper"]) {
    const slug = authoredSlug(base);
    assert.ok(isAuthoredSlug(slug));
    assert.equal(loadWedge(slug), null, `loadWedge answered for ${slug}`);
  }
  // And the installed ones still load, because the guard is on the mark and not on the lookup.
  assert.ok(loadWedge("business-shaper"), "an installed service still loads");
});

test("loadWedge refuses a slug that escapes the services directory", () => {
  // THE BUG: `loadWedge` did `join(root, slug)` on a string that arrives from `POST /v1/tasks`, so
  // `"../../etc"` read outside `wedges/`. Only ever a file called `wedge.json`, which is why it had
  // not bitten — but "only exploitable through a file with one specific name" is not an argument.
  for (const bad of ["../secrets", "a/b", "..", "", "./x"]) {
    assert.equal(loadWedge(bad), null, `loadWedge accepted ${JSON.stringify(bad)}`);
  }
});

test("the resolver refuses to answer at all without a project", async () => {
  // THE BUG: a caller that has lost track of whose work it is running continues with a guess. An
  // empty project id is a programming error, not a state, so it throws rather than returning null —
  // null would be indistinguishable from "no such service" and the bug would be invisible.
  _resetAuthored();
  await assert.rejects(() => loadProjectWedge("", authoredSlug("proposals")), /scoped to a project/);
  // A plain slug is fine with no project: installed services are the same for every tenant, which is
  // what makes them installed. `projectAllowsWedge` answers the different question.
  assert.ok(await loadProjectWedge("", "business-shaper"));
});

test("a written service is invisible to another project through the API", async () => {
  // THE BUG: the store is scoped but a route forgets, and a founder lists "their" services and sees
  // somebody else's business. The route-level version of test 1.
  _resetAuthored();
  const { app } = await makeFreshApp();
  const mine = (await api(app, "me")).json.projects[0].id as string;
  const theirs = freshProjectId("other");
  await getAuthoredStore().createDraft(draftRow(theirs, authoredSlug("their-service")));
  await getAuthoredStore().createDraft(draftRow(mine, authoredSlug("my-service")));

  const list = await api(app, "services/drafts");
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.map((d: any) => d.slug),
    [authoredSlug("my-service")],
  );

  const theirDraft = await api(app, `services/drafts/${encodeURIComponent(authoredSlug("their-service"))}`);
  assert.equal(theirDraft.status, 404, "another tenant's service must read as a typo, not as a forbidden row");

  const promote = await api(app, `services/drafts/${encodeURIComponent(authoredSlug("their-service"))}/promote`, {
    method: "POST",
  });
  assert.equal(promote.status, 404);
  assert.equal((await getAuthoredStore().getAuthored(theirs, authoredSlug("their-service")))!.status, "drafted");
});

// ═══════════════════════════ 2. THE HUMAN GATE ═══════════════════════════

test("a written service cannot run before a human promotes it", async () => {
  // THE BUG: model output becomes a running service with nobody in the loop. the self-improvement system (deleted in 59f1dd83 — 261 sandbox-hours, four proposals, nothing adopted)
  // is the precedent and the stake here is higher — a promoted service is one a client eventually hears
  // from. The gate is in the RESOLVER, not at a route, because a gate at a route is one somebody
  // forgets to add to the second route.
  _resetAuthored();
  const p = freshProjectId("gate");
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(p, slug));

  assert.equal(await loadProjectWedge(p, slug), null, "a draft must not be loadable");
  assert.deepEqual(await promotedSlugs(p), []);

  await getAuthoredStore().decide(p, slug, "promoted", "founder");
  assert.ok(await loadProjectWedge(p, slug), "promotion is what makes it loadable");
});

test("a rejected service cannot be loaded, and cannot be promoted afterwards", async () => {
  // THE BUG: "no" that does not stick. A founder declines a draft, somebody clicks promote on a
  // stale tab, and a service they said no to starts talking to their clients.
  _resetAuthored();
  const p = freshProjectId("no");
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(p, slug));
  await getAuthoredStore().decide(p, slug, "rejected", "founder");

  assert.equal(await loadProjectWedge(p, slug), null);
  assert.equal(await getAuthoredStore().decide(p, slug, "promoted", "someone-else"), undefined);
  assert.equal((await getAuthoredStore().getAuthored(p, slug))!.status, "rejected");
});

test("two founders promoting at once produce one promotion and one readable refusal", async () => {
  // THE BUG: read-check-write. Two tabs both see `drafted`, both write `promoted`, and the audit
  // trail records whichever landed second as the decider — so nobody can say who agreed to it.
  _resetAuthored();
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(project, slug));

  const [first, second] = await Promise.all([
    api(app, `services/drafts/${encodeURIComponent(slug)}/promote`, { method: "POST" }),
    api(app, `services/drafts/${encodeURIComponent(slug)}/promote`, { method: "POST" }),
  ]);
  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [200, 409]);
  const loser = first.status === 409 ? first : second;
  assert.match(loser.json.error, /already running/);
});

test("a task cannot be spawned against a service nobody has agreed to run", async () => {
  // THE BUG: the resolver is right and the boundary is not, so the run is accepted, queued and
  // charged for before anything notices. The refusal has to happen at `POST /v1/tasks` — that is the
  // only place the founder finds out in time to do something about it.
  _resetAuthored();
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(project, slug));

  const body = JSON.stringify({ wedge: slug, task_type: "draft_scope", input: {} });
  const refused = await api(app, "tasks", { method: "POST", body });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /agreed to/);
  // And the sentence never confirms that another business's service exists.
  assert.doesNotMatch(refused.json.error, /wedge|kernel|harness|provision/i);

  await getAuthoredStore().decide(project, slug, "promoted", "founder");
  const accepted = await api(app, "tasks", { method: "POST", body });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(accepted.json.wedge, slug);
});

test("an unknown job on a promoted service is still refused at the door", async () => {
  // THE BUG: a promoted service becomes a free pass. A task type the definition does not declare is
  // a run with no output schema — an agent handed a verb nobody taught it.
  _resetAuthored();
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(project, slug));
  await getAuthoredStore().decide(project, slug, "promoted", "founder");

  const res = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: slug, task_type: "invent_something", input: {} }),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /invent_something/);
});

// ═══════════════════════════ 3. VALIDATION AT AUTHORING TIME ═══════════════════════════

const messagesFor = (patch: Record<string, unknown>): string => {
  const slug = authoredSlug("proposals");
  return authoredFaults(slug, { ...goodManifest(slug), ...patch })
    .map((f) => f.message)
    .join(" | ");
};

test("the reference definition passes, so every refusal below is about the one thing it broke", () => {
  const slug = authoredSlug("proposals");
  assert.deepEqual(authoredFaults(slug, goodManifest(slug)), []);
});

test("a written service MAY reference a verified shared workflow — the catalogue dissolving into the generator", () => {
  const slug = authoredSlug("proposals");
  // Referencing the kernel-owned primitive by lib is allowed; authoring code is not.
  assert.deepEqual(
    authoredFaults(slug, {
      ...goodManifest(slug),
      workflows: [{ name: "chase_step", lib: "dunning-ladder", description: "which dunning step" }],
    }),
    [],
    "a lib reference is how a generated service gets real mechanics",
  );
  // An unknown lib is refused — the reference must resolve to a primitive that actually exists.
  assert.match(
    messagesFor({ workflows: [{ name: "x", lib: "make-money-fast" }] }),
    /verified shared primitive/,
  );
});

test("the shared dunning-ladder primitive runs for a wedge that references it by lib", async () => {
  const { runWorkflow } = await import("../src/workflows");
  // invoice-chaser now references the shared lib instead of shipping its own next_step.mjs.
  const overdue = await runWorkflow("invoice-chaser", "next_step", { days_overdue: 40 });
  assert.equal(overdue.ok, true, overdue.error);
  assert.equal((overdue.data as any).step, "final_notice");
  assert.equal((overdue.data as any).escalate, true);
  const disputed = await runWorkflow("invoice-chaser", "next_step", { days_overdue: 40, disputed: true });
  assert.equal((disputed.data as any).step, "hold");
});

test("a definition claiming a capability nothing provides is refused, by name", () => {
  // THE BUG: a silently-dropped capability resolves to no connections at grant time, which is
  // indistinguishable from a business that connected nothing. The run goes ahead with no hands,
  // drafts something, and reports success. Reached by a missing "s".
  const msgs = messagesFor({ capabilities: ["read_payment"] });
  assert.match(msgs, /read_payment/);
  assert.match(msgs, /did you mean "read_payments"/);
});

test("a job with no output schema is refused, and so is a schema that checks nothing", () => {
  // THE BUG: `validateOutput` cannot validate a run without a schema, so the run reports success on
  // whatever the model said. This repo's most expensive bug shape, and the one a written service is
  // most likely to reach.
  assert.match(messagesFor({ task_types: { do_it: { description: "x" } } }), /does not say what it produces/);
  for (const schema of [{}, true, "an object", { type: "object" }, { type: "object", properties: {} }]) {
    assert.match(
      messagesFor({ task_types: { do_it: { description: "x", output_schema: schema } } }),
      /does not say what it produces/,
      `accepted ${JSON.stringify(schema)} as an output schema`,
    );
  }
});

test("a definition with an unknown field is refused with the nearest legal one named", () => {
  // THE BUG is `manifestFaults`'s own: a manifest saying `"provide"` parses fine, declares nothing,
  // and reads as wired up. This asserts the authored path runs that validator rather than a laxer
  // copy of it.
  assert.match(messagesFor({ capabilties: [] }), /unknown field "capabilties"/);
});

test("every field a written service may not have is refused, one sentence each", () => {
  // THE BUG, in six flavours: each of these is a way for a generated definition to grant itself
  // something a reviewer glancing at a card would not notice.
  // A workflow with no shared-lib reference is still refused (it would point at code nobody wrote);
  // one that references a verified primitive is now allowed — see the dedicated test below.
  assert.match(messagesFor({ workflows: [{ name: "reconcile" }] }), /cannot author its own runnable code/);
  assert.match(messagesFor({ connections: ["stripe"] }), /one specific connected account/);
  // `policy` LEFT this list deliberately (2026-08-28): a service that must ask permission for
  // everything on day one is a gate the founder learns to stop reading. An authored envelope is now
  // ALLOWED and sanitised hard instead — exact actions only, max three rules, ceilings halved,
  // money rules deleted whole. The refusal-shaped protection moved into `sanitiseAuthoredPolicy`,
  // pinned by authored-policy.test.ts; what this line pins is that an authored policy no longer
  // trips the refusal path at all (an UNBOUNDED rule like this one simply does not survive repair).
  assert.doesNotMatch(messagesFor({ policy: { auto_approve: [{ action: "email.send" }] } }), /act without asking/);
  assert.match(messagesFor({ harness: { allow_action_token: true } }), /without approval/);
  assert.match(messagesFor({ tools: ["bash"] }), /choose its own tools/);
  assert.match(messagesFor({ model: "gpt-9" }), /our decision/);
  assert.match(messagesFor({ internal: true }), /the work this business sells/);
});

test("a permission that is not required is refused, because that is not a permission", () => {
  // THE BUG: the review card promises "it will always ask you before it does any of this", and a
  // `required: false` entry makes that promise false while still appearing on the list.
  assert.match(messagesFor({ approvals: [{ action: "email.send", risk: "high", required: false }] }), /not a permission/);
});

test("a dangling reference is refused rather than stored as configuration", () => {
  // THE BUG: each of these reads as configured and does nothing. A resume that names no job parks
  // the engagement forever — the client answers and nothing picks it up.
  assert.match(
    messagesFor({
      task_types: {
        ask_client: {
          description: "x",
          output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
          waits_for: { on: "client_request", resume: "not_a_job", reason: "waiting on the brief" },
        },
      },
    }),
    /never restart/,
  );
  assert.match(
    messagesFor({
      task_types: {
        ask_client: {
          description: "x",
          output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
          waits_for: { on: "client_request", resume: "ask_client", reason: "waiting" },
        },
      },
    }),
    /same thing again/,
  );
  assert.match(messagesFor({ cases: { stages: ["a", "b"], initial: "c" } }), /not one of the stages/);
});

test("a definition too big for a founder to read is refused", () => {
  // THE BUG: a surface nobody could review is a surface nobody reviewed, and the promote button
  // still says the same thing. A model asked for a service can emit forty jobs.
  const many: Record<string, unknown> = {};
  for (let i = 0; i < AUTHOR_LIMITS.max_task_types + 1; i++) {
    many[`job_${i}`] = { description: "x", output_schema: { type: "object", properties: { ok: { type: "boolean" } } } };
  }
  assert.match(messagesFor({ task_types: many }), /more than anybody will read/);
  assert.match(messagesFor({ task_types: {} }), /not describe a single job/);
});

test("a written service cannot be stored under a slug that hides what it is", () => {
  // THE BUG: an authored definition filed under a plain slug is back inside `loadWedge`'s reach, and
  // the whole lexical tenancy argument is undone by one row.
  assert.match(authoredFaults("proposals", goodManifest("proposals")).map((f) => f.message).join(" "), /not marked as authored/);
  // And it cannot claim to be something else, which is how it would end up trusted as installed.
  assert.match(messagesFor({ wedge: "invoice-chaser" }), /those must match/);
});

test("the store itself refuses a row that is not marked as authored", async () => {
  // THE BUG, at the last line of defence: a future caller that skips `authoredFaults`. The invariant
  // is enforced at the door rather than trusted from whoever is writing.
  _resetAuthored();
  await assert.rejects(
    () => getAuthoredStore().createDraft({ ...draftRow(freshProjectId("x"), "proposals") }),
    /authored slug/,
  );
});

test("an unusable draft is refused with a sentence, and nothing is stored", () => {
  // THE BUG: the founder gets "something went wrong" and a broken business, or — worse — a row that
  // looks like progress. `authorWedgeFromOutput` returns faults or a draft, never a half of one.
  const bad = authorWedgeFromOutput({ manifest: { title: "Thing" } }, { slugBase: "Thing" });
  assert.equal(bad.draft, undefined);
  assert.ok(bad.faults.length > 0);
  assert.match(bad.faults.map((f) => f.message).join(" "), /not describe a single job/);

  const notEvenJson = authorWedgeFromOutput("sorry, I could not do that", { slugBase: "Thing" });
  assert.equal(notEvenJson.draft, undefined);
  assert.match(notEvenJson.faults[0].message, /did not come back as a service definition/);
});

test("a good draft is normalised so nothing it declares is missing on disk", () => {
  // THE BUG: `skills` on a manifest is a FILENAME FILTER. A definition listing `["write-a-scope"]`
  // with no such file mounts nothing, so the agent runs with no procedure while every log line says
  // the service loaded fine. The filter is rewritten to exactly what is present.
  const r = authorWedgeFromOutput(goodOutput(), { slugBase: "Proposals and sign-off" });
  assert.ok(r.draft, r.faults.map((f) => f.message).join("; "));
  assert.equal(r.draft!.slug, authoredSlug("proposals-and-sign-off"));
  assert.deepEqual(r.draft!.manifest.skills, ["write-a-scope.md"]);
  assert.deepEqual(r.draft!.manifest.knowledge, []);
  assert.equal(r.draft!.manifest.wedge, r.draft!.slug);
});

test("a skill without a Never ceiling is refused", () => {
  const r = authorWedgeFromOutput(
    { ...goodOutput(), skills: [{ name: "write-a-scope", content: "# Writing a scope\n\nStart from the deliverable." }] },
    { slugBase: "Proposals" },
  );
  assert.equal(r.draft, undefined);
  assert.ok(r.faults.some((f) => /no Never/i.test(f.message)));
});

test("a file name from a model cannot become a path", () => {
  // THE BUG: skill names are joined onto a path when the sandbox is filled, and a name is not a
  // place. Normalised rather than refused, because a wrong extension is no reason to throw away a
  // correct procedure.
  const r = authorWedgeFromOutput(
    { ...goodOutput(), skills: [{ name: "../../etc/passwd", content: "# x\n\n## Never\n\n- Never invent a path.\n" }] },
    { slugBase: "Proposals" },
  );
  assert.deepEqual(r.draft!.skills.map((s) => s.name), ["etc-passwd.md"]);
});

test("a written service with no skills still gets a delivery playbook, not a named trade", () => {
  const r = authorWedgeFromOutput({ ...goodOutput(), skills: [] }, { slugBase: "Proposals" });
  assert.ok(r.draft, r.faults.map((f) => f.message).join("; "));
  assert.equal(r.draft!.skills[0]!.name, "how-we-deliver.md");
  assert.doesNotMatch(r.draft!.skills[0]!.content, /web-studio|wedge|kernel/i);
});

// ═══════════════════════════ 4. ROLES ═══════════════════════════

test("a written service cannot claim a singleton role, taken or not", () => {
  // THE BUG: `dunning` is `cardinality: "one"` across the whole INSTALL, and the install is shared
  // by every tenant. One business's written service claiming it would either lose to the installed
  // chaser silently or take dunning away from every other business on the box. So the refusal is on
  // ANY role, not on the ones that happen to be held today — a role that becomes free tomorrow must
  // not become claimable tomorrow.
  const taken = buildWedgeRoleIndex();
  assert.ok(taken.byRole.get("dunning"), "the fixture assumes an installed service holds dunning");

  const msgs = messagesFor({
    provides: ["dunning"],
    task_types: {
      chase_invoice: { description: "x", output_schema: { type: "object", properties: { sent: { type: "boolean" } } } },
    },
  });
  assert.match(msgs, /started by Mycel itself/);
  assert.match(msgs, /take it from every other business/);

  // Even a role nothing claims. There is no per-project role index and inventing one is not this.
  assert.match(messagesFor({ provides: ["app_building"] }), /started by Mycel itself/);
});

// ═══════════════════════════ 5. THE INSTALLED SERVICES ARE UNAFFECTED ═══════════════════════════

test("the hand-written services still load, still validate and still hold their roles", () => {
  // THE BUG: a change to the shared validator or to `loadWedge` that quietly breaks the seven
  // services actually in production. `buildWedgeRoleIndex` throws on any manifest fault, so this is
  // the whole catalogue re-validated, and the role assertions are the migration's own regression.
  const idx = buildWedgeRoleIndex();
  for (const slug of idx.scanned) {
    const loaded = loadWedge(slug);
    assert.ok(loaded, `${slug} no longer loads`);
    assert.deepEqual(manifestFaults(slug, loaded!.manifest as unknown), [], `${slug} no longer validates`);
    assert.equal(isAuthoredSlug(slug), false, `${slug} looks like a written service`);
  }
  assert.ok(idx.byRole.get("business_shaping"), "the shaper still holds its role");
});

test("the shaper declares the job that writes a service, so the role is not a claim it cannot perform", () => {
  // THE BUG: adding `draft_service` to the `business_shaping` role without adding it to the wedge
  // that holds the role. `manifestFaults` refuses that — a role declared but not performable reads
  // as wired up and is not — so this would fail the boot rather than fail quietly. Pinned anyway,
  // because the failure it prevents is onboarding silently losing its only escape hatch.
  const shaper = loadWedge(buildWedgeRoleIndex().byRole.get("business_shaping")!);
  assert.ok(shaper!.manifest.task_types?.draft_service?.output_schema);
  assert.ok(
    shaper!.skills.some((s) => s.name.includes("write-a-service")),
    "the job exists but nothing teaches the agent how to do it",
  );
});

// ═══════════════════════════ 6. THE CEILINGS DID NOT MOVE ═══════════════════════════

test("nothing here widened the autonomy ceilings", () => {
  // THE BUG: a new way to create work becomes a new way around the volume limits. A written service
  // declares no policy at all (it is refused above), so it cannot auto-approve anything — but the
  // hard caps are what stop a bug from mattering, and they are asserted as literals so that moving
  // them requires editing a test that says why they are there.
  assert.equal(HARD_MAX_PER_SWEEP, 5);
  assert.equal(HARD_MAX_PER_DAY, 20);
});

test("every written service acts alone in nothing, and the review card says so as a fact", () => {
  // THE BUG: the promise on the review card drifts from what the definition allows. `policy` is
  // refused at authoring, so `never_acts_alone` is derivable rather than asserted — this pins the
  // two together so that permitting an envelope later cannot silently keep the reassuring sentence.
  const r = authorWedgeFromOutput(goodOutput(), { slugBase: "Proposals" });
  const card = reviewDraft(r.draft!);
  assert.equal(card.never_acts_alone, true);
  assert.equal(card.manifestHasPolicy ?? undefined, undefined);
});

// ═══════════════════════════ WHAT THE FOUNDER SEES ═══════════════════════════

test("the founder is shown work, permissions and guarantees — not a definition", () => {
  // THE BUG: a review nobody can perform is worse than no review, because it manufactures consent
  // for whatever the model wrote. A founder cannot read a manifest, so the card is built FROM the
  // manifest rather than from any prose the model wrote about its own output.
  const r = authorWedgeFromOutput(goodOutput(), { slugBase: "Proposals and sign-off" });
  const card = reviewDraft(r.draft!);

  assert.equal(card.title, "Proposals and sign-off");
  assert.deepEqual(card.does.map((d) => d.job), ["draft scope", "chase signoff"]);
  assert.match(card.does[0].description, /scope with deliverables/);
  // Capabilities are shown in the words CAPABILITIES uses, not as slugs.
  assert.ok(card.needs.includes("Send email as your business"));
  assert.ok(card.needs.some((n) => /day rate/.test(n)), "the setup questions are part of what it needs");
  assert.deepEqual(card.always_asks, ["email send (medium risk)"]);
  assert.deepEqual(card.stages, ["scoping", "proposed", "signed"]);
});

test("no word a customer must never read reaches the review card", () => {
  // THE BUG: the shaper already had this one — a model that writes "we'd provision a wedge for you"
  // and the console prints it. The card is one surface further along and the same rule applies.
  const r = authorWedgeFromOutput(goodOutput(), { slugBase: "Proposals" });
  const card = reviewDraft(r.draft!);
  const prose = [card.title, ...card.does.flatMap((d) => [d.job, d.description]), ...card.needs, ...card.always_asks].join(" ");
  assert.doesNotMatch(prose, /\bwedge|kernel|harness|provision/i);
});

test("a draft whose capability the kernel no longer offers still renders a readable card", () => {
  // THE BUG: a row stored months ago, read back after `CAPABILITIES` changed, throws and takes the
  // whole services page down for that tenant. History must degrade into a sentence, never a 500.
  const card = reviewDraft({
    slug: authoredSlug("old"),
    manifest: { wedge: authoredSlug("old"), title: "Old", capabilities: ["read_carrier_pigeons"] },
    skills: [],
    knowledge: [],
  });
  /**
   * ═══ THIS ASSERTED `no longer offers`, AND THAT DISTINCTION NO LONGER EXISTS ═══
   *
   * While `CAPABILITIES` was the whole vocabulary, a well-formed name it did not contain could only
   * be one removed from the kernel. Now it is equally likely to be a trade's own declared need —
   * `read_appointments` and `read_carrier_pigeons` are the same shape, and nothing in the string
   * tells them apart. Keeping the old wording would mean reading a physiotherapy service's real
   * requirement back to its founder as something we had withdrawn.
   *
   * Losing the distinction costs little, because the connect surface tells the truth either way: a
   * capability nothing provides gets `whyNoProvider` — "nothing connected here says it can do this,
   * connect the tool your business uses for it" — which is exactly as true of a withdrawn capability
   * as of a trade we never shipped.
   *
   * What this test is FOR survives unchanged: stored history renders a sentence rather than throwing.
   */
  assert.equal(card.needs.length, 1);
  assert.equal(card.needs[0], "Read carrier pigeons", "stored history no longer renders a readable line");
  assert.ok(!/undefined|null|\[object/.test(card.needs[0]!), "the line is not readable prose");
});

test("the promote and reject routes name who decided, and refuse without a project", async () => {
  // THE BUG: a decision with no name on it. Somebody asks in three months who agreed to let this
  // thing email their clients and the answer is nobody knows.
  _resetAuthored();
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("proposals");
  await getAuthoredStore().createDraft(draftRow(project, slug));

  const ok = await api(app, `services/drafts/${encodeURIComponent(slug)}/promote`, { method: "POST" });
  assert.equal(ok.status, 200);
  const row = await getAuthoredStore().getAuthored(project, slug);
  assert.ok(row!.decided_by, "nothing recorded who agreed to it");
  assert.ok(row!.decided_at);

  const paused = ((await api(app, "schedules")).json as { wedge: string; enabled: boolean; task_type: string }[]).filter(
    (s) => s.wedge === slug,
  );
  assert.equal(paused.length, 1, "agreeing to a written service must put its work on a paused clock");
  assert.equal(paused[0]!.enabled, false);
  assert.equal(paused[0]!.task_type, "draft_scope");

  const live = await api(app, `services/drafts/${encodeURIComponent(slug)}/go-live`, { method: "POST" });
  assert.equal(live.status, 200);
  assert.ok(live.json.first_task_id, "go-live starts the first job instead of promising tomorrow");
  const on = ((await api(app, "schedules")).json as { wedge: string; enabled: boolean }[]).filter((s) => s.wedge === slug);
  assert.ok(on.length > 0 && on.every((s) => s.enabled));

  const intake = await api(app, `wedges/${encodeURIComponent(slug)}/intake`);
  assert.equal(intake.status, 200, "Home reads intake from the written service, not from a folder");
  assert.ok((intake.json.total as number) > 0, "declared intake must surface so the knowledge card is real");

  // An unknown key reaches no project at all and must not read another tenant's list.
  const anon = await api(app, "services/drafts", {}, "not-a-key");
  assert.equal(anon.status, 401);
});

test("re-drafting replaces a draft and leaves a promoted service alone", async () => {
  // THE BUG: a founder clicks "try again", and the definition of something already running for
  // their clients is silently rewritten underneath the engagements it is carrying.
  _resetAuthored();
  const p = freshProjectId("redraft");
  const slug = authoredSlug("proposals");
  const store = getAuthoredStore();
  await store.createDraft(draftRow(p, slug));
  await store.createDraft({ ...draftRow(p, slug), title: "Second attempt" });
  assert.equal((await store.getAuthored(p, slug))!.title, "Second attempt");

  await store.decide(p, slug, "promoted", "founder");
  const after = await store.createDraft({ ...draftRow(p, slug), title: "Third attempt" });
  assert.equal(after.title, "Second attempt", "a promoted service was rewritten underneath the founder");
  assert.equal(after.status, "promoted");
});

// ═══════════════════════════ THE WHOLE PATH, THROUGH A REAL RUN ═══════════════════════════

test("a shaping run that writes nonsense refuses loudly and stores nothing", async () => {
  // THE BUG: the recurring expensive one — something failing while reporting success. The mock
  // runtime returns a schema-shaped sample rather than a real definition, which is exactly what a
  // model having a bad day produces, and it must NOT become a row that looks like progress on the
  // founder's list. The run itself still succeeds (the agent did its job and its output passed its
  // own schema); what failed is the CONTENT, and `service.draft_refused` is where that is said.
  //
  // This is also the honest boundary of what can be verified here: `MYCEL_RUNTIME=mock` means no
  // real manifest is producible locally, so the authoring, validation and promotion path is tested
  // directly with fixtures above and this test covers the wiring between them.
  _resetAuthored();
  const { app, store } = await makeFreshApp();
  const shaper = buildWedgeRoleIndex().byRole.get("business_shaping")!;
  const project = (await api(app, "me")).json.projects[0].id as string;

  const created = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({
      wedge: shaper,
      task_type: "draft_service",
      input: { description: "I run a design studio — I scope projects and chase sign-off." },
    }),
  });
  assert.equal(created.status, 201, created.text);
  const done = await waitTask(app, created.json.id);
  assert.equal(done.status, "succeeded", "the run itself is fine; it is the content that is refused");

  // Read from the store rather than the route: `/v1/tasks/:id/events` is an SSE stream, and what
  // this test is about is whether the event was RECORDED, not how it is delivered.
  const events = await store.eventsAfter(created.json.id as string, 0);
  const refused = events.find((e) => e.type === "service.draft_refused");
  assert.ok(refused, "a draft that cannot be used must say so, not go quiet");
  assert.ok(refused!.data.reasons.length > 0);
  assert.match(refused!.data.summary, /refused it, because/);
  assert.equal(events.some((e) => e.type === "service.drafted"), false);

  assert.deepEqual(await getAuthoredStore().listAuthored({ project_id: project }), [], "nothing was stored");
});

// ── repairAuthoredManifest: a broken delivery loop is salvaged, not fatal ──────────────────────────
// The magic moment died in production on a normal design/dev-agency brief because the model shaped
// iterative work as a job that waits on ITSELF. These pin the repair that turns that into a runnable
// single-shot job instead of a dead onboarding screen — while leaving a genuine two-stage handoff
// untouched.

test("repair: a job that waits on ITSELF has the broken wait dropped, and the draft then succeeds", () => {
  const m = goodManifest("design-studio");
  (m.task_types as Record<string, Record<string, unknown>>).draft_scope.waits_for = {
    on: "client_request",
    resume: "draft_scope", // resumes itself — the exact shape observed in prod
    reason: "waiting on the brief",
  };
  const out = authorWedgeFromOutput({ manifest: m, skills: [] }, { slugBase: "Design Studio" });
  assert.equal(out.faults.length, 0, `should no longer fault: ${JSON.stringify(out.faults)}`);
  assert.ok(out.draft, "a draft is produced");
  assert.equal(
    (out.draft!.manifest.task_types as Record<string, Record<string, unknown>>).draft_scope.waits_for,
    undefined,
    "the self-resume wait is dropped, leaving a single-shot job",
  );
});

test("repair: a wait resuming a job that does not exist is dropped too (would park forever)", () => {
  const m = goodManifest("design-studio") as Record<string, unknown>;
  (m.task_types as Record<string, Record<string, unknown>>).draft_scope.waits_for = {
    on: "client_request",
    resume: "a_job_that_was_never_written",
    reason: "waiting",
  };
  repairAuthoredManifest(m);
  assert.equal(
    (m.task_types as Record<string, Record<string, unknown>>).draft_scope.waits_for,
    undefined,
    "a dangling resume is dropped",
  );
});

test("repair: a genuine two-stage handoff (draft -> revise) is left untouched", () => {
  const m: Record<string, unknown> = {
    wedge: "design-studio",
    title: "Website build",
    task_types: {
      draft_site: {
        description: "Produce a first version of the site from the brief.",
        output_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        waits_for: { on: "client_request", resume: "revise_site", reason: "waiting on feedback" },
      },
      revise_site: {
        description: "Fold the client's feedback into the next version.",
        output_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    },
    capabilities: ["send_email"],
  };
  repairAuthoredManifest(m);
  assert.deepEqual(
    (m.task_types as Record<string, Record<string, unknown>>).draft_site.waits_for,
    { on: "client_request", resume: "revise_site", reason: "waiting on feedback" },
    "a valid next-stage handoff survives the repair",
  );
});

test("repair: a singular/synonym capability name is mapped to the real one", () => {
  const m: Record<string, unknown> = {
    wedge: "x",
    title: "t",
    task_types: { do_it: { description: "d", output_schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
    capabilities: ["read_payment", "send_emails", "read_payments"],
  };
  repairAuthoredManifest(m);
  assert.deepEqual(m.capabilities, ["read_payments", "send_email", "read_payments"], "plurals/synonyms mapped, real names untouched");
});

test("repair: an unmappable capability is left alone (it should still fault, not be guessed)", () => {
  const m: Record<string, unknown> = { wedge: "x", title: "t", task_types: {}, capabilities: ["frobnicate_the_widget"] };
  repairAuthoredManifest(m);
  assert.deepEqual(m.capabilities, ["frobnicate_the_widget"], "a genuinely unknown capability is not fuzzy-guessed");
});

test("repair: a cases.initial that names no real stage is pointed at the first stage", () => {
  const m: Record<string, unknown> = {
    wedge: "x",
    title: "t",
    task_types: {},
    cases: { stages: ["scoping", "in_progress", "done"], initial: "kickoff" },
  };
  repairAuthoredManifest(m);
  assert.equal((m.cases as Record<string, unknown>).initial, "scoping", "initial defaults to the first stage");
});

test("repair: an over-long title is clipped, a malformed approval is strengthened, a missing intake id is derived", () => {
  const longTitle = "A".repeat(200);
  const m: Record<string, unknown> = {
    wedge: "x",
    title: longTitle,
    task_types: {},
    approvals: [
      { action: "email.send", risk: "kinda-risky", required: false },
      { action: "publish", risk: "high", required: true },
    ],
    intake: [
      { ask: "What is your day rate, and does it change for retainers?" }, // no id
      { id: "hosting", ask: "Where is the site hosted?" }, // fine
    ],
  };
  repairAuthoredManifest(m);
  assert.ok((m.title as string).length <= AUTHOR_LIMITS.max_title, "title clipped to the limit");
  const a0 = (m.approvals as Record<string, unknown>[])[0];
  assert.equal(a0.risk, "medium", "an unknown risk becomes the cautious middle");
  assert.equal(a0.required, true, "an approval is never left un-required");
  const q0 = (m.intake as Record<string, unknown>[])[0];
  assert.match(q0.id as string, /^[a-z][a-z0-9-]{1,48}$/, "a usable id is derived from the ask");
  assert.equal((m.intake as Record<string, unknown>[])[1].id, "hosting", "a good id is left untouched");
});

test("repair: fields copied from an example wedge (role, policy, connections, workflows) are stripped, and the draft then runs", () => {
  const m: Record<string, unknown> = {
    wedge: "x",
    title: "Website build",
    provides: ["dunning"],
    policy: { auto_approve: ["email.send"] },
    connections: ["gmail"],
    workflows: [{ name: "do-it", lib: "reconcile" }],
    harness: { steps: 99 },
    tools: ["bash"],
    model: "gpt-5",
    internal: true,
    tier: "impossible",
    task_types: { build: { description: "Build the site.", output_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    capabilities: ["send_email"],
  };
  const out = authorWedgeFromOutput({ manifest: m, skills: [] }, { slugBase: "Studio" });
  assert.equal(out.faults.length, 0, `should now run: ${JSON.stringify(out.faults)}`);
  const mm = out.draft!.manifest as unknown as Record<string, unknown>;
  for (const gone of ["provides", "policy", "connections", "workflows", "harness", "tools", "model", "tier"]) {
    assert.equal(mm[gone], undefined, `${gone} should be stripped`);
  }
  assert.notEqual(mm.internal, true, "internal:true is cleared");
});

// ── A written service may choose how it works, and nothing else about its harness ────────────────
//
// `harness` was refused whole on a task type, and the reason in the header is exact:
// `HarnessProfileSpec` carries `allow_action_token`, tool grants and permission overrides, so a
// generated service asking for one is asking to act without passing the gate.
//
// That reasoning is about the fields INSIDE a harness spec, and refusing the whole object had a
// consequence nobody could see: an authored service falls through to `general`, so every trade this
// platform writes for itself can DECIDE and DRAFT and can never OPERATE. Bookkeeping becomes "a
// document about categorisation" rather than categorising in the client's ledger. PLATFORM.md §3
// calls that the difference between a report and a back office, and it applied to the entire
// population this module exists for.
//
// The unlock is SAFER than the status quo, which is the part worth pinning: `general` grants
// actions; every authorable shape does not.

test("a written service may ask to operate — and that REMOVES its action grant", async () => {
  const { SHAPE_DEFAULTS } = await import("../src/harness");
  const { AUTHORABLE_SHAPES, AUTHORED_POLICY_MAX_RULES, AUTHORED_POLICY_MAX_PER_DAY } = await import(
    "../src/wedgeauthor",
  );

  /**
   * The DERIVATION property, asserted rather than assumed: a shape added later that can send must
   * not become authorable through somebody forgetting to update a list. `deliver` is the one named
   * exception and is excluded from the sweep by name, so adding a second one is a deliberate act
   * that has to edit this test.
   */
  for (const shape of AUTHORABLE_SHAPES.filter((s) => s !== "deliver")) {
    assert.equal(
      SHAPE_DEFAULTS[shape as keyof typeof SHAPE_DEFAULTS].grants_actions,
      false,
      `${shape} is offered to authored services and CAN act`,
    );
  }

  /**
   * AND THE SHAPE LIST IS NOT WHAT CONSTRAINS SENDING, which is why `deliver` is on it.
   *
   * An authored task type declaring no harness resolves to `deliver`; before that it resolved to
   * `general`, which grants actions just the same. So the permission was always there by default,
   * and refusing the shape that asks for it out loud bought nothing.
   *
   * What actually limits unattended action is `sanitiseAuthoredPolicy` — clamped harder than any
   * hand-written wedge, because the author is the thing being granted.
   */
  assert.equal(SHAPE_DEFAULTS.general.grants_actions, true, "the old default could act");
  assert.equal(SHAPE_DEFAULTS.deliver.grants_actions, true, "and so can the new one — same permission");
  assert.ok(AUTHORED_POLICY_MAX_RULES <= 3 && AUTHORED_POLICY_MAX_PER_DAY <= 10, "the real ceiling");
  assert.ok(AUTHORABLE_SHAPES.includes("operate"));
  assert.ok(!AUTHORABLE_SHAPES.includes("general"), "tuned for nothing — nothing should land there");
});

test("build is not authorable — it would have nowhere to build", () => {
  // Not a risk exclusion. `workspace` is still refused, and a build-shaped job with no workspace
  // exports nothing: the run does the work and the orchestrator deletes it with the sandbox.
  assert.equal(AUTHORABLE_SHAPES.includes("build"), false);
});

test("an operate job survives authoring; a shape that can send does not", () => {
  const job = (harness: unknown) => ({
    manifest: {
      wedge: "x",
      title: "Ledger desk",
      task_types: {
        categorise: {
          description: "Categorise the month in the client's own accounting package.",
          harness,
          output_schema: {
            type: "object",
            properties: { client_summary: { type: "string" }, done: { type: "boolean" } },
            required: ["client_summary", "done"],
          },
          ship_requires: ["client_summary"],
        },
      },
    },
    skills: [],
  });

  const ok = authorWedgeFromOutput(job({ shape: "operate" }), { slugBase: "Ledger" });
  assert.equal(ok.faults.length, 0, `operate should author: ${JSON.stringify(ok.faults)}`);
  const kept = (ok.draft!.manifest as unknown as Record<string, unknown>).task_types as Record<
    string,
    { harness?: { shape?: string } }
  >;
  assert.equal(kept.categorise?.harness?.shape, "operate", "the shape survives repair");

  /**
   * `deliver` IS on offer, and refusing it was incoherent rather than safe.
   *
   * An authored task type declaring no harness resolves to `deliver` — `resolveHarnessProfile` used
   * to drop it into `general`, which grants actions just the same and is described in its own file
   * as the shape nobody has thought about. So silence already produced this shape while asking for
   * it was refused, on the grounds that it "cannot send" — untrue of the default behind it.
   *
   * What holds the line is unchanged and is not the shape list: an authored service may not carry a
   * `policy` envelope, so it has no auto-approval and every send waits for a human.
   */
  const delivers = authorWedgeFromOutput(job({ shape: "deliver" }), { slugBase: "Ledger" });
  assert.equal(delivers.faults.length, 0, `deliver should author: ${JSON.stringify(delivers.faults)}`);

  // `general`, `decide` and `build` stay refused, and the refusal says why in the founder's own
  // terms rather than naming a field. `general` is excluded even though it grants exactly what
  // `deliver` does: it is tuned for nothing, so asking for it is asking for the worst harness here.
  for (const shape of ["general", "decide", "build"]) {
    const bad = authorWedgeFromOutput(job({ shape }), { slugBase: "Ledger" });
    assert.ok(bad.faults.length > 0, `${shape} should be refused`);
    assert.match(
      bad.faults.map((f) => f.message).join(" "),
      /cannot act at all, or can only act once you have approved it/,
    );
  }
});

test("everything else inside a harness is still refused, with the original argument", () => {
  const withHarness = (harness: unknown) =>
    authorWedgeFromOutput(
      {
        manifest: {
          wedge: "x",
          title: "Ledger desk",
          task_types: {
            categorise: {
              description: "Do the thing.",
              harness,
              output_schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            },
          },
        },
        skills: [],
      },
      { slugBase: "Ledger" },
    )
      .faults.map((f) => f.message)
      .join(" ");

  // The action token is the whole reason `harness` was refused in the first place. Asking for it
  // ALONGSIDE a legal shape must not sneak through.
  assert.match(withHarness({ shape: "operate", allow_action_token: true }), /may not do/);
  assert.match(withHarness({ shape: "operate", tools: { bash: true } }), /may not do/);
  assert.match(withHarness({ steps: 99 }), /may not do/);
  assert.match(withHarness("operate"), /cannot read/);
});

test("a workspace is still refused, and now says why", () => {
  const out = authorWedgeFromOutput(
    {
      manifest: {
        wedge: "x",
        title: "Site studio",
        task_types: {
          build: {
            description: "Build the site.",
            workspace: { dir: "app", seed: "business-template" },
            output_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          },
        },
      },
      skills: [],
    },
    { slugBase: "Studio" },
  );
  assert.ok(out.faults.length > 0);
  assert.match(out.faults.map((f) => f.message).join(" "), /directory of code/);
});

// ═══════════════════════════ 6. THE CATALOGUE A FOUNDER IS SHOWN ═══════════════════════════
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A SERVICE WRITTEN FOR A BUSINESS WAS INVISIBLE TO EVERY SURFACE THAT ASKS WHAT WE RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `GET /v1/wedges` read the wedges DIRECTORY and nothing else. Its own header says the shaping agent
// "has to reason against the real list" — and the real list left out the half of the catalogue that
// exists precisely because the directory does not cover somebody's trade.
//
// Measured: `brand-and-website-projects` was authored for a real brand studio on 14 August and
// promoted. It is live. The shaper is handed eight directory trades and nothing else, so every brand
// studio shaped since has settled on the nearest miss — four of them on `invoice-chaser`, whose own
// description is "chases YOUR overdue invoices". The service that fitted them existed the whole time
// and nothing could see it.
//
// A written service is how this product covers a trade nobody packaged. Outside the catalogue, that
// mechanism runs once per business and never compounds.

test("A PROMOTED WRITTEN SERVICE IS IN THE CATALOGUE", async () => {
  _resetAuthored();
  const { app } = await makeFreshApp();
  // The SESSION's own project. `freshProjectId()` is not in the caller's accessible set, so a route
  // that scopes correctly resolves no project for it — which is the first way this test was wrong.
  const p = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("brand-and-website-projects");
  await getAuthoredStore().createDraft(draftRow(p, slug));
  await getAuthoredStore().decide(p, slug, "promoted", "founder");

  const cat = (await api(app, "wedges", { headers: { "x-mycel-project": p } })).json as {
    wedge: string; title: string; jobs: { task_type: string; description: string }[];
  }[];
  const mine = cat.find((w) => w.wedge === slug);
  assert.ok(mine, `a promoted written service is missing from the catalogue. Got: ${cat.map((w) => w.wedge)}`);
  /*
    The SAME SHAPE as a directory entry, not a second kind of row. Every consumer — the shaper's
    catalogue, the services list, onboarding — reads one list, and a caller that has to know which
    half a trade came from is a caller that will forget.
  */
  assert.equal(mine!.title, "Proposals and sign-off", "a written service renders as its slug");
  assert.ok(mine!.jobs.length > 0, "a written service carries no jobs, so nothing can match on it");
  assert.ok(
    mine!.jobs.every((j) => typeof j.description === "string" && j.description.length > 0),
    "the job descriptions are the only prose a wedge has, and they are what a founder's words match against",
  );
  // And the directory half is still there — this adds, it does not replace.
  assert.ok(cat.some((w) => !isAuthoredSlug(w.wedge)), "the packaged trades fell out of the catalogue");
});

test("a DRAFT is not in it — nothing runs until a human promotes it", async () => {
  _resetAuthored();
  const { app } = await makeFreshApp();
  const p = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("packaging-design");
  await getAuthoredStore().createDraft(draftRow(p, slug));

  const cat = (await api(app, "wedges", { headers: { "x-mycel-project": p } })).json as { wedge: string }[];
  assert.ok(
    !cat.some((w) => w.wedge === slug),
    "an unpromoted draft is offered as a live service, defeating the one gate this module has",
  );
});

test("ANOTHER TENANT'S WRITTEN SERVICE IS NOT IN IT", async () => {
  /**
   * The directory half of this route is deliberately not project-scoped — it describes the kernel's
   * capabilities. A WRITTEN service is the other thing: it belongs to the business it was written
   * for, and publishing one tenant's service definition to another is a decision about their work
   * rather than a cache question.
   *
   * So this does NOT yet make the catalogue compound across businesses. A trade learned once and
   * offered to everyone in it afterwards is the growth mechanism, and it is a decision somebody has
   * to make rather than a refactor. Pinned here so that when it is made, it is made on purpose.
   */
  _resetAuthored();
  const { app } = await makeFreshApp();
  const mine = (await api(app, "me")).json.projects[0].id as string;
  const theirs = freshProjectId("other");
  const slug = authoredSlug("their-brand-service");
  await getAuthoredStore().createDraft(draftRow(theirs, slug));
  await getAuthoredStore().decide(theirs, slug, "promoted", "founder");
  /*
    ASSERT THE FIXTURE. Both leak assertions below are "this slug is absent", which is exactly what a
    test proves when its setup silently did nothing — and sabotaging the scope check left this test
    green, which is how the vacuum was found rather than guessed at.
  */
  assert.deepEqual(await promotedSlugs(theirs), [slug], "the fixture never promoted anything to leak");

  const cat = (await api(app, "wedges", { headers: { "x-mycel-project": mine } })).json as { wedge: string }[];
  assert.ok(!cat.some((w) => w.wedge === slug), "one tenant's written service leaked into another's catalogue");

  /**
   * AND NAMING THEIR PROJECT IN THE HEADER DOES NOT FETCH IT.
   *
   * Caught by sabotage: replacing the scope check with `named ?? [...set][0]` — trusting the header
   * — left every assertion above green, because they all pass their OWN project id. A header a
   * caller controls is not a permission, and both of this repo's cross-tenant leaks were a defaulted
   * or trusted scope on a read.
   */
  const asThem = (await api(app, "wedges", { headers: { "x-mycel-project": theirs } })).json as { wedge: string }[];
  assert.ok(
    !asThem.some((w) => w.wedge === slug),
    "naming another tenant's project in the header served their written services",
  );
  // The directory half still answers — an unauthorised project scope is not an error, it is no
  // written services. The kernel's own capabilities are not a tenant's data.
  assert.ok(asThem.length > 0, "an unrecognised project scope emptied the whole catalogue");
});

// ═══════════════════════════ 7. WHICH JOB STARTS THE WORK ═══════════════════════════
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A NEW ENGAGEMENT WOULD HAVE BEGUN BY REVISING A WEBSITE THAT DOES NOT EXIST
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `repairAuthoredManifest` derives `fulfillment.production_task_type` for services written before
// that block was required. It took the LAST non-machinery job, on the reasoning that "a service
// reads in order and the thing it hands over is what it ends on" — a true sentence about the
// DELIVERABLE, and the wrong answer to this question. `production_task_type` is what
// `sweepFulfillmentIgnition` SPAWNS when an engagement is ready to begin.
//
// Read from the one written service live in production, a brand studio's, four jobs in order:
//
//     shape_brand_strategy      inputs: positioning, competitors, target_audience, goals
//     develop_brand_identity    inputs: brand_strategy, approved_feedback
//     build_marketing_website   inputs: brand_guidelines, website_copy
//     revise_marketing_website  inputs: feedback, website_url          <- was chosen
//
// Every later job takes a previous step's output; only the first takes facts about the client. A
// single-job service makes first and last the same name, which is why this went unseen.

test("PRODUCTION STARTS AT THE FIRST JOB, NOT THE LAST", () => {
  const manifest = {
    wedge: authoredSlug("brand-and-website"),
    title: "Brand and website projects",
    task_types: {
      shape_brand_strategy: { description: "Turn positioning and audience into a brand strategy." },
      develop_brand_identity: { description: "Develop the logo and visual system from the approved strategy." },
      build_marketing_website: { description: "Build the marketing site from the approved identity." },
      revise_marketing_website: { description: "Apply the client's consolidated feedback and prepare handover." },
    },
  } as unknown as Record<string, unknown>;
  repairAuthoredManifest(manifest);
  const f = (manifest.fulfillment ?? {}) as { production_task_type?: string };
  assert.equal(
    f.production_task_type,
    "shape_brand_strategy",
    `ignition would start an engagement with "${f.production_task_type}"`,
  );
});

test("a job that names what the client receives still wins", () => {
  /*
    An author who declares `deliverable_kind` has answered this directly, and that beats any
    positional guess. Declared SECOND here on purpose — if position were still deciding, this test
    would pass for the wrong reason.
  */
  const manifest = {
    wedge: authoredSlug("claims"),
    title: "Claims and denials",
    task_types: {
      gather_claim_facts: { description: "Collect the facts a claim needs." },
      file_claim: { description: "File the claim and report the outcome.", deliverable_kind: "document" },
      chase_denial: { description: "Chase a denied claim." },
    },
  } as unknown as Record<string, unknown>;
  repairAuthoredManifest(manifest);
  assert.equal((manifest.fulfillment as { production_task_type?: string }).production_task_type, "file_claim");
});

test("the repair is idempotent and never overwrites a real fulfillment block", () => {
  // It runs on every LOAD, not just at authoring — so a service that already answered must be left
  // exactly as it is, or every read would rewrite the founder's own service.
  const manifest = {
    wedge: authoredSlug("kept"),
    title: "Kept",
    task_types: { first_job: { description: "One." }, second_job: { description: "Two." } },
    fulfillment: { production_task_type: "second_job", intake_asks: [{ kind: "answer", ask: "Which brand?" }] },
  } as unknown as Record<string, unknown>;
  repairAuthoredManifest(manifest);
  const f = manifest.fulfillment as { production_task_type?: string; intake_asks?: unknown[] };
  assert.equal(f.production_task_type, "second_job", "the repair overwrote a declared production job");
  assert.equal(f.intake_asks?.length, 1, "the repair flattened intake the founder had filled in");
});

// ═══════════════════════════ 8. THE NEED REACHES THE FOUNDER ═══════════════════════════
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A DECLARATION NOBODY IS ASKED TO MEET IS NOT A FRAMEWORK
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A written service can now name a need this kernel has never heard of, and a connection the founder
// brings can answer it. `GET /v1/capabilities` is the surface where a founder LEARNS that a service
// needs something — it feeds the apps page's "needs" section — and it enumerated `ALL_CAPABILITIES`
// and nothing else.
//
// So the loop had a hole in the middle: the service declares, nobody is asked, nothing is connected,
// `resolveCapability` reports it missing forever. Reachable in theory, unreachable in practice.

test("A WRITTEN SERVICE'S OWN NEED IS SOMETHING THE FOUNDER IS ASKED TO CONNECT", async () => {
  _resetAuthored();
  const { app } = await makeFreshApp();
  const p = (await api(app, "me")).json.projects[0].id as string;
  const slug = authoredSlug("physio-recalls-and-claims");
  const row = draftRow(p, slug);
  // The whole point: a trade this kernel has never heard of, naming what it runs on.
  (row.manifest as unknown as { capabilities: string[] }).capabilities = ["read_appointments", "send_email"];
  await getAuthoredStore().createDraft(row);
  await getAuthoredStore().decide(p, slug, "promoted", "founder");
  // A schedule is what makes a wedge THIS PROJECT'S — same rule `app-suggestions.ts` uses.
  await getDomainStore().createSchedule({
    project_id: p, name: "recalls", wedge: slug, task_type: "draft_scope", input: {},
    cadence: { kind: "every", seconds: 86_400 }, enabled: true, next_run_at: new Date().toISOString(),
  });

  const caps = (await api(app, "capabilities", { headers: { "x-mycel-project": p } })).json as {
    items: { capability: string; title: string; question: string; implementation: string; needed_by: string[] }[];
  };
  const mine = caps.items.find((i) => i.capability === "read_appointments");
  assert.ok(mine, `the declared need is not on the connect surface. Got: ${caps.items.map((i) => i.capability)}`);

  /*
    Its own name, said plainly. There is no hand-written title for a trade we do not know, and
    inventing one would be inventing knowledge — the service that declared it chose these words.
  */
  assert.equal(mine!.title, "read appointments");
  assert.match(mine!.question, /Which tool does your business use to read appointments\?/);
  /*
    BROKERED, and the founder is told. `resolveCapability` hands the agent the vendor's own tools for
    a declared capability; a green row that looked like the kernel-parsed kind would be the same lie
    `brokeredCaveat` exists to prevent one layer down.
  */
  assert.equal(mine!.implementation, "brokered");
  assert.match(mine!.needed_by.join(" "), /Proposals and sign-off/, "the row does not say which service wants it");

  // And the eleven are still all there — this adds, it does not replace.
  for (const known of ["read_payments", "send_email"]) {
    assert.ok(caps.items.some((i) => i.capability === known), `${known} fell off the connect surface`);
  }
});

test("a need from a service this project does NOT run is not asked about", async () => {
  /**
   * The founder's own complaint, verbatim, when this surface listed what the SOFTWARE can do rather
   * than what THIS business asked for: *"I'm not a bookkeeping company, for fuck's sake."* A
   * declared need inherits that rule — it is drawn from the wedges this project runs, so a physio's
   * appointment question never reaches a design studio.
   */
  _resetAuthored();
  const { app } = await makeFreshApp();
  const p = (await api(app, "me")).json.projects[0].id as string;
  const theirs = freshProjectId("other");
  const slug = authoredSlug("someone-elses-service");
  const row = draftRow(theirs, slug);
  (row.manifest as unknown as { capabilities: string[] }).capabilities = ["read_matters"];
  await getAuthoredStore().createDraft(row);
  await getAuthoredStore().decide(theirs, slug, "promoted", "founder");

  const caps = (await api(app, "capabilities", { headers: { "x-mycel-project": p } })).json as {
    items: { capability: string }[];
  };
  assert.ok(
    !caps.items.some((i) => i.capability === "read_matters"),
    "another tenant's declared need is being asked of this founder",
  );
});

// ═══════════════════════════ 9. WHAT THE FOUNDER READS ABOUT THEIR OWN SERVICE ═══════════════════════════
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A CORRECT DRAFT USED TO DESCRIBE ITS OWN NEED AS SOMETHING WE NO LONGER OFFER
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `reviewDraft` builds the "What it needs from you first" list on the screen where a founder first
// meets the service written for them. It had two branches: a known capability got its title, and
// anything else got `something called "X", which this kernel no longer offers`.
//
// That was right while `CAPABILITIES` was the whole vocabulary — an unrecognised name could only be
// one removed from the kernel between authoring and review. It became wrong the moment a service
// could declare a trade's own need: a physiotherapy practice's `read_appointments` would have been
// read back to its founder as something we NO LONGER OFFER, which is about the only sentence that
// could make a correct draft look broken.

test("A DECLARED NEED IS READ BACK PLAINLY, NOT AS A REMOVED CAPABILITY", () => {
  const slug = authoredSlug("physio-recalls");
  const manifest = goodManifest(slug) as Record<string, unknown>;
  manifest.capabilities = ["read_appointments", "send_email"];
  const review = reviewDraft({ slug, manifest: manifest as never, skills: [], knowledge: [], described_as: "physio" } as never);

  assert.ok(
    review.needs.includes("Read appointments"),
    `the declared need is not said plainly. Got: ${JSON.stringify(review.needs)}`,
  );
  assert.ok(
    !review.needs.some((n) => /no longer offers/.test(n)),
    "a correct draft still describes its own need as something we removed",
  );
  // The known one keeps its hand-written title — that is the half worth having.
  assert.ok(review.needs.some((n) => /email/i.test(n)), "the known capability lost its title");
});

test("a name that is neither known nor well-formed is still reported as gone", () => {
  /*
    The third case is real and still says so: a capability genuinely removed from the kernel between
    authoring and review must degrade to a readable line rather than crash the page, and must not be
    mistaken for a trade-specific declaration.
  */
  const slug = authoredSlug("stale");
  const manifest = goodManifest(slug) as Record<string, unknown>;
  manifest.capabilities = ["Read Appointments"];
  const review = reviewDraft({ slug, manifest: manifest as never, skills: [], knowledge: [], described_as: "x" } as never);
  assert.ok(
    review.needs.some((n) => /no longer offers/.test(n)),
    `a malformed capability name was read as a trade need. Got: ${JSON.stringify(review.needs)}`,
  );
});

// ═══════════════════════════ 10. A QUESTION THAT REACHES NO TOOL ═══════════════════════════
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// "WHICH PRACTICE MANAGEMENT SYSTEM DO YOU USE?" IS A TEXTAREA
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The founder types "Cliniko" and nothing connects to Cliniko. The answer is stored as prose, the
// service still has no way into the system it was written for, and both sides believe setup is done.
//
// STRIPPED, NOT REFUSED — and the placement was measured, not chosen. It was a blocking fault first.
// Authoring four real trades against the live model with that fault in place:
//
//     physio       REFUSED   "Which practice management system do you use?"
//     immigration  shippable
//     cleaning     shippable
//     dental       REFUSED   "Which practice management system do you use?"
//
// Two of four, and both of them mainstream. A fault becomes `service.draft_refused` with no retry
// behind it, so the founder's outcome was "we could not write your service". A guard that turns half
// of ordinary trades away is worse than the question it prevents.
//
// Dropping it loses nothing real: the answer reached no tool either way. The capability is where the
// need belongs, and the notice says so.

test("A SETUP QUESTION THAT ASKS THE FOUNDER TO NAME A PRODUCT IS REMOVED, NOT REFUSED", () => {
  const slug = authoredSlug("physio-recalls");
  const manifest = goodManifest(slug) as Record<string, unknown>;
  manifest.intake = [
    { id: "which-system", ask: "Which practice management system do you use?" },
    { id: "recall", ask: "What is the standard recall interval for patients?" },
  ];
  const notices: { message: string }[] = [];
  repairAuthoredManifest(manifest, notices as never);

  const asks = (manifest.intake as { ask: string }[]).map((q) => q.ask);
  assert.deepEqual(asks, ["What is the standard recall interval for patients?"], "the dead-end question survived");

  // THE DRAFT STILL SHIPS. This is the whole reason it is a repair: a fault here refused two of four
  // real trades, and a refusal is the end of that founder's visit.
  assert.deepEqual(authoredFaults(slug, manifest).map((f) => f.message), [], "the draft is still refused");

  // And the founder is told why a question vanished, with the way out named.
  const told = notices.find((n) => /connects to nothing/.test(n.message));
  assert.ok(told, `no notice explained the removal. Got: ${JSON.stringify(notices)}`);
  assert.match(told!.message, /capability/, "the notice does not say what to do instead");
});

test("the questions worth asking are untouched", () => {
  /**
   * NARROW ON PURPOSE. This matches the IDENTITY question — a system-ish noun AND "... do you use" —
   * not any sentence containing the word "system". A service's real intake is trade knowledge with
   * prose answers, and stripping those would take away the questions that make a deliverable good.
   */
  const slug = authoredSlug("physio-recalls");
  const manifest = goodManifest(slug) as Record<string, unknown>;
  const real = [
    { id: "recall", ask: "What is the standard recall interval for patients?" },
    { id: "policy", ask: "What is your booking system's cancellation policy?" },
    { id: "insurers", ask: "Which insurers do you work with?" },
    { id: "rate", ask: "What do you charge, and what sits outside the monthly fee?" },
  ];
  manifest.intake = [...real];
  repairAuthoredManifest(manifest, [] as never);
  assert.deepEqual(manifest.intake, real, "a real trade question was stripped as a dead end");
});

test("every spelling of the identity question is caught", () => {
  // Four phrasings, all observed from the real author across four trades.
  for (const ask of [
    "Which practice management system do you use?",
    "What case management system do you use?",
    "What practice management software do you use?",
    "Which scheduling tool are you using?",
  ]) {
    const slug = authoredSlug("identity-question");
    const manifest = goodManifest(slug) as Record<string, unknown>;
    manifest.intake = [{ id: "which-system", ask }];
    repairAuthoredManifest(manifest, [] as never);
    assert.deepEqual((manifest.intake as unknown[]), [], `not stripped: ${ask}`);
  }
});
