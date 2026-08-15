#!/usr/bin/env node
/**
 * Bootstrap AgentMail for Mycel production.
 *
 * Needs an ORGANIZATION API key (console.agentmail.to → API keys → org-scoped).
 * An inbox-scoped key (`am_us_inbox_…`) cannot list inboxes or create webhooks.
 *
 *   AGENTMAIL_API_KEY=am_… \
 *   AGENTMAIL_WEBHOOK_URL=https://app.mycelai.dev/api/agentmail/webhook \
 *   node kernel/scripts/agentmail-bootstrap.mjs
 *
 * Creates (idempotent where possible):
 *   1. One shared GTM inbox (username gtm) on AgentMail's default domain — or AGENTMAIL_DOMAIN
 *   2. Org webhook → our cloud proxy → kernel, events message.received + message.bounced
 *   3. Prints JSON for Secrets Manager: mycel/agentmail
 *
 * Domain strategy (do not skip):
 *   · Customer invoice chase → THEIR Gmail/Outlook or THEIR verified domain. Never Mycel.
 *   · Mycel GTM (selling Mycel) → one outreach subdomain, separate from transactional mail.
 *   Mixing cold outreach and invoice replies on one domain burns reputation for both.
 */
import { writeFileSync } from "node:fs";

const API = (process.env.AGENTMAIL_API_URL ?? "https://api.agentmail.to").replace(/\/+$/, "");
const KEY = (process.env.AGENTMAIL_API_KEY ?? "").trim();
const WEBHOOK_URL =
  (process.env.AGENTMAIL_WEBHOOK_URL ?? "https://app.mycelai.dev/api/agentmail/webhook").trim();
const USERNAME = (process.env.AGENTMAIL_GTM_USERNAME ?? "gtm").trim().toLowerCase();
const DOMAIN = (process.env.AGENTMAIL_DOMAIN ?? "").trim().toLowerCase() || undefined;
const DISPLAY = process.env.AGENTMAIL_DISPLAY_NAME ?? "Mycel GTM";

if (!KEY) {
  console.error("Set AGENTMAIL_API_KEY to an ORGANIZATION key from https://console.agentmail.to");
  process.exit(1);
}
if (KEY.includes("_inbox_")) {
  console.error(
    "This looks like an inbox-scoped key (am_us_inbox_…). It cannot create webhooks.\n" +
      "Create an organization API key in the AgentMail console and retry.",
  );
  process.exit(1);
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const inboxBody = {
  username: USERNAME,
  display_name: DISPLAY,
  ...(DOMAIN ? { domain: DOMAIN } : {}),
  client_id: "mycel-gtm-shared",
};

console.log(`· Creating inbox ${USERNAME}@${DOMAIN ?? "agentmail.to"} …`);
let inbox;
try {
  inbox = await call("/v0/inboxes", { method: "POST", body: inboxBody });
} catch (e) {
  if (e.status === 409 || /already|exists/i.test(String(e.message))) {
    console.log("  (exists — listing to find it)");
    const list = await call("/v0/inboxes?limit=100");
    const items = list?.inboxes ?? list?.items ?? list ?? [];
    inbox = (Array.isArray(items) ? items : []).find(
      (i) =>
        i.client_id === "mycel-gtm-shared" ||
        i.username === USERNAME ||
        String(i.inbox_id ?? "").startsWith(`${USERNAME}@`),
    );
    if (!inbox) throw e;
  } else {
    throw e;
  }
}

const inboxId = inbox.inbox_id ?? inbox.id;
const address = inbox.email ?? inbox.address ?? inboxId;
console.log(`  ✓ inbox_id=${inboxId}  address=${address}`);

console.log(`· Creating webhook → ${WEBHOOK_URL} …`);
const webhook = await call("/v0/webhooks", {
  method: "POST",
  body: {
    url: WEBHOOK_URL,
    event_types: ["message.received", "message.bounced"],
    inbox_ids: [inboxId],
    client_id: "mycel-kernel",
  },
});

const secret = webhook.secret ?? webhook.webhook_secret;
if (!secret) {
  console.error("Webhook created but no secret returned — check AgentMail console for whsec_…");
  process.exit(1);
}

const out = {
  api_key: KEY,
  webhook_secret: secret,
  webhook_id: webhook.webhook_id ?? webhook.id,
  inbox_id: inboxId,
  address,
  webhook_url: WEBHOOK_URL,
};

const path = new URL("../../.context/agentmail-prod.json", import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
console.log(`\n✓ Wrote ${path.pathname}`);
console.log("\nPush to AWS (us-east-1):\n");
console.log(
  `aws secretsmanager put-secret-value --secret-id mycel/agentmail --secret-string '${JSON.stringify({
    api_key: KEY,
    webhook_secret: secret,
  })}'\n`,
);
console.log("Then redeploy kernel/worker so AGENTMAIL_* env vars pick up the secret.");
console.log("\nIn Mycel Apps → Email: connect this one shared inbox (do NOT mint one per org).");
