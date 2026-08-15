import { test } from "node:test";
import assert from "node:assert/strict";
import { actionPreview, redactPreview } from "../src/actions";
import type { Connection } from "../src/contract";

const composio = {
  id: "c1", project_id: "p1", kind: "composio", name: "Xero",
  owner: { kind: "founder", id: "founder" },
  config: { toolkit: "xero" }, created_at: "",
} as unknown as Connection;

test("preview: a credential in a tool argument never reaches the approval row", async () => {
  // The preview is PERSISTED in the approvals table and RENDERED to a human, so anything in it
  // outlives the run and gets read. Some brokered tools take a token as an argument; once one lands
  // here it is in the database, in the UI, and in anything that reads either.
  const out = actionPreview(composio, "XERO_CREATE_INVOICE", {
    arguments: {
      amount: 420,
      contact: "Acme Ltd",
      webhook_secret: "whsec_do_not_persist_me",
      api_key: "sk-live-nope",
      nested: { authorization: "Bearer abc123", note: "fine" },
    },
  });
  const args = (out as { arguments: Record<string, unknown> }).arguments;

  // Redacted, not dropped: a human deciding whether to approve should see THAT a token was going to
  // be sent, just not what it is.
  assert.equal(args.webhook_secret, "[redacted]");
  assert.equal(args.api_key, "[redacted]");
  assert.equal((args.nested as Record<string, unknown>).authorization, "[redacted]");

  // …while everything the human actually needs to judge the action survives intact.
  assert.equal(args.amount, 420);
  assert.equal(args.contact, "Acme Ltd");
  assert.equal((args.nested as Record<string, unknown>).note, "fine");

  assert.ok(!JSON.stringify(out).includes("whsec_do_not_persist_me"));
  assert.ok(!JSON.stringify(out).includes("sk-live-nope"));
  assert.ok(!JSON.stringify(out).includes("Bearer abc123"));
});

test("preview: a document argument is summarised, not copied", () => {
  // An argument can be a whole attachment. A preview is a summary for a human to judge, not a
  // second copy of the payload sitting in the approvals table forever.
  const body = "x".repeat(50_000);
  const out = redactPreview({ body }) as { body: string };
  assert.ok(out.body.length < 500, "truncated");
  assert.match(out.body, /\[50000 chars\]$/, "and says how much was elided, so nobody thinks that was all of it");
});

test("preview: depth and length are bounded so the card stays readable", () => {
  // Unreadable JSON trains people to approve without looking, which is the worst possible outcome
  // for a gate whose entire value is that it gets read.
  const deep = { a: { b: { c: { d: { e: "too far" } } } } };
  assert.equal(JSON.stringify(redactPreview(deep)).includes("too far"), false);
  assert.match(JSON.stringify(redactPreview(deep)), /nested/);

  const many = { items: Array.from({ length: 100 }, (_, i) => `row ${i}`) };
  const out = redactPreview(many) as { items: string[] };
  assert.equal(out.items.length, 21, "20 plus a count of what was left out");
  assert.match(String(out.items.at(-1)), /80 more/);
});

test("preview: still shows the destination, which is the point of the gate", () => {
  // A preview that only echoes what the agent asked for is not a check on the agent.
  const email = {
    id: "c2", project_id: "p1", kind: "email", name: "Support",
    owner: { kind: "founder", id: "founder" },
    config: { url: "https://api.postmark.example/send" }, created_at: "",
  } as unknown as Connection;
  const out = actionPreview(email, "send_email", { to: "client@example.com", subject: "July close" });
  assert.equal((out as { to: string }).to, "client@example.com");
  assert.match(JSON.stringify(out), /postmark/);
});

test("preview: a brokered send carries the recipient at the top level, like every other kind", () => {
  // Every non-Composio kind sets `to`, and the approval card renders it as its own row. A brokered
  // send set it nowhere, so a founder approving `composio:GMAIL_SEND_EMAIL` saw a toolkit and a
  // tool slug and had to find who it reached inside the arguments blob — on the one card in this
  // product whose entire purpose is that it gets read.
  const gmail = { ...composio, name: "Gmail", config: { toolkit: "gmail" } } as unknown as Connection;
  const out = actionPreview(gmail, "GMAIL_SEND_EMAIL", {
    arguments: { recipient_email: "sarah@harborline.example", subject: "July close" },
  }) as Record<string, unknown>;
  assert.equal(out.to, "sarah@harborline.example");

  // A list of recipients names the first rather than nothing.
  const many = actionPreview(gmail, "GMAIL_SEND_EMAIL", {
    arguments: { to: ["sarah@harborline.example", "ap@harborline.example"] },
  }) as Record<string, unknown>;
  assert.equal(many.to, "sarah@harborline.example");

  // Unsure means silent. A WRONG recipient on an approval card is worse than none, so a tool whose
  // arguments hold no recognised recipient key simply omits the row, exactly as before.
  const unknown = actionPreview(composio, "XERO_CREATE_INVOICE", { arguments: { amount: 12 } }) as Record<string, unknown>;
  assert.equal(unknown.to, undefined);

  // And a redacted key is never un-redacted on the way to the top level.
  const secret = actionPreview(gmail, "GMAIL_SEND_EMAIL", {
    arguments: { to: "x@y.example", authorization: "Bearer abc" },
  }) as Record<string, unknown>;
  assert.ok(!JSON.stringify(secret).includes("Bearer abc"));
});
