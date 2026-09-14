// WHAT THE FIRST RUN WILL DO, SAID AT BOOT INSTEAD OF DISCOVERED SIXTY SECONDS LATER.
//
// ═══ THE TWO FAILURES THIS EXISTS FOR ═══
//
// Both were found by cloning the published repo and following its own README as a stranger would.
// Neither is a bug in the kernel: in both cases the kernel does exactly what it was configured to
// do. They are failures of DISCLOSURE, and they land on the one run that decides whether someone
// keeps going.
//
//   1. THE SILENT HANG. Defaults are `MYCEL_RUNTIME=opencode`, `MYCEL_SANDBOX=local`. A fresh clone
//      has no `opencode` binary, so the first task sits in `running` at step `start_opencode` for
//      SIXTY SECONDS and then fails with `opencode failed to start (no log)`. There is no log
//      because the process never existed. The message names the proximate cause and none of the
//      three things that would fix it, and it arrives long after the person has decided the product
//      is broken. Sixty seconds of nothing is worse than an error, because an error can be pasted
//      into a search box.
//
//   2. THE `[mock]` TRAP, which is the exact opposite shape and more expensive. `MYCEL_RUNTIME=mock`
//      needs no binary and no key and every task SUCCEEDS — `status: completed`, output validated
//      against the wedge's real schema, the whole contract exercised. And every string field
//      contains the literal `[mock]`, because `runtime.mock.ts` stamps a placeholder it deliberately
//      never varies. Someone who set this to get past failure 1 now sees a product that works and
//      writes gibberish, which reads as a broken model rather than as an unconfigured runtime.
//
// ═══ WHY WARN AND NOT EXIT ═══
//
// `sandboxPreflight` exits the process, and is right to: it guards a hosted fleet where a node that
// accepts tasks and fails all of them looks green to a load balancer. This one must NOT exit. A
// kernel with no agent runtime is still a legitimate thing to run — it serves the portal, it takes
// the demo seed, it answers `/v1/moves`, and `npm test` drives the whole contract through the mock.
// Refusing to boot would break `npm run demo`, which is the one path in the README explicitly
// designed to need no keys at all.
//
// So: say the true thing loudly, name every way forward, and get out of the way.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { MycelConfig } from "./config";
import { providerEnvVar, splitModel } from "./opencode";
import { PROVIDERS, resolveAll, shortestPath, type Capability } from "./gtm/providers";

/**
 * `command -v`, without a shell. PATHEXT is honoured so this is not silently Unix-only.
 *
 * Takes the env EXPLICITLY rather than reading `process.env` inline. `runtimeAdvisories` already
 * accepted an injected env for exactly this reason, then reached around its own parameter here —
 * so the missing-binary advisory was untestable on any machine that HAD the binary: the suite
 * passed an empty env, `onPath` consulted the real PATH, found a developer's opencode install, and
 * the assertion failed only on machines where the product worked. A check whose result depends on
 * whose laptop runs it is the class of bug this repo keeps finding in itself.
 */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? ((env.PATHEXT ?? process.env.PATHEXT) ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}

/**
 * Lines to print after the boot banner. Returns `[]` when the install is actually able to do work,
 * which is the common case in production and keeps a healthy boot quiet.
 *
 * Pure and exported so the tests can assert the sentences rather than the formatting — the value
 * here is entirely in what is said, and a warning that stops naming the remedy has regressed even
 * though it still appears.
 */
export function runtimeAdvisories(cfg: MycelConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (cfg.runtime === "mock") {
    return [
      `MYCEL_RUNTIME=mock — no agent runs, and every task will still SUCCEED.`,
      `Output is generated from each wedge's real output schema, so the contract is`,
      `genuinely exercised, but every string field contains the literal "[mock]".`,
      `That is the fake runtime, not a broken model. For real work, unset`,
      `MYCEL_RUNTIME and give the kernel an agent (see below).`,
    ];
  }

  const problems: string[] = [];
  // Only `local` runs the binary on this machine; docker and daytona ship it inside the image, so
  // asking the host for it there would be a false alarm on a correct install.
  if (cfg.sandboxBackend === "local" && !onPath("opencode", env)) {
    problems.push(
      `The "opencode" binary is not on PATH, and MYCEL_SANDBOX=local runs it here.`,
      `Every task will sit in "running" for 60s and then fail "opencode failed to start".`,
    );
  }

  // The other half: a binary with nothing to call. In proxy mode the harness holds the key and the
  // sandbox is meant to have none, so the check moves to the upstream the proxy would forward to.
  // Hosted installs broker via LiteLLM (`MYCEL_LITELLM_URL` + master key) — that IS the upstream,
  // so requiring OPENAI_API_KEY / MYCEL_LLM_UPSTREAM on top was a false alarm that fired on every
  // healthy prod boot (observed 2026-08-11).
  const { providerId } = splitModel(cfg.model);
  const keyVar = providerEnvVar(providerId);
  if (cfg.proxyMode) {
    const hasLiteLLM = !!(env.MYCEL_LITELLM_URL && env.MYCEL_LITELLM_MASTER_KEY);
    if (!env[keyVar] && !env.MYCEL_LLM_UPSTREAM && !hasLiteLLM) {
      problems.push(
        `MYCEL_PROXY_MODE=1 but neither ${keyVar}, MYCEL_LLM_UPSTREAM, nor MYCEL_LITELLM_URL+MYCEL_LITELLM_MASTER_KEY is set — the proxy has nothing to forward to.`,
      );
    }
  } else if (!env[keyVar]) {
    problems.push(`${keyVar} is not set, and the model is ${cfg.model} — the agent will have no credentials.`);
  }

  if (!problems.length) return [];
  return [
    ...problems,
    ``,
    `Ways forward:`,
    `  · npm run demo          a seeded business on the mock runtime, no keys, nothing to install`,
    `  · MYCEL_RUNTIME=mock    canned runs (read the "[mock]" note above before you judge output)`,
    `  · MYCEL_SANDBOX=docker  run the agent in a container instead of on this machine`,
    `  · install OpenCode (https://opencode.ai) and export ${keyVar}=…   ← real work`,
  ];
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE OUTSIDE-SERVICE SLOTS ARE SET TO, PRINTED WHERE SOMEBODY WILL SEE IT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `GET /v1/gtm/availability` already answers this well: which capability is on, which vendor is
 * running it, and the one variable that would turn on each one that is off. It is also behind a
 * bearer token, at a path nobody guesses, in a product whose first five minutes happen in a
 * terminal. Measured on a cold clone: the endpoint gives a stranger everything, and boot — the only
 * thing they actually read — said nothing about it at all.
 *
 * So the same facts, four lines, at the moment the question occurs.
 *
 * ═══ IT IS NOT A WARNING, AND MUST NOT LOOK LIKE ONE ═══
 *
 * Every other block on this screen is a `⚠` about something that will go wrong. NONE of these is a
 * problem: the entire GTM path runs on a connected LinkedIn account with no key at all, and these
 * providers only widen the top of the funnel. Dressing "off" as a warning would teach a new user
 * that a correct install is broken, which is the specific misreading `works_without_keys` exists to
 * prevent on the endpoint.
 *
 * ═══ AND IT IS SILENT WHEN THERE IS NOTHING TO SAY ═══
 *
 * An operator who has configured their providers does not need them recited on every restart, and a
 * boot banner that prints the same paragraph forever is one people stop reading — which would cost
 * the advisories above their audience too. All on, nothing printed.
 */
export function providerAdvisories(env: NodeJS.ProcessEnv = process.env): string[] {
  const all = resolveAll(env as Record<string, string | undefined>);
  const off = all.filter((r) => !r.chosen && !r.problem);
  const broken = all.filter((r) => r.problem);
  if (!off.length && !broken.length) return [];

  const label = (c: Capability): string =>
    ({ search: "Web search", places: "Places", crawl: "Page crawling", enrich: "Email lookup" })[c];

  const lines: string[] = [
    `Outside services: ${all.length - off.length - broken.length}/${all.length} on. These widen the top of the funnel;`,
    `finding people, inviting, messaging and replies need no key at all.`,
    ``,
  ];
  for (const r of all) {
    if (r.problem) {
      lines.push(`  ✗ ${label(r.capability).padEnd(14)} ${r.problem}`);
      continue;
    }
    if (r.chosen) {
      lines.push(`  ✓ ${label(r.capability).padEnd(14)} ${r.chosen.label}`);
      continue;
    }
    // The shortest path only. A list of three vendors reads as three things to do, and the honest
    // answer to "how do I turn this on" is one of them.
    const first = shortestPath(PROVIDERS[r.capability])!;
    const rest = PROVIDERS[r.capability].filter((o) => o.implemented && o.id !== first.id).length;
    lines.push(
      `  · ${label(r.capability).padEnd(14)} off — set ${first.env} (${first.signup})` +
        (rest ? `, or ${rest} other${rest > 1 ? "s" : ""}` : ""),
    );
  }
  lines.push(``, `  Full detail, read live from this process: GET /v1/gtm/availability`);
  return lines;
}
