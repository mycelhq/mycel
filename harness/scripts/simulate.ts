/**
 * An artificial society of an agency and its clients, driven end to end through the public API.
 *
 * ═══ WHY THIS EXISTS, AND HOW IT DIFFERS FROM `seed-demo.ts` ═══
 *
 * `seed-demo.ts` builds a FIXTURE: a believable business, frozen at one instant, for a human to look
 * at. It is the right artifact for a demo and the wrong one for a regression test, because nothing
 * in it ever ACTS. The loop this product sells is not a screenshot — it is a client asking for
 * something, the business answering, work going out, the client signing it off — and until now the
 * only way to know that loop still worked end to end was for a person to click through it by hand.
 * That is exactly the kind of verification that is done once, before launch, and then never again.
 *
 * So this drives BOTH SIDES of the relationship through time, repeatably, and fails loudly. It is a
 * test that happens to also be a demo, rather than a demo that we hope is a test.
 *
 * ═══ THE MOST VALUABLE THING IN THIS FILE IS THE `tenancy` BEAT ═══
 *
 * Two cross-tenant leaks have shipped in this repo, and both had the same shape: a read that fell
 * back to "any project this caller can see" instead of naming one. Every other beat here would have
 * passed happily through both of them. The `tenancy` beat holds several credentials at once and
 * asserts, positively, that each one is blind to the others — client A against client B's threads,
 * invoices and deliverables, and a whole second project against the first. Those assertions are the
 * reason to run this script in CI rather than before a launch.
 *
 * ═══ WHAT IT INHERITS FROM THE SEED, DELIBERATELY AND WITHOUT WEAKENING ═══
 *
 * • HTTP ONLY, never the stores. With no `MYCEL_DATABASE_URL` every store is an in-process `Map`, so
 *   a script that imports them drives ITS OWN process and the kernel on the port never sees a byte.
 *   Going through the routes also means every row went through the same validation and tenancy check
 *   a real founder's row does — and a simulation that can construct state the routes would refuse is
 *   a simulation of a product that does not exist.
 *
 * • THE TWO GUARDS, UNCHANGED AND WITH NO `--force`: `assertLoopback` (the host must be loopback) and
 *   `assertMemoryStore` (`GET /v1/meta` must say `store=memory`, checked after sign-in and before the
 *   first write). They live in ./lib/kernel.ts now and they cover every write path in here, including
 *   the portal ones — a portal session is minted from a founder session on this same kernel, so
 *   there is no path to a write that has not already passed both.
 *
 * ═══ WHAT IS HONEST HERE, AND WHAT WOULD NOT BE ═══
 *
 * The seed creates no runs, because `runtime.mock.ts` writes the literal string `[mock]` and seeding
 * a fabricated agent answer onto a screen whose whole claim is that the answer is grounded would be
 * a lie. This script DOES cause runs — a client emailing in and a client replying in the portal both
 * legitimately spawn one — and that is a different thing: the kernel really ran, and whatever the
 * mock runtime wrote is the kernel's own honest output. What this script never does is WRITE an
 * agent's answer itself. It writes facts and presses the buttons a human presses; every derived
 * thing on screen was derived by the kernel.
 *
 * The one beat that cannot be honest without a model is business SHAPING. `--shape` runs the real
 * `business-shaper` wedge; without it the shape is a fixture and the run prints that it was skipped,
 * rather than inventing a shape and calling it the agent's.
 */
import { argv, env, exit } from "node:process";

import {
  Session,
  assertLoopback,
  assertMemoryStore,
  baseUrl,
  clockFrom,
  die,
  money,
  rng,
  usd,
} from "./lib/kernel";

// ── Options ──────────────────────────────────────────────────────────────────────────────────────

const BASE = baseUrl();
const OWNER_EMAIL = env.MYCEL_OWNER_EMAIL ?? "founder@mycel.local";
const OWNER_PASSWORD = env.MYCEL_OWNER_PASSWORD ?? "";

const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};

/**
 * Seedable, and printed in the header.
 *
 * `Math.random` in a simulation is how you get a script that fails once a fortnight and cannot be
 * reproduced from its own failure output. Everything that varies here — which client goes quiet,
 * which of several plausible sentences a client sends — comes off this one generator, so
 * `--seed=1234` replays a failure exactly.
 */
const SEED = Number(flag("seed") ?? 20260810);
const rand = rng(Number.isFinite(SEED) ? SEED : 1);
const { iso, day } = clockFrom();

// ── Beats ────────────────────────────────────────────────────────────────────────────────────────
//
// Ordered, because the story is ordered: you cannot deliver to a client you have not signed, and a
// client cannot accept a deliverable that has not been released. `--only=portal` therefore runs the
// beats `portal` DEPENDS on as well, and says so — a "run just this beat" that silently ran it
// against an empty world would be a debugging tool that lies about which beat is broken.

const BEAT_ORDER = ["onboard", "clients", "money", "agency", "portal", "followup", "tenancy"] as const;
type Beat = (typeof BEAT_ORDER)[number];

/** What each beat cannot run without. Transitive; resolved below. */
const NEEDS: Record<Beat, Beat[]> = {
  onboard: [],
  clients: ["onboard"],
  money: ["clients"],
  agency: ["clients"],
  portal: ["agency", "money"],
  followup: ["portal"],
  tenancy: ["portal"],
};

function selectedBeats(): { run: Set<Beat>; asked: Beat[] } {
  const only = flag("only");
  if (only === undefined || only === "") return { run: new Set(BEAT_ORDER), asked: [...BEAT_ORDER] };
  const asked = only.split(",").map((s) => s.trim()).filter(Boolean) as Beat[];
  for (const b of asked) {
    if (!BEAT_ORDER.includes(b)) die(`unknown beat "${b}" — pick from: ${BEAT_ORDER.join(", ")}`);
  }
  const run = new Set<Beat>();
  const add = (b: Beat) => {
    if (run.has(b)) return;
    for (const n of NEEDS[b]) add(n);
    run.add(b);
  };
  asked.forEach(add);
  return { run, asked };
}

// ── Narrative and assertions ─────────────────────────────────────────────────────────────────────
//
// Two sides, printed with two different marks, because "who did this" is the single most useful
// column when you are reading a failure: `»` is the agency acting, `«` is a client acting. A
// transcript where both sides look alike is one you have to re-derive the story from every time.

let failures = 0;
let checks = 0;

const say = (line: string) => console.log(`    ${line}`);
const agency = (line: string) => say(`»  ${line}`);
const client = (who: string, line: string) => say(`«  ${who}: ${line}`);
const note = (line: string) => say(`   ${line}`);
const skip = (line: string) => say(`~  SKIPPED — ${line}`);

function heading(n: number, title: string): void {
  console.log(`\n  ── ${n}. ${title} ${"─".repeat(Math.max(0, 74 - title.length))}`);
}

/**
 * An assertion that records rather than throws.
 *
 * Deliberately NOT fail-fast. The tenancy beat makes a dozen related claims, and when a scoping
 * regression lands you want to see all of them — "A can read B's invoices AND B's threads" is a
 * different bug from "A can read B's invoices only", and a script that dies on the first one makes
 * you re-run to find out which. The process still exits non-zero; see the end of `main`.
 */
function expect(claim: string, ok: boolean, detail = ""): boolean {
  checks++;
  if (ok) {
    say(`✓  ${claim}`);
  } else {
    failures++;
    say(`✗  ${claim}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

// ── The business ─────────────────────────────────────────────────────────────────────────────────
//
// Invented, like the seed's, and every domain is `.example` — RFC 2606 reserves it precisely so no
// real mailbox is ever named in a fixture. A simulation that ships a real-looking address is one
// copy-paste away from a stranger being chased for money they do not owe.

const BUSINESS_NAME = "Kestrel & Co Bookkeeping";

/** The wedge the whole simulation runs on. Real, on disk, with real declared stages. */
const WEDGE = "books-keeper";

interface SimClient {
  key: string;
  name: string;
  handle: string;
  /** Where this relationship is. The four states a real book of business is always a mix of. */
  relationship: "new" | "mid_project" | "long_standing" | "gone_quiet";
  stage: string;
  note: string;
  /** What they emailed in to start the conversation. A human's words, never an agent's. */
  opener: string;
}

const CLIENTS: SimClient[] = [
  {
    key: "new",
    name: "Kettle Row Coffee",
    handle: "owner@kettlerow.example",
    relationship: "new",
    stage: "open",
    note: "Signed nine days ago. One location, Square only. Nothing has closed yet.",
    opener:
      "Hi — just signed up. I've sent the Square login to your onboarding address. When do you need the bank " +
      "statements by for the first month?",
  },
  {
    key: "mid",
    name: "Farrier & Vine",
    handle: "accounts@farriervine.example",
    relationship: "mid_project",
    stage: "reconciling",
    note: "Wine bar. Card, cash and one delivery platform. October is half reconciled.",
    opener:
      "October's card settlements look short to me against the till. Can you take a look before you close it out?",
  },
  {
    key: "long",
    name: "Halyard Marine Supply",
    handle: "ap@halyard.example",
    relationship: "long_standing",
    stage: "review",
    note: "Four years with us. Files their own sales tax off our prepared return. Pays on the day.",
    opener: "Same as every quarter — send the prepared return when it's ready and I'll file it Friday.",
  },
  {
    key: "quiet",
    name: "Pallas Print Room",
    handle: "hello@pallasprint.example",
    relationship: "gone_quiet",
    stage: "collecting",
    note: "Nothing since August. Two chases unanswered. Still on the monthly fee.",
    opener: "Sorry for the silence — it's been a month. I'll dig the statements out this week, promise.",
  },
];

/** Sentences a client might send, picked deterministically. Never agent output — see the header. */
const CLIENT_REPLIES = [
  "Thanks — that makes sense. Anything else you need from my side before you close it?",
  "Got it. I've attached nothing yet but the statements are coming tonight.",
  "That's clearer than last month, thank you. Go ahead.",
];

interface World {
  founder: Session;
  /** The second tenant, used only by the `tenancy` beat. A whole other business on the same kernel. */
  other?: { session: Session; project: string; clientId: string; invoiceId: string };
  clients: Record<string, { id: string; threadId?: string; portal?: Session; caseId?: string }>;
  channelId?: string;
  invoices: Record<string, string>;
  deliverableIds: Record<string, string>;
  requestIds: Record<string, string>;
}

async function main(): Promise<void> {
  assertLoopback(BASE);
  const { run, asked } = selectedBeats();

  if (!OWNER_PASSWORD) {
    die(
      `MYCEL_OWNER_PASSWORD is not set.\n` +
        `  Boot a kernel with a stable owner login and pass the same values here:\n` +
        `    PORT=4100 MYCEL_RUNTIME=mock MYCEL_API_KEY=mycel_sim_key \\\n` +
        `    MYCEL_OWNER_EMAIL=${OWNER_EMAIL} MYCEL_OWNER_PASSWORD=<pick one> npm run start`,
    );
  }

  const founder = new Session(BASE, "founder");
  const W: World = { founder, clients: {}, invoices: {}, deliverableIds: {}, requestIds: {} };

  console.log(
    `\n  An artificial society: ${BUSINESS_NAME} and ${CLIENTS.length} of its clients\n` +
      `    kernel  ${BASE}\n` +
      `    seed    ${SEED}   (replay this exact run with --seed=${SEED})\n` +
      `    beats   ${[...run].join(", ")}${asked.length < BEAT_ORDER.length ? `   (asked for: ${asked.join(", ")}; the rest are prerequisites)` : ""}`,
  );

  // ── 1. An agency onboards ──────────────────────────────────────────────────────────────────────
  heading(1, "An agency onboards");

  const login = await founder.post<{ token: string; projects: { id: string; name: string }[] }>("auth/login", {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  });
  founder.token = login.token;
  const bootstrap = login.projects[0]?.id ?? die("the owner has no project — the kernel did not bootstrap correctly");
  founder.project = bootstrap;

  // BOTH GUARDS, BEFORE THE FIRST WRITE. `/v1/meta` is authenticated, so this cannot move earlier —
  // checked unauthenticated it only ever produced `store=unknown` from a 401 body, which is a guard
  // that fires on everything and therefore protects nothing.
  await assertMemoryStore(founder);
  agency(`signed in as ${OWNER_EMAIL}; kernel reports an in-memory store, so this is safe to write to`);

  /**
   * Its own project, and the bootstrap `default` kept aside as the SECOND TENANT.
   *
   * Not tidiness. The `tenancy` beat needs a genuinely separate project with its own client and its
   * own invoice, and the bootstrap project is one the kernel guarantees exists — creating a third
   * would be the first thing to hit `limitsFor().projects` on a free plan and would turn the most
   * valuable beat in the file into the one that gets skipped.
   */
  /**
   * `wedges` names BOTH services this business runs, and `invoice-chaser` is not decoration.
   *
   * FOUND BY THIS SCRIPT: `POST /v1/moves/take` refused the top-ranked move with
   * `move.wedge_disabled` — "the invoice-chaser wedge is not enabled for this business" — because
   * the project was created running only the bookkeeping wedge. The ranking correctly PROPOSES a
   * chase (it is derived from the invoice, not from what is enabled) and correctly REFUSES to take
   * one, which is a real product state and exactly the sort of thing a fixture with one wedge in it
   * never surfaces. A business that sends invoices runs the chaser; so it is named here.
   */
  const madeProject = await founder.tryPost<{ project?: { id: string } }>("projects", {
    name: BUSINESS_NAME,
    wedges: [WEDGE, "invoice-chaser"],
  });
  if (!madeProject.body?.project) {
    die(
      `could not create a project for the simulation (${madeProject.status}: ${madeProject.text.slice(0, 200)})\n` +
        `  This run needs TWO projects — one for the agency and one to prove it cannot see the other.\n` +
        `  Restart the kernel (the store is in memory, so that IS the reset) and run again.`,
    );
  }
  founder.project = madeProject.body.project.id;
  agency(`created the business "${BUSINESS_NAME}" (project ${founder.project.slice(0, 8)})`);

  // The console redirects every route to /onboarding until this pref is true — see the guard in
  // cloud/app/(app)/layout.tsx. A world you cannot navigate to is not a simulation of the product.
  await founder.patch("me/prefs", { onboarded: true });

  /**
   * SHAPING. Real only with `--shape`, and a fixture otherwise.
   *
   * `business-shaper` is an agent, and under `MYCEL_RUNTIME=mock` its output is the literal string
   * `[mock]`. Asserting anything about a shape produced that way would be asserting about a
   * placeholder, and — worse — printing it as "the shape the agent drafted" would put fabricated
   * agent output in the transcript, which is the exact line `seed-demo.ts` refuses to cross. So the
   * default path states the shape as a FACT the founder typed, which is what an onboarding answer
   * genuinely is, and says out loud that no model ran.
   */
  if (flag("shape") !== undefined) {
    const t = await founder.post<{ id: string }>("tasks", {
      wedge: "business-shaper",
      task_type: "draft_shape",
      input: { description: `${BUSINESS_NAME} — monthly bookkeeping and sales tax prep for owner-run food and marine retail.` },
    });
    agency(`asked business-shaper to draft the shape (run ${t.id.slice(0, 8)}) — real model output only if this kernel has a provider key`);
  } else {
    skip("business shaping needs a live model; pass --shape to run the business-shaper wedge for real");
  }

  /**
   * What the business has been told. `during_onboarding: true` on every one, which labels them
   * STATED rather than OBSERVED — knowledge.ts is explicit that a rule distilled from a real
   * correction on a real job is worth far more, and that "an unmarked onboarding answer becomes
   * indistinguishable from one earned on a real job". Every rule a script can honestly write is of
   * the weaker kind, so it writes the weaker kind and labels it.
   */
  const taught = [
    { id: "engagement-scope", answer: "Feeds reconciled, receipts chased, P&L and balance sheet by the 7th business day. Sales tax prepared quarterly for the client to file — never filed by us." },
    { id: "pricing", answer: "$400/month up to 250 transactions, then $0.45 each above that. Catch-up months are quoted separately." },
    { id: "escalate", answer: "Anything going to a tax authority. Any unmatched transaction over $2,000. Anything that looks like an owner draw." },
  ];
  for (const t of taught) await founder.post(`wedges/${WEDGE}/intake/${t.id}`, { answer: t.answer, during_onboarding: true });
  agency(`taught ${taught.length} rules, all labelled 'stated' (not 'observed' — no agent has been corrected yet)`);

  await founder.post("schedules", {
    name: "Monthly close",
    wedge: WEDGE,
    task_type: "monthly_close",
    cadence: { kind: "monthly", day: 1, hour: 9, minute: 0 },
    input: {},
  });
  agency("put the monthly close on the clock");

  // ── 2. Several clients, at different stages of a relationship ──────────────────────────────────
  if (run.has("clients")) {
    heading(2, "Several clients, at four different stages of a relationship");

    /**
     * A mailbox, then a channel on it. This is what makes a THREAD possible at all: threads hang off
     * a channel, and `POST /v1/channels/:id/inbound` is the only honest way for a client's first
     * message to exist — the same route a real email webhook posts to. There is no session material
     * on the connection and there must not be; nothing here will ever talk to a mail provider.
     */
    const conn = await founder.post<{ id: string }>("connections", {
      kind: "email",
      name: "Kestrel & Co inbox",
      config: {},
    });
    const channel = await founder.post<{ id: string }>("channels", {
      connection_id: conn.id,
      address: "hello@kestrelbooks.example",
      wedge: WEDGE,
      task_type: "chase_receipts",
    });
    W.channelId = channel.id;
    agency(`opened the shared mailbox hello@kestrelbooks.example (channel ${channel.id.slice(0, 8)})`);

    for (const c of CLIENTS) {
      /**
       * INBOUND FIRST, and the client row is a side effect of it.
       *
       * `acceptIntake` creates the client if the handle is unknown, so posting the email is both the
       * conversation starting AND the customer being registered — which is how a real one arrives.
       * Creating the client first with `POST /v1/clients` and then emailing in would work, but it
       * would exercise a path no real customer takes, and the point of this script is the real path.
       */
      const inbound = await founder.post<{ client_id: string; thread_id?: string; task_id: string }>(
        `channels/${channel.id}/inbound`,
        {
          from: { handle: c.handle, name: c.name },
          subject: `${c.name} — October`,
          body: c.opener,
        },
      );
      // `client_id` from intake is the handle when no row was made; re-read so we always hold an id.
      const found = (await founder.get<{ id: string; display_name: string; handles: string[] }[]>("clients")).find(
        (row) => row.handles?.includes(c.handle),
      );
      const id = found?.id ?? inbound.client_id;
      W.clients[c.key] = { id, threadId: inbound.thread_id };
      client(c.name, `emailed in — "${c.opener.slice(0, 68)}…"`);
      note(`     → kernel opened thread ${inbound.thread_id?.slice(0, 8) ?? "—"} and queued run ${inbound.task_id.slice(0, 8)}`);

      const kase = await founder.post<{ id: string }>("cases", {
        wedge: WEDGE,
        title: `${c.name} — October close`,
        client_id: id,
        stage: c.stage,
        due_at: iso(c.relationship === "gone_quiet" ? -6 : 4),
      });
      W.clients[c.key]!.caseId = kase.id;
      agency(`opened an engagement for ${c.name} at stage "${c.stage}" (${c.relationship.replace("_", " ")})`);
    }
  }

  // ── 3. Invoices at five different ages ─────────────────────────────────────────────────────────
  if (run.has("money")) {
    heading(3, "Money, at five different ages");

    /**
     * `POST /v1/invoices` always creates a DRAFT — deliberately: an invoice that arrives already
     * `sent` has no issue date, so nobody can say when the clock started. Every one below is
     * therefore issued by a second call, and the draft is the one that is not.
     *
     * Every amount is integer minor units. NOTHING here divides by 100; `usd()` multiplies.
     */
    const invoice = async (args: {
      key: string;
      client: string;
      description: string;
      dollars: number;
      dueInDays: number;
      issue?: boolean;
      payDollars?: number;
    }) => {
      const inv = await founder.post<{ id: string }>("invoices", {
        client_id: W.clients[args.client]!.id,
        currency: "USD",
        due_date: day(args.dueInDays),
        lines: [{ description: args.description, kind: "fixed", quantity_milli: 1000, unit_amount: usd(args.dollars) }],
      });
      if (args.issue !== false) await founder.post(`invoices/${inv.id}/status`, { to: "sent" });
      if (args.payDollars !== undefined) await founder.post(`invoices/${inv.id}/payments`, { amount_minor: usd(args.payDollars) });
      W.invoices[args.key] = inv.id;
      const age =
        args.issue === false
          ? "draft, never sent"
          : args.payDollars !== undefined
            ? "paid in full"
            : args.dueInDays >= 0
              ? `issued, due in ${args.dueInDays}d`
              : `${-args.dueInDays}d overdue`;
      agency(`invoiced ${CLIENTS.find((c) => c.key === args.client)?.name} ${money(usd(args.dollars))} — ${age}`);
      return inv.id;
    };

    await invoice({ key: "badly_overdue", client: "quiet", description: "Bookkeeping — August and September", dollars: 800, dueInDays: -47 });
    await invoice({ key: "overdue", client: "mid", description: "Bookkeeping — September", dollars: 400, dueInDays: -9 });
    await invoice({ key: "not_yet_due", client: "long", description: "Bookkeeping + sales tax prep — Q3", dollars: 1_150, dueInDays: 12 });
    await invoice({ key: "paid", client: "long", description: "Bookkeeping — September", dollars: 400, dueInDays: -2, payDollars: 400 });
    await invoice({ key: "draft", client: "new", description: "Onboarding + first month", dollars: 650, dueInDays: 21, issue: false });

    // The whole reason the spread matters: `GET /v1/moves` is DERIVED, and with one invoice in one
    // state the ranking has nothing to rank and looks like vapour.
    const moves = await founder.get<{ moves: { kind: string }[] }>("moves");
    expect("the ranked move list is derived from those facts, not empty", (moves.moves?.length ?? 0) > 0, `${moves.moves?.length ?? 0} moves`);
  }

  // ── 4. The agency does the work ────────────────────────────────────────────────────────────────
  if (run.has("agency")) {
    heading(4, "The agency does the work");

    /** Two open asks. This is the half of the model a service-business owner recognises instantly:
     *  the month is not late because the work is hard, it is late because a customer has not sent a
     *  bank statement. */
    const ask1 = await founder.post<{ id: string }>("requests", {
      client_id: W.clients.mid!.id,
      case_id: W.clients.mid!.caseId,
      thread_id: W.clients.mid!.threadId,
      kind: "answer",
      ask: "The three card settlements on 12–14 Oct are $211.40 short against the till — was any of that a cash float top-up?",
    });
    W.requestIds.mid = ask1.id;
    agency(`asked ${CLIENTS[1]!.name} about a $211.40 discrepancy (request ${ask1.id.slice(0, 8)})`);

    const ask2 = await founder.post<{ id: string }>("requests", {
      client_id: W.clients.quiet!.id,
      case_id: W.clients.quiet!.caseId,
      kind: "document",
      ask: "August and September bank statements — PDF or CSV, either is fine.",
    });
    W.requestIds.quiet = ask2.id;
    agency(`asked ${CLIENTS[3]!.name} for two months of statements (they have gone quiet — request ${ask2.id.slice(0, 8)})`);

    /**
     * The engagement parked on that answer.
     *
     * `request_resolved` and not a date, because the thing being waited on is a fact about the world
     * rather than the passage of time — the whole reason waits are a first-class object. Soft: the
     * kernel allows one live wait per case, and a refusal here is a real state, not a script bug.
     */
    const wait = await founder.tryPost(`cases/${W.clients.quiet!.caseId}/wait`, {
      reason: "the August–September catch-up cannot start until the statements arrive",
      condition: { kind: "request_resolved", request_id: ask2.id, label: "Pallas Print Room's statements" },
      resume: { task_type: "monthly_close", input: { period: "2026-09" } },
      nudge_at: iso(2),
      max_nudges: 2,
      expires_at: iso(21),
    });
    agency(wait.ok ? "parked that engagement on their answer rather than chasing it by hand" : `did not park the engagement — ${wait.text.slice(0, 90)}`);

    /**
     * WORK DELIVERED, and released.
     *
     * `kind: "link"` because a `document` deliverable is validated to carry exactly one artifact, and
     * the honest way to get an artifact here is a real run producing one — which under the mock
     * runtime it would not. A link is a whole, valid, real deliverable with nothing invented in it.
     */
    const d = await founder.post<{ deliverable: { id: string; status: string } }>("deliverables", {
      case_id: W.clients.long!.caseId,
      kind: "link",
      title: "Halyard Marine — Q3 sales tax return, prepared",
      summary: "Prepared return for the quarter to 30 Sep. Check the marine-parts exemption on line 4 before you file.",
      url: "https://files.kestrelbooks.example/halyard/q3-return",
    });
    W.deliverableIds.long = d.deliverable.id;
    expect("a submitted deliverable lands in review, not with the client", d.deliverable.status === "in_review", d.deliverable.status);

    // Invisible to the client until this. `DELIVERABLE_STATES.in_review.client_sees` is null on
    // purpose — a customer must not learn work exists before the founder has released any of it.
    const released = await founder.post<{ parked: string }>(`deliverables/${d.deliverable.id}/release`, {});
    agency(`released "Halyard Marine — Q3 sales tax return" to the client — ${released.parked}`);

    /**
     * An approval, if the kernel raised one.
     *
     * NOT a failure when there is none. Approvals are raised by a running agent hitting a policy
     * gate, and under `MYCEL_RUNTIME=mock` whether that happens depends on the wedge's envelope
     * rather than on anything this script controls. Asserting that one exists would make the beat
     * fail for a reason that has nothing to do with the loop being tested; asserting that we can
     * resolve one WHEN it exists is the real claim.
     */
    const pending = await founder.get<{ approvals?: { approval_id: string; action: string }[] } | { approval_id: string; action: string }[]>(
      "approvals?status=pending",
    );
    const list = Array.isArray(pending) ? pending : (pending.approvals ?? []);
    if (list.length) {
      const a = list[0]!;
      const done = await founder.tryPost(`approvals/${a.approval_id}/approve`, {});
      expect(`the founder can resolve a pending approval (${a.action})`, done.ok, `${done.status} ${done.text.slice(0, 120)}`);
    } else {
      skip("no approval was pending — nothing in this run hit a policy gate, which is a real state and not a fault");
    }

    /** A move taken and its outcome reported — the half that makes the ranking learn. */
    const moves = await founder.get<{ moves: { id: string; kind: string; entity_id?: string }[] }>("moves");
    const move = moves.moves?.[0];
    if (move) {
      const taken = await founder.tryPost(`moves/take`, { move_id: move.id });
      expect(`the top-ranked move ("${move.kind}") can be taken`, taken.ok, `${taken.status} ${taken.text.slice(0, 120)}`);
      const outcome = await founder.tryPost("moves/outcome", {
        move_id: move.id,
        kind: move.kind,
        entity_id: move.entity_id ?? "",
        result: "replied",
        note: "simulated: the client answered",
      });
      expect("its outcome can be reported back, so the ranking learns", outcome.ok, `${outcome.status} ${outcome.text.slice(0, 120)}`);
    } else {
      skip("the ranking proposed no moves, so there was none to take");
    }
  }

  // ── 5. A client actually uses the portal ───────────────────────────────────────────────────────
  if (run.has("portal")) {
    heading(5, "A client actually uses the portal");

    for (const c of CLIENTS) {
      const row = W.clients[c.key]!;
      /**
       * Mint, then exchange. The link is returned ONCE — only its hash is stored — and it is
       * single-use outside a short grace window, which is why this holds onto the session token
       * rather than re-exchanging later.
       */
      const link = await founder.post<{ token: string }>(`clients/${row.id}/portal-link`, {});
      const sess = await founder.post<{ token: string; client?: { display_name: string } }>("portal/session", {
        token: link.token,
      });
      /**
       * NO PROJECT HEADER, and that is the point of the plane.
       *
       * A client session IS its own project scope; the kernel takes the tenant from the session and
       * would be right to ignore anything the caller sent. Leaving `project` empty here means the
       * assertions in the `tenancy` beat cannot accidentally be passing because a header happened to
       * be correct.
       */
      row.portal = new Session(BASE, `portal:${c.name}`, sess.token);
      client(c.name, `opened their portal link (session for "${sess.client?.display_name ?? "?"}")`);
    }

    const mid = W.clients.mid!;
    const midName = CLIENTS[1]!.name;

    // ── What they can see ──
    const me = await mid.portal!.get<{ display_name: string }>("portal/me");
    const threads = await mid.portal!.get<{ id: string }[]>("portal/threads");
    const invoices = await mid.portal!.get<{ id: string; totals?: { amount_due?: number } }[]>("portal/invoices");
    const cases = await mid.portal!.get<{ id: string; stage: string }[]>("portal/cases");
    const dels = await mid.portal!.get<{ deliverables: unknown[] }>("portal/deliverables");
    client(midName, `sees ${threads.length} conversation(s), ${invoices.length} invoice(s), ${cases.length} engagement(s), ${dels.deliverables.length} deliverable(s)`);
    expect("the portal renders the client from their own session", me.display_name === midName, me.display_name);
    expect("a draft invoice is never shown to a client", !invoices.some((i) => i.id === W.invoices.draft));

    // ── They reply on a thread ──
    if (mid.threadId) {
      const reply = CLIENT_REPLIES[Math.floor(rand() * CLIENT_REPLIES.length)]!;
      const posted = await mid.portal!.post<{ id: string; task_id?: string }>(`portal/threads/${mid.threadId}/messages`, {
        body: reply,
      });
      client(midName, `replied on the thread — "${reply.slice(0, 60)}…"`);
      expect("a client's reply spawns real work rather than just sitting there", !!posted.task_id, "no task_id came back");
    }

    // ── They answer what the business was blocked on ──
    const open = await mid.portal!.get<{ id: string; ask: string; status: string }[]>("portal/requests?status=open");
    const ask = open.find((r) => r.id === W.requestIds.mid);
    if (ask) {
      const answered = await mid.portal!.post<{ ok?: boolean }>(`portal/requests/${ask.id}/respond`, {
        response: "Yes — $200 of that was a float top-up on the 13th, the rest is a refund I processed by hand.",
      });
      client(midName, "answered the open question, which unblocks the close");
      expect("answering a request closes it and releases the work", !!answered, "");
      const after = await mid.portal!.get<{ id: string; status: string }[]>("portal/requests");
      expect("the answered request is no longer open", after.find((r) => r.id === ask.id)?.status !== "open");
    } else {
      skip(`the open request did not reach ${midName}'s portal (agency beat may not have run)`);
    }

    // ── They ask for NEW work ──
    //
    // The one beat that may not exist yet. Another agent is adding a client-side "start a thread"
    // route under /v1/portal/*; if it is not there, this must SKIP with a sentence rather than fail,
    // because a red run for a route nobody has landed teaches nothing. Probed by calling it: hono
    // answers an unmounted path with a 404 that carries no JSON error body of ours.
    const askForWork = {
      subject: "New: payroll for two part-timers",
      body: "Separate from the monthly close — we're taking on two part-time staff in January. Is payroll something you do?",
    };
    const newThread = await mid.portal!.attempt<{ id?: string; thread?: { id: string } }>("portal/threads", {
      method: "POST",
      body: JSON.stringify(askForWork),
    });
    if (newThread.status === 404 && !newThread.body) {
      skip(
        "asking for new work: POST /v1/portal/threads is not mounted on this kernel yet.\n" +
          "                 The client-side 'start a thread' route is being added separately; this beat will\n" +
          "                 light up on its own once it lands. Nothing else in this run depends on it.",
      );
      // The fallback that keeps the STORY intact without pretending the route exists: the ask still
      // reaches the business, on the conversation they already have.
      if (mid.threadId) {
        await mid.portal!.post(`portal/threads/${mid.threadId}/messages`, { body: askForWork.body });
        client(midName, `asked for new work on their existing thread instead — "${askForWork.body.slice(0, 58)}…"`);
      }
    } else if (newThread.ok) {
      const id = newThread.body?.id ?? newThread.body?.thread?.id;
      client(midName, `started a new conversation asking for work — "${askForWork.subject}"`);
      expect("asking for new work creates a conversation the business can see", !!id, JSON.stringify(newThread.body).slice(0, 160));
    } else {
      expect("asking for new work is accepted", false, `${newThread.status} ${newThread.text.slice(0, 160)}`);
    }

    // ── Someone signs work off ──
    const long = W.clients.long!;
    const longName = CLIENTS[2]!.name;
    const theirs = await long.portal!.get<{ deliverables: { id: string; title: string; state: string; can_act: boolean }[] }>("portal/deliverables");
    const waiting = theirs.deliverables.find((x) => x.id === W.deliverableIds.long);
    if (waiting) {
      /**
       * `can_act`, NOT a status string — and the difference is the point of the plane.
       *
       * The portal projection deliberately carries no raw status: `toPortalDeliverable` maps it to a
       * client sentence, because `in_review` and `drafting` have no honest client-facing meaning.
       * The first draft of this assertion checked `status === "with_client"` and failed against a
       * perfectly correct kernel — it was asserting an operator-plane field from the client plane.
       * `can_act` is the field the portal actually renders its buttons off, so it is the one worth
       * asserting: it is true exactly when this client may accept or ask for changes right now.
       */
      expect("a released deliverable reaches the right client's portal, actionable", waiting.can_act === true, `state="${waiting.state}" can_act=${waiting.can_act}`);
      const verdict = await long.portal!.post<{ ok: boolean }>(`portal/deliverables/${waiting.id}/accept`, {
        note: "Looks right. Filing it Friday.",
      });
      client(longName, `accepted "${waiting.title}"`);
      expect("acceptance is recorded", verdict.ok === true);
      // Idempotent by design — a portal on a flaky train connection retries constantly.
      const again = await long.portal!.tryPost<{ already?: boolean }>(`portal/deliverables/${waiting.id}/accept`, { note: "" });
      expect("accepting twice is not an error (a retried request that already succeeded)", again.ok, `${again.status}`);
    } else {
      skip("no deliverable was with this client to sign off");
    }

    // ── And someone asks for changes ──
    const d2 = await founder.post<{ deliverable: { id: string } }>("deliverables", {
      case_id: W.clients.mid!.caseId,
      kind: "link",
      title: "Farrier & Vine — October management accounts",
      summary: "Draft P&L and balance sheet for October, with the card discrepancy still flagged.",
      url: "https://files.kestrelbooks.example/farriervine/oct-accounts",
    });
    await founder.post(`deliverables/${d2.deliverable.id}/release`, {});
    agency("released October's management accounts to Farrier & Vine");
    const changes = await mid.portal!.tryPost<{ ok: boolean }>(`portal/deliverables/${d2.deliverable.id}/request-changes`, {
      note: "The delivery-platform commission is in the wrong month — can you move it to October?",
    });
    client(midName, "asked for changes instead of accepting");
    expect("a change request is accepted and carries the client's words", changes.ok, `${changes.status} ${changes.text.slice(0, 120)}`);
    W.deliverableIds.mid = d2.deliverable.id;

    // A change request with no words is refused — the note IS the message, and a silent rejection
    // tells the business nothing it can act on.
    const empty = await long.portal!.tryPost(`portal/deliverables/${W.deliverableIds.long ?? "x"}/request-changes`, { note: "" });
    expect("a change request with nothing said is refused", !empty.ok, `${empty.status}`);
  }

  // ── 6. The agency responds ─────────────────────────────────────────────────────────────────────
  if (run.has("followup")) {
    heading(6, "The agency responds");

    const mid = W.clients.mid!;
    const thread = await founder.get<{ messages: { direction: string; body: string }[] }>(`threads/${mid.threadId}`);
    const inbound = thread.messages.filter((m) => m.direction === "inbound").length;
    agency(`read ${CLIENTS[1]!.name}'s thread — ${thread.messages.length} messages, ${inbound} from the client`);
    expect("what the client said in the portal is on the founder's copy of the thread", inbound >= 2, `${inbound} inbound`);

    if (W.deliverableIds.mid) {
      const redo = await founder.tryPost(`deliverables/${W.deliverableIds.mid}/versions`, {
        summary: "v2 — delivery-platform commission moved to October, as asked.",
        url: "https://files.kestrelbooks.example/farriervine/oct-accounts-v2",
      });
      expect("a change request can be answered with a new version", redo.ok, `${redo.status} ${redo.text.slice(0, 140)}`);
      const rereleased = await founder.tryPost(`deliverables/${W.deliverableIds.mid}/release`, {});
      expect("and re-released to the client", rereleased.ok, `${rereleased.status} ${rereleased.text.slice(0, 140)}`);
      agency("redid October's accounts and sent them back");
    }

    // The engagement moves through the route, so the stage is validated against the wedge manifest
    // rather than written raw.
    const advanced = await founder.put<{ stage?: string }>(`cases/${mid.caseId}`, { stage: "review" });
    expect("the engagement can be advanced to a stage the wedge declares", advanced.stage === "review", String(advanced.stage));
    agency(`moved ${CLIENTS[1]!.name}'s close to "review"`);

    const nextMoves = await founder.get<{ moves: { kind: string }[] }>("moves");
    note(`     → the ranking now proposes ${nextMoves.moves?.length ?? 0} moves`);
  }

  // ── 7. Cross-tenant safety, as an assertion ────────────────────────────────────────────────────
  if (run.has("tenancy")) {
    heading(7, "Cross-tenant safety — the part that must never regress");

    /**
     * A WHOLE SECOND BUSINESS, on the bootstrap project the agency deliberately did not use.
     *
     * Same owner, same kernel, different project. That is the harder case and the one both shipped
     * leaks were: a caller who is legitimately allowed to see SOMETHING, reading a route that
     * resolved "which tenant" from the set of projects they can see rather than from the one they
     * named. A test with two unrelated logins would not have caught either.
     */
    const other = new Session(BASE, "founder@other-project", founder.token, bootstrap);
    const otherClient = await other.post<{ id: string }>("clients", {
      display_name: "Ninth Street Framing",
      handles: ["books@ninthstreet.example"],
      metadata: { note: "belongs to a DIFFERENT project — nothing in the agency's world may see this" },
    });
    const otherInvoice = await other.post<{ id: string }>("invoices", {
      client_id: otherClient.id,
      currency: "USD",
      due_date: day(-5),
      lines: [{ description: "Bookkeeping — October", kind: "fixed", quantity_milli: 1000, unit_amount: usd(975) }],
    });
    await other.post(`invoices/${otherInvoice.id}/status`, { to: "sent" });
    W.other = { session: other, project: bootstrap, clientId: otherClient.id, invoiceId: otherInvoice.id };
    note(`a second business exists on this kernel: project ${bootstrap.slice(0, 8)}, one client, one overdue invoice`);

    // ── Project against project ──
    const agencyClients = await founder.get<{ id: string }[]>("clients");
    expect(
      "the agency's client list contains no client from the other project",
      !agencyClients.some((c) => c.id === otherClient.id),
      `${agencyClients.length} clients returned`,
    );
    const agencyMoves = await founder.get<{ moves: { entity_id?: string }[] }>("moves");
    expect(
      "the agency's ranked moves never reference the other project's overdue invoice",
      !(agencyMoves.moves ?? []).some((m) => m.entity_id === otherInvoice.id),
    );
    const otherClients = await other.get<{ id: string }[]>("clients");
    expect(
      "and the other project's client list contains none of the agency's clients",
      !otherClients.some((c) => Object.values(W.clients).some((x) => x.id === c.id)),
      `${otherClients.length} clients returned`,
    );
    const crossInvoice = await founder.attempt(`invoices/${otherInvoice.id}`);
    expect("the agency cannot read the other project's invoice by id", !crossInvoice.ok, `got ${crossInvoice.status}`);

    // ── Client against client ──
    const a = W.clients.mid!;
    const b = W.clients.long!;
    const aName = CLIENTS[1]!.name;
    const bName = CLIENTS[2]!.name;
    if (!a.portal || !b.portal) {
      expect("two portal sessions exist to compare", false, "the portal beat did not mint them");
    } else {
      const t = await a.portal.attempt(`portal/threads/${b.threadId}`);
      expect(`${aName} cannot read ${bName}'s thread`, t.status === 404, `got ${t.status}`);

      const i = await a.portal.attempt(`portal/invoices/${W.invoices.not_yet_due}`);
      expect(`${aName} cannot read ${bName}'s invoice`, i.status === 404, `got ${i.status}`);

      const dl = await a.portal.attempt(`portal/deliverables/${W.deliverableIds.long}`);
      expect(`${aName} cannot read ${bName}'s deliverable`, dl.status === 404, `got ${dl.status}`);

      const verdictAttempt = await a.portal.tryPost(`portal/deliverables/${W.deliverableIds.long}/accept`, { note: "mine now" });
      expect(`${aName} cannot sign off ${bName}'s work`, !verdictAttempt.ok, `got ${verdictAttempt.status}`);

      const reply = await a.portal.tryPost(`portal/threads/${b.threadId}/messages`, { body: "posting into someone else's conversation" });
      expect(`${aName} cannot post into ${bName}'s conversation`, !reply.ok, `got ${reply.status}`);

      // The list routes, which is where a leak actually shows up in a UI: a per-id 404 with a leaky
      // list is still a leak, and the list is the thing a client's screen renders.
      const aThreads = await a.portal.get<{ id: string }[]>("portal/threads");
      expect(`${aName}'s thread list is only their own`, !aThreads.some((x) => x.id === b.threadId), `${aThreads.length} threads`);
      const aInvoices = await a.portal.get<{ id: string }[]>("portal/invoices");
      expect(
        `${aName}'s invoice list contains none of ${bName}'s invoices`,
        !aInvoices.some((x) => x.id === W.invoices.not_yet_due || x.id === W.invoices.paid),
        `${aInvoices.length} invoices`,
      );
      const aDels = await a.portal.get<{ deliverables: { id: string }[] }>("portal/deliverables");
      expect(
        `${aName}'s deliverable list contains none of ${bName}'s`,
        !aDels.deliverables.some((x) => x.id === W.deliverableIds.long),
        `${aDels.deliverables.length} deliverables`,
      );

      // ── The client plane against the other project ──
      const otherThreads = await a.portal.attempt(`portal/threads/${otherClient.id}`);
      expect("a client session cannot reach into the second project at all", otherThreads.status === 404, `got ${otherThreads.status}`);

      /**
       * AND A CLIENT SESSION MUST IGNORE A PROJECT HEADER.
       *
       * The scope comes from the session and nothing else. If a portal route ever read
       * `x-mycel-project` — which is exactly the sort of "harmless" convenience that gets added when
       * someone shares a middleware — a client could name any tenant on the kernel. This asserts the
       * header changes nothing rather than assuming it.
       */
      const spoofed = new Session(BASE, `${a.portal.label} + forged project header`, a.portal.token, bootstrap);
      const spoofedThreads = await spoofed.get<{ id: string }[]>("portal/threads");
      expect(
        "a forged x-mycel-project header on a client session changes nothing",
        spoofedThreads.length === aThreads.length && spoofedThreads.every((x) => aThreads.some((y) => y.id === x.id)),
        `${spoofedThreads.length} vs ${aThreads.length}`,
      );

      // ── And the two planes must not accept each other's credentials ──
      const clientTokenOnFounderRoute = await new Session(BASE, "client token, founder route", a.portal.token, founder.project).attempt("clients");
      expect("a client session cannot be used on the founder plane", !clientTokenOnFounderRoute.ok, `got ${clientTokenOnFounderRoute.status}`);
      const founderTokenOnPortal = await new Session(BASE, "founder token, portal route", founder.token).attempt("portal/threads");
      expect("a founder session cannot be used on the client plane", !founderTokenOnPortal.ok, `got ${founderTokenOnPortal.status}`);
    }
  }

  // ── The verdict ────────────────────────────────────────────────────────────────────────────────

  const ok = failures === 0;
  console.log(
    `\n  ${ok ? "✓" : "✗"} ${checks - failures}/${checks} checks passed` +
      `${ok ? "" : `  —  ${failures} FAILED`}\n` +
      `    business  ${BUSINESS_NAME}, project ${founder.project}\n` +
      `    replay    npm run sim -- --seed=${SEED}\n` +
      `    one beat  npm run sim -- --only=tenancy    (prerequisite beats run too, and are listed)\n` +
      `    reset     restart the kernel. The store is in memory, so that IS the reset — this script\n` +
      `              is single-shot against a given kernel and will refuse nothing on a second run,\n` +
      `              it will simply build a second, duplicate business.\n` +
      `    console   sign in at http://localhost:3000 as ${OWNER_EMAIL}\n`,
  );
  if (!ok) exit(1);
}

await main();
