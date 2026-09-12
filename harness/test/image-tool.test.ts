// Something to put in the frame.
//
// Every site and deck this product built shipped grey rectangles, and not by accident:
// `design-lint.ts` refuses external placeholder CDNs — correctly, they look fake when they 404 —
// and offers `.ph-img` as the only alternative. The linter was right and the cupboard was bare. An
// agent asked to make something look designed had a palette, a type scale and craft rules about
// composition, and nothing to photograph. It drew SVG by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { IMAGE_TOOL_PATH, imageProviderFromEnv, imageToolDoc, imageToolScript } from "../src/imagetool";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAL = { kind: "fal", key: "k", model: "fal-ai/flux/dev" } as const;
const script = imageToolScript(FAL);

test("the script is valid bash", () => {
  const p = join(tmpdir(), `mycel-image-test-${process.pid}`);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  // `bash -n` parses without executing. A script written by string concatenation is one stray
  // quote away from a tool that installs cleanly and fails on first use.
  execFileSync("bash", ["-n", p], { stdio: "pipe" });
});

test("it refuses without a prompt and a destination", () => {
  const p = join(tmpdir(), `mycel-image-usage-${process.pid}`);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  let code = 0;
  try {
    execFileSync("bash", [p], { stdio: "pipe" });
  } catch (e) {
    code = (e as { status?: number }).status ?? 0;
  }
  assert.equal(code, 2, "a bare invocation should exit 2 with usage, not write a file");
});

test("the body is checked, because a 200 can be an apology page", () => {
  // The byte-sniffing guard is gone with the direct call it existed for: the script now reads JSON
  // from OUR endpoint, so an HTML apology from a provider can never reach it — the kernel turns
  // that into a 502 before the sandbox sees anything.
  //
  // What survives is the check that matters either way: a decoded body that is too small to be an
  // image writes nothing, because a half-written file in an `<img>` looks broken rather than
  // unfinished and the agent cannot tell which from an exit code.
  assert.ok(!/JFIF/.test(script), "a format allowlist rejects EXIF JPEGs — it must not come back");
  assert.match(script, /image_base64/, "the response is read as the field we control");
  assert.match(script, /-lt 1024/, "nothing rejects a body too small to be an image");
  assert.match(script, /mv "\$TMP" "\$OUT"/, "and it is only moved into place once whole");
  assert.match(script, /-lt 1024/, "no size floor — a one-line error page would be written as an image");
});

test("a failed fetch writes nothing at all", () => {
  // A half-downloaded file in an <img> is worse than a missing one: the page looks broken rather
  // than unfinished, and the agent cannot tell the difference from an exit code.
  assert.match(script, /TMP="\$\(mktemp\)"/, "it no longer downloads to a temp file first");
  assert.match(script, /mv "\$TMP" "\$OUT"/, "the destination is written before the body is checked");
  assert.ok(!/-o "\$OUT"/.test(script), "curl writes straight to the destination");
});

test("the prompt is encoded by a real encoder", () => {
  // The first version hex-escaped every byte with od/sed. Valid encoding, rejected by the service,
  // and the failure surfaced as "no image" rather than as anything diagnosable.
  assert.ok(!/od -An/.test(script), "the hand-rolled hex encoder is back");
  // The prompt is JSON now, not a path segment — `node` builds the body so quoting is its problem.
  assert.match(script, /JSON\.stringify/, "the request body is hand-assembled again");
});

test("the doc leads with when NOT to use it", () => {
  const doc = imageToolDoc(FAL).join("\n");
  // Same shape as `mycel-insight`'s doc, and for the same reason: the expensive mistake with an
  // image tool is not forgetting it exists, it is decorating. A generated photograph in a monthly
  // close makes a credible document look like a brochure.
  const notAt = doc.indexOf("When NOT to use it");
  const earnsAt = doc.indexOf("Where it earns its place");
  assert.ok(notAt > 0 && earnsAt > notAt, "the refusals no longer come before the capability");
  for (const forbidden of ["report", "portrait", "logo", "screenshot"]) {
    assert.ok(doc.toLowerCase().includes(forbidden), `the doc no longer warns about a ${forbidden}`);
  }
  assert.match(doc, /brand\/tokens\.css/, "nothing ties the image to the house style");
});

test("installed and documented on the same shapes, or not at all", () => {
  // The rule the build tools follow: a tool an agent is told about and cannot run costs it turns.
  // The inverse costs more — a tool installed and never mentioned is one it never uses, which is
  // the most common defect in this repo.
  const runtime = readFileSync(join(HERE, "..", "src", "runtime.ts"), "utf8");
  assert.match(runtime, /writeFile\(IMAGE_TOOL_PATH, imageToolScript\(imageProvider\)\)/, "the tool is not installed");
  // Intent, not exact form: the call now passes art direction as a second argument and spans lines.
  // A test pinned to one spelling of a call fails on a change that improved the thing it guards,
  // which teaches whoever hits it to loosen the assertion rather than read it.
  assert.match(runtime, /imageToolDoc\(\s*img\b/, "the tool is installed and never mentioned");
  // Both guarded by the same shape test. Checked in a WINDOW before each call site rather than by
  // splitting on the symbol — the first occurrence of `IMAGE_TOOL_PATH` is its import, so a naive
  // split searches the top of the file, which cannot contain the guard. (That was this test's own
  // first bug.)
  const GUARD = 'profile.shape === "deliver" || profile.shape === "build"';
  const before = (needle: string) => {
    const at = runtime.indexOf(needle, runtime.indexOf("\n", runtime.indexOf("import")));
    const site = runtime.lastIndexOf(needle);
    return runtime.slice(Math.max(0, site - 1500), site);
  };
  assert.ok(before("writeFile(IMAGE_TOOL_PATH").includes(GUARD), "the install is not shape-guarded");
  assert.ok(before("imageToolDoc(img").includes(GUARD), "the doc is not shape-guarded");
});

test("it lands beside the other sandbox tools", () => {
  assert.equal(IMAGE_TOOL_PATH, "/usr/local/bin/mycel-image");
});

test("no key, no tool — the refusal that makes this worth having", () => {
  // THE POINT OF THE REWRITE. The first version called a free keyless endpoint, worked on the
  // first try, and produced a muddy blob. Shipping that to a client's homepage is not a
  // capability, it is a downgrade with extra steps — and it contradicts every other refusal here:
  // the grounding floor will not write ungrounded copy, `designSystemFilesFor` will not invent a
  // colour. A tool that always answers, badly, is the one thing none of them would do.
  assert.equal(imageProviderFromEnv({} as NodeJS.ProcessEnv), undefined);
  // No keyless fallback may creep back in.
  assert.ok(!/pollinations/i.test(script), "a free keyless endpoint is back in the script");
  // The wording moved with the design: the sandbox no longer holds a provider key at all, so the
  // refusal is about this kernel having no provider configured rather than this sandbox having no
  // key. The refusal itself is the point and it is still there.
  assert.match(script, /image generation is not wired on this kernel/, "the tool no longer refuses");
});

test("providers are chosen by which key is present, best output first", () => {
  const fal = imageProviderFromEnv({ FAL_KEY: "a" } as NodeJS.ProcessEnv);
  assert.equal(fal?.kind, "fal");
  assert.match(fal?.model ?? "", /flux/, "FLUX is no longer the default");
  // FLUX first even when several are configured: it is the least prone to smearing letters, which
  // is the failure that makes a generated image unusable on a marketing page.
  const both = imageProviderFromEnv({ FAL_KEY: "a", HIGGSFIELD_API_KEY: "b" } as NodeJS.ProcessEnv);
  assert.equal(both?.kind, "fal");
  // The OpenAI path needs its OWN key. Reusing the agent's text key is a 400 per call.
  assert.equal(imageProviderFromEnv({ OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv), undefined);
  assert.equal(imageProviderFromEnv({ MYCEL_IMAGE_OPENAI_KEY: "x" } as NodeJS.ProcessEnv)?.kind, "openai");
});

test("the key never lands in the script on disk", () => {
  // The script is written into the workspace, and a workspace file is one the run can export.
  const withKey = imageToolScript({ kind: "fal", key: "sk-secret-value", model: "fal-ai/flux/dev" });
  assert.ok(!withKey.includes("sk-secret-value"), "a live credential was baked into an exportable file");
  assert.match(withKey, /\$MYCEL_IMAGE_KEY/, "the key is no longer read from the environment");
});
