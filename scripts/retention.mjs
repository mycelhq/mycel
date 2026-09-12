#!/usr/bin/env node
// DOES ANYONE COME BACK — the other number this company did not have.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `activation-funnel.mjs` answers "where do signups stop". It says nothing about the people who did
// NOT stop, and retention is the discipline this product is graded hardest on and measured least.
// Every retention judgement made so far has been read off the CODE — "we have a digest", "we have a
// next-move list" — which grades the machine rather than the outcome. A product can hold every
// retention feature ever written and retain nobody.
//
// So this counts the only thing that settles it: after the week somebody started, did the business
// keep running work?
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT "RETAINED" MEANS HERE, AND WHY IT IS NOT LOGINS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A login is attention; a task is the product doing its job. Mycel's whole promise is that work
// happens whether or not the founder is looking, so counting sessions would punish exactly the
// outcome we are selling — a founder who trusts it enough to stop checking is the SUCCESS case, and
// a session-based metric records them as churned.
//
// So a week counts as retained when a task RAN for that org in it. Not succeeded — ran. A week of
// failing runs is a bad week and a real one, and folding failures into churn would flatter us by
// hiding our worst weeks inside a number that already looks like the customer's fault.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WEEK 0 IS EXCLUDED FROM THE DENOMINATOR ON PURPOSE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Everyone runs something in the week they sign up — onboarding itself does. Counting week 0 makes
// the first bar 100% and tells nobody anything. The question retention asks is whether they came
// BACK, so the cohort is "orgs whose first task was in week W" and the bars are weeks 1..N after it.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set. This reads production: pull it from the secret store first, e.g.\n" +
      "  DATABASE_URL=$(aws secretsmanager get-secret-value --secret-id mycel/database-url --query SecretString --output text) npm run retention",
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HORIZON = 8;

try {
  // One row per (org, week-with-activity). The week index is relative to the org's OWN first task,
  // which is what makes cohorts comparable across sign-up dates.
  const rows = await q(`
    WITH firsts AS (
      SELECT p.org_id, min(t.created_at) AS first_at
      FROM projects p JOIN tasks t ON t.project_id = p.id
      GROUP BY p.org_id
    )
    SELECT f.org_id, f.first_at, t.created_at
    FROM firsts f
    JOIN projects p ON p.org_id = f.org_id
    JOIN tasks t ON t.project_id = p.id
  `);

  if (!rows.length) {
    console.log("No org has ever run a task. There is no retention to measure yet — that is the finding.");
    process.exit(0);
  }

  /** org -> Set of week indices with at least one run. */
  const weeks = new Map();
  /** org -> first task time, to know how much horizon each org has actually HAD. */
  const firstAt = new Map();
  for (const r of rows) {
    const first = Date.parse(r.first_at);
    firstAt.set(r.org_id, first);
    const w = Math.floor((Date.parse(r.created_at) - first) / WEEK_MS);
    if (!weeks.has(r.org_id)) weeks.set(r.org_id, new Set());
    weeks.get(r.org_id).add(w);
  }

  const now = Date.now();
  console.log(`\n  ORGS THAT EVER RAN A TASK: ${weeks.size}\n`);
  console.log("  week   eligible   returned   rate");
  console.log("  ────────────────────────────────────");
  for (let w = 1; w <= HORIZON; w++) {
    /**
     * ELIGIBLE, not "all orgs". An org that started three days ago cannot have a week 4, and
     * counting it as churned would mean the metric falls every time someone new signs up — which is
     * the classic way a cohort chart is made to lie in the reassuring direction.
     */
    const eligible = [...firstAt.entries()].filter(([, at]) => now - at >= (w + 1) * WEEK_MS);
    if (!eligible.length) {
      console.log(`  ${String(w).padStart(4)}   ${"—".padStart(8)}   ${"—".padStart(8)}   not enough history yet`);
      continue;
    }
    const returned = eligible.filter(([org]) => weeks.get(org)?.has(w)).length;
    const rate = Math.round((returned / eligible.length) * 100);
    const bar = "█".repeat(Math.round(rate / 5));
    console.log(
      `  ${String(w).padStart(4)}   ${String(eligible.length).padStart(8)}   ${String(returned).padStart(8)}   ${String(rate).padStart(3)}% ${bar}`,
    );
  }

  // The single number worth quoting: of orgs old enough to have had a month, how many ran anything
  // in their fourth week. Four weeks is the shortest window in which "they kept using it" is a
  // claim rather than a hope.
  const monthEligible = [...firstAt.entries()].filter(([, at]) => now - at >= 5 * WEEK_MS);
  if (monthEligible.length) {
    const kept = monthEligible.filter(([org]) => weeks.get(org)?.has(4)).length;
    console.log(
      `\n  WEEK 4: ${kept}/${monthEligible.length} orgs still running work ` +
        `(${Math.round((kept / monthEligible.length) * 100)}%)\n`,
    );
  } else {
    console.log("\n  No org is five weeks old yet. Week 4 is the number to watch; come back when one is.\n");
  }
} finally {
  await pool.end();
}
