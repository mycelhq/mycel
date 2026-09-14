// A JOB THAT DELIVERS TO A CLIENT MUST HAVE ONE.
//
// ═══ THE PRODUCTION RUN ═══
//
// A four-person brand studio finished onboarding on 14 August 2026. The shaper wrote them a service
// — four jobs, a four-stage case machine, three good intake questions — and they put it on the
// clock. It ran `shape_brand_strategy` on the 15th, 15th, 16th, 17th, 18th and 19th. Five succeeded.
// In that project: 0 clients, 0 cases, 0 connections, 0 deliverables, 0 invoices. Every run carried
// `client_id = NULL`.
//
// The service shaped the brand strategy of nobody, five times, spending a sandbox and a model call
// each morning, finishing green each time. Then the founder stopped opening the product.
//
// These pin the rule that stops it: the precondition refuses fulfilment work with no recipient, and
// refuses NOTHING ELSE — the kernel's own machinery has no client by design and must keep running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryRefusal, deliversToAClient } from "../src/delivery-precondition";
import type { WedgeManifest } from "../src/wedge";

/** The brand studio's real manifest, trimmed to the fields this decision reads. */
const AUTHORED: Pick<WedgeManifest, "fulfillment" | "task_types" | "title"> = {
  title: "Brand identity and marketing websites",
  // `fulfillment: null` in the row. An authored service with no block still delivers a document —
  // `fulfillmentOf` applies that default at run time, and reading the absent field as "delivers
  // nothing" here would exempt exactly the services this protects.
  task_types: {
    shape_brand_strategy: { description: "Turn positioning into a brand strategy" },
    build_marketing_website: { description: "Build the site" },
  } as WedgeManifest["task_types"],
};

const TRADE: Pick<WedgeManifest, "fulfillment" | "task_types" | "title"> = {
  title: "Monthly Close",
  fulfillment: { deliverable_shapes: ["document"] },
  task_types: {
    monthly_close: { description: "Close the month" },
    chase_receipts: { description: "Ask for what is missing", client_facing: false },
  } as WedgeManifest["task_types"],
};

const MACHINERY: Pick<WedgeManifest, "fulfillment" | "task_types" | "title"> = {
  title: "Find clients",
  task_types: { advance_sequences: { description: "Move everybody one step" } } as WedgeManifest["task_types"],
};

test("the run that actually happened is refused", () => {
  const r = deliveryRefusal({
    wedge: "drafted:brand-and-website-projects",
    manifest: AUTHORED,
    taskType: "shape_brand_strategy",
    clients: 0,
  });
  assert.ok(r, "a fulfilment job in a business with no clients still fires");
  assert.equal(r!.reason, "no_client");
  // The sentence is rendered verbatim to a founder, so it names the service, the job and the fix.
  assert.match(r!.message, /shape brand strategy/);
  assert.match(r!.message, /Brand identity and marketing websites/);
  assert.match(r!.message, /Add the client you are doing this for/);
});

test("one client is enough — the rest of the gates are softer on purpose", () => {
  /**
   * A founder with a client and no mailbox still gets the work drafted; `client-ready.ts` holds it
   * before it reaches anybody. That is a different and better stop than not running at all, and
   * widening this precondition to "and a mailbox, and a connection" would turn a product that
   * degrades into one that refuses.
   */
  assert.equal(
    deliveryRefusal({ wedge: "drafted:x", manifest: AUTHORED, taskType: "shape_brand_strategy", clients: 1 }),
    undefined,
  );
});

test("a run already aimed at somebody is never refused", () => {
  // A case episode, a kickoff and a wait resume all carry their own target. The count is irrelevant
  // to them — and a resume refused here would strand an engagement mid-flight.
  for (const aim of [{ clientId: "c1" }, { caseId: "k1" }]) {
    assert.equal(
      deliveryRefusal({ wedge: "drafted:x", manifest: AUTHORED, taskType: "shape_brand_strategy", clients: 0, ...aim }),
      undefined,
      `a run with ${Object.keys(aim)[0]} was refused`,
    );
  }
});

test("the kernel's own machinery has no client by design and keeps running", () => {
  /**
   * THE FAILURE THE NARROW TEST PREVENTS. Finding clients, reconciling payments, sweeping waits and
   * authoring a service all run with no client, correctly — a precondition that refused them would
   * stop a brand-new business from ever acquiring the client it is being told to add.
   */
  assert.equal(
    deliveryRefusal({ wedge: "gtm-operator", manifest: MACHINERY, taskType: "advance_sequences", clients: 0 }),
    undefined,
  );
  assert.equal(deliversToAClient("gtm-operator", MACHINERY, "advance_sequences"), false);
});

test("a trade's own machinery opts out while its craft does not", () => {
  // `chase_receipts` asks the client for something; it hands nothing over. The opt-out is per task
  // type and only ever narrows — a job that delivers is described by the wedge, not by a flag.
  assert.equal(deliversToAClient("books-keeper", TRADE, "monthly_close"), true);
  assert.equal(deliversToAClient("books-keeper", TRADE, "chase_receipts"), false);
  assert.ok(deliveryRefusal({ wedge: "books-keeper", manifest: TRADE, taskType: "monthly_close", clients: 0 }));
  assert.equal(
    deliveryRefusal({ wedge: "books-keeper", manifest: TRADE, taskType: "chase_receipts", clients: 0 }),
    undefined,
  );
});

test("an unknown wedge is not second-guessed", () => {
  // No manifest means no declaration, which means no opinion — the same answer `inputFaults` gives
  // for a task type with no schema. Inventing a contract here would refuse runs on a deployment
  // that ships a subset of the catalogue.
  assert.equal(deliveryRefusal({ wedge: "ghost", manifest: undefined, taskType: "anything", clients: 0 }), undefined);
});

test("the unattended door applies it; the founder's own door does not", () => {
  /**
   * ═══ WHERE A REFUSAL BELONGS, AND WHERE IT IS JUST IN THE WAY ═══
   *
   * The first version of this also refused `POST /v1/tasks`, and that was the wrong instinct. A
   * founder pressing Run is a deliberate act by somebody who is watching; telling them no is a gate
   * in front of the one person allowed to decide, and it broke a dozen tests that start a job with
   * no client because starting a job with no client is a perfectly ordinary thing to do on purpose.
   *
   * The waste this exists to stop is UNATTENDED and REPEATING: a schedule firing every morning,
   * spending a sandbox and a model call on work with no recipient, for as long as nobody notices.
   * That is where it refuses, and only there.
   *
   * A schedule that disabled itself would be the product silently undoing a decision the founder
   * made, and the desk would be off on the morning they finally add a client. It refuses THIS
   * firing and stays on.
   */
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");

  const scheduler = src("scheduler.ts");
  assert.match(scheduler, /deliveryRefusal\(\{/, "the scheduler does not apply the precondition");
  // The tick loop and nothing else. `skipIdle` is what the tick passes; fire-now, a blueprint
  // activating and a service going live all call `fireSchedule` directly and must go through.
  assert.match(scheduler, /if \(manifest && skipIdle\) \{/, "the precondition applies to an attended firing too");
  assert.match(scheduler, /did not fire: \$\{refusal\.message\}/, "the refusal is not written where anybody can read it");
  const block = scheduler.slice(scheduler.indexOf("const refusal = deliveryRefusal"));
  assert.ok(
    !/updateSchedule\([^)]*enabled:\s*false/.test(block.slice(0, 900)),
    "the schedule disables itself when it refuses",
  );

  const server = src("server.ts");
  assert.ok(
    !/deliveryRefusal/.test(server),
    "POST /v1/tasks refuses a job with no client — that is a gate in front of the person allowed to decide",
  );
});
