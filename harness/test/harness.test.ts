import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHarnessProfile, profileConstraintDefaults, SHAPE_DEFAULTS } from "../src/harness";
import { buildOpencodeConfig } from "../src/opencode";
import { buildAgentsMdForTest, buildPromptForTest } from "../src/runtime";
import { loadWedge, type LoadedWedge } from "../src/wedge";
import type { Task } from "../src/contract";

/**
 * Harness profiles: the harness, engineered per task type.
 *
 * These assert the two things that make the split worth having — that a profile REQUESTS and the
 * plan/ceilings DECIDE, and that a build run cannot hold a credential — plus the plumbing that
 * carries a profile into the config and the prompt.
 */

const CEILINGS = { maxRuntimeS: 1800, maxCostUsd: 50 };

function taskOf(wedge: string, task_type: string, input: Record<string, unknown> = {}): Task {
  return {
    id: "t1",
    wedge,
    task_type,
    actor: { kind: "system", id: "s" },
    input,
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "queued",
    cost_usd: 0,
    created_at: "",
    updated_at: "",
  } as Task;
}

/** A wedge shaped like a loaded one, without touching the filesystem. */
function fakeWedge(manifest: Record<string, unknown>): LoadedWedge {
  return { manifest: manifest as never, dir: "/tmp", skills: [], knowledge: [] };
}

/**
 * Does this permission map leave `tool` switched on for the model?
 *
 * Asserting on individual keys was how these tests used to read, and it tested the wrong thing: a
 * profile can deny `edit` by naming it or by denying `"*"` and not allowing it, and a test that
 * greps for `permission.edit === "deny"` passes or fails on spelling rather than on whether the
 * agent can write a file.
 *
 * This mirrors the resolution rules VERIFIED against the real opencode 1.17.6 binary by running
 * `opencode debug agent build` over each shape of config and reading back the toolset it hands the
 * model:
 *   · a tool named explicitly wins over `"*"`; absent both, the default is allow;
 *   · `write` is not a permission key — writing is governed by `edit` (denying `edit` removes the
 *     `edit` AND `write` tools; denying `write` alone removes nothing);
 *   · a pattern map leaves the tool ON unless its own `"*"` is `deny`, which removes the tool
 *     entirely rather than filtering commands.
 */
function toolEnabled(permission: Record<string, unknown>, tool: string): boolean {
  const key = tool === "write" ? "edit" : tool;
  const rule = permission[key] ?? permission["*"] ?? "allow";
  if (typeof rule === "string") return rule !== "deny";
  if (rule && typeof rule === "object") return (rule as Record<string, string>)["*"] !== "deny";
  return true;
}

// ---------------------------------------------------------------------------------------------
// Resolution and defaulting
// ---------------------------------------------------------------------------------------------

test("harness: a task type with no harness block gets the permissive default, unchanged", () => {
  // Introducing profiles must not have silently retightened every existing wedge. A manifest that
  // says nothing gets exactly what it got before: allow-by-default with the catastrophes denied,
  // the standard tier, and the action token.
  const profile = resolveHarnessProfile({
    task: taskOf("x", "anything"),
    wedge: fakeWedge({ wedge: "x", task_types: { anything: {} } }),
    ceilings: CEILINGS,
  });
  assert.equal(profile.shape, "general");
  assert.equal(profile.tier, "standard");
  assert.equal(profile.grants_actions, true);
  assert.equal(profile.strict_output, false);
  assert.equal(profile.permission["*"], "allow");
});

test("harness: narrowest declaration wins — task_type over wedge over shape default", () => {
  const profile = resolveHarnessProfile({
    task: taskOf("x", "decide_it"),
    wedge: fakeWedge({
      wedge: "x",
      harness: { shape: "decide", max_cost_usd: 0.25, steps: 10 },
      task_types: { decide_it: { harness: { steps: 55, permission: { websearch: "allow" } } } },
    }),
    ceilings: CEILINGS,
  });
  assert.equal(profile.shape, "decide", "the wedge-level shape applies to a task type that omits one");
  assert.equal(profile.max_cost_usd, 0.25, "the wedge-level budget survives");
  assert.equal(profile.steps, 55, "the task type overrides the wedge");
  assert.equal(profile.permission.websearch, "allow", "a task type may reopen a tool the shape closed");
  assert.equal(toolEnabled(profile.permission, "edit"), false, "…without discarding the shape's denies");
});

test("harness: a manifest is JSON and can say anything, so nothing is trusted", () => {
  // Every field here is either the wrong type, out of range, or meaningless. None of it may reach
  // opencode: a malformed `permission` block is a sandbox that never becomes ready, which surfaces
  // sixty seconds later as "opencode failed to start" with the cause inside a dying container.
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({
      wedge: "x",
      task_types: {
        t: {
          harness: {
            shape: "godmode",
            tier: "unlimited",
            max_runtime_s: "forever",
            max_cost_usd: -5,
            temperature: 99,
            steps: 0,
            permission: { bash: "maybe", edit: { "*": "sometimes" }, read: "deny" },
            tools: { edit: "no", write: false },
            instructions: [1, "extra.md"],
          },
        },
      },
    }),
    ceilings: CEILINGS,
  });
  assert.equal(profile.shape, "general", "an unknown shape falls back, it does not crash");
  assert.equal(profile.tier, "standard", "an unknown tier falls back to standard, not to the priciest");
  assert.equal(profile.max_cost_usd, SHAPE_DEFAULTS.general.max_cost_usd);
  assert.equal(profile.temperature, undefined, "a temperature of 99 would fail the provider call");
  assert.equal(profile.permission.read, "deny", "the one valid rule survives…");
  assert.equal(profile.permission.bash !== "maybe", true, "…and the invalid ones are dropped");
  assert.deepEqual(profile.tools, { write: false }, "non-boolean tool entries are dropped");
  assert.deepEqual(profile.instructions, ["AGENTS.md", "extra.md"], "AGENTS.md is always first");
});

test("harness: budgets are clamped by the server ceilings, never raised by a manifest", () => {
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({
      wedge: "x",
      task_types: { t: { harness: { shape: "build", max_runtime_s: 86400, max_cost_usd: 1e6 } } },
    }),
    ceilings: { maxRuntimeS: 900, maxCostUsd: 3 },
  });
  assert.equal(profile.max_runtime_s, 900);
  assert.equal(profile.max_cost_usd, 3);
});

test("harness: the default runtime is profile-dependent, and longer than the old flat 300s", () => {
  // A live run spent 165k tokens and was killed mid-think because every task defaulted to five
  // minutes. Scaffolding an app is not a five-minute job; a dunning decision is.
  const build = profileConstraintDefaults(
    fakeWedge({ wedge: "x", task_types: { t: { harness: { shape: "build" } } } }),
    "t",
    CEILINGS,
  );
  const decide = profileConstraintDefaults(
    fakeWedge({ wedge: "x", task_types: { t: { harness: { shape: "decide" } } } }),
    "t",
    CEILINGS,
  );
  assert.ok(build.max_runtime_s > 300, `build got ${build.max_runtime_s}s`);
  assert.ok(build.max_runtime_s > decide.max_runtime_s, "a build gets longer than a decision");
  assert.ok(build.max_cost_usd > decide.max_cost_usd, "and a bigger budget");

  // Still clamped: MYCEL_MAX_RUNTIME_S is the ceiling, not a suggestion.
  const clamped = profileConstraintDefaults(
    fakeWedge({ wedge: "x", task_types: { t: { harness: { shape: "build" } } } }),
    "t",
    { maxRuntimeS: 120, maxCostUsd: 50 },
  );
  assert.equal(clamped.max_runtime_s, 120);
});

// ---------------------------------------------------------------------------------------------
// The plan decides the tier
// ---------------------------------------------------------------------------------------------

test("harness: a profile requests a tier, the plan decides it", () => {
  const wedge = fakeWedge({ wedge: "x", task_types: { t: { harness: { shape: "build" } } } });

  // Build asks for `deep`. A free org gets `standard` — clamped down, not refused, and reported.
  const free = resolveHarnessProfile({ task: taskOf("x", "t"), wedge, plan: "free", ceilings: CEILINGS });
  assert.equal(free.requested_tier, "deep");
  assert.equal(free.tier, "standard");
  assert.equal(free.tier_clamped, true);

  const starter = resolveHarnessProfile({ task: taskOf("x", "t"), wedge, plan: "starter", ceilings: CEILINGS });
  assert.equal(starter.tier, "standard");
  assert.equal(starter.tier_clamped, true);

  const growth = resolveHarnessProfile({ task: taskOf("x", "t"), wedge, plan: "growth", ceilings: CEILINGS });
  assert.equal(growth.tier, "deep");
  assert.equal(growth.tier_clamped, false);
});

test("harness: the task's own tier still wins over the profile, and is still clamped", () => {
  const wedge = fakeWedge({ wedge: "x", task_types: { t: { harness: { shape: "decide" } } } });
  // An operator debugging a specific run asks for deep on a decide task type…
  const asked = resolveHarnessProfile({
    task: taskOf("x", "t", { tier: "deep" }),
    wedge,
    plan: "growth",
    ceilings: CEILINGS,
  });
  assert.equal(asked.tier, "deep");
  // …and the plan ceiling is not bypassed by asking through a different door.
  const denied = resolveHarnessProfile({
    task: taskOf("x", "t", { tier: "deep" }),
    wedge,
    plan: "free",
    ceilings: CEILINGS,
  });
  assert.equal(denied.tier, "standard");
});

test("harness: the shorter `task_types.<t>.tier` spelling still works", () => {
  // Existing wedges use it. Breaking them to gain a nesting level would be a poor trade.
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({ wedge: "x", task_types: { t: { tier: "deep" } } }),
    plan: "growth",
    ceilings: CEILINGS,
  });
  assert.equal(profile.tier, "deep");
});

// ---------------------------------------------------------------------------------------------
// The least-privilege split — the reason this exists
// ---------------------------------------------------------------------------------------------

test("harness: a build profile never holds the action token, even if the manifest asks", () => {
  // This is the load-bearing assertion in the file. A build edits the founder's source tree; it has
  // no business emailing their customers. `actions: true` on a build shape is overruled rather than
  // merged, because "this run edits my code" and "this run may act as me" must not both be true.
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({
      wedge: "x",
      connections: ["billing-email", "stripe"],
      task_types: { t: { harness: { shape: "build", actions: true } } },
    }),
    ceilings: CEILINGS,
  });
  assert.equal(profile.grants_actions, false);

  // And the instructions say so plainly, rather than leaving the agent to discover it via 401s.
  const md = buildAgentsMdForTest(taskOf("x", "t"), null, [], profile);
  assert.ok(!md.includes("MYCEL_ACTION_TOKEN"), "no action-token curl recipes");
  assert.ok(!md.includes("$MYCEL_ACTIONS_URL"), "no action proxy section");
  assert.ok(!md.includes("$MYCEL_GAPS_URL"), "no knowledge-gap section it cannot reach");
  assert.match(md, /NO access to this business's email/);
});

test("harness: a decide profile keeps the action proxy and loses the filesystem", () => {
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({ wedge: "x", task_types: { t: { harness: { shape: "decide" } } } }),
    ceilings: CEILINGS,
  });
  assert.equal(profile.grants_actions, true, "a decision's whole job may be to send one message");

  // Denied by default, so this holds for tools that do not exist yet as well as the ones that do.
  assert.equal(profile.permission["*"], "deny");
  assert.equal(toolEnabled(profile.permission, "edit"), false);
  assert.equal(toolEnabled(profile.permission, "write"), false);
  assert.equal(toolEnabled(profile.permission, "task"), false, "no subagents to supervise");
  assert.equal(toolEnabled(profile.permission, "webfetch"), false, "not decided from the open web");
  assert.equal(toolEnabled(profile.permission, "websearch"), false);
  assert.equal(toolEnabled(profile.permission, "external_directory"), false);
  assert.equal(toolEnabled(profile.permission, "some_tool_opencode_adds_in_2027"), false);

  // …while the six a decision genuinely uses stay on.
  for (const tool of ["read", "grep", "glob", "list", "skill", "todowrite"]) {
    assert.equal(toolEnabled(profile.permission, tool), true, `${tool} must stay available`);
  }

  /**
   * The shell stays open, and that is deliberate rather than an oversight: the action proxy, the
   * reads proxy, the case API and the gap API are all taught to the agent as `curl` commands, so
   * removing bash removes the agent's entire control plane.
   *
   * It also could not be narrowed even if we wanted to. Verified against the real opencode 1.17.6
   * binary with `opencode debug agent build`: a bash rule map whose `"*"` is `deny` does not filter
   * commands, it REMOVES the bash tool from the model's toolset. `{"curl *":"allow","*":"deny"}`
   * is simply "no shell". Pattern rules carve holes out of an allow default; they cannot build an
   * allowlist.
   */
  const bash = profile.permission.bash as Record<string, string>;
  assert.equal(bash["*"], "allow");
  assert.equal(bash["rm -rf /"], "deny");
});

test("harness: the permission wildcard is pinned first, because last means an empty toolset", () => {
  /**
   * Verified against the real opencode 1.17.6 binary with `opencode debug agent build`:
   *
   *   {"*": "deny", "read": "allow"}  →  the model gets `read`
   *   {"read": "allow", "*": "deny"}  →  the model gets NOTHING
   *
   * Same two rules, opposite order, and the second is not an error — it is an agent with no tools,
   * which presents as a model that mysteriously narrates instead of working. Since this object is
   * assembled by spreading founder JSON over our defaults, and JS spread keeps a key at the index
   * of its FIRST appearance, a wedge that introduces `"*"` to a shape without one would append it.
   */
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({
      wedge: "x",
      task_types: {
        t: { harness: { shape: "build", permission: { read: "allow", grep: "allow", "*": "deny" } } },
      },
    }),
    ceilings: CEILINGS,
  });
  assert.equal(Object.keys(profile.permission)[0], "*", "the wildcard must lead, whatever order it arrived in");
  assert.equal(toolEnabled(profile.permission, "read"), true, "…and the allows it precedes still bite");
  assert.equal(toolEnabled(profile.permission, "webfetch"), false);
});

test("harness: `needs_connections` is honoured as the spelling for withholding credentials", () => {
  // The design doc's name for the switch. A founder reaching for it and silently getting the
  // default would be the worst possible failure on the one field that governs credentials.
  const off = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({ wedge: "x", task_types: { t: { harness: { needs_connections: false } } } }),
    ceilings: CEILINGS,
  });
  assert.equal(off.grants_actions, false, "a general-shape task type may still refuse the token");

  const on = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({
      wedge: "x",
      // A build asking for connections by either spelling is still refused — the shape decides.
      task_types: { t: { harness: { shape: "build", needs_connections: true } } },
    }),
    ceilings: CEILINGS,
  });
  assert.equal(on.grants_actions, false);
});

// ---------------------------------------------------------------------------------------------
// The profile actually reaches opencode
// ---------------------------------------------------------------------------------------------

test("harness: the opencode config genuinely differs by task type", () => {
  const wedge = fakeWedge({
    wedge: "x",
    task_types: {
      chase: { harness: { shape: "decide" } },
      ship: { harness: { shape: "build" } },
    },
  });
  const decide = resolveHarnessProfile({ task: taskOf("x", "chase"), wedge, ceilings: CEILINGS });
  const build = resolveHarnessProfile({ task: taskOf("x", "ship"), wedge, ceilings: CEILINGS });

  const a = buildOpencodeConfig("openai/gpt-5-nano", undefined, decide).config;
  const b = buildOpencodeConfig("openai/gpt-5.6-terra", undefined, build).config;

  assert.notDeepEqual(a, b, "one config for every task was the whole problem");

  // Permissions: the decide run cannot write a file; the build run must be able to.
  assert.equal(toolEnabled(a.permission as Record<string, unknown>, "edit"), false);
  assert.equal(toolEnabled(b.permission as Record<string, unknown>, "edit"), true);

  // Snapshots are pure overhead for a run that edits nothing.
  assert.equal(a.snapshot, false);
  assert.equal(b.snapshot, true);

  // Compaction on a four-minute decision means summarising away the invoice it was reasoning about.
  assert.deepEqual(a.compaction, { auto: false });
  assert.deepEqual(b.compaction, { auto: true });

  // Sampling: a dunning step should not be "gentle nudge" on Tuesday and "final notice" on Wednesday.
  assert.equal((a.agent as any).build.temperature, 0.1);
  assert.equal((b.agent as any).build.temperature, undefined);
  assert.ok((b.agent as any).build.steps > (a.agent as any).build.steps);

  // Tool output truncation is a per-turn token bill, and a decision reads three files.
  assert.ok((a.tool_output as any).max_lines < (b.tool_output as any).max_lines);
});

test("harness: proxy mode pins small_model, so side-work does not reach a provider that isn't there", () => {
  // `mycel` has exactly one model registered. With `small_model` unset, opencode's title/summary
  // calls fall back to its own default provider — which has no key inside the sandbox.
  const profile = resolveHarnessProfile({
    task: taskOf("x", "t"),
    wedge: fakeWedge({ wedge: "x", task_types: { t: {} } }),
    ceilings: CEILINGS,
  });
  const { config, providerEnv } = buildOpencodeConfig(
    "openai/gpt-5.6-luna",
    { proxyBaseUrl: "http://harness/v1/internal/llm", nonce: "n0nce", modelId: "gpt-5.6-luna" },
    profile,
  );
  assert.equal(config.model, "mycel/gpt-5.6-luna");
  assert.equal(config.small_model, "mycel/gpt-5.6-luna");
  assert.deepEqual(providerEnv, {}, "no real provider key enters the sandbox");
});

test("harness: the prompt differs by task type too", () => {
  const wedge = fakeWedge({
    wedge: "x",
    task_types: {
      chase: { harness: { shape: "decide" }, output_schema: { type: "object" } },
      ship: { harness: { shape: "build" }, description: "Add the pricing page." },
    },
  });
  const decide = resolveHarnessProfile({ task: taskOf("x", "chase"), wedge, ceilings: CEILINGS });
  const build = resolveHarnessProfile({ task: taskOf("x", "ship"), wedge, ceilings: CEILINGS });

  const pDecide = buildPromptForTest(taskOf("x", "chase"), wedge, decide);
  const pBuild = buildPromptForTest(taskOf("x", "ship"), wedge, build);
  assert.notEqual(pDecide, pBuild);

  // The schema is inlined even under strict output. This asserted the OPPOSITE, on the belief that
  // opencode's `format: json_schema` already constrained the model, so a decide run was ordered to
  // emit nothing but JSON and never shown the shape — the gap that made those runs unfinishable.
  // The belief was doubly wrong: 1.17.6 DOES honour `format`, and honouring it is what gave
  // production a 0% shaping success rate, so the harness no longer sends it at all and this prose
  // schema is the only statement of the contract the model ever sees. See opencode.ts startPrompt.
  assert.ok(pDecide.includes("conforming to this schema"), "the schema is shown, not assumed");
  assert.match(pDecide, /must be ONLY the JSON result/);
  assert.match(pBuild, /verify it actually runs|check it works/);
  assert.ok(!pBuild.includes("must be ONLY the JSON result"), "a build's deliverable is a repo");

  // And the instructions file diverges too.
  const mdDecide = buildAgentsMdForTest(taskOf("x", "chase"), wedge, [], decide);
  const mdBuild = buildAgentsMdForTest(taskOf("x", "ship"), wedge, [], build);
  assert.notEqual(mdDecide, mdBuild);
  assert.match(mdDecide, /DECISION task/);
  assert.match(mdBuild, /BUILD task/);
});

test("harness: every run is told how to answer self-harm", () => {
  const md = buildAgentsMdForTest(taskOf("x", "t"), null, []);
  assert.match(md, /988/);
  assert.match(md, /refuse to help with methods/i);
});

test("harness: a task type may narrow which of the wedge's procedures it sees", () => {
  // An index line for a procedure this run must not use is an invitation to use it.
  const wedge: LoadedWedge = {
    manifest: {
      wedge: "x",
      task_types: { t: { harness: { shape: "decide", skills: ["chase-politely"] } } },
    } as never,
    dir: "/tmp",
    knowledge: [],
    skills: [
      { name: "chase-politely.md", content: "---\ndescription: how we chase\n---\nbody" },
      { name: "file-sales-tax.md", content: "---\ndescription: how we file sales tax\n---\nbody" },
    ],
  };
  const profile = resolveHarnessProfile({ task: taskOf("x", "t"), wedge, ceilings: CEILINGS });
  const md = buildAgentsMdForTest(taskOf("x", "t"), wedge, [], profile);
  assert.ok(md.includes("skills/chase-politely.md"));
  assert.ok(!md.includes("skills/file-sales-tax.md"), "a task type only sees the procedures it needs");
});

// ---------------------------------------------------------------------------------------------
// The two profiles that ship
// ---------------------------------------------------------------------------------------------

test("harness: invoice-chaser's chase_invoice is a real decide profile on disk", () => {
  const wedge = loadWedge("invoice-chaser");
  assert.ok(wedge, "the wedge loads");
  const profile = resolveHarnessProfile({
    task: taskOf("invoice-chaser", "chase_invoice"),
    wedge,
    plan: "growth",
    ceilings: CEILINGS,
  });
  assert.equal(profile.shape, "decide");
  /**
   * `standard`, from the decide profile — the wedge no longer pins a tier of its own.
   *
   * It used to say `"tier": "fast"`, and "a dunning judgement does not need a frontier model" was a
   * reasonable-sounding thing to believe. Production disagreed twice. gpt-5-nano called `bash`
   * without the required `description` key eleven identical times and never converged; a later run
   * read the same policy file six times in four minutes and produced nothing before the ceiling
   * killed it. The task is not hard because the JUDGEMENT is hard — it is hard because it is
   * agentic, and nano cannot hold a tool schema across turns.
   *
   * A task-type tier is a REQUEST that outranks the shape profile, so this one line quietly beat
   * the `decide` profile's `standard` on every run. Removing it lets the profile decide and the
   * plan clamp, which is the layering the harness was designed around.
   */
  assert.equal(profile.tier, "standard", "an agentic decision needs a model that can hold a tool schema");
  assert.equal(profile.strict_output, true);
  assert.equal(profile.grants_actions, true, "it exists to send the chase");
  assert.equal(toolEnabled(profile.permission, "edit"), false);
  /**
   * THE BUDGET IS COUNTED IN COMPLETIONS, NOT IN MINUTES.
   *
   * This asserted `<= 300` — "a decision that hasn't landed in four minutes won't" — and that was a
   * sentence about a world where a model completion took ten seconds. It measures 85–95 seconds in
   * production (LiteLLM spend logs), so 300s is three completions and 180s is two. A week of real
   * `mycel:run` durations came back p50 175s, with four runs finishing at 180.1s, 180.2s, 180.6s and
   * 180.8s: the ceiling, to the tenth of a second, killed mid-answer. The test was defending the
   * number that was doing the killing.
   *
   * So the invariant is stated in the unit that actually governs it: a decide run must be able to
   * afford at least three completions, and must still be bounded well under the hour-long global
   * ceiling so a stuck run cannot sit on a founder's screen indefinitely.
   */
  const COMPLETION_S = 95;
  assert.ok(
    profile.max_runtime_s >= 3 * COMPLETION_S,
    `a decision gets at least three model completions; got ${profile.max_runtime_s}s`,
  );
  assert.ok(profile.max_runtime_s <= 900, `and is still bounded; got ${profile.max_runtime_s}s`);
});

test("harness: product-builder's build_feature is a real build profile on disk, with no credentials", () => {
  const wedge = loadWedge("product-builder");
  assert.ok(wedge, "the wedge loads");
  const profile = resolveHarnessProfile({
    task: taskOf("product-builder", "build_feature"),
    wedge,
    plan: "growth",
    ceilings: CEILINGS,
  });
  assert.equal(profile.shape, "build");
  assert.equal(profile.tier, "deep");
  assert.equal(profile.grants_actions, false, "a build has no business sending email");
  assert.equal(toolEnabled(profile.permission, "edit"), true);
  assert.equal(profile.strict_output, false);
  assert.ok(profile.max_runtime_s >= 900, "scaffolding an app is not a five-minute job");

  // The same wedge's OTHER task type is a decision, and gets a different harness entirely — which
  // is the point: the profile follows the work, not the service.
  const review = resolveHarnessProfile({
    task: taskOf("product-builder", "review_diff"),
    wedge,
    plan: "growth",
    ceilings: CEILINGS,
  });
  assert.equal(review.shape, "decide");
  assert.equal(toolEnabled(review.permission, "edit"), false);
  assert.notEqual(review.tier, profile.tier);
});

test("harness: draft_service may webfetch, because guessing a trade from two sentences is how a food studio gets a questionnaire desk", () => {
  const wedge = loadWedge("business-shaper");
  assert.ok(wedge);
  const profile = resolveHarnessProfile({
    task: taskOf("business-shaper", "draft_service"),
    wedge,
    ceilings: CEILINGS,
  });
  assert.equal(profile.shape, "decide");
  assert.equal(toolEnabled(profile.permission, "webfetch"), true, "the skill tells it to fetch their site");
  assert.equal(toolEnabled(profile.permission, "edit"), false);
});
