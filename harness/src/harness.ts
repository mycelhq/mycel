/**
 * Harness profiles — the harness, engineered per task type.
 *
 * Until this file existed, every task got an identical harness: `buildOpencodeConfig` emitted one
 * config regardless of the work, and the prompt varied only by wedge. But "build a Next.js product
 * for this business" and "decide the next dunning step on this invoice" want almost nothing in
 * common. Different tools, different permissions, a different model tier, a different runtime
 * budget, a different output contract — and, most importantly, different CREDENTIALS. A build has
 * no business holding a token that can send email from the founder's mailbox.
 *
 * A profile is a REQUEST. The plan decides the tier (`resolveTier` clamps down, never refuses) and
 * the server ceilings decide the budgets. A wedge manifest is JSON written by a founder; nothing in
 * it may raise a limit.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT OPENCODE ACTUALLY LETS US CONTROL
 *
 * Verified against the real `opencode` 1.17.6 binary (the version `sandbox.snapshot.ts` pins), by
 * running `opencode debug config` and `opencode debug agent build` over candidate configs, and by
 * reading the OpenAPI document the 1.17.6 server serves at GET /doc. Not inferred from docs.
 *
 *   · `permission` — per-tool `allow` | `ask` | `deny`, and for read/edit/glob/grep/list/bash/task/
 *     external_directory/lsp/skill an object of glob-pattern → action. VERIFIED: this is not merely
 *     a prompt gate, it determines the TOOLSET the model is handed. `edit: "deny"` removes both
 *     `edit` and `write`; `task: "deny"` removes subagents entirely.
 *
 *     THREE verified behaviours that the shape of this file depends on, each of which is a footgun:
 *
 *     1. `write` and `patch` are NOT permission keys. `permission: { write: "deny" }` on its own
 *        changes the toolset not at all — `write` stays on. The key that governs writing is `edit`,
 *        and denying it removes `edit` AND `write` together. The `tools` spelling agrees:
 *        `tools: { write: false }` came back out of `debug config` as `permission.edit: "deny"`.
 *        Writing `write: "deny"` next to `edit: "deny"` therefore reads like defence in depth and
 *        is decoration; only the `edit` line is doing anything.
 *
 *     2. `"*"` IS a valid permission key — opencode's own default is literally `{"*": "allow"}` —
 *        and `{"*": "deny"}` plus explicit allows composes into a TRUE ALLOWLIST. Denied-by-default
 *        with `read`/`grep`/`glob`/`skill`/`todowrite`/`bash` allowed yields exactly those six tools
 *        and nothing else. This matters more than it looks: a denylist fails OPEN, so the day
 *        opencode ships a new tool, every denylist profile silently gains it.
 *
 *     3. ORDER IS SIGNIFICANT, and it fails catastrophically rather than loudly. The wildcard must
 *        be the FIRST key in the object. `{"*": "deny", read: "allow"}` yields `read`; the same
 *        pairs written `{read: "allow", "*": "deny"}` yields THE EMPTY TOOLSET — an agent with no
 *        tools at all, which presents as a model that inexplicably refuses to do anything rather
 *        than as a config error. Since this object is assembled by spreading founder-authored JSON
 *        over our defaults, key order is an emergent property of the merge, so `orderPermission()`
 *        below pins the wildcard to the front rather than trusting it.
 *
 *     Within a single tool's pattern map, the reverse is true and an allowlist is NOT expressible:
 *     a bash map whose `"*"` is `deny` removes the bash tool outright, so `{"curl *": "allow",
 *     "*": "deny"}` is simply "no shell" (verified: bash absent from the toolset). Pattern maps
 *     carve holes out of an allow default; the tool-level wildcard is where allowlisting happens.
 *   · `tools` — a flat `{ [toolId]: boolean }` map. VERIFIED: 1.17.6 normalises this INTO
 *     `permission` (`tools: { webfetch: false }` came back out of `debug config` as
 *     `permission.webfetch: "deny"`), so the two are one lever with two spellings. Real tool ids
 *     from GET /experimental/tool/ids: invalid, question, bash, read, glob, grep, edit, write,
 *     task, webfetch, todowrite, websearch, skill, apply_patch.
 *   · `agent.<name>` — per-agent `model`, `temperature`, `top_p`, `prompt`, `steps` (max agentic
 *     iterations before a forced text answer), `permission`, `mode`, `description`. The default
 *     primary agent is `build`. VERIFIED: `prompt: "{file:./AGENTS.md}"` is resolved to the file's
 *     contents at config load.
 *   · `instructions` — an array of files/globs appended to the system prompt.
 *   · `model` / `small_model` — the working model and the one used for cheap side-work (titles,
 *     summaries). `small_model` matters in proxy mode: only ONE model is registered on the `mycel`
 *     provider, so leaving it unset points side-work at a provider that does not exist in there.
 *   · `provider` — custom providers (how the LLM proxy is wired today), including per-provider
 *     `options.timeout` / `headerTimeout` / `chunkTimeout`.
 *   · `plugin` — the JS hooks (`tool.execute.before`) the Mycel approval gate rides on.
 *   · `tool_output.max_lines` / `max_bytes` — truncation of tool output before it is spilled to
 *     disk. Straightforwardly a token-cost lever.
 *   · `compaction.auto` / `prune` / `tail_turns` — automatic context compaction for long runs.
 *   · `snapshot` — filesystem snapshot tracking. Pure overhead for a run that edits no files.
 *   · `mcp` — local (stdio) and remote MCP servers, per-server env and timeout.
 *   · `skills.paths` / `skills.urls` — extra skill folders. VERIFIED: 1.17.6 also picks up
 *     `~/.claude/skills/*` on its own, which is worth knowing before mounting anything there.
 *   · `disabled_providers` / `enabled_providers`, `share`, `autoupdate`, `lsp`, `formatter`.
 *   · Per MESSAGE (POST /session/:id/message), not just per config: `agent`, `tools` (the same
 *     boolean map), `system`, `variant`, and `format` — where `format` may be
 *     `{ type: "json_schema", schema, retryCount }`. This line used to end "i.e. OpenCode has
 *     NATIVE structured output with retries, a better home for a wedge's `output_schema` than a
 *     sentence in the prompt". BOTH HALVES OF THAT ARE FALSE AT THIS PIN, and believing them cost
 *     a week of 100%-failing production runs. `retryCount` is decoded and then never read (the
 *     error is raised with a literal `retries: 0`), and the answer is delivered as a call to a
 *     synthetic `StructuredOutput` tool into `message.structured` — which this harness's event
 *     mapper cannot see — while any turn that answers in prose is hard-failed. Mycel therefore
 *     does NOT send `format`; the prompt states the schema and `runTask` validates against it.
 *     The full disassembly of the pinned binary's behaviour is in `startPrompt` in opencode.ts.
 *   · GET /permission + POST /permission/:requestID/reply (`once` | `always` | `reject`) — a
 *     first-class approval gate over HTTP, which is what `permission: "ask"` suspends on in server
 *     mode. See the note on `ask` below.
 *
 * NOT controllable, or not in 1.17.6 (see the report at the end of this comment's usefulness):
 *   · `subagent_depth` exists in the CURRENT published schema but is ABSENT from the 1.17.6 binary.
 *     Do not emit it; an unknown key is at best ignored.
 *   · There is no wall-clock or token BUDGET in opencode's config. `steps` bounds iterations, not
 *     time or spend. Time is ours (the orchestrator deadline); spend is LiteLLM's virtual key.
 *   · `permission: "ask"` is the honest way to gate a shell command by pattern, but it SUSPENDS
 *     until something replies on /permission/:id/reply. Headless with nobody listening, that is a
 *     hang, which is why every profile here uses allow/deny only.
 */
import type { Task } from "./contract";
import { isTier, resolveTier, wasClamped, type ModelTier } from "./models";
import type { LoadedWedge, WedgeManifest } from "./wedge";
import type { Plan } from "./identity";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/**
 * The kind of work, at the coarsest grain that changes the harness.
 *
 * Deliberately three and not thirty. A shape is not a task type — it is the answer to "does this
 * run write files, does it need credentials, and does it run for four minutes or forty". Everything
 * finer belongs in the per-task-type overrides.
 *
 *   · `decide`  — read, reason, produce a structured answer, maybe take one gated action.
 *                 Short, cheap, strict output, no filesystem writes.
 *   · `build`   — construct or alter software. Long, expensive, needs edit + shell + subagents,
 *                 free-form output, and NO real-world credentials whatsoever.
 *   · `general` — everything that existed before profiles did. The permissive default, kept so
 *                 that adding this file changed no wedge's behaviour until it opted in.
 */
export type HarnessShape = "decide" | "build" | "general";

const SHAPES: HarnessShape[] = ["decide", "build", "general"];
export const isShape = (v: unknown): v is HarnessShape => SHAPES.includes(v as HarnessShape);

export type PermissionAction = "allow" | "ask" | "deny";
/** Either a flat action, or glob-pattern → action (read/edit/glob/grep/list/bash/task/skill/...). */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;
export type PermissionMap = Record<string, PermissionRule>;

/**
 * The catastrophes, denied on every profile including `build`.
 *
 * VERIFIED behaviour that shapes this list: a bash rule map whose `"*"` entry is `deny` does not
 * merely block unmatched commands — it removes the `bash` tool from the model's toolset outright.
 * So "allow only `curl *`" is NOT expressible as `{ "curl *": "allow", "*": "deny" }`; that is
 * simply "no shell". Pattern rules are therefore usable for carving holes OUT of an allow default,
 * and not for building an allowlist. Every profile that keeps a shell keeps a broad one.
 */
const BASH_DENYLIST: Record<string, PermissionAction> = {
  "rm -rf /": "deny",
  "rm -rf /*": "deny",
  "rm -rf ~": "deny",
  "mkfs*": "deny",
  "dd if=*": "deny",
  ":(){ :|:& };:": "deny",
  // Nothing inside the sandbox should be reaching for the host's package manager or a shutdown.
  "shutdown*": "deny",
  "reboot*": "deny",
};

// ---------------------------------------------------------------------------------------------
// What a manifest may say
// ---------------------------------------------------------------------------------------------

/**
 * The harness block a founder may write in `wedge.json`, at the wedge level or under
 * `task_types.<name>.harness`. Every field is a REQUEST; nothing here can widen a server ceiling
 * or reach a tier the org's plan does not include.
 */
export interface HarnessProfileSpec {
  shape?: string;
  tier?: string;
  /** Wall-clock hint. Clamped to `MYCEL_MAX_RUNTIME_S`. */
  max_runtime_s?: number;
  /** Spend hint. Clamped to `MYCEL_MAX_COST_USD`. */
  max_cost_usd?: number;
  /** OpenCode `permission` overrides, merged over the shape's defaults. */
  permission?: PermissionMap;
  /** OpenCode `tools` booleans, merged over the shape's defaults. */
  tools?: Record<string, boolean>;
  /** Extra `instructions` files/globs to mount for THIS task type. */
  instructions?: string[];
  /** Skill filenames to index for THIS task type. Omit to index everything the wedge loaded. */
  skills?: string[];
  /**
   * May this run hold the action-proxy token (send/charge/book, read a connection, advance a case)?
   * Defaults per shape; `build` is false and saying `true` on a build shape is refused below.
   *
   * `needs_connections` is the same switch under the name the design doc uses, accepted because
   * this is the field a founder is most likely to reach for and least likely to get right from
   * memory. `actions` wins if somebody writes both — it is the narrower word for what it does, and
   * a silent tiebreak beats an error on the one field whose default is "no credentials".
   */
  actions?: boolean;
  needs_connections?: boolean;
  temperature?: number;
  /** OpenCode `agent.build.steps` — max agentic iterations before a forced text-only answer. */
  steps?: number;
  /** Ask OpenCode for native `format: {type:"json_schema"}` output rather than a prompt sentence. */
  strict_output?: boolean;
}

/** A task_type entry, with the harness block. Structural so `wedge.ts` need not import this. */
interface TaskTypeWithHarness {
  tier?: string;
  description?: string;
  output_schema?: unknown;
  harness?: HarnessProfileSpec;
}

// ---------------------------------------------------------------------------------------------
// What the runtime gets back
// ---------------------------------------------------------------------------------------------

/** A resolved, clamped, ready-to-use harness. Nothing downstream re-decides any of this. */
export interface HarnessProfile {
  shape: HarnessShape;
  task_type: string;
  /** Post-clamp. This is the tier that actually runs. */
  tier: ModelTier;
  /** What was asked for before the plan had its say — for the "we ran you cheaper" notice. */
  requested_tier: ModelTier;
  tier_clamped: boolean;
  max_runtime_s: number;
  max_cost_usd: number;
  permission: PermissionMap;
  tools: Record<string, boolean>;
  instructions: string[];
  /** Undefined means "index every skill the wedge loaded". */
  skills?: string[];
  /**
   * The least-privilege bit that matters most. False → no action grant is minted, no connection is
   * resolved, and MYCEL_ACTION_TOKEN is never placed in the sandbox's environment.
   */
  grants_actions: boolean;
  temperature?: number;
  steps?: number;
  strict_output: boolean;
  /** Long-lived runs get compaction and generous truncation; short ones get neither. */
  long_lived: boolean;
}

interface ShapeDefaults {
  tier: ModelTier;
  max_runtime_s: number;
  max_cost_usd: number;
  permission: PermissionMap;
  tools: Record<string, boolean>;
  grants_actions: boolean;
  strict_output: boolean;
  long_lived: boolean;
  temperature?: number;
  steps?: number;
}

/**
 * The two real profiles, plus the legacy default.
 *
 * These are the whole point of the file, so they are written out rather than composed: reading what
 * a `decide` run may and may not do should not require evaluating three levels of spread operator.
 */
export const SHAPE_DEFAULTS: Record<HarnessShape, ShapeDefaults> = {
  /**
   * DECIDE — the invoice-chaser's `chase_invoice`, and most of what a service business actually
   * buys. Read the case, read the knowledge, work out the next step, answer in the wedge's schema,
   * and possibly ask for one gated action.
   *
   * Cheap on purpose: this is a `fast`-tier judgement over a few kilobytes of context, and running
   * it on the deep tier is how the margin maths in models.ts stops working.
   *
   * On the shell: `bash` stays ALLOWED and that is not an oversight. The action proxy, the reads
   * proxy, the case API and the knowledge-gap API are all taught to the agent as `curl` commands
   * (see `buildAgentsMd`), so removing the shell removes the agent's entire control plane. What is
   * removed instead is everything a decision has no use for — `edit`/`write` (it produces an answer,
   * not a diff), `task` (no subagents to supervise), `webfetch`/`websearch` (a dunning decision is
   * made from the client's own history, not from the open internet). The remaining exposure is a
   * broad shell inside a disposable microVM holding no credential except a nonce that is revoked
   * when the run ends — which is the real boundary, and it is the action proxy, not the toolset.
   */
  decide: {
    /**
     * `standard`, not `fast`, and the reason is arithmetic rather than taste.
     *
     * This was `fast` (gpt-5-nano). A production run then called `bash` SEVENTY-TWO times, almost
     * every one rejected with `SchemaError: Missing key ["description"]`, never adapting, until the
     * task expired having produced nothing. The cheap model could not reliably satisfy a two-field
     * tool schema, and a model that cannot call a tool correctly does not become cheap by costing
     * less per token — it costs a whole run.
     *
     * The tier ladder still clamps DOWN by plan (`resolveTier`), so a free-tier org gets `fast`
     * anyway. This changes what we ASK for, not what a plan is allowed to have.
     */
    tier: "standard",
    /**
     * SEVEN MINUTES, AND THE UNIT THIS IS COUNTED IN IS COMPLETIONS, NOT SECONDS.
     *
     * This said 240 — "a decision that has not landed in four minutes is not going to land" — and
     * that sentence was written when a model completion took about ten seconds, so four minutes was
     * two dozen turns. In production a single completion now measures 85–95 seconds (LiteLLM spend
     * logs; the ALB idle timeout was raised 60 → 300 for exactly this). 240s is therefore not "four
     * minutes of thinking", it is TWO completions, and a decide run that reads one knowledge file
     * before answering has already spent both.
     *
     * The evidence is a week of `mycel:run` durations: p50 175s, with four runs finishing at 180.1,
     * 180.2, 180.6 and 180.8 seconds — the exact ceiling, killed mid-completion and reported to the
     * founder as a failure.
     *
     * 420s is four completions plus boot. It buys a real answer, a knowledge read, and one recovery
     * from a bad tool call. It is not a licence to loop: the contract watcher ends a run the moment
     * the answer exists, and `max_cost_usd` is the budget that actually bounds waste. A ceiling's job
     * is to catch a run that is stuck, not to interrupt one that is working.
     */
    max_runtime_s: 420,
    max_cost_usd: 0.5,
    /**
     * A true allowlist: deny everything, then name the six tools a decision actually uses.
     *
     * Written this way rather than as a list of denies because a denylist fails OPEN. Enumerating
     * `edit: "deny", task: "deny", webfetch: "deny"…` is only correct against the toolset that
     * exists today; the day opencode ships a seventh tool, every profile spelled as a denylist
     * silently acquires it, and nobody re-reads this file when a dependency is bumped. Denied by
     * default, a new tool arrives switched OFF and someone has to decide to switch it on.
     *
     * `"*"` MUST stay first — see finding (3) in the header. `orderPermission()` enforces it after
     * the merge, so a founder's JSON cannot accidentally push it to the back and empty the toolset.
     *
     * `invalid` is allowed deliberately: it is opencode's handler for a malformed tool call, and
     * denying it turns "the model emitted bad JSON" into a harder failure than it needs to be.
     *
     * `question` is NOT allowed, and this is the concrete bug the rewrite fixed rather than a
     * hypothetical. Feeding both spellings of this profile to the real 1.17.6 binary:
     *
     *   denylist  → bash,glob,grep,invalid,QUESTION,read,skill,todowrite
     *   allowlist → bash,glob,grep,invalid,read,skill,todowrite
     *
     * The denylist left `question` on because nobody thought to name it. `question` prompts a human
     * and blocks on the answer; there is no human on a queued run, so a model that reaches for it
     * hangs until the deadline kills it — the same failure mode as `permission: "ask"`, arrived at
     * by omission instead of by choice. That is what a fail-open list buys you.
     *
     * (`list` is named below and does not appear in any toolset: it is a permission key without a
     * corresponding tool in 1.17.6. Harmless, and kept so the allowlist stays readable as intent.)
     */
    permission: {
      "*": "deny",
      invalid: "allow",
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      skill: "allow",
      todowrite: "allow",
      bash: { ...BASH_DENYLIST, "*": "allow" },
    },
    // Empty on purpose. `tools` and `permission` are one lever with two spellings — 1.17.6 folds
    // `tools` into `permission` at load — and stating a restriction twice invites the two copies to
    // disagree. The allowlist above is the single source of truth.
    tools: {},
    grants_actions: true,
    strict_output: true,
    long_lived: false,
    // Near-deterministic: the same overdue invoice with the same history should not produce a
    // "final notice" on Tuesday and a "gentle nudge" on Wednesday.
    temperature: 0.1,
    steps: 40,
  },

  /**
   * BUILD — constructing or altering the founder's own Next.js product.
   *
   * Long, expensive, and file-shaped. It needs `edit`, `write`, a real shell (npm, git, the dev
   * server), `webfetch` for library docs, and subagents. What it does NOT need, ever, is a
   * credential that reaches the outside world on the founder's behalf.
   *
   * `grants_actions: false` is the load-bearing line in this file. No action grant is minted, so
   * there is no MYCEL_ACTION_TOKEN in the sandbox, so `$MYCEL_ACTIONS_URL` answers 401 to anything
   * the model tries — and no connection is resolved for the run at all, which is the cheapest
   * security win available here: the run cannot leak a mailbox it was never told about. A build
   * agent that decides the fastest way to test its work is to email a customer simply cannot.
   *
   * This is also why the plugin's name-substring gate is not the defence. `isGated()` in plugin.ts
   * matches on TOOL NAME against a substring list — "send", "email", "pay", "delete" — and the tool
   * a build uses is called `bash`, which matches nothing in that list. A shell-enabled profile is
   * therefore effectively UNGATED at the plugin layer: `bash` can `curl` anywhere, write any file,
   * and run any binary in the image, and the plugin will not see it. Only two things constrain it:
   * the sandbox is disposable and network-isolated from our control plane except through the nonce,
   * and it holds no nonce. Withholding the token is the control; the plugin is not.
   */
  build: {
    tier: "deep",
    /**
     * An hour, clamped by MYCEL_MAX_RUNTIME_S (3600 by default, so this is the ceiling).
     *
     * The old flat 300s default is why a live run burned 165k tokens and was killed mid-think:
     * scaffolding an app is not a five-minute job and never was. Thirty minutes replaced it, and
     * thirty minutes is now too few for a different reason: the production build is a TOOL the
     * agent calls (`mycel-build`, remotebuild.ts) and it BLOCKS while CodeBuild runs. Three
     * attempts at three to six minutes each is up to ~18 minutes of this budget spent watching a
     * compiler, which at 1800s left about ten for reading a codebase, making a change and fixing
     * what the first build found. The entire value of the tool is that the agent reads a real build
     * error and fixes it in the same run; a budget that expires during the fix throws that away and
     * pays for it twice.
     */
    max_runtime_s: 3600,
    max_cost_usd: 5,
    /**
     * Allow-by-default, and unlike `decide` that is the right call here rather than laziness.
     *
     * A build wants the whole toolset — that is what distinguishes it — so an allowlist would be a
     * transcription of the tool registry that has to be edited every time opencode adds something,
     * and would fail closed in the one shape where a missing tool means the work silently cannot be
     * done. The security boundary for a build is not the toolset at all; it is `grants_actions:
     * false` below. Constrain what it can REACH, not what it can RUN.
     *
     * `edit: "allow"` covers `write` too (they are one permission — header, finding 1), so there is
     * no `write` line here; it would be decoration.
     */
    permission: {
      "*": "allow",
      // Reading outside the workspace is the one hole worth closing even here: the sandbox is
      // disposable, but /proc and the environment of a neighbouring process are not the job.
      external_directory: "deny",
      // No human is listening, so a tool that asks one is a tool that hangs the run.
      question: "deny",
      bash: { ...BASH_DENYLIST, "*": "allow" },
    },
    tools: {},
    grants_actions: false,
    // A build's deliverable is a repository, not a JSON object. Forcing a schema on it produces a
    // model that stops working in order to describe its work.
    strict_output: false,
    long_lived: true,
    temperature: undefined,
    // High, because a build legitimately takes hundreds of turns. `steps` is opencode's only
    // built-in stop, and it stops with a text answer rather than an error.
    steps: 400,
  },

  /**
   * GENERAL — what every task got before this file existed, preserved exactly.
   *
   * `"*": "allow"` with only the catastrophes denied. Kept as the default so that introducing
   * profiles changed no running wedge's behaviour: a task type opts into a tighter harness by
   * declaring a shape, it is not silently moved into one.
   */
  general: {
    tier: "standard",
    // Ten minutes rather than the old five. Still clamped by the ceiling, and still the shape that
    // nobody has thought about — which is exactly why it should not be the tightest.
    max_runtime_s: 600,
    max_cost_usd: 2,
    permission: { "*": "allow", bash: { ...BASH_DENYLIST } },
    tools: {},
    grants_actions: true,
    strict_output: false,
    long_lived: false,
  },
};

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export interface ResolveHarnessArgs {
  task: Task;
  wedge: LoadedWedge | null;
  /** The org's plan, for the tier ceiling. Undefined behaves as `self_hosted` (see models.ts). */
  plan?: Plan;
  /**
   * The org runs without ceilings (see `superadmin.ts`). Defaults false, so every existing caller —
   * and every test — keeps the plan's ceiling, and forgetting to pass it can only ever produce the
   * safe answer rather than a free upgrade to the most expensive model we run.
   */
  unlimited?: boolean;
  /** Server ceilings from `loadConfig()`. Nothing a manifest says may exceed these. */
  ceilings: { maxRuntimeS: number; maxCostUsd: number };
}

/**
 * Resolve the harness for one run.
 *
 * Precedence, narrowest wins: shape defaults → wedge-level `harness` → `task_types.<t>.harness` →
 * the task's own `input.tier`. Then the plan clamps the tier and the server clamps the budgets.
 *
 * Every input here is untrusted JSON or a caller-supplied body, so every field is validated rather
 * than spread: a manifest saying `"tier": "godmode"` or `"max_cost_usd": 1e9` must produce a
 * sensible run, not a crash and not a blank cheque.
 */
export function resolveHarnessProfile(args: ResolveHarnessArgs): HarnessProfile {
  const { task, wedge, plan, ceilings, unlimited = false } = args;
  const manifest = wedge?.manifest as (WedgeManifest & { harness?: HarnessProfileSpec }) | undefined;
  const tt = manifest?.task_types?.[task.task_type] as TaskTypeWithHarness | undefined;

  const wedgeSpec = sanitizeSpec(manifest?.harness);
  const typeSpec = sanitizeSpec(tt?.harness);

  const shape: HarnessShape =
    (isShape(typeSpec.shape) ? typeSpec.shape : undefined) ??
    (isShape(wedgeSpec.shape) ? wedgeSpec.shape : undefined) ??
    "general";
  const base = SHAPE_DEFAULTS[shape];

  /**
   * The tier request, narrowest first. `task_types.<t>.tier` is kept as an alias for
   * `task_types.<t>.harness.tier` because wedges already use it and breaking them to gain a nesting
   * level would be a poor trade.
   */
  const requested: ModelTier =
    (isTier(task.input?.tier) ? task.input.tier : undefined) ??
    (isTier(typeSpec.tier) ? typeSpec.tier : undefined) ??
    (isTier(tt?.tier) ? (tt!.tier as ModelTier) : undefined) ??
    (isTier(wedgeSpec.tier) ? wedgeSpec.tier : undefined) ??
    (isTier(manifest?.tier) ? (manifest!.tier as ModelTier) : undefined) ??
    base.tier;

  // The plan decides. A profile that asks for `deep` on a free org gets `fast` and the run happens
  // anyway — same contract as everywhere else in the system.
  const tier = resolveTier(requested, plan, unlimited);

  const max_runtime_s = clampPositive(
    typeSpec.max_runtime_s ?? wedgeSpec.max_runtime_s ?? base.max_runtime_s,
    ceilings.maxRuntimeS,
    base.max_runtime_s,
  );
  const max_cost_usd = clampPositive(
    typeSpec.max_cost_usd ?? wedgeSpec.max_cost_usd ?? base.max_cost_usd,
    ceilings.maxCostUsd,
    base.max_cost_usd,
  );

  /**
   * A build never holds the action token — not even if the manifest asks for it.
   *
   * This is the one place a founder's own JSON is overruled rather than merged. The reason is that
   * `shape: "build"` is a claim about what the run does, and "this run edits my source tree" and
   * "this run may email my customers" should not be true at the same time. If a wedge genuinely
   * needs both, that is two task types, and splitting them is the point.
   */
  const grants_actions =
    shape === "build"
      ? false
      : (typeSpec.actions ??
        typeSpec.needs_connections ??
        wedgeSpec.actions ??
        wedgeSpec.needs_connections ??
        base.grants_actions);

  return {
    shape,
    task_type: task.task_type,
    tier,
    requested_tier: requested,
    tier_clamped: wasClamped(requested, plan, unlimited),
    max_runtime_s,
    max_cost_usd,
    // Narrowest last: a task type may open or close a specific tool without restating the shape.
    // `orderPermission` then pins `"*"` to the front, because a wildcard that lands last empties
    // the toolset outright rather than erroring — see finding (3) in the header.
    permission: orderPermission({ ...base.permission, ...wedgeSpec.permission, ...typeSpec.permission }),
    tools: { ...base.tools, ...wedgeSpec.tools, ...typeSpec.tools },
    // AGENTS.md is always first — it is the file the runtime writes and everything else supplements.
    instructions: dedupe(["AGENTS.md", ...(wedgeSpec.instructions ?? []), ...(typeSpec.instructions ?? [])]),
    skills: typeSpec.skills ?? wedgeSpec.skills,
    grants_actions,
    temperature: typeSpec.temperature ?? wedgeSpec.temperature ?? base.temperature,
    steps: typeSpec.steps ?? wedgeSpec.steps ?? base.steps,
    strict_output: typeSpec.strict_output ?? wedgeSpec.strict_output ?? base.strict_output,
    long_lived: base.long_lived,
  };
}

/**
 * The profile a caller should ask for when creating a task of this type, before a Task exists.
 *
 * Exported because the runtime is the WRONG place for `max_runtime_s` to take effect and pretending
 * otherwise would be dishonest: `runTask` in orchestrator.ts captures its deadline from
 * `task.constraints` before it ever enters the runtime, so by the time a profile is resolved the
 * clock is already set. The fix is for the task-creation path to default the constraint from the
 * profile instead of from a flat 300 — one call, here, so that the number lives in one place.
 */
export function profileConstraintDefaults(
  wedge: LoadedWedge | null,
  taskType: string,
  ceilings: { maxRuntimeS: number; maxCostUsd: number },
): { max_runtime_s: number; max_cost_usd: number } {
  const profile = resolveHarnessProfile({
    task: { task_type: taskType, input: {} } as Task,
    wedge,
    ceilings,
  });
  return { max_runtime_s: profile.max_runtime_s, max_cost_usd: profile.max_cost_usd };
}

// ---------------------------------------------------------------------------------------------
// Validation helpers — every caller of these is holding founder-authored JSON
// ---------------------------------------------------------------------------------------------

/** Keep only the fields we understand, in the types we understand. Silently drops the rest. */
function sanitizeSpec(raw: unknown): HarnessProfileSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const s = raw as Record<string, unknown>;
  const out: HarnessProfileSpec = {};
  if (typeof s.shape === "string") out.shape = s.shape;
  if (typeof s.tier === "string") out.tier = s.tier;
  if (isFinitePositive(s.max_runtime_s)) out.max_runtime_s = s.max_runtime_s;
  if (isFinitePositive(s.max_cost_usd)) out.max_cost_usd = s.max_cost_usd;
  const perm = sanitizePermission(s.permission);
  if (perm) out.permission = perm;
  const tools = sanitizeBooleanMap(s.tools);
  if (tools) out.tools = tools;
  const instructions = sanitizeStrings(s.instructions);
  if (instructions) out.instructions = instructions;
  const skills = sanitizeStrings(s.skills);
  if (skills) out.skills = skills;
  if (typeof s.actions === "boolean") out.actions = s.actions;
  if (typeof s.needs_connections === "boolean") out.needs_connections = s.needs_connections;
  // Temperature outside [0,2] is not a preference, it is a typo that would fail the provider call.
  if (typeof s.temperature === "number" && s.temperature >= 0 && s.temperature <= 2) {
    out.temperature = s.temperature;
  }
  if (isFinitePositive(s.steps)) out.steps = Math.min(Math.floor(s.steps), 1000);
  if (typeof s.strict_output === "boolean") out.strict_output = s.strict_output;
  return out;
}

const ACTIONS: PermissionAction[] = ["allow", "ask", "deny"];
const isAction = (v: unknown): v is PermissionAction => ACTIONS.includes(v as PermissionAction);

/**
 * Permission maps, one level deep.
 *
 * Anything that is not an action or a pattern→action object is dropped rather than passed through,
 * because opencode reads this config at startup and a malformed `permission` block is a sandbox
 * that never becomes ready — which surfaces as "opencode failed to start" sixty seconds later, with
 * the cause buried in a log inside a container that is about to be destroyed.
 */
function sanitizePermission(raw: unknown): PermissionMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: PermissionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isAction(value)) {
      out[key] = value;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const rules: Record<string, PermissionAction> = {};
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        if (isAction(action)) rules[pattern] = action;
      }
      if (Object.keys(rules).length) out[key] = rules;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeBooleanMap(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeStrings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length ? out : undefined;
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Requests below the ceiling are honoured; above it are clamped; nonsense falls back. */
function clampPositive(want: number, ceiling: number, fallback: number): number {
  const c = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : fallback;
  if (!Number.isFinite(want) || want <= 0) return Math.min(fallback, c);
  return Math.min(want, c);
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/**
 * Put `"*"` first, if it is there at all.
 *
 * Not cosmetic. Verified against the real opencode 1.17.6 binary with `opencode debug agent build`:
 * `{"*": "deny", read: "allow"}` hands the model `read`, while `{read: "allow", "*": "deny"}` — the
 * same two rules, written in the other order — hands it NOTHING. An agent with an empty toolset
 * does not crash; it sits there producing text about what it would do, which is the most expensive
 * possible way to discover a config bug.
 *
 * This object is built by spreading founder-authored JSON over our defaults, and JS spread keeps a
 * key at the position of its FIRST appearance. So a wedge that adds `"*"` to a shape whose defaults
 * have none gets it appended at the end — silently, and only for that one wedge. Pinning it here
 * costs one object rebuild per run and removes the entire class of failure.
 */
function orderPermission(merged: PermissionMap): PermissionMap {
  if (!("*" in merged)) return merged;
  const { "*": wildcard, ...rest } = merged;
  return { "*": wildcard, ...rest };
}
