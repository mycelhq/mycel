/**
 * ═══ THE RUN READS ITS OWN WORK WITH THE REVIEWER'S INSTRUMENT ═══
 *
 * `mycel-check` exists so a deliverable is refused BEFORE the run says it is finished, rather than
 * after — a comparable runtime's `validate_slide` pattern, where the artifact skill ships the checker alongside the
 * generator and the agent is handed the same instrument the reviewer will use.
 *
 * The whole value of it rests on one property: it must agree with the submit gate. A self-check
 * that goes green on something `slopFault` then refuses is worse than no tool, because it teaches
 * the agent its instrument lies and the next real finding gets ignored with it. That is not a
 * hypothetical here — `deliverables.routes.ts` records three separate occasions where two gates
 * disagreeing about one message cost a day of sending each.
 *
 * So the first test is not "the endpoint works". It is "the endpoint and the gate return the same
 * verdict on the same bytes."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { registerGrant, revokeGrant } from "../src/proxygrants";
import { lintArtifact } from "../src/design-lint";
import { checkToolDoc, checkToolScript, CHECK_TOOL_PATH } from "../src/checktool";

/** A document carrying the tells `craft/anti-ai-slop.md` names. */
const SLOPPY = `<!doctype html><html><head><style>
  .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
  a { color: #6366f1; }
</style></head><body>
  <div class="hero"><h1>Results</h1></div>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
</body></html>`;

const CLEAN = `<!doctype html><html><head><style>
  body { font-family: Georgia, serif; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; } td, th { border-bottom: 1px solid #ddd; padding: 8px; }
</style></head><body>
  <h1>Fairmont Dental Group</h1>
  <p>Three of the four practices were checked this week.</p>
  <table><tr><th>Practice</th><th>Reading</th></tr><tr><td>Didsbury</td><td>Cited twice</td></tr></table>
</body></html>`;

async function check(app: ReturnType<typeof makeApp>["app"], nonce: string, html: string, name = "report.html") {
  return api(app, "internal/check", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ html, name }),
  });
}

test("mycel-check returns exactly what the submit gate would refuse", async () => {
  const { app } = makeApp();
  const nonce = await registerGrant({
    base_url: "http://127.0.0.1:1/v1", api_key: "k", model: "m", task_id: "no-such-task",
  });
  try {
    const res = await check(app, nonce, SLOPPY);
    assert.equal(res.status, 200);

    // The gate's own verdict on the same bytes. Not a hardcoded list: a rule added kernel-side must
    // appear in both or this fails, which is the drift the tool exists to be immune to.
    const gate = lintArtifact(SLOPPY).filter((f) => f.severity === "P0").map((f) => f.id).sort();
    assert.ok(gate.length > 0, "the fixture stopped tripping any P0 rule — it no longer tests anything");

    const got = (res.json.findings as Array<{ id: string }>).map((f) => f.id).sort();
    assert.deepEqual(got, gate, "the self-check and the submit gate disagree about the same file");

    // Every finding must carry a fix. A refusal the agent cannot act on is a loop.
    for (const f of res.json.findings as Array<{ fix?: string }>) {
      assert.ok(f.fix && f.fix.length > 4, "a finding with no fix leaves the retry nowhere to go");
    }
  } finally {
    await revokeGrant(nonce);
  }
});

test("a clean document comes back clean", async () => {
  const { app } = makeApp();
  const nonce = await registerGrant({
    base_url: "http://127.0.0.1:1/v1", api_key: "k", model: "m", task_id: "no-such-task",
  });
  try {
    const res = await check(app, nonce, CLEAN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.findings, [], "a clean file reported findings — the tool cries wolf");
    assert.equal(res.json.checked, "report.html");
  } finally {
    await revokeGrant(nonce);
  }
});

test("findings the submit does not block on are not reported as rejections", async () => {
  /**
   * The tool's credibility rests on every finding being a real rejection. `slopFault` blocks on P0
   * and deliberately not on P1/P2 — "judgement calls (contrast ratios, motion durations) where a
   * confident refusal would be wrong often enough to cost more than it saves". A self-check that
   * reports those as failures is a tool that cries wolf, and an agent that learns to override it
   * once will override it on the finding that mattered.
   *
   * This fixture trips a P2 (an untagged <section>) and no P0. It must come back clean.
   */
  const p2Only = `<!doctype html><html><head><style>body{font-family:Georgia,serif;color:#1a1a1a}</style></head>
    <body><section><h1>Fairmont Dental Group</h1><p>Three practices were checked.</p></section></body></html>`;
  const raw = lintArtifact(p2Only);
  assert.ok(raw.some((f) => f.severity !== "P0"), "the fixture trips no soft finding — it no longer tests anything");
  assert.ok(!raw.some((f) => f.severity === "P0"), "the fixture trips a P0 — it cannot isolate the filter");

  const { app } = makeApp();
  const nonce = await registerGrant({
    base_url: "http://127.0.0.1:1/v1", api_key: "k", model: "m", task_id: "no-such-task",
  });
  try {
    const res = await check(app, nonce, p2Only);
    assert.deepEqual(res.json.findings, [], "a finding the submit gate ignores was reported as a rejection");
  } finally {
    await revokeGrant(nonce);
  }
});

test("without the run's own nonce it answers nothing", async () => {
  const { app } = makeApp();
  const res = await check(app, "not-a-real-nonce", CLEAN);
  assert.equal(res.status, 401, "the check answered a caller holding no grant");
});

test("an empty body is an error, never a pass", async () => {
  const { app } = makeApp();
  const nonce = await registerGrant({
    base_url: "http://127.0.0.1:1/v1", api_key: "k", model: "m", task_id: "no-such-task",
  });
  try {
    const res = await check(app, nonce, "");
    // The dangerous answer here is 200 with an empty findings list: a run whose file failed to read
    // would be told it passed.
    assert.equal(res.status, 400, "an unreadable file was reported as clean");
  } finally {
    await revokeGrant(nonce);
  }
});

test("the script names the endpoint and the file, and fails loudly on no answer", () => {
  const s = checkToolScript("https://kernel.example/v1/internal", "NONCE123");
  assert.match(s, /^#!\/usr\/bin\/env bash/, "not executable as written");
  assert.ok(s.includes("https://kernel.example/v1/internal/check"), "the script posts somewhere else");
  assert.ok(s.includes("Bearer NONCE123"), "the script carries no credential");
  // The failure that matters: silence read as success. An agent that gets no answer and exits 0
  // submits unchecked believing it was checked.
  assert.match(s, /Do not treat that as a pass/, "a silent kernel would look like a clean file");
  assert.equal(CHECK_TOOL_PATH, "/usr/local/bin/mycel-check");
});

test("the doc says these are the submit rules, not a style opinion", () => {
  const withShape = checkToolDoc(true).join("\n");
  const without = checkToolDoc(false).join("\n");
  assert.match(withShape, /refuse a deliverable at submit/i, "the doc reads as advisory");
  assert.match(withShape, /sections/i, "a run with a declared shape is not told the shape is checked");
  assert.ok(!/sections the shape/i.test(without), "a run with no shape is told its sections are checked");
  // Both must carry the "did not run is not a pass" rule: the absent-tool case is the one where an
  // agent silently skips the check and reports success.
  for (const d of [withShape, without]) assert.match(d, /did not run is not a pass/i);
});

test("the shape's sections are checked, and the answer key comes from the manifest", async () => {
  /**
   * The half that makes this more than a slop linter: the run is told which sections its trade's
   * format calls for and which its file is missing, while it can still cheaply add them.
   *
   * The expected list is resolved from the grant's `task_id` → task → wedge → task type. The agent
   * sends the HTML and nothing else, deliberately — a check whose answer key is supplied by the
   * subject is not a check, and the shape file is sitting mounted in the sandbox where a run could
   * read it and send back only the headings it happened to write.
   */
  const { store, app } = makeApp();
  const task = await store.createTask({
    id: "shape-check-1", project_id: "p1", wedge: "geo-monitor", task_type: "weekly_report",
    actor: { kind: "system", id: "test" }, input: {},
    constraints: { max_runtime_s: 600, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as never);
  const nonce = await registerGrant({
    base_url: "http://127.0.0.1:1/v1", api_key: "k", model: "m", task_id: task.id,
  });
  try {
    // Clean by the slop rules and missing every section the GEO shape names.
    const res = await check(app, nonce, CLEAN);
    assert.equal(res.status, 200);
    const missing = (res.json.findings as Array<{ id: string; message: string }>)
      .filter((f) => f.id === "shape-section-missing");
    assert.ok(missing.length >= 4, `the declared shape was never consulted (got ${missing.length} section findings)`);
    // The message must name the section, or the run cannot tell which one to add.
    assert.match(missing.map((f) => f.message).join(" "), /scorecard/i, "a finding that does not name its section");
    // And every one carries the obligation from the manifest, not a generic "add a section".
    for (const f of res.json.findings as Array<{ id: string; fix: string }>) {
      if (f.id === "shape-section-missing") assert.ok(f.fix.length > 20, "the fix does not say what goes in the section");
    }

    // A file that DOES carry the headings must not be flagged. This is the false-positive half:
    // a tool that reports a section as missing when it is present is one an agent learns to ignore.
    const withSections = CLEAN.replace(
      "<h1>Fairmont Dental Group</h1>",
      "<h1>Fairmont Dental Group</h1>" +
        ["Where you stand this week", "The scorecard", "Do this first", "Then this",
         "And plan for this", "What happens next week"].map((h) => `<h2>${h}</h2>`).join(""),
    );
    const clean = await check(app, nonce, withSections);
    assert.deepEqual(
      (clean.json.findings as Array<{ id: string }>).filter((f) => f.id === "shape-section-missing"),
      [],
      "a file carrying every declared section was still told sections were missing",
    );
  } finally {
    await revokeGrant(nonce);
  }
});

test("a task the shape cannot be resolved for still gets the slop rules", async () => {
  // The lookup is wrapped so a missing task, an unloadable wedge or a malformed shape can never
  // turn a dirty file into a clean verdict. The blocking half must survive the optional half.
  const { app } = makeApp();
  const nonce = await registerGrant({
    base_url: "http://127.0.0.1:1/v1", api_key: "k", model: "m", task_id: "vanished",
  });
  try {
    const res = await check(app, nonce, SLOPPY);
    assert.equal(res.status, 200);
    const p0 = lintArtifact(SLOPPY).filter((f) => f.severity === "P0").length;
    assert.equal((res.json.findings as unknown[]).length, p0, "an unresolvable shape swallowed the slop findings");
  } finally {
    await revokeGrant(nonce);
  }
});
