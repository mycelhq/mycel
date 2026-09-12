/**
 * ═══ A MAILBOX THAT CAN SEND AND CANNOT RECEIVE ═══
 *
 * Found by provisioning the first customer inbox this system has ever had and sending through it.
 * The send worked — HTTP 200, a real SES message id, a real thread id. Nothing came back: no
 * thread row, no message row, no task.
 *
 * The org webhook was real, enabled and correctly addressed. It was also scoped to
 * `inbox_ids: ["gotomarket@agentmail.to","mycel@agentmail.to"]` — two inboxes we registered by hand
 * in August. Every inbox provisioned since could send and could not receive.
 *
 * That is the worst failure shape this product has: we email a client a question, the client
 * replies, the reply is delivered to an inbox nobody is listening to, and the founder concludes
 * their client ignored them. Nothing errors.
 *
 * The route already refuses a mailbox with no `wedge`/`task_type` because "an inbox nothing runs on
 * is a mailbox that swallows replies". This is the same sentence, one layer down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f: string) =>
  readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

test("provisioning an inbox checks it can receive, and says so in the answer", () => {
  const s = src("server.ts");
  const i = s.indexOf("ensureInboxDelivery(cfg, inboxId)");
  assert.ok(i > -1, "provisioning no longer verifies inbound delivery");

  // It must not throw the mailbox away: sending works, and failing the request would destroy
  // something useful over a problem the founder can be told about.
  assert.match(s.slice(i, i + 300), /\.catch\(/, "a webhook read that fails would fail the whole provision");

  // And the verdict has to reach the caller. A console line is not a product surface.
  assert.match(s, /inbox_id: inboxId, delivery \}/, "the delivery verdict never leaves the server");
});

test("a scoped webhook is reported, not silently half-repaired", async () => {
  /**
   * The first version of this tried to widen the webhook in place. Measured against the live API on
   * 6 September, that is impossible: `PATCH /v0/webhooks/{id}` returns 200 and changes nothing —
   * empty array, null and a full replacement list all left the filter untouched and `updated_at`
   * reading August — and it returns 200 for `{"nonsense_field":1}` as well, so it ignores its body.
   * `PUT` is a 404.
   *
   * Delete-and-create works and issues a NEW signing secret, which means rotating
   * `AGENTMAIL_WEBHOOK_SECRET` and redeploying. That is an operator action, not something to run
   * inside a founder's click. So the function reports, and the message says exactly what to do.
   */
  const s = src("agentmail.ts");
  const body = s.slice(s.indexOf("export async function ensureInboxDelivery"));
  assert.ok(!/method: "PATCH"/.test(body), "it still tries a PATCH the API ignores");
  assert.match(body, /an operator must recreate the webhook/, "the message does not say how to fix it");
  assert.match(body, /arrive and fire nothing/, "the message does not say what breaks");
});

test("an already-covered inbox is left alone", async () => {
  // Two shapes count as covered: a hook with no filter, and a hook naming this inbox. Neither
  // should trigger a write — a PATCH per provision is a needless mutation of shared config.
  const { ensureInboxDelivery } = await import("../src/agentmail");
  assert.equal(typeof ensureInboxDelivery, "function");
  const s = src("agentmail.ts");
  const body = s.slice(s.indexOf("export async function ensureInboxDelivery"));
  assert.match(body, /!h\.inbox_ids \|\| h\.inbox_ids\.length === 0/, "an org-wide hook is not recognised as covering");
  assert.match(body, /\.includes\(inboxId\)/, "a hook already naming this inbox is not recognised as covering");
  assert.match(body, /h\.enabled !== false/, "a disabled webhook would be treated as coverage");
});
