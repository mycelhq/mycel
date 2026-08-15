#!/usr/bin/env node
/**
 * Create (or reuse) one AgentMail inbox + webhook pointing at Mycel's public proxy.
 *
 * Requires an ORGANIZATION-scoped API key. Inbox-scoped keys (`am_us_inbox_…`) cannot create
 * webhooks or inboxes — create an org key at https://console.agentmail.to.
 *
 * Usage:
 *   AGENTMAIL_API_KEY=am_… node kernel/harness/scripts/setup-agentmail.mjs
 *   AGENTMAIL_API_KEY=am_… WEBHOOK_URL=https://app.mycelai.dev/api/agentmail/webhook \
 *     INBOX_USERNAME=gtm DOMAIN=gtm.mycelai.dev node kernel/harness/scripts/setup-agentmail.mjs
 */
const API = (process.env.AGENTMAIL_API_URL ?? "https://api.agentmail.to").replace(/\/+$/, "");
const KEY = (process.env.AGENTMAIL_API_KEY ?? "").trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL ?? "https://app.mycelai.dev/api/agentmail/webhook").trim();
const USERNAME = (process.env.INBOX_USERNAME ?? "gtm").trim();
const DOMAIN = (process.env.DOMAIN ?? "").trim(); // empty → AgentMail default domain
const DISPLAY = (process.env.DISPLAY_NAME ?? "Mycel GTM").trim();

if (!KEY) {
  console.error("Set AGENTMAIL_API_KEY to an organization-scoped key (not am_us_inbox_…).");
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.hint || data?.message || text.slice(0, 400);
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function main() {
  console.log("AgentMail setup");
  console.log(`  API:     ${API}`);
  console.log(`  webhook: ${WEBHOOK_URL}`);

  const inboxBody = {
    username: USERNAME,
    display_name: DISPLAY,
    ...(DOMAIN ? { domain: DOMAIN } : {}),
  };
  console.log(`\n1) Creating inbox ${USERNAME}${DOMAIN ? `@${DOMAIN}` : ""}…`);
  let inbox;
  try {
    inbox = await call("POST", "/v0/inboxes", inboxBody);
  } catch (e) {
    console.error(String(e.message || e));
    console.error("\nIf this failed with missing_permission, your key is inbox-scoped or incomplete.");
    console.error("Create an org key at https://console.agentmail.to with inbox_* + webhook_* permissions.");
    process.exit(1);
  }
  const inboxId = inbox.inbox_id || inbox.id;
  const address = inbox.email || inbox.address || `${USERNAME}@${DOMAIN || "agentmail.to"}`;
  console.log(`   inbox_id: ${inboxId}`);
  console.log(`   address:  ${address}`);

  console.log("\n2) Creating webhook…");
  const webhook = await call("POST", "/v0/webhooks", {
    url: WEBHOOK_URL,
    event_types: ["message.received", "message.bounced"],
    inbox_ids: [inboxId],
  });
  const webhookId = webhook.webhook_id || webhook.id;
  const secret = webhook.secret || webhook.client_secret || webhook.svix_secret || "";
  console.log(`   webhook_id: ${webhookId}`);
  console.log(`   secret:     ${secret ? `${String(secret).slice(0, 12)}…` : "(not in response — copy from console)"}`);

  console.log(`
3) Store in AWS (eu-west-2):

aws secretsmanager put-secret-value --secret-id mycel/agentmail --secret-string '${JSON.stringify({
    api_key: KEY,
    webhook_secret: secret || "whsec_PASTE_FROM_CONSOLE",
  })}'

4) In Mycel Apps → Email, create/connect inbox_id=${inboxId} address=${address}

5) Redeploy kernel+worker so AGENTMAIL_* env picks up the secret.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
