// Fill ONE named tenant with a business that has been running for years.
//
// ═══ WHY THIS EXISTS ALONGSIDE seed-demo.ts ═══
//
// `seed-demo.ts` refuses to write anywhere but a loopback address, and says so in the clearest terms
// it can: "There is no override." That rail is right. A fixture generator that can be aimed at a
// live kernel is one flag away from writing invented invoices into a customer's books, and the
// blast radius of that mistake is the whole company.
//
// So this is not that script with the rail filed off. It is a different script with a DIFFERENT
// rail, because it has a different job: seeding the demo tenant on a real deployment, which is a
// thing we actually need and which loopback-only forbids by construction.
//
// ═══ THE RAIL ═══
//
// It authenticates, reads back the org it landed in, and REFUSES unless that org's name matches
// `--org` exactly. Not a prefix, not a fuzzy match. A credential pointed at the wrong tenant fails
// on the second call, before a single row is written.
//
// That is a better guarantee than a URL check, which is what loopback-only really is: it constrains
// WHERE the writes go, not WHOSE data they become. A demo credential cannot reach a customer's org,
// and if one ever could, this check is what stops it.
//
// ═══ WHAT "RICH" MEANS HERE ═══
//
// A demo tenant with three clients and no history reads as a fixture, and a viewer correctly
// concludes the product is a prototype. A firm that has been trading for years has: clients of
// different sizes and vintages, invoices in every state including long-settled ones, work in
// progress at different stages, questions waiting on clients, and a pipeline with real people in
// it. The spread is what makes the ranked views have something to rank.
//
// Every row goes through the public API, so it passed the same validation, tenancy check and
// normalisation a founder's own click produces. Nothing here can construct a state the product
// itself could not reach.
//
//   npx tsx harness/scripts/seed-tenant.ts --org-id <uuid>
//
// Requires MYCEL_URL, MYCEL_OWNER_EMAIL, MYCEL_OWNER_PASSWORD.

import { env, exit, argv } from "node:process";

const BASE = (env.MYCEL_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const EMAIL = env.MYCEL_OWNER_EMAIL ?? "";
const PASSWORD = env.MYCEL_OWNER_PASSWORD ?? "";
/**
 * The product API key, used INSTEAD of the member session when present.
 *
 * A showroom org refuses every write from a session — that is the point of it. The seeder is not a
 * visitor though: the key lives in Secrets Manager, never reaches a browser, and is the one
 * credential the guard exempts. Without this the rule eats its own tail and the tenant it protects
 * becomes the one tenant nobody can build.
 */
/**
 * `MYCEL_SEED_API_KEY` FIRST, because `MYCEL_API_KEY` is already taken where this has to run.
 *
 * The kernel's own ECS task definition defines `MYCEL_API_KEY` as a secret — the kernel's bootstrap
 * key, scoped to the system `default` project. Seeding the demo means running this script from
 * inside the VPC on that same image, and a container override that sets `MYCEL_API_KEY` as a plain
 * environment variable LOSES to the task definition's secret of the same name.
 *
 * So the seeder silently ran as the kernel and wrote 46 records into the wrong org, and every count
 * it printed said 46/46 because from its point of view the writes worked. A distinct name cannot
 * collide, which is the only property that actually helps here.
 */
const API_KEY = env.MYCEL_SEED_API_KEY ?? env.MYCEL_API_KEY ?? "";

const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WANT_ORG = arg("--org-id");

/**
 * ═══ WHICH HALF TO SEED, BECAUSE ONLY ONE HALF IS SAFE TO REPEAT ═══
 *
 * The two halves of this script have different idempotence, and running it twice used to mean
 * finding out which.
 *
 * The GTM records are keyed — `key: co.domain`, `key: p.slug` — so `POST /v1/records` upserts and a
 * second run overwrites in place. The BOOK is not: `POST /v1/clients` mints a new id every time, and
 * invoices and cases hang off whatever ids that run produced. So a re-run doubles the roster,
 * doubles the money, and leaves the demo showing sixteen clients with two of everything.
 *
 * That is exactly the situation this was needed for: the pipeline was seeded with stages that do not
 * exist and had to be rewritten, while the book was already correct and must not be touched.
 *
 *   --only gtm    companies and people. Keyed, safe to repeat.
 *   --only book   clients, invoices, cases, requests. Creates. Run ONCE per tenant.
 *   (default)     both, which is what a fresh tenant wants.
 */
/**
 * ═══ AND `fill`, FOR A TENANT THAT ALREADY EXISTS ═══
 *
 * The demo org has had a roster and cases since the day it was made and has never had a single
 * invoice, and until now there was no way to give it one. The reason is worth writing down because
 * it is a whole class of bug: every downstream loop reads `ids[inv.client]`, and `ids` was only
 * ever populated by CREATING clients in the same run. So the only way to reach an existing client
 * was to make a second copy of it — which is precisely what `--only book` warns you not to do.
 *
 * The roster is now RESOLVED before it is created: `GET /v1/clients`, matched on handle, reused
 * where it exists. That fixes the class rather than the instance — `book` stops doubling the book
 * on a second run, and `fill` becomes possible at all.
 *
 *   --only gtm    companies and people. Keyed, safe to repeat.
 *   --only book   clients, invoices, cases, requests. Now resolves before creating, so a re-run
 *                 attaches to the existing roster instead of cloning it. Cases and requests still
 *                 create, so it is not fully idempotent — prefer `fill`.
 *   --only fill   NEVER creates a client. Attaches the things a live tenant turns out to be
 *                 missing — invoices, answered intake — to whatever roster is already there, and
 *                 skips anything already present. Safe to repeat.
 *   (default)     gtm + book, which is what a fresh tenant wants.
 */
const ONLY = arg("--only") ?? "all";
const doing = (part: "gtm" | "book" | "fill"): boolean =>
  part === "fill" ? ONLY === "fill" : ONLY === "all" || ONLY === part;

/** Both halves that touch the book need the roster, however it got there. */
const needsRoster = (): boolean => doing("book") || doing("fill");

let TOKEN = "";
let PROJECT = "";

async function call<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const r = await fetch(`${BASE}/v1/${path}`, {
    method: body === undefined && method === "POST" ? "GET" : method,
    headers: {
      "content-type": "application/json",
      ...(API_KEY || TOKEN ? { authorization: `Bearer ${API_KEY || TOKEN}` } : {}),
      ...(PROJECT ? { "x-mycel-project": PROJECT } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const day = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const iso = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
};
const usd = (dollars: number): number => Math.round(dollars * 100);

/**
 * A failed write, reported ONCE with its reason.
 *
 * Every call site here was `.catch(() => false)`, and a run against the wrong host printed
 * `companies 0/18  people 0/46` with no hint that all sixty-four failed for the same trivial reason
 * (the kernel is not on that hostname). A counter that can only say "none of them worked" sends you
 * reading the data when the problem is the URL.
 *
 * Deduplicated because sixty-four identical stack traces is its own kind of unreadable, and the
 * second one tells you nothing the first did not.
 */
const seenErrors = new Set<string>();
function note(e: unknown): false {
  const msg = (e as Error).message ?? String(e);
  if (!seenErrors.has(msg)) {
    seenErrors.add(msg);
    console.error(`    ! ${msg}`);
  }
  return false;
}

/**
 * A roster with VINTAGE. Ages, sizes and industries differ because a real book of business is
 * lopsided — one anchor client paying most of the bills, a few mid-size, a couple of small ones
 * that arrived last month.
 *
 * `logo_url` uses Clearbit's public logo endpoint against real domains, so the roster renders
 * actual company marks rather than initials on grey squares. Faces are what make a list of names
 * read as a business.
 *
 * ═══ REAL DOMAIN FOR THE LOGO, UNROUTABLE ADDRESS FOR THE MAILBOX ═══
 *
 * These two fields used to be the same string, and that put a REAL, DELIVERABLE address on every
 * client of a demo tenant that hands any visitor a full owner session — `admin@fairmont.com`,
 * `ops@ridgeline.com`, `hello@willow.co`. Registered domains belonging to actual companies.
 *
 * It is inert today only because the demo org has no connections at all, so every send fails with
 * "this business has no mailbox connected". That is not a safeguard, it is an accident of setup: the
 * day somebody connects a mailbox to make the demo more convincing, a stranger clicking Approve can
 * mail a dental practice in the middle of a Product Hunt launch.
 *
 * So `domain` stays real — Clearbit needs it and the logos are worth having — and `handle` moves to
 * `.invalid`, which RFC 2606 reserves and guarantees will never resolve.
 *
 * `.invalid` rather than `.example`, deliberately: `ship-checks.ts` lists `.example` as forbidden
 * PLACEHOLDER vocabulary, so a deliverable quoting one of these addresses would be held as
 * unfinished. `.invalid` is equally unroutable and carries no such meaning.
 */
const CLIENTS = [
  { key: "ridgeline", name: "Ridgeline Logistics", handle: "ops@ridgeline.invalid", domain: "ridgeline.com", note: "Anchor client. Monthly AI-visibility reporting since 2024." },
  { key: "willow", name: "Willow & Pine", handle: "hello@willow.invalid", domain: "willow.co", note: "Webflow build plus ongoing SEO retainer." },
  { key: "fairmont", name: "Fairmont Dental Group", handle: "admin@fairmont.invalid", domain: "fairmont.com", note: "Local search across four practices." },
  { key: "marlow", name: "Marlow & Associates", handle: "reception@marlow.invalid", domain: "marlow.law", note: "Content programme. Quarterly review." },
  { key: "sunset", name: "Sunset Coffee Roasters", handle: "orders@sunset.invalid", domain: "sunset.coffee", note: "Shopify storefront and lifecycle email." },
  { key: "delgado", name: "Delgado Builders", handle: "office@delgado.invalid", domain: "delgado.build", note: "New site, launched last month." },
  { key: "cedar", name: "Cedar Home Care", handle: "care@cedar.invalid", domain: "cedar.health", note: "Joined in January. Local SEO." },
  { key: "pike", name: "Pike Street Kitchen", handle: "bookings@pikestreet.invalid", domain: "pikestreet.restaurant", note: "Smallest account. Reviews and listings." },
];

/**
 * Invoices spanning the WHOLE of `effectiveStatus`, and spanning time.
 *
 * Seed them all identical and `/invoices` is technically populated while saying nothing, and
 * `/next` has nothing to rank. The spread is the content: badly overdue money is the single most
 * legible thing this product does, and a firm with two years of history has settled invoices behind
 * it, not just live ones.
 */
const INVOICES = [
  { client: "ridgeline", dollars: 4200, due: -47, desc: "AI visibility retainer — March" },
  { client: "ridgeline", dollars: 4200, due: -77, desc: "AI visibility retainer — February", pay: 4200 },
  { client: "ridgeline", dollars: 4200, due: -108, desc: "AI visibility retainer — January", pay: 4200 },
  { client: "willow", dollars: 8750, due: -12, desc: "Webflow build — milestone 2 of 3" },
  { client: "willow", dollars: 8750, due: -63, desc: "Webflow build — milestone 1 of 3", pay: 8750 },
  { client: "fairmont", dollars: 1800, due: 9, desc: "Local search retainer — April" },
  { client: "fairmont", dollars: 1800, due: -21, desc: "Local search retainer — March", pay: 1800 },
  { client: "marlow", dollars: 3400, due: -5, desc: "Content programme — Q1" },
  { client: "sunset", dollars: 2250, due: 16, desc: "Lifecycle email build" },
  { client: "delgado", dollars: 6900, due: -34, desc: "Website build — final" },
  { client: "cedar", dollars: 1200, due: 22, desc: "Local SEO — April" },
  { client: "pike", dollars: 650, due: -3, desc: "Reviews and listings — March" },
];

const CASES = [
  { client: "ridgeline", title: "Ridgeline Logistics — April visibility report", stage: "collecting", due: 3 },
  { client: "willow", title: "Willow & Pine — pricing page rebuild", stage: "reconciling", due: 6 },
  { client: "fairmont", title: "Fairmont Dental — four-practice listing audit", stage: "collecting", due: 11 },
  { client: "marlow", title: "Marlow — Q2 content plan", stage: "drafting", due: 18 },
  { client: "delgado", title: "Delgado Builders — post-launch review", stage: "reviewing", due: 2 },
  /**
   * THE LAST THREE, BECAUSE EIGHT CLIENTS AND FIVE ENGAGEMENTS IS A BOOK WITH HOLES IN IT.
   *
   * Sunset, Cedar and Pike were in `CLIENTS` with nothing to do — they appeared on the roster, in
   * the invoice list and nowhere else, so the demo showed three customers who are apparently paying
   * for no work. It also broke `seed-history`, which now places each seeded file on the engagement
   * of the client its filename names and has nowhere to put theirs.
   */
  { client: "sunset", title: "Sunset Coffee — lifecycle email sequence", stage: "drafting", due: 8 },
  { client: "cedar", title: "Cedar Home Care — local search across three towns", stage: "collecting", due: 5 },
  { client: "pike", title: "Pike Street — reviews and listings refresh", stage: "reviewing", due: 14 },
];

/**
 * THE PIPELINE. "Find clients" was the emptiest screen in the product, and it is the half most
 * prospects are buying.
 *
 * Companies first, then the people who work at them: `companyOf` is a plain map lookup, so a person
 * written before their employer renders with a blank company block. `logo_url` and `photo_url` are
 * what turn a list of strings into faces — a CRM without them reads as a spreadsheet.
 */
const GTM_COMPANIES = [
  { domain: "orbitalstudio.co", name: "Orbital Studio", industry: "Brand and web design", headcount: 11 },
  { domain: "kestrelmedia.com", name: "Kestrel Media", industry: "Performance marketing", headcount: 24 },
  { domain: "fernhillseo.com", name: "Fernhill SEO", industry: "Search and content", headcount: 8 },
  { domain: "loomdigital.io", name: "Loom Digital", industry: "Web development", headcount: 17 },
  { domain: "quaystreetcreative.com", name: "Quay Street Creative", industry: "Creative studio", headcount: 6 },
  { domain: "brightpathmarketing.com", name: "Brightpath Marketing", industry: "Full-service marketing", headcount: 31 },
  { domain: "sableandco.design", name: "Sable & Co.", industry: "Brand identity", headcount: 5 },
  { domain: "northbeamdigital.com", name: "Northbeam Digital", industry: "Paid media", headcount: 19 },
  { domain: "havenmedia.com", name: "Haven Media", industry: "Content and video", headcount: 13 },
  { domain: "arborcreative.com", name: "Arbor Creative", industry: "Creative studio", headcount: 9 },
  { domain: "pinnaclesearch.io", name: "Pinnacle Search", industry: "Technical SEO", headcount: 12 },
  { domain: "driftwoodagency.com", name: "Driftwood Agency", industry: "Social and community", headcount: 22 },
  { domain: "wrenandbolt.com", name: "Wren & Bolt", industry: "Web development", headcount: 7 },
  { domain: "meridiangrowth.co", name: "Meridian Growth", industry: "Growth consulting", headcount: 15 },
  { domain: "copperfoxstudio.com", name: "Copper Fox Studio", industry: "Design and build", headcount: 4 },
  { domain: "lanternmarketing.com", name: "Lantern Marketing", industry: "Local search", headcount: 28 },
  { domain: "tidalwavemedia.io", name: "Tidalwave Media", industry: "Performance marketing", headcount: 36 },
  { domain: "greywillowdigital.com", name: "Grey Willow Digital", industry: "Ecommerce", headcount: 14 },
];

/**
 * ═══ THE STAGES ARE THE ONES THAT EXIST, WHICH THEY WERE NOT ═══
 *
 * This list used to say `sourced`, `contacted` and `engaged`. None of those are stages. `STAGES` in
 * cloud/lib/gtm.ts is `queued warmed invited connected dm1 dm2 em1 replied booked won lost`, so five
 * of the six seeded people belonged to no column on the board and the pipeline read as empty while
 * the database read as seeded. That is the whole complaint about this screen, and it was a
 * vocabulary mismatch rather than a missing row.
 *
 * ═══ AND EVERY FIELD THE CARD DRAWS ═══
 *
 * `pipeline-card.tsx` renders name, title, headline, photo, company name, company logo, email,
 * email_status, linkedin_url, stage, due_at. The seed filled six of those. A card with a face and a
 * job title and three empty slots looks like a broken import, not a prospect — the missing contact
 * detail is exactly what a founder is checking for when they judge whether the pipeline is real.
 *
 * ═══ THE SHAPE IS A FUNNEL, DELIBERATELY ═══
 *
 * Weighted to the early stages, because that is what a real book looks like: plenty queued, a few
 * replies, two bookings, a couple won, a few lost. An even spread across eleven columns would be
 * eleven tidy piles and would say the pipeline is decorative. `lost` matters most of all — a CRM
 * with no losses in it is obviously fake, and a founder reads that instantly.
 */
const GTM_PEOPLE = [
  // ── Replied, booked and won: the top of the board, where the story pays off ──
  { slug: "amara-boateng", name: "Amara Boateng", title: "Founder", company: "orbitalstudio.co", stage: "replied", headline: "Building brands for climate tech", location: "Austin, TX" },
  { slug: "tom-hedley", name: "Tom Hedley", title: "Managing Director", company: "kestrelmedia.com", stage: "replied", headline: "Performance marketing for DTC", location: "Denver, CO" },
  { slug: "marcus-webb", name: "Marcus Webb", title: "Founder", company: "northbeamdigital.com", stage: "replied", headline: "Paid media, mostly B2B SaaS", location: "Austin, TX" },
  { slug: "elena-vasquez", name: "Elena Vasquez", title: "Managing Partner", company: "brightpathmarketing.com", stage: "replied", headline: "Twelve years in-house, now agency side", location: "Chicago, IL" },
  { slug: "priya-raman", name: "Priya Raman", title: "Head of Delivery", company: "fernhillseo.com", stage: "booked", headline: "Search and content for healthcare", location: "Seattle, WA" },
  { slug: "james-okafor", name: "James Okafor", title: "Co-founder", company: "meridiangrowth.co", stage: "booked", headline: "Growth for early-stage teams", location: "Chicago, IL" },
  { slug: "sofia-marchetti", name: "Sofia Marchetti", title: "Owner", company: "quaystreetcreative.com", stage: "won", headline: "Small studio, big clients", location: "Dublin, IE" },
  { slug: "daniel-okoro", name: "Daniel Okoro", title: "Co-founder", company: "loomdigital.io", stage: "won", headline: "We build the sites other agencies subcontract", location: "Lagos, NG" },

  // ── Mid-sequence: the messages that have gone out and not yet come back ──
  { slug: "rachel-nunn", name: "Rachel Nunn", title: "Operations Director", company: "driftwoodagency.com", stage: "em1", headline: "Community-led social", location: "San Diego, CA" },
  { slug: "victor-lindqvist", name: "Victor Lindqvist", title: "Founder", company: "pinnaclesearch.io", stage: "em1", headline: "Technical SEO, enterprise only", location: "Stockholm, SE" },
  { slug: "aisha-rahman", name: "Aisha Rahman", title: "Head of Client Services", company: "lanternmarketing.com", stage: "em1", headline: "Local search at scale", location: "Atlanta, GA" },
  { slug: "grant-mcallister", name: "Grant McAllister", title: "Managing Director", company: "tidalwavemedia.io", stage: "dm2", headline: "Scaling spend for ecommerce", location: "Glasgow, UK" },
  { slug: "nina-petrova", name: "Nina Petrova", title: "Founder", company: "sableandco.design", stage: "dm2", headline: "Identity work for founders", location: "Berlin, DE" },
  { slug: "oliver-bancroft", name: "Oliver Bancroft", title: "Partner", company: "havenmedia.com", stage: "dm2", headline: "Video that does not look like an ad", location: "Nashville, TN" },
  { slug: "chidi-nwosu", name: "Chidi Nwosu", title: "Founder", company: "wrenandbolt.com", stage: "dm1", headline: "Two developers, no account managers", location: "Toronto, CA" },
  { slug: "hannah-brooks", name: "Hannah Brooks", title: "Client Partner", company: "greywillowdigital.com", stage: "dm1", headline: "Shopify Plus specialists", location: "Portland, OR" },
  { slug: "luca-ferrari", name: "Luca Ferrari", title: "Creative Director", company: "arborcreative.com", stage: "dm1", headline: "Design led, strategy first", location: "Milan, IT" },
  { slug: "beatrice-adeyemi", name: "Beatrice Adeyemi", title: "Founder", company: "copperfoxstudio.com", stage: "dm1", headline: "Four of us, ten years together", location: "Edinburgh, UK" },

  // ── Connected and invited: the network built but not yet spoken to ──
  { slug: "jen-whitlock", name: "Jen Whitlock", title: "Operations Lead", company: "kestrelmedia.com", stage: "connected", headline: "Making the delivery side work", location: "Denver, CO" },
  { slug: "samuel-reyes", name: "Samuel Reyes", title: "Head of Growth", company: "brightpathmarketing.com", stage: "connected", headline: "Demand gen for mid-market", location: "Denver, CO" },
  { slug: "fiona-gallagher", name: "Fiona Gallagher", title: "Managing Director", company: "havenmedia.com", stage: "connected", headline: "Twenty years, still enjoying it", location: "Belfast, UK" },
  { slug: "kenji-morita", name: "Kenji Morita", title: "Founder", company: "orbitalstudio.co", stage: "connected", headline: "Product design and brand", location: "Vancouver, CA" },
  { slug: "clara-jensen", name: "Clara Jensen", title: "Delivery Lead", company: "pinnaclesearch.io", stage: "connected", headline: "Audits that people actually action", location: "Copenhagen, DK" },
  { slug: "tobias-schmidt", name: "Tobias Schmidt", title: "Co-founder", company: "northbeamdigital.com", stage: "invited", headline: "Media buying, no fluff", location: "Munich, DE" },
  { slug: "amelia-hart", name: "Amelia Hart", title: "Founder", company: "arborcreative.com", stage: "invited", headline: "Brand systems for scale-ups", location: "Melbourne, AU" },
  { slug: "ryan-doherty", name: "Ryan Doherty", title: "Principal", company: "meridiangrowth.co", stage: "invited", headline: "Fractional growth lead", location: "Boston, MA" },
  { slug: "yuki-tanaka", name: "Yuki Tanaka", title: "Head of Operations", company: "tidalwavemedia.io", stage: "invited", headline: "Ops for a 36-person agency", location: "Singapore, SG" },
  { slug: "martin-oduya", name: "Martin Oduya", title: "Founder", company: "driftwoodagency.com", stage: "invited", headline: "Social for challenger brands", location: "Nairobi, KE" },
  { slug: "sara-lindberg", name: "Sara Lindberg", title: "Account Director", company: "lanternmarketing.com", stage: "invited", headline: "Multi-location retail clients", location: "Oslo, NO" },

  // ── Warmed and queued: the top of the funnel, which is where most of a book lives ──
  { slug: "declan-moore", name: "Declan Moore", title: "Founder", company: "wrenandbolt.com", stage: "warmed", headline: "Ex-agency, now running my own", location: "Cork, IE" },
  { slug: "priscilla-owens", name: "Priscilla Owens", title: "Managing Partner", company: "greywillowdigital.com", stage: "warmed", headline: "Ecommerce, mostly fashion", location: "New York, NY" },
  { slug: "andre-silva", name: "Andre Silva", title: "Creative Lead", company: "sableandco.design", stage: "warmed", headline: "Identity, packaging, everything printed", location: "Lisbon, PT" },
  { slug: "meera-kapoor", name: "Meera Kapoor", title: "Founder", company: "copperfoxstudio.com", stage: "warmed", headline: "Design and build under one roof", location: "Bengaluru, IN" },
  { slug: "callum-frazer", name: "Callum Frazer", title: "Head of Delivery", company: "quaystreetcreative.com", stage: "warmed", headline: "Keeping six people busy", location: "Perth, AU" },
  { slug: "isabelle-dubois", name: "Isabelle Dubois", title: "Founder", company: "fernhillseo.com", stage: "queued", headline: "Content that ranks and reads well", location: "Lyon, FR" },
  { slug: "nathan-cole", name: "Nathan Cole", title: "Managing Director", company: "loomdigital.io", stage: "queued", headline: "Development partner to five agencies", location: "Auckland, NZ" },
  { slug: "zainab-hassan", name: "Zainab Hassan", title: "Founder", company: "brightpathmarketing.com", stage: "queued", headline: "Marketing for professional services", location: "Dubai, AE" },
  { slug: "peter-vandenberg", name: "Peter van den Berg", title: "Partner", company: "northbeamdigital.com", stage: "queued", headline: "Paid search, twelve years", location: "Amsterdam, NL" },
  { slug: "grace-mwangi", name: "Grace Mwangi", title: "Founder", company: "havenmedia.com", stage: "queued", headline: "Video and photography", location: "Cape Town, ZA" },
  { slug: "eli-rosenthal", name: "Eli Rosenthal", title: "Head of Strategy", company: "meridiangrowth.co", stage: "queued", headline: "Positioning before tactics", location: "Tel Aviv, IL" },
  { slug: "charlotte-white", name: "Charlotte White", title: "Founder", company: "pinnaclesearch.io", stage: "queued", headline: "SEO for regulated industries", location: "Wellington, NZ" },
  { slug: "omar-benali", name: "Omar Benali", title: "Managing Director", company: "arborcreative.com", stage: "queued", headline: "Creative studio, fifteen years", location: "Casablanca, MA" },
  { slug: "sinead-kelly", name: "Sinead Kelly", title: "Operations Director", company: "driftwoodagency.com", stage: "queued", headline: "The person who makes it ship", location: "Galway, IE" },

  // ── Lost. A pipeline with no losses in it is obviously fake ──
  { slug: "gregory-payne", name: "Gregory Payne", title: "Founder", company: "tidalwavemedia.io", stage: "lost", headline: "Performance marketing", location: "Miami, FL" },
  { slug: "leila-mansour", name: "Leila Mansour", title: "Managing Director", company: "lanternmarketing.com", stage: "lost", headline: "Local search and reputation", location: "Marseille, FR" },
  { slug: "stuart-bell", name: "Stuart Bell", title: "Co-founder", company: "greywillowdigital.com", stage: "lost", headline: "Ecommerce builds", location: "Minneapolis, MN" },
];

/**
 * The spread of enrichment outcomes. See the note on `email_status` below.
 *
 * "DELIVERABLE" is the provider's own wire value and the card special-cases it to "ok"; the rest are
 * shown lowercased as they are. Ordered so that walking the list gives a plausible mix rather than
 * runs of the same verdict down a column.
 */
const EMAIL_STATUS = ["DELIVERABLE", "DELIVERABLE", "risky", "DELIVERABLE", "unknown", "DELIVERABLE", "catch_all"];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE DEMO BUSINESS KNOWS ABOUT ITSELF
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The demo tenant's Knowledge page read "0 of 5 — 5 still to answer", which is the single most
 * damaging empty state in the product to show a stranger. Every other empty screen says "you have
 * not done this yet"; that one says the agent has been given nothing to work from, on a page whose
 * headline is "Teach it what you know". The whole argument of the product is that a correction is
 * kept, and the demo was evidence that nothing had been.
 *
 * These are written as an operator would answer them, not as documentation. Specific numbers,
 * named clients from this same seed, one real refusal, and a chase with a sentence in it somebody
 * would actually send. A generic answer here would seed a generic house style, and the point of
 * the page is that the house style is yours.
 *
 * Keyed by the question ids declared in `wedges/geo-monitor/wedge.json`. A key that no longer
 * matches a declared question is skipped and reported rather than invented, because the failure
 * this protects against is a renamed question quietly going unanswered forever.
 */
/**
 * WHAT THE BUSINESS HAS WRITTEN DOWN.
 *
 * ═══ Why the demo needs this and production is missing it ═══
 *
 * `/files` renders the memory tree as the business's brain: the drawers, the notes, the wiki links
 * between them. On a tenant with no memory it renders the services and then nothing — a file
 * explorer with no files, which is the least convincing possible version of "this system
 * accumulates what it learns".
 *
 * It is also the honest state of production. Zero `memory:write` events have ever been recorded
 * (see the note in `memory.ts` and the measurement behind it), so the drawer is empty for every org
 * that exists. Seeding the showroom does not fix that — the loop still has to run — but a demo that
 * cannot show the feature at all is a demo that argues against it.
 *
 * ═══ These are notes a run would plausibly have written ═══
 *
 * Not marketing copy about memory. Each one is the kind of thing an agent writes down mid-job — a
 * client's quirk, a decision and its reason, a date that matters — because that is what the feature
 * produces and a demo that shows something else is showing a different product.
 *
 * `[[wiki-links]]` between them on purpose: the tree is a graph, and a demo where nothing links to
 * anything hides the half that makes it a brain rather than a folder.
 */
const MEMORY: { path: string; body: string }[] = [
  {
    path: "clients/ridgeline.md",
    body:
      "# Ridgeline Dental\n\n" +
      "Reports go to Dana, never to the shared inbox — the shared one is three receptionists and " +
      "nothing gets read. Confirmed after two months of silence on the [[engagements/ridgeline-visibility]] " +
      "retainer.\n\n" +
      "They call it 'the ranking report'. Using our own words for it on a call cost ten minutes once.\n\n" +
      "Do not reference competitors by name in the summary. Dana forwards these to the practice owner " +
      "and he reads any named competitor as a recommendation.",
  },
  {
    path: "clients/fairmont.md",
    body:
      "# Fairmont Family Practice\n\n" +
      "Four locations, read separately. A single combined number is the one thing they have asked us " +
      "twice not to send — see [[knowledge/per-location-breakdown]].\n\n" +
      "Invoices go to accounts@, work goes to Marie. Sending either to the other address adds a week.",
  },
  {
    path: "engagements/ridgeline-visibility.md",
    body:
      "# Ridgeline — monthly visibility\n\n" +
      "First working day of the month, covering the month before. $3,000/mo.\n\n" +
      "Scope is the report only. Content work that the report surfaces is quoted separately and this " +
      "has been argued once already — if a run drafts content here it is out of scope and the founder " +
      "should see it before it goes.\n\n" +
      "Contact: [[clients/ridgeline]].",
  },
  {
    path: "knowledge/per-location-breakdown.md",
    body:
      "# Multi-location clients get their locations split\n\n" +
      "A practice with more than one address reads the locations separately, because the person " +
      "receiving the report is usually accountable for one of them.\n\n" +
      "Learned on [[clients/fairmont]] after a combined report was sent and came back with 'which of " +
      "these is mine'. Applied to every multi-location client since.",
  },
  {
    path: "timeline/2026-08-close.md",
    body:
      "# August close\n\n" +
      "All four reports out on the 1st. Fairmont's took a second pass — the per-location split was " +
      "missing from the first draft, which is now written down as [[knowledge/per-location-breakdown]] " +
      "rather than remembered.\n\n" +
      "Ridgeline lost position 2 on 'emergency dentist' to a competitor. Flagged, not actioned: " +
      "content is out of scope on that retainer.",
  },
];

const KNOWLEDGE_WEDGE = "geo-monitor";

const KNOWLEDGE: { id: string; answer: string }[] = [
  {
    id: "engagement-scope",
    answer:
      "A visibility report on the 1st working day of the month, covering the previous month. For each client: " +
      "where they appear across ChatGPT, Claude, Gemini and Perplexity for their tracked prompt set, what moved " +
      "since last month, and which competitor took any position they lost. Ridgeline and Fairmont also get the " +
      "per-location breakdown — Fairmont is four practices and they read them separately. Anything that needs new " +
      "content from us is flagged in the report but is NOT in the fee; that is quoted separately.",
  },
  {
    id: "pricing",
    answer:
      "Monthly retainer, billed on the 1st, 14 day terms. £/$ figures are per client and already on the invoice — " +
      "Ridgeline 4,200, Willow 3,500 during the build then 1,800, Fairmont 1,800, Cedar 1,200, Pike 650. " +
      "Outside the fee: writing or rewriting pages, schema work, anything on a site we do not already run, and " +
      "adding more than five tracked prompts in a month. Rush work inside 48 hours is +50%. We do not bill for " +
      "the report itself being late if it is our fault.",
  },
  {
    id: "chase-tone",
    answer:
      "Short, names the thing, gives a date, does not apologise. What I actually send:\n\n" +
      "\"Hi Sam — still need the March GA4 export to finish your report. If you can get it over by Thursday the " +
      "report lands Friday as normal; after that it slips to the following week. Happy to jump on a call if it is " +
      "easier for someone there to pull it.\"\n\n" +
      "Never more than three sentences, never a chase that only says 'just following up', and never two chases in " +
      "the same week. If the second one goes unanswered I ring them.",
  },
  {
    id: "escalate",
    answer:
      "Stop and come to me when: a client's visibility drops more than 20% month on month (that is a conversation, " +
      "not a line in a report); the data is incomplete and the report would have to guess; anything that would go " +
      "out to a client's own customers; a competitor mention that names them unfavourably; or any figure that " +
      "contradicts what we told them last month. Do not stop for a missing logo, a formatting question, or a " +
      "single prompt that failed to return — note it and carry on.",
  },
  {
    id: "quirks",
    answer:
      "Fairmont is four practices under one name and they must never be averaged into one number — the Didsbury " +
      "practice is the one the owner actually looks at. Ridgeline's marketing lead changed in February; the report " +
      "goes to Priya now, not Dan, and she wants the summary first and the tables at the back. Willow are mid " +
      "site-rebuild so month-on-month comparisons are meaningless until it ships — say so rather than showing a " +
      "drop. Pike Street is the smallest account and the owner reads it on a phone, so no wide tables. Cedar are " +
      "in care and are regulated; nothing about outcomes or clinical claims, ever.",
  },
];

const REQUESTS = [
  { client: "ridgeline", kind: "answer", ask: "Which three competitors should the April report benchmark against? Last quarter used DHL, Kuehne+Nagel and DSV." },
  { client: "willow", kind: "document", ask: "Final pricing tiers for the new page — a doc or a screenshot of the sheet is fine." },
  { client: "fairmont", kind: "answer", ask: "The Fairview practice shows different opening hours on Google and on your site. Which is right?" },
  { client: "sunset", kind: "document", ask: "Product photography for the six new single-origin bags." },
];

async function main() {
  if (!WANT_ORG) throw new Error("--org-id is required, and must match the target org exactly");
  if (!API_KEY && (!EMAIL || !PASSWORD)) throw new Error("MYCEL_API_KEY, or MYCEL_OWNER_EMAIL and MYCEL_OWNER_PASSWORD");

  /**
   * With a key there is no login and no projects list, so the project is named explicitly. With a
   * session the first project is taken, which is what the original run did.
   */
  if (API_KEY) {
    PROJECT = arg("--project-id") ?? "";
    if (!PROJECT) throw new Error("--project-id is required when seeding with MYCEL_API_KEY");
  } else {
    const login = await call<{ token: string; projects: { id: string; name: string }[] }>("auth/login", {
      email: EMAIL,
      password: PASSWORD,
    });
    TOKEN = login.token;
    PROJECT = login.projects?.[0]?.id ?? "";
    if (!PROJECT) throw new Error("that account has no project to seed");
  }

  /**
   * ═══ THE RAIL ═══
   *
   * Read back which org this credential actually landed in and refuse unless it is EXACTLY the one
   * named. An ORG ID rather than a name, deliberately: names collide, are edited, and invite fuzzy
   * matching. An id is the thing tenancy is actually enforced on everywhere else in the system, so
   * it is the thing worth checking here. A credential pointed at the wrong tenant fails on the
   * second call, before a single row exists.
   */
  /**
   * The rail. With a session, ask who we are. With a key, the key is already scoped to one org and
   * the explicit --project-id is the assertion — so the check reads the project back instead.
   */
  /**
   * ═══ THE RAIL FELL BACK TO THE ANSWER IT WAS CHECKING, SO IT CHECKED NOTHING ═══
   *
   * This line used to end `.catch(() => ({})).org_id ?? WANT_ORG`. Read it as a guard and it is
   * vacuous: whenever the lookup failed, `org` became `WANT_ORG`, the comparison below compared
   * `WANT_ORG` to itself, and a script whose own header says it "writes invented invoices and
   * clients" waved itself through.
   *
   * It is not theoretical. Seeding the demo through `ecs run-task`, the container override set
   * `MYCEL_API_KEY` as a plain environment variable — but the kernel's task definition already
   * defines `MYCEL_API_KEY` as a SECRET, and the secret wins. The seeder therefore authenticated as
   * the KERNEL's own bootstrap key, which is scoped to the system `default` project in a different
   * org. `GET projects/<demo project>` 404'd for that key, the catch swallowed it, the fallback
   * supplied the expected answer, and the rail printed "seeding org e349fa95…" while writing 46
   * records into somebody else's project.
   *
   * The failure mode is the one this file exists to prevent, and the guard against it produced a
   * reassuring line of output instead. So: no fallback. An unreadable project is a REFUSAL, because
   * "I could not determine whose data this is" and "it is yours" are not the same sentence.
   */
  /**
   * `GET /v1/projects`, NOT `GET /v1/projects/<id>` — the latter has never existed.
   *
   * That is the other half of why this rail never fired. It asked a route the server does not
   * define, got Hono's bare 404 every single time, and the fallback turned that into "the org is
   * whatever you told me it was". A check that always takes its error path is not a check that
   * rarely works; it is a check that has never once worked.
   *
   * The list route is a BETTER question anyway. With a key the kernel answers with exactly that
   * key's own project and nothing else, so finding `--project-id` in the response proves the key is
   * scoped where the caller claims, and its `org_id` is then the org the writes will really land
   * in — read from the server rather than assumed from the flag.
   */
  const org = API_KEY
    ? await (async () => {
        const mine = await call<{ id: string; org_id?: string }[]>("projects", undefined, "GET").catch((e) => {
          console.error(`\n  ✗ could not list projects with this key: ${(e as Error).message}\n`);
          exit(1);
        });
        const hit = (mine as { id: string; org_id?: string }[]).find((p) => p.id === PROJECT);
        if (!hit) {
          console.error(
            `\n  ✗ this key does not carry project ${PROJECT}.\n` +
              `    It carries: ${(mine as { id: string }[]).map((p) => p.id).join(", ") || "(nothing)"}\n\n` +
              `    Refusing, rather than assuming the key is where you said it is.\n` +
              `    Under ECS, note that MYCEL_API_KEY is ALREADY a secret on the kernel task\n` +
              `    definition and shadows a plain environment override. Use MYCEL_SEED_API_KEY.\n`,
          );
          exit(1);
        }
        return hit.org_id ?? "";
      })()
    : (await call<{ org_id?: string }>("me", undefined, "GET")).org_id ?? "";
  if (org !== WANT_ORG) {
    console.error(
      `\n  ✗ refusing to seed.\n` +
        `    --org-id said        "${WANT_ORG}"\n` +
        `    the credential is in "${org}"\n\n` +
        `  This script writes invented invoices and clients. It only ever writes to the org you name,\n` +
        `  because the alternative is writing them into somebody's real books.\n`,
    );
    exit(1);
  }
  console.log(`seeding org ${org} at ${BASE}\n`);

  const ids: Record<string, string> = {};

  /**
   * Resolve first, create second. Matched on HANDLE rather than display name: the handle is the
   * field `POST /v1/clients` treats as the address, names get edited, and a fuzzy name match on a
   * script that writes invoices is not a trade worth making.
   */
  const roster = needsRoster()
    ? await call<{ id: string; handles?: string[] }[]>("clients", undefined, "GET").catch(() => [])
    : [];
  const byHandle = new Map<string, string>();
  for (const row of roster) for (const h of row.handles ?? []) byHandle.set(h.trim().toLowerCase(), row.id);

  let made = 0;
  let reused = 0;
  for (const c of needsRoster() ? CLIENTS : []) {
    const found = byHandle.get(c.handle.toLowerCase());
    if (found) {
      ids[c.key] = found;
      reused++;
      continue;
    }
    // `fill` attaches to what is there and never invents a client. A tenant missing half its roster
    // is a different problem from a tenant missing its invoices, and quietly fixing both here is
    // how a "safe to repeat" script grows a way to surprise someone.
    if (!doing("book")) continue;
    const row = await call<{ id: string }>("clients", {
      display_name: c.name,
      handles: [c.handle],
      metadata: { note: c.note, domain: c.domain, logo_url: `https://logo.clearbit.com/${c.domain}` },
    }).catch(() => null);
    if (row?.id) {
      ids[c.key] = row.id;
      made++;
    }
  }
  if (needsRoster()) console.log(`  clients   ${Object.keys(ids).length}/${CLIENTS.length} (${made} new, ${reused} existing)`);

  /**
   * What is already invoiced, so a re-run adds nothing twice. Keyed on client + line description,
   * which is what makes these rows distinguishable — the amounts and due dates repeat across months
   * by design ("retainer — March", "retainer — February"), so neither alone identifies an invoice.
   */
  const already = new Set<string>();
  if (needsRoster()) {
    const existing = await call<{ client_id?: string; lines?: { description?: string }[] }[]>(
      "invoices",
      undefined,
      "GET",
    ).catch(() => []);
    for (const iv of existing) {
      for (const l of iv.lines ?? []) already.add(`${iv.client_id}|${l.description}`);
    }
  }

  let invoiced = 0;
  let skipped = 0;
  for (const inv of needsRoster() ? INVOICES : []) {
    const cid = ids[inv.client];
    if (!cid) continue;
    if (already.has(`${cid}|${inv.desc}`)) {
      skipped++;
      continue;
    }
    const row = await call<{ id: string }>("invoices", {
      client_id: cid,
      currency: "USD",
      due_date: day(inv.due),
      lines: [{ description: inv.desc, kind: "fixed", quantity_milli: 1000, unit_amount: usd(inv.dollars) }],
    }).catch(() => null);
    if (!row?.id) continue;
    await call(`invoices/${row.id}/status`, { to: "sent" }).catch(() => {});
    if (inv.pay !== undefined) {
      await call(`invoices/${row.id}/payments`, { amount_minor: usd(inv.pay) }).catch(() => {});
    }
    invoiced++;
  }
  if (needsRoster()) console.log(`  invoices  ${invoiced}/${INVOICES.length} (${skipped} already there)`);

  // NOT on `fill`: `POST /v1/cases` has no key, so a repeat would stack duplicate work items on a
  // tenant somebody is looking at. Invoices above can be deduped by line; these cannot.
  let cased = 0;
  for (const k of doing("book") ? CASES : []) {
    const cid = ids[k.client];
    if (!cid) continue;
    const row = await call<{ id: string }>("cases", {
      wedge: "books-keeper",
      title: k.title,
      client_id: cid,
      stage: k.stage,
      due_at: iso(k.due),
    }).catch(() => null);
    if (row?.id) cased++;
  }
  if (doing("book")) console.log(`  cases     ${cased}/${CASES.length}`);

  // Same reason as cases: creates, cannot be keyed, so `fill` leaves them alone.
  let asked = 0;
  for (const r of doing("book") ? REQUESTS : []) {
    const cid = ids[r.client];
    if (!cid) continue;
    const row = await call<{ id: string }>("requests", { client_id: cid, kind: r.kind, ask: r.ask }).catch(() => null);
    if (row?.id) asked++;
  }
  if (doing("book")) console.log(`  requests  ${asked}/${REQUESTS.length}`);

  /**
   * Answers, only where there is not one already.
   *
   * `GET /v1/wedges/:wedge/intake` is the authority on what is asked and what is covered, so this
   * reads it rather than assuming the manifest — a question that has been answered by a real run,
   * or renamed since this list was written, must not be overwritten or silently missed. An id in
   * KNOWLEDGE that the wedge no longer declares is REPORTED, because the failure worth catching is
   * a renamed question that quietly goes unanswered forever.
   */
  let taught = 0;
  let known = 0;
  if (needsRoster()) {
    type Cov = { questions?: { id: string; answered?: boolean }[] };
    const cov = await call<Cov>(
      `wedges/${encodeURIComponent(KNOWLEDGE_WEDGE)}/intake`,
      undefined,
      "GET",
    ).catch(() => null);
    if (!cov?.questions) {
      console.log(`  knowledge could not read ${KNOWLEDGE_WEDGE} intake — skipped`);
    } else {
      const declared = new Map(cov.questions.map((q) => [q.id, q.answered === true]));
      const orphans = KNOWLEDGE.filter((k) => !declared.has(k.id)).map((k) => k.id);
      for (const k of KNOWLEDGE) {
        const state = declared.get(k.id);
        if (state === undefined) continue;
        if (state) {
          known++;
          continue;
        }
        const ok = await call(`wedges/${encodeURIComponent(KNOWLEDGE_WEDGE)}/intake/${encodeURIComponent(k.id)}`, {
          answer: k.answer,
          during_onboarding: true,
        })
          .then(() => true)
          .catch(note);
        if (ok) taught++;
      }
      console.log(`  knowledge ${taught}/${KNOWLEDGE.length} answered (${known} already)`);
      if (orphans.length) {
        console.log(`    ! ${orphans.join(", ")} — no longer declared by ${KNOWLEDGE_WEDGE}, not written`);
      }
    }

    /**
     * The memory tree, so `/files` has a brain to explore.
     *
     * `PUT /v1/memory` is idempotent on the path — re-running the seeder rewrites the same five
     * notes rather than accumulating copies, which matters because this script is run repeatedly
     * against the showroom.
     *
     * Failures are per-note and counted rather than fatal. A demo with four of five notes is still
     * a demo; a seeder that aborts halfway leaves the tenant in a state nobody chose.
     */
    let remembered = 0;
    for (const note of MEMORY) {
      const ok = await call("memory", { path: note.path, body: note.body }, "PUT")
        .then(() => true)
        .catch(note_ => { console.log(`    ! memory ${note.path}: ${String(note_).slice(0, 120)}`); return false; });
      if (ok) remembered++;
    }
    console.log(`  memory ${remembered}/${MEMORY.length} notes written`);
  }

  let cos = 0;
  for (const co of doing("gtm") ? GTM_COMPANIES : []) {
    const ok = await call("records", {
      wedge: "gtm-operator",
      collection: "companies",
      key: co.domain,
      data: { ...co, logo_url: `https://logo.clearbit.com/${co.domain}`, source: "demo-seed" },
    }).then(() => true).catch(note);
    if (ok) cos++;
  }
  if (doing("gtm")) console.log(`  companies ${cos}/${GTM_COMPANIES.length}`);

  let ppl = 0;
  for (const [i, p] of (doing("gtm") ? GTM_PEOPLE : []).entries()) {
    const co = GTM_COMPANIES.find((c) => c.domain === p.company);
    const ok = await call("records", {
      wedge: "gtm-operator",
      collection: "people",
      // Keyed on the slug, which is also the /gtm/<campaign>/<who> URL segment — one identifier in
      // three places, so a mismatch is impossible rather than unlikely.
      key: p.slug,
      data: {
        name: p.name,
        title: p.title,
        headline: p.headline,
        location: p.location,
        company_key: p.company,
        company_name: co?.name,
        company_domain: p.company,
        company_logo: `https://logo.clearbit.com/${p.company}`,
        stage: p.stage,
        photo_url: `https://i.pravatar.cc/160?u=${p.slug}`,
        /**
         * Contact detail, because the empty slots are what made these read as a broken import.
         *
         * The address is derived from the name and the company domain — first.last@domain — which is
         * both the commonest real pattern and, more usefully, obviously synthetic to anyone who looks
         * twice. Nobody is going to email these.
         *
         * `email_status` is spread rather than set to "verified" everywhere. Enrichment does not come
         * back clean every time, and a column of forty identical green ticks is the tell that the
         * data was typed rather than gathered. A founder who has used one of these tools knows what
         * the real mix looks like.
         */
        email: `${p.slug.replace(/-/g, ".")}@${p.company}`,
        email_status: EMAIL_STATUS[i % EMAIL_STATUS.length],
        linkedin_url: `https://www.linkedin.com/in/${p.slug}`,
        source: "demo-seed",
      },
    }).then(() => true).catch(note);
    if (ok) ppl++;
  }
  if (doing("gtm")) console.log(`  people    ${ppl}/${GTM_PEOPLE.length}`);

  console.log(`\ndone.`);
}

main().catch((e) => {
  console.error(`\nseed-tenant: ${(e as Error).message}\n`);
  exit(1);
});
