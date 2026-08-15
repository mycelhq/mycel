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
import { authorWedgeFromOutput, authoredFaults, repairAuthoredManifest, reviewDraft, AUTHOR_LIMITS } from "../src/wedgeauthor";
import { buildWedgeRoleIndex, manifestFaults } from "../src/roles";
import { HARD_MAX_PER_DAY, HARD_MAX_PER_SWEEP } from "../src/autonomy";
import { api, freshProjectId, makeFreshApp, waitTask } from "./helpers";

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
  };
}

const goodOutput = (name = "Proposals and sign-off") => ({
  slug: name,
  manifest: goodManifest("ignored — overwritten by the caller's slug"),
  skills: [{ name: "write-a-scope", content: "# Writing a scope\n\nStart from the deliverable." }],
});

function draftRow(projectId: string, slug: string): NewAuthoredWedge {
  return {
    project_id: projectId,
    slug,
    title: "Proposals and sign-off",
    manifest: goodManifest(slug) as unknown as WedgeManifest,
    skills: [{ name: "write-a-scope.md", content: "# Writing a scope" }],
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
  // THE BUG: model output becomes a running service with nobody in the loop. `improvement.ts` is the
  // precedent and the stake here is higher — a promoted service is one a client eventually hears
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
  assert.match(messagesFor({ policy: { auto_approve: [{ action: "email.send" }] } }), /act without asking/);
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

test("a file name from a model cannot become a path", () => {
  // THE BUG: skill names are joined onto a path when the sandbox is filled, and a name is not a
  // place. Normalised rather than refused, because a wrong extension is no reason to throw away a
  // correct procedure.
  const r = authorWedgeFromOutput(
    { ...goodOutput(), skills: [{ name: "../../etc/passwd", content: "x" }] },
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
  // whole services page down for that tenant. `authoredFaults` has already refused unknown
  // capabilities at authoring, so this can only happen to stored history — and history must degrade
  // into a sentence rather than a 500.
  const card = reviewDraft({
    slug: authoredSlug("old"),
    manifest: { wedge: authoredSlug("old"), title: "Old", capabilities: ["read_carrier_pigeons"] },
    skills: [],
    knowledge: [],
  });
  assert.match(card.needs[0], /no longer offers/);
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
