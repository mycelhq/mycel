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
import { between } from "./helpers/anchor";

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
    /**
     * A script name is colon-SEPARATED, never colon-terminated: `demo:seed`, not `demo:`. The
     * looser `[a-z0-9:-]*` swallowed the punctuation in an ordinary sentence — "npm run demo: nine
     * ranked moves…" in an image's alt text — and reported `demo:` as a missing script.
     */
    for (const m of TEXT[doc].matchAll(/npm run ([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)/g)) {
      assert.ok(
        Object.hasOwn(PKG.scripts, m[1]!),
        `${doc} tells the reader to run "npm run ${m[1]}", which is not in package.json`,
      );
    }
  }
});


/**
 * Slugs this document teaches the reader to CREATE.
 *
 * `docs/WEDGES.md` walks through writing `wedges/hello-desk/wedge.json` and then posting a task
 * against it. That reference is correct and the wedge is deliberately not in this repo — so the
 * rule is not "every wedge named exists", it is "every wedge named exists OR this document is the
 * thing that creates it". Keyed on the `mkdir`/path the walkthrough itself shows, so a doc cannot
 * claim the exemption without actually teaching the reader to make the directory.
 */
const taughtHere = (text: string): Set<string> =>
  new Set([...text.matchAll(/wedges\/([a-z0-9][a-z0-9-]*)\/wedge\.json/g)].map((m) => m[1]!));

test("docs: every wedge named in a request body is a wedge on disk", () => {
  const wedges = new Set(readdirSync(root("wedges"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  for (const doc of ALL) {
    // `\\?"` because a shell script prints these through an escaped double quote.
    const taught = taughtHere(TEXT[doc]);
    for (const m of TEXT[doc].matchAll(/\\?"wedge\\?"\s*:\s*\\?"([a-z0-9-]+)\\?"/g)) {
      if (taught.has(m[1]!)) continue; // this document creates it — see `taughtHere`
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
      // A wedge the document itself creates has no manifest here to read.
      if (taughtHere(TEXT[doc]).has(wedge!)) continue;
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

/**
 * TRACKED wedges only.
 *
 * The README documents what SHIPS. A wedge somebody created five minutes ago by following the
 * "your first wedge" walkthrough in docs/WEDGES.md is not that — and before this, their very next
 * `npm run check` failed with "wedges/hello-desk exists and the README never names it". A guard
 * that punishes a reader for following the tutorial is worse than no guard.
 *
 * Falls back to every directory when git cannot answer (a tarball, a vendored copy), because the
 * check is still right there and only the tutorial case needs the exemption.
 */
const trackedWedges = (): Set<string> | null => {
  try {
    const out = execFileSync("git", ["ls-files", "wedges"], { cwd: root("."), encoding: "utf8" });
    const slugs = new Set(out.split("\n").filter(Boolean).map((f) => f.split("/")[1]!).filter(Boolean));
    return slugs.size ? slugs : null;
  } catch {
    return null;
  }
};

const WEDGES = (() => {
  const tracked = trackedWedges();
  return readdirSync(root("wedges"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!tracked || tracked.has(d.name)))
    .map((d) => ({ slug: d.name, m: JSON.parse(read(`wedges/${d.name}/wedge.json`)) as Manifest }));
})();

test("docs: every wedge in the repo is in the README, on the right side of the line", () => {
  const table = between(TEXT["README.md"], "**Sellable wedges**", "A generated definition");
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
            if (!out.has(m[1]!)) out.set(m[1]!, between(p, "harness/"));
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

test("docs: one answer to 'what do I run before I push'", () => {
  /**
   * Four places answer this: CI, CONTRIBUTING, the README's build section, and package.json.
   * They had drifted to two answers — CONTRIBUTING said `npm run check` while the README still
   * said `npm i && npm test` — and a contributor who follows the README pushes without a
   * typecheck, which is the half CI fails on. `tsc` and the suite catch different things: a
   * backtick inside a SQL string in a template literal breaks the template, and only `tsc` sees
   * it, because the suite passes when nothing imports the broken module.
   */
  assert.ok(PKG.scripts.check, "there must be one command that does both");
  assert.match(PKG.scripts.check!, /typecheck/);
  assert.match(PKG.scripts.check!, /test/);

  for (const doc of ["README.md", "CONTRIBUTING.md"] as const) {
    assert.match(TEXT[doc], /npm run check/, `${doc} must point at the single pre-push command`);
  }

  // CI must actually run both halves, or "what CI runs" is a claim rather than a fact.
  const ci = readFileSync(root(".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /tsc --noEmit/, "CI must typecheck");
  assert.match(ci, /npm test/, "CI must run the suite");
});

test("docs: a shell example never uses a variable the reader's shell does not have", () => {
  /**
   * The README's task example sent `-H "authorization: Bearer $MYCEL_API_KEY"`. `npm run demo`
   * sets that variable inside a CHILD process, so a reader who pastes the block into their own
   * shell sends `Bearer ` and gets a 401 — verified against a live kernel. Same shape as the
   * login block that answered "invalid credentials": a command that cannot work as written.
   *
   * The rule is mechanical. Inside one fenced bash block, every `$VAR` must either be assigned in
   * that same block or be one a shell always has. Nothing here needs to know what the variables
   * mean.
   */
  const ALWAYS_SET = new Set(["HOME", "PATH", "PWD", "USER", "SHELL", "TMPDIR", "PORT"]);

  for (const doc of DOCS) {
    for (const m of TEXT[doc].matchAll(/```bash\n([\s\S]*?)```/g)) {
      const block = m[1]!;
      // `FOO=…`, `export FOO=…`, and `read FOO` all count as assignment.
      const assigned = new Set([...block.matchAll(/(?:^|\n)\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/g)].map((a) => a[1]!));
      for (const use of block.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
        const name = use[1]!;
        if (assigned.has(name) || ALWAYS_SET.has(name)) continue;
        assert.fail(
          `${doc}: a bash block uses $${name} without setting it — pasted into a fresh shell this ` +
            `sends an empty value. Use the literal, or assign it in the block.`,
        );
      }
    }
  }
});

test("scripts: an instruction they PRINT does not send an empty bearer", () => {
  /**
   * setup.sh finished by printing `curl … -H "authorization: Bearer $MYCEL_API_KEY"`, and it never
   * exports that variable — it writes `.env`, which the KERNEL reads, and the kernel prints an
   * ephemeral key at boot. So the reader pastes a header with nothing in it and gets a 401.
   *
   * Narrow on purpose. A shell script uses `$VAR` legitimately everywhere; what cannot be right is
   * a variable inside a command the script is telling a HUMAN to run, because that human's shell is
   * not this script's.
   */
  for (const script of SCRIPTS) {
    for (const line of TEXT[script].split("\n")) {
      if (!/\b(say|echo|printf|Write-Host)\b/.test(line) || !line.includes("curl")) continue;
      assert.ok(
        !/Bearer\s+\\?\$\{?[A-Za-z_]/.test(line),
        `${script} prints a curl using a shell variable the reader does not have:\n  ${line.trim()}`,
      );
    }
  }
});


/**
 * GitHub's heading anchor, near enough for our own headings.
 *
 * Lowercase, drop anything that is not a word character, space or hyphen, then spaces to hyphens.
 * `## 1b. Your first wedge, in eleven lines` → `1b-your-first-wedge-in-eleven-lines`.
 */
function anchorFor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

test("docs: a link to a heading lands on a heading that exists", () => {
  /**
   * The link checker strips the `#` fragment and only resolves the FILE, so
   * `docs/WEDGES.md#a-heading-that-was-renamed` passed while sending the reader to the top of a
   * long document with no idea what they were meant to see. On GitHub that is a silent miss: no
   * 404, just the wrong scroll position.
   */
  const headings = new Map<string, Set<string>>();
  for (const doc of [...DOCS, ...DOC_DIR]) {
    headings.set(doc, new Set([...TEXT[doc as keyof typeof TEXT].matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchorFor(m[1]!))));
  }

  let checked = 0;
  for (const doc of [...DOCS, ...DOC_DIR]) {
    const from = doc.includes("/") ? `${doc.slice(0, doc.lastIndexOf("/"))}/` : "";
    for (const m of TEXT[doc as keyof typeof TEXT].matchAll(/\]\(([^)\s]*#[^)\s]+)\)/g)) {
      const [path, frag] = m[1]!.split("#") as [string, string];
      if (/^https?:/.test(path)) continue;
      // Same document when the path is empty, otherwise resolve it the way the link checker does.
      const target = path === "" ? doc : `${from}${path}`.replace(/^\.\//, "").replace(/\/\.\//g, "/");
      const known = headings.get(target as string);
      if (!known) continue; // a link into a non-markdown file; the link checker already resolved it
      checked += 1;
      assert.ok(known.has(frag), `${doc} links to ${m[1]} — ${target} has no heading with that anchor`);
    }
  }
  assert.ok(checked > 0, "no in-document anchors were checked — the scan stopped resolving");
});

test("docs: nothing points at a document that only exists in the private monorepo", () => {
  /**
   * `docs/ROADMAP.md` shipped a "see the internal stress-test doc" pointer for months. That
   * directory lives in the monorepo and is never published, so it is a dead reference for every
   * reader of the public repo — and it puts the filename of a strategy document on the internet,
   * which is the half that cannot be withdrawn.
   *
   * The filename is deliberately not repeated here. The publish scanner greps the whole staged
   * tree, this file is IN that tree, and a comment quoting the thing it bans is indistinguishable
   * from the thing itself to a grep — which is the third time in this pass that prose describing a
   * rule tripped the rule.
   *
   * `scripts/publish-oss.sh` scans for this too and would REFUSE the publish. That is the right
   * place for the last line of defence and the wrong place to find out: the publish is the moment
   * you least want a surprise. This fails in CI instead, on the commit that introduces it.
   *
   * Scoped to a document extension so `/v1/internal/gate` and `harness/src/internal-sender.ts` —
   * both real and both public — are not swept up.
   */
  const PRIVATE_DOC = /(^|[^a-z/])internal\/[A-Za-z0-9_-]+\.(md|pdf|docx?|xlsx?)/;
  for (const doc of [...DOCS, ...SCRIPTS, ...DOC_DIR]) {
    const hit = PRIVATE_DOC.exec(TEXT[doc as keyof typeof TEXT]);
    assert.equal(hit, null, `${doc} references a private monorepo document: ${hit?.[0]}`);
  }
});

test("docs: the private siblings the comments cite are explained, not just cited", () => {
  /**
   * 52 comments in the published tree cite `growth/…`, `cloud/…` or `landing/…`. Those directories
   * are the private siblings this kernel was extracted from and are deliberately not published, so
   * to a reader every one of those paths looks like a file they should be able to open and cannot.
   *
   * They are worth keeping — each names the failure that shaped the code — but only if something
   * says what they are. This fails if the citations exist and the explanation does not, which is
   * the state the repo was in.
   */
  const PRIVATE_SIBLING = /(^|[^a-z/])(growth|cloud|landing)\/[A-Za-z0-9_./-]+\.(ts|tsx|md|json)/;
  const cites = readdirSync(root("harness/src"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .some((e) => PRIVATE_SIBLING.test(readFileSync(`${e.parentPath ?? e.path}/${e.name}`, "utf8")));

  if (!cites) return; // nothing cites them any more — the explanation may go too

  assert.match(
    TEXT["AGENTS.md"],
    /are not missing/,
    "comments cite private sibling directories and AGENTS.md does not say what they are",
  );
  for (const dir of ["growth/", "cloud/", "landing/"]) {
    assert.ok(TEXT["AGENTS.md"].includes(dir), `AGENTS.md must name ${dir} as a private sibling`);
  }
});

test("docs: a command an example depends on is one the docs tell you to have", () => {
  /**
   * The README's login block pipes through `jq`, in six places across two documents, and nothing
   * ever said you needed it. On a machine without it the first copy-paste block after the quickstart
   * dies with `jq: command not found` — which reads as the repo being broken, not as a missing tool.
   *
   * Bounded by an allowlist of what is genuinely always there: POSIX text utilities, and the two
   * runtimes the repo already requires. Anything outside that is an assumption, and an assumption
   * has to be written down where the prerequisites are.
   */
  const ALWAYS = new Set([
    // POSIX, present on any machine that can run a shell.
    "cat", "cd", "echo", "export", "grep", "sed", "awk", "sort", "uniq", "head", "tail", "mkdir",
    "rm", "cp", "mv", "ls", "printf", "read", "set", "unset", "test", "true", "false", "tr", "wc",
    "find", "xargs", "ln", "chmod", "exit", "source", "if", "then", "fi", "for", "do", "done",
    "while", "case", "esac", "else", "elif", "return", "local",
    // Already required by name, one line above this check's own subject.
    "node", "npm", "npx", "git",
  ]);

  const declared = TEXT["AGENTS.md"];
  const missing = new Map<string, Set<string>>();

  for (const doc of [...DOCS, ...DOC_DIR]) {
    for (const block of TEXT[doc as keyof typeof TEXT].matchAll(/```bash\n([\s\S]*?)```/g)) {
      for (const raw of block[1]!.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        for (const seg of line.split("|")) {
          const cleaned = seg.trim().replace(/^\$\(/, "").trim();
          const first = /^([a-z][a-z0-9_.-]*)\s/.exec(cleaned)?.[1];
          // Only a command with arguments; a bare word is usually a heredoc terminator or a value.
          if (!first || ALWAYS.has(first)) continue;
          if (declared.includes(`\`${first}\``)) continue;
          if (!missing.has(first)) missing.set(first, new Set());
          missing.get(first)!.add(doc);
        }
      }
    }
  }

  assert.deepEqual(
    [...missing.keys()],
    [],
    `these commands are used in examples and never named as something to install:\n` +
      [...missing].map(([c, where]) => `  ${c} — in ${[...where].join(", ")}`).join("\n"),
  );
});

test("docs: a directory tree in a doc is a tree that exists", () => {
  /**
   * `docs/ARCHITECTURE.md` §2b drew a repository with `core/`, `plugins/` and `clients/` roots and
   * four `@mycel/*` SDK packages. None of it was ever built — it was a design sketch written in the
   * present tense under the heading "Repository structure", contradicting the accurate tree in
   * AGENTS.md one directory away.
   *
   * That is the most expensive kind of wrong doc. A reader trying to find their way around gets a
   * confident, detailed map of a different repository, and the more carefully they read it the
   * longer they are lost.
   *
   * Matched on the SHAPE of a tree entry — `  name/` with a description after it — because that is
   * what both of those blocks looked like and what makes a line a claim about the filesystem rather
   * than prose that happens to contain a slash.
   */
  // Leading indentation is OPTIONAL: AGENTS.md's tree starts at column zero and
  // ARCHITECTURE.md's was indented under a repo name. Requiring it examined nothing, which the
  // floor below turned into a failure rather than a pass.
  const ENTRY = /^\s*([a-z][a-z0-9-]*)\/\s{2,}\S/;
  let checked = 0;

  for (const doc of [...DOCS, ...DOC_DIR]) {
    /**
     * Fences matched from line starts, alternating open/close.
     *
     * `/```\n([\s\S]*?)```/g` scans from the top of the file and pairs whichever fence it meets
     * first with the next one — so in a document whose first block is ```bash it locks onto the
     * CLOSING fence and captures the prose between blocks. It examined zero tree entries, and only
     * the floor at the end of this test turned that into a failure instead of a pass.
     */
    for (const block of TEXT[doc as keyof typeof TEXT].matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)) {
      for (const line of block[1]!.split("\n")) {
        const name = ENTRY.exec(line)?.[1];
        if (!name) continue;
        checked += 1;
        assert.ok(
          existsSync(root(name)),
          `${doc} draws a tree containing ${name}/, which is not in the published tree:\n  ${line.trim()}`,
        );
      }
    }
  }

  assert.ok(checked >= 5, `only ${checked} tree entries examined — the scan stopped resolving`);
});
