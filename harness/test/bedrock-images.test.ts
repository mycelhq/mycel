// IMAGE GENERATION ON THE BUSINESS'S OWN CREDITS, WITH NOTHING SECRET IN THE SANDBOX.
//
// Every other provider here is an API key that must be bought, stored, rotated, and then handed to
// an agent sandbox. Bedrock is reached with the task's IAM role and billed to credits the business
// already holds — and the reason to prefer it is not the money. An AWS credential inside a sandbox
// would reach S3, ECS and everything else that role can touch. A scoped provider key is merely bad;
// that would be worse than bad.
//
// So the tool posts to the KERNEL with the run's short-lived proxy nonce — the same mechanism
// `/v1/internal/llm` already uses for the model itself — and the kernel makes the AWS call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { imageProviderFromEnv, imageToolScript, imageToolDoc } from "../src/imagetool";
import { INACTIVE_LIMITS, PLAN_LIMITS, UNLIMITED_LIMITS } from "../src/identity";
import { ONLY_IN_MONOREPO, inMonorepo } from "./_monorepo";

const bedrockEnv = { MYCEL_IMAGE_BEDROCK_REGION: "eu-west-1" } as NodeJS.ProcessEnv;

test("a region turns it on, and no key is required", () => {
  const p = imageProviderFromEnv(bedrockEnv)!;
  assert.equal(p.kind, "bedrock");
  assert.equal(p.key, "", "a bedrock provider carries no provider credential at all");
  // NOT `amazon.nova-canvas-v1:0`, which AWS puts first and retires on 30 September 2026. Building
  // on it would have shipped something with an expiry date already printed on it.
  assert.equal(p.model, "stability.stable-image-ultra-v1:1");
  assert.doesNotMatch(p.model!, /nova-canvas/);
});

test("a key somebody went and bought beats the floor", () => {
  // Setting a provider key is an act: an operator decided this deployment should use that model and
  // paid for it. Bedrock is what runs when nobody has chosen — not a preference that overrules a
  // decision already made.
  assert.equal(imageProviderFromEnv({ ...bedrockEnv, FAL_KEY: "k" })!.kind, "fal");
  assert.equal(imageProviderFromEnv({ ...bedrockEnv, MYCEL_IMAGE_OPENAI_KEY: "k" })!.kind, "openai");
});

test("the OpenAI path defaults to the model that actually leads the boards", () => {
  // As of September 2026 GPT Image 2 leads blind-preference ranking by a margin those boards have
  // not seen before. `gpt-image-1` was a year-old default nobody had revisited.
  const p = imageProviderFromEnv({ MYCEL_IMAGE_OPENAI_KEY: "k" } as NodeJS.ProcessEnv)!;
  assert.equal(p.model, "gpt-image-2");
});

test("no region means no image tool, rather than one that 501s", () => {
  // Unsetting the region is how this is turned off cleanly: the tool is not installed and not
  // documented, and the agent composes without photography instead of burning a turn discovering
  // that a documented tool does not work.
  assert.equal(imageProviderFromEnv({} as NodeJS.ProcessEnv), undefined);
});

test("the sandbox script holds a nonce and a URL, never a credential — for ANY provider", () => {
  // This is the fix for a leak I introduced: pointing MYCEL_IMAGE_OPENAI_KEY at the org's existing
  // OpenAI secret put a live credential in every build sandbox, where an agent could read it,
  // spend outside LiteLLM's per-org budget, and walk past `images_per_month` by calling the API
  // itself. One script shape now, and it carries a nonce.
  for (const p of [
    { kind: "bedrock", key: "" },
    { kind: "openai", key: "sk-live-SECRET", model: "gpt-image-2" },
    { kind: "fal", key: "fal-live-SECRET" },
    { kind: "higgsfield", key: "hf-live-SECRET" },
  ] as const) {
    const script = imageToolScript(p);
    assert.ok(!script.includes("SECRET"), `${p.kind}: the provider key reached the sandbox script`);
    assert.ok(!script.includes("api.openai.com") && !script.includes("fal.run"),
      `${p.kind}: the sandbox can reach the provider directly`);
    assert.match(script, /MYCEL_IMAGE_URL/);
    assert.match(script, /authorization: Bearer \$MYCEL_IMAGE_KEY/);
  }
  const s = imageToolScript({ kind: "bedrock", key: "" });
  assert.match(s, /MYCEL_IMAGE_URL/);
  assert.match(s, /authorization: Bearer \$MYCEL_IMAGE_KEY/);
  for (const forbidden of ["AWS_ACCESS_KEY", "AWS_SECRET", "AWS_SESSION_TOKEN", "bedrock-runtime", "amazonaws.com"]) {
    assert.ok(!s.includes(forbidden), `the sandbox script must not contain ${forbidden}`);
  }
});

test("the runtime hands the sandbox a nonce, not a provider key", () => {
  const rt = readFileSync(new URL("../src/runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(rt, /env\.MYCEL_IMAGE_KEY = nonce \?\? ""/);
  assert.ok(!/env\.MYCEL_IMAGE_KEY = imageProvider\.key/.test(rt),
    "a provider credential must never be written into a sandbox environment");
});

test("the printenv audit fails closed on the image provider keys", () => {
  // Nothing needs one in a sandbox any more. The day one reappears is the day a run can spend
  // outside the per-org budget, so the audit should catch it rather than a bill.
  const sb = readFileSync(new URL("../src/sandbox.ts", import.meta.url).pathname, "utf8");
  for (const k of ["MYCEL_IMAGE_OPENAI_KEY", "FAL_KEY", "HIGGSFIELD_API_KEY"]) {
    assert.match(sb, new RegExp(`"${k}"`), `${k} is not on SANDBOX_FORBIDDEN_ENV`);
  }
});

test("the prompt goes through argv into node, never interpolated into a shell", () => {
  const s = imageToolScript({ kind: "bedrock", key: "" });
  // The same rule `verifyWorkspace` documents at length: Daytona hands our string to a shell we do
  // not control, and a quote in a founder's business description would close its wrapper.
  assert.match(s, /node -e '.*JSON\.stringify.*' "\$PROMPT"/);
  assert.doesNotMatch(s, /-d "\{.*\$PROMPT/, "the prompt must never be pasted into the JSON body");
});

test("a half-written image is never left where a page can reference it", () => {
  const s = imageToolScript({ kind: "bedrock", key: "" });
  assert.match(s, /TMP="\$\(mktemp\)"/);
  assert.match(s, /mv "\$TMP" "\$OUT"/, "it is moved into place only after it is whole");
  assert.match(s, /-lt 1024/, "and only if it is big enough to be an image");
});

test("the route authenticates, scopes the region, and never logs the prompt", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf('app.post("/v1/internal/image"');
  assert.ok(at > 0, "the image route is missing");
  const route = src.slice(at, at + 6500);
  assert.match(route, /invalid proxy token/, "an unauthenticated caller must not reach Bedrock");
  assert.match(route, /imageProviderFromEnv\(\)/, "the provider is resolved in the kernel, not the sandbox");
  assert.match(route, /not configured on this kernel/, "no provider answers honestly, not with a crash");
  // A founder's description of their business is not ours to write into a log line.
  assert.match(route, /never the prompt/i);
  assert.doesNotMatch(route.slice(route.indexOf("catch")), /\$\{prompt\}/);
});

test("Stability takes an aspect ratio, so the kernel maps pixels rather than the agent guessing", () => {
  const route = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.match(route, /aspect_ratio/);
  assert.match(route, /"16:9"/, "the ratios must be the ones the model accepts");
  assert.match(route, /output_format: "png"/);
  // The tool's interface stays in pixels because that is what somebody laying out a page thinks in.
  assert.match(route, /Math\.abs\(Math\.log/, "nearest ratio, not a lookup that misses");
});

test("a filtered generation is not read as a successful one", () => {
  // Stability answers 200 with `finish_reasons[0]` carrying the reason. Without the check, a
  // moderated request would be treated as a success and whatever came back written into a page.
  const route = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.match(route, /finish_reasons/);
  assert.match(route, /if \(parsed\.finish_reasons\?\.\[0\]\) return undefined;/);
});

test("the IAM grant is scoped to the image models, not to bedrock", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const tf = readFileSync(new URL("../../../infra/hosting.tf", import.meta.url).pathname, "utf8");
  assert.match(tf, /kernel_task_bedrock_images/);
  assert.match(tf, /"bedrock:InvokeModel"/);
  assert.match(tf, /foundation-model\/stability\.stable-image-ultra-v1:1/);
  assert.doesNotMatch(tf, /foundation-model\/amazon\.nova-canvas/, "Canvas is retired on 2026-09-30");
  // A wildcard would quietly grant every future Bedrock capability as AWS adds it.
  assert.doesNotMatch(tf.slice(tf.indexOf("kernel_task_bedrock_images")), /"bedrock:\*"/);
});

test("the doc still leads with the refusals, and names what it is driving", () => {
  const doc = imageToolDoc({ kind: "bedrock", key: "", model: "stability.stable-image-ultra-v1:1" }).join("\n");
  assert.ok(doc.indexOf("When NOT to use it") < doc.indexOf("Where it earns its place"));
  assert.match(doc, /stability\.stable-image-ultra-v1:1/);
});

// ── the margin control ──────────────────────────────────────────────────────────────────────────
//
// Text spend is bounded by LiteLLM, which holds the org's virtual key with a `max_budget` and
// refuses at the proxy. Image generation does not pass through LiteLLM at all — it is a Bedrock call
// the kernel makes with its own role — so it was bounded by NOTHING. An agent in a loop could have
// generated images until somebody read a bill.

test("every plan carries an image allowance, including the ones that get none", () => {
  for (const [plan, l] of Object.entries(PLAN_LIMITS) as [string, { images_per_month: number | null }][]) {
    assert.ok("images_per_month" in l, `${plan} has no image ceiling at all`);
  }
  // A generated image costs real money on somebody who has not paid one.
  assert.equal(PLAN_LIMITS.free.images_per_month, 0);
  assert.equal(INACTIVE_LIMITS.images_per_month, 0, "a lapsed org does not keep generating");
  assert.equal(PLAN_LIMITS.self_hosted.images_per_month, null, "the operator's own bill, their call");
  assert.equal(UNLIMITED_LIMITS.images_per_month, null);
  // And the ladder goes up.
  const ladder = (["find", "starter", "growth", "scale"] as const).map(
    (p) => PLAN_LIMITS[p].images_per_month as number,
  );
  assert.deepEqual(ladder, [...ladder].sort((a, b) => a - b), `not monotonic: ${ladder.join(" < ")}`);
});

test("the ceiling is counted, not priced", () => {
  const src = readFileSync(new URL("../src/identity.ts", import.meta.url).pathname, "utf8");
  // An image is $0.04 on Stability Ultra and $0.22 on GPT Image 2. A dollar ceiling would mean a
  // founder's allowance silently quartering when an operator changed a default.
  assert.match(src, /COUNTED, NOT PRICED/);
  assert.match(src, /images_per_month: number \| null;/);
});

test("the counter is bumped before the call, so two runs cannot both pass the check", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf('app.post("/v1/internal/image"');
  const route = src.slice(at, at + 6500);
  assert.match(route, /\.bump\(projectId, "month", `images:\$\{month\}`/);
  // Read-then-write is exactly what turned a `max_per_day: 40` into roughly 160 across replicas.
  assert.ok(route.indexOf(".bump(") < route.indexOf("generateImage("), "bump must precede the spend");
  assert.match(route, /used > cap/);
});

test("who pays comes from the grant, never from the body", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf('app.post("/v1/internal/image"');
  const route = src.slice(at, at + 6500);
  // A `project_id` in the request would be the sandbox choosing whose budget to spend.
  assert.match(route, /grant\.task_id/);
  assert.doesNotMatch(route, /b\.project_id/);
});

test("a plan with no allowance is refused before anything is spent", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf('app.post("/v1/internal/image"');
  const route = src.slice(at, at + 6500);
  assert.match(route, /not included on this plan/);
  assert.ok(route.indexOf("not included on this plan") < route.indexOf("generateImage("));
  // 402, not 403: this is about money, and the agent's doc can say so.
  assert.match(route, /not included on this plan" \}, 402\)/);
});

test("a counter we cannot reach lets the image through", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf('app.post("/v1/internal/image"');
  const route = src.slice(at, at + 6500);
  // Losing a founder's hero to our own outage is worse than one uncounted image. This is a margin
  // control, not a security boundary — the distinction decides which way it fails.
  assert.match(route, /\.catch\(\(\) => 0\)/);
  assert.match(route, /margin control/);
});

test("the floor is documented as a floor, not sold as a good model", () => {
  // Checked September 2026: Stable Image Ultra appears on no image arena. The boards are GPT Image
  // 2 by the largest first-to-second gap any of them has recorded, then Nano Banana Pro, then
  // FLUX.2. A comment that implied otherwise would be the exact dishonesty this codebase spends its
  // comments avoiding — and the next person choosing a model would believe it.
  const src = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.match(src, /THE FLOOR, NOT A GOOD MODEL/);
  // `[\s*]+` spans the comment wrap: prose reflowed at 100 columns breaks any matcher that
  // assumes one line, and the third time is enough to stop assuming.
  assert.match(src, /does not appear on the image[\s*]+arenas at all/);
  assert.match(src, /MYCEL_IMAGE_OPENAI_KEY/, "and it names the way to something better");
});

test("fal reaches FLUX.2, not the research release from a year ago", () => {
  // `fal-ai/flux/dev` was FLUX.1 [dev] — a distilled research build, chosen when this file's only
  // job was to prove a picture could be fetched at all. FLUX.2 [pro] is third on the 2026 boards
  // behind GPT Image 2 and Nano Banana Pro, which makes it the best thing reachable here without an
  // OpenAI image key, at roughly four cents for a hero.
  const p = imageProviderFromEnv({ FAL_KEY: "k" } as NodeJS.ProcessEnv)!;
  assert.equal(p.kind, "fal");
  assert.equal(p.model, "fal-ai/flux-2-pro");
  const src = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.ok(!src.includes("fal-ai/flux/dev"), "the old endpoint must not survive as a fallback");
});

test("the ladder runs cheapest-floor to best, and a key always beats the floor", () => {
  // The order this settles on: Bedrock when nothing is set (free, unranked, honest about it), fal
  // for FLUX.2 (~$0.04, third on the boards), OpenAI for gpt-image-2 (~$0.22, first by a margin
  // those boards have not seen before). Quality is bought deliberately; the floor is never a
  // decision somebody made.
  const bedrock = { MYCEL_IMAGE_BEDROCK_REGION: "us-west-2" } as NodeJS.ProcessEnv;
  assert.equal(imageProviderFromEnv(bedrock)!.model, "stability.stable-image-ultra-v1:1");
  assert.equal(imageProviderFromEnv({ ...bedrock, FAL_KEY: "k" })!.model, "fal-ai/flux-2-pro");
  assert.equal(
    imageProviderFromEnv({ ...bedrock, FAL_KEY: "k", MYCEL_IMAGE_OPENAI_KEY: "k" })!.model,
    "gpt-image-2",
    "the best model wins when it is reachable — fal only led this list while gpt-image-2 needed a " +
      "key nobody had set, which is ordering by availability rather than by quality",
  );
});

test("the deployment points the image key at the OpenAI secret it already holds", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  // `imageProviderFromEnv` refuses to reuse the agent's key for images, because an ordinary text key
  // answers 400 per call and a run discovers that by spending its budget. That rule stays: this is
  // an operator setting a DIFFERENT variable on purpose, which is the opt-in the code asks for, and
  // it happens to point at the same secret.
  const tf = readFileSync(new URL("../../../infra/services.tf", import.meta.url).pathname, "utf8");
  assert.match(tf, /MYCEL_IMAGE_OPENAI_KEY", valueFrom = local\.secret_arns\["openai-api-key"\]/);
});

test("the price argument against gpt-image-2 was four times too large", () => {
  // The ~$0.22 figure is the 2K/4K tier. At the size this tool asks for it is about 0.8 cents,
  // measured against the live API — 196 output tokens for 1024×1024. Quoting the wrong number
  // argued against the best available model on the strength of it.
  const src = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.match(src, /0\.8 cents/);
  assert.match(src, /2K\/4K tier/);
});

test("no stale model default survives inside the generated script", () => {
  // The OpenAI branch carried `MYCEL_IMAGE_MODEL || "gpt-image-1"` — the old model, left behind when
  // the provider default moved to gpt-image-2. The runtime always sets that env var, so the fallback
  // never fired and nothing ever broke, which is exactly why it survived: a stale default that never
  // resolves is invisible until the day it does.
  const tool = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.ok(!tool.includes("gpt-image-1"), "the retired model must not be reachable at all");
  assert.match(tool, /p\.model \?\? "gpt-image-2"/);
});

test("the OpenAI response is written from base64, which is what the API actually returns", () => {
  // Verified against the live API: `gpt-image-2` answers with `b64_json`, not a URL. A script that
  // only handled the URL shape would fetch nothing and leave an empty frame on a founder's page.
  const tool = readFileSync(new URL("../src/imagetool.ts", import.meta.url).pathname, "utf8");
  assert.match(tool, /d\.data\?\.\[0\]\?\.b64_json/);
  assert.match(tool, /d\.data\?\.\[0\]\?\.url \?\? d\.images\?\.\[0\]\?\.url/, "the url shape is still handled");
});
