// `sharedCraft()` fails soft to [] when its directory is absent — deliberately, so a missing file of
// general advice never fails a run. The cost of that choice is that a deployment which forgets to
// ship it produces every deliverable with none of it, and nothing anywhere says so.
//
// That is exactly what happened: `craft/` had no COPY line in the Dockerfile, so the eight rules
// "mounted on every run that produces something a client receives" were absent in production for
// their whole life. Four directories have now had this same bug (wedges, workflows, service-skills,
// design-systems), which is enough to assert on rather than remember.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sharedCraft } from "../src/craft";

const dockerfile = () => readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

test("the runtime data is carried in two lines, not seven", () => {
  /**
   * ═══ THIS TEST USED TO BE THE LIST, AND THE LIST IS HOW IT WAS BEATEN ═══
   *
   * It read: *"The list is the point. Adding a directory that `<cwd>`-resolves without adding it
   * here — and to the Dockerfile — reproduces the bug for the fifth time."* Seven names, hardcoded,
   * asserting seven `COPY` lines.
   *
   * `packs` was the eighth. It resolved `<cwd>/packs`, it was never on this list, it was never in
   * the Dockerfile, and this guard passed the whole time. Production had **4,442 `workflow:*` calls
   * and zero `pack:*`, ever**, while books-keeper, gtm-operator, geo-monitor and invoice-chaser all
   * declared packs in their manifests. A guard whose population is maintained by hand fails the same
   * way as the thing it guards, and for the same reason.
   *
   * So the general property moved to `the-image-carries-what-the-kernel-reads.test.ts`, which reads
   * the resolvers out of the source instead of being told them. What is left here is the LAYOUT that
   * makes the general property cheap to satisfy: one line for the headline concept, one for the
   * runtime library. Two lines cannot be forgotten six times.
   */
  const df = dockerfile();
  assert.match(df, /^COPY wedges \.\/wedges$/m, "wedges/ is read at runtime and not copied into the image");
  assert.match(df, /^COPY library \.\/library$/m, "library/ is read at runtime and not copied into the image");
  // And the seven-line shape must not come back: it is the shape that lost packs.
  for (const gone of ["blueprints", "workflows", "service-skills", "design-systems", "craft", "templates", "packs"]) {
    assert.doesNotMatch(
      df,
      new RegExp(`^COPY ${gone} `, "m"),
      `${gone}/ is copied on its own line again — that is the shape that dropped packs`,
    );
  }
});

test("the shared craft is non-empty and mounts under a name that says where it came from", () => {
  const mounted = sharedCraft();
  assert.ok(mounted.length >= 2, `expected the craft shelf, got ${mounted.length}`);
  for (const m of mounted) {
    assert.match(m.name, /^craft:/, `${m.name} does not say it is shared craft`);
    assert.ok(m.content.length > 500, `${m.name} is too short to be advice`);
  }
});

test("presentation craft names the mounted brand contract, or it cannot be followed", () => {
  // A rule that says "make it look good" is not actionable. The run is handed `brand/tokens.css`;
  // the craft has to point at that file by name, or the two never meet.
  const presenting = sharedCraft().find((m) => m.name === "craft:presenting-work");
  assert.ok(presenting, "no presentation craft is mounted");
  assert.match(presenting!.content, /brand\/tokens\.css/, "never names the token file the run is given");
  assert.match(presenting!.content, /height/i, "no fixed-height rule — Chart.js will loop the browser");
  assert.match(presenting!.content, /lorem ipsum|placeholder/i, "does not forbid placeholders");
});

test("craft files are markdown and nothing else", () => {
  // `sharedCraft` skips non-.md, so a stray asset would be silently ignored rather than mounted —
  // and someone would eventually wonder why the template they added never arrived.
  for (const f of readdirSync(new URL("../../library/craft/", import.meta.url))) {
    assert.match(f, /\.md$/, `craft/${f} will never be mounted; sharedCraft only reads .md`);
  }
});
