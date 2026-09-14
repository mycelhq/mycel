// WHAT A BUSINESS NEEDS — declared as a capability, never as a vendor.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// Two shipped blueprints named a brand in a JSON file and made it a requirement:
//
//   blueprints/books-keeper.json    {"name": "xero",   "kind": "composio"}
//   blueprints/invoice-chaser.json  {"name": "stripe", "kind": "composio"}
//
// So a bookkeeper who runs QuickBooks was shown a setup checklist that said "Connect Xero", with no
// second option and no way to say that is not what I use. A joinery firm paid by bank transfer was
// asked to connect Stripe before its accounts-receivable chaser would go live. Neither founder had
// done anything wrong; the product had simply written one vendor's name down and called it a
// requirement. We broker roughly three thousand apps and then insist on the one somebody typed.
//
// The same file shipped two rows that were worse than wrong, because they looked configured:
//
//   bank-feed    config.api_url = "https://api.example-bank.com"
//   books-email  config.from    = "books@yourdomain.com"
//
// A placeholder in a `config` block is indistinguishable, to every code path downstream, from a real
// setting. `example-bank.com` does not resolve; `books@yourdomain.com` is a real-looking sender that
// a client would have seen on a receipt chase. Both are deleted, and this module is where the need
// they were badly expressing now lives.
//
// ═══ THE VOCABULARY, AND WHY IT LOOKS LIKE roles.ts ═══
//
// This is deliberately the same mechanism as `WEDGE_ROLES`, one axis over: roles.ts stopped the
// kernel naming a wedge DIRECTORY, this stops a blueprint naming a VENDOR. Everything that made that
// one work is copied on purpose rather than reinvented differently —
//
//   · A CLOSED SET, in code. An open string would let a blueprint declare `read_payment` and be
//     silently ignored: the checklist would show one fewer requirement, the business would activate,
//     and nothing would ever read a payment. Silently satisfying a typo is strictly worse than the
//     hardcoded vendor it replaces, because the hardcode at least worked.
//   · DECLARED, NOT INFERRED. "Has a Stripe connection" does not mean "wants payments read" — a
//     founder may connect Stripe for a client's own account (see `ConnectionOwner`). Intent is
//     stated by the blueprint.
//   · ZERO PROVIDERS IS A LEGITIMATE INSTALL. Most service businesses are paid by bank transfer and
//     will never connect a payment provider. `absent` is the sentence that says what stops, and the
//     feature carries on saying it — `paymentConfidence`'s `unverifiable` level is exactly this shape
//     and this module must not contradict it.
//   · CARDINALITY IS PART OF THE CAPABILITY, and here it genuinely varies. See below.
//
// ═══ WHY CARDINALITY IS PER CAPABILITY AND NOT GLOBAL ═══
//
// Asked "two providers claim one capability — pick deterministically, or refuse?", the honest answer
// turned out to be that it depends on whether the capability READS or ACTS, and pretending otherwise
// breaks one of the two:
//
//   READS are `"all"`. A business with Stripe *and* QuickBooks connected takes money through both,
//   and reading only the first — however deterministically — means the invoices settled in the other
//   one keep getting chased. That is the exact bug this whole area exists to stop. So every bound
//   provider is read and the results are unioned; `reconcileProject` already namespaces every
//   external id by connection id, so two providers reporting the same opaque id cannot collide.
//
//   ACTS are `"one"`, and two claimants REFUSE rather than sort-and-take-first. Sending the same
//   dunning email from both Gmail and Outlook is not a merge, it is sending it twice; picking one is
//   picking which address a client sees our business as, silently. roles.ts made this argument for
//   `dunning` and it is the same argument. Refusing names both connections and asks.
//
// ═══ WHAT IS NOT HERE, AND WHY ═══
//
//   · No `linkedin`. It is genuinely ours — a captured member session behind a mandatory proxy, not
//     a Composio app — so there is no second provider to resolve between and nothing to abstract.
//     Wedges keep declaring it by kind, and that stays correct.
//   · SMS / WhatsApp as capabilities: channel kinds were stubbed and removed once already; they
//     return when a real transport exists, not as menu items with no kitchen.
//
// ═══ WHY THE PROVIDER TABLE IS DATA ═══
//
// The mapping from a capability to the toolkits that can serve it is a fact about Composio's
// catalogue, which changes without us. It is therefore a table, overridable from disk by
// `MYCEL_CAPABILITY_PROVIDERS`, and not a `switch`. This matters more than usual right now: the
// default table below was written WITHOUT a live `COMPOSIO_API_KEY`, so the Stripe and Xero tool
// slugs are the ones the shipped blueprints already used and everything else is a considered guess.
// A wrong slug degrades the way a missing one does — `resolveCapability` reports the provider as
// bound but unreadable, loudly — and is corrected by editing a JSON file, not by a release.
import { readFileSync } from "node:fs";
import type { Connection } from "./contract";

/**
 * The capabilities a business can declare a need for.
 *
 * Money/email are here because shipped wedges stop without them. The publish / CRM / calendar / ads
 * set is here because 2026–27 boom desks (GEO, RevOps, booking, marketplace-adjacent reporting)
 * cannot declare a need without inventing a vendor name — the exact failure this module exists to
 * stop. `kernel_parses: false` on the new set is deliberate: the agent/Composio path consumes them
 * until a normaliser earns `true`.
 */
export const CAPABILITIES = {
  /**
   * Know whether money has actually arrived. `invoice-chaser` — the whole of payments.ts.
   *
   * The capability, not the vendor, is the thing the chaser needs: it asks "has this been paid" and
   * a QuickBooks payment answers that question exactly as well as a Stripe one.
   */
  read_payments: {
    title: "See payments as they arrive",
    /** The onboarding question. Offers alternatives; never demands a brand. */
    question: "Which of these do you get paid through?",
    cardinality: "all",
    /** The kernel itself parses this, so a provider with no normaliser is a loud gap. See below. */
    kernel_parses: true,
    kernel_acts: false,
    satisfiable_by_input: true,
    absent:
      "no payment provider is connected to this business, so nothing here can confirm whether an invoice has been paid — a bank transfer or a cash payment would not show up",
  },
  /**
   * Read the invoices a business raises elsewhere. `books-keeper` (the monthly close reconciles
   * against the ledger's invoices) and `invoice-chaser` (an invoice raised in the accounting system
   * rather than here is still an invoice a client owes).
   */
  read_invoices: {
    title: "Read the invoices you've raised",
    question: "Where do you raise your invoices?",
    cardinality: "all",
    kernel_parses: true,
    kernel_acts: false,
    satisfiable_by_input: true,
    absent:
      "no accounting system is connected to this business, so nothing here can see invoices raised outside Mycel",
  },
  /**
   * Pull the bank feed. `books-keeper`'s `daily_sync`, which is what the deleted `bank-feed` row with
   * `api.example-bank.com` in it was trying and failing to express.
   *
   * `kernel_parses: false` and that is not a shortcut. No kernel code reads a bank transaction today
   * — `reconcile.mjs` runs in the wedge sandbox against whatever tools it is handed — so claiming a
   * normalisation seam here would be claiming work that does not exist.
   */
  read_bank_transactions: {
    title: "Pull your bank transactions",
    question: "How should it see your bank?",
    cardinality: "all",
    kernel_parses: false,
    kernel_acts: false,
    satisfiable_by_input: true,
    absent:
      "no bank feed is connected to this business, so the daily sync has nothing to pull and the month cannot be reconciled automatically",
  },
  /**
   * Send email as the business. Both shipped blueprints; it is how a chase and a close report leave.
   *
   * `"one"` — see the cardinality note in the header. Which address a client sees is not a detail
   * this code may decide by sort order.
   */
  send_email: {
    title: "Send email as your business",
    question: "Which mailbox should it send from?",
    cardinality: "one",
    kernel_parses: false,
    // The kernel composes the send itself — see capabilities.act.ts. That is what makes one
    // `send_email` verb mean the same thing on Gmail, Outlook, AgentMail and a raw transactional
    // sender, instead of five wedges each learning a different toolkit's argument names.
    kernel_acts: true,
    satisfiable_by_input: false,
    absent:
      "no mailbox is connected to this business, so nothing can be emailed to a client — drafts are still written and still need somewhere to go",
  },
  /**
   * Publish a page or post under the business's name. GEO corrective content, localisation locale
   * pushes, support help-centre updates — all the same need: write somewhere a buyer can read.
   *
   * `"one"` — publishing the same draft to Webflow and WordPress is not a merge.
   */
  publish_content: {
    title: "Publish content under your name",
    question: "Where should finished writing go live?",
    cardinality: "one",
    kernel_parses: false,
    kernel_acts: false,
    satisfiable_by_input: false,
    absent:
      "no publishing destination is connected to this business, so drafts stay drafts — nothing can go live on a site or CMS until one is",
  },
  /**
   * Read CRM records (contacts, companies, deals). RevOps hygiene and enrichment need the current
   * state before any write-back.
   */
  read_crm: {
    title: "Read your CRM",
    question: "Where do you keep contacts and deals?",
    cardinality: "all",
    // Contacts normalise into ObservedContact → Mycel clients (capability-import.ts). Same pull →
    // Home pattern as payments: connect grants the capability, Check now / go-live is when we pull.
    kernel_parses: true,
    kernel_acts: false,
    satisfiable_by_input: true,
    absent:
      "no CRM is connected to this business, so nothing here can see contacts, companies or deal stages",
  },
  /**
   * Write CRM records. Always gated; cardinality `"one"` so we never double-write the same contact
   * into two systems by sort order.
   */
  write_crm: {
    title: "Update your CRM",
    question: "Which CRM should it write back to?",
    cardinality: "one",
    kernel_parses: false,
    kernel_acts: false,
    satisfiable_by_input: false,
    absent:
      "no CRM is connected for writing, so enrichment and stage updates cannot be applied — drafts of the change can still be written for you to paste",
  },
  /**
   * Read calendars. Booking desks and recruiting screens need availability without inventing slots.
   */
  read_calendar: {
    title: "See your calendar",
    question: "Which calendar should it read availability from?",
    cardinality: "all",
    // The kernel reads and normalises these itself now (`CALENDAR_SHAPES`), because booking without
    // free/busy is not booking — it is proposing a time and hoping. See capabilities.normalise.ts on
    // what is stored (UTC instants) and what is displayed (an IANA zone, carried, never computed with).
    kernel_parses: true,
    kernel_acts: false,
    satisfiable_by_input: true,
    absent:
      "no calendar is connected to this business, so nothing here can see free/busy or existing bookings",
  },
  /**
   * Create a calendar event. `"one"` — booking the same slot on two calendars is double-booking the
   * founder, not a helpful merge.
   */
  book_calendar: {
    title: "Book time on your calendar",
    question: "Which calendar should bookings land on?",
    cardinality: "one",
    kernel_parses: false,
    kernel_acts: true,
    satisfiable_by_input: false,
    absent:
      "no calendar is connected for booking, so proposed slots stay proposals — nothing can place an event until one is",
  },
  /**
   * Read ad-account metrics. Performance desks and marketplace ops need spend/ROAS without a vendor
   * named in the blueprint.
   */
  read_ads: {
    title: "Read your ad accounts",
    question: "Where do you run paid ads?",
    cardinality: "all",
    kernel_parses: false,
    kernel_acts: false,
    satisfiable_by_input: true,
    absent:
      "no ad account is connected to this business, so nothing here can pull spend, clicks or conversion numbers",
  },
  /**
   * Change ads (pause, budget, creative). Always high-risk / gated. `"one"` — two ad accounts must
   * not both receive the same budget move silently.
   */
  write_ads: {
    title: "Change your ads",
    question: "Which ad account should it be allowed to change?",
    cardinality: "one",
    kernel_parses: false,
    kernel_acts: false,
    satisfiable_by_input: false,
    absent:
      "no ad account is connected for changes, so pause/budget/creative moves cannot be applied — recommendations can still be drafted for approval",
  },
} as const satisfies Record<string, CapabilitySpec>;

export interface CapabilitySpec {
  title: string;
  question: string;
  /** `"all"` unions every bound provider; `"one"` refuses when two are bound. See the header. */
  cardinality: "all" | "one";
  /** Does kernel code parse this provider's output? If so, a provider with no reads is a loud gap. */
  kernel_parses: boolean;
  /**
   * Does kernel code COMPOSE this verb's calls? The write-side twin of `kernel_parses`, and it exists
   * for the same failure pointing the other way.
   *
   * `unreadable` made a connected-but-unparseable READ say so. The write verbs had no equivalent, so
   * `send_email` — declared by five blueprints — was a word in a vocabulary with nothing behind it:
   * the capability resolved `ok: true` the moment Gmail was connected, the checklist went green, and
   * whether anything could actually be sent depended entirely on whether the agent happened to guess
   * `GMAIL_SEND_EMAIL` and its argument names. When it guessed wrong the run reported a tool error the
   * founder never saw, and the chase simply did not go out.
   *
   * So: `true` means an adapter in capabilities.act.ts builds the provider's arguments and reads its
   * answer, and a bound provider with no `actions` is `unactionable` — refused loudly, exactly like
   * `unreadable`. `false` on an action verb means BROKERED-ONLY: see `capabilityAdapter`.
   */
  kernel_acts: boolean;
  /**
   * Can a TASK INPUT stand in for this connection?
   *
   * ═══ WHY THIS IS EXPLICIT AND NOT INFERRED FROM THE NAME ═══
   *
   * A capability that READS something can be satisfied by the caller supplying that something. A
   * monthly close posted with sixteen transactions in `input.transactions` does not need a bank
   * feed — it is holding the ledger, and the run reporting "no bank feed is connected, so the month
   * cannot be reconciled" while looking at the data is the platform demanding a connection to reach
   * what it already has.
   *
   * A capability that ACTS cannot. No amount of supplied data substitutes for the ability to send an
   * email as the business, and a manifest that claimed otherwise would produce a run that believes
   * it can send and silently cannot — the exact failure `capabilityAdapter` was written to end.
   *
   * `kernel_acts` looked like the discriminator and is not: it separates adapter-driven from
   * brokered-only, so a brokered ACTION verb reads `false` too. The `read_` prefix looked like one
   * as well, and a naming convention is not a guarantee. So it is stated per capability, and
   * `capability_inputs` in a manifest is refused when it names one that is false here.
   */
  satisfiable_by_input: boolean;
  /** Printed when nothing provides it. Says what is missing and what stops. Never empty. */
  absent: string;
}

export type CapabilityName = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as CapabilityName[];

export const isCapability = (s: string): s is CapabilityName => Object.hasOwn(CAPABILITIES, s);

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A CAPABILITY THIS KERNEL HAS NEVER HEARD OF, SATISFIED BY A CONNECTION THE FOUNDER BROUGHT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `CAPABILITIES` is eleven names. The broker underneath is not: `readComposio` takes a free-form
 * capability string, reaches any of 1,540 Composio toolkits, and a connection can even map a
 * capability to a raw vendor API path and carry the call on its own OAuth. So the RUNTIME was always
 * a framework and the DECLARATION was the ceiling — a service could only ever ask for one of eleven
 * things.
 *
 * That ceiling is what stops this covering trades nobody packaged. A physiotherapy practice runs on
 * Cliniko or Jane, a law firm on Clio, a plumber on ServiceTitan or Jobber. None of it is `read_crm`
 * and none of it is expressible, so a service written for that business could name what it needed
 * and be handed nothing — `runtime.ts` skipped an unknown name silently, with no grant and no
 * sentence saying why.
 *
 * THE CHAIN IS NOW THE OTHER WAY AROUND. It was `capability (our eleven) -> providers (our vendor
 * table) -> the founder's connection`, which requires this kernel to already know what Cliniko is.
 * A connection may now declare what it PROVIDES, so a service states a need in its own words and
 * whatever the founder connected answers it. Nothing here learns a vendor's name.
 *
 * The eleven stay exactly as they are. They are the path where the kernel PARSES the answer and
 * COMPOSES the call — normalised money, a real send — and that is worth more than a raw tool when it
 * exists. A declared capability is brokered: the agent gets the vendor's own tools and is told so.
 */
export interface DeclaredProvider {
  /** Composio tool slugs the agent may read through, for this capability. */
  reads?: readonly string[];
  /** Composio tool slugs the agent may act through. */
  actions?: readonly string[];
}

/** `snake_case`, the shape every name in `CAPABILITIES` already has. Anything else is a typo. */
const DECLARED_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export function isDeclarableCapability(s: string): boolean {
  return DECLARED_NAME.test(s) && s.length <= 60;
}

/** What a connection says it can do, as `{ capability: { reads, actions } }`. Never throws. */
export function connectionProvides(conn: Connection): Record<string, DeclaredProvider> {
  const raw = (conn.config as Record<string, unknown> | undefined)?.provides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DeclaredProvider> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDeclarableCapability(name)) continue;
    const spec = (v ?? {}) as Record<string, unknown>;
    const list = (k: string): string[] =>
      Array.isArray(spec[k]) ? (spec[k] as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
    const reads = list("reads");
    const actions = list("actions");
    /*
      A capability claimed with NEITHER is a claim with nothing behind it. Recording it would make
      `resolveCapability` report a working binding for a connection that cannot do the thing — the
      "connected but unimplemented" failure the eleven already have a loud sentence for.
    */
    if (!reads.length && !actions.length) continue;
    out[name] = { ...(reads.length ? { reads } : {}), ...(actions.length ? { actions } : {}) };
  }
  return out;
}

/**
 * The connections in this project that say they provide `capability`.
 *
 * Founder-owned only, and scoped — the same two filters `resolveCapability` applies for the eleven,
 * for the same reason: a client's connection is not the business's, and resolving across tenants is
 * the leak this repo has shipped twice.
 */
export function declaredProviders(
  capability: string,
  connections: readonly Connection[],
  projectId: string,
): { connection: Connection; provides: DeclaredProvider }[] {
  if (!projectId || !isDeclarableCapability(capability)) return [];
  const out: { connection: Connection; provides: DeclaredProvider }[] = [];
  for (const c of connections) {
    if (c.project_id !== projectId || c.owner?.kind !== "founder") continue;
    const p = connectionProvides(c)[capability];
    if (p) out.push({ connection: c, provides: p });
  }
  return out;
}

/** The founder-readable sentence for a capability nothing provides. One wording, every surface. */
export function whyNoProvider(capability: string): string {
  if (isCapability(capability)) return CAPABILITIES[capability].absent;
  /*
    A DECLARED capability has no hand-written sentence, and inventing a vendor for it would be the
    hardcoding this exists to remove. So it names the need in the service's own words and the one
    action that resolves it — which is also the only honest thing to say about a trade we do not know.
  */
  return (
    `Nothing connected here says it can ${capability.replace(/_/g, " ")}. Connect the tool your ` +
    `business uses for it and mark it as providing "${capability}" — this kernel does not need to ` +
    `know which product that is.`
  );
}

/**
 * How this kernel actually serves a capability. The audit, in one function.
 *
 * `"kernel"` — there is real code here: reads it parses (`kernel_parses`), or calls it composes
 * (`kernel_acts`). The verb means the same thing whichever vendor is behind it, which is the entire
 * premise of the capability layer.
 *
 * `"brokered"` — there is NOT. The connection is handed to the agent and the agent drives the
 * vendor's own tools directly, guessing slugs and argument names, with nothing here normalising the
 * shape or checking the answer. That is a legitimate degrade — it is how `read_bank_transactions`
 * works today, deliberately, because `reconcile.mjs` reads the feed in the sandbox — but it is NOT
 * the same product, and the difference has to be visible or it is a promise we are not keeping.
 *
 * Five of eleven are brokered as this ships: read_bank_transactions, publish_content, read_crm,
 * write_crm, read_ads, write_ads. Each says so, in `resolveCapability`'s detail, on every surface.
 */
export function capabilityAdapter(capability: string): "kernel" | "brokered" {
  // A declared capability is brokered BY CONSTRUCTION — the kernel has no parser for a trade it has
  // never heard of, and saying so is the whole honesty of `brokeredCaveat`.
  if (!isCapability(capability)) return "brokered";
  const spec = CAPABILITIES[capability];
  return spec.kernel_parses || spec.kernel_acts ? "kernel" : "brokered";
}

/**
 * The sentence a brokered capability appends to its binding. Told to the FOUNDER (on the capability
 * surface) and to the AGENT (through `capabilityConnections` → the run's "what you cannot do"), for
 * the reason `hasLinkedInExecutor` gives: an agent that plans around a verb nobody built spends a
 * whole run discovering it, and a founder who was shown a green tick never finds out at all.
 */
export function brokeredCaveat(capability: string): string {
  if (!isCapability(capability)) {
    /*
      No `spec.title` to quote, and inventing one would be inventing knowledge of a trade this kernel
      does not have. The sentence says the same true thing the eleven's version says: you are getting
      the vendor's own tools, read them before you plan around them.
    */
    return (
      `this kernel has no adapter for "${capability}" — the tool your business connected for it is ` +
      `handed to you as the vendor's own actions, so read what they take before planning a step ` +
      `around one`
    );
  }
  const spec = CAPABILITIES[capability];
  return (
    `this kernel has no adapter for "${capability}" (${spec.title.toLowerCase()}) — a connected provider is handed to ` +
    `the agent as the vendor's own tools, so nothing here normalises what comes back or composes what goes out, and ` +
    `anything that reaches a person outside the business still stops at a human`
  );
}

/**
 * "Did you mean" for a mistyped capability. Same letters, different spelling — the `looksLike` from
 * roles.ts, duplicated deliberately rather than exported across: it is four lines, and coupling the
 * wedge-manifest validator to the blueprint validator so they share a spellchecker is a worse trade
 * than two copies that a test pins.
 */
function looksLike(known: string, given: string): boolean {
  if (known === given) return false;
  const a = known.toLowerCase();
  const b = given.toLowerCase();
  if (a === b) return true;
  const norm = (s: string) => [...s.replace(/[^a-z]/g, "")].sort().join("");
  if (norm(a) === norm(b)) return true;
  // ONE CHARACTER DROPPED OR ADDED, which roles.ts's anagram test does not catch and which is the
  // typo that actually happens here: `read_payment` for `read_payments`. Worth the four lines,
  // because the difference between naming the fix and printing the whole vocabulary is the
  // difference between a founder correcting a file and a founder opening a support ticket.
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

/**
 * A capability name that is not one, as a sentence — or undefined if it is fine.
 *
 * Returns rather than throws so `blueprintFaults` can collect every problem in one file and report
 * them together, which is the thing `manifestFaults` learned: a founder who mistyped twice should be
 * told twice.
 */
export function capabilityFault(given: string, opts: { declarable?: boolean } = {}): string | undefined {
  if (isCapability(given)) return undefined;
  /**
   * ═══ A NEAR MISS IS A TYPO; ANYTHING ELSE DEPENDS ON WHO WROTE IT ═══
   *
   * `looksLike` tells the two apart, and that half is unconditional. `read_paymnets` is a slip, and
   * naming the intended capability beats accepting it — the kernel PARSES that one, so a typo would
   * quietly downgrade a normalised read to a raw vendor call.
   *
   * What the caller decides is what happens to a name resembling nothing we ship.
   *
   *   · A PACKAGED manifest or blueprint — ours. `fly_to_mars` in our own artifact is a bug, and the
   *     closed vocabulary is the check that catches it. Default, because the strict answer is the
   *     safe one to get by accident.
   *
   *   · `declarable: true` — a service WRITTEN for a business, or a connection saying what it
   *     provides. Eleven names against 1,540 connectable toolkits is the ceiling that stops this
   *     platform covering a trade nobody packaged: a physiotherapy practice cannot say
   *     `read_appointments`, a law firm cannot say `read_matters`, and being made to pick the
   *     nearest of eleven is how a brand studio ended up declared as `invoice-chaser`.
   *
   * Either way nothing is silently dropped — `runtime.ts` reports a name it cannot resolve in
   * `missing` rather than skipping it, which is the failure this whole check exists for.
   */
  const near = ALL_CAPABILITIES.find((c) => looksLike(c, given));
  if (near) return `"${given}" is not a capability this kernel knows — did you mean "${near}"?`;
  if (opts.declarable) {
    if (isDeclarableCapability(given)) return undefined;
    return (
      `"${given}" is not a usable capability name — use snake_case, like "read_appointments". ` +
      `This kernel implements ${ALL_CAPABILITIES.join(", ")}; anything else is answered by a tool ` +
      `you connect and mark as providing it.`
    );
  }
  return `"${given}" is not a capability this kernel knows (known capabilities: ${ALL_CAPABILITIES.join(", ")})`;
}

// ═══════════════════════════ THE PROVIDER TABLE ═══════════════════════════

/**
 * One read this provider can answer a capability with.
 *
 * `shape` names a normaliser in capabilities.normalise.ts rather than holding a function, so the
 * whole table stays serialisable and an operator can correct a slug from disk. A `shape` with no
 * normaliser registered is caught at boot by `assertCapabilityTableValid` — a table entry pointing
 * at a parser that does not exist would otherwise read as a working provider and return nothing.
 */
export interface ProviderRead {
  /**
   * Composio tool slug, uppercase. The founder must also have granted it — `isReadTool` decides.
   *
   * A read is EITHER a tool slug or an API `path`, never both and never neither. Both carry a
   * `shape`, because the answer has to be normalised whichever door it came through — and putting a
   * path anywhere other than here would have meant a read the boot validator could not check and the
   * normaliser registry never saw.
   */
  slug?: string;
  /**
   * ═══ THE VENDOR'S OWN API, WHEN THE TOOLKIT HAS NOTHING ═══
   *
   * Verified against the live catalogue on 30 August 2026, with a real key: Xero's toolkit is FOUR
   * tools — `GET_CONNECTIONS`, `GET_CONTACTS`, `GET_QUOTES`, `POST_INVOICE_UPDATE` — and not one of
   * them reads an invoice, a payment or a bank transaction. QuickBooks has thirteen, of which the
   * only reads are two balance reports. Square has none at all.
   *
   * The four accounting slugs this file declared — `XERO_GET_INVOICES`, `XERO_GET_PAYMENTS`,
   * `QUICKBOOKS_QUERY_INVOICES`, `QUICKBOOKS_QUERY_PAYMENTS` — do not exist and never did. They were
   * acknowledged guesses written when there was no key to check them with, and they failed in the
   * worst direction: a bookkeeper connecting Xero got a read that could not run, for the one trade
   * this product has been hardened on.
   *
   * A path goes through `/tools/execute/proxy`: Composio keeps the part that is genuinely theirs —
   * the OAuth dance, the refresh, the per-tenant token we must never hold — and the request
   * addresses the vendor's real REST API. All of Xero rather than four of it, and
   * `capabilities.normalise.ts` has been able to parse those response shapes the whole time.
   */
  path?: string;
  /** Normaliser key. Must exist in the registry for this capability. */
  shape: string;
  /**
   * Extra tool arguments merged into every call (after `limit`). Attio's list requires
   * `object_type`; Salesforce's list accepts a SOQL `query`. Kept on the table so an operator can
   * correct them from `MYCEL_CAPABILITY_PROVIDERS` without a code change.
   */
  arguments?: Record<string, unknown>;
}

/**
 * One call this provider can PERFORM a capability with. The write-side twin of `ProviderRead`.
 *
 * `shape` names an adapter in capabilities.act.ts — a pair of functions that turn the kernel's own
 * request (an `EmailSend`, a `BookingRequest`) into this vendor's argument names and turn the
 * vendor's answer back into the kernel's own result. Held as a KEY rather than a function for the
 * same reason reads are: the whole table stays serialisable, so an operator whose Composio catalogue
 * disagrees with our guesses can correct a slug from disk through `MYCEL_CAPABILITY_PROVIDERS`
 * without a deploy. `assertCapabilityTableValid` refuses to boot on a shape with no adapter.
 */
export interface ProviderAction {
  /** Composio tool slug (uppercase), or the kernel's own executor capability for a non-composio `via`. */
  slug: string;
  /** Adapter key. Must exist in the action registry for this capability. */
  shape: string;
}

export interface CapabilityProvider {
  /**
   * Composio toolkit slug, or — for `via` other than `"composio"` — the kernel's own connection kind.
   * Lower case, and it is what a connection is matched on.
   */
  toolkit: string;
  /** What a founder calls it. "QuickBooks", not "quickbooks". Shown in the connect step. */
  label: string;
  /** How it gets connected: brokered by Composio, or one of the kernel's own transports. */
  via: "composio" | "agentmail" | "email";
  /**
   * Reads the kernel itself will run and parse. EMPTY IS MEANINGFUL, not missing: it says this
   * provider can be connected and handed to the agent, but the kernel cannot read it for this
   * capability. `resolveCapability` reports that as an `unreadable` binding rather than as silence.
   */
  reads?: readonly ProviderRead[];
  /**
   * Calls the kernel itself will compose. EMPTY IS MEANINGFUL in exactly the way `reads` is: on a
   * capability the kernel acts through, a provider with no action can be connected and shown to the
   * agent, but the kernel cannot perform the verb with it — reported as `unactionable`, never as a
   * send that quietly did nothing.
   */
  actions?: readonly ProviderAction[];
}

/**
 * Capability → the toolkits that can serve it, in preference order.
 *
 * ORDER IS THE OFFER ORDER, not a precedence: with `cardinality: "all"` nothing is chosen by being
 * first, and with `"one"` two bound providers refuse rather than take the first. Order exists so the
 * connect step lists the thing most founders use at the top.
 *
 * UNVERIFIED AGAINST THE LIVE CATALOGUE. There is no `COMPOSIO_API_KEY` in this environment. The
 * `stripe` and `xero` entries reuse the exact slugs the shipped blueprints already declared, so they
 * are no more speculative than what is in production today. `quickbooks`, `freshbooks`, `wave`,
 * `square`, `paypal`, `gmail`, `outlook` and `plaid` are considered guesses at the toolkit slug and,
 * where reads are listed, at the tool slug. Every one of them fails the honest way — see
 * `resolveCapability`'s `unreadable` — and is corrected by `MYCEL_CAPABILITY_PROVIDERS`.
 */
export const DEFAULT_CAPABILITY_PROVIDERS: Record<CapabilityName, readonly CapabilityProvider[]> = {
  read_payments: [
    {
      toolkit: "stripe",
      label: "Stripe",
      via: "composio",
      reads: [
        { slug: "STRIPE_LIST_INVOICES", shape: "stripe_invoices" },
        { slug: "STRIPE_LIST_CHARGES", shape: "stripe_charges" },
      ],
    },
    {
      // An accounting ledger knows what has been paid at least as well as a card processor does, and
      // for the many businesses paid by bank transfer it is the ONLY thing that knows. Leaving
      // accounting out of `read_payments` is what made the chaser useless to them.
      toolkit: "quickbooks",
      label: "QuickBooks",
      via: "composio",
      // No such tool. The thirteen QuickBooks tools are four creates, four reads of a single named
      // record, two balance reports and a account query — nothing that lists what was paid.
      reads: [{ path: "/v3/company/{realmId}/query?query=select * from Payment", shape: "quickbooks_payments" }],
    },
    { toolkit: "xero", label: "Xero", via: "composio", reads: [{ path: "/api.xro/2.0/Payments", shape: "xero_payments" }] },
    // Connectable, and zero tools in the catalogue as of 30 August 2026 — so `resolveCapability`
    // reports it `unreadable`, which is the honest answer rather than a read that fails at run time.
    { toolkit: "square", label: "Square", via: "composio" },
    {
      toolkit: "paypal",
      label: "PayPal",
      via: "composio",
      /**
       * `PAYPAL_LIST_PAYMENTS` and `PAYPAL_LIST_INVOICES` are real — verified 30 August 2026, unlike
       * the four accounting slugs above — and they are still not claimed here, because a `reads`
       * entry needs a SHAPE and nobody has seen a PayPal payload from a connected account. Writing a
       * normaliser from the published docs would be the same unverified guess that put
       * `XERO_GET_INVOICES` in this file, one layer down and harder to spot.
       *
       * Connect a PayPal account, read one page, write `paypal_payments` and `paypal_invoices` in
       * capabilities.normalise.ts against what actually came back, and add the two lines here. Until
       * then this binds `unreadable`, which is the honest answer.
       */
    },
    { toolkit: "freshbooks", label: "FreshBooks", via: "composio" },
  ],
  read_invoices: [
    { toolkit: "xero", label: "Xero", via: "composio", reads: [{ path: "/api.xro/2.0/Invoices", shape: "xero_invoices" }] },
    {
      toolkit: "quickbooks",
      label: "QuickBooks",
      via: "composio",
      reads: [{ path: "/v3/company/{realmId}/query?query=select * from Invoice", shape: "quickbooks_invoices" }],
    },
    { toolkit: "freshbooks", label: "FreshBooks", via: "composio" },
    {
      toolkit: "stripe",
      label: "Stripe",
      via: "composio",
      reads: [{ slug: "STRIPE_LIST_INVOICES", shape: "stripe_invoices" }],
    },
  ],
  read_bank_transactions: [
    /**
     * `plaid` was here and there is no such toolkit — verified 30 August 2026, along with
     * `linkedinads`, `wave` and `wordpress`, all four of which this file offered and none of which
     * the catalogue has. A founder picking one got a connect step for something that cannot exist.
     */
    { toolkit: "quickbooks", label: "QuickBooks", via: "composio" },
    /**
     * NO READ HERE, and that is not an omission. `read_bank_transactions` is `kernel_parses: false`:
     * the kernel does not normalise a bank feed, the agent reads it raw, and `assertCapabilityTableValid`
     * refuses any read declared on a capability with no shape registry — which is what caught the
     * first version of this line.
     *
     * The Xero path still exists and still works; it lives on the CONNECTION as
     * `read_paths: { read_bank_transactions: "/api.xro/2.0/BankTransactions" }`, reached through the
     * agent's own `/v1/internal/reads/:capability`. That is the right home for it: an endpoint is a
     * per-tenant fact a founder's connect step can correct, not a constant.
     */
    { toolkit: "xero", label: "Xero", via: "composio" },
  ],
  send_email: [
    // Verified 2026-08-11 against the live Composio catalogue (prod COMPOSIO_API_KEY).
    // FIRST on purpose: invoice chase must come from the founder's own mailbox (white-label +
    // reputation). AgentMail is for platform GTM outbound, not customer-facing dunning.
    { toolkit: "gmail", label: "Gmail", via: "composio", actions: [{ slug: "GMAIL_SEND_EMAIL", shape: "gmail_send" }] },
    // Catalogue uses the double-prefixed slug — OUTLOOK_SEND_EMAIL does not exist.
    { toolkit: "outlook", label: "Outlook", via: "composio", actions: [{ slug: "OUTLOOK_OUTLOOK_SEND_EMAIL", shape: "outlook_send" }] },
    {
      // Platform / GTM mailbox Mycel provisions. Listed after Gmail/Outlook so invoice chase
      // defaults to the founder's brand. Still the only provider here that receives replies without
      // a separate IMAP path — see agentmail.ts.
      toolkit: "agentmail",
      label: "Mycel mailbox (GTM / when you have no Gmail)",
      via: "agentmail",
      // Not a Composio slug: `executeAction` branches on the connection KIND for the kernel's own
      // transports, so the slug it is handed is the kernel's own verb. Named `send_email` rather than
      // left blank so the approval card, the trace and the audit row all read the same word.
      actions: [{ slug: "send_email", shape: "agentmail_send" }],
    },
    {
      // The founder's OWN transactional sender (Postmark, Resend, SendGrid) configured directly,
      // with `api_url`, `from` and a vaulted token on the connection. Last because it is deaf — see
      // the reply-routing note on `sendEmail` in actions.ts — but it is the one provider here that
      // needs no broker at all, and a business that already sends its own mail should not be made to
      // authorise an OAuth app to keep doing it.
      toolkit: "email",
      label: "Your own email service (Postmark, Resend, SendGrid…)",
      via: "email",
      actions: [{ slug: "send_email", shape: "transport_send" }],
    },
  ],
  // UNVERIFIED against the live Composio catalogue — same honesty rule as the money table. Wrong
  // toolkit slugs fail as `unreadable` / unbound, never as silent success. Correct via
  // MYCEL_CAPABILITY_PROVIDERS.
  publish_content: [
    { toolkit: "webflow", label: "Webflow", via: "composio" },
    { toolkit: "notion", label: "Notion", via: "composio" },
    { toolkit: "contentful", label: "Contentful", via: "composio" },
  ],
  // Contact reads verified 2026-08-11 against the live catalogue. Import path: capability-import.ts.
  read_crm: [
    {
      toolkit: "hubspot",
      label: "HubSpot",
      via: "composio",
      reads: [{ slug: "HUBSPOT_HUBSPOT_LIST_CONTACTS", shape: "hubspot_contacts" }],
    },
    {
      toolkit: "pipedrive",
      label: "Pipedrive",
      via: "composio",
      reads: [{ slug: "PIPEDRIVE_GET_ALL_PERSONS", shape: "pipedrive_persons" }],
    },
    {
      toolkit: "salesforce",
      label: "Salesforce",
      via: "composio",
      reads: [
        {
          slug: "SALESFORCE_LIST_CONTACTS",
          shape: "salesforce_contacts",
          arguments: {
            query: "SELECT Id, FirstName, LastName, Email, Phone FROM Contact WHERE Email != null LIMIT 100",
          },
        },
      ],
    },
    {
      toolkit: "attio",
      label: "Attio",
      via: "composio",
      reads: [
        {
          slug: "ATTIO_LIST_RECORDS",
          shape: "attio_people",
          // Attio refuses the call without an object type. "people" is the default people object;
          // override via MYCEL_CAPABILITY_PROVIDERS if a workspace renamed it.
          arguments: { object_type: "people" },
        },
      ],
    },
  ],
  write_crm: [
    { toolkit: "hubspot", label: "HubSpot", via: "composio" },
    { toolkit: "salesforce", label: "Salesforce", via: "composio" },
    { toolkit: "pipedrive", label: "Pipedrive", via: "composio" },
    { toolkit: "attio", label: "Attio", via: "composio" },
  ],
  // Calendar slugs verified 2026-08-11 against the live catalogue (prod COMPOSIO_API_KEY).
  // Outlook uses double-prefixed tool names; Google matches the short forms.
  read_calendar: [
    {
      toolkit: "googlecalendar",
      label: "Google Calendar",
      via: "composio",
      reads: [{ slug: "GOOGLECALENDAR_EVENTS_LIST", shape: "google_calendar_events" }],
    },
    {
      toolkit: "outlook",
      label: "Outlook Calendar",
      via: "composio",
      reads: [{ slug: "OUTLOOK_OUTLOOK_LIST_EVENTS", shape: "outlook_events" }],
    },
  ],
  book_calendar: [
    {
      toolkit: "googlecalendar",
      label: "Google Calendar",
      via: "composio",
      actions: [{ slug: "GOOGLECALENDAR_CREATE_EVENT", shape: "google_calendar_book" }],
    },
    {
      toolkit: "outlook",
      label: "Outlook Calendar",
      via: "composio",
      actions: [{ slug: "OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT", shape: "outlook_book" }],
    },
  ],
  read_ads: [
    { toolkit: "metaads", label: "Meta Ads", via: "composio" },
    { toolkit: "googleads", label: "Google Ads", via: "composio" },
  ],
  write_ads: [
    { toolkit: "metaads", label: "Meta Ads", via: "composio" },
    { toolkit: "googleads", label: "Google Ads", via: "composio" },
  ],
};

/**
 * The table in force, with the on-disk override applied.
 *
 * WHOLE-CAPABILITY REPLACEMENT, not a merge. A merge would need a rule for what happens when the
 * override and the default both mention `stripe` with different reads, and any such rule is a
 * surprise waiting for whoever is debugging at the time. Replacing one capability's list outright is
 * the only semantics that can be reasoned about from the file alone.
 *
 * Memoised for the same reason and with the same caveat as the role index: the file is baked into
 * the image, so within one process the answer cannot change, and an edit under a running process
 * gets the old answer until restart.
 */
let tableMemo: Record<CapabilityName, readonly CapabilityProvider[]> | null = null;

export function capabilityProviders(capability: CapabilityName): readonly CapabilityProvider[] {
  return providerTable()[capability] ?? [];
}

export function providerTable(): Record<CapabilityName, readonly CapabilityProvider[]> {
  if (tableMemo) return tableMemo;
  const path = process.env.MYCEL_CAPABILITY_PROVIDERS;
  let table = DEFAULT_CAPABILITY_PROVIDERS;
  if (path) {
    // A malformed override is LOUD and then ignored. Refusing to boot would take a whole deployment
    // down over a comma; silently ignoring it would leave an operator staring at a file they believe
    // is in force. The middle is the only honest option: say so, on stderr, and use the defaults.
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, CapabilityProvider[]>;
      const merged: Record<string, readonly CapabilityProvider[]> = { ...DEFAULT_CAPABILITY_PROVIDERS };
      for (const [k, v] of Object.entries(raw)) {
        if (!isCapability(k)) {
          console.error(`[mycel] ${path}: ${capabilityFault(k)} — that block was ignored`);
          continue;
        }
        if (!Array.isArray(v)) {
          console.error(`[mycel] ${path}: "${k}" must be an array of providers — that block was ignored`);
          continue;
        }
        merged[k] = v;
      }
      table = merged as Record<CapabilityName, readonly CapabilityProvider[]>;
    } catch (e) {
      console.error(`[mycel] could not read MYCEL_CAPABILITY_PROVIDERS at ${path}, using the built-in table:`, e);
    }
  }
  tableMemo = table;
  return tableMemo;
}

/** Test seam, and the counterpart of `_resetWedgeRoleIndex`. */
export function _resetCapabilityTable(): void {
  tableMemo = null;
}

/**
 * Every read NAME this capability might run on this provider. What a connect grants.
 *
 * A tool read grants its slug. A path read grants the CAPABILITY — the founder consented to us
 * reading their invoices, not to a particular URL we happen to address this month, and a grant tied
 * to a path would silently lapse the day the vendor versions their API.
 */
export function readToolsFor(capability: CapabilityName, toolkit: string): string[] {
  const p = capabilityProviders(capability).find((x) => x.toolkit === toolkit.toLowerCase());
  return (p?.reads ?? []).map((r) => r.slug ?? capability);
}


// ═══════════════════════════ RESOLUTION ═══════════════════════════

/** A provider the founder has actually connected, and whether we can read it. */
export interface BoundProvider {
  provider: CapabilityProvider;
  connection: Connection;
  /**
   * True when this provider is connected but the table gives the kernel nothing to read it with, on
   * a capability the kernel parses.
   *
   * THE POINT OF THIS FIELD. The recurring expensive bug in this repo is something failing while
   * reporting success, and the shape it would take here is precise: a founder connects FreshBooks,
   * the checklist goes green, the chaser reads zero invoices from it forever, and every summary says
   * the run was clean. So the gap is a value that callers must handle, not an empty array.
   */
  unreadable: boolean;
  /**
   * True when this provider is connected but the table gives the kernel nothing to PERFORM the verb
   * with, on a capability the kernel acts through.
   *
   * The write-side twin of `unreadable`, and the failure is worse because it has a recipient. A
   * founder connects Outlook, the checklist goes green, and the invoice chaser's mail never leaves —
   * not bounced, not queued, not errored anywhere a person looks. Every summary says the sweep was
   * clean because nothing failed: nothing was attempted.
   */
  unactionable: boolean;
}

export interface CapabilityBinding {
  /**
   * `CapabilityName` for one of the eleven the kernel implements, or any `snake_case` name a service
   * declared and a connection answered. Widened when capabilities stopped being a closed list — see
   * `declaredProviders`. Callers that need the distinction ask `isCapability`, and the two that did
   * (`blueprints.ts`, `blueprints.routes.ts`) already guarded on it before reading the spec table.
   */
  capability: string;
  /** Connected providers, in table order. Empty when nothing provides it. */
  bound: BoundProvider[];
  /** Everything else the founder could connect for this. What the connect step offers. */
  candidates: CapabilityProvider[];
  /**
   * Can this capability be USED right now? False for zero providers, false for a `"one"` capability
   * with two claimants, and false when every bound provider is `unreadable`.
   */
  ok: boolean;
  /** Whether two claimants on a `"one"` capability is why `ok` is false. Callers word it differently. */
  ambiguous: boolean;
  /** A sentence for a founder. Always populated, on every branch. */
  detail: string;
}

/**
 * Which of the founder's connections serve this capability, in this project.
 *
 * ═══ TENANCY ═══
 *
 * `projectId` is a REQUIRED positional argument with no default and no overload that omits it. Two
 * cross-tenant leaks have shipped in this repo and both were a scope that defaulted. The comparison
 * is exact string equality, so a connection with no `project_id` matches nothing rather than
 * everything.
 *
 * Founder-owned only, for the reason `reconcileProject` gives at its own filter: a client-owned
 * connection is a CLIENT's account the founder operates on their behalf, and reading it as the
 * business's own payment provider would settle our invoices out of their customers' money.
 *
 * ═══ WHY `verified_at` AND NOT THE ROW ═══
 *
 * A Composio row exists from the moment "Connect" is clicked, before the founder has authorised
 * anything — that is what `POST /v1/composio/toolkits/:toolkit/connect` does and why the catalogue
 * distinguishes `pending`. An abandoned OAuth screen must not read as a bound provider, or the
 * checklist goes green on a business that cannot do the thing.
 */
export function resolveCapability(
  capability: string,
  connections: readonly Connection[],
  projectId: string,
): CapabilityBinding {
  if (!projectId) throw new Error("resolving a capability must be scoped to a project");
  /**
   * ═══ A NAME THIS KERNEL DOES NOT KNOW, ANSWERED BY WHAT THE FOUNDER CONNECTED ═══
   *
   * Taken FIRST and returned whole, rather than folded into the table below, because the two are not
   * the same kind of answer. The eleven are capabilities the kernel PARSES and COMPOSES — it knows
   * what an invoice is, it can normalise the money, it can perform the send. A declared one is
   * brokered by construction: the agent is handed the vendor's own tools and `capabilityAdapter`
   * tells it so. Pretending otherwise would be the quiet version of the failure the "connected but
   * unimplemented" sentence exists to shout about.
   *
   * `cardinality` is effectively many: two connections that both say they can do a thing is a
   * founder's own arrangement, not an ambiguity for this module to refuse. The refusal below exists
   * for `send_email`, where picking would decide which address a client sees the business as.
   */
  if (!isCapability(capability)) {
    const declared = declaredProviders(capability, connections, projectId);
    const bound: BoundProvider[] = declared.map((d) => ({
      provider: {
        toolkit: String((d.connection.config as Record<string, unknown>)?.toolkit ?? d.connection.kind),
        label: d.connection.name,
        via: d.connection.kind === "composio" ? "composio" : "email",
        reads: [],
        actions: [],
      } as CapabilityProvider,
      connection: d.connection,
      // Never "unreadable"/"unactionable": those report that the KERNEL has no parser or composer,
      // which is true of every declared capability and is the point rather than a defect.
      unreadable: false,
      unactionable: false,
    }));
    return bound.length
      ? { capability, bound, candidates: [], ok: true, ambiguous: false, detail: "" }
      : {
          capability,
          bound,
          candidates: [],
          ok: false,
          ambiguous: false,
          detail: whyNoProvider(capability),
        };
  }
  const spec = CAPABILITIES[capability];
  const providers = capabilityProviders(capability);

  const mine = connections.filter((c) => c.project_id === projectId && c.owner?.kind === "founder");
  const bound: BoundProvider[] = [];
  for (const provider of providers) {
    const conn = mine.find((c) => matchesProvider(c, provider));
    if (!conn) continue;
    bound.push({
      provider,
      connection: conn,
      unreadable: spec.kernel_parses && (provider.reads ?? []).length === 0,
      unactionable: spec.kernel_acts && (provider.actions ?? []).length === 0,
    });
  }
  const candidates = providers.filter((p) => !bound.some((b) => b.provider.toolkit === p.toolkit));

  if (bound.length === 0) {
    return { capability, bound, candidates, ok: false, ambiguous: false, detail: spec.absent };
  }

  if (spec.cardinality === "one" && bound.length > 1) {
    const names = bound.map((b) => `${b.provider.label} (${b.connection.name})`);
    return {
      capability,
      bound,
      candidates,
      ok: false,
      ambiguous: true,
      // Refuses, and does not pick. Picking would decide which address a client sees the business as,
      // by array order, with nobody having said so. Same argument roles.ts makes for two dunning
      // wedges — and the same remedy: tell the founder both, and let them disconnect one.
      detail:
        `${names.join(" and ")} are both connected and only one can ${spec.title.toLowerCase()} — ` +
        `nothing here will choose for you, because choosing would decide what your clients see. Disconnect one.`,
    };
  }

  // ONE TEST FOR BOTH HALVES. A provider is usable when the kernel can do what this capability is
  // for: parse it if it reads, perform it if it acts. Splitting these into two checks is how the
  // write half came to have none at all.
  const usable = bound.filter((b) => !b.unreadable && !b.unactionable);
  if (usable.length === 0) {
    const noun = spec.kernel_acts && !spec.kernel_parses ? "way to send through" : "reader for";
    return {
      capability,
      bound,
      candidates,
      ok: false,
      ambiguous: false,
      // LOUD. This is the connected-but-unimplemented case, and the sentence names the provider and
      // the fix rather than reporting an empty read — or an unattempted send — as a quiet success.
      detail:
        `${bound.map((b) => b.provider.label).join(" and ")} ${bound.length === 1 ? "is" : "are"} connected, but ` +
        `this kernel has no ${noun} ${bound.length === 1 ? "it" : "them"} yet — so ${spec.title.toLowerCase()} ` +
        `is not working and nothing here should be trusted to say otherwise`,
    };
  }

  const stranded = bound.filter((b) => b.unreadable || b.unactionable);
  return {
    capability,
    bound,
    candidates,
    ok: true,
    ambiguous: false,
    detail:
      `${usable.map((b) => b.provider.label).join(" and ")} connected` +
      (stranded.length
        ? ` — ${stranded.map((b) => b.provider.label).join(" and ")} also connected but this kernel cannot use it yet`
        : "") +
      // Appended even on the happy path, because "connected" reads as "working" and for a brokered
      // capability it only means "reachable". The founder is told what they have actually got.
      (capabilityAdapter(capability) === "brokered" ? `, but ${brokeredCaveat(capability)}` : ""),
  };
}

/**
 * Does this connection serve this provider entry?
 *
 * Composio matches on `config.toolkit` AND requires `verified_at`; the kernel's own kinds match on
 * `Connection.kind` and require a stored credential where the kind needs one. Kept in one function
 * so a new `via` cannot be added without deciding what "connected" means for it.
 */
function matchesProvider(conn: Connection, provider: CapabilityProvider): boolean {
  if (provider.via === "composio") {
    if (conn.kind !== "composio") return false;
    const cfg = (conn.config ?? {}) as Record<string, unknown>;
    if (String(cfg.toolkit ?? "").toLowerCase() !== provider.toolkit) return false;
    return !!cfg.verified_at;
  }
  if (provider.via === "agentmail") {
    return conn.kind === "agentmail" && !!(conn.config as Record<string, unknown>)?.address;
  }
  // `email` — a directly configured transactional sender. It needs a `from` and a vaulted token; the
  // token is checked by the caller that has the secret store, so what is asserted here is the part
  // this module can see. A row with no `from` is the placeholder problem all over again.
  return conn.kind === "email" && !!String((conn.config as Record<string, unknown>)?.from ?? "").trim();
}

/**
 * Boot gate, and the counterpart of `assertWedgeRolesValid`.
 *
 * Every `shape` in the table must have a normaliser, and — the one that would actually bite — a
 * capability the kernel parses must have at least one provider that can be read. Called from
 * `createServer` with the registry, injected rather than imported so this module stays free of the
 * parser graph and the check is testable against a fixture table.
 */
export function assertCapabilityTableValid(
  hasShape: (capability: CapabilityName, shape: string) => boolean,
  /**
   * `hasActionShape` from capabilities.act.ts. Optional ONLY so a fixture table can be validated for
   * its reads alone; `createServer` always passes it, and a deployment that did not would boot with
   * a send verb whose adapter key points at nothing — the exact failure the read gate already
   * catches on the other side.
   */
  hasActionShape?: (capability: CapabilityName, shape: string) => boolean,
): void {
  const faults: string[] = [];
  const table = providerTable();
  for (const capability of ALL_CAPABILITIES) {
    const providers = table[capability] ?? [];
    const seen = new Set<string>();
    for (const p of providers) {
      if (seen.has(p.toolkit)) {
        faults.push(`${capability}: "${p.toolkit}" is listed twice, and only the first would ever bind`);
      }
      seen.add(p.toolkit);
      for (const r of p.reads ?? []) {
        if (!hasShape(capability, r.shape)) {
          faults.push(
            `${capability}/${p.toolkit}: read "${r.slug}" names the shape "${r.shape}", which no normaliser provides — ` +
              `that provider would connect, look correct, and read nothing`,
          );
        }
      }
      for (const a of p.actions ?? []) {
        if (hasActionShape && !hasActionShape(capability, a.shape)) {
          faults.push(
            `${capability}/${p.toolkit}: action "${a.slug}" names the shape "${a.shape}", which no adapter provides — ` +
              `that provider would connect, look correct, and never send anything`,
          );
        }
      }
    }
    if (CAPABILITIES[capability].kernel_parses && !providers.some((p) => (p.reads ?? []).length)) {
      faults.push(`${capability} is parsed by the kernel but no provider in the table declares a read`);
    }
    if (CAPABILITIES[capability].kernel_acts && !providers.some((p) => (p.actions ?? []).length)) {
      faults.push(`${capability} is performed by the kernel but no provider in the table declares an action`);
    }
  }
  if (faults.length) {
    throw new Error(`[mycel] ${faults.length} problem(s) in the capability provider table:\n` + faults.map((f) => `  · ${f}`).join("\n"));
  }
}

/**
 * ═══ WHICH WEDGES DOES THIS PROJECT ACTUALLY RUN? ═══
 *
 * Extracted from `GET /v1/capabilities` so the rule can be tested without a server, because the
 * rule is the entire bug and it had been getting the answer "all of them" in production.
 *
 * THE FAILURE, OBSERVED: a design studio reached the sixth screen of onboarding and was asked
 * *"Read the invoices you've raised — For Monthly Close for E-commerce"*, offering Xero, QuickBooks
 * and FreshBooks. The founder, again: *"I'm not a bookkeeping company, for fuck's sake."*
 *
 * THE CAUSE: the route listed every wedge DIRECTORY on disk and narrowed it by
 * `identity.projectAllowsWedge`, which returns true for every wedge when a project's allowlist is
 * empty — and nothing in the kernel ever populates that allowlist. So the narrowing was a no-op,
 * every install ships `books-keeper`, and `needed_by` was non-empty for the bookkeeping
 * capabilities on every project in existence. A surface listing what the SOFTWARE can do, wearing
 * the authority of what THIS business asked for.
 *
 * THE RULE, which the cloud already argues in `app-suggestions.ts` and which is now applied at the
 * source rather than in one consumer: a business the founder set up is one with a SCHEDULE. A
 * blueprint file on disk means nothing — every install carries all of them — and the durable trace
 * that a business was actually stood up is the schedule that standing it up creates. The join is
 * the schedule's `wedge`, never its name, so a rename does not silently empty this.
 *
 * `allows` stays in the pipeline but only as a NARROWING filter, and only for on-disk slugs. It is
 * a permission check, never a membership check; conflating those two is what produced the bug.
 * Authored slugs are per-project by construction and are never on the allowlist, so subjecting them
 * to it would delete exactly the wedges the founder wrote himself — the same bug pointing the other
 * way, which is how this route came to report every capability EXCEPT the ones this business had
 * genuinely declared.
 */
export function projectWedgeSlugs(args: {
  schedules: readonly { project_id?: string | null; wedge: string }[];
  projectId: string;
  /** `identity.projectAllowsWedge`, passed in so this stays pure. */
  allows: (wedge: string) => boolean;
  /** `isAuthoredSlug`, passed in for the same reason. */
  authored: (wedge: string) => boolean;
}): string[] {
  const { schedules, projectId, allows, authored } = args;
  // A falsy project id would otherwise match every schedule whose own project is unset. Two
  // cross-tenant leaks have shipped in this repo; neither of them is going to be this one.
  if (!projectId) return [];
  const out = new Set<string>();
  for (const s of schedules) {
    if (s.project_id !== projectId) continue;
    if (!s.wedge) continue;
    if (!authored(s.wedge) && !allows(s.wedge)) continue;
    out.add(s.wedge);
  }
  return [...out];
}
