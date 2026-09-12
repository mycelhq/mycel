/**
 * MAIL FROM OURSELVES IS NOT A CUSTOMER.
 *
 * A founder opened their Clients room and found exactly one client: "Mycel Go-to-Market",
 * `gotomarket@agentmail.to`. Our own outreach mailbox, promoted to customer because intake creates
 * a client for whoever sent the message, and the message was a QA probe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bareAddress,
  isOurOwnAddress,
  isPlatformAddress,
  isInternalClient,
} from "../src/internal-sender.ts";

test("our own outreach mailbox is not a client", () => {
  assert.equal(isPlatformAddress("gotomarket@agentmail.to"), true);
  assert.equal(isPlatformAddress("Mycel Go-to-Market <gotomarket@agentmail.to>"), true);
  assert.equal(isPlatformAddress("hello@mycelai.dev"), true);
  assert.equal(isPlatformAddress("anything@mycelai.dev"), true);
});

test("agentmail.to is where CUSTOMERS live and must never be excluded wholesale", () => {
  // The failure this guards is invisible: a domain rule would stop every tenant on agentmail.to
  // from ever gaining a client, and an empty Clients room looks like a quiet week.
  assert.equal(isPlatformAddress("jane@agentmail.to"), false);
  assert.equal(isPlatformAddress("qa-walkthrough-desk@agentmail.to"), false);
  assert.equal(isPlatformAddress("northgate@agentmail.to"), false);
});

test("a project's own desk address is a loop, not a correspondent", () => {
  const own = ["qa-walkthrough-desk@agentmail.to"];
  assert.equal(isOurOwnAddress("qa-walkthrough-desk@agentmail.to", own), true);
  // Plus-addressing is how a loop disguises itself.
  assert.equal(isOurOwnAddress("qa-walkthrough-desk+case123@agentmail.to", own), true);
  assert.equal(isOurOwnAddress("Desk <QA-Walkthrough-Desk@AgentMail.to>", own), true);
});

test("another tenant's desk is an ordinary correspondent", () => {
  // `ownAddresses` must be scoped to the project. If it ever gets the whole table, every tenant
  // stops being able to email every other tenant.
  assert.equal(isOurOwnAddress("someone-elses-desk@agentmail.to", ["my-desk@agentmail.to"]), false);
});

test("a real customer is still a real customer", () => {
  assert.equal(isOurOwnAddress("owner@northgate.co.uk", ["desk@agentmail.to"]), false);
  assert.equal(isOurOwnAddress("Jane <jane@example.com>", []), false);
});

test("addresses are unwrapped and case-folded before comparison", () => {
  assert.equal(bareAddress("Mycel <GoToMarket@Agentmail.TO>"), "gotomarket@agentmail.to");
  assert.equal(bareAddress("  mailto:a@b.com "), "a@b.com");
});

test("a client row carrying the internal mark is hidden", () => {
  assert.equal(isInternalClient({ metadata: { internal: true } }), true);
  // Legacy marks found on production rows. Nothing in src/ writes these; the intent was recorded by
  // hand and had no reader, so both rows rendered as real customers.
  assert.equal(isInternalClient({ metadata: { synthetic: true } }), true);
  assert.equal(isInternalClient({ metadata: { self: true } }), true);
  assert.equal(isInternalClient({ metadata: { internal: "yes" } }), false);
  assert.equal(isInternalClient({ metadata: {} }), false);
  assert.equal(isInternalClient({ metadata: null }), false);
  assert.equal(isInternalClient({}), false);
});

test("the intake path marks the row and refuses to start work", () => {
  // Both halves, read off the source: the client is created with the internal mark, and `silent`
  // is forced so no run is spawned. Either one alone leaves half the bug.
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function acceptIntake"), src.indexOf("// ── Deliverables"));
  assert.match(fn, /const fromUs = isOurOwnAddress\(/, "intake no longer asks whether the sender is us");
  assert.match(fn, /if \(fromUs\) args = \{ \.\.\.args, silent: true \};/, "an internal sender can start a run again");
  assert.match(fn, /metadata: fromUs \? \{ \.\.\.INTERNAL_CLIENT_METADATA \} : \{\}/, "the internal mark is no longer written");
});

test("the clients list is the chokepoint", () => {
  const src = readFileSync(new URL("../src/clients.routes.ts", import.meta.url), "utf8");
  assert.match(src, /inScope\(set, cl\.project_id\) && !isInternalClient\(cl\)/,
    "GET /v1/clients stopped filtering internal rows — every room downstream shows them again");
});
