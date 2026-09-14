/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * FIFTEEN OF FIFTEEN: THE CLIENT WAS NEVER TOLD
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured against production on 14 September — every deliverable ever released, joined against
 * outbound messages to that client within a day of the release:
 *
 *     Ridgeline — April AI visibility      09 Sep    told: 0
 *     Fairmont Dental — listings audit     07 Sep    told: 0
 *     Willow & Pine — pricing page copy    06 Sep    told: 0
 *     ... fifteen of fifteen, told: 0
 *
 * `THE-BAR.md` gate 1 reads "0 of 8 deliverables accepted by a client" and calls it "the single most
 * important number in this document". It was read as a quality problem for weeks. Nobody had been
 * told there was anything to accept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { announceRelease, announcementText, type AnnounceDeps } from "../src/release-announce";

const client = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  project_id: "p1",
  display_name: "Fairmont Dental",
  handles: ["jane@fairmont.example"],
  ...over,
}) as never;

const deps = (over: Partial<AnnounceDeps> = {}): AnnounceDeps => ({
  getClient: async () => client(),
  mintLink: () => ({ token: "mpl_abc" }),
  portalBase: () => "https://northgate.mycelai.dev",
  send: async () => ({ ok: true }),
  ...over,
});

const D = { project_id: "p1", client_id: "c1", title: "Fairmont Dental — listings audit" };

test("RELEASING THE WORK TELLS THE CLIENT", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const out = await announceRelease(
    deps({ send: async (a) => (sent.push(a), { ok: true }) }),
    D,
    { summary: "Twelve listings checked, three wrong." },
  );
  assert.equal(out.sent, true, out.detail);
  assert.equal(sent.length, 1, "the release sent nothing");
  assert.equal(sent[0]!.to, "jane@fairmont.example");
  assert.match(String(sent[0]!.subject), /listings audit/);
});

test("the message asks for the decision, which is what gate 1 measures", () => {
  /*
    A message that says "your report is ready" gets read. One that says what to do next gets
    answered, and the gate is measured in answers, not in opens.
  */
  const { text } = announcementText({ title: "X", summary: "Y", url: "https://e.example/portal/enter?token=t" });
  assert.match(text, /Accept it, or tell us what to change\./);
  assert.match(text, /https:\/\/e\.example\/portal\/enter\?token=t/);
});

test("it stays short, because the work is the thing", () => {
  // The founder's instruction for this surface was "minimize text". An email that explains the work
  // competes with the work.
  const { text } = announcementText({
    title: "Fairmont Dental — listings audit",
    summary: "Twelve listings checked, three wrong.",
    url: "https://e.example/portal/enter?token=t",
  });
  const words = text.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 45, `the announcement is ${words} words:\n${text}`);
});

test("NO ADDRESS IS AN ANSWER, NOT A SILENCE", async () => {
  /**
   * The whole bug in one assertion. Before this, a release with no reachable client returned `ok`
   * and the founder had no way to tell it apart from one that reached somebody. The sentence has to
   * name the remedy — an address is what makes a portal possible at all — rather than the condition.
   */
  const out = await announceRelease(deps({ getClient: async () => client({ handles: [] }) }), D, {});
  assert.equal(out.sent, false);
  assert.match(out.detail, /Fairmont Dental/, "the founder is not told WHICH client cannot be reached");
  assert.match(out.detail, /email address/);
});

test("a failed send reports the provider's own reason", async () => {
  const out = await announceRelease(deps({ send: async () => ({ ok: false, detail: "mailbox full" }) }), D, {});
  assert.equal(out.sent, false);
  assert.equal(out.detail, "mailbox full");
});

test("a send that throws is still an answer", async () => {
  // Never throws, and never blocks the release: the work IS with the client — it is in their portal
  // and it is the truth of the record. Failing the transition because an email bounced would trade
  // the delivery for the notification.
  const out = await announceRelease(deps({ send: async () => { throw new Error("connection reset"); } }), D, {});
  assert.equal(out.sent, false);
  assert.match(out.detail, /connection reset/);
});

test("NO PORTAL ADDRESS YET STILL SENDS", async () => {
  /*
    A tenant whose portal domain is not live still has a client who needs to know the work is done.
    "It is ready, tell us what you think" is strictly better than silence, and it is the state every
    business is in during its first week.
  */
  const sent: Array<Record<string, unknown>> = [];
  const out = await announceRelease(
    deps({ portalBase: () => undefined, send: async (a) => (sent.push(a), { ok: true }) }),
    D,
    {},
  );
  assert.equal(out.sent, true, out.detail);
  assert.doesNotMatch(String(sent[0]!.text), /undefined|null|Open it here/, "a broken link was sent");
  assert.match(String(sent[0]!.text), /Accept it, or tell us what to change\./);
});

test("the link is minted per release, never reused from the message body", async () => {
  // One-time links: two releases must not share a token, or the second email carries one already
  // exchanged and the client lands on a login screen.
  const tokens: string[] = [];
  let n = 0;
  const d = deps({
    mintLink: () => ({ token: `mpl_${++n}` }),
    send: async (a) => (tokens.push(String(a.text)), { ok: true }),
  });
  await announceRelease(d, D, {});
  await announceRelease(d, D, {});
  assert.match(tokens[0]!, /token=mpl_1/);
  assert.match(tokens[1]!, /token=mpl_2/);
});

test("work with no client says so rather than reporting success", async () => {
  const out = await announceRelease(deps({ getClient: async () => undefined }), D, {});
  assert.equal(out.sent, false);
  assert.match(out.detail, /no client/);
});

test("EVERY RELEASE ROUTE TELLS THE CLIENT, AND server.ts ACTUALLY SUPPLIES IT", () => {
  /**
   * The "built but never invoked" guard, which this repo needs more than most: the announcement is
   * an OPTIONAL dep, so a route can call it, a module can implement it, every unit test can pass,
   * and production can still send nothing because nobody wired it up. That is exactly how
   * `propose_reply` sat declared, routed and never once run.
   *
   * Three routes move a deliverable to `with_client` — release, release-with-edit, and the document
   * editor's save-and-send. All three must go through the one helper, so a fourth cannot be written
   * that forgets.
   */
  const routes = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

  /*
    `"with_client"` as the TARGET, not anywhere in the call. The first version counted the client's
    own verdict route — `transitionDeliverable(pid, id, kind, ["with_client"], ...)` — which
    transitions OUT of the state, and then demanded that route announce a release it is ending.
  */
  const releases = [...routes.matchAll(/transitionDeliverable\([^,]+,[^,]+,\s*"with_client"\s*,/g)].length;
  const tells = [...routes.matchAll(/await tellClient\(/g)].length;
  assert.ok(releases >= 3, `expected at least three release sites, found ${releases}`);
  assert.equal(tells, releases, `${releases} routes release work and ${tells} tell the client`);

  assert.match(server, /announceRelease:/, "server.ts does not supply the announcement — nothing is sent in production");
  assert.match(server, /from "\.\/release-announce"/, "server.ts no longer imports it");
});

test("the founder is told the outcome on the response they are already looking at", () => {
  // A release to a client with no email address must be visible in the second the founder pressed
  // the button, not on a sweep tomorrow.
  const routes = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");
  const bodies = [...routes.matchAll(/c\.json\(\{[^}]*released: true[\s\S]{0,200}?\}\)/g)].map((m) => m[0]);
  assert.ok(bodies.length >= 2, `expected the release responses, found ${bodies.length}`);
  for (const b of bodies) assert.match(b, /told/, `a release response does not carry the outcome:\n${b}`);
});
