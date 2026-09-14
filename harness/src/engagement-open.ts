// A CONTRACT WAS SIGNED. NOW SOMEBODY HAS TO DO THE WORK.
//
// ═══ THE LINK THAT WAS DECLARED AND NEVER CONNECTED ═══
//
// `signing.routes.ts` has carried an `onExecuted?: (env: Envelope) => Promise<void>` hook since it
// was written, called at both places a signature can complete the envelope. Nothing has ever passed
// one. So a fully executed agreement — the client typed their name, the certificate was sealed, the
// audit chain recorded it — did precisely nothing. The founder's timeline said "executed" and their
// Deliverables screen stayed empty forever.
//
// Found by `evals/driver/scenario-close-the-loop.mjs`, which got as far as sending the envelope and
// then reported, correctly, "no deliverable has been produced for this client".
//
// ═══ WHY THIS IS NOT JUST "RUN KICKOFF" ═══
//
// The case the proposal was written against is a PROSPECT case on `gtm-operator`, and gtm-operator
// is machinery: it finds people and stops. It declares no `fulfillment` block, so
// `productionTaskType` correctly returns undefined for it and the ignition sweep correctly skips it.
// Running kickoff on the prospect case would produce nothing and look like it had worked.
//
// The work happens on a DELIVERY case, on a wedge that actually delivers something. That handoff —
// prospect who signed → engagement being worked — is the one the console performs by hand today
// (`convertProspect`, where a founder picks the trade). This does it when the paper is signed,
// which is the moment it becomes true.
//
// ═══ AND IT REFUSES TO GUESS THE TRADE ═══
//
// A business running one fulfillment wedge has an unambiguous answer and gets it. A business running
// three does not, and picking one would open the engagement on the wrong desk — a bookkeeping client
// on the content desk, work drafted against the wrong exemplars, and a founder who now has to notice
// and undo it. Nothing is worse here than a wrong guess made silently, so zero-or-many leaves a note
// on the case naming exactly what it could not decide, and the founder converts it themselves.
import type { Case } from "./contract";
import type { Envelope } from "./signing";
import { getDomainStore } from "./domain";
import { getIdentityStore } from "./identity";
import { productionTaskType } from "./fulfillment-ignite";
import { readBusinessShape, type BusinessShape } from "./business-shape";
import type { Store } from "./store";
import { loadProjectWedge, promotedSlugs } from "./authored";
import { runKickoffPlaybook } from "./kickoff";
import { ensureProjectMailbox } from "./mailbox-ensure";
import { readMoneyPlan } from "./money-plan";
import { ensureUpkeepQuietly } from "./upkeep";

/** Where the signed engagement points at the work, and the work points back. */
export const DELIVERY_CASE_KEY = "delivery_case_id";
const SIGNED_FROM_KEY = "signed_from_case_id";

/**
 * Which of this project's wedges does the work.
 *
 * `productionTaskType` is the authority and it is asked directly rather than re-deriving its rule:
 * it already answers "does this wedge turn a run into something a client receives", including the
 * authored-service default, the operational-name refusals, and the `waits_for` spine. A wedge it
 * answers `undefined` for cannot be the answer here either.
 */
/**
 * Exported for its tests, like `productionTaskType` next door. The rule it encodes — which trade
 * delivers a signed engagement — is the one place a firm's own written service either becomes real
 * work or does not, and it deserves to be asserted directly rather than through a signed envelope.
 */
export async function deliveryWedge(projectId: string, exclude: string, store: Store): Promise<string | undefined> {
  /**
   * ═══ ASK THE BUSINESS WHAT IT DOES, BEFORE INFERRING IT ═══
   *
   * The first version read the project's `wedges` list and looked for exactly one producer in it.
   * Two things were wrong with that, and together they meant a real signed contract landed on no
   * desk at all:
   *
   *   · AN EMPTY `wedges` LIST MEANS *ALL* WEDGES, NOT NONE. `projectAllowsWedge` reads
   *     `p.wedges.length === 0 || p.wedges.includes(w)` — the list is a RESTRICTION, and no
   *     restriction is the default. Iterating it found zero candidates for every ordinary project.
   *   · EVEN READ CORRECTLY IT WOULD REFUSE. An unrestricted install offers several trades that
   *     deliver — books-keeper, content-desk, recruiting-desk, site-builder — so "exactly one" is
   *     never true, and the founder would be asked to convert by hand forever.
   *
   * The answer was never an inference. `draft_shape` asks the founder what their business does and
   * records `runs_as.wedge`, copied character for character out of the catalogue. That is their own
   * statement of their trade, made before any of this, and it is the first thing asked here.
   */
  const shape = await readBusinessShape(store, projectId).catch(() => ({}) as BusinessShape);
  /**
   * ═══ `direct` ONLY, AND `adjacent` IS NOT A NEAR MISS ═══
   *
   * This accepted either, and the two mean opposite things. `direct` is the trade the firm SELLS;
   * `adjacent` is a trade we ship that helps the firm's own back office. The shaper is explicit
   * about which it means — read from production on 13 September:
   *
   *     Northlight Studio (brand identity + Webflow) → invoice-chaser, fit=adjacent,
   *     covers "Chases YOUR overdue invoices by email and escalates on a schedule."
   *
   * This function picks the service a CLIENT's engagement opens on. Taking that `adjacent` answer
   * would open an engagement in a design client's name on invoice chasing and send that client
   * intake questions about it. Four of the fifteen real businesses shaped so far are design studios
   * sitting on exactly that answer, and the engagement sweep now asks this question on a clock — so
   * a wrong answer here is no longer one founder's confusing afternoon, it is outbound mail.
   *
   * An `adjacent` firm therefore falls through to the authored-service path below, which is correct:
   * a brand studio's client work is not in the catalogue, and that is precisely the case a service
   * gets written for.
   */
  const declared = shape.fit === "direct" ? shape.wedge?.trim() : undefined;
  if (declared && declared !== exclude && (await productionTaskType(projectId, declared))) {
    return declared;
  }

  /*
   * No shape, or a trade the catalogue does not cover — which is the case a service gets WRITTEN
   * for. Fall back to a project that has narrowed itself to exactly one producing wedge, which is
   * unambiguous when it happens. Anything else stays a refusal: see the header on why a desk chosen
   * wrongly and silently is worse than a founder converting by hand.
   */
  /**
   * ═══ THE FIRM'S OWN CRAFT IS A CANDIDATE, AND IT WAS NOT ═══
   *
   * `shape.wedge` above is only set when the shaping run judged the business a `direct` or
   * `adjacent` fit to one of the ten trades we ship (business-shape.ts). A firm the catalogue does
   * NOT cover therefore arrives here with `declared` undefined — and a firm the catalogue does not
   * cover is exactly the firm we write a bespoke service for.
   *
   * So the one case authored services exist to serve was the one case this function could not
   * answer. It read `project.wedges`, a RESTRICTION list that is empty on every real project
   * (an empty list means all trades allowed, not none), found nothing, and returned undefined.
   *
   * MEASURED IN PRODUCTION: three services written from real firms, one promoted and live, and
   * 143 engagements — every one of them on `gtm-operator`, `books-keeper`, `geo-monitor` or
   * `recruiting-desk`. Not one on a craft we learned. `promotedSlugs` existed, was tested, and had
   * no production caller at all.
   *
   * A promoted service is a stronger candidate than a catalogue trade, not a weaker one: somebody
   * read it and pressed Go live, which is a more specific statement about this business than a
   * shaping run's similarity judgement. It is still gated on `productionTaskType`, so a service
   * that cannot actually produce a deliverable is no more eligible than before.
   */
  const restricted = getIdentityStore().getProject(projectId)?.wedges ?? [];
  const written = await promotedSlugs(projectId).catch(() => [] as string[]);
  const candidates: string[] = [];
  for (const w of [...written, ...restricted]) {
    if (w === exclude || candidates.includes(w)) continue;
    if (await productionTaskType(projectId, w)) candidates.push(w);
  }
  /**
   * STILL EXACTLY ONE. Ambiguity refuses rather than guesses, which is the rule this function
   * already had and the reason it is safe to widen the pool: a firm with two live services gets a
   * human decision, not a coin toss on whose letterhead the work goes out under.
   */
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Open the engagement the signature just created, and start it.
 *
 * IDEMPOTENT on the prospect case's `delivery_case_id`. An envelope can execute once, but the hook
 * is called from two routes and a retry must not open a second engagement against one signature —
 * that would be two kickoffs, two deposit invoices, and two runs at the same client.
 */
export async function openEngagementFromSignature(env: Envelope, store: Store): Promise<string | undefined> {
  if (env.status !== "executed" || !env.project_id || !env.client_id || !env.case_id) return undefined;
  const domain = getDomainStore();
  const source = await domain.getCase(env.case_id).catch(() => undefined);
  if (!source) return undefined;

  const data = (source.data ?? {}) as Record<string, unknown>;
  const existing = typeof data[DELIVERY_CASE_KEY] === "string" ? (data[DELIVERY_CASE_KEY] as string) : "";
  if (existing) return existing;

  /*
   * A signature against a case that ALREADY delivers is an expansion or a renewal, not a new
   * engagement — the work is on the desk it was always on. Kickoff runs on it (idempotent by
   * `kickoff_at`) so a renewal that changed the money gets the new plan, and nothing is opened.
   */
  if (await productionTaskType(env.project_id, source.wedge)) {
    await startWork(source);
    return source.id;
  }

  const wedge = await deliveryWedge(env.project_id, source.wedge, store);

  /**
   * ═══ MOST SERVICE BUSINESSES DO THEIR OWN WORK, AND THE MONEY STILL HAS TO HAPPEN ═══
   *
   * The first version of this returned here when it could not find a desk, on the reasoning that a
   * signature with nowhere to deliver is a signature nobody can act on. That is true of half the
   * market and false of the other half — probably the larger half.
   *
   * A recruitment agency places warehouse staff. Mycel cannot place warehouse staff. What it can do
   * is find the 3PL opening a second depot, open the conversation, write the engagement from the
   * call, put it up for signature, raise the invoice and chase the retainer. Their FULFILLMENT is
   * empty and their LOOP is the entire product. Same for a consultancy, a design studio, a surveyor,
   * anyone whose work happens in a room or on a site.
   *
   * Refusing to act on their signature because nothing here can produce a deliverable gets it
   * exactly backwards: it withholds the invoice — the part they are paying us for — because we
   * cannot do the part they never asked us to do.
   *
   * So there are two shapes and both close:
   *
   *   WITH a trade we can run  → a delivery case on that desk, kickoff, production on the clock.
   *   WITHOUT one              → kickoff ON THE PROSPECT CASE. The client exists, the money plan is
   *                              on it from the signed proposal, so the invoice is raised and
   *                              chased exactly the same. The work is theirs and always was.
   *
   * The second path opens no new case on purpose. A case on a desk that cannot produce anything
   * would sit in Deliverables forever looking like work that never started.
   */
  if (!wedge) {
    await startWork(source);
    await domain
      .updateCase(
        source.id,
        {},
        {
          at: new Date().toISOString(),
          kind: "note",
          // Says what happened and what is theirs, rather than reporting an absence as a fault.
          note: `${env.title} is signed and the first invoice is raised. The work itself is yours — nothing here delivers it, and nothing here will pretend to.`,
          actor: "system",
        },
      )
      .catch(() => undefined);
    return source.id;
  }

  const now = new Date().toISOString();
  /**
   * The wedge's OWN opening stage, exactly as `POST /v1/cases` resolves it. A case created with a
   * stage the wedge does not declare is invisible to every sweep that filters by stage — the case
   * would exist, look fine on a list, and never be picked up by anything.
   */
  const loaded = await loadProjectWedge(env.project_id, wedge).catch(() => null);
  const stages = loaded?.manifest.cases?.stages ?? [];
  const stage = loaded?.manifest.cases?.initial ?? stages[0] ?? "open";
  /**
   * ═══ THE CLIENT SHOULD NOT SEE THEIR OWN NAME AS THE NAME OF THE WORK ═══
   *
   * `title: source.title` carried the PROSPECT case's title across, and a prospect case is titled
   * with the person — `enrollProspect` sets `title: p.name ?? p.profile_id`. Correct there: in a
   * pipeline you are looking at people. Wrong the moment it becomes an engagement, and visible to
   * exactly the wrong audience — the client portal's "In progress" list showed Priya Raman two rows
   * of "Priya Raman", which is what her own supplier apparently calls the work they do for her.
   *
   * The signed proposal already has the right words. `agreed_terms.headline` is what they are buying
   * in their own terms, checked by the gate and printed on the paper they signed, so the engagement
   * and the contract say the same thing. Falls back to the prospect title, because a case with no
   * name at all is worse than one named after a person.
   */
  const agreed = (data.agreed_terms ?? {}) as { headline?: unknown };
  const headline = typeof agreed.headline === "string" ? agreed.headline.trim() : "";

  const opened = await domain.createCase({
    project_id: env.project_id,
    wedge,
    title: headline || source.title,
    client_id: env.client_id,
    stage,
    status: "open",
    data: {
      [SIGNED_FROM_KEY]: source.id,
      envelope_id: env.id,
      // The terms `openProposalEnvelope` wrote when it drafted the paper. Carried across rather than
      // re-derived from the PDF: this is what the client agreed to, and kickoff bills from it.
      ...(data.money_plan ? { money_plan: data.money_plan } : {}),
      ...(data.agreed_terms ? { agreed_terms: data.agreed_terms } : {}),
      ...(typeof data.contact_email === "string" ? { contact_email: data.contact_email } : {}),
    },
    history: [{ at: now, kind: "created", note: `opened from a signed agreement — ${env.title}`, actor: "system" }],
  });

  // Both directions. The prospect case is the idempotency key above, and the founder reading either
  // screen should be able to get to the other one.
  await domain
    .updateCase(
      source.id,
      { data: { ...data, [DELIVERY_CASE_KEY]: opened.id } },
      { at: now, kind: "note", note: "signed — the work opened on its own desk", actor: "system" },
    )
    .catch(() => undefined);

  await startWork(opened);
  return opened.id;
}

/**
 * Kickoff, and nothing beyond it.
 *
 * `runKickoffPlaybook` raises the intake asks the wedge declares and drafts the deposit invoice from
 * the money plan. It deliberately does NOT start production — `sweepFulfillmentIgnition` does that,
 * on its own claim-once marker, once the case is ready. Spawning the run from here would race the
 * sweep and bypass the readiness rule (intake answered, or deposit paid, or the timer), which exists
 * so a client is not sent work drafted before they answered the questions it depends on.
 *
 * Fails soft and loudly: a signature that is recorded and a kickoff that is not is recoverable by
 * hand, and throwing would fail the SIGNATURE route — telling a client their signature did not go
 * through when it did, which is the worst available lie.
 */
export async function startWork(kase: Case): Promise<void> {
  const domain = getDomainStore();

  /**
   * AN ADDRESS TO ASK FROM, BEFORE THE THING THAT ASKS.
   *
   * Ordered above kickoff deliberately. `runKickoffPlaybook` creates a thread only when a channel
   * already exists, and stamps `thread_id` on the intake asks from it — so a mailbox arriving one
   * line later reproduces exactly the state this fixes: asks with no thread, on a project that now
   * has an inbox.
   *
   * Never fatal. `ensureProjectMailbox` returns a reason rather than throwing, and the `catch` is
   * belt-and-braces: a signed engagement opening is worth more than an address, and the asks it
   * raises are answerable in the portal either way. See that module's header for the measurement
   * that made this necessary — twenty-one projects, one channel, and it was the QA one.
   */
  const pid = kase.project_id;
  const wedge = kase.wedge;
  // Both are optional on `Case`. A case with neither cannot be routed to an inbox anyway, and
  // saying so beats asserting them and finding out in a stack trace.
  const production = pid && wedge ? await productionTaskType(pid, wedge).catch(() => undefined) : undefined;
  const mailbox =
    pid && wedge && production
      ? await ensureProjectMailbox({
          project_id: pid,
          wedge,
          task_type: production,
          project_name: getIdentityStore().getProject(pid)?.name,
        }).catch((e: unknown) => ({ ok: false as const, reason: String(e) }))
      : { ok: false as const, reason: `nothing to route: project=${pid ?? "?"} wedge=${wedge ?? "?"}` };
  if (!mailbox.ok) {
    // Logged, not raised — but logged, because a silently degraded loop is how this got to
    // fifty-one asks and three answers.
    console.warn(`[mycel] ${pid} has no mailbox and one could not be made: ${mailbox.reason}`);
  } else if (mailbox.created) {
    console.log(`[mycel] ${pid} can now email clients from ${mailbox.address}`);
  }

  try {
    await runKickoffPlaybook({ domain, kase, money_plan: readMoneyPlan(kase.data) });
  } catch (e) {
    console.error(`[mycel] signed engagement ${kase.id} opened but kickoff did not run:`, e);
  }
  /**
   * And make sure the clock that STARTS it exists.
   *
   * `ensureUpkeepQuietly` arms the ignition sweep only when the project already has a
   * deliverable-producing engagement open — which, for a business whose first client just signed, is
   * true for the first time as of the line above. Without this the engagement sits open and ready
   * and nothing ever looks at it, which is a worse failure than not opening it at all: it looks
   * exactly like work in progress.
   *
   * The same pairing the authored promote route makes, for the same reason, and quiet for the same
   * reason: a schedule that could not be created must not undo a signature.
   */
  if (kase.project_id) {
    await ensureUpkeepQuietly(domain, kase.project_id).catch((e) =>
      console.error(`[mycel] could not arm the clock for engagement ${kase.id}:`, e),
    );
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A CLIENT ARRIVING IS ITSELF A GO-SIGNAL
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything above opens an engagement when paper is SIGNED. That is the right trigger for a firm
 * that sells through proposals, and it is the only trigger the product had — which left the
 * commonest case in the market with nothing at all: a founder who already has the client, adds them,
 * and expects the desk to start.
 *
 * ═══ THE PRODUCTION SEQUENCE THAT MADE THIS NECESSARY ═══
 *
 * A four-person brand studio finished onboarding on 14 August 2026. The shaper wrote them a service
 * they agreed to — four jobs, a four-stage case machine, three intake questions good enough to send
 * a client verbatim. They put it on the clock. It ran `shape_brand_strategy` six times across five
 * days, succeeded five times, and produced zero deliverables, because the project had zero clients
 * and therefore zero engagements. Then they stopped opening the product.
 *
 * `delivery-precondition.ts` is the defensive half of that finding: stop burning a model call every
 * morning on work with no recipient. THIS is the offensive half, and it is the one that matters —
 * the moment a client exists, the desk should open the engagement, ask that client the questions the
 * service says it needs, and start the work when the answers land. Nothing above needed to be built
 * for it: `runKickoffPlaybook` already sends the intake asks and the connection invites,
 * `fulfillment-ignite` already starts production once they are answered, and `waits.ts` already
 * parks and resumes. The link from "a client exists" to "the engagement is open" was the only
 * missing piece, and it is thirty lines.
 *
 * ═══ WHAT IT REFUSES TO GUESS ═══
 *
 * Exactly what `deliveryWedge` refuses to guess, because it is the same function. One live producing
 * service is unambiguous and gets opened. Two is a decision about whose letterhead the work goes out
 * under, and a founder makes that — `convertProspect` is one click and it is theirs.
 *
 * A client who already has an open case is left alone: a second engagement opened behind somebody's
 * back is the failure mode this whole file's idempotency is written against.
 */
export async function openEngagementForNewClient(
  projectId: string,
  client: { id: string; display_name?: string },
  store: Store,
): Promise<string | undefined> {
  if (!projectId || !client?.id) return undefined;
  const domain = getDomainStore();

  // Already engaged. Adding a second client to the same business must not reopen the first one's
  // work, and a re-run of this (a retried request, a replayed event) must be a no-op.
  const existing = await domain
    .listCases({ project_id: projectId, client_id: client.id })
    .catch(() => []);
  if (existing.length) return undefined;

  // `exclude` is empty: there is no source case to avoid here, unlike the signature path where the
  // prospect's own gtm case must not be mistaken for a desk.
  const wedge = await deliveryWedge(projectId, "", store).catch(() => undefined);
  if (!wedge) return undefined;

  const loaded = await loadProjectWedge(projectId, wedge).catch(() => null);
  const stages = loaded?.manifest.cases?.stages ?? [];
  const stage = loaded?.manifest.cases?.initial ?? stages[0] ?? "open";
  const now = new Date().toISOString();

  const opened = await domain.createCase({
    project_id: projectId,
    wedge,
    // The client's name, not the service's: this is the engagement with THEM, and it is what the
    // founder scans a list of engagements looking for.
    title: client.display_name?.trim() || "New engagement",
    client_id: client.id,
    stage,
    status: "open",
    data: {},
    history: [
      {
        at: now,
        kind: "created",
        note: `opened when ${client.display_name?.trim() || "this client"} was added — ${loaded?.manifest.title ?? wedge} is the only service live here`,
        actor: "system",
      },
    ],
  });

  /*
    The same `startWork` the signature path runs: a mailbox to ask through, the kickoff playbook that
    sends the intake questions and the connection invites, and the clock armed. Failures inside it are
    logged rather than raised — an engagement that opened and whose kickoff did not is recoverable and
    visible, and failing the caller would make adding a client look broken.
  */
  await startWork(opened);
  return opened.id;
}
