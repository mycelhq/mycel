// Every command the docs tell you to run exists, and every file they point at is there.
//
// ═══ WHY ═══
//
// `npm run demo:seed` builds a business called Sightline Research and logs in as
// founder@sightlineresearch.example. For eight months the README said Ridgeline Books and
// founder@ridgeline.example, so the first copy-paste block in the file — the first thing a reader
// actually EXECUTES — answered `{"error":"invalid credentials"}`. The seed had been renamed and
// the doc never followed.
//
// The guard that was supposed to catch it asserted the literal old email, so it could only fail
// when the README changed and never when the thing it documents did. Nobody noticed because
// documentation fails silently: there is no stack trace, just a person who concludes the project
// is broken and closes the tab.
//
// So these checks are all of the same shape — take what the docs CLAIM and resolve it against the
// repo — and none of them care how anything is worded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(root(p), "utf8");

/** The docs a stranger reads, in the order they meet them. */
const DOCS = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"] as const;

/**
 * The onboarding scripts, which PRINT instructions and are therefore documentation that executes.
 *
 * `curl -fsSL https://mycelai.dev/init | bash` is a path the README advertises, and `setup.sh` ends
 * by telling the reader a request to make. That example rots exactly the way the README's did, and
 * it is worse when it does: they got there by trusting a pipe to a shell.
 */
const SCRIPTS = ["setup.sh", "setup.ps1", "init.sh", "init.ps1"] as const;

/**
 * `docs/` is where the README sends people for detail, and it rots hardest because nothing links
 * back out of it. Found on the first run of these checks against it: CONTRACT.md — the contract
 * reference — showed both its examples against `uk-property-sourcing`, a wedge that has never
 * existed here, in a manifest shape with `agent`, `memory` and `channels` blocks that real wedges
 * dropped long ago.
 */
const DOC_DIR = readdirSync(root("docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);

const ALL = [...DOCS, ...SCRIPTS, ...DOC_DIR] as const;
const TEXT = Object.fromEntries(ALL.map((d) => [d, read(d)])) as Record<(typeof ALL)[number], string>;

const PKG = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

test("docs: every `npm run X` is a script that exists", () => {
  for (const doc of ALL) {
    for (const m of TEXT[doc].matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      assert.ok(
        Object.hasOwn(PKG.scripts, m[1]!),
        `${doc} tells the reader to run "npm run ${m[1]}", which is not in package.json`,
      );
    }
  }
});

test("docs: every wedge named in a request body is a wedge on disk", () => {
  const wedges = new Set(readdirSync(root("wedges"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  for (const doc of ALL) {
    // `\\?"` because a shell script prints these through an escaped double quote.
    for (const m of TEXT[doc].matchAll(/\\?"wedge\\?"\s*:\s*\\?"([a-z0-9-]+)\\?"/g)) {
      assert.ok(wedges.has(m[1]!), `${doc} shows a call against wedge "${m[1]}", which does not exist`);
    }
  }
});

test("docs: every task_type in an example is one that wedge declares", () => {
  // The pairing matters, not just the existence. A `task_type` the kernel does not know is a 400 on
  // the one request somebody makes to decide whether this works.
  for (const doc of ALL) {
    for (const m of TEXT[doc].matchAll(
      /\\?"wedge\\?"\s*:\s*\\?"([a-z0-9-]+)\\?"\s*,\s*\\?"task_type\\?"\s*:\s*\\?"([a-z0-9_]+)\\?"/g,
    )) {
      const [, wedge, taskType] = m;
      // `task_types` is an object KEYED by the type, not a list of records with a `type` field.
      const declared = (JSON.parse(read(`wedges/${wedge}/wedge.json`)) as { task_types?: Record<string, unknown> }).task_types ?? {};
      assert.ok(
        Object.hasOwn(declared, taskType!),
        `${doc} shows ${wedge}/${taskType}, which that wedge does not declare — the reader gets a 400 on their first request`,
      );
    }
  }
});

test("docs: every relative link resolves to something that is here", () => {
  // Including the images. A README whose hero image 404s on GitHub is the first thing a visitor
  // sees, and it is invisible to every test that only reads text.
  for (const doc of DOCS) {
    const links = [
      ...[...TEXT[doc].matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!),
      ...[...TEXT[doc].matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
    ];
    for (const raw of links) {
      const href = raw.split("#")[0]!.trim();
      if (!href || /^(https?:|mailto:|#)/.test(href)) continue;
      // Relative to the DOCUMENT, not to the repo root — `docs/WEDGES.md` links to `./CONTRACT.md`.
      const from = doc.includes("/") ? `${doc.slice(0, doc.lastIndexOf("/"))}/` : "";
      assert.ok(
        existsSync(root(`${from}${href}`.replace(/^\.\//, "").replace(/\/\.\//g, "/"))),
        `${doc} links to ${href}, which is not in the published tree`,
      );
    }
  }
});

test("docs: every source path named in prose is a file that is here", () => {
  /**
   * Not just links — the `backticked/paths.ts` in a sentence, which is how these docs point at code
   * most of the time. "Implement `Sandbox` (see `harness/src/sandbox.ts`)" is a promise, and a
   * renamed file turns it into a dead end that no link checker looks at.
   *
   * Anchored on the top-level directories so this matches repo paths and not, say, a URL fragment
   * or an npm package name. A path named with no directory prefix is unresolvable anyway and is
   * deliberately not matched — see the CONTRIBUTING edit that made `gtm/jina.ts` fully qualified.
   */
  const TOP = "harness|wedges|docs|design|library|skills|scripts|docker";
  for (const doc of DOCS) {
    for (const m of TEXT[doc].matchAll(new RegExp("`((?:" + TOP + ")/[A-Za-z0-9._/-]+)`", "g"))) {
      const path = m[1]!.replace(/\/$/, "");
      assert.ok(existsSync(root(path)), `${doc} points at ${path}, which is not in the published tree`);
    }
  }
});

test("docs: the quickstart's own claim is the one the suite makes", () => {
  // "npm i && npm test — green. no keys, no Docker, no Postgres." is the load-bearing promise of the
  // whole README, and it is true because `test` sets the mock runtime itself rather than relying on
  // the reader's environment. If that ever moves to an env file or a prerequisite, the promise goes
  // with it and this is the line that should stop first.
  assert.match(PKG.scripts.test!, /MYCEL_RUNTIME=mock/, "npm test must configure its own runtime");
  assert.ok(!/MYCEL_DATABASE_URL/.test(PKG.scripts.test!), "npm test must not require Postgres");
  assert.match(PKG.scripts.demo!, /demo\.ts/, "and `npm run demo` must be the one that shows something");

  /**
   * ANCHORED TO THE QUICKSTART, not to the file.
   *
   * This matched `npm i && npm test` anywhere in the README. When the first block changed to
   * `npm i && npm run demo` it went on passing, because the phrase still occurs further down in a
   * section about building on the kernel — so the assertion had quietly stopped guarding the one
   * command that decides whether anybody keeps reading.
   */
  const quickstart = TEXT["README.md"].slice(0, TEXT["README.md"].indexOf("## What this is"));
  assert.ok(quickstart.length > 0, "could not find the quickstart — this test is pinned to that heading");
  assert.match(quickstart, /npm i && npm run demo/, "the first command must be the one that shows the payoff");
  assert.match(quickstart, /no keys/, "and it must say what it does NOT need");
});

test("docs: the Node version is one claim, made in every place that makes it", () => {
  /**
   * Four places say which Node this needs — package.json `engines`, `.npmrc` deciding whether that
   * is enforced, the CI runner, and AGENTS.md. A contributor reads one of them.
   *
   * `engines` alone is advisory: npm warns and installs anyway, so on an old Node the first thing a
   * stranger met was a stack trace from a missing API rather than a version requirement, and the
   * available conclusion was that the repo is broken.
   */
  const npmrc = read(".npmrc");
  assert.match(npmrc, /engine-strict\s*=\s*true/, "engines must be enforced, or it is a comment");

  const required = /">=(\d+)"/.exec(JSON.stringify((JSON.parse(read("package.json")) as { engines?: { node?: string } }).engines ?? {}));
  assert.ok(required, "package.json must declare an engines.node floor");
  const floor = Number(required![1]);

  assert.match(TEXT["AGENTS.md"], new RegExp(`Node ${floor}\\+`), `AGENTS.md must say Node ${floor}+`);

  // And CI must run something the floor allows, or green there says nothing about a contributor's
  // machine — in either direction.
  const ci = readFileSync(root(".github/workflows/ci.yml"), "utf8");
  const ciNode = Number(/node-version:\s*"(\d+)"/.exec(ci)?.[1]);
  assert.ok(ciNode >= floor, `CI runs Node ${ciNode}, below the declared floor of ${floor}`);
});

// ── The wedge catalogue is derived, or it drifts ────────────────────────────
//
// `harness-operator` was deleted deliberately — 261 sandbox-hours, four proposals, none adopted —
// and both the README and WEDGES.md went on listing it as something in the repo. In the other
// direction `content-desk` shipped and the README's table never learned about it, so a real service
// was invisible to anyone reading the front page.
//
// Neither is catchable by reading prose. Both are trivial against `wedges/*/wedge.json`.

interface Manifest {
  wedge: string;
  internal?: boolean;
}

const WEDGES = readdirSync(root("wedges"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ slug: d.name, m: JSON.parse(read(`wedges/${d.name}/wedge.json`)) as Manifest }));

test("docs: every wedge in the repo is in the README, on the right side of the line", () => {
  const table = TEXT["README.md"].slice(
    TEXT["README.md"].indexOf("**Sellable wedges**"),
    TEXT["README.md"].indexOf("A generated definition"),
  );
  assert.ok(table.length > 0, "could not find the wedge section — this test is pinned to its headings");

  for (const { slug, m } of WEDGES) {
    assert.ok(table.includes(`\`${slug}\``), `wedges/${slug} exists and the README never names it`);
    // `internal: true` is the wedge's own declaration that it is machinery, not a product. The
    // README splits on exactly that, and the two must not disagree about which a wedge is.
    const inMachinery = /\*\*Machinery\*\*[^\n]*(?:\n(?!\n)[^\n]*)*/.exec(table)?.[0] ?? "";
    assert.equal(
      inMachinery.includes(`\`${slug}\``),
      m.internal === true,
      `${slug} declares internal: ${m.internal === true} — the README puts it on the other side`,
    );
  }
});

test("docs: nothing is listed as a wedge that is not one", () => {
  // The `harness-operator` failure, in the general form. Any backticked slug in a wedge list that
  // has no directory is a reader sent looking for something that was removed.
  const slugs = new Set(WEDGES.map((w) => w.slug));
  const sections = [
    TEXT["README.md"].slice(TEXT["README.md"].indexOf("**Sellable wedges**"), TEXT["README.md"].indexOf("A generated definition")),
    TEXT["docs/WEDGES.md"].slice(TEXT["docs/WEDGES.md"].indexOf("## 2. Three worked examples"), TEXT["docs/WEDGES.md"].indexOf("### a)")),
  ];
  for (const section of sections) {
    for (const m of section.matchAll(/`([a-z][a-z0-9]+(?:-[a-z0-9]+)+)`/g)) {
      const slug = m[1]!;
      // Only judge names that LOOK like a wedge slug and are not something else we ship.
      if (/^(npm|pre-commit|package-lock|wedge-gap|create-mycel-app|x-mycel-project|content-type)$/.test(slug)) continue;
      assert.ok(slugs.has(slug), `a wedge list names \`${slug}\`, which is not a directory in wedges/`);
    }
  }
});

// ── The contract is the product, so the docs about it are too ───────────────
//
// "`/v1` and the event stream are what consumers depend on" is one of the six invariants in
// CONTRIBUTING. A documented endpoint that no longer exists is the most expensive kind of rot here:
// the reader is not a casual visitor, they are someone building against it, and they find out at
// runtime in their own code.
//
// Nothing was broken when this was written — all 59 documented endpoints resolve against the 383
// registered routes. That is the point of adding it now rather than after one breaks.

/** `POST /v1/approvals/:id/{approve,reject}` is two endpoints written once. */
function expandBraces(path: string): string[] {
  const m = /\{([^}]*,[^}]*)\}/.exec(path);
  if (!m) return [path];
  return m[1]!.split(",").flatMap((alt) => expandBraces(path.replace(m[0]!, alt.trim())));
}

/** Every `app.get("/v1/…")` in the harness, as verb + segments. */
function registeredRoutes(): Array<{ verb: string; segments: string[] }> {
  const out: Array<{ verb: string; segments: string[] }> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "graphify-out" && e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/\b(get|post|patch|put|del|delete)\("(\/v1\/[^"]+)"/g)) {
          const verb = m[1]!.toUpperCase() === "DEL" ? "DELETE" : m[1]!.toUpperCase();
          out.push({ verb, segments: m[2]!.replace(/\/$/, "").split("/").filter(Boolean) });
        }
      }
    }
  };
  walk(root("harness/src"));
  return out;
}

test("docs: every /v1 endpoint the docs name is one the harness registers", () => {
  const routes = registeredRoutes();
  assert.ok(routes.length > 100, `only found ${routes.length} routes — the scan stopped resolving this codebase`);

  /** A documented path matches a route when every segment lines up, allowing `:params` and a `{.+}` tail. */
  const resolves = (verb: string, path: string): boolean =>
    routes.some((r) => {
      if (r.verb !== verb) return false;
      const want = path.replace(/\/$/, "").split("/").filter(Boolean);
      const wild = r.segments.at(-1)?.includes("{.+}");
      if (wild ? want.length < r.segments.length - 1 : want.length !== r.segments.length) return false;
      return r.segments.every((seg, i) => {
        if (seg.startsWith(":")) return true; // a param accepts whatever the docs put there
        return want[i] === seg;
      });
    });

  for (const doc of ALL) {
    for (const m of TEXT[doc].matchAll(/\b(GET|POST|PATCH|DELETE)\s+(\/v1\/[A-Za-z0-9/:{},._-]+)/g)) {
      for (const path of expandBraces(m[2]!.replace(/[.,`]+$/, ""))) {
        assert.ok(
          resolves(m[1]!, path),
          `${doc} documents ${m[1]} ${path}, which the harness does not register`,
        );
      }
    }
  }
});

// ── If the software tells you to set it, you can look it up ─────────────────
//
// 123 `MYCEL_*` variables are read in `harness/src` and most are internal plumbing a self-hoster
// never touches — a blanket "document them all" rule would bury the dozen that matter under a
// hundred that do not. The cut that earns its place is narrower and not a matter of taste: a
// variable the kernel NAMES IN A MESSAGE. Preflight told operators to set
// `MYCEL_LITELLM_URL`+`MYCEL_LITELLM_MASTER_KEY` and neither appeared in any doc or in
// `.env.example`, so the instruction led nowhere. Eight were like that.

/**
 * Every `MYCEL_*` named inside a literal that TELLS SOMEBODY TO SET IT.
 *
 * Three narrowings, each of which a looser version got wrong on the way here:
 *
 *   · Whole file with comments stripped, not line by line. The first attempt required the print
 *     call on the same line as the string, and `problems.push(` in preflight.ts wraps — so it found
 *     2 of the 9 and would have passed while the LiteLLM instruction still led nowhere.
 *   · Prose, so a literal that is an env-var NAME rather than a sentence does not count.
 *   · A directive word. This is the actual rule — "if the software tells you to SET it, you can
 *     look it up" — and without it the scan pulls in every variable merely mentioned in passing.
 */
function varsNamedInMessages(): Map<string, string> {
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
  const LITERAL = /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
  const PROSE = /[a-z]{3,}[ ,.][ ]?[a-z]{3,}/;
  const DIRECTIVE = /\b(set|unset|export|configure|provide|give)\b/i;

  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "graphify-out" && e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".ts")) {
        /**
         * `plugin.ts` is written INTO the sandbox and runs there. Its `MYCEL_GATE_*` and
         * `MYCEL_TASK_ID` are injected by the harness — see `MYCEL_GATE_URL` in runtime.ts — so
         * "set MYCEL_GATE_URL" in its output is addressed to us, not to an operator, and
         * documenting them for a self-hoster would be telling them to set something they must not.
         */
        if (e.name === "plugin.ts") continue;
        for (const lit of stripComments(readFileSync(p, "utf8")).match(LITERAL) ?? []) {
          if (!PROSE.test(lit) || !DIRECTIVE.test(lit)) continue;
          for (const m of lit.matchAll(/\b(MYCEL_[A-Z0-9_]+)\b/g)) {
            if (!out.has(m[1]!)) out.set(m[1]!, p.slice(p.indexOf("harness/")));
          }
        }
      }
    }
  };
  walk(root("harness/src"));
  return out;
}

test("docs: a variable the kernel tells you to set is one you can look up", () => {
  const named = varsNamedInMessages();
  // A floor, because the whole failure mode of the first two attempts was a scan that quietly
  // matched almost nothing and passed. If this drops, the guard has stopped looking, not the
  // codebase stopped instructing.
  assert.ok(named.size >= 8, `only ${named.size} variables found in messages — the scan stopped resolving`);
  assert.ok(named.has("MYCEL_LITELLM_URL"), "the instruction this test was written for is no longer being found");

  const everywhere = [...DOCS, ...DOC_DIR].map((d) => TEXT[d as keyof typeof TEXT]).join("\n") + read(".env.example");
  for (const [name, where] of named) {
    assert.ok(
      everywhere.includes(name),
      `${where} tells somebody about ${name}, and it appears in no doc and in no .env.example — the instruction leads nowhere`,
    );
  }
});

// ── The changelog's own promise ─────────────────────────────────────────────

test("docs: every commit the changelog cites is a commit that exists", () => {
  /**
   * CHANGELOG.md opens by saying "short hashes refer to upstream commits and are here so a claim
   * can be traced to the change that made it true". 130 of them, and nothing checked. A hash that
   * does not resolve is worse than no hash: it is a citation that looks verifiable and is not, in
   * the one file a visitor reads to decide whether the project is alive.
   *
   * Skips in a published clone. The public repo is a SNAPSHOT — `git archive HEAD kernel/` — so the
   * upstream commits these name are genuinely not in its history, and failing there would make a
   * stranger's clone red for a reason they cannot fix. Same convention as every other test here
   * that names a private sibling.
   */
  const inMonorepo = (() => {
    try {
      // A commit from the published snapshot's own first entry would resolve anywhere; this asks
      // whether we are in the repo that HAS the upstream history, by checking the count.
      const n = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root("."), encoding: "utf8" }).trim());
      return Number.isFinite(n) && n > 500;
    } catch {
      return false;
    }
  })();
  if (!inMonorepo) return; // # SKIP — a published snapshot has no upstream history to resolve against

  const cited = [...new Set([...read("CHANGELOG.md").matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]!))];
  assert.ok(cited.length > 50, `only ${cited.length} hashes found — the scan stopped resolving`);

  const missing = cited.filter((h) => {
    try {
      return execFileSync("git", ["cat-file", "-t", h], { cwd: root("."), encoding: "utf8" }).trim() !== "commit";
    } catch {
      return true;
    }
  });
  assert.deepEqual(missing, [], "the changelog cites commits that do not exist");
});
