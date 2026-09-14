// Every provider the code offers is named in the files a person reads, and nothing else is.
//
// `providers.ts` is the registry, and three other artefacts describe it to humans: `.env.example`,
// which is the file somebody opens to configure this; `AGENTS.md`, which is what a coding agent
// reads instead of the README; and the boot banner. Documentation that lists vendors by hand falls
// behind the code silently — the failure is not a crash, it is a newcomer who never learns a
// capability exists, which is indistinguishable from it not existing.
//
// This is deliberately a DRIFT test, not a content test. It does not care how the docs are worded.
// It cares that adding a provider to the registry cannot be done without the docs following.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVIDERS, overrideEnv, type Capability } from "../src/gtm/providers";

const at = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const ENV_EXAMPLE = at(".env.example");
const AGENTS = at("AGENTS.md");

const every = Object.values(PROVIDERS).flat();

test("docs: .env.example names every provider key, and where to get it", () => {
  for (const o of every) {
    assert.ok(ENV_EXAMPLE.includes(o.env), `.env.example never mentions ${o.env} (${o.label})`);
    assert.ok(
      ENV_EXAMPLE.includes(o.signup),
      `.env.example names ${o.env} without saying where to get one — the answer to "now what" belongs with the question`,
    );
  }
});

test("docs: .env.example names every override variable", () => {
  for (const cap of Object.keys(PROVIDERS) as Capability[]) {
    assert.ok(ENV_EXAMPLE.includes(overrideEnv(cap)), `.env.example never mentions ${overrideEnv(cap)}`);
  }
});

test("docs: AGENTS.md names every provider key", () => {
  for (const o of every) {
    assert.ok(AGENTS.includes(o.env), `AGENTS.md never mentions ${o.env} (${o.label})`);
  }
});

test("docs: nothing is advertised that the code does not offer", () => {
  // The other direction, and the one that produces the worse experience: a key in the docs that
  // resolves to nothing is a promise the repo cannot keep. Matched on the shape of our own variable
  // names so it catches a vendor removed from the registry and left in the file.
  const known = new Set(every.map((o) => o.env));
  const capNames = new Set((Object.keys(PROVIDERS) as Capability[]).map(overrideEnv));
  for (const doc of [
    { name: ".env.example", text: ENV_EXAMPLE },
    { name: "AGENTS.md", text: AGENTS },
  ]) {
    for (const m of doc.text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_API_KEY\b/g) ?? []) {
      // Model-provider and service keys live in the same files and are not GTM providers.
      if (/^(ANTHROPIC|OPENAI|OPENROUTER|GOOGLE_GENERATIVE_AI|DAYTONA|COMPOSIO|AGENTMAIL|MYCEL|LANGFUSE)/.test(m)) continue;
      assert.ok(known.has(m), `${doc.name} advertises ${m}, which no provider in the registry offers`);
    }
    for (const m of doc.text.match(/\bMYCEL_[A-Z]+_PROVIDER\b/g) ?? []) {
      assert.ok(capNames.has(m), `${doc.name} advertises ${m}, which is not a capability`);
    }
  }
});
