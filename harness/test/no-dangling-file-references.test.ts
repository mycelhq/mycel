// A COMMENT THAT NAMES A FILE THAT IS NOT THERE IS WORSE THAN NO COMMENT.
//
// ═══ THE TWO THIS EXISTS FOR ═══
//
// Both were features deleted for good, measured reasons, and both left their comments behind:
//
//   `process-mining.ts`  deleted in 5ed4567c — "a query on 36% of runs, read once in its lifetime".
//                        A twenty-two-line doc block survived in server.ts describing the route in
//                        the present tense, sitting directly above a DIFFERENT route's own comment.
//   `improvement.ts`     deleted in 59f1dd83 — "261 sandbox-hours, four proposals, nothing adopted".
//                        Ten comments still said it "already turns a reflection run into a proposal
//                        that, once approved, rewrites a playbook", and cloud kept an orphaned
//                        `ImprovementProposal` doc block over no interface.
//
// I read both and concluded the features were built. That is the cost: a confident wrong answer
// about what this system does, from evidence that reads exactly like a deliberate decision. Deleted
// code cannot mislead anyone; a comment describing deleted code can, and did.
//
// ═══ WHAT IS ALLOWED ═══
//
// Saying a file was DELETED is not a dangling reference, it is the useful version of one — the
// knowledge-metrics.ts note that process mining was cut, and why, is worth more than silence. So a
// reference is fine when its own comment block says so.
//
// ═══ A RATCHET, NOT A GATE ═══
//
// The rest are renames — `turn-auto-resume.ts` became turn-resume.ts, `preview-state-page.ts`
// became preview-page.ts. Harmless individually, and failing on all of them at once means a commit
// nobody reviews. This fails when the number goes UP, so the next deletion that leaves debris fails
// on the commit that leaves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ONLY_IN_MONOREPO, inMonorepo } from "./_monorepo";

const REPO = join(import.meta.dirname, "..", "..", "..");

function files(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** Every filename that exists anywhere in the repo, so a reference across packages still resolves. */
const PRESENT = new Set(
  ["kernel", "cloud", "growth", "landing", "docs", "infra", "scripts"]
    .flatMap((d) => files(join(REPO, d), () => true))
    .map((p) => p.slice(p.lastIndexOf("/") + 1)),
);

/** `.ts` written for a `.tsx` file is a typo, not a dangling reference. */
function resolves(name: string): boolean {
  if (PRESENT.has(name)) return true;
  const stem = name.slice(0, name.lastIndexOf("."));
  return ["ts", "tsx", "js", "jsx", "mjs"].some((e) => PRESENT.has(`${stem}.${e}`));
}

/** Backticked only. Bare prose like "see page.ts" is too noisy to be worth a rule. */
const REF = /`([a-z0-9][a-z0-9.\-]*\.(?:ts|tsx))`/g;
const SAYS_DELETED = /\bdeleted in\b|\bwas deleted\b|\bdelete[ds]?\b.*\bin [0-9a-f]{7,}\b/i;

/**
 * A FILE IN SOMEBODY ELSE'S REPOSITORY IS NOT A DANGLING REFERENCE.
 *
 * Several modules here are ports, and the most useful line in each of them is the one naming the
 * upstream file the argument came from — `openwork`'s `session-admission-outcome.ts`, `opendesign`'s
 * `create-design-system`. Those are citations, and a citation that cannot be checked out locally is
 * still the difference between an argued port and a claim.
 *
 * Allowed only when the block NAMES the project. "See foo.ts" with no source is exactly the shape
 * this test exists to catch, and staying strict about that is what keeps the allowance narrow.
 */
const CITES_UPSTREAM = /\b(openwork|opendesign|opencode|nexu-io|different-ai)\b/i;

/** The comment block a line belongs to, so "deleted in <sha>" three lines up still counts. */
function blockAround(lines: string[], i: number): string {
  const isComment = (l: string) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
  };
  let a = i;
  let b = i;
  while (a > 0 && isComment(lines[a - 1]!)) a--;
  while (b < lines.length - 1 && isComment(lines[b + 1]!)) b++;
  return lines.slice(a, b + 1).join("\n");
}

function dangling(roots: string[]): string[] {
  const bad = new Map<string, Set<string>>();
  for (const root of roots) {
    for (const p of files(join(REPO, root), (f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i]!.trim();
        if (!(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"))) continue;
        for (const m of lines[i]!.matchAll(REF)) {
          const name = m[1]!;
          if (resolves(name)) continue;
          const block = blockAround(lines, i);
          if (SAYS_DELETED.test(block) || CITES_UPSTREAM.test(block)) continue;
          bad.set(name, (bad.get(name) ?? new Set()).add(p.slice(REPO.length + 1)));
        }
      }
    }
  }
  return [...bad].map(([k, v]) => `${k}  →  ${[...v].join(", ")}`).sort();
}

const BUDGET = 15;

test("no comment may name a source file that is not there", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const bad = dangling(["kernel/harness", "cloud"]);
  assert.ok(
    bad.length <= BUDGET,
    `comments naming files that do not exist rose to ${bad.length} (budget ${BUDGET}).\n\n` +
      `Either the file was renamed — fix the name — or the feature was deleted, in which case SAY\n` +
      `so with the commit that removed it. "deleted in <sha>" is allowed and is worth more than\n` +
      `silence; a comment that still describes it in the present tense produces a confident wrong\n` +
      `answer about what this system does.\n\n  ${bad.join("\n  ")}`,
  );
});

test("the budget follows the work down", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const bad = dangling(["kernel/harness", "cloud"]);
  assert.ok(
    bad.length > BUDGET - 6,
    `dangling references are down to ${bad.length} — lower BUDGET to ${bad.length}.`,
  );
});

test("the scan resolves this repo rather than finding nothing", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  // A path that has drifted reports zero dangling references and passes both assertions above.
  assert.ok(PRESENT.has("server.ts"), "the repo sweep found no server.ts — the root path is wrong");
  assert.ok(PRESENT.size > 500, `only saw ${PRESENT.size} files — the sweep is not seeing the repo`);
  assert.ok(resolves("page.ts"), "the .ts/.tsx fallback is not working");
  assert.ok(!resolves("definitely-not-a-real-file.ts"), "everything resolves — the check is vacuous");
});
