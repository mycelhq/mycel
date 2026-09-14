/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY /v1 ROUTE EITHER CHECKS THE TENANT OR IS A DELIBERATE PUBLIC DOOR
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * On 12 September the demo tenant was writable by anyone who opened it, because the one middleware
 * protecting it was keyed on an org id that no longer matched. Three services ran that guard on
 * every request and it protected nothing. The lesson recorded then was "check the RESOURCE, never
 * the config" — this is the other half: check that every door HAS a lock, mechanically, rather than
 * trusting that whoever added the last route remembered.
 *
 * ═══ WHAT COUNTS AS A CHECK, AND WHY THE FIRST TWO ATTEMPTS WERE WRONG ═══
 *
 * A route is scoped if it, or a helper it calls, or a middleware over its prefix, establishes who is
 * asking. Getting that wrong in either direction makes this worthless:
 *
 *   · My first pass looked only for `inScope(`/`accessible(` inside the handler and reported 147 of
 *     332 routes unscoped. Most were fine. `invoices.routes.ts` resolves its tenant through a local
 *     `readProject(c)` closure that calls `accessible(c)` and refuses a project the caller cannot
 *     reach — the check is one line further up the file.
 *   · My second pass still flagged 67, almost all `/v1/portal/*`. Those are covered by a PREFIX
 *     MIDDLEWARE that resolves the client session and answers 401 without one, and they read it
 *     through `client(c)` — a one-line arrow the helper detector did not recognise.
 *
 * A measurement that cries wolf gets ignored, and an ignored security check is worse than none. So
 * this understands all three shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * Anything that establishes WHO is asking, or refuses when it cannot.
 *
 * FOUR MECHANISMS, because this system genuinely has four and a check that knows only one is the
 * scanner crying wolf:
 *
 *   · a member session      — `accessible(c)`, `inScope(...)`, `writeProjectId(c)`
 *   · a client portal token — `c.get("client")`, established by the `/v1/portal/*` middleware
 *   · a per-task action grant — `getActionGrant(...)`, which the SANDBOX holds; every
 *     `/v1/internal/*` data route resolves the task from it and 401s without one
 *   · a shared gate token   — `safeEqual(token, loadConfig().gateToken)` on the policy gate
 *   · a build or proxy grant — `getBuildGrant(...)`, `getGrant(...)`: the same one-task, dies-with-it
 *     shape as an action grant, for the build callback and the model proxy
 *
 * The last two are how a run calls home. They are not weaker than a session — a grant is scoped to
 * ONE task and dies with it — but they look nothing like one in the source.
 */
const DIRECT =
  /inScope\(|accessible\(|writeProjectId\(|requireSuperadmin|c\.get\("client"\)|c\.get\("scope"\)|isShowroomOrg|client\(c\)|scope\(c\)|c\.get\("party"\)|getActionGrant\(|getBuildGrant\(|getGrant\(|safeEqual\(/;

/**
 * Public by design. Every entry is a door somebody opened deliberately, and the reason is the point
 * of listing them here rather than pattern-matching a prefix: an unexplained exemption is how a
 * private route ends up looking public enough to skip.
 */
const PUBLIC: Array<[RegExp, string]> = [
  [/^\/v1\/auth\//, "the doors themselves — signup, login, reset, verify"],
  [/^\/v1\/(health|ready|version|meta)\b/, "liveness and build metadata, no tenant data"],
  [/^\/v1\/webhooks?\//, "signature-verified at the edge, not session-scoped"],
  [/^\/v1\/(stripe|agentmail|composio)\//, "provider callbacks, verified by provider signature"],
  [/^\/v1\/(invites|signup-invites)\/:token/, "the token IS the credential; there is no session yet"],
  [/^\/v1\/blueprints\/:slug$/, "the catalogue we publish — the same content as the marketing site"],
  [/^\/v1\/wedges$/, "the list of services we ship; the marketing site prints the same thing"],
  [/^\/v1\/skills\/library$/, "the shared, operator-managed library — not one tenant's. The POST is key-only"],
  [/^\/v1\/meetings\/complete$/, "the bot posts a per-join token, validated by completeJoin against the join it was minted for"],
  [/^\/p\/:token$/, "the portal short link; the token is the credential, same shape as /v1/invites/:token"],
  [
    /^\/v1\/(portal|party)\/session$/,
    "the door each scope is minted at — its own middleware skips it by path, exactly as /v1/auth/login is skipped",
  ],
];

/**
 * ═══ AUTHENTICATED IS NOT THE SAME AS TENANT-SCOPED, AND THIS TEST IS ABOUT THE SECOND ═══
 *
 * Every `/v1` route already sits behind `app.use("/v1/*")`, which establishes a scope and refuses
 * without one except for a named handful of doors (`login`, `signup`, `reset`, `verify/confirm`).
 * So nothing below is anonymous.
 *
 * What this checks is the layer above: a route that touches ONE TENANT'S data must establish which
 * tenant. That is the failure that made the demo writable — the request was authenticated the whole
 * time. The exemptions above are routes that are authenticated and touch no tenant's data, or whose
 * credential IS the path token.
 */

/**
 * Blank comments, keep newlines, and DO NOT EAT STRINGS.
 *
 * A regex stripper cannot do this job in this codebase, and the way it fails is silent. Hono route
 * patterns end in `/*` — `app.use("/v1/portal/*", …)` — so `/\/\*[\s\S]*?\*\//` treats the inside of
 * that string literal as the start of a comment and blanks everything up to the next `*\/`, which
 * in a file this size is hundreds of lines. The scan then found ZERO middlewares in the entire
 * kernel and reported every portal route as unguarded.
 *
 * That is the worst shape a security check can take: it does not error, it does not find nothing —
 * it finds a plausible list of holes that are not holes, and the real one would be lost in it.
 *
 * So this walks the source once, tracking whether it is inside a string, a template or a comment.
 * Newlines survive so line-based rules still work; everything else in a comment becomes a space.
 */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "'" | '"' | "`";
  let state: State = "code";
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } else out += " ";
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " "; i++; continue;
    }
    // Inside a string or template: copy verbatim, honour escapes, close on the matching quote.
    if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
    if (c === state) state = "code";
    out += c; i++;
  }
  return out;
}

/**
 * The block starting at `open` (the index of its `{`), to its matching close.
 *
 * Brace-counting rather than a character budget, because every fixed window in this repo has
 * eventually reached into the next function and reported its neighbour's virtue as its own. Strings
 * are already blanked by `blankComments`, so a brace inside a literal cannot unbalance this.
 */
function bodyOf(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

interface Route {
  method: string;
  path: string;
  file: string;
  scoped: boolean;
  publicWhy?: string;
}

function scan(): Route[] {
  const files = readdirSync(SRC)
    .filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))
    .map((f) => [f, blankComments(readFileSync(join(SRC, f), "utf8"))] as const);

  /*
    ① Prefix middlewares, collected across EVERY file before any route is judged.

    Per-file was wrong and the scan said so out loud: `app.use("/v1/portal/*", …)` is registered in
    `server.ts`, and half the portal routes live in `portal-threads.ts` and `requests.routes.ts`.
    Scoped by a guard in another file is still scoped — Hono mounts them all on one app.
  */
  const guarded: RegExp[] = [];
  for (const [, src] of files) {
    for (const m of src.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*async\s*\(c[^)]*\)\s*=>\s*\{/g)) {
      const body = src.slice(m.index + m[0].length, m.index + m[0].length + 1200);
      /*
        SETTING A SCOPE IS NOT GUARDING. A middleware must establish who is asking AND refuse when it
        cannot — `if (!scope) return c.json({ error: "unauthorized" }, 401)`. The first version
        accepted either, so deleting that refusal left the test green while every portal route began
        receiving a null client. Caught by sabotage.
      */
      // Three scope names, because there are three kinds of caller: a member, a client in the
      // portal, and a third party answering one request (`/v1/party/*`).
      const establishes = /c\.set\("(client|scope|party)"/.test(body);
      const refuses = /unauthorized|\b401\b|\b403\b/.test(body);
      if (establishes && refuses) {
        guarded.push(new RegExp("^" + m[1]!.replace(/\*/g, ".*").replace(/\//g, "\\/")));
      }
    }
  }

  const out: Route[] = [];
  for (const [f, src] of files) {
    // ② Local helpers that check, including single-expression arrows.
    const helpers = new Set<string>();
    /*
      `(?:=>)?` — an OPTIONAL arrow. The first version wrote `=>?`, which reads as "an `=` then an
      optional `>`" and therefore REQUIRES an equals sign. So it matched arrow consts and could not
      match a `function` declaration at all: `function allowOps(c: any): boolean {` — the superadmin
      check guarding every /v1/ops route — was invisible, and six correctly-guarded routes were
      reported as holes. Two characters, and the difference between a security scan and a rumour.
    */
    for (const m of src.matchAll(
      /*
        NESTED PARENS IN THE PARAMETER LIST, because TypeScript puts them there:
        `const ownedSub = async (c: import("hono").Context) => {`. `\([^)]*\)` stops at the `)` of
        `import("hono"` and the match dies, so `ownedSub` and `composioConn` — both of which call
        `inScope(accessible(c), …)` — were invisible and their routes read as holes.
      */
      /(?:const|function)\s+(\w+)\s*(?:=\s*)?(?:async\s*)?\((?:[^()]|\([^()]*\))*\)\s*(?::[^=;{]+)?(?:=>)?\s*\{/g,
    )) {
      /*
        THE HELPER'S OWN BODY, bounded by its braces — not a fixed window.

        This took 900 characters from the match, which in `invoices.routes.ts` reaches past the end
        of `readProject` and into `owned` twenty lines below. `owned` calls `accessible(`, so
        `readProject` was credited with a check it did not make: sabotage replaced its
        `accessible(c)` with a header read and the test stayed green. A security check that cannot
        be sabotaged is not a check.
      */
      if (DIRECT.test(bodyOf(src, m.index + m[0].length - 1))) helpers.add(m[1]!);
    }
    const helperCall = helpers.size ? new RegExp(`\\b(${[...helpers].join("|")})\\s*\\(`) : null;

    // ③ The routes themselves.
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*async\s*\(c[^)]*\)\s*=>\s*\{/g)) {
      const rest = src.slice(m.index + m[0].length);
      const end = rest.search(/app\.(get|post|put|patch|delete)\(/);
      const body = rest.slice(0, end === -1 ? 3000 : end);
      const path = m[2]!;
      const pub = PUBLIC.find(([re]) => re.test(path));
      out.push({
        method: m[1]!.toUpperCase(),
        path,
        file: f,
        scoped: DIRECT.test(body) || (helperCall?.test(body) ?? false) || guarded.some((g) => g.test(path)),
        publicWhy: pub?.[1],
      });
    }
  }
  return out;
}

const routes = scan();

test("the scanner finds the routes at all", () => {
  // A scanner that silently matches nothing would make every assertion below vacuously true — the
  // exact failure mode of a guard that runs and does nothing.
  assert.ok(routes.length > 250, `only ${routes.length} routes found — the scanner has stopped working`);
  assert.ok(
    routes.some((r) => r.path === "/v1/portal/me"),
    "a known portal route is missing, so the scan is not reaching server.ts",
  );
});

test("EVERY ROUTE IS SCOPED, OR PUBLIC WITH A REASON WRITTEN DOWN", () => {
  const naked = routes.filter((r) => !r.scoped && !r.publicWhy);
  assert.deepEqual(
    naked.map((r) => `${r.method} ${r.path} (${r.file})`),
    [],
    "these read or write without establishing who is asking — add the check, or add it to PUBLIC with the reason",
  );
});

test("and the public list stays small and used", () => {
  /**
   * An exemption list is only safe while somebody can read the whole of it. If this grows, the
   * question to ask is whether a new prefix middleware belongs there instead — which is what
   * `/v1/portal/*` already is.
   */
  const exempt = routes.filter((r) => r.publicWhy);
  /*
    33 today, and the number is the point rather than the round figure I first guessed. Every one is
    a door somebody opened deliberately: six auth routes, four liveness/metadata reads, the
    provider callbacks that verify their own signatures, three token-is-the-credential links, and
    two catalogue reads that print what the marketing site prints, and the two session doors each
    scope is minted at. A cap slightly above the real count is a ratchet; a round number is a wish.
  */
  assert.ok(
    exempt.length <= 34,
    `${exempt.length} routes are exempt — the list is no longer reviewable:\n  ` +
      exempt.map((r) => `${r.method} ${r.path} — ${r.publicWhy}`).join("\n  "),
  );
  for (const [re, why] of PUBLIC) {
    assert.ok(why.length > 15, `an exemption with no reason: ${re}`);
  }
});
