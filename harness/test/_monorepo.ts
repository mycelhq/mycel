// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// TESTS THAT CAN ONLY RUN INSIDE THE MONOREPO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// A handful of guards here measure things that live OUTSIDE the kernel: the Terraform in `infra/`,
// the console in `cloud/`, or a sweep over every sibling in the workspace. They are correct and worth
// keeping — "no new mechanism may be built and left unwired" has caught real dead code.
//
// They also cannot pass in the published repo, because those directories are deliberately absent
// from it. `docs/OPEN-CORE.md` is explicit about why: the firm layer is the paid product, and the
// kernel ships without it.
//
// ── WHY THIS MATTERS MORE THAN IT SOUNDS ──
//
// The public README's first instruction is `npm i && npm test`, with the promise "green. no keys, no
// Docker, no Postgres… if it is red, the clone is broken — not your machine." Eight of these fired on
// a fresh clone, so the first thing a stranger did failed, and the README told them the repo was
// broken. Measured by cloning it: 1595 passing, 1 failing, and the failing one was
// `B1 stranger-install: the advisory names the hang AND every way forward`.
//
// ── SKIP, NOT DELETE, AND NOT A SILENT PASS ──
//
// Deleting them would lose real coverage in the place it works. Making them pass vacuously outside
// the monorepo is worse than either: a guard that reports success when it measured nothing is the
// failure mode this repo keeps writing tests to avoid.
//
// `node:test` prints a skipped test with its reason, so the published suite is green AND honest about
// what it did not check.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The workspace root when this IS the monorepo; above the repo root when it is not. */
const ABOVE_KERNEL = join(import.meta.dirname, "..", "..", "..");

/**
 * Whether the sibling apps are here.
 *
 * Keyed on `cloud/` and `infra/` rather than on a marker file, because those are the two directories
 * these tests actually read — a marker could exist while the thing under test does not, which would
 * put the failure back with an extra step in front of it.
 */
export const inMonorepo = (): boolean =>
  existsSync(join(ABOVE_KERNEL, "cloud")) && existsSync(join(ABOVE_KERNEL, "infra"));

/**
 * The reason string, written once so every skipped test says the same true thing rather than six
 * paraphrases of it.
 */
export const ONLY_IN_MONOREPO =
  "only runs in the monorepo — this check reads cloud/ or infra/, which the published kernel does not ship (see docs/OPEN-CORE.md)";
