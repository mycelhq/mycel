// "Draft a proposal" — the closer asset after a prospect replies. No network: `complete` is
// injected, the same way draft-message.ts is driven in its test.
//
// What matters here is the degradation contract the route leans on, plus the honesty guarantee: a
// valid model object becomes a structured `ReportDocumentInput` the branded renderer can lay out; an
// over-long section is clipped so the proposal still fits a page; every failure mode becomes
// `undefined` so the surface degrades to "no draft yet"; and the model is never asked to invent
// facts about the prospect beyond the three it is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftProposal, MAX_BODY, MAX_SECTIONS } from "../src/gtm/proposal";
import type { chatComplete } from "../src/litellm";
import { render } from "../src/render";
import { resolveBrandKit } from "../src/brandkit";

const KIT = resolveBrandKit({ display_name: "Ledgerly", accent: "#0f766e" }, "proj");

const args = {
  orgId: "org_1",
  prospect: { name: "Dana Reid", company: "Acme Ltd", headline: "Head of Finance at Acme Ltd" },
  sells: "automated invoice chasing for agencies",
  sells_to: "agency owners",
  name: "Ledgerly",
};

/** A `complete` stub that always returns the given object as JSON. */
const object = (o: unknown) => (async () => JSON.stringify(o)) as unknown as typeof chatComplete;

test("a valid model object becomes a structured, renderable document", async () => {
  const complete = object({
    title: "A proposal for Acme Ltd",
    sections: [
      { heading: "What we understand", body: "You lead finance at Acme and chasing invoices eats your week." },
      { heading: "How we'd help", body: "We take invoice chasing off your desk end to end." },
      { heading: "Next step", body: "A short call to see if it fits." },
    ],
  }) as unknown as typeof chatComplete;
  const doc = await draftProposal({ ...args, complete });
  assert.ok(doc, "a valid object must produce a document");
  assert.equal(doc.title, "A proposal for Acme Ltd");
  assert.match(doc.subtitle ?? "", /Dana Reid/);
  // Three sections → heading+paragraph pairs the report renderer understands.
  assert.equal(doc.blocks.filter((b) => b.kind === "heading").length, 3);
  assert.equal(doc.blocks.filter((b) => b.kind === "paragraph").length, 3);
  // And it actually renders to a real branded PDF through the existing pipeline.
  const out = render("report", doc, KIT);
  assert.equal(out.content_type, "application/pdf");
  assert.ok(out.size_bytes > 500);
});

test("an over-long section body is clipped so the proposal still fits", async () => {
  const complete = object({
    title: "Proposal",
    sections: [
      { heading: "How we'd help", body: "x".repeat(MAX_BODY + 500) },
      { heading: "Next step", body: "A short call." },
    ],
  }) as unknown as typeof chatComplete;
  const doc = await draftProposal({ ...args, complete });
  assert.ok(doc);
  const para = doc.blocks.find((b) => b.kind === "paragraph") as { text: string };
  assert.ok(para.text.length <= MAX_BODY, `expected <= ${MAX_BODY}, got ${para.text.length}`);
  assert.ok(para.text.endsWith("…"));
});

test("more than five sections are trimmed to a one-pager", async () => {
  const complete = object({
    title: "Proposal",
    sections: Array.from({ length: 9 }, (_, i) => ({ heading: `H${i}`, body: `Body ${i}.` })),
  }) as unknown as typeof chatComplete;
  const doc = await draftProposal({ ...args, complete });
  assert.ok(doc);
  assert.equal(doc.blocks.filter((b) => b.kind === "heading").length, MAX_SECTIONS);
});

test("model failure (undefined) yields undefined — the surface offers no draft", async () => {
  const doc = await draftProposal({ ...args, complete: (async () => undefined) as unknown as typeof chatComplete });
  assert.equal(doc, undefined);
});

test("unparseable / too-thin output yields undefined", async () => {
  const junk = await draftProposal({ ...args, complete: (async () => "not json at all") as unknown as typeof chatComplete });
  assert.equal(junk, undefined);
  const thin = await draftProposal({
    ...args,
    complete: object({ title: "Proposal", sections: [{ heading: "Only one", body: "Not enough." }] }) as unknown as typeof chatComplete,
  });
  assert.equal(thin, undefined, "fewer than two usable sections is not a proposal");
});

test("no org and no offer both refuse before any model call", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return "{}";
  }) as unknown as typeof chatComplete;
  assert.equal(await draftProposal({ ...args, orgId: undefined, complete: spy }), undefined);
  assert.equal(await draftProposal({ ...args, sells: undefined, complete: spy }), undefined);
  assert.equal(called, false, "a refusal must not spend a model call");
});

test("no invented prospect facts: only the three given facts reach the prompt", async () => {
  let seen = "";
  const capture = (async (a: { system: string; user: string }) => {
    seen = `${a.system}\n${a.user}`;
    return JSON.stringify({
      title: "Proposal",
      sections: [
        { heading: "A", body: "one" },
        { heading: "B", body: "two" },
      ],
    });
  }) as unknown as typeof chatComplete;
  await draftProposal({ ...args, complete: capture });
  // The exact facts we hold appear; the system prompt forbids inventing anything past them.
  assert.match(seen, /Dana Reid/);
  assert.match(seen, /Acme Ltd/);
  assert.match(seen, /Head of Finance/);
  assert.match(seen, /Invent NO facts/i);

  // A prospect with unknown company/headline is passed as "(unknown)", never guessed.
  seen = "";
  await draftProposal({ ...args, prospect: { name: "Sam" }, complete: capture });
  assert.match(seen, /Company: \(unknown\)/);
  assert.match(seen, /Headline \/ role: \(unknown\)/);
});
