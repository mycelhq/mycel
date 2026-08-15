# Decodo ISP setup (LinkedIn egress)

Mycel talks to LinkedIn Voyager from ECS. Datacenter egress gets accounts restricted, so every
session needs a **sticky ISP proxy near the member**. Decodo (ex-Smartproxy) is the default ops path.

## Honest: no API provision

Decodo's management API can create **residential (pay-per-GB) sub-users**. It cannot buy or assign
**dedicated ISP IPs**. Those are purchased in the dashboard (Static Residential → Dedicated ISP),
then Mycel **auto-builds** the gateway URL from the bought pool:

`http://user-{name}-country-{cc}:{password}@isp.decodo.com:{stickyPort}`

A 4th country is a dashboard buy, then add the ISO code to `MYCEL_DECODO_COUNTRIES`. Until then a
US (or any unbought) connect fails with **"no residential line in this country yet"** — it will not
silently use France.

## What a self-serve user does

1. Start a plan (Find $49 includes 1 LinkedIn; Mycel pays Decodo COGS).
2. Connect LinkedIn: pick country (France / Spain / UK / …), paste `li_at` + `JSESSIONID`.
3. Kernel leases that country's dedicated IP to this LinkedIn member forever (same cookies → same
   IP). No proxy URL to paste. "I have my own proxy" is collapsed, for operators only.

## Kernel env

```bash
MYCEL_LINKEDIN_PROXY_PROVIDER=decodo
MYCEL_DECODO_USERNAME=your_dashboard_user   # `user-` prefix added if missing
MYCEL_DECODO_PASSWORD=…
MYCEL_DECODO_COUNTRIES=fr,es,gb             # bought dedicated IPs; one seat per country
# optional
MYCEL_DECODO_HOST=isp.decodo.com
MYCEL_DECODO_PORT_BASE=10001                # FR=10001, ES=10002, GB=10003
```

Wire credentials into ECS / Secrets Manager — never git:

```bash
aws secretsmanager put-secret-value --secret-id mycel/decodo \
  --secret-string '{"username":"…","password":"…"}'
```

Terraform sets `MYCEL_LINKEDIN_PROXY_PROVIDER=decodo`, `MYCEL_DECODO_COUNTRIES=fr,es,gb`, and
injects username/password from that secret.

## Verify

```bash
curl -s "$KERNEL/v1/linkedin/proxy-pool" -H "authorization: Bearer $KEY"
# POST /v1/linkedin/connect  { "li_at": "…", "jsessionid": "…", "country": "fr" }
```

`provider: "decodo"` and a leased URL means it is working. See `VERIFY-LINKEDIN.md`.

## Ops status (2026-08-13)

- Dedicated sticky ISP purchased (3 IPs: FR, ES, UK spare). Username/password live in
  Secrets Manager `mycel/decodo` — never in git. Host is the Decodo gateway
  (`isp.decodo.com:10001+`), not the egress IP.
- Username form: `user-{dashboardUser}-country-{cc}`. Rotating port `10000` is never used.
- Islam → `fr`, Rania → `es`. UK stays unused until a UK member. Connect is country + cookies.
