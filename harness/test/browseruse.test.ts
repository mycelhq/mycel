// THE BROWSER MOUNT — three properties, each of which is a way this could go wrong quietly.
//
// browser-use is an agent framework. Mounting one inside our sandbox is only safe because of what we
// DENY it, and every denial here is invisible at runtime: a nested agent that works is not an error,
// a provider key that leaks in is not an error, and a shape that quietly gains a browser is not an
// error. They are all just capabilities nobody decided to grant.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSERUSE_BIN,
  BROWSERUSE_BRIEF,
  BROWSERUSE_DENIED,
  BROWSERUSE_LLM_TOOLS,
  BROWSERUSE_MCP_SERVER,
  BROWSERUSE_TOOLS,
  buildBrowserUseMcp,
  qualified,
} from "../src/browseruse";
import { SHAPE_DEFAULTS } from "../src/harness";

const entry = (m?: Record<string, unknown>) =>
  (m?.[BROWSERUSE_MCP_SERVER] ?? {}) as { command?: string[]; environment?: Record<string, string> };

test("only the operate shape gets a browser", () => {
  for (const shape of ["decide", "build", "general"]) {
    assert.equal(buildBrowserUseMcp(shape), undefined, shape);
  }
  assert.ok(buildBrowserUseMcp("operate"), "operate");
});

test("with no proxy, no credential enters the sandbox — and the keys are empty, not absent", () => {
  // Absent is not the same as empty. On a transport that OVERLAYS `environment` onto the parent's,
  // an omitted key is inherited from the kernel process, which may well have one.
  const env = entry(buildBrowserUseMcp("operate")).environment ?? {};
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.OPENAI_BASE_URL, undefined, "no endpoint without a key to use on it");
});

test("with a proxy, the model is the RUN'S — routed by OPENAI_BASE_URL, never a provider key", () => {
  // The whole wiring, and the seam is `OPENAI_BASE_URL`: `ChatOpenAI._get_client_params()` strips a
  // None `base_url` before constructing `AsyncOpenAI`, so openai-python reads the env var itself.
  // The config.json route cannot carry a base_url — `LLMEntry` has no such field and no
  // `extra='allow'` — which is why this is the path and not that one.
  const env =
    entry(
      buildBrowserUseMcp("operate", {
        llm: { baseUrl: "https://api.example/v1/internal/llm", apiKey: "nonce-abc", model: "gpt-5.6-luna" },
      }),
    ).environment ?? {};
  assert.equal(env.OPENAI_API_KEY, "nonce-abc", "the run's nonce: minted per run, TTL'd, revoked at the end");
  assert.equal(env.OPENAI_BASE_URL, "https://api.example/v1/internal/llm");
  assert.equal(env.BROWSER_USE_LLM_MODEL, "gpt-5.6-luna");
  // Always emptied, never omitted. browser-use will happily pick a different provider if it finds
  // one, and the point is that there is exactly one route out of this sandbox.
  assert.equal(env.ANTHROPIC_API_KEY, "");
});

test("no provider-shaped credential is ever emitted", () => {
  for (const m of [buildBrowserUseMcp("operate"), buildBrowserUseMcp("operate", { llm: { baseUrl: "u", apiKey: "n", model: "m" } })]) {
    for (const [k, v] of Object.entries(entry(m).environment ?? {})) {
      assert.doesNotMatch(v, /^sk-|^sk_live|^sk-ant-|Bearer /, `${k} looks like a provider key`);
    }
  }
});

test("the nested agent is denied by the shape, by its qualified name", () => {
  // `retry_with_browser_use_agent` drives the browser autonomously until it decides it is done —
  // outside our step cap, our cost ceiling and our approval gate. With no model it would fail
  // anyway; this is the belt, and it is what keeps it denied the day somebody adds a key.
  const perm = SHAPE_DEFAULTS.operate.permission as Record<string, unknown>;
  assert.equal(perm.browseruse_retry_with_browser_use_agent, "deny");
  assert.deepEqual(BROWSERUSE_DENIED, ["browseruse_retry_with_browser_use_agent"]);
  assert.equal(qualified("browser_navigate"), "browseruse_browser_navigate");
});

test("the shape still cannot send, charge or publish", () => {
  // A browser holding a live customer session is a strictly larger surface than a token scoped to
  // three endpoints, so the shape that has one does not also hold the send grant. Mounting these
  // tools must not have moved that line.
  assert.equal(SHAPE_DEFAULTS.operate.grants_actions, false);
});

test("every LLM-backed tool is named, so a refusal can be explained", () => {
  for (const t of BROWSERUSE_LLM_TOOLS) {
    assert.ok(BROWSERUSE_TOOLS.includes(t as (typeof BROWSERUSE_TOOLS)[number]), t);
  }
  // Both work on a proxy-mode kernel. On one without a proxy they refuse, and this list is what
  // lets something say WHY rather than surfacing a stack trace.
  assert.ok(BROWSERUSE_LLM_TOOLS.includes("browser_extract_content"));
});

test("the brief teaches the one idea the tools are useless without", () => {
  // An agent that has the tools and not this will pass CSS selectors, get errors, and fall back to
  // guessing from screenshots — which is the exact failure browser-use was mounted to remove.
  assert.match(BROWSERUSE_BRIEF, /browser_get_state/);
  assert.match(BROWSERUSE_BRIEF, /NUMBERED list/);
  assert.match(BROWSERUSE_BRIEF, /Do not write CSS selectors or XPath/);
  // And it restates the boundary, because an agent in a browser is the one most likely to look for
  // a way around a grant it does not hold.
  assert.match(BROWSERUSE_BRIEF, /sends, charges or publishes/);
});

test("the binary is absolute, because an MCP server is spawned with no shell", () => {
  // A `~` here produced a server that silently failed to start and a run with no tools and no
  // error — the same failure mcpbridge.ts documents for its own bridge path.
  assert.ok(BROWSERUSE_BIN.startsWith("/"), BROWSERUSE_BIN);
  assert.deepEqual(entry(buildBrowserUseMcp("operate")).command, [BROWSERUSE_BIN, "--mcp"]);
});

test("an allowlist is enforced in the browser, not in a prompt", () => {
  // An agent TOLD not to navigate somewhere can still navigate there. This is the session-level
  // control, and it is off unless a caller asks for it — "operate the customer's own software"
  // usually means we do not know the domain in advance.
  assert.equal(entry(buildBrowserUseMcp("operate")).environment?.BROWSER_USE_ALLOWED_DOMAINS, undefined);
  const scoped = entry(buildBrowserUseMcp("operate", { allowedDomains: ["xero.com", " app.hubspot.com "] }));
  assert.equal(scoped.environment?.BROWSER_USE_ALLOWED_DOMAINS, "xero.com,app.hubspot.com");
});

test("no telemetry pipeline describing a customer's browsing to a third party", () => {
  const env = entry(buildBrowserUseMcp("operate")).environment ?? {};
  assert.equal(env.ANONYMIZED_TELEMETRY, "false");
  assert.equal(env.BROWSER_USE_CLOUD_SYNC, "false");
  assert.equal(env.BROWSER_USE_HEADLESS, "true");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RESIDENTIAL EGRESS
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// All four answer engines block a datacenter IP (measured in production, 30 August 2026). The fix
// is where the request comes from, and this is the wiring that carries it into the browser.

test("a proxy reaches browser-use as three variables, never as one URL", () => {
  /**
   * PINNED AGAINST THE WHEEL, because getting this wrong is invisible.
   *
   * browser_use/config.py maps `BROWSER_USE_PROXY_URL` to `ProxySettings.server`, and
   * browser/profile.py passes that as `--proxy-server=`. Chromium ignores credentials in that flag.
   * Auth happens over CDP: session.py registers `Fetch.authRequired` and answers with the separate
   * `username`/`password`, which come from their own two env vars.
   *
   * So `http://user:pass@host` 407s every request — and a 407 reaching the agent looks exactly like
   * the captcha wall the proxy was bought to get past. This test is what makes a version bump that
   * renames these variables a failing build instead of a silent bill.
   */
  const mcp = buildBrowserUseMcp("operate", {
    proxy: { server: "http://residential.decodo.io:10000", username: "user-x-country-gb", password: "p" },
  })!;
  const env = (mcp.browseruse as { environment: Record<string, string> }).environment;
  assert.equal(env.BROWSER_USE_PROXY_URL, "http://residential.decodo.io:10000");
  assert.equal(env.BROWSER_USE_PROXY_USERNAME, "user-x-country-gb");
  assert.equal(env.BROWSER_USE_PROXY_PASSWORD, "p");
  assert.ok(!env.BROWSER_USE_PROXY_URL.includes("@"), "credentials in the server URL are dropped");
});

test("no proxy configured sets none of the three", () => {
  // The default, and the state everything has shipped in: residential egress is metered per
  // gigabyte, so a deploy must not start spending. A half-set trio is worse than none — Chromium
  // would route through a proxy it cannot authenticate to and every probe would 407.
  const env = (buildBrowserUseMcp("operate")!.browseruse as { environment: Record<string, string> }).environment;
  for (const k of ["BROWSER_USE_PROXY_URL", "BROWSER_USE_PROXY_USERNAME", "BROWSER_USE_PROXY_PASSWORD"]) {
    assert.ok(!(k in env), k);
  }
});
