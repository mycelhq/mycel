#!/usr/bin/env node
// WHERE SIGNUPS STOP — the number this company did not have.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY A SCRIPT AND NOT A PAGE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This is not a customer's question. An agency does not care how many other agencies activated, and
// a console page for it would be a founder-of-Mycel tool wearing a product's clothes — plus one more
// route with no customer-facing caller. It answers ONE question, asked by one person, and a script is
// the honest shape for that.
//
// It exists because answering "are we building the right things" required hand-querying production
// Postgres, and the answer turned out to be the most important fact in the company:
//
//     Four outside signups. Three ran ZERO tasks. One got through two onboarding steps, skipped
//     connecting anything, left eighty-four seconds later, came back once two days afterwards, and
//     cancelled. Total engaged time across every outside user: about four minutes.
//
// A fact that expensive to obtain gets found once and then forgotten. This makes it one command.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IT COUNTS, AND WHY NOT POSTHOG
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `StepSeen` and `Advance` already send a funnel to PostHog, and that funnel is CONSENT-GATED —
// `analytics.tsx` will not initialise until `lib/consent` says yes. So the people most likely to
// bounce are also the people least likely to have consented, and the product's own funnel is
// blindest exactly where it matters most. The database has no such gap: a member row, its onboarding
// marks, and whether any task ever ran are facts we hold regardless.
//
// THE ONLY MILESTONE THAT COUNTS AS ACTIVATION IS A TASK THAT RAN. Not a completed onboarding, not a
// connected integration, not a subscription. Somebody who finished every screen and never ran a job
// has not used this product, and a funnel that counts them as activated is a funnel that will report
// success through an empty database.
//
//   npm run funnel              — everyone
//   npm run funnel -- --all     — including internal/demo accounts, which are excluded by default

import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL || process.env.MYCEL_DATABASE_URL;
if (!url) {
  process.stderr.write(
    "DATABASE_URL is not set. This reads production: pull it from the secret store first, e.g.\n" +
      "  DATABASE_URL=$(aws secretsmanager get-secret-value --secret-id mycel/database-url " +
      "--query SecretString --output text) npm run funnel\n",
  );
  process.exit(2);
}

/**
 * Accounts that are ours. Excluded by default because including them is how a funnel flatters
 * itself: the demo org has nine accepted deliverables and six paid invoices, all seeded on one
 * afternoon, and counting it turns "nobody has activated" into "sixty percent activate".
 */
const INTERNAL = /(^|@)(mycel|example)\.|^demo@|^founder@|^owner@|@test\./i;

const { Pool } = await import("pg");
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15_000 });

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const members = await q(`
  SELECT m.id, m.email, m.created_at, m.prefs, o.id AS org_id, o.name AS org_name, o.plan_status
  FROM members m
  LEFT JOIN orgs o ON o.id = m.org_id
  ORDER BY m.created_at DESC
`);

/**
 * ═══ A JOB MEANS CLIENT WORK, NOT OUR OWN MACHINERY RUNNING ON AN EMPTY BUSINESS ═══
 *
 * This counted every row in `tasks`, and on 2026-09-06 it reported "ran a job — 5 of 5, 100%".
 * Every one of those jobs, for three of the four outside accounts, was `harness-operator`:
 * `reflect_memory`, `review_work` and `review_artifacts`, three a day per project, spawned
 * automatically by a clock nobody asked for. They were reflecting on businesses with zero clients,
 * zero cases and zero deliverables. Not one of those three founders ever ran a single piece of
 * client work, and the funnel called all of them activated.
 *
 * That is the most expensive kind of metric: one that is technically true, points the wrong way,
 * and is read by the person deciding what to build. `harness-operator` has since been deleted, but
 * the counting rule was wrong independently of it — any future internal clock would do the same.
 *
 * So a job counts when a CLIENT would recognise it: it belongs to a case, or it produced an
 * artifact, or it is not machinery. `internal` on a task type is the wedge's own declaration that
 * no client ever opens its output, and machinery wedges are named because the whole wedge is ours.
 */
const MACHINERY_WEDGES = ["harness-operator", "business-shaper", "gtm-operator"];
const taskCounts = new Map(
  (await q(`SELECT p.org_id, count(t.id)::int AS n FROM projects p
            LEFT JOIN tasks t ON t.project_id = p.id
             AND t.wedge <> ALL($1::text[])
            GROUP BY p.org_id`, [MACHINERY_WEDGES])).map((r) => [r.org_id, r.n]),
);
/** Everything they ran, machinery included — so the gap between the two is visible, not hidden. */
const allTaskCounts = new Map(
  (await q(`SELECT p.org_id, count(t.id)::int AS n FROM projects p
            LEFT JOIN tasks t ON t.project_id = p.id GROUP BY p.org_id`)).map((r) => [r.org_id, r.n]),
);
const accepted = new Map(
  (await q(`SELECT p.org_id, count(d.id)::int AS n FROM projects p
            LEFT JOIN deliverables d ON d.project_id = p.id AND d.status = 'accepted'
            GROUP BY p.org_id`)).map((r) => [r.org_id, r.n]),
);

const showAll = process.argv.includes("--all");
const rows = members.filter((m) => showAll || !INTERNAL.test(m.email ?? ""));

/**
 * How long somebody actually used it — first job to last.
 *
 * The retention question, and the only one worth asking of a business whose value compounds. A
 * signup that ran fourteen jobs across two days and stopped is a completely different fact from one
 * that ran fourteen across two months, and a funnel that reports both as "activated" hides it.
 */
const life = new Map(
  (await q(`SELECT p.org_id, min(t.created_at) AS first, max(t.created_at) AS last
            FROM projects p JOIN tasks t ON t.project_id = p.id GROUP BY p.org_id`))
    .map((r) => [r.org_id, { first: r.first, last: r.last }]),
);

/** How far somebody got, in the only terms that matter. */
function stage(m) {
  const ob = m.prefs?.onboarding ?? {};
  const marks = Object.keys(ob.marks ?? {});
  const tasks = taskCounts.get(m.org_id) ?? 0;
  const all = allTaskCounts.get(m.org_id) ?? 0;
  if ((accepted.get(m.org_id) ?? 0) > 0) return "a client accepted work";
  if (tasks > 0) return `ran ${tasks} client job${tasks === 1 ? "" : "s"}`;
  // Said out loud rather than shown as a zero. "Nothing but our own machinery" is a finding about
  // the product, and rounding it to "never ran a job" loses the fact that the platform was busy.
  if (all > 0) return `ran nothing but our own machinery (${all} internal job${all === 1 ? "" : "s"})`;
  if (ob.left_at) return `left onboarding after ${marks.length} step${marks.length === 1 ? "" : "s"}`;
  if (marks.length) return `stalled in onboarding at step ${marks.length}`;
  if (m.prefs?.name || m.prefs?.avatar_url) return "signed in, never started onboarding";
  return "signed up, nothing after";
}

const line = "─".repeat(96);
process.stdout.write(`\n${line}\n  ACTIVATION — ${rows.length} account(s)${showAll ? "" : ", internal excluded"}\n${line}\n\n`);

for (const m of rows) {
  const ob = m.prefs?.onboarding ?? {};
  const skipped = Object.entries(ob.marks ?? {}).filter(([, v]) => v?.skipped).map(([k]) => k);
  process.stdout.write(
    `  ${String(m.email ?? "—").padEnd(34)} ${new Date(m.created_at).toISOString().slice(0, 10)}  ` +
      `${String(m.plan_status ?? "—").padEnd(10)} ${stage(m)}\n`,
  );
  if (skipped.length) process.stdout.write(`  ${" ".repeat(34)} skipped: ${skipped.join(", ")}\n`);
  /**
   * NOT "dwell time". `left_at` is when somebody left the ONBOARDING FLOW, which may be days after
   * signing up and says nothing about how long they stayed on the page. The first version of this
   * line printed the gap since signup and read as four days of engagement; it is a date, and that is
   * all it is.
   */
  if (ob.left_at) {
    process.stdout.write(`  ${" ".repeat(34)} left onboarding ${new Date(ob.left_at).toISOString().slice(0, 10)}\n`);
  }
  const span = life.get(m.org_id);
  if (span?.first) {
    const days = Math.max(1, Math.round((new Date(span.last) - new Date(span.first)) / 86_400_000));
    process.stdout.write(
      `  ${" ".repeat(34)} used it across ${days} day${days === 1 ? "" : "s"} ` +
        `(${new Date(span.first).toISOString().slice(0, 10)} → ${new Date(span.last).toISOString().slice(0, 10)})\n`,
    );
  }
}

// The one number. Everything above is how it is made.
const activated = rows.filter((m) => (taskCounts.get(m.org_id) ?? 0) > 0).length;
const delivered = rows.filter((m) => (accepted.get(m.org_id) ?? 0) > 0).length;
process.stdout.write(
  `\n${line}\n` +
    `  signed up            ${rows.length}\n` +
    `  ran CLIENT work      ${activated}   ${pct(activated, rows.length)}\n` +
    `  client accepted work ${delivered}   ${pct(delivered, rows.length)}\n` +
    `${line}\n\n` +
    `  A completed onboarding is not activation, a subscription is not activation, and neither is\n` +
    `  a job our own clock spawned on an empty business. CLIENT WORK is the milestone: a job whose\n` +
    `  output somebody outside this company would recognise. On 2026-09-06 the old rule read 100%\n` +
    `  here while three of four outside founders had never run one.\n\n`,
);

function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

await pool.end();
