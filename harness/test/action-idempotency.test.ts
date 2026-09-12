// The same send, arriving twice.
//
// The dangerous case is not a write that fails — that is visible and recoverable. It is a write
// that SUCCEEDS while the caller never learns it did: the message goes, the response is lost to a
// timeout, the agent retries, and two emails reach the prospect. No protocol fixes this at the
// transport layer; at-least-once delivery plus idempotent APPLY is the only construction that
// works, and the action route is the apply side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

/** The route's own derivation, mirrored so the SHAPE of the key can be reasoned about here. */
const key = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

test("the key is scoped to the intent, not the attempt", () => {
  // The same message retried is the same key — that is the whole mechanism.
  const first = key(["task-1", "send_email", "conn-1", "sue@acme.com", "Quick question", "body"]);
  const retry = key(["task-1", "send_email", "conn-1", "sue@acme.com", "Quick question", "body"]);
  assert.equal(first, retry);

  // Genuinely different messages from ONE task must both go. If the key were scoped to the task
  // alone, a wedge that sends two emails would silently send one.
  const second = key(["task-1", "send_email", "conn-1", "bob@acme.com", "Quick question", "body"]);
  assert.notEqual(first, second, "a different recipient is a different intent");
  const reworded = key(["task-1", "send_email", "conn-1", "sue@acme.com", "Quick question", "other"]);
  assert.notEqual(first, reworded, "a different body is a different intent");
});

test("the route derives the key server-side rather than trusting the caller", () => {
  // `POST /v1/tasks` takes a caller-supplied `idempotency-key`, which is the standard pattern and
  // the wrong one here: this caller is a language model in a sandbox, and asking it to reproduce
  // the same key on a retry is asking it to be deterministic about what it is worst at. A retry
  // would arrive with a fresh key and dedupe nothing.
  const route = server.slice(server.indexOf('app.post("/v1/internal/actions/:capability"'));
  const head = route.slice(0, 8000);
  assert.match(head, /const intentKey = createHash\("sha256"\)/, "the key is no longer derived");
  assert.ok(
    !/c\.req\.header\("idempotency-key"\)/.test(head),
    "the action route started trusting a caller-supplied key",
  );
});

test("the claim happens before the approval gate, so a retry does not queue a second card", () => {
  const route = server.slice(server.indexOf('app.post("/v1/internal/actions/:capability"'));
  const claimAt = route.indexOf('putIfAbsent(\n        "action_idem"');
  const gateAt = route.indexOf("HUMAN APPROVAL GATE");
  assert.ok(claimAt > 0, "the idempotency claim is gone");
  assert.ok(gateAt > 0, "the approval gate is gone");
  assert.ok(claimAt < gateAt, "a duplicate now reaches the founder as a second approval to read");
});

test("its own namespace, so it cannot answer task creation's question", () => {
  const store = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "store.ts"),
    "utf8",
  );
  assert.match(store, /"action_idem"/, "the grant kind is gone");
  // "has this task been created" and "has this message already gone" are different questions. A
  // shared namespace lets one answer the other on a nonce collision.
  assert.match(store, /"idem"\s*\|\s*"action_idem"/, "the two idempotency namespaces were merged");
});

test("it fails open, because the approval gate is the primary defence", () => {
  // Blocking a legitimate send because the grant store blipped would cost a real message to keep a
  // receipt. The duplicate still meets a human on every path except a standing grant, which is
  // exactly the path this protects.
  const route = server.slice(server.indexOf('app.post("/v1/internal/actions/:capability"'));
  assert.match(
    // Generously wide: this route is heavily commented, and the claim sits ~150 lines in.
    route.slice(0, 20000),
    /action idempotency check failed, proceeding/,
    "the dedupe stopped failing open — a store blip now blocks sends",
  );
});
