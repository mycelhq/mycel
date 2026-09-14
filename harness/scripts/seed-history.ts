// Give the demo tenant a PAST, so the screens that plot one have something to plot.
//
// ═══ WHY THIS IS NOT PART OF seed-tenant.ts ═══
//
// `seed-tenant.ts` writes through the public API, and says so at length: "every row goes through the
// public API, so it passed the same validation, tenancy check and normalisation a founder's own
// click produces. Nothing here can construct a state the product itself could not reach."
//
// That rule is right, and it is exactly why this file cannot follow it. What the demo is missing is
// HISTORY — two months of finished runs, their costs, their failures, the approvals somebody sat and
// waited on. There is no API for that and there must never be one: `POST /v1/tasks` starts a REAL
// run, boots a sandbox and spends money, and an endpoint that could write a completed task dated six
// weeks ago would be an endpoint that could forge a customer's audit trail.
//
// So this writes SQL, deliberately, and is a different script with a different name so nobody
// mistakes it for the other guarantee. It is fabricating a past, which is a thing you may only ever
// do to a tenant that exists to be looked at.
//
// ═══ WHAT THE SCREENS ACTUALLY READ, WHICH IS NOT WHAT YOU WOULD GUESS ═══
//
// ANALYTICS IS DERIVED FROM `tasks`. `GET /v1/analytics` buckets tasks by day for the line, by wedge
// for the breakdown, and reads `approvals` for the how-long-a-human-takes number. There is no
// analytics table to fill — an empty analytics page means an empty task history, and the fix is a
// believable run log rather than a metrics fixture.
//
// CAMPAIGNS are `records` rows in collection `campaign` (singular — `CAMPAIGN_COLLECTIONS` in
// cloud/lib/gtm.ts accepts both spellings precisely because betting on one is how a screen silently
// shows nothing).
//
// DELIVERABLES need a `case_id` and a `client_id`, both NOT NULL, and their bytes live in
// `artifacts`, whose `task_id` is NOT NULL too. So a deliverable cannot exist without a task that
// produced it, which is the correct shape and the reason this file writes tasks first.
//
// ═══ THE RAIL ═══
//
// Same as its sibling, and for the same reason: it refuses unless the project it was handed really
// belongs to the org it was told. Rewritten after the sibling's rail was found to have never worked
// — it called `GET /v1/projects/:id`, a route that does not exist, and fell back to the answer it
// was checking. This one asks Postgres, which cannot 404 into a false positive.
//
//   MYCEL_SEED_DB_URL=... npx tsx harness/scripts/seed-history.ts \
//     --org-id <uuid> --project-id <uuid> [--wipe]

import { env, exit, argv } from "node:process";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { FILES, SUMMARY, seedVersions } from "./lib/revisions";
/*
  THE SAME WINDOW THE PRODUCT HONOURS, imported rather than retyped. A seeded gate whose row claims
  a different deadline from a real one is the exact defect `store.ts` documents at this constant —
  and the dead-run sweep reads `expires_at` to decide whether a gate is still worth protecting, so
  a wrong number here would have the demo empty itself again for a new reason.
*/
import { APPROVAL_TTL_MS } from "../src/store";

const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WANT_ORG = arg("--org-id") ?? "";
const PROJECT = arg("--project-id") ?? "";
const WIPE = argv.includes("--wipe");
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `--only gates` — GIVE THE SHOWROOM SOMETHING WAITING ON A HUMAN
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED ON THE DEMO TENANT, 14 September: fifteen approvals seeded `pending`, every one of them
 * `expired`, every owning task `failed` with "This run went silent while awaiting_approval", all
 * fifteen closed in the same second. The dead-run sweep reclaims anything non-terminal untouched
 * for ten minutes, `awaiting_approval` is non-terminal, and a seeded row is stale the moment it is
 * written. So the queue emptied itself within ten minutes of every seed this script has ever run,
 * and nobody saw it because nobody looks at a demo ten minutes after seeding it.
 *
 * What a visitor was left with, on the tenant the landing page embeds, under the heading for the
 * one promise this product is sold on: "Nothing to approve. Connect a mailbox so it can draft
 * something that needs you." A setup nag in the shop window.
 *
 * The sweep is fixed (`recovery.ts`: a run waiting on a person with an open approval is patient,
 * not dead). This is the other half — the queue those fifteen were supposed to be. It is separate
 * from the history build because it is the one part that must be RE-RUNNABLE: history is fabricated
 * once and then true, and a queue is a thing that gets emptied by anyone clicking through the demo.
 *
 *   --only gates [--gates 3]   ensure N pending approvals exist. Counts first, tops up, never
 *                              duplicates, and touches nothing else.
 */
const ONLY = arg("--only") ?? "all";
const WANT_GATES = Math.max(1, Number(arg("--gates") ?? 3));
const URL = env.MYCEL_SEED_DB_URL ?? env.DATABASE_URL ?? "";

const DAY = 86_400_000;
const now = Date.now();
const at = (daysAgo: number, hour = 9, minute = 0): Date =>
  new Date(now - daysAgo * DAY - (new Date(now).getUTCHours() - hour) * 3_600_000 - minute * 60_000);

/**
 * Deterministic pseudo-random from a string.
 *
 * `Math.random()` would make every run of this script produce a different past, so re-running it
 * after a wipe would silently change every number on the demo — and a screenshot taken yesterday
 * would stop matching the product today. Seeded from the row's own identity, the same demo is the
 * same demo.
 */
const rnd = (seed: string): number => {
  const h = createHash("sha256").update(seed).digest();
  return h.readUInt32BE(0) / 0xffffffff;
};

/**
 * The work this agency actually sells, as run types.
 *
 * Ridgeline Studio does AI-visibility reporting, site builds, local search and content — so the
 * wedges are `geo-monitor`, `product-builder`, `invoice-chaser` and `books-keeper`. NOT a spread
 * across every wedge on disk: a real agency does a few things over and over, and an analytics
 * breakdown showing ten equal slices is the tell that the data was generated rather than earned.
 */
const WORK: { wedge: string; type: string; weight: number; cost: [number, number] }[] = [
  { wedge: "geo-monitor", type: "visibility_report", weight: 34, cost: [0.28, 0.94] },
  { wedge: "geo-monitor", type: "competitor_sweep", weight: 12, cost: [0.18, 0.52] },
  { wedge: "product-builder", type: "build_feature", weight: 16, cost: [1.10, 4.30] },
  { wedge: "product-builder", type: "design_identity", weight: 6, cost: [0.70, 2.10] },
  { wedge: "invoice-chaser", type: "chase_overdue", weight: 18, cost: [0.04, 0.16] },
  { wedge: "books-keeper", type: "monthly_close", weight: 14, cost: [0.22, 0.75] },
];

const pickWork = (seed: string) => {
  const total = WORK.reduce((n, w) => n + w.weight, 0);
  let r = rnd(seed) * total;
  for (const w of WORK) {
    r -= w.weight;
    if (r <= 0) return w;
  }
  return WORK[0]!;
};

/**
 * Status, weighted to a business that mostly works.
 *
 * ~86% succeed. The rest is the honest tail: a few failures, a couple waiting on a human, one or two
 * that expired because nobody looked. A demo with a 100% success rate is not reassuring, it is
 * obviously fake — and the approvals number this feeds is only interesting if some runs actually
 * stopped and waited.
 */
const pickStatus = (seed: string): string => {
  const r = rnd(`s:${seed}`);
  if (r < 0.86) return "succeeded";
  if (r < 0.93) return "failed";
  if (r < 0.98) return "awaiting_approval";
  return "expired";
};

/**
 * What is actually waiting on the founder, with the words in it.
 *
 * Varied on purpose: a queue of one repeated action reads as a stuck loop rather than a day's work,
 * and the point of the screen is that a person can judge each item in about four seconds.
 *
 * ═══ `client` IS NOT DECORATION — THE CARD SHOWS BOTH ═══
 *
 * Seen on the live demo the first time `--only gates` ran: a card headed "Send an email to
 * office@delgado.build" with "Sunset Coffee Roasters" underneath it. The draft was picked at random
 * and the client was picked at random, so the address, the greeting ("Hi Tom") and the name on the
 * card were three different businesses.
 *
 * These are not generic templates — each one was written FOR somebody, names them in the first line
 * and refers to their work. So each one says who, the seeder resolves that against the real roster,
 * and a card that cannot be matched is not dealt at all. The queue is the screen this product is
 * sold on; a visitor who reads one card closely must not find three businesses in it.
 */
const APPROVAL_DRAFTS = [
  {
    action: "send_email",
    to: "ops@ridgeline.com",
    /** Matched against the real roster on `display_name`. */
    for: "Ridgeline",
    subject: "March visibility report — one thing to look at",
    body:
      "Hi Dan,\n\nMarch is attached. Short version: you are named in 6 of 9 buyer questions, up from 4 in February.\n\nThe one to look at is \"third party logistics UK\" — Kuehne+Nagel is taking that answer outright and it is the highest-intent question on the list. I have drafted a page for it; say the word and I will put it live this week.\n\nInvoice for March follows separately.\n\nRachel",
  },
  {
    action: "send_email",
    to: "admin@fairmont.com",
    /** Matched against the real roster on `display_name`. */
    for: "Fairmont",
    subject: "Fairview opening hours — which is right?",
    body:
      "Hi Sue,\n\nQuick one before I push the listings live. Google says Fairview closes at 17:00 on Fridays, your site says 18:30. Which should I use?\n\nThe other three practices matched, so this is the last thing holding the audit up.\n\nRachel",
  },
  {
    action: "send_invoice",
    to: "hello@willow.co",
    /** Matched against the real roster on `display_name`. */
    for: "Willow",
    subject: "Invoice 2041 — Webflow build, milestone 2",
    body:
      "Milestone 2 of 3, £8,750, due in 14 days.\n\nCovers the pricing page rebuild and the two template changes we agreed on the call. Milestone 3 invoices on launch.",
  },
  {
    action: "send_email",
    to: "office@delgado.build",
    /** Matched against the real roster on `display_name`. */
    for: "Delgado",
    subject: "Post-launch review — 30 days in",
    body:
      "Hi Tom,\n\nThe site has been up a month. Enquiries are running at 11 a week against 4 before, and the quote form is the page doing the work.\n\nOne thing worth fixing: the gallery is 8MB on mobile and it is the slowest page you have. Half a day to sort.\n\nRachel",
  },
  {
    action: "chase_overdue",
    to: "ops@ridgeline.com",
    for: "Ridgeline",
    subject: "Invoice 2038 — 47 days",
    body:
      "Hi Dan,\n\nInvoice 2038 (£4,200, March retainer) is 47 days past due. I know March was busy — is there anything holding it up on your side, or shall I resend to accounts?\n\nRachel",
  },
];

/** Stage order, mirroring cloud/lib/gtm.ts STAGES. Used only to make touch counts rise sensibly. */
const STAGE_ORDER = ["queued","warmed","invited","connected","dm1","dm2","em1","replied","booked","won","lost"];

/**
 * The same forty-six people the record seeder writes, reduced to what a CASE needs.
 *
 * Duplicated from `seed-tenant.ts` rather than imported because that file is API-driven and this one
 * is SQL-driven; importing across that boundary would tie a script that fabricates history to one
 * that promises it never does. The slug is the join key and is what keeps them in step.
 */
const PEOPLE_FOR_CASES: { slug: string; name: string; stage: string; location: string }[] = [
  { slug: "amara-boateng", name: "Amara Boateng", stage: "replied", location: "Bristol, UK" },
  { slug: "tom-hedley", name: "Tom Hedley", stage: "replied", location: "Manchester, UK" },
  { slug: "marcus-webb", name: "Marcus Webb", stage: "replied", location: "Austin, TX" },
  { slug: "elena-vasquez", name: "Elena Vasquez", stage: "replied", location: "Chicago, IL" },
  { slug: "priya-raman", name: "Priya Raman", stage: "booked", location: "Leeds, UK" },
  { slug: "james-okafor", name: "James Okafor", stage: "booked", location: "London, UK" },
  { slug: "sofia-marchetti", name: "Sofia Marchetti", stage: "won", location: "Dublin, IE" },
  { slug: "daniel-okoro", name: "Daniel Okoro", stage: "won", location: "Lagos, NG" },
  { slug: "rachel-nunn", name: "Rachel Nunn", stage: "em1", location: "Brighton, UK" },
  { slug: "victor-lindqvist", name: "Victor Lindqvist", stage: "em1", location: "Stockholm, SE" },
  { slug: "aisha-rahman", name: "Aisha Rahman", stage: "em1", location: "Birmingham, UK" },
  { slug: "grant-mcallister", name: "Grant McAllister", stage: "dm2", location: "Glasgow, UK" },
  { slug: "nina-petrova", name: "Nina Petrova", stage: "dm2", location: "Berlin, DE" },
  { slug: "oliver-bancroft", name: "Oliver Bancroft", stage: "dm2", location: "Cardiff, UK" },
  { slug: "chidi-nwosu", name: "Chidi Nwosu", stage: "dm1", location: "Toronto, CA" },
  { slug: "hannah-brooks", name: "Hannah Brooks", stage: "dm1", location: "Portland, OR" },
  { slug: "luca-ferrari", name: "Luca Ferrari", stage: "dm1", location: "Milan, IT" },
  { slug: "beatrice-adeyemi", name: "Beatrice Adeyemi", stage: "dm1", location: "Edinburgh, UK" },
  { slug: "jen-whitlock", name: "Jen Whitlock", stage: "connected", location: "Manchester, UK" },
  { slug: "samuel-reyes", name: "Samuel Reyes", stage: "connected", location: "Denver, CO" },
  { slug: "fiona-gallagher", name: "Fiona Gallagher", stage: "connected", location: "Belfast, UK" },
  { slug: "kenji-morita", name: "Kenji Morita", stage: "connected", location: "Vancouver, CA" },
  { slug: "clara-jensen", name: "Clara Jensen", stage: "connected", location: "Copenhagen, DK" },
  { slug: "tobias-schmidt", name: "Tobias Schmidt", stage: "invited", location: "Munich, DE" },
  { slug: "amelia-hart", name: "Amelia Hart", stage: "invited", location: "Melbourne, AU" },
  { slug: "ryan-doherty", name: "Ryan Doherty", stage: "invited", location: "Boston, MA" },
  { slug: "yuki-tanaka", name: "Yuki Tanaka", stage: "invited", location: "Singapore, SG" },
  { slug: "martin-oduya", name: "Martin Oduya", stage: "invited", location: "Nairobi, KE" },
  { slug: "sara-lindberg", name: "Sara Lindberg", stage: "invited", location: "Oslo, NO" },
  { slug: "declan-moore", name: "Declan Moore", stage: "warmed", location: "Cork, IE" },
  { slug: "priscilla-owens", name: "Priscilla Owens", stage: "warmed", location: "New York, NY" },
  { slug: "andre-silva", name: "Andre Silva", stage: "warmed", location: "Lisbon, PT" },
  { slug: "meera-kapoor", name: "Meera Kapoor", stage: "warmed", location: "Bengaluru, IN" },
  { slug: "callum-frazer", name: "Callum Frazer", stage: "warmed", location: "Perth, AU" },
  { slug: "isabelle-dubois", name: "Isabelle Dubois", stage: "queued", location: "Lyon, FR" },
  { slug: "nathan-cole", name: "Nathan Cole", stage: "queued", location: "Auckland, NZ" },
  { slug: "zainab-hassan", name: "Zainab Hassan", stage: "queued", location: "Dubai, AE" },
  { slug: "peter-vandenberg", name: "Peter van den Berg", stage: "queued", location: "Amsterdam, NL" },
  { slug: "grace-mwangi", name: "Grace Mwangi", stage: "queued", location: "Cape Town, ZA" },
  { slug: "eli-rosenthal", name: "Eli Rosenthal", stage: "queued", location: "Tel Aviv, IL" },
  { slug: "charlotte-white", name: "Charlotte White", stage: "queued", location: "Wellington, NZ" },
  { slug: "omar-benali", name: "Omar Benali", stage: "queued", location: "Casablanca, MA" },
  { slug: "sinead-kelly", name: "Sinead Kelly", stage: "queued", location: "Galway, IE" },
  { slug: "gregory-payne", name: "Gregory Payne", stage: "lost", location: "Miami, FL" },
  { slug: "leila-mansour", name: "Leila Mansour", stage: "lost", location: "Marseille, FR" },
  { slug: "stuart-bell", name: "Stuart Bell", stage: "lost", location: "Newcastle, UK" },
];


/**
 * A believable hour for a booked call, stable per person.
 *
 * Weekdays only, 10:00–16:00 UTC, never on the hour twice in a row. A demo whose meetings are all at
 * 09:00 tomorrow reads as fixture data; one at 14:30 on Thursday reads as somebody's week.
 */
function meetingSlot(slug: string): string {
  const d = new Date();
  // 1–6 days out, skipping the weekend so a Friday seed does not book a Sunday.
  let ahead = 1 + Math.floor(rnd(`meet:${slug}`) * 6);
  const at = new Date(d.getTime());
  while (ahead > 0) {
    at.setUTCDate(at.getUTCDate() + 1);
    const day = at.getUTCDay();
    if (day !== 0 && day !== 6) ahead -= 1;
  }
  const hour = 10 + Math.floor(rnd(`hour:${slug}`) * 7);
  const half = rnd(`half:${slug}`) < 0.5 ? 0 : 30;
  at.setUTCHours(hour, half, 0, 0);
  return at.toISOString();
}

/**
 * Ensure the demo has work genuinely waiting on a person, and never more than it asked for.
 *
 * ═══ WHY IT COUNTS BEFORE IT WRITES ═══
 *
 * The history build is fabricated once and then true. A queue is not: anyone clicking through the
 * demo can empty it, and this is the one part of the seed meant to be run again next week. Counting
 * the live gates first is what makes "run it again" safe — the alternative is a shop window with
 * thirty drafts waiting, which reads as neglect rather than as a business mid-flight.
 *
 * ═══ WHAT COUNTS AS LIVE ═══
 *
 * A pending approval on a NON-TERMINAL task. `GET /v1/approvals` refuses to show a pending approval
 * whose task has gone terminal — correctly, since nothing will ever come back to ask — so counting
 * the approvals table alone would see a queue the product does not.
 *
 * ═══ RECENT, AND ONLY A FEW ═══
 *
 * Dated across the last thirty hours rather than spread over the ten weeks the history covers. A
 * card reading "waiting 63 days" is not a gate a founder is about to answer, it is evidence nobody
 * is minding the business, and it is the first thing a visitor reads on the screen we sell on.
 *
 * `expires_at` is stamped with the approval's real window (`APPROVAL_TTL_MS`, imported), so a
 * seeded gate is as live as a real one and the sweep leaves it alone for exactly as long.
 */
async function ensureGates(db: pg.Client): Promise<void> {
  const live = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM public.approvals a
       JOIN public.tasks t ON t.id = a.task_id
      WHERE t.project_id = $1
        AND a.status = 'pending'
        AND t.status NOT IN ('succeeded','failed','rejected','expired','cancelled')`,
    [PROJECT],
  );
  const have = live.rows[0]?.n ?? 0;
  if (have >= WANT_GATES) {
    console.log(`  ${have} approval(s) already waiting on a human — nothing to do`);
    return;
  }

  /*
    `handles` comes back too, and the card is why. `approval-card.tsx` resolves the recipient address
    against the founder's own client list and renders the BUSINESS NAME when it matches — "Willow &
    Pine" rather than "hello@willow.co". Seeding the draft's own written-in address meant it never
    matched, so the one screen this product is sold on introduced every card by an email address.
    The address inside the draft is decoration; the client's real handle is what makes the row read.
  */
  const clients = await db.query<{ id: string; display_name: string; handles: unknown }>(
    `SELECT id, display_name, handles FROM public.clients WHERE project_id = $1 ORDER BY created_at`,
    [PROJECT],
  );
  if (clients.rows.length === 0) throw new Error("no clients on this project — run seed-tenant.ts --only book first");
  const emailOf = (c: { handles: unknown }): string | undefined => {
    const list = Array.isArray(c.handles) ? c.handles : [];
    return list.find((h): h is string => typeof h === "string" && h.includes("@"));
  };
  const cases = await db.query<{ id: string; client_id: string }>(
    `SELECT id, client_id FROM public.cases WHERE project_id = $1 ORDER BY created_at`,
    [PROJECT],
  );

  const WEDGE_FOR: Record<string, { wedge: string; type: string }> = {
    send_email: { wedge: "geo-visibility", type: "visibility_report" },
    send_invoice: { wedge: "invoice-chaser", type: "raise_invoice" },
    chase_overdue: { wedge: "invoice-chaser", type: "chase_overdue" },
  };

  /*
    DEALT FROM THE DECK, NOT DRAWN WITH REPLACEMENT. The first run of this produced two cards
    reading "Invoice 2041 — Webflow build, milestone 2" for two different clients, which is the
    "queue of one repeated action reads as a stuck loop" failure the drafts list exists to avoid,
    reintroduced by the picker.

    And each draft goes to the client it was WRITTEN for. `for` is matched against the real roster;
    a draft whose business is not on this tenant's books is skipped rather than mailed at a
    stranger, because a card naming three different companies is worse than one card fewer.
  */
  const dealt = APPROVAL_DRAFTS.map((d) => ({
    draft: d,
    client: clients.rows.find((c) => c.display_name.toLowerCase().includes(d.for.toLowerCase())),
  })).filter(
    (x): x is { draft: (typeof APPROVAL_DRAFTS)[number]; client: (typeof clients.rows)[number] } =>
      !!x.client && !!emailOf(x.client),
  );
  if (!dealt.length) throw new Error("no draft matches any client on this project — the roster and APPROVAL_DRAFTS have drifted apart");

  for (let i = have; i < WANT_GATES; i++) {
    const seed = `${PROJECT}:gate:${i}`;
    // Modulo rather than random: WANT_GATES above the deck size repeats in order instead of
    // colliding at random, and three gates against five drafts never repeats at all.
    const hand = dealt[i % dealt.length]!;
    const draft = hand.draft;
    const client = hand.client;
    const work = WEDGE_FOR[draft.action] ?? WEDGE_FOR.send_email!;
    const kase = cases.rows.find((k) => k.client_id === client.id) ?? null;
    /*
      Across this morning, newest first, so the queue reads as a day's work — and so every one of
      them is comfortably inside its own 24-hour window. A gate seeded 30 hours ago is already
      expired on arrival, which would have reproduced the bug this mode exists to undo.
    */
    const created = new Date(now - Math.round((0.5 + i * 3 + rnd(`h:${seed}`) * 2) * 3_600_000));
    const taskId = randomUUID();
    await db.query(
      `INSERT INTO public.tasks
         (id, project_id, case_id, wedge, task_type, actor, input, constraints, tools, status,
          cost_usd, event_seq, created_at, updated_at, client_id, source)
       VALUES ($1,$2,$3,$4,$5,'{"kind":"schedule"}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,
               'awaiting_approval',$6,0,$7,$7,$8,'demo-history')`,
      [taskId, PROJECT, kase?.id ?? null, work.wedge, work.type, (0.05 + rnd(`$:${seed}`) * 0.3).toFixed(4), created, client.id],
    );
    await db.query(
      `INSERT INTO public.approvals (approval_id, task_id, action, risk, preview, status, created_at, expires_at)
       VALUES ($1,$2,$3,'medium',$4::jsonb,'pending',$5,$6)`,
      [
        randomUUID(), taskId, draft.action,
        JSON.stringify({
          // The client's OWN address, not the one written into the draft — see `emailOf` above.
          to: emailOf(client) ?? draft.to,
          subject: draft.subject,
          body: draft.body,
          preview: `${draft.action.replace(/_/g, " ")} to ${emailOf(client) ?? draft.to}`,
          client: client.display_name,
          connection: "Zoho — hello@ridgelinestudio.com",
        }),
        created,
        new Date(created.getTime() + APPROVAL_TTL_MS),
      ],
    );
    console.log(`  + ${draft.action} for ${client.display_name} — "${draft.subject}"`);
  }
  console.log(`\n  ${WANT_GATES} approval(s) now waiting on a human`);
}

async function main() {
  if (!URL) throw new Error("MYCEL_SEED_DB_URL (or DATABASE_URL) is required");
  if (!WANT_ORG || !PROJECT) throw new Error("--org-id and --project-id are both required");

  const db = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // ── The rail. Postgres cannot 404 into a false positive the way the sibling's HTTP check did. ──
  const owner = await db.query<{ org_id: string; name: string }>(
    `SELECT org_id, name FROM public.projects WHERE id = $1`,
    [PROJECT],
  );
  if (owner.rows.length === 0 || owner.rows[0]!.org_id !== WANT_ORG) {
    console.error(
      `\n  ✗ refusing.\n` +
        `    --project-id ${PROJECT}\n` +
        `    --org-id     ${WANT_ORG}\n` +
        `    actually in  ${owner.rows[0]?.org_id ?? "(no such project)"}\n\n` +
        `  This script FABRICATES a past. It only ever does that to the tenant you name.\n`,
    );
    await db.end();
    exit(1);
  }
  console.log(`seeding history into "${owner.rows[0]!.name}" (${PROJECT})\n`);

  if (ONLY === "gates") {
    await ensureGates(db);
    await db.end();
    return;
  }

  if (WIPE) {
    /**
     * Unwound in dependency order, because a task is not a leaf.
     *
     * `artifacts.task_id` and `approvals.task_id` are both NOT NULL foreign keys, and deliverables
     * point at the artifacts. Deleting tasks first therefore fails on
     * `artifacts_task_id_fkey` — which it did, on the first re-run, AFTER the approvals had already
     * been cleared. A wipe that half-succeeds is worse than one that refuses, so this goes
     * children-first and every statement is scoped to rows this script wrote.
     */
    const scope = `SELECT id FROM public.tasks WHERE project_id = $1 AND source = 'demo-history'`;
    await db.query(
      `DELETE FROM public.deliverables d
        WHERE d.project_id = $1
          AND d.id LIKE 'del_%'
          AND EXISTS (SELECT 1 FROM public.artifacts a WHERE a.task_id IN (${scope}) AND a.client_id = d.client_id)`,
      [PROJECT],
    );
    await db.query(`DELETE FROM public.artifacts WHERE task_id IN (${scope})`, [PROJECT]);
    // GTM cases carry no task_id, so they need their own clause or a re-run doubles the pipeline.
    await db.query(
      `DELETE FROM public.cases WHERE project_id = $1 AND wedge = 'gtm-operator' AND data->>'source' = 'demo-seed'`,
      [PROJECT],
    );
    await db.query(`DELETE FROM public.approvals WHERE task_id IN (${scope})`, [PROJECT]);
    /**
     * ═══ AND `events`, WHICH THIS LIST WAS MISSING ═══
     *
     * The note above says a task is not a leaf and then names two of its children. There is a
     * third: `events.task_id` is a NOT NULL foreign key too, and the delete below failed on
     * `events_task_id_fkey` — AFTER the deliverables and artifacts were already gone. Exactly the
     * half-succeeded wipe the note warns about, caused by the note's own list being incomplete.
     *
     * Found by running it: the demo tenant was left with nine deliverables, no artifacts and four
     * hundred tasks that would not delete.
     */
    await db.query(`DELETE FROM public.events WHERE task_id IN (${scope})`, [PROJECT]);
    const w = await db.query(
      `WITH gone AS (
         DELETE FROM public.tasks WHERE project_id = $1 AND source = 'demo-history' RETURNING id
       ) SELECT count(*)::int AS n FROM gone`,
      [PROJECT],
    );
    console.log(`  wiped ${w.rows[0]?.n ?? 0} previously seeded tasks and everything hanging off them`);
  }

  const clients = await db.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM public.clients WHERE project_id = $1 ORDER BY created_at`,
    [PROJECT],
  );
  const cases = await db.query<{ id: string; title: string; client_id: string }>(
    `SELECT id, title, client_id FROM public.cases WHERE project_id = $1 ORDER BY created_at`,
    [PROJECT],
  );
  if (clients.rows.length === 0) throw new Error("no clients on this project — run seed-tenant.ts --only book first");
  console.log(`  ${clients.rows.length} clients, ${cases.rows.length} cases to hang work off\n`);

  // ── 1. THE RUN LOG, which is what the analytics graphs are ────────────────
  //
  // 70 days back. Weekdays busy, weekends nearly idle — the shape of the line is what makes it read
  // as a real business, and a flat 20-a-day would say "generated" from across the room.
  const taskIds: { id: string; day: number; wedge: string; type: string; clientId: string; caseId: string | null }[] = [];
  let inserted = 0;
  for (let d = 70; d >= 0; d--) {
    const dow = new Date(now - d * DAY).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const base = weekend ? 1 : 5;
    const count = base + Math.floor(rnd(`n:${d}`) * (weekend ? 2 : 6));

    for (let i = 0; i < count; i++) {
      const seed = `${PROJECT}:${d}:${i}`;
      const work = pickWork(seed);
      const status = pickStatus(seed);
      const client = clients.rows[Math.floor(rnd(`c:${seed}`) * clients.rows.length)]!;
      const kase = cases.rows.length ? cases.rows[Math.floor(rnd(`k:${seed}`) * cases.rows.length)]! : null;
      const cost = status === "succeeded" || status === "failed"
        ? work.cost[0] + rnd(`$:${seed}`) * (work.cost[1] - work.cost[0])
        : 0;
      const created = at(d, 8 + Math.floor(rnd(`h:${seed}`) * 9), Math.floor(rnd(`m:${seed}`) * 60));
      const id = randomUUID();

      await db.query(
        `INSERT INTO public.tasks
           (id, project_id, case_id, wedge, task_type, actor, input, constraints, tools, status,
            cost_usd, event_seq, created_at, updated_at, client_id, source)
         VALUES ($1,$2,$3,$4,$5,'{"kind":"schedule"}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,
                 $6,$7,0,$8,$8,$9,'demo-history')`,
        [id, PROJECT, kase?.id ?? null, work.wedge, work.type, status, cost.toFixed(4), created, client.id],
      );
      taskIds.push({ id, day: d, wedge: work.wedge, type: work.type, clientId: client.id, caseId: kase?.id ?? null });
      inserted++;

      /**
       * Approvals, on the runs that stopped for one.
       *
       * ═══ THE PREVIEW IS THE WHOLE CARD, AND IT WAS EMPTY ═══
       *
       * This first shipped with `preview: '{}'`, which produced fourteen identical cards reading
       * "send an email / approve and send" with nothing inside them. `approval-card.tsx` renders
       * `preview.to`, `preview.subject` and `preview.body` — its own header says the card must show
       * "what, to whom, through which connection, and the exact words that will be sent" — so an
       * empty preview does not degrade the card, it guts it.
       *
       * That matters more here than anywhere else in the seed: the approval gate is the single thing
       * this product is sold on. A queue of blank confirmations is an argument AGAINST it, because it
       * shows a founder being asked to rubber-stamp things they cannot read.
       *
       * `decided_at` is what makes the "how long a human takes" figure real, so it stays null on the
       * ones still waiting.
       */
      const pending = status === "awaiting_approval";
      if (pending || rnd(`a:${seed}`) < 0.04) {
        const waited = 25 + rnd(`w:${seed}`) * 320; // minutes
        const decided = pending ? null : new Date(created.getTime() + waited * 60_000);
        /**
         * ═══ THE LINE THAT IS SUPPOSED TO FALL ═══
         *
         * "How much still needs you" reads `involvementByWeek`, which counts `auto_approved` as
         * WITHOUT you and everything else as WITH you. This seed only ever wrote `approved` and
         * `pending`, so the demo drew a flat line at 100% — the product's headline promise, plotted,
         * failing, in the shop window.
         *
         * That chart is deliberately allowed to say the promise is not being kept; its own note
         * argues for that, and in PRODUCTION it should keep saying it until it is. But the demo
         * exists to show the product working, and a business that has been running for ten weeks and
         * granted standing approvals is one where the line falls. So it falls — from everything
         * stopping at a person in week one to about a third by the last week.
         *
         * It is not decoration, and the demo stays internally consistent: `seed-tenant` grants the
         * standing approvals that would have produced exactly this, so a visitor who follows the
         * caption to Standing approvals finds the rules that explain the fall.
         */
        const weeksAgo = Math.floor(d / 7);
        const totalWeeks = Math.ceil(70 / 7);
        // Oldest week ~0% unattended, newest ~65%. `d` counts days BACK, so it falls as d shrinks.
        const unattended = 0.65 * (1 - weeksAgo / totalWeeks);
        const alone = !pending && rnd(`auto:${seed}`) < unattended;
        const draft = APPROVAL_DRAFTS[Math.floor(rnd(`d:${seed}`) * APPROVAL_DRAFTS.length)]!;
        await db.query(
          `INSERT INTO public.approvals (approval_id, task_id, action, risk, preview, status, created_at, decided_at)
           VALUES ($1,$2,$3,'medium',$4::jsonb,$5,$6,$7)`,
          [
            randomUUID(), id, draft.action,
            JSON.stringify({
              to: draft.to,
              subject: draft.subject,
              body: draft.body,
              preview: `${draft.action.replace(/_/g, " ")} to ${draft.to}`,
              client: client.display_name,
              connection: "Zoho — hello@ridgelinestudio.com",
            }),
            pending ? "pending" : alone ? "auto_approved" : "approved", created, decided,
          ],
        );
      }
    }
  }
  console.log(`  tasks       ${inserted} across 70 days`);

  // ── 2. DELIVERABLES, with bytes somebody can open ─────────────────────────

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * EVERY CSV WAS THE SAME LOGISTICS REPORT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `csv()` generated one question set — "who ships pallets to Ireland", "third party logistics UK",
   * "pallet delivery quote" — and handed it to every report on the tenant. So a prospect opening
   * FAIRMONT DENTAL's listings audit read about freight forwarding, and so did PIKE STREET
   * KITCHEN's reviews summary.
   *
   * The note under `MD` records the founder rejecting exactly this in the markdown deliverables —
   * "six generic headings that could have been about any client on any project" — and the fix
   * stopped at the markdown. A report that is about the wrong industry is worse than a shallow one:
   * shallow reads as thin, wrong reads as a demo assembled from one template, which is the thing
   * the demo exists to disprove.
   *
   * Each report now carries its own COLUMNS as well as its own rows, because that is most of what
   * makes one convincing. A listings audit is not question/surface/named/position — it is a
   * directory, what it says, and whether that matches. Written out rather than generated: a
   * prospect opens one of these, and determinism across re-seeds is worth more here than variety.
   */
  const VISIBILITY_QUESTIONS = [
    "best logistics company near me", "who ships pallets to Ireland", "third party logistics UK",
    "same day courier Leeds", "freight forwarder for small business", "warehousing and fulfilment UK",
    "best 3PL for ecommerce", "pallet delivery quote", "customs clearance help UK",
  ];

  /** Answer-engine visibility. Genuinely Ridgeline's report, and only theirs. */
  const visibilityCsv = (seed: string) => {
    const rows = ["question,surface,named,position,checked_at"];
    for (let i = 0; i < VISIBILITY_QUESTIONS.length; i++) {
      for (const surface of ["ChatGPT", "Perplexity", "Google AI Overview"]) {
        const named = rnd(`${seed}:${i}:${surface}`) > 0.55;
        const pos = named ? 1 + Math.floor(rnd(`p:${seed}:${i}:${surface}`) * 5) : "";
        rows.push(`"${VISIBILITY_QUESTIONS[i]}",${surface},${named ? "yes" : "no"},${pos},${at(3).toISOString()}`);
      }
    }
    return rows.join("\n");
  };

  const CSV: Record<string, string> = {
    // Four practices, one brand. The audit a dental group actually pays for: whether the same name,
    // address and hours appear everywhere a patient looks.
    "fairmont-listings-audit.csv": [
      "practice,directory,name_matches,address_matches,phone_matches,hours_match,status",
      "Fairview Road,Google Business Profile,yes,yes,yes,no,hours say closed Saturday — the practice opens 9-1",
      "Fairview Road,Apple Maps,yes,yes,yes,yes,ok",
      "Fairview Road,Bing Places,yes,no,yes,yes,unit number missing from address line 1",
      "Fairview Road,NHS.uk,yes,yes,no,yes,old landline — reception moved to the 0330 number in March",
      "Oakwell,Google Business Profile,yes,yes,yes,yes,ok",
      "Oakwell,Apple Maps,no,yes,yes,yes,\"listed as Oakwell Dental Surgery, brand is Oakwell Dental Care\"",
      "Oakwell,Bing Places,yes,yes,yes,no,no hours at all",
      "Oakwell,NHS.uk,yes,yes,yes,yes,ok",
      "Marsh Lane,Google Business Profile,yes,yes,no,yes,phone points at the closed Marsh Lane annexe",
      "Marsh Lane,Apple Maps,yes,yes,no,yes,same old number",
      "Marsh Lane,Bing Places,no,no,no,no,not listed",
      "Marsh Lane,NHS.uk,yes,yes,yes,yes,ok",
      "Kingsmead,Google Business Profile,yes,yes,yes,yes,ok",
      "Kingsmead,Apple Maps,yes,yes,yes,yes,ok",
      "Kingsmead,Bing Places,yes,yes,yes,yes,ok",
      "Kingsmead,NHS.uk,yes,no,yes,yes,\"address still shows the pre-2024 suite\"",
    ].join("\n"),

    // Home care is hyper-local: the question is which town you rank in, not which keyword.
    "cedar-local-seo.csv": [
      "town,search,position_now,position_last_month,map_pack,note",
      "Harpenden,home care Harpenden,3,7,yes,moved into the map pack after the hours fix",
      "Harpenden,live in carer Harpenden,6,6,no,",
      "Harpenden,dementia care at home Harpenden,4,9,yes,new page published 14 Aug",
      "St Albans,home care St Albans,8,11,no,three chains above you all have review counts over 40",
      "St Albans,live in carer St Albans,12,12,no,",
      "St Albans,respite care St Albans,5,5,yes,",
      "Wheathampstead,home care Wheathampstead,1,2,yes,",
      "Wheathampstead,elderly care Wheathampstead,2,4,yes,",
      "Redbourn,home care Redbourn,9,14,no,no page for this town yet — everything ranks off the St Albans one",
      "Redbourn,carers Redbourn,15,18,no,same",
    ].join("\n"),

    // A restaurant's reviews are the deliverable. Themes and what they cost, not sentiment scores.
    "pike-reviews-summary.csv": [
      "source,reviews_30d,average,theme,mentions,direction",
      "Google,41,4.6,service speed at lunch,11,worse than last month",
      "Google,41,4.6,the short rib,9,better",
      "Google,41,4.6,noise level,6,unchanged",
      "Google,41,4.6,card machine declined,4,new this month",
      "TripAdvisor,12,4.4,booking system,5,worse than last month",
      "TripAdvisor,12,4.4,portion size,3,unchanged",
      "OpenTable,23,4.7,front of house,14,better",
      "OpenTable,23,4.7,wait for the bill,7,worse than last month",
      "Yelp,6,4.2,vegetarian options,4,unchanged",
      "Yelp,6,4.2,parking,3,unchanged",
    ].join("\n"),

    // Who takes the answer when Ridgeline does not.
    "ridgeline-competitor-sweep.csv": [
      "question,winner,their_page,why_they_win,ridgeline_position",
      "\"third party logistics UK\",Kuehne+Nagel,capability page,answers in the first paragraph,4",
      "\"best 3PL for ecommerce\",DSV,solutions page,names the platforms they integrate with,not named",
      "\"who ships pallets to Ireland\",Ridgeline,routes page,only page that lists the Dublin lane,1",
      "\"pallet delivery quote\",Palletways,quote form,price is on the page,6",
      "\"customs clearance help UK\",DHL,guide,written as an answer not a brochure,not named",
      "\"warehousing and fulfilment UK\",Ridgeline,warehousing page,square footage and locations stated,2",
      "\"same day courier Leeds\",CitySprint,city page,a page per city,not named",
      "\"freight forwarder for small business\",Ridgeline,pricing page,the only one showing a minimum,1",
      "\"best logistics company near me\",Kuehne+Nagel,homepage,brand strength,5",
    ].join("\n"),
  };

  /**
   * ═══ THE SENTENCE A CLIENT READS BEFORE THEY OPEN ANYTHING ═══
   *
   * A version's `summary` is the covering note. It is what the portal shows in the list, what the
   * email quotes, and for most clients it is the whole deliverable — they read it and never open
   * the attachment. So it says the finding, not the fact that a finding exists.
   */

  const csv = (title: string, name: string, seed: string) => {
    const written = CSV[name];
    if (written) return written;
    // The visibility reports, which are Ridgeline's and where the shared question set is correct.
    if (name.startsWith("ridgeline-visibility")) return visibilityCsv(seed);
    // Nothing else should reach here. A silent generic report is exactly the bug above, so this
    // fails the seed rather than shipping one.
    throw new Error(`seed-history: no written CSV for ${name} (${title}) — add one to CSV`);
  };

  /**
   * ═══ A DELIVERABLE HAS TO SURVIVE BEING OPENED ═══
   *
   * The first version of this was six generic headings that could have been about any client on any
   * project — "Reviewed the current page against three competitors" — and the founder's verdict was
   * "shallow md file", which was correct. A prospect opens exactly one of these, and a document that
   * says nothing specific proves the opposite of what it was seeded to prove.
   *
   * So each one carries the things only a real engagement produces: named competitors, actual
   * numbers, a decision the client has to make, and a cost. Written per-client rather than from a
   * template, because a template is what it looked like.
   */
  const MD: Record<string, string> = {
    "willow-pricing-copy.md": [
      "# Willow & Pine — pricing page copy",
      "",
      "**Status:** ready for your review · **Version 2** · Ridgeline Studio",
      "",
      "## The problem with v1",
      "",
      "The old page led with \"Flexible packages for every business\", which tested worst of the four",
      "headlines we ran. It describes you, not the reader, and it makes a visitor do the work of",
      "guessing whether they can afford you. 61% of sessions left without scrolling past the fold.",
      "",
      "## What changed",
      "",
      "| Section | Before | After |",
      "| --- | --- | --- |",
      "| Headline | Flexible packages for every business | A Webflow site, live in six weeks, from £8,750 |",
      "| Price | Below three tiers, after a form | Above the fold, in the headline |",
      "| Proof | None | Two named builds with before/after enquiry counts |",
      "| CTA | \"Get in touch\" | \"See a build we shipped last month\" |",
      "",
      "## The number that matters",
      "",
      "Putting the price in the headline will reduce enquiries and increase qualified enquiries. On",
      "the three other clients we have done this for, total enquiries fell 30-40% and booked calls",
      "rose. If you are measured on enquiry volume rather than revenue, say so now and we will",
      "reverse it.",
      "",
      "## Decisions we need from you",
      "",
      "1. **Is £8,750 the number we publish?** It is your current floor. Publishing it makes it hard",
      "   to charge less without explaining why.",
      "2. **May we name Fairmont and Delgado as the two proof builds?** We have not asked them.",
      "",
      "## What happens when you approve",
      "",
      "Copy goes into Webflow the same day. The page is behind a staging password until you confirm,",
      "then it replaces /pricing and the old URL redirects. No other page changes.",
      "",
      "*Time on this: 3h 20m. Included in the March retainer.*",
      "",
    ].join("\n"),
    "marlow-q2-content-plan.md": [
      "# Marlow & Associates — Q2 content plan",
      "",
      "**Twelve pieces, April to June** · Ridgeline Studio",
      "",
      "## What Q1 told us",
      "",
      "Nine pieces published. Two did essentially all the work:",
      "",
      "- *\"What happens if you die without a will in England\"* — 4,102 sessions, 31 enquiries",
      "- *\"How long does probate actually take\"* — 2,870 sessions, 19 enquiries",
      "",
      "The other seven produced 41 sessions between them. The pattern is not subtle: pieces answering",
      "a question somebody types in a bad moment convert. Pieces about your firm do not.",
      "",
      "## Q2, therefore",
      "",
      "Ten of the twelve are direct-answer pieces on questions with real search volume and no good",
      "answer currently ranking. Two are firm pieces, kept because you asked for them.",
      "",
      "1. Can an executor be removed, and who decides",
      "2. What a deed of variation costs and when it is worth it",
      "3. Intestacy rules when there are stepchildren",
      "4. How long a contested probate takes in practice",
      "5. What happens to a jointly owned house",
      "6. Lasting power of attorney — the two types, plainly",
      "7. Care home fees and the seven-year rule",
      "8. Digital assets in a will",
      "9. Executor's personal liability",
      "10. Trusts for a disabled beneficiary",
      "11. *Meet the private client team* (firm piece)",
      "12. *Our approach to fixed fees* (firm piece)",
      "",
      "## What we need from you",
      "",
      "**One 30-minute call with Sarah per piece, for pieces 1-10.** This is the whole reason Q1's two",
      "winners worked — they contain things only a practising solicitor knows, and no amount of",
      "research substitutes. Without the calls we can still write them; they will read like everyone",
      "else's and perform like the other seven.",
      "",
      "*Twelve pieces at £280 = £3,360. Invoiced monthly across Q2.*",
      "",
    ].join("\n"),
    "delgado-launch-review.md": [
      "# Delgado Builders — 30 days after launch",
      "",
      "Site went live 14 March. This covers 14 March to 13 April against the same window last year.",
      "",
      "## Enquiries",
      "",
      "| | Before | After | Change |",
      "| --- | --- | --- | --- |",
      "| Enquiries per week | 4.1 | 11.3 | **+176%** |",
      "| From the quote form | 0 | 8.2 | new |",
      "| Phone | 4.1 | 3.1 | -24% |",
      "",
      "Phone enquiries fell and that is fine — the quote form is absorbing them and it captures job",
      "type and postcode, which the phone did not. You are getting more information about more people.",
      "",
      "## What is working",
      "",
      "The quote form is doing almost all of it. Second is the extensions page, which now ranks 4th",
      "for \"house extension\" plus your two main towns.",
      "",
      "## What is not",
      "",
      "**The gallery is 8.2MB and it is your slowest page by a distance.** On a phone on 4G it takes",
      "6.1 seconds to become usable. 38% of mobile visitors leave before it finishes. It is the second",
      "most visited page on the site.",
      "",
      "Fixing it is about half a day: compress the 34 images, load below-the-fold ones lazily.",
      "Estimated at 6.1s to roughly 1.4s.",
      "",
      "## Recommended next",
      "",
      "1. **Fix the gallery** — half a day, biggest single win available",
      "2. Add a bathrooms page — you rank for extensions and lofts, nothing for bathrooms",
      "3. Leave everything else alone for another month",
      "",
      "*Post-launch review included in the build. The gallery fix is not — £240 if you want it.*",
      "",
    ].join("\n"),
    "sunset-lifecycle-emails.md": [
      "# Sunset Coffee — lifecycle email sequence",
      "",
      "**Six emails, ready to load into Shopify Email** · Ridgeline Studio",
      "",
      "## The sequence",
      "",
      "| # | Trigger | Subject | Sends |",
      "| --- | --- | --- | --- |",
      "| 1 | Order placed | Your beans are being roasted on Thursday | immediately |",
      "| 2 | Shipped | On their way — and how to brew them | on dispatch |",
      "| 3 | Delivered +3d | Did we get the roast right? | day 3 |",
      "| 4 | Delivered +18d | You are probably running low | day 18 |",
      "| 5 | No order +45d | The single origins that landed since | day 45 |",
      "| 6 | No order +90d | Still here, and 15% off if you want it | day 90 |",
      "",
      "Email 4 is the one that pays for this. A 250g bag lasts a two-cup-a-day household about 18",
      "days, which is why it sends then rather than at a round number.",
      "",
      "## What we need from you",
      "",
      "1. **Roast day confirmation** — email 1 says Thursday. Is that always true?",
      "2. **The 15% in email 6** — your call. It is the only discount in the sequence.",
      "3. Product photography for the six new single origins (asked 11 April, still outstanding).",
      "",
      "*Six emails, £1,850. Second half of the lifecycle build.*",
      "",
    ].join("\n"),
  };

  const md = (title: string, file: string) =>
    MD[file] ??
    [
      `# ${title}`,
      "",
      "Prepared by Ridgeline Studio.",
      "",
      "This deliverable is part of the seeded demo tenant. Its siblings carry full worked content;",
      "this one is a placeholder and should be filled in before anybody is shown it.",
      "",
    ].join("\n");

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE FILE GOES TO THE CLIENT IT NAMES
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * This was `cases.rows[i % cases.rows.length]` — round-robin by array index, ignoring entirely
   * which client the title and filename name. So the demo tenant shipped with, live on the landing
   * page's embed:
   *
   *   "Fairmont Dental — listings audit"          → Willow & Pine
   *   "Willow & Pine — pricing page copy"       → Fairmont Dental Group
   *   "Cedar Home Care — local SEO positions"  → Fairmont Dental Group
   *   "Delgado — post-launch review"           → Ridgeline Logistics
   *   "Sunset — lifecycle email sequence"      → Willow & Pine
   *
   * Five of ten wrong. On a product whose entire pitch is that it handles client work without
   * mixing anything up, a careful reader of the demo saw it mixing up clients — and it also
   * attached each file to a stranger's engagement, so the artifact bytes landed under the wrong
   * `client_id` too.
   *
   * The filename already carries the answer. Every entry is `<client>-<what>.<ext>`, so the prefix
   * is matched against the client's display name and the case is that client's. A file whose prefix
   * matches nobody THROWS rather than falling back to round-robin: a fixture quietly attributing
   * work to whoever was next in the array is precisely the bug being fixed, and a seeder that
   * cannot place a file should say so rather than guess.
   */
  const caseForClient = new Map<string, (typeof cases.rows)[number]>();
  for (const k of cases.rows) if (!caseForClient.has(k.client_id)) caseForClient.set(k.client_id, k);

  const clientByPrefix = (name: string): { id: string; display_name: string } => {
    const prefix = name.split("-")[0]!.toLowerCase();
    const hit = clients.rows.find((c) => c.display_name.toLowerCase().replace(/[^a-z]/g, "").startsWith(prefix));
    if (!hit) throw new Error(`seed-history: "${name}" names a client this project does not have (${prefix})`);
    return hit;
  };

  let delivs = 0;
  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i]!;
    const client = clientByPrefix(f.name);
    const kase = caseForClient.get(client.id);
    if (!kase) throw new Error(`seed-history: ${client.display_name} has no engagement to hang "${f.title}" off`);
    const owner = taskIds.filter((t) => t.caseId === kase.id)[0] ?? taskIds[i % taskIds.length]!;
    const body = f.type === "text/csv" ? csv(f.title, f.name, `${PROJECT}:${i}`) : md(f.title, f.name);
    const artifactId = randomUUID();

    await db.query(
      `INSERT INTO public.artifacts (id, task_id, name, content_type, content, created_at, encoding, size_bytes, source, client_id)
       VALUES ($1,$2,$3,$4,$5,$6,'utf8',$7,'run',$8)`,
      [artifactId, owner.id, f.name, f.type, body, at(2 + i), Buffer.byteLength(body), kase.client_id],
    );
    await db.query(
      `INSERT INTO public.deliverables (id, project_id, case_id, client_id, title, kind, status, current_version, created_at, updated_at, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        `del_${createHash("sha1").update(f.name).digest("hex").slice(0, 8)}`,
        PROJECT, kase.id, kase.client_id, f.title, f.kind,
        /*
          ═══ "delivered" IS NOT A STATE THIS PRODUCT HAS ═══

          This read `i < 7 ? "accepted" : "delivered"`, and `delivered` is not in `DeliverableStatus`
          — the union is drafting | in_review | with_client | changes_requested | accepted |
          withdrawn. Three rows on the LIVE DEMO carried it, which means three rows whose state
          nothing in the product can describe: `DELIVERABLE_STATES` has no entry, so `state_note` has
          no sentence, the portal has no `client_sees` line, and every switch on status falls through.

          `with_client` is the state it was reaching for and it says the thing out loud — "sent —
          waiting on your client to accept it or ask for changes". That is the half of the loop a
          demo most needs to show.

          This is what writing seed data in raw SQL costs. The route would have refused the value;
          an INSERT takes whatever string it is handed. See `accepted_at` directly below for the
          second half of the same bill.
        */
        i < 7 ? "accepted" : "with_client",
        // Read from the same place the loop below reads it, so the row's claim and the rows that
        // back it cannot drift. They did: this said 3 and the seeder wrote none.
        seedVersions({ index: i, baseDaysAgo: 2 + i, finalSummary: "" }).length,
        at(2 + i),
        /*
          ═══ AND THE STAMP, WITHOUT WHICH "ACCEPTED" IS A WORD AND NOT A FACT ═══

          Seven rows said `accepted` and left `deliverables.accepted_at` null, because only the
          VERSION was being stamped. The parent row is what every reader actually joins on:

            · `founder-alerts.ts` skips on `!d.accepted_at`, so the demo never fired the alert that
              says a client accepted something — the single best moment this product has.
            · `hours_to_accept` is null, so the demo cannot say how fast it turns work around.
            · The per-service impact panel counts `accepted_at` and reads zero on a tenant with
              seven accepted deliverables in it.

          The route sets both together (`transitionDeliverable` stamps the row, `settleVersion`
          stamps the version). Reaching behind it means remembering both, and this forgot one.
        */
        i < 7 ? at(1 + i) : null,
      ],
    );
    /**
     * ═══ AND THE VERSION, WITHOUT WHICH THE ROW OPENS ONTO NOTHING ═══
     *
     * The deliverable was written with `current_version` set to 1, 2 or 3 and no
     * `deliverable_versions` row ever inserted. So every one of these claimed a version that did
     * not exist: the artifact was real, the deliverable was real, and the thing that JOINS them was
     * missing. On the live demo ten of fourteen deliverables opened onto an empty page — a prospect
     * clicking "Ridgeline — April AI visibility" got nothing at all.
     *
     * Where `current_version` is more than one, the earlier versions are seeded too, each with the
     * change the client asked for. That history is not decoration: accept-or-ask-for-changes is the
     * loop this product sells, and a demo where nothing was ever sent back shows the easy half.
     *
     * WHICH ONES AND WHAT THEY SAID LIVE IN `lib/revisions.ts`, not here, because the direction of
     * the demo's learning curve — the answer it gives to the only question the product is sold on —
     * used to be an emergent property of two ternaries in this loop, and it came out backwards. It is
     * a claim now, and `test/the-demo-argues-for-the-product.test.ts` checks it.
     */
    const accepted = i < 7;
    for (const ver of seedVersions({ index: i, baseDaysAgo: 2 + i, finalSummary: SUMMARY[f.name] ?? f.title })) {
      await db.query(
        `INSERT INTO public.deliverable_versions
           (id, project_id, deliverable_id, version, summary, artifact_ids, task_id, author,
            created_at, released_at, accepted_at, change_request, change_requested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          randomUUID(),
          PROJECT,
          `del_${createHash("sha1").update(f.name).digest("hex").slice(0, 8)}`,
          ver.version,
          ver.summary,
          ver.carriesFile ? [artifactId] : [],
          owner.id,
          ver.author,
          at(ver.daysAgo),
          ver.carriesFile && accepted ? at(1 + i) : null,
          ver.changeRequest,
          ver.changeRequestedDaysAgo === null ? null : at(ver.changeRequestedDaysAgo),
        ],
      );
    }
    delivs++;
  }
  console.log(`  deliverables ${delivs}, each with a version a client can open`);

  // ── 3. CAMPAIGNS, so the pipeline is a campaign and not a wall of faces ───
  const CAMPAIGNS = [
    { id: "cmp_agencies_uk", name: "UK agencies — AI visibility", inbound: false },
    { id: "cmp_agencies_us", name: "US agencies — site rebuilds", inbound: false },
    { id: "cmp_inbound_audit", name: "Inbound — free audit requests", inbound: true },
  ];
  const STEPS = [
    { from: "queued", action: "view_profile", advance_to: "warmed", wait_days: 0 },
    { from: "warmed", action: "send_invite", advance_to: "invited", wait_days: 1 },
    { from: "invited", action: "wait_accept", advance_to: "connected", wait_days: 3 },
    { from: "connected", action: "send_dm", advance_to: "dm1", wait_days: 1 },
    { from: "dm1", action: "follow_up", advance_to: "dm2", wait_days: 4 },
    { from: "dm2", action: "send_email", advance_to: "em1", wait_days: 3 },
  ];
  let camps = 0;
  for (const c of CAMPAIGNS) {
    await db.query(
      `INSERT INTO public.records (id, project_id, wedge, collection, key, data, observed_at, created_at, updated_at)
       VALUES ($1,$2,'gtm-operator','campaign',$3,$4::jsonb,'',$5,$5)
       ON CONFLICT (COALESCE(project_id,'-'), wedge, collection, key, observed_at)
         DO UPDATE SET data = public.records.data || EXCLUDED.data, updated_at = now()`,
      [
        randomUUID(), PROJECT, c.id,
        JSON.stringify({
          id: c.id, name: c.name, steps: STEPS, inbound: c.inbound,
          connection_id: "conn_linkedin_demo", approval_id: "apr_demo", task_id: taskIds[0]!.id,
          calendar_url: "https://cal.com/islam-hachimi/30min",
          created_at: at(48).toISOString(), expires_at: at(-30).toISOString(),
          source: "demo-seed",
        }),
        at(48),
      ],
    );
    camps++;
  }
  console.log(`  campaigns    ${camps}`);

  /**
   * ═══ A PROSPECT IS A CASE, NOT A RECORD, AND THAT IS WHY CAMPAIGNS LOOKED EMPTY ═══
   *
   * The people were seeded into `records` (collection `people`) and given a `campaign_id`, which is
   * what the face wall reads. But `cloud/lib/gtm-data.ts` builds the pipeline from
   * `GET /v1/cases?wedge=gtm-operator` and maps each case through `readProspect`. There were ZERO
   * gtm-operator cases, so every campaign rendered with nobody in it while the records table held
   * forty-six people — the same class of mistake as seeding GTM records into the wrong project, and
   * found the same way: by reading what the screen actually queries instead of what it displays.
   *
   * So each person gets a case as well. `data.profile_id` is the join back to the person record
   * (that is the key `readProspect` uses, and what the person page routes on), `data.campaign_id`
   * puts them in a campaign, and the case's own `stage` is what the board groups by.
   */
  const caseIds = new Map<string, string>();
  let prospected = 0;
  for (const [i, p] of PEOPLE_FOR_CASES.entries()) {
    const camp =
      /UK|IE/.test(p.location) ? CAMPAIGNS[0]!.id
      : ["replied", "booked", "won"].includes(p.stage) ? CAMPAIGNS[2]!.id
      : CAMPAIGNS[1]!.id;
    const id = randomUUID();
    const open = !["won", "lost"].includes(p.stage);
    // Touch count rises with stage: somebody at dm2 has been written to more than somebody queued.
    const touches = Math.max(0, STAGE_ORDER.indexOf(p.stage));
    await db.query(
      `INSERT INTO public.cases (id, project_id, wedge, title, stage, status, data, due_at, meeting_at, history, created_at, updated_at)
       VALUES ($1,$2,'gtm-operator',$3,$4,$5,$6::jsonb,$7,$9,'[]'::jsonb,$8,$8)`,
      [
        id, PROJECT, p.name, p.stage, open ? "open" : "closed",
        JSON.stringify({
          profile_id: p.slug,
          name: p.name,
          campaign_id: camp,
          connection_id: "conn_linkedin_demo",
          touch_count: touches,
          source: "demo-seed",
        }),
        // Only live prospects are due anything. A won or lost case with a due date reads as a bug.
        open ? at(-1 - Math.floor(rnd(`due:${p.slug}`) * 6)) : null,
        at(30 - i % 28),
        /**
         * A BOOKED CALL HAS AN HOUR ON IT.
         *
         * `contract.ts` says it plainly — *"a `booked` case with no `meeting_at` is a genuine
         * defect, and the calendar surfaces it rather than hiding it"* — and the demo was proving
         * the point on itself: two booked prospects under "No time set · Booked, with no hour on
         * it. This is the one that gets missed." That heading is correct behaviour and a terrible
         * shop window, because the only meetings in the demo were the broken kind.
         *
         * Spread across the next few working days at plausible hours, derived from the slug so a
         * re-seed puts the same call in the same slot. In production this comes from the Cal.com
         * webhook; the demo has no webhook, which is exactly why it had no times.
         */
        p.stage === "booked" ? meetingSlot(p.slug) : null,
      ],
    );
    caseIds.set(p.slug, id);
    prospected++;
  }
  console.log(`  prospects    ${prospected} gtm-operator cases across ${CAMPAIGNS.length} campaigns`);

  /**
   * ═══ THE SHOP WINDOW IS NOT ON A TRIAL IT NEVER STARTED ═══
   *
   * Home's plan card read "No plan · Nothing runs until a plan is behind it · Start the trial" —
   * on the demo. So a prospect clicking through a working business was told, in the one card about
   * money, that this business cannot run anything. It is the correct sentence for an org with no
   * subscription and the wrong thing to show somebody being sold to, because the demo is meant to
   * be what a CUSTOMER sees.
   *
   * `growth` + `active` + a billing_ref, which is what `hasPaidPlan` actually asks for — it checks
   * for a subscription rather than trusting the status column, and a demo that satisfies the status
   * and not the reference would still show the wrong card in half the places that ask.
   *
   * SAFE, because a showroom org is refused at the door anyway: `isShowroomOrg` blocks task
   * creation with its own 403 before any limit is consulted. The plan here buys a correct SCREEN,
   * not permission to spend.
   */
  const planned = await db.query(
    `UPDATE public.orgs SET plan = 'growth', plan_status = 'active',
            billing_ref = COALESCE(NULLIF(billing_ref, ''), 'cus_demo_showroom'),
            plan_renews_at = $2
     WHERE id = (SELECT org_id FROM public.projects WHERE id = $1)`,
    [PROJECT, at(-18)],
  );
  console.log(`  plan         ${planned.rowCount ? "growth, active" : "unchanged"}`);

  /**
   * ═══ THE STANDING APPROVALS THAT EXPLAIN THE FALLING LINE ═══
   *
   * The involvement chart's own caption tells a founder where the fall comes from: *"It falls when
   * you allow a kind of thing outright, in Standing approvals."* The seed now writes auto-approved
   * decisions that make the line fall, so the demo has to hold the rules that would have produced
   * them — otherwise a visitor follows the caption and finds an empty screen, which teaches them the
   * number is decoration.
   *
   * Two grants, narrow on purpose, and they are the two a real business grants first: the status
   * update nobody needs to read, and the reminder for a document already asked for. Neither moves
   * money and neither is a first contact — `matchStanding` would refuse a `high` verdict anyway.
   *
   * Written as `records` rows because that is where `grantStanding` puts them; the route cannot be
   * used here, and correctly so — it refuses a product key, because "an API key could write a
   * permission and sign a human's name to it".
   */
  const GRANTS = [
    { action: "email:send_status_update", per_day: 5 },
    { action: "email:send_document_reminder", per_day: 3 },
  ];
  let granted = 0;
  for (const g of GRANTS) {
    const id = randomUUID();
    await db.query(
      /*
        `observed_at` is '' — the point-in-time form. A grant is a CURRENT fact about what this
        business allows, not a sample in a series, and the unique index includes the column, so a
        timestamp here would let a re-seed stack duplicate permissions.
      */
      `INSERT INTO public.records (id, project_id, wedge, collection, key, data, observed_at)
       VALUES ($1,$2,'standing','standing_grant',$3,$4::jsonb,'')
       ON CONFLICT (COALESCE(project_id,'-'), wedge, collection, key, observed_at) DO NOTHING`,
      [
        randomUUID(),
        PROJECT,
        id,
        JSON.stringify({
          v: 1,
          id,
          action: g.action,
          max_per_day: g.per_day,
          /*
            `at()` takes DAYS AGO, so a negative argument is the future. Granted 56 days ago and live
            for another 30 — a demo whose permissions all lapsed last month shows the gate closed,
            which is the opposite of the thing being demonstrated.

            86 days apart, and that is deliberate: `MAX_GRANT_DAYS` is 90, so this is a grant the
            product could actually have minted. A seeded 116-day grant would read as live to
            `isLive` and be a thing no route in the kernel can produce.
          */
          expires_at: at(-30).toISOString(),
          granted_at: at(56).toISOString(),
          granted_by: "demo-founder",
        }),
      ],
    );
    granted++;
  }
  console.log(`  standing     ${granted} grants, which is what makes the involvement line fall`);

  // Give every seeded person a campaign, so the board groups instead of sprawling.
  const spread = await db.query(
    `UPDATE public.records SET data = data || jsonb_build_object('campaign_id',
        CASE WHEN (data->>'location') ILIKE '%UK%' OR (data->>'location') ILIKE '%IE%' THEN $2
             WHEN (data->>'stage') IN ('replied','booked','won') THEN $4
             ELSE $3 END)
     WHERE project_id = $1 AND collection = 'people' AND data->>'source' = 'demo-seed'`,
    [PROJECT, CAMPAIGNS[0]!.id, CAMPAIGNS[1]!.id, CAMPAIGNS[2]!.id],
  );
  console.log(`  people tied to a campaign: ${spread.rowCount}`);

  await db.end();
  console.log(`\ndone.\n`);
}

main().catch((e) => {
  console.error(`\nseed-history: ${(e as Error).message}\n`);
  exit(1);
});
