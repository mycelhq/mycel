/**
 * A believable small business, built out of nothing but the public API.
 *
 * WHY THIS EXISTS. There was no seed. Every demo of this product — to a prospect, to a designer, to
 * whoever is recording the landing page — started from an empty console, which shows the one thing
 * the product is not for: nothing to do. And the empty console is not just unpersuasive, it is
 * actively misleading about what the software IS. `GET /v1/moves` is a ranked list DERIVED from
 * invoices, cases, client requests and waits; with none of those seeded it returns `[]`, and a
 * viewer reasonably concludes the ranking is vapour. The only way to show that the ranking is real
 * is to put real facts underneath it and let the kernel rank them.
 *
 * HOW IT WORKS, AND WHY IT IS HTTP AND NOT FUNCTION CALLS.
 *
 * The obvious implementation is to import `getDomainStore()` and `getBillingStore()` and write rows
 * directly, the way the test suite does. That is wrong here for a reason that is easy to miss: with
 * no `MYCEL_DATABASE_URL` every store is an in-process `Map`, so a seed script that imports them
 * seeds ITS OWN process and exits, and the kernel the browser is talking to on :4000 never sees a
 * byte of it. The test suite gets away with it because it holds the server in the same process.
 *
 * So this file is an HTTP client and nothing else. That has two further benefits worth stating:
 * every row it writes went through the same validation, tenancy check and normalisation a real
 * founder's row does — a seed that reaches behind the routes can construct state the routes would
 * have refused, and then the demo is showing a screen that cannot occur — and the script keeps
 * working unchanged the day the store is Postgres.
 *
 * WHAT IT DELIBERATELY DOES NOT CREATE: RUNS.
 *
 * There is no task in here, and that omission is the honest half of this file. Running one requires
 * an agent; without a provider key the kernel falls back to `MYCEL_RUNTIME=mock`, and
 * `runtime.mock.ts` writes the literal string `[mock]` into every text field it produces — its own
 * comment calls that "load-bearing", the signal that tells a product "the kernel answered" apart
 * from "the kernel answered with something worth showing a human". A seeded run would therefore put
 * a fabricated agent answer on a screen whose entire claim is that the answer is grounded. Seeding
 * the FACTS and letting the kernel derive from them is real; seeding the agent's output is not. If
 * you demo with a real provider key, start the runs yourself and they will be real.
 *
 * GUARDS — `assertLoopback` and `assertMemoryStore`. Two of them, both structural, neither
 * overridable, and deliberately independent: the first refuses any host that is not loopback, the
 * second refuses any kernel whose data outlives the process. Between them there is no argument you
 * can pass that points this script at a real business.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";

// ── Guards, transport, dates ─────────────────────────────────────────────────────────────────────
//
// All four of these now live in ./lib/kernel.ts, because simulate.ts needs every one of them and a
// second hand-copied `assertLoopback` is one edit away from being a weaker one. The guards are
// unchanged and still have NO override: loopback-only host, in-memory store only. Read the comments
// there for why.

import { Session, assertLoopback, assertMemoryStore, baseUrl, clockFrom, die, usd } from "./lib/kernel";

const BASE = baseUrl();
const OWNER_EMAIL = env.MYCEL_OWNER_EMAIL ?? "founder@mycel.local";
const OWNER_PASSWORD = env.MYCEL_OWNER_PASSWORD ?? "";

/** The one credential this script has. `simulate.ts` holds several; a seed only ever needs this. */
const s = new Session(BASE, "founder");

/**
 * The fatal forms, so the body of the seed never has to spell out `as T` or check for undefined.
 * Every call is fatal on a non-2xx: a seed that shrugs off a 400 leaves a half-built business whose
 * missing half is discovered on camera. The one caller that legitimately tolerates a refusal uses
 * `s.tryPost`.
 */
const get = <T,>(path: string) => s.get<T>(path);
const post = <T,>(path: string, body: unknown) => s.post<T>(path, body);
const patch = <T,>(path: string, body: unknown) => s.patch<T>(path, body);
const put = <T,>(path: string, body: unknown) => s.put<T>(path, body);

const { iso, day, hour } = clockFrom();

// ── The business ─────────────────────────────────────────────────────────────────────────────────
//
// Ridgeline Books is invented, and every customer under it is invented. The domains are all
// `.example`, which RFC 2606 reserves precisely so that nobody's real mailbox is ever named in a
// fixture — a demo that ships a real-looking address is one copy-paste away from a stranger being
// chased for $1,450 they do not owe. The numbers are a plausible small bookkeeping practice: a few
// hundred to a couple of thousand dollars a month, not a fantasy MRR.

/** The label the console prints in its business switcher, verbatim. */
const BUSINESS_NAME = "Ridgeline Books";

// Money is integer minor units everywhere in this kernel. Nothing here divides. `usd` is imported
// from ./lib/kernel — see contract.ts, and see that file for why `Math.round` and not a cast.

interface SeedClient {
  key: string;
  display_name: string;
  handles: string[];
  note: string;
}

const CLIENTS: SeedClient[] = [
  { key: "harbourline", display_name: "Harborline Ceramics", handles: ["accounts@harborline.example"], note: "Shopify + Etsy. Payouts land net of fees." },
  { key: "foldgrain", display_name: "Fold & Grain Bakery", handles: ["hello@foldandgrain.example"], note: "Two locations, one card reader each. Cash-heavy Saturdays." },
  { key: "meridian", display_name: "Meridian Cycle Works", handles: ["ap@meridiancycle.example"], note: "Sales tax registered in three states. Files quarterly." },
  { key: "quillstone", display_name: "Quill & Stone Bookshop", handles: ["admin@quillandstone.example"], note: "Pays on the day, every time." },
  { key: "saltmarsh", display_name: "Saltmarsh Surf Co", handles: ["finance@saltmarsh.example"], note: "Seasonal. Winter months are nearly dormant." },
];

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────
//
// The prospect roster lives in `demo-gtm.json` beside this file rather than inline, for one reason:
// `cloud/scripts/demo-faces.mjs` writes a portrait per row and has to agree with this script
// about every single slug. A slug in one and not the other is a broken image in a recording, so
// there is exactly one copy of the roster and both programs read it.
//
// WHAT IS HONEST TO SEED HERE, AND WHAT IS NOT. A stage, a due time, a name and an employer are
// facts about a pipeline, and stating them is the same thing this file already does for invoices and
// cases. What is NOT written is `provenance` — the per-field record of which resolver found what and
// what it charged. That is the enrichment waterfall's own testimony; inventing it would put fake
// dollar figures on the one screen whose entire claim is that the figures are real, and `readPerson`
// would happily render them. So people here carry a name, a headline, a company and a face, and the
// `/gtm` home's "Enrichment" stat correctly reads $0.00, because nothing was spent.
//
// The `paused_reason` strings in the roster are copied VERBATIM out of gtm/sequence.ts and pacing.ts
// — the sentences the sequencer actually writes when it refuses to act. The stage board prints them
// unparaphrased on purpose (see its header), so a paraphrase here would be a fabricated quote.

interface RosterCompany {
  domain: string;
  name: string;
  industry: string;
  headcount: number;
}

interface RosterPerson {
  slug: string;
  name: string;
  title: string;
  company: string;
  location: string;
  stage: string;
  dueInHours: number;
  pausedReason: string | null;
}

interface Roster {
  campaign: { name: string; account: string };
  companies: RosterCompany[];
  people: RosterPerson[];
}

const ROSTER: Roster = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "demo-gtm.json"), "utf8"),
) as Roster;

/**
 * Where the avatars are served from.
 *
 * Faces are static JPEGs under `cloud/public/demo/faces/`, company marks under `demo/marks/`, so the
 * URL the kernel stores is a URL into the CONSOLE, not into the kernel. `Face` renders `photo_url`
 * in a plain `<img>` from the browser on the console's origin — same-origin, no CORS. Overridable
 * because the console does not always sit on :3000.
 */
const APP_URL = (env.MYCEL_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/**
 * The one message a human wrote.
 *
 * The composer labels this field "First message, for everyone" and it is a HUMAN-authored field by
 * design — the founder types it, the agent never drafts it, and `sequence.ts` parks rather than
 * improvising when it is missing. So writing plain copy here is not fabricating agent output; it is
 * the seed playing the founder, which is the same thing it does when it writes an invoice line.
 *
 * Short and unsalesy on purpose. It is also the thing a viewer of the recording will read most
 * closely, and a demo whose first DM is growth-hack boilerplate argues against the product.
 */
const FIRST_MESSAGE =
  "Hi — I do the books for a handful of owner-run shops around here, mostly the month-end close and " +
  "sales tax. No pitch: if you ever want a second pair of eyes on a messy month, I'm happy to look.";

async function main(): Promise<void> {
  assertLoopback(BASE);

  // ── Sign in ────────────────────────────────────────────────────────────────────────────────────
  if (!OWNER_PASSWORD) {
    die(
      `MYCEL_OWNER_PASSWORD is not set.\n` +
        `  Boot the kernel with a stable owner login and pass the same values here:\n` +
        `    MYCEL_RUNTIME=mock MYCEL_API_KEY=mycel_demo_key \\\n` +
        `    MYCEL_OWNER_EMAIL=${OWNER_EMAIL} MYCEL_OWNER_PASSWORD=<pick one> npm run dev`,
    );
  }
  const login = await post<{ token: string; projects: { id: string; name: string }[] }>("auth/login", {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  });
  s.token = login.token;
  s.project = login.projects[0]?.id ?? die("the owner has no project — the kernel did not bootstrap correctly");
  await assertMemoryStore(s);

  /**
   * A business with a name, because the sidebar prints `project.name` verbatim.
   *
   * The kernel bootstraps every new org with a project literally called `default`, and there is no
   * rename route — `PUT /v1/projects/:id/branding` sets a brand kit for rendered documents, not the
   * console label. So the demo gets its own project rather than borrowing the bootstrap one, and
   * "default" stops being the first word a prospect reads about their own company.
   *
   * Falls back rather than failing: project count is plan-limited (`limitsFor().projects`), and a
   * seed that dies on a 402 having already been asked for is worse than a seed that runs in
   * `default` and says so.
   */
  const named = login.projects.find((p) => p.name === BUSINESS_NAME);
  if (named) {
    s.project = named.id;
  } else {
    const created = await s.tryPost<{ project?: { id: string } }>("projects", { name: BUSINESS_NAME, wedges: [] });
    if (created.body?.project) s.project = created.body.project.id;
    else console.warn(`  ! could not create a project named "${BUSINESS_NAME}" — seeding into "${login.projects[0]?.name}"`);
  }

  /**
   * Additive, and therefore refused twice.
   *
   * Nothing in here reads before it writes, so a second run produces ten customers with five names.
   * The in-memory store has no delete-everything, and adding one to the public API so a seed script
   * could use it would be a genuinely dangerous route to own. Restarting the kernel is the reset,
   * it takes two seconds, and it is the truthful mental model of an in-memory store anyway.
   */
  const existing = await get<{ id: string }[]>("clients");
  if (existing.length && !argv.includes("--append")) {
    die(
      `this project already has ${existing.length} client(s) — seeding again would duplicate them.\n` +
        `  Restart the kernel (the store is in memory, so that IS the reset) and run this again.\n` +
        `  Pass --append if you genuinely want a second set.`,
    );
  }

  /**
   * The console redirects every route to `/onboarding` until this pref is true — see the guard in
   * `cloud/app/(app)/layout.tsx`. A seed that populates a business you then cannot navigate to is
   * not a seed, so the flag is part of the artifact rather than a step in a README nobody reads.
   */
  await patch("me/prefs", { onboarded: true });

  const ids: Record<string, string> = {};
  for (const c of CLIENTS) {
    const row = await post<{ id: string }>("clients", {
      display_name: c.display_name,
      handles: c.handles,
      metadata: { note: c.note },
    });
    ids[c.key] = row.id;
  }

  // ── Money ──────────────────────────────────────────────────────────────────────────────────────
  //
  // Five invoices spanning the whole of `effectiveStatus`: badly overdue, mildly overdue, due soon,
  // settled, and not yet issued. That spread is the point — it is what makes the ranked move list
  // have something to rank, and it is what makes the `/invoices` stat strip show real arithmetic
  // rather than one row repeated. `POST /v1/invoices` always creates a draft (deliberately: an
  // invoice that arrives already `sent` has no issue date, so nobody can say when the clock
  // started), so every one of these is issued by a second call.

  const invoice = async (args: {
    client: string;
    description: string;
    dollars: number;
    dueInDays: number;
    issue?: boolean;
    payDollars?: number;
  }) => {
    const inv = await post<{ id: string }>("invoices", {
      client_id: ids[args.client],
      currency: "USD",
      due_date: day(args.dueInDays),
      lines: [{ description: args.description, kind: "fixed", quantity_milli: 1000, unit_amount: usd(args.dollars) }],
    });
    if (args.issue !== false) await post(`invoices/${inv.id}/status`, { to: "sent" });
    if (args.payDollars !== undefined) await post(`invoices/${inv.id}/payments`, { amount_minor: usd(args.payDollars) });
    return inv.id;
  };

  const overdueInvoice = await invoice({ client: "harbourline", description: "Bookkeeping — September", dollars: 1_450, dueInDays: -34 });
  await invoice({ client: "meridian", description: "Bookkeeping + sales tax return — Q3", dollars: 2_200, dueInDays: -12 });
  await invoice({ client: "foldgrain", description: "Bookkeeping — October", dollars: 680, dueInDays: 5 });
  await invoice({ client: "quillstone", description: "Bookkeeping — October", dollars: 950, dueInDays: -3, payDollars: 950 });
  // Not issued. A draft is work the founder has done and not yet sent, which is its own kind of
  // money left on the table and its own row in the ledger's stat strip.
  await invoice({ client: "saltmarsh", description: "Bookkeeping — October", dollars: 1_120, dueInDays: 21, issue: false });

  // ── The work ───────────────────────────────────────────────────────────────────────────────────
  //
  // One case per client at a different stage of the wedge's own ladder
  // (open → collecting → reconciling → review → filed), so the board reads as a month in motion
  // rather than five copies of "open".

  const kase = async (args: { client: string; title: string; stage: string; dueInDays?: number }) =>
    (
      await post<{ id: string }>("cases", {
        wedge: "books-keeper",
        title: args.title,
        client_id: ids[args.client],
        stage: args.stage,
        ...(args.dueInDays === undefined ? {} : { due_at: iso(args.dueInDays) }),
      })
    ).id;

  const harbourCase = await kase({ client: "harbourline", title: "Harborline Ceramics — October close", stage: "collecting", dueInDays: 3 });
  await kase({ client: "foldgrain", title: "Fold & Grain Bakery — October close", stage: "reconciling", dueInDays: 6 });
  await kase({ client: "meridian", title: "Meridian Cycle Works — sales tax quarter to 31 Oct", stage: "review", dueInDays: 2 });
  await kase({ client: "quillstone", title: "Quill & Stone Bookshop — October close", stage: "filed" });
  await kase({ client: "saltmarsh", title: "Saltmarsh Surf Co — October close", stage: "open", dueInDays: 11 });

  // ── On the clock ───────────────────────────────────────────────────────────────────────────────
  //
  // BEFORE the wait below, and that ordering is load-bearing rather than tidy. Arming a wait makes
  // the kernel `ensureWaitSchedule` a housekeeping tick under the internal `waits` wedge, and
  // `/brain` picks the wedge it asks about off the FIRST schedule it finds. Seeded the other way
  // round, every question a viewer types is scoped to `waits` — a wedge with no invoices, no cases
  // and no rules under it — and the answer to "Harborline" is "0 of 0 matches. Nothing matched."
  // A grounded-answer demo whose grounding is empty is the worst possible screen to record.

  await post("schedules", {
    name: "Daily bank feed sync",
    wedge: "books-keeper",
    task_type: "daily_sync",
    cadence: { kind: "daily", hour: 7, minute: 30 },
    input: {},
  });
  await post("schedules", {
    name: "Monthly close",
    wedge: "books-keeper",
    task_type: "monthly_close",
    cadence: { kind: "monthly", day: 1, hour: 9, minute: 0 },
    input: {},
  });

  // ── What the business is blocked on ────────────────────────────────────────────────────────────
  //
  // Two outstanding asks and one live wait. This is the half of the model most demos skip and it is
  // the half a service-business owner recognises instantly: the month is not late because the work
  // is hard, it is late because a customer has not sent a bank statement.

  const statementRequest = await post<{ id: string }>("requests", {
    client_id: ids.harbourline,
    case_id: harbourCase,
    kind: "document",
    ask: "October bank statement (business checking account, 01–31 Oct) — PDF or CSV both fine.",
  });
  await post("requests", {
    client_id: ids.foldgrain,
    kind: "answer",
    ask: "The $412.00 Faire payment on 14 Oct — is that stock, or a refund to a wholesale customer?",
  });

  /**
   * The stalled wait: the close cannot resume until that statement arrives.
   *
   * `request_resolved` and not a date, because the thing being waited on is a fact about the world
   * rather than the passage of time — the whole reason waits exist as a first-class object. It
   * carries an expiry so it cannot hang for ever, which is also what puts it in front of the
   * founder as something to decide about.
   */
  await post(`cases/${harbourCase}/wait`, {
    reason: "the October close is blocked on the bank statement only Harborline can send",
    condition: { kind: "request_resolved", request_id: statementRequest.id, label: "Harborline's October bank statement" },
    resume: { task_type: "monthly_close", input: { period: "2026-10" } },
    nudge_at: iso(2),
    max_nudges: 2,
    expires_at: iso(14),
  });

  // ── What it has been taught ────────────────────────────────────────────────────────────────────
  //
  // PROVENANCE IS THE WHOLE POINT OF THIS BLOCK, so read the flag before you copy it.
  //
  // `during_onboarding: true` labels every rule below as STATED — the founder typed it into a setup
  // screen — as opposed to OBSERVED, which is what the system calls a rule distilled from a real
  // correction on a real job. knowledge.ts is explicit that the second is worth far more and that
  // "an unmarked onboarding answer becomes indistinguishable from one earned on a real job".
  //
  // Every rule a seed can honestly create is of the first kind. Producing an observed rule means
  // an agent drafted something, a human edited it, and the delta was distilled — none of which can
  // be faked here without the fake being the most valuable-looking thing on the screen. So the seed
  // creates the weaker kind and labels it weaker, and a demo that wants the stronger kind has to go
  // and earn one.

  const taught: { id: string; answer: string }[] = [
    {
      id: "engagement-scope",
      answer:
        "Bank and card feeds reconciled, receipts chased, and P&L plus balance sheet issued by the 7th business day. Sales tax is prepared quarterly for the client's approval — they file it, never us.",
    },
    {
      id: "pricing",
      answer:
        "$450/month up to 300 transactions, then $0.40 each above that. Entity formation, payroll and R&D credits are quoted separately and never bundled into the monthly fee.",
    },
    {
      id: "chase-tone",
      answer:
        "Hi Sam — closing October and I'm short receipts for 4 card payments ($212.40 total). Could you forward them when you get a minute? Happy to close without them and treat as non-deductible if that's easier.",
    },
    {
      id: "escalate",
      answer:
        "Anything that goes to a tax authority. Any transaction over $2,000 it cannot match. Any client asking whether something is tax deductible. Anything that looks like an owner draw.",
    },
    {
      id: "quirks",
      answer:
        "Harborline's Shopify payouts land net of fees, so gross always has to be rebuilt. Fold & Grain deposit their Saturday cash on the following Tuesday. Quill & Stone sell only in one state — never apply out-of-state tax to them.",
    },
  ];
  for (const t of taught) {
    await post(`wedges/books-keeper/intake/${t.id}`, { answer: t.answer, during_onboarding: true });
  }

  // ── Go-to-market ───────────────────────────────────────────────────────────────────────────────
  //
  // Four writes, in an order that is enforced by the kernel rather than chosen for tidiness:
  //
  //   1. the LinkedIn seat, because a campaign names a connection and refuses an unknown one;
  //   2. the people and companies, because the board reads names, headlines and faces out of the
  //      `records` graph and not off the cases;
  //   3. propose — which creates the campaign, the artifact, ONE approval, and one case per prospect
  //      at stage `queued`;
  //   4. approve, and only THEN move the cases.
  //
  // Step 4 is the ordering that bites. `enrolProspects` refuses to add anybody to a campaign whose
  // approval has already been decided ("the approved list cannot grow afterwards"), so enrolment has
  // to happen inside the propose call, before the approval — which is exactly what proposing with a
  // full prospect list does. Approving after that is safe; approving BEFORE would leave a campaign
  // with nobody in it and no way to add them.

  /**
   * The founder's own LinkedIn account, as a connection with no credential.
   *
   * There is no session material here and there must not be — this is a demo kernel and nothing in
   * it will ever talk to LinkedIn. What the `config` carries is the pacing state, which is the sole
   * input to `readPacing` in cloud/lib/linkedin.ts and therefore the only reason the pacing HUD on
   * the campaign page shows real arithmetic instead of an empty box.
   *
   * `tier: "free"`, deliberately. It is tempting to write `sales_navigator` because the numbers are
   * bigger, and it would be a lie about a bookkeeper: the whole premise is a one-person practice that
   * has not bought anything. Free tier, an old personal account (past the eight-week ramp, so
   * `ageRamp` is 1), and an engagement record that earns its multiplier honestly — 21 of 64
   * invitations accepted is a 33% acceptance rate, which is good and not fantastical, and zero flags.
   * Every number the HUD prints is derived from these five by the same arithmetic the kernel uses.
   */
  const seat = await post<{ id: string }>("connections", {
    kind: "linkedin",
    name: ROSTER.campaign.account,
    config: {
      tier: "free",
      account_age_days: 1_240,
      // Pacific, matching the roster's cities. Decides whether the HUD says the account is inside
      // its own sending window right now — a real answer that changes through the day, not a badge.
      utc_offset: -8,
      pacing: {
        used: { invite: 26, message: 14 },
        engagement: { sent: 64, accepted: 21, replied: 9, flagged: 0 },
      },
    },
  });

  // The graph. Companies first so a person's `company_key` always resolves — `companyOf` is a plain
  // map lookup and a person written ahead of their employer renders with a blank company block.
  for (const co of ROSTER.companies) {
    await post("records", {
      wedge: "gtm-operator",
      collection: "companies",
      key: co.domain,
      data: {
        name: co.name,
        domain: co.domain,
        industry: co.industry,
        headcount: co.headcount,
        logo_url: `${APP_URL}/demo/marks/${co.domain}.svg`,
        source: "demo-seed",
      },
    });
  }

  for (const p of ROSTER.people) {
    const co = ROSTER.companies.find((c) => c.domain === p.company);
    await post("records", {
      wedge: "gtm-operator",
      collection: "people",
      // Keyed on the slug, which is also the case's `profile_id` and the `/gtm/<campaign>/<who>`
      // URL segment. One identifier, three places, so a mismatch is impossible rather than unlikely.
      key: p.slug,
      data: {
        profile_id: p.slug,
        name: p.name,
        title: p.title,
        // Composed rather than stored twice: the headline a card shows is the title against the
        // employer, and duplicating it in the roster is one more thing to keep in step.
        headline: `${p.title} · ${co?.name ?? p.company}`,
        company: co?.name,
        company_key: p.company,
        company_domain: p.company,
        location: p.location,
        photo_url: `${APP_URL}/demo/faces/${p.slug}.jpg`,
        // Named so nobody reading a row later mistakes it for something LinkedIn said. And NO
        // `provenance` — see the note above the roster types.
        source: "demo-seed",
      },
    });
  }

  const proposed = await post<{ campaign_id: string; cases: number }>("gtm/campaigns", {
    connection_id: seat.id,
    name: ROSTER.campaign.name,
    // The default sequence (view → invite → message → follow-up) is what `proposeCampaign` uses when
    // `steps` is omitted, and it is the one the product argues for. Omitting it here means the demo
    // shows the real default rather than a bespoke sequence invented for a screenshot.
    prospects: ROSTER.people.map((p) => ({
      profile_id: p.slug,
      name: p.name,
      copy: { send_message: FIRST_MESSAGE },
    })),
  });
  await post(`gtm/campaigns/${proposed.campaign_id}/approve`, {});

  /**
   * Move everybody to where the roster says they are.
   *
   * Through `PUT /v1/cases/:id` rather than by writing the store, so every stage name is validated
   * against the wedge manifest's declared stages and `data` MERGES rather than replaces — which is
   * what keeps `campaign_id`, `connection_id` and the approved copy on the case while a
   * `paused_reason` is added beside them.
   *
   * `lost` is also closed, because that is what the sequencer does: `closeCase` sets the stage AND
   * the status together, and a `lost` case left open would be a row the board draws as still running.
   * `replied` and `booked` stay open on purpose — they are terminal for the SEQUENCER and live for
   * the founder, which is the distinction stages.ts spends a paragraph on.
   */
  const enrolled = await get<{ cases: { case_id: string; profile_id: string }[] }>(
    `gtm/campaigns/${proposed.campaign_id}/cases`,
  );
  const caseOf = new Map(enrolled.cases.map((k) => [k.profile_id, k.case_id]));
  for (const p of ROSTER.people) {
    const caseId = caseOf.get(p.slug);
    if (!caseId) continue;
    await put(`cases/${caseId}`, {
      stage: p.stage,
      due_at: hour(p.dueInHours),
      ...(p.stage === "lost" ? { status: "closed" } : {}),
      ...(p.pausedReason ? { data: { paused_reason: p.pausedReason, paused_at: iso(0) } } : {}),
    });
  }

  // ── Report ─────────────────────────────────────────────────────────────────────────────────────

  const moves = await get<{ moves: { kind: string }[] }>("moves");
  console.log(
    `\n  ✓ Seeded ${BUSINESS_NAME} into ${BASE} (project ${s.project})\n` +
      `    ${CLIENTS.length} clients · 5 invoices (1 overdue ${34}d, 1 overdue 12d, 1 due soon, 1 paid, 1 draft)\n` +
      `    5 cases across every stage · 2 open client requests · 1 wait blocked on a bank statement\n` +
      `    2 schedules · ${taught.length} taught rules (all labelled 'stated', not 'observed')\n` +
      `    → GET /v1/moves ranks ${moves.moves?.length ?? 0} moves off that\n` +
      `\n    GTM: ${ROSTER.companies.length} companies · ${ROSTER.people.length} prospects across the stage board\n` +
      `    campaign "${ROSTER.campaign.name}" — approved, faces from ${APP_URL}/demo/\n` +
      `    → ${APP_URL}/gtm/${proposed.campaign_id}   (id is a fresh uuid on every seed)\n` +
      `\n    Sign in at http://localhost:3000 as ${OWNER_EMAIL}\n` +
      `    Reset: restart the kernel. The store is in memory. Overdue invoice id: ${overdueInvoice}\n` +
      // READ IT OVER THE API, WITH THE CREDENTIAL THAT ACTUALLY WORKS.
      //
      // FOUND IN A STRANGER-INSTALL WALKTHROUGH: the README told people to curl /v1/moves with the
      // demo API key, which resolves to its own key-derived project — a different tenant from the
      // one this seed just wrote into. It correctly returned {"moves":[]}, and since the README
      // elsewhere pre-frames [] as "what an unseeded kernel returns", the only available conclusion
      // was that the seed had failed. It had not. Project scope is required and never defaulted, so
      // the fix is to hand over the working call rather than to loosen the scoping: this block
      // prints the project id and a command that can be pasted as-is.
      `\n    Read it over the API (project scope is required, so both headers matter):\n` +
      `      TOKEN=$(curl -s ${BASE}/v1/auth/login -H 'content-type: application/json' \\\n` +
      `        -d '{"email":"${OWNER_EMAIL}","password":"<the MYCEL_OWNER_PASSWORD you booted with>"}' | jq -r .token)\n` +
      `      curl -s ${BASE}/v1/moves -H "authorization: Bearer $TOKEN" -H 'x-mycel-project: ${s.project}' | jq\n` +
      `    The kernel's MYCEL_API_KEY is a DIFFERENT tenant and will correctly return {"moves":[]} here.\n`,
  );
}

await main();
