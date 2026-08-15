// The contract between the kernel and the app it generates.
//
// `business-template/lib/kernel.ts` is the only way the generated business app reaches Mycel. It is
// hand-written rather than generated from `contract.ts` — deliberately, because `contract.ts`
// describes the OPERATOR domain (Task, Approval, Connection, Artifact-with-content) and generating
// from it would hand a partly agent-authored, customer-facing app type names for a hundred things
// it must never see.
//
// The cost of hand-writing it is drift, and drift is what these tests remove. They read the actual
// template file and the actual server, so a route renamed kernel-side fails here rather than
// failing a founder's customer on a page load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** grep exits 1 when it matches nothing, which is the passing case for two tests below. */
function grep(args: string[], cwd: string): string[] {
  try {
    return execFileSync("grep", args, { cwd, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const ROOT = join(process.cwd(), "..");

// `business-template/` is a SIBLING of the kernel in the monorepo, and it is deliberately not part
// of the published open-source tree (`scripts/publish-oss.sh` ships `kernel`, `portal` and
// `create-mycel-app`, and nothing else). So this whole file is a monorepo-only check: it asserts the
// kernel has not drifted from a consumer that a public checkout does not contain.
//
// It SKIPS rather than fails when the sibling is absent, and the two states are not interchangeable.
// A hard read at module scope threw ENOENT before a single test registered, which took the entire
// file down — five silent losses — in exactly the tree where a red suite is most expensive: the
// public repo a stranger clones. Skipping keeps the monorepo's coverage identical (the file is
// always present there, so it always runs) while letting the published tree go green honestly,
// saying what it did not check instead of pretending there was nothing to check.
const SDK_PATH = join(ROOT, "business-template/lib/kernel.ts");
const HAVE_TEMPLATE = existsSync(SDK_PATH);
const monorepoOnly = {
  skip: HAVE_TEMPLATE ? false : "business-template/ is not in this tree (published kernel) — monorepo-only drift check",
};
const SDK = HAVE_TEMPLATE ? readFileSync(SDK_PATH, "utf8") : "";
/**
 * Every module that registers a route, concatenated.
 *
 * NOT just server.ts, and the difference is a bug this file had rather than a refactor. Portal
 * routes have lived in mounted modules for a while (`portal-approvals.ts`, `invoices.routes.ts`,
 * `requests.routes.ts`, `deliverables.routes.ts`) and this check only ever read `server.ts`. It
 * passed anyway — because the SDK happened not to call any of them yet — so the first SDK verb that
 * reached a mounted module failed here claiming the kernel did not register a route it registers on
 * the line above the one it is mounted from. A drift check that reports drift where there is none
 * teaches you to edit the check, which is exactly how the real drift gets through next time.
 *
 * Read from disk rather than listed by hand: a new `*.routes.ts` is picked up the day it lands.
 */
const SRC = join(process.cwd(), "harness/src");
const SERVER = [
  "server.ts",
  "portal-approvals.ts",
  ...readdirSync(SRC).filter((f) => f.endsWith(".routes.ts")),
]
  .map((f) => readFileSync(join(SRC, f), "utf8"))
  .join("\n");

/** Every `/v1/portal/...` path the SDK builds, with its interpolations turned into `:param`. */
function sdkPaths(): string[] {
  const found = new Set<string>();
  // `call("me")`, `proxy(\`threads/${x}/attachments\`)` — the two private helpers are the only
  // places a URL is built, which is itself the property this file is checking.
  for (const m of SDK.matchAll(/\b(?:call|proxy)<[^>]*>\(\s*[`"]([^`"]+)[`"]/g)) found.add(m[1]);
  for (const m of SDK.matchAll(/\b(?:call|proxy)\(\s*[`"]([^`"]+)[`"]/g)) found.add(m[1]);
  // `exchangeLink` fetches the session route directly, because it is the one unauthenticated call.
  for (const m of SDK.matchAll(/\/v1\/portal\/([a-z]+)`/g)) found.add(m[1]);
  return (
    [...found]
      .map((p) => p.replace(/\$\{[^}]+\}/g, ":param"))
      /**
       * A QUERY STRING IS NOT PART OF A ROUTE.
       *
       * Hono registers `"/v1/portal/requests"`; an SDK calling `requests?status=open` is that same
       * route with a filter on it. Without this the checker reported "server.ts does not register
       * /v1/portal/requests?status=open" for a route sitting in requests.routes.ts — and the repair
       * its own failure message invites ("fix the SDK") would have meant deleting a legitimate query
       * parameter to appease a string match.
       *
       * That is precisely the failure the `:param` note below describes, one level along: a checker
       * that recognises only one spelling of a path reports a missing route for a route that is
       * there, and what people learn is to edit the check.
       */
      .map((p) => p.split("?")[0].replace(/\/$/, ""))
      .filter(Boolean)
  );
}

test("every kernel route the generated app calls actually exists in server.ts", monorepoOnly, () => {
  const paths = sdkPaths();
  assert.ok(paths.length >= 8, `expected the full portal surface, found ${paths.length}: ${paths}`);

  for (const p of paths) {
    /**
     * Turn the SDK's path into the Hono route pattern the server registers.
     *
     * A parameter matches ANY name, not just `:id`. This used to hard-code `:id` on the grounds that
     * "Hono names them `:id` throughout", which was true right up until a route needed two distinct
     * parameters in one path (`:id/files/:artifact`) and could not name them both that. A checker
     * that only recognises one spelling of a placeholder reports a missing route for a route that is
     * there, and the fix people reach for is to delete the assertion.
     */
    const route = `/v1/portal/${p}`.replace(/\/$/, "");
    const pattern = new RegExp(
      `"${route.split("/").map((seg) => (seg === ":param" ? ":[A-Za-z_]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}"`,
    );
    assert.ok(
      pattern.test(SERVER),
      `lib/kernel.ts calls ${route}, which server.ts does not register. Either the route was ` +
        `renamed (fix the SDK) or the SDK invented it (fix the SDK).`,
    );
  }
});

test("the generated app cannot express a request the kernel has not scoped", monorepoOnly, () => {
  // THE RULE: the portal RENDERS, the kernel DECIDES. The module this replaced exported
  // `api<T>(path, init)`, so every call site chose its own URL — a surface on which "read another
  // client's thread" is one wrong template literal away. Four route handlers had additionally given
  // up on it and hand-rolled `fetch(\`${KERNEL}/v1/portal/...\`)` with the token pasted in.
  //
  // These assertions are what makes the closure real rather than a comment.
  assert.ok(!/export\s+(async\s+)?function\s+call\b/.test(SDK), "the generic request helper must stay private");
  assert.ok(!/export\s+(async\s+)?function\s+proxy\b/.test(SDK), "the byte-proxy helper must stay private");
  assert.ok(!/export\s+const\s+KERNEL\b/.test(SDK), "the kernel base URL must stay private");
  assert.ok(!/\bexport\s+.*\bapi\s*[<(]/.test(SDK), "no exported `api(path)` — that is the hole this closes");

  // No exported function may take a path, a URL, or a token. Ids are fine: the kernel answers 404
  // for a thread that is not this session's, so an id is a lookup key and not a claim of access.
  for (const m of SDK.matchAll(/export async function (\w+)\(([^)]*)\)/g)) {
    const [, name, params] = m;
    // `exchangeLink` is the single exemption and it proves the rule: the one-time link token IS the
    // credential being presented, by someone who has no session yet. It is not a bearer token this
    // app holds — it arrives in a URL a customer clicked, is handed straight to the kernel, and is
    // never stored. Every other function gets its authority from the session cookie.
    if (name === "exchangeLink") continue;
    assert.ok(
      !/\b(path|url|token|endpoint|route)\s*[?:]/.test(params),
      `${name}() takes ${params.trim()} — an exported function must not accept a path, URL or token`,
    );
    assert.ok(
      !/\b(client_?id|project_?id|org_?id)\b/.test(params),
      `${name}() takes an identity parameter. Identity comes from the session, never from a caller: ` +
        `a function that accepts a client id is a function that can be asked for another client.`,
    );
  }
});

test("no part of the generated app reaches the kernel except through lib/kernel.ts and lib/insight.ts", monorepoOnly, () => {
  // The four route handlers that used to build kernel URLs by hand are the reason this is asserted
  // over the whole tree rather than trusted. An agent extending the app will copy whatever pattern
  // it finds; if one hand-rolled fetch survives, that becomes the pattern.
  //
  // `lib/insight.ts` is the SECOND file, and the exemption is narrow enough to state in a sentence:
  // it holds a DIFFERENT CREDENTIAL with no read authority. `lib/kernel.ts` is the closed surface
  // for a client session — a credential that resolves to one customer's threads and files, which is
  // why nothing may compose a URL with it. The ingest key can do exactly one thing, to one project:
  // append an event. It cannot read a thread, a client, a file or a summary, so "a URL this app can
  // compose" is not the same category of risk. It also cannot live in `lib/kernel.ts`, which imports
  // `server-only` and `next/headers`.
  //
  // The exemption is paid for by the test below, whose assertions are stricter than the ones on
  // `lib/kernel.ts` because this credential sits behind a page anyone on the internet can load.
  const hits = grep(
    ["-rn", "--include=*.ts", "--include=*.tsx", "MYCEL_KERNEL_URL", "app", "components", "lib"],
    join(ROOT, "business-template"),
  );
  const offenders = hits.filter((l) => !l.startsWith("lib/kernel.ts:") && !l.startsWith("lib/insight.ts:"));
  assert.deepEqual(
    offenders,
    [],
    `only lib/kernel.ts and lib/insight.ts may know where the kernel is:\n${offenders.join("\n")}`,
  );
});

test("the generated app's ingest key can only append, and only to its own project", monorepoOnly, () => {
  // The failures this prevents, both of which an agent extending the app would write in good faith:
  // reusing `INSIGHT_INGEST_KEY` for a second, richer call; or adding a `project_id` to the body so
  // the numbers "land in the right place". The first presents a credential on a path it was not
  // scoped for. The second is the exact shape of the cross-tenant bug `insight/keys.ts` exists to
  // make impossible — and two cross-tenant leaks have already shipped in this codebase.
  const INSIGHT = readFileSync(join(ROOT, "business-template/lib/insight.ts"), "utf8");

  // One endpoint, named literally, with no template hole in the path part.
  const paths = [...INSIGHT.matchAll(/\/v1\/[A-Za-z0-9/_-]*/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(paths)], ["/v1/insight/events"], "lib/insight.ts must post to exactly one kernel path");
  assert.ok(SERVER.includes('"/v1/insight/events"'), "server.ts no longer registers the ingest route");

  // Read at call time from the server environment, never inlined into a bundle.
  assert.ok(/process\.env\.INSIGHT_INGEST_KEY/.test(INSIGHT), "the ingest key must come from the server env");
  assert.deepEqual(
    grep(["-rl", "NEXT_PUBLIC_INSIGHT", "app", "components", "lib", "content"], join(ROOT, "business-template")),
    [],
    "an ingest key inlined into the client bundle is an ingest key every visitor holds",
  );

  // No project id, in any spelling. The kernel derives it from the signature; a field here would be
  // ignored on arrival and would still be a lie sitting in the codebase for the next agent to copy.
  assert.ok(
    !/\b(project_?id|projectId|org_?id|client_?id)\b/i.test(INSIGHT),
    "the project comes from the ingest key's signature and must appear nowhere in the request",
  );

  // Nothing identifying, and not by redaction — this module must have no way to see a visitor.
  for (const forbidden of ["cookies(", "headers(", "x-forwarded-for", "user-agent", "referer", "referrer"]) {
    assert.ok(!INSIGHT.includes(forbidden), `lib/insight.ts must never read ${forbidden}`);
  }
});

test("the browser is never given an address for the kernel", monorepoOnly, () => {
  // A `NEXT_PUBLIC_` kernel URL would put the kernel in the client bundle, and from there the next
  // step is always a token to go with it. Server-side only, structurally.
  assert.deepEqual(grep(["-rl", "NEXT_PUBLIC_MYCEL", "."], join(ROOT, "business-template")), []);
});
