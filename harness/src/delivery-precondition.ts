// A JOB THAT DELIVERS TO A CLIENT MUST HAVE ONE.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PRODUCTION RUN THIS EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A real founder — a four-person brand studio — finished onboarding on 14 August. The shaper wrote
// them a service, `drafted:brand-and-website-projects`: four jobs (brand strategy → visual identity
// → website build → review), a four-stage case machine, three intake questions good enough to use
// verbatim in a client kickoff. They read it, agreed to it, and put it on the clock.
//
// It then ran `shape_brand_strategy` on 15, 15, 16, 17, 18 and 19 August. Five succeeded. And in
// that project, on the day this was written:
//
//     clients 0   ·   cases 0   ·   connections 0   ·   deliverables 0   ·   invoices 0
//
// Every one of those runs carried `client_id = NULL` and `case_id = NULL`. The service shaped the
// brand strategy of nobody, five times, each time spending a model call and a sandbox, each time
// finishing green. Then the founder stopped opening the product.
//
// Nothing in the system was wrong in isolation. The schedule fired because it was enabled. The run
// succeeded because the agent did the job it was given. The artifact was stored because it was
// produced. `deliverables.wrap` handed it to no client because there was no client, and that is
// correct behaviour — you cannot deliver to nobody.
//
// What was missing is the sentence somebody should have read on 15 August: *this job produces
// something for a client and you have not added one yet.*
//
// ═══ WHY A PRECONDITION AND NOT A BETTER EMPTY STATE ═══
//
// Because the cost is asymmetric and it compounds. A run is money — a sandbox, a model call, and on
// a daily rhythm it is that every morning for as long as the founder leaves it on. A refusal is
// free and it is information. `inputFaults` in `scheduler.ts` already makes exactly this trade for a
// schedule whose input cannot satisfy its contract, with the same reasoning written next to it: a
// template that will fail identically at every future firing must not be deferred, it must be
// refused loudly.
//
// This is the same rule one level up. Not "your input is malformed" but "there is nobody at the
// other end of this".
//
// ═══ WHAT IT DOES NOT DO ═══
//
// It does not refuse work that has no client BY DESIGN. Most of the kernel's own jobs are internal
// machinery — finding clients, reconciling payments, sweeping waits, authoring a service — and none
// of them delivers anything to anybody. The test is the wedge's own declaration
// (`fulfillment.deliverable_shapes`, the same field `compile.ts` uses to decide a job is
// client-facing, and the same field `withSpine` uses to decide a trade gets the delivery spine), so
// a service says for itself whether it hands something over.
//
// And it never refuses a run that HAS a client, however little else is set up. A founder with one
// client and no mailbox still gets the work drafted; the capability gate holds it before it reaches
// anybody (`client-ready.ts`), which is a different and softer stop than not running at all.
import { isAuthoredSlug, type WedgeManifest } from "./wedge";

/** Why a fulfilment job cannot start, in the founder's words, with the fix in the sentence. */
export interface DeliveryRefusal {
  /** Stable, for a surface that wants to branch: the console shows a different button per reason. */
  reason: "no_client";
  /** One sentence. Said to a founder, never to a developer — it is rendered verbatim. */
  message: string;
}

/**
 * Does this task type hand something to a client?
 *
 * Wedge-level `fulfillment.deliverable_shapes` is the declaration, with the authored default that
 * `fulfillmentOf` applies: a written service with no fulfilment block still produces a document,
 * because without that default its runs go green and Deliverables stay empty — which is the failure
 * this whole file is about, arriving one layer down.
 *
 * A task type may opt out with `client_facing: false`. That is for the machinery a trade carries
 * alongside its craft: `books-keeper` chases receipts and nudges requests, and neither hands over a
 * deliverable. Opting IN is not offered — a job that delivers is described by the wedge, not by a
 * flag somebody remembered to set.
 */
export function deliversToAClient(
  wedge: string,
  manifest: Pick<WedgeManifest, "fulfillment" | "task_types"> | undefined,
  taskType: string,
): boolean {
  if (!manifest) return false;
  const spec = manifest.task_types?.[taskType] as { client_facing?: unknown } | undefined;
  if (spec && spec.client_facing === false) return false;
  const shapes = manifest.fulfillment?.deliverable_shapes ?? [];
  if (shapes.length > 0) return true;
  /*
    An authored service with no fulfilment block. `fulfillmentOf` gives it `["document"]` at run
    time, so it DOES deliver, and reading the absent field as "delivers nothing" here would exempt
    exactly the services this exists to protect — every one written by the shaper before
    `deliverable_shapes` was something it knew to emit. The brand studio's manifest has
    `fulfillment: null`.
  */
  return isAuthoredSlug(wedge);
}

/**
 * Can this fulfilment job start?
 *
 * `undefined` means yes. Anything else is a refusal to render.
 *
 * `clients` is the COUNT in the project rather than a list: the question is whether this business
 * has anybody to deliver to at all, and a count is one cheap read where a list is a page of rows
 * nothing here would look at.
 */
export function deliveryRefusal(args: {
  wedge: string;
  manifest: Pick<WedgeManifest, "fulfillment" | "task_types" | "title"> | undefined;
  taskType: string;
  /** How many clients this project has. */
  clients: number;
  /** Set when the caller already aimed the run at somebody — a case episode, a kickoff, a resume. */
  clientId?: string;
  /** An engagement carries its own client; a task on a case is aimed by construction. */
  caseId?: string;
}): DeliveryRefusal | undefined {
  if (args.clientId || args.caseId) return undefined;
  if (args.clients > 0) return undefined;
  if (!deliversToAClient(args.wedge, args.manifest, args.taskType)) return undefined;

  const what = args.taskType.replace(/_/g, " ");
  const service = (args.manifest?.title ?? "").trim();
  return {
    reason: "no_client",
    message:
      `"${what}" produces something for a client${service ? ` — it is part of ${service}` : ""}, and this ` +
      `business has no clients yet. Add the client you are doing this for and it will run for them; ` +
      `until then there is nobody to hand the work to.`,
  };
}
