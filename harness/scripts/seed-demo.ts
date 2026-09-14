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
/**
 * ═══ THE DEMO DELIVERABLE IS RENDERED BY THE PRODUCT, NOT WRITTEN BY THIS SCRIPT ═══
 *
 * The close pack was hand-built HTML plus a CSV. Both are real files and both are honest, and
 * neither shows what this software actually makes: `render/report.ts` lays out a branded,
 * paginated document with a chart on page one, and every rendered document is linted for taste on
 * the way out. The two screens this product is sold on — the deliverable inspector and the client
 * portal — were demonstrating a spreadsheet.
 *
 * This is the SAME `render()` the server calls for invoices and receipts, so the seed is not
 * inventing a state the product cannot reach. It relaxes "public API and nothing else" for exactly
 * one call, and the thing it reaches for is the product's own output path.
 */
import { render } from "../src/render";
import { resolveBrandKit } from "../src/brandkit";

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
// ═══ THIS WAS A BRITISH BOOKKEEPER AND IT SOLD THE PRODUCT SHORT ═══
//
// The demo was "Ridgeline Books" closing October for Quill & Stone Bookshop and Meridian Cycle
// Works: a bookkeeping practice billing $450 a month, with a deliverable whose headline figures
// were cost of goods, wages and rent. Two things wrong with it, and the second is the expensive one.
//
// It read as British — Harborline, Meridian Cycle Works, Quill & Stone — to an audience that is
// American. And bookkeeping is the cheapest, most commoditised knowledge work there is: a demo
// whose flagship artifact is a P&L invites the buyer to price the whole product against a $200
// bookkeeping app, when what it does is produce work a client pays four figures a month for.
//
// So the demo is now an agency selling AI-visibility monitoring — `geo-monitor`, which is a wedge
// that already ships, is already priced in USD ($750 setup, $990/month in its own manifest), and
// whose `weekly_report` needs nothing but a client to run. It is also the measurement work this
// business actually sells, so the demo and the company finally describe the same thing.
//
// Every customer is invented and the domains are all `.example`, which RFC 2606 reserves precisely
// so nobody's real mailbox is ever named in a fixture — a demo that ships a real-looking address is
// one copy-paste away from a stranger being chased for money they do not owe.

/** The label the console prints in its business switcher, verbatim. */
const BUSINESS_NAME = "Sightline Research";

// Money is integer minor units everywhere in this kernel. Nothing here divides. `usd` is imported
// from ./lib/kernel — see contract.ts, and see that file for why `Math.round` and not a cast.

interface SeedClient {
  key: string;
  display_name: string;
  handles: string[];
  note: string;
}

// The keys are unchanged on purpose. `demo-gtm.json` and `cloud/scripts/demo-faces.mjs` agree with
// this file slug-for-slug, and a renamed key is a broken portrait in a recording — the exact
// coupling the note under the pipeline block warns about. Only what a human reads has changed.
const CLIENTS: SeedClient[] = [
  { key: "willowline", display_name: "Halstead Robotics", handles: ["marketing@halsteadrobotics.example"], note: "Warehouse automation, Ohio. Long sales cycle, six-figure deals." },
  { key: "foldgrain", display_name: "Fernwood Health", handles: ["growth@fernwoodhealth.example"], note: "Care-coordination SaaS. Buyers ask AI before they ask a rep." },
  { key: "meridian", display_name: "Parcelwise", handles: ["demand@parcelwise.example"], note: "Freight software. Three competitors outrank them in every model." },
  { key: "quillstone", display_name: "Brightline Legal", handles: ["ops@brightlinelegal.example"], note: "Employment law, mid-market. Pays on the day, every time." },
  { key: "saltmarsh", display_name: "Kestrel Analytics", handles: ["hello@kestrelanalytics.example"], note: "Seed-stage. Watching every dollar until the next round." },
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
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * IS ANYTHING ACTUALLY LISTENING THERE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THERE IS NO UI IN THIS REPOSITORY. The console is a separate consumer of `/v1`, in its own repo,
 * which the README states plainly — and this script did not. It closed by printing seven links into
 * `APP_URL` and the line "Sign in at http://localhost:3000", so a stranger's first run ended in a
 * list of addresses that answer nothing, and the available conclusion is that the seed failed.
 *
 * That is exactly the failure the comment at the bottom of this file was written about, in a new
 * place: the seed worked, and its own closing report was the thing saying otherwise.
 *
 * So ask. A link is printed when something answers and replaced with the truth when nothing does.
 * One request, short deadline, never throws — a diagnostic must not be able to take down the thing
 * it diagnoses, least of all after the work is already committed.
 */
async function consoleIsUp(): Promise<boolean> {
  try {
    return (await fetch(APP_URL, { signal: AbortSignal.timeout(1500) })).status > 0;
  } catch {
    return false;
  }
}

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

  /**
   * ═══ THE DEMO'S OWNER HAS CONFIRMED THEIR ADDRESS ═══
   *
   * Without this, every screen in the demo opens under an amber banner: *"Confirm
   * founder@sightlineresearch.example — delivery and outbound stay off until this address is
   * confirmed."* Correct behaviour, and the first frame of every recorded clip that starts on Home,
   * the first thing in every screenshot, and the first thing a visitor to the live demo reads.
   *
   * A demo business is a business that finished setting up. `verify/request` hands the token back to
   * the caller — the product is what delivers it (`cloud/lib/mail.ts`), and here there is no inbox —
   * so the seed does both halves the way a founder clicking the link in their email would.
   */
  const verify = await post<{ status: string; token?: string }>("auth/verify/request", {}).catch(() => undefined);
  if (verify?.token) await post("auth/verify/confirm", { token: verify.token }).catch(() => undefined);

  /**
   * ═══ HOW THIS BUSINESS GETS PAID, BEFORE ANY INVOICE EXISTS ═══
   *
   * Without it every seeded invoice renders a red block: *"This invoice is missing the registered
   * address and company number an accounts department needs"*, and under How to pay, *"This business
   * has not said how it takes payment, so this invoice cannot tell the client where to send the
   * money."* Both sentences are correct — `payments.rails.ts` refuses to invent a sort code, and the
   * document says so rather than looking complete — and both are the first thing anybody sees on the
   * demo's invoice screen, in the clips on the landing page, and in every screenshot anybody takes.
   *
   * A demo that opens on an error the product is right to show is still a demo that opens on an
   * error. Seeding the rails is the honest fix: it is a thing every real business does once, in
   * Settings, before it bills anybody.
   *
   * Bank transfer and card, because those are the two a client actually uses, and a seller identity
   * complete enough that the document has nothing to complain about.
   */
  await put("payments/rails", {
    currency: "USD",
    seller: {
      address: ["Sightline Research LLC", "1100 Congress Ave, Suite 400", "Austin, TX 78701"],
      company_number: "EIN 88-4102993",
    },
    rails: [
      {
        kind: "bank_transfer",
        enabled: true,
        lines: ["Sightline Research LLC", "Routing 021000021", "Account 4471 0098 2210", "Reference: the invoice number"],
      },
      { kind: "stripe", enabled: true, lines: ["Card or bank debit, through the link on this invoice."] },
      { kind: "cash_or_cheque", enabled: false, lines: [] },
    ],
  }).catch(() => undefined);

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

  const overdueInvoice = await invoice({ client: "willowline", description: "AI visibility monitor — September", dollars: 2_970, dueInDays: -34 });
  await invoice({ client: "meridian", description: "Visibility monitor + displacement review — Q3", dollars: 4_450, dueInDays: -12 });
  await invoice({ client: "foldgrain", description: "AI visibility monitor — October", dollars: 990, dueInDays: 5 });
  await invoice({ client: "quillstone", description: "AI visibility monitor — October", dollars: 990, dueInDays: -3, payDollars: 990 });
  // Not issued. A draft is work the founder has done and not yet sent, which is its own kind of
  // money left on the table and its own row in the ledger's stat strip.
  await invoice({ client: "saltmarsh", description: "Setup + first month", dollars: 1_740, dueInDays: 21, issue: false });

  // ── The work ───────────────────────────────────────────────────────────────────────────────────
  //
  // One case per client at a different stage of the wedge's own ladder
  // (open → collecting → reconciling → review → filed), so the board reads as a month in motion
  // rather than five copies of "open".

  const kase = async (args: { client: string; title: string; stage: string; dueInDays?: number }) =>
    (
      await post<{ id: string }>("cases", {
        wedge: "geo-monitor",
        title: args.title,
        client_id: ids[args.client],
        stage: args.stage,
        ...(args.dueInDays === undefined ? {} : { due_at: iso(args.dueInDays) }),
      })
    ).id;

  const willowCase = await kase({ client: "willowline", title: "Halstead Robotics — November visibility report", stage: "probing", dueInDays: 3 });
  await kase({ client: "foldgrain", title: "Fernwood Health — November visibility report", stage: "probing", dueInDays: 6 });
  // Captured too: this engagement carries the deliverable that is WAITING ON THE FOUNDER, and its
  // `reporting` stage is the same fact from the case side. A demo where the case says review and the
  // deliverable does not exist is a demo that describes a workflow it cannot show.
  const meridianCase = await kase({ client: "meridian", title: "Parcelwise — competitor displacement review", stage: "reporting", dueInDays: 2 });
  // Captured, unlike its siblings: this is the engagement the delivered report hangs off, and
  // `closed` is the right stage for it — the work is done, which is what makes a deliverable honest.
  const quillCase = await kase({ client: "quillstone", title: "Brightline Legal — November visibility report", stage: "closed" });
  await kase({ client: "saltmarsh", title: "Kestrel Analytics — baseline probe", stage: "scoping", dueInDays: 11 });

  // ── On the clock ───────────────────────────────────────────────────────────────────────────────
  //
  // BEFORE the wait below, and that ordering is load-bearing rather than tidy. Arming a wait makes
  // the kernel `ensureWaitSchedule` a housekeeping tick under the internal `waits` wedge, and
  // `/brain` picks the wedge it asks about off the FIRST schedule it finds. Seeded the other way
  // round, every question a viewer types is scoped to `waits` — a wedge with no invoices, no cases
  // and no rules under it — and the answer to "Harborline" is "0 of 0 matches. Nothing matched."
  // A grounded-answer demo whose grounding is empty is the worst possible screen to record.

  // Both task types exist in `geo-monitor`'s manifest. The old pair (`daily_sync`, `monthly_close`)
  // were books-keeper's and would have been rejected the moment either schedule fired.
  await post("schedules", {
    name: "Weekly visibility probe",
    wedge: "geo-monitor",
    task_type: "weekly_report",
    cadence: { kind: "weekly", weekday: 1, hour: 7, minute: 30 },
    input: { client: "Halstead Robotics" },
  });
  await post("schedules", {
    name: "Monthly visibility report",
    wedge: "geo-monitor",
    task_type: "weekly_report",
    cadence: { kind: "monthly", day: 1, hour: 9, minute: 0 },
    input: { client: "Parcelwise" },
  });

  // ── What the business is blocked on ────────────────────────────────────────────────────────────
  //
  // Two outstanding asks and one live wait. This is the half of the model most demos skip and it is
  // the half a service-business owner recognises instantly: the report is not late because the work
  // is hard, it is late because the client has not sent back the one list it needs.

  const statementRequest = await post<{ id: string }>("requests", {
    client_id: ids.willowline,
    case_id: willowCase,
    kind: "document",
    ask: "The competitor list you want us probing against — five names is plenty. We have three from the site and want yours before the next run.",
  });
  await post("requests", {
    client_id: ids.foldgrain,
    kind: "answer",
    ask: "Models keep citing your 2023 pricing page. Is that URL still live on purpose, or should we recommend a redirect?",
  });

  /**
   * The stalled wait: the close cannot resume until that statement arrives.
   *
   * `request_resolved` and not a date, because the thing being waited on is a fact about the world
   * rather than the passage of time — the whole reason waits exist as a first-class object. It
   * carries an expiry so it cannot hang for ever, which is also what puts it in front of the
   * founder as something to decide about.
   */
  await post(`cases/${willowCase}/wait`, {
    reason: "the next visibility report is blocked on the competitor list only Halstead can confirm",
    condition: { kind: "request_resolved", request_id: statementRequest.id, label: "Halstead's competitor list" },
    resume: { task_type: "weekly_report", input: { client: "Halstead Robotics" } },
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
        "We probe the client's category questions on ChatGPT, Claude, Gemini and Perplexity every week, record what each model actually said and what it cited, and report share of voice against a named competitor set. We recommend the pages to write; the client writes them unless they have bought the build-out.",
    },
    {
      id: "pricing",
      answer:
        "$750 one-time setup, then $990/month for up to 40 tracked questions. Page build-out is $1,800 per page and is never bundled into the monthly. Competitor displacement reviews are quoted per engagement.",
    },
    {
      id: "chase-tone",
      answer:
        "Hi Dana — we are two days from the November run and still need your competitor list. Five names is plenty. Happy to run it against the three we inferred from your site if you would rather not spend the time.",
    },
    {
      id: "escalate",
      answer:
        "Anything that names a competitor in a claim we would publish. Any recommendation to change or retire a live pricing page. Any share-of-voice figure that moved more than 15 points in one week — that is usually our measurement breaking, not their market moving.",
    },
    {
      id: "quirks",
      answer:
        "Halstead's buyers ask about integrations before brands, so probe the integration questions first. Fernwood is in healthcare — never let a model's clinical claim into a report unquoted. Parcelwise has three competitors who outrank them everywhere; the report is worthless if it does not say which one and where.",
    },
  ];
  for (const t of taught) {
    await post(`wedges/geo-monitor/intake/${t.id}`, { answer: t.answer, during_onboarding: true });
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
   * bigger, and it would be a lie about this firm: the whole premise is a one-person practice that
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

  // ── The finished work, and the client who can see it ───────────────────────────────────────────
  //
  // ═══ THE TWO SCREENS THIS PRODUCT IS ACTUALLY SOLD ON, AND NEITHER EXISTED HERE ═══
  //
  // Everything above seeds the operations: money owed, work in flight, what we are waiting on. None
  // of it is the thing a founder is buying. What they are buying is that a piece of finished work
  // reaches their client, in their own branding, and the client opens it. Until now the seed could
  // not produce a single deliverable, so `/deliverables` and the whole client portal were empty on
  // every demo of this product — the two screens that carry the promise, dark.
  //
  // ═══ WHY THIS DOES NOT BREAK THE "NO SEEDED AGENT OUTPUT" RULE ═══
  //
  // The header of this file refuses to seed what an agent wrote, and it is right: under
  // `MYCEL_RUNTIME=mock` an agent writes the literal string `[mock]`, and putting that on a screen
  // whose whole claim is that the answer is grounded would be inventing the one thing a buyer is
  // being asked to believe.
  //
  // This is not that. The version below is `author: "founder"` and the file attached to it is a file
  // the founder uploaded — which is a REAL and ordinary path through the product, not a stand-in for
  // one. An agency exporting its own measurement working and sending it to a client is
  // the most common thing this software will ever be used for, and it involves no agent at all. What
  // is seeded here is a fact (this firm delivered this file), exactly like the invoices above.
  //
  // ═══ WHY A CSV AND NOT A PDF ═══
  //
  // `artifact-preview.ts` renders `.csv` through the same `sheet` mode as `.xlsx`: a real cell grid,
  // in the console inspector AND in the portal. A PDF renders as a page image. The grid is the
  // better demonstration because it is visibly DATA — a viewer can read the numbers and check them
  // against the invoices above — and because a CSV is a handful of bytes this script can write
  // without a spreadsheet library, so the seed keeps its "public API and nothing else" property.
  //
  // The rows are the same October the rest of this seed describes. They have to be: a demo where the
  // spreadsheet disagrees with the invoice list is worse than one with no spreadsheet.

  /**
   * WHERE THE CLIENT SHOWS UP WHEN A BUYER ASKS AN AI, one row per model, as a percentage of the
   * answers that named them at all. This is the working behind the report — the raw counts a
   * client is entitled to see under a headline figure — and it replaces a P&L.
   *
   * The columns are the same shape the renderer already understands (label, current, prior,
   * change), so nothing below needed rewriting to read them. What changed is what they MEAN, and
   * the formatter beneath (`money`) is now `pct`, because a share of voice printed as $48,250.00
   * would be the same class of bug as the count-formatted-as-money this file already documents.
   */
  const CLOSE_CSV = [
    "Surface,November,October,Change",
    "ChatGPT,34.0,26.0,+8.0 pts",
    "Perplexity,41.0,38.0,+3.0 pts",
    "Claude,22.0,24.0,-2.0 pts",
    "Gemini,17.0,17.0,0.0 pts",
    "Google AI Overviews,29.0,19.0,+10.0 pts",
    "Weighted share of voice,28.6,24.8,+3.8 pts",
    "",
    "Questions probed,40,,",
    "Awaiting competitor list,1,,",
  ].join("\n");


  /**
   * ═══ THE SAME CLOSE, AS THE DOCUMENT A CLIENT ACTUALLY OPENS ═══
   *
   * The CSV above is the working. This is the report, and the difference is the whole product:
   * `/deliverables` and the client portal are the two screens this is sold on, and until now both
   * rendered a spreadsheet. A spreadsheet is honest and it is not something a founder shows anyone.
   *
   * It breaks no rule in this file's header. That header refuses to seed what an AGENT wrote,
   * because under `MYCEL_RUNTIME=mock` an agent writes `[mock]` and putting that on a screen whose
   * claim is groundedness would fake the one thing a buyer is asked to believe. An agency
   * sending a client a formatted report alongside the raw export is not that — it is the
   * most ordinary path through this software, involves no agent, and is stamped `author: "founder"`
   * exactly like the CSV.
   *
   * EVERY FIGURE IS READ FROM `CLOSE_CSV`, never retyped. A demo whose report disagrees with its own
   * spreadsheet is worse than one with neither, and two hand-maintained copies of the same numbers
   * is how they come to disagree.
   *
   * Self-contained CSS, no external stylesheet and no webfont: this file is served through the
   * artifact route and read inside an iframe in `preview-pane.tsx`, where a network request for a
   * font is a request that does not happen and a layout that silently degrades.
   */
  /**
   * The P&L rows only — everything down to and including `Net`.
   *
   * `CLOSE_CSV` carries two counts after a blank line (`Unreconciled at 31 Oct,2,,`), and they
   * have four fields like every other row, so a shape filter admits them. Rendered into the table
   * they read "Questions probed  40.0%" — a count formatted as a percentage, in a measurement
   * demo. They belong under "Still open", where they already are, and nowhere else.
   */
  const allRows = CLOSE_CSV.split("\n")
    .slice(1)
    .map((line) => line.split(","))
    .filter((c) => c.length === 4 && c[0] && c[1]);
  const netAt = allRows.findIndex((c) => c[0] === "Weighted share of voice");
  const closeRows = netAt >= 0 ? allRows.slice(0, netAt + 1) : allRows;
  const money = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n)
      ? `${n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
      : v;
  };
  /**
   * The hand-built HTML close pack lived here and is gone. It has been replaced by a PDF that the
   * PRODUCT renders — same figures, read from the same `closeRows`, but laid out by
   * `render/report.ts` with a chart on page one and linted for taste on the way out.
   *
   * Keeping both would have put two versions of one document in front of a client, and the HTML
   * was only ever here because the seed could write it without reaching for the renderer.
   */

  /**
   * A task, and it is a HOLDER rather than a run.
   *
   * Artifacts hang off tasks — `POST /v1/tasks/:id/artifacts` is the founder's upload route and it
   * is scoped by the task's project. So one is created to carry the file. Its own output is never
   * read, never rendered and never shown; under the mock runtime it would say `[mock]`, and nothing
   * in this seed or on any screen below quotes it.
   *
   * Fail-soft, and the whole block is. A kernel that refuses to create a task — no queue, no
   * runtime, a stricter build — should still get every other row this script writes. The demo is
   * poorer without the deliverable; it is useless without the invoices.
   */
  let deliveredTo: string | undefined;
  let portalLink: string | undefined;
  try {
    const holder = await post<{ id: string }>("tasks", {
      wedge: "geo-monitor",
      task_type: "weekly_report",
      case_id: quillCase,
      /**
       * `client` IS REQUIRED (it was `period` while this ran on books-keeper) AND A MISSING
       * REQUIRED FIELD KILLS THE WHOLE SEED.
       *
       * The kernel rejected this with `$.period: required` and the demo never finished — so the
       * demo kernel had no deliverable, and `record-product.mjs`, which seeds before it films,
       * could not be run at all. The clips on the landing page were a week stale for this reason
       * and no test covers it: the seed is a script, not a suite.
       *
       * The same client the report below is addressed to. A holder task naming a different client
       * from the document hanging off it would be a demo contradicting itself in the one place a
       * buyer looks closely.
       *
       * The wedge's own schema note explains why it is required rather than inferred: "a close with
       * no period is a close of nothing, and production runs have failed asking for exactly this
       * after spending a sandbox to discover it."
       */
      input: { client: "Brightline Legal", seeded_upload: true },
    });

    // The report FIRST, because `artifact_ids` order is the order the inspector shows them and the
    // first is what a client opens. The ledger export goes with it — a real close is both, and a
    // report with no working behind it is the thing a client asks for next.
    /**
     * EVERY FIGURE COMES FROM `closeRows`, which is parsed from `CLOSE_CSV` — the same rule the
     * HTML already followed. A demo whose report disagrees with its own ledger is worse than one
     * with no report, and this one ships both files to the same client.
     *
     * The chart is the first block on purpose: `report.ts` added it because "a monthly close
     * arrived as a wall of correct figures, and every client who read one asked the same question
     * in different words: where is my money going." That is the block a viewer sees in the poster
     * frame of the recording, so it is the block that has to be there.
     */
    const kit = resolveBrandKit(undefined, BUSINESS_NAME);
    /**
     * The chart is every SURFACE, which is every row except the weighted total — a bar for the
     * summary line beside the things it summarises would double-count itself visually.
     *
     * It filtered on `Number(c[1]) < 0` when these were expenses, and a share of voice is never
     * negative, so that predicate now selects nothing and the chart would have vanished silently.
     * That is the whole hazard of reusing a numeric fixture for a different subject.
     */
    const spend = closeRows
      .filter((c) => c[0] !== "Weighted share of voice")
      .map((c) => ({ label: c[0]!, value: Number(c[1]), note: c[3] }));
    const pdf = render(
      "report",
      {
        title: "Where buyers find you when they ask AI",
        subtitle: "Brightline Legal — November",
        label: "Visibility report",
        meta: [
          { label: "Period", value: "1–30 November" },
          { label: "Questions", value: "40 probed weekly" },
          { label: "Prepared", value: BUSINESS_NAME },
        ],
        blocks: [
          {
            kind: "paragraph",
            text:
              "You are named in 28.6% of the answers buyers get when they ask about employment " +
              "counsel — up 3.8 points on October. The whole gain is ChatGPT and Google's AI " +
              "Overviews, both of which started citing your severance guide. Claude slipped two " +
              "points and is the one surface where a competitor now outranks you outright.",
          },
          { kind: "chart", title: "Share of voice, by surface", series: spend },
          { kind: "heading", text: "Every surface, month over month", level: 2 },
          {
            kind: "table",
            columns: ["Surface", "November", "October", "Change"],
            rows: closeRows.map((c) => [c[0]!, money(c[1]!), money(c[2]!), c[3]!]),
          },
          { kind: "heading", text: "What we would do next", level: 2 },
          {
            kind: "bullets",
            items: [
              "Write the non-compete enforceability page. It is the question you lose most often, and every model currently answers it with a competitor's blog.",
              "Your 2023 pricing page is still being cited. Redirect it — we are waiting on your call before recommending that to anyone else.",
              "Claude cites case law and almost never cites firms. Expect that surface to stay flat; it is not worth spending a page on.",
            ],
          },
          { kind: "heading", text: "Still open", level: 2 },
          {
            kind: "bullets",
            items: [
              "40 questions probed this month across five surfaces.",
              "Waiting on your competitor list before the next run.",
            ],
          },
        ],
        footer: `Prepared by ${BUSINESS_NAME}. Every figure is counted from answers we recorded, never estimated.`,
      },
      kit,
    );

    const reportForm = new FormData();
    reportForm.append(
      "file",
      new Blob([Buffer.from(pdf.content, "base64")], { type: pdf.content_type }),
      pdf.name,
    );
    const report = await s.upload<{ id: string }>(`tasks/${holder.id}/artifacts`, reportForm);

    const form = new FormData();
    form.append(
      "file",
      new Blob([CLOSE_CSV], { type: "text/csv" }),
      "Brightline-Legal-November-visibility.csv",
    );
    const uploaded = await s.upload<{ id: string }>(`tasks/${holder.id}/artifacts`, form);

    // `{ ok, deliverable }`, not the row — `founderSubmit` wraps it. Worth naming, because reading
    // `.id` off the envelope produced `POST /v1/deliverables/undefined/release → 404`, which points
    // at the release route and is really about the line above it.
    const created = await post<{ deliverable: { id: string } }>("deliverables", {
      case_id: quillCase,
      /**
       * `file_set`, NOT `document` — the kernel enforces the difference and it is right to.
       *
       * This said `document` from when the close was ONE hand-written HTML page. It now ships two
       * artifacts, the rendered report and the ledger export, and the kernel refuses: "a document
       * deliverable is exactly one file, and this version has 2". That rule is worth keeping: a
       * client opening a "document" and finding two files does not know which one is the answer.
       *
       * `books-keeper`'s manifest already declares both shapes in `deliverable_shapes`, so this is
       * the seed catching up with what the wedge always allowed. A real close IS both — the report
       * and the working behind it — which is exactly why the second file was added.
       */
      kind: "file_set",
      title: "November visibility report — Brightline Legal",
      summary:
        "You are named in 28.6% of the answers buyers get when they ask about employment counsel — up " +
        "3.8 points on October, all of it ChatGPT and Google's AI Overviews picking up your severance " +
        "guide. Claude slipped two points and is the one surface where a competitor now outranks you. " +
        "I would write the non-compete page next; we are still waiting on your competitor list.",
      artifact_ids: [report.id, uploaded.id],
      // No `author` here: it is not a body field and never should be. Who submitted a version is a
      // property of the route, and this one is the founder plane, so the kernel stamps it.
    });
    const deliverable = created.deliverable;
    // The founder's own gate. Nothing reaches a client until this call, and the portal's read filter
    // is `released_at` rather than a status — see deliverables.ts. So this line is the difference
    // between a screen the client can see and one they cannot.
    await post(`deliverables/${deliverable.id}/release`, {});
    deliveredTo = "Brightline Legal";

    /**
     * ═══ AND ONE THAT IS WAITING ON THE FOUNDER ═══
     *
     * The deliverable above is released, so `/deliverables` showed a single row in a single state
     * and the lifecycle — drafting → in_review → with_client → accepted — was invisible. Worse, the
     * product's core promise is the founder's gate ("nothing reaches a client until you release
     * it") and a demo could not show it, because nothing was ever waiting.
     *
     * This one is SUBMITTED AND NOT RELEASED. It is what `in_review` means to a founder — finished
     * work waiting on you — it lights the sidebar badge the app layout already fetches, and it puts
     * an item on Home's approvals surface. Nothing about it is agent-written: same founder-upload
     * path as the close above, same `author` stamp from the route.
     *
     * Parcelwise's case is already at stage `reporting`, so the two agree. A case that says it is
     * reporting with
     * no deliverable behind it is a workflow described rather than shown.
     */
    /**
     * ═══ RENDERED BY THE PRODUCT, LIKE THE ONE ABOVE ═══
     *
     * This was 40 lines of hand-written HTML with its own stylesheet, its own dark-mode media query
     * and its own table markup — a second document format, maintained in this script, sitting next
     * to a deliverable that `render/report.ts` produces. Two looks for one firm is exactly the
     * defect the brand kit exists to prevent, and a viewer comparing the two artifacts on the same
     * screen sees two different companies.
     *
     * Same renderer, same kit, same figures-read-from-one-place rule.
     */
    const DISPLACEMENT = [
      ["Question", "Who wins", "Us", "Gap"],
      ["best freight visibility software", "Fourkites", "not named", "—"],
      ["project44 alternatives", "Fourkites", "4th", "3 places"],
      ["TMS with real-time ETA", "Parcelwise", "1st", "holding"],
      ["freight API for shippers", "Fourkites", "2nd", "1 place"],
    ];
    const displacementPdf = render(
      "report",
      {
        title: "Who is being named instead of you",
        subtitle: "Parcelwise — competitor displacement",
        label: "Displacement review",
        meta: [
          { label: "Surfaces", value: "ChatGPT, Perplexity, Claude, Gemini" },
          { label: "Prepared", value: BUSINESS_NAME },
        ],
        blocks: [
          {
            kind: "paragraph",
            text:
              "Fourkites takes three of the four questions that matter most to your buyers, and on " +
              "the highest-volume one you are not named at all. That is not a ranking problem — " +
              "there is no page of yours for a model to cite. The one question you win is the one " +
              "you wrote a comparison page for last year.",
          },
          {
            kind: "table",
            columns: DISPLACEMENT[0]!,
            rows: DISPLACEMENT.slice(1),
          },
          { kind: "heading", text: "What we would do next", level: 2 },
          {
            kind: "bullets",
            items: [
              "Write the freight-visibility comparison page. It is the question you lose worst and the one you have nothing to cite.",
              "The real-time ETA page is working. Do not touch it — it is the only thing keeping you first anywhere.",
            ],
          },
        ],
        footer: `Prepared by ${BUSINESS_NAME}. Counted from recorded answers, never estimated.`,
      },
      kit,
    );

    const taxForm = new FormData();
    taxForm.append(
      "file",
      new Blob([Buffer.from(displacementPdf.content, "base64")], { type: displacementPdf.content_type }),
      displacementPdf.name,
    );
    const taxFile = await s.upload<{ id: string }>(`tasks/${holder.id}/artifacts`, taxForm);
    await post("deliverables", {
      case_id: meridianCase,
      kind: "document",
      title: "Competitor displacement — Parcelwise",
      summary:
        "Fourkites takes three of your four highest-intent questions, and on the biggest one you are " +
        "not named at all — there is no page of yours for a model to cite. The comparison page is the " +
        "fix and I have costed it. Needs your eyes before it goes to Dana; it names a competitor in " +
        "every row.",
      artifact_ids: [taxFile.id],
    });
    // Deliberately NOT released. That is the whole point of this row.

    // A way in. `portal-link` mints the token a client would receive by email; the console's own
    // client page has the same button, so this is not a seeding back door.
    const link = await post<{ token: string; url?: string }>(`clients/${ids.quillstone}/portal-link`, {});
    portalLink = link.url ?? `${APP_URL}/portal/enter?token=${link.token}`;
  } catch (e) {
    console.warn(`  ! could not seed the delivered work: ${(e as Error).message}`);
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
      (deliveredTo
        ? `\n    Delivered: "November visibility report — ${deliveredTo}" — released: a rendered PDF plus its CSV working\n` +
          `    → ${APP_URL}/deliverables      (the inspector: preview + the founder's verbs)\n` +
          `    → ${portalLink}\n` +
          `      (the CLIENT'S view of the same work. Open it in a private window — it is a different session.)\n`
        : `\n    ! No deliverable was seeded, so /deliverables and the portal are empty.\n`) +
      (await consoleIsUp()
        ? `\n    Sign in at ${APP_URL} as ${OWNER_EMAIL}\n`
        : `\n    Nothing is answering at ${APP_URL}, which is expected: THERE IS NO UI IN THIS REPO.\n` +
          `    The kernel is headless; the console is a separate consumer of /v1 —\n` +
          `    https://github.com/mycelhq/console, or build your own against the contract.\n` +
          `    The links above are where those pages WOULD be. The curl below works right now.\n` +
          `    (Set MYCEL_APP_URL if your console is somewhere other than :3000.)\n`) +
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
