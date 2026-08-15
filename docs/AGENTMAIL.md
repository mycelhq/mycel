# AgentMail (prod) — live as of 2026-08-11

## Live resources

| Resource | Value |
|---|---|
| Org API key | in `mycel/agentmail` → `api_key` |
| Webhook | `ep_3HmykdZon7VYcMsmlxN8YRecriX` |
| Webhook URL | `https://app.mycelai.dev/api/agentmail/webhook` |
| Webhook secret | in `mycel/agentmail` → `webhook_secret` |
| Dogfood / ops inbox | `mycel@agentmail.to` |
| GTM inbox | `gotomarket@agentmail.to` |

Webhook listens to **both** inboxes (`message.received`, `message.bounced`).

## Public ingress

Cloud `proxy.ts` allows `/api/agentmail` without session (Svix signature is the auth).
Route forwards raw body + `svix-*` headers to the private kernel.

**Redeploy cloud** before AgentMail deliveries work in prod — until then `/api/agentmail/webhook` 307s to login.

## Domain split

| Use | Mailbox |
|---|---|
| **Invoice chase (customers)** | **Gmail / Outlook** via Apps / onboarding (white-label) |
| **Mycel GTM outbound** | `gotomarket@agentmail.to` (shared inbox, thread-first routing) |
| **Mycel dogfood / ops** | `mycel@agentmail.to` |

Do not chase customer invoices from `@agentmail.to` or a Mycel domain.

## Still needed from you

1. Redeploy **cloud** + **kernel** (secrets + proxy + thread-first + GTM send).
2. **Decodo** ISP username/password → `mycel/decodo`.
3. **FullEnrich** — key in `mycel/fullenrich-api-key`; `FULLENRICH_API_KEY` wired in `infra/services.tf` (redeploy kernel).
4. Optional: verify custom domain (`gtm.mycelai.dev`) in AgentMail + DNS when Rania’s domain is ready.
