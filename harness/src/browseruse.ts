// The hands for the `operate` shape — browser-use, mounted as an MCP server.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY NOT RAW PLAYWRIGHT, WHICH THE IMAGE ALREADY HAS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Playwright is a driver. An agent given `page.click(selector)` has to invent a selector from a
// screenshot or from raw HTML, and it is wrong often enough that every `operate` run becomes a retry
// loop against somebody else's markup. The cost of the shape was never page loads; it was re-tries,
// and a selector that worked last week breaking when the vendor renames a class.
//
// browser-use serialises the page into an INDEXED list of interactive elements, so the agent clicks
// index 14. No selector, no guessing, nothing to break on a class rename. It also carries years of
// accumulated work on the things that actually stop browser automation in the wild — stealth,
// iframes, shadow DOM, downloads, file inputs, multi-tab state — which we would otherwise write
// ourselves, badly, one incident at a time.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// IT GETS A MODEL, AND IT IS THE RUN'S OWN — NOT A PROVIDER KEY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// browser-use's best tools need a model: `browser_extract_content` ("read this page and tell me X")
// and its own agent. We do not give a sandbox a provider credential — that is the rule mcpbridge.ts
// exists to hold — so the question is whether browser-use can be pointed at the run's own scoped
// proxy, the way opencode is.
//
// IT CAN, AND THE FIRST READING OF THIS SAID OTHERWISE. That first reading was of the config.json
// path, and it was correct about it: `mcp/server.py` does `base_url = llm_config.get('base_url')`,
// but `llm_config` is `LLMEntry.model_dump(exclude_none=True)` and `LLMEntry` declares only
// `api_key`, `model`, `temperature`, `max_tokens` with no `extra='allow'` — so a `base_url` written
// into config.json is dropped before the server sees it. True, and beside the point, because there
// is a second path and it is the better one:
//
//     ChatOpenAI._get_client_params() builds `{'api_key': …, 'base_url': self.base_url, …}` and then
//     strips every None before constructing `AsyncOpenAI(**client_params)`.
//
// So with `base_url` unset, `AsyncOpenAI` is constructed WITHOUT that argument, and openai-python
// then does what it always does: reads `OPENAI_BASE_URL` from the environment. Three env vars are
// therefore the whole wiring — `OPENAI_API_KEY` (the run's nonce, which `config.py` folds into
// `config['llm']['api_key']`), `OPENAI_BASE_URL` (read by the SDK itself), and
// `BROWSER_USE_LLM_MODEL` (folded into `config['llm']['model']`).
//
// That is strictly better than a provider key would have been. The nonce is minted per run, TTL'd,
// revoked when the run ends, and every token browser-use spends goes through the same LiteLLM
// virtual key with the same per-org budget and model allowlist as the agent's own calls. Its
// spending is inside our accounting rather than beside it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS STILL DENIED, AND WHY IT IS NOT A CAPABILITY QUESTION
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `retry_with_browser_use_agent` stays denied even though it now has everything it needs to run.
// This is not caution about browser-use; it is the same rule that denies `task` to this shape two
// lines above it in `SHAPE_DEFAULTS`. A nested agent chooses its own steps inside our step cap
// without counting against it, and its clicks do not pass `tool.execute.before` individually —
// which is where the approval gate lives. One agent per run, and it is ours.
//
// Everything else is on: navigate, click by index, type, get_state, get_html, screenshot, scroll,
// back, tabs, sessions, and `browser_extract_content` with a real model behind it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THIS MOUNT ENFORCES
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. NO PROVIDER KEY, EVER. The only credential is the run's nonce, and `ANTHROPIC_API_KEY` is
//      emptied explicitly rather than omitted — `environment` overlays the parent's on some
//      transports, so an omitted name is an INHERITED one, and browser-use will happily pick a
//      different provider if it finds one. There is exactly one route out of this sandbox.
//   2. NO NESTED AGENT. `retry_with_browser_use_agent` is denied by name in the shape's permission
//      map — not because it would fail (it now has everything it needs) but because a nested agent
//      chooses its own steps inside our step cap without counting against it, and its clicks do not
//      pass `tool.execute.before` individually, which is where the approval gate lives.
//   3. A DOMAIN ALLOWLIST, when the caller supplies one. `BROWSER_USE_ALLOWED_DOMAINS` is enforced
//      inside the browser session, which is a much better place than a prompt: an agent that is told
//      not to navigate somewhere can still navigate there.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND IT STILL CANNOT SEND, CHARGE OR PUBLISH
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `SHAPE_DEFAULTS.operate.grants_actions` is `false` and not negotiable by a manifest. A browser
// holding a live customer session is a strictly larger surface than a token scoped to three
// endpoints, so the shape that has one does not also hold the send grant. That line is the same one
// `build` draws, for the same reason, and mounting these tools does not move it.

import { BROWSER_USE_VERSION } from "./sandbox.snapshot";

/**
 * The MCP server name, and therefore the prefix on every tool the model sees.
 *
 * opencode names MCP tools `<serverName>_<toolName>` (measured — see mcpbridge.ts), and browser-use
 * already prefixes its own tools with `browser_`. So this is `browseruse` and not `browser`, because
 * the latter would produce `browser_browser_navigate`. The provenance being visible in the tool name
 * is worth the extra characters: the approval gate matches on these strings, and so does anyone
 * reading a trace.
 */
export const BROWSERUSE_MCP_SERVER = "browseruse";

/** Absolute — an MCP server is spawned as a bare process, with no shell to expand `~`. */
export const BROWSERUSE_BIN = "/opt/browseruse/bin/browser-use";

/** Every tool the pinned wheel's `mcp/server.py` registers, in its own order. */
export const BROWSERUSE_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_get_state",
  "browser_extract_content",
  "browser_get_html",
  "browser_screenshot",
  "browser_scroll",
  "browser_go_back",
  "browser_list_tabs",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_close",
  "retry_with_browser_use_agent",
  "browser_list_sessions",
  "browser_close_session",
  "browser_close_all",
] as const;

/**
 * The ones that need a model.
 *
 * Both work when `opts.llm` is supplied, which is every run on a proxy-mode kernel. On a kernel with
 * no proxy they refuse, and that is honest rather than broken — the alternative was a provider key
 * in the sandbox. Kept as data rather than as a sentence in a comment so anything that needs to
 * explain a refusal reads the same list the mount does.
 */
export const BROWSERUSE_LLM_TOOLS = ["retry_with_browser_use_agent", "browser_extract_content"] as const;

/**
 * What the agent is told this thing can do, compiled into its instructions for the `operate` shape.
 *
 * A mounted tool the agent does not know the SHAPE of is a tool it uses once, badly, and stops
 * using. The important idea here is not any single tool — it is that `browser_get_state` returns an
 * INDEXED list and every other call refers to those indexes. An agent that has not been told that
 * will keep trying to pass CSS selectors, get errors, and fall back to guessing from screenshots,
 * which is the exact failure mode browser-use exists to remove.
 */
export const BROWSERUSE_BRIEF = [
  "## The browser",
  "",
  "You have a real Chromium browser. It is how work gets done in software that has no API.",
  "",
  "**Read the page before you touch it.** `browser_get_state` returns the page's interactive elements",
  "as a NUMBERED list. Every click and every keystroke refers to one of those numbers.",
  "Do not write CSS selectors or XPath — they are not accepted, and inventing one from a screenshot",
  "is how automation breaks the week a vendor renames a class.",
  "",
  "The loop is: `browser_navigate` → `browser_get_state` → act on an index → `browser_get_state` again.",
  "Re-read the state after anything that changes the page. The indexes are not stable across loads.",
  "",
  "- `browser_click`, `browser_type` — act on an index from the last state.",
  "- `browser_scroll`, `browser_go_back` — move around. Scroll before deciding something is absent;",
  "  the state only describes what has been rendered.",
  "- `browser_get_html` — the raw markup, when you need something the state does not carry.",
  "- `browser_extract_content` — ask a question of the current page in words. Cheaper and more",
  "  reliable than reading raw HTML yourself when the answer is a fact rather than a structure.",
  "- `browser_screenshot` — when the layout itself is the evidence. Attach it rather than describing it.",
  "- `browser_list_tabs` / `browser_switch_tab` / `browser_close_tab` — flows that open new windows.",
  "",
  "**What you cannot do here.** Nothing you do in this browser sends, charges or publishes on the",
  "business's behalf — that is a separate grant this shape does not hold, on purpose. If a job",
  "genuinely needs a message sent or money moved, finish what you can, then say plainly what is left",
  "and who has to approve it. Do not look for a way around it.",
  "",
  "**If you are blocked** — a login you do not have, a challenge you cannot pass, a page that will",
  "not load — stop and say so, naming the URL and what you saw. A run that reports the wall is worth",
  "more than one that spends twenty minutes pretending it is not there.",
].join("\n");

/** `<server>_<tool>`, which is the name the model calls and the gate matches. */
export const qualified = (tool: string): string => `${BROWSERUSE_MCP_SERVER}_${tool}`;

/** The nested agent, denied by name. See point 2 above. */
export const BROWSERUSE_DENIED = [qualified("retry_with_browser_use_agent")];

export interface BrowserUseMount {
  /**
   * The run's own model endpoint. Absent means the deterministic tools work and the two LLM-backed
   * ones refuse — which is what happens on a kernel with no proxy mode, and is honest rather than
   * broken.
   */
  llm?: { baseUrl: string; apiKey: string; model: string };
  /**
   * Domains the browser may reach at all, enforced by the browser session rather than by a prompt.
   * Empty or absent means unrestricted, which is the honest default for a shape whose job is
   * "operate the customer's own software" — we usually do not know in advance what that is.
   */
  allowedDomains?: readonly string[];
  /** An egress proxy, when the tenant's work has to appear to come from somewhere specific. */
  /**
   * Residential egress for this run, when it is configured. See operate-egress.ts — the three
   * fields are not decomposable into one URL, because Chromium ignores credentials in the flag.
   */
  proxy?: { server: string; username: string; password: string };
  /**
   * A browser-use config file inside the sandbox, when this run carries a session to restore.
   *
   * The session cannot ride in an env var: `storage_state` is a `browser_profile` field and the only
   * route to `browser_profile` is the config file. See browser-work.ts, which builds both.
   */
  configPath?: string;
  /** Off by default. Only a developer watching a local run wants a window. */
  headless?: boolean;
}

/**
 * The `mcp` entry for this shape, in opencode's own config shape.
 *
 * Returns `undefined` for every shape that is not `operate`. That is not an optimisation: mounting
 * a browser on a `decide` run would hand a four-minute text decision a capability it has no reason
 * to hold, and `harness-shapes` exists so that a shape's tools, permissions, tier and credentials
 * are decided as ONE unit rather than accumulated.
 */
export function buildBrowserUseMcp(
  shape: string,
  opts: BrowserUseMount = {},
): Record<string, unknown> | undefined {
  if (shape !== "operate") return undefined;

  const environment: Record<string, string> = {
    /**
     * THE MODEL, AS THREE ENV VARS. See the note at the top for why these three and not config.json.
     *
     * `OPENAI_API_KEY` is the RUN'S NONCE, never a provider key: minted per run, TTL'd, revoked when
     * the run ends, and metered through the same virtual key as the agent's own calls. Set to the
     * empty string when there is no proxy — explicitly empty rather than omitted, because
     * `environment` overlays the parent's on some transports and an inherited provider key is
     * exactly the failure this line exists to make impossible.
     *
     * `ANTHROPIC_API_KEY` is always emptied. browser-use will happily pick a different provider if
     * it finds one, and the whole point is that there is exactly one route out of this sandbox.
     */
    OPENAI_API_KEY: opts.llm?.apiKey ?? "",
    ANTHROPIC_API_KEY: "",
    ...(opts.llm
      ? {
          // Read by openai-python itself, because ChatOpenAI strips a None `base_url` before it
          // constructs the client. This is the seam, and it is one line.
          OPENAI_BASE_URL: opts.llm.baseUrl,
          BROWSER_USE_LLM_MODEL: opts.llm.model,
        }
      : {}),
    // Never a window in a sandbox, and never a version check phoning home mid-run.
    BROWSER_USE_HEADLESS: String(opts.headless === false ? false : true),
    BROWSER_USE_VERSION_CHECK: "false",
    // The sandbox is disposable and the run is already traced on our side; a second telemetry
    // pipeline describing a customer's browsing to a third party is not ours to opt into.
    ANONYMIZED_TELEMETRY: "false",
    BROWSER_USE_CLOUD_SYNC: "false",
    // Chromium is baked into the image at the shared Playwright cache. Named so a future image
    // change that moves it fails loudly here rather than as "the browser launched and died".
    PLAYWRIGHT_BROWSERS_PATH: "/root/.cache/ms-playwright",
    MYCEL_BROWSERUSE_VERSION: BROWSER_USE_VERSION,
  };

  /**
   * THE DOMAIN LOCK, and the only layer here that actually contains anything.
   *
   * Enforced inside the browser session rather than asked for in a prompt, because an agent told not
   * to navigate somewhere can still navigate there. A run holding a credential for a client's CMS
   * cannot reach their bank — not "is instructed not to", cannot.
   *
   * Empty means unrestricted, which is right for a GEO probe (it opens four different answer engines
   * and holds no credential) and wrong for anything carrying a session. `browser-work.ts` is what
   * makes sure a credentialed run never gets here with an empty list.
   */
  const domains = (opts.allowedDomains ?? []).map((d) => d.trim()).filter(Boolean);
  if (domains.length) environment.BROWSER_USE_ALLOWED_DOMAINS = domains.join(",");
  if (opts.configPath) environment.BROWSER_USE_CONFIG_PATH = opts.configPath;
  /**
   * THREE VARIABLES, BECAUSE CHROMIUM IGNORES CREDENTIALS IN `--proxy-server`.
   *
   * Verified against the pinned wheel: `config.py` maps `BROWSER_USE_PROXY_URL` to
   * `ProxySettings.server`, `profile.py:935` passes it as `--proxy-server=`, and Chromium drops any
   * userinfo in that flag. The auth happens over CDP instead — `session.py` registers
   * `Fetch.authRequired` and answers with the separate `username`/`password`.
   *
   * A single `user:pass@host` URL therefore 407s every request, and a 407 reaching the agent looks
   * exactly like the captcha wall this exists to get past. See operate-egress.ts.
   */
  if (opts.proxy) {
    environment.BROWSER_USE_PROXY_URL = opts.proxy.server;
    environment.BROWSER_USE_PROXY_USERNAME = opts.proxy.username;
    environment.BROWSER_USE_PROXY_PASSWORD = opts.proxy.password;
  }

  return {
    [BROWSERUSE_MCP_SERVER]: {
      type: "local",
      command: [BROWSERUSE_BIN, "--mcp"],
      environment,
      enabled: true,
    },
  };
}
