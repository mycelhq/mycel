# AGENTS.md

Context for coding agents working in this repo. Humans want [README.md](./README.md); this is the
detail that would clutter it.

Format: [agents.md](https://agents.md) — the open convention, so any agent finds it without being told.

## Commands

```bash
npm i
npm run check     # typecheck + the whole suite. The one command before you push.
npm test          # the suite alone, in-process, no keys and no Docker
npm run typecheck # tsc --noEmit
npm run demo      # boot + seed + the ranked moves, one terminal, no keys
npm run demo:kernel # the server alone, for iterating on the seed with demo:seed
```

Run `npm run typecheck` even when `npm test` is green. They fail on different things: a backtick
inside a SQL string in a template literal breaks the template, and only `tsc` sees it — the suite
passes because nothing imports the broken module.

Run `npm test` from `kernel/`, not from `kernel/harness/` — the script lives in the root
`package.json` and a bare `npx tsx --test` inside `harness/` reports hundreds of phantom failures.

Durability suite, only if you have Postgres:

```bash
MYCEL_TEST_DATABASE_URL=postgres://... npm test
```

Some tests `# SKIP` with a reason naming a sibling that lives in a private monorepo and is not
published here. They skip rather than fail so a stranger's clone is green **honestly**.

Needs Node 20+ and git. Docker / Daytona / Postgres only if you choose those backends. A real run
needs an `opencode` binary and a provider key.

## The `[mock]` trap

With `MYCEL_RUNTIME=mock`, every task **succeeds** — real schema, real contract — and every string
field is the literal `[mock]`. That is the fake runtime stamping a placeholder. It is not a broken
model, and mock must never be able to impersonate one.

The other first-run failure: defaults are `opencode` + `local` sandbox. With no `opencode` binary
the task sits on `start_opencode` for 60s, then reports `opencode failed to start (no log)`. There
is no log because the process never existed.

Boot prints both. `npm test` and `npm run demo` use mock on purpose.

## Environment

| Var | Default | |
|---|---|---|
| `MYCEL_RUNTIME` | `opencode` | `opencode` \| `mock` |
| `MYCEL_SANDBOX` | `local` | `local` \| `docker` \| `daytona` |
| `MYCEL_MODEL` | `standard` tier | provider-prefixed; per-task override in input |
| `MYCEL_API_KEY` | generated | printed on boot |
| `MYCEL_OWNER_EMAIL` / `MYCEL_OWNER_PASSWORD` | generated | owner login |
| `MYCEL_DATABASE_URL` | — | Postgres; else in-memory (gone on restart) |
| `MYCEL_PROXY_MODE` | `0` | model calls through the harness, so keys never enter the sandbox |
| `PORT` | `4000` | |
| `MYCEL_URL` | `http://localhost:4000` | which kernel `npm run demo:seed` targets (loopback only) |
| `MYCEL_APP_URL` | `http://localhost:3000` | where the console is, if you run one. The seed stores avatar URLs against it and links to it — and checks whether anything answers before it does |

`npm run dev` loads `.env` if present. Real env wins. `setup.sh` writes that file.

### Running it for real

Defaults are chosen for one machine. These are the ones a self-hoster actually reaches for.

| Var | Default | |
|---|---|---|
| `MYCEL_WORKER` | on | `0` gives an API-only replica; run a worker-only container against the same database to split them |
| `MYCEL_WORKER_CONCURRENCY` | `10` | tasks in flight per worker |
| `MYCEL_MAX_COST_USD` | `50` | ceiling per task. A task may ask for less, never more |
| `MYCEL_MAX_RUNTIME_S` | `10800` | ditto, for wall clock |
| `MYCEL_MAX_TOKENS` | `8192` | ditto, for one model call |
| `MYCEL_PUBLIC_URL` | `http://127.0.0.1:$PORT` | the address others reach this kernel at; used in links it emits |
| `MYCEL_PG_POOL_MAX` | `5` | Postgres connections per process |
| `MYCEL_SIGNUP_INVITE_ONLY` | off | close public signup |
| `MYCEL_KEEP_SANDBOX` | off | `1` leaves the sandbox up after a run, to look inside it |
| `MYCEL_EXIT_ON_PREFLIGHT_FAILURE` | off | `1` makes a failed sandbox preflight fatal. Off by default on purpose: a Daytona blip once restarted the fleet every eighty seconds, and the kernel serves the API fine without sandboxes |
| `MYCEL_LITELLM_URL` + `MYCEL_LITELLM_MASTER_KEY` | — | broker model calls through LiteLLM. With `MYCEL_PROXY_MODE=1` this counts as the upstream, so no provider key is needed on the harness |
| `MYCEL_CONTROL_TOKEN` | — | required by the ops routes that rewrite entitlements. Separate from every product key on purpose: one leaked product key must not be able to |
| `MYCEL_CAPABILITY_PROVIDERS` | — | override which provider serves a capability, without a code change |
| `MYCEL_IMAGE_OPENAI_KEY` | — | the image tool's OpenAI key, named separately so a deployment can point it at a secret it already holds |
| `MYCEL_LINKEDIN_MOCK` | off | `1` mocks the LinkedIn transport. Evals only — it is not a dry run |
| `MYCEL_OPERATE_PROXY_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` / `MYCEL_OPERATE_PROXY_COUNTRIES` | — | residential egress for operate-mode runs |

If the kernel ever names a variable in a message and it is not in one of these tables,
`harness/test/docs-do-not-lie.test.ts` fails. Being told to set something you cannot look up is the
bug that rule exists for.

### Outside services

Optional, all of them. Finding people, inviting, messaging and spotting replies run on a connected
LinkedIn account and need no key at all.

**Set one key per capability and that is the whole configuration** — the provider is inferred from
whichever key is present, so there is no second question to answer wrong.

| Capability | Set one of | Instant key |
|---|---|---|
| Web search | `SERPER_API_KEY` · `BRAVE_API_KEY` · `TAVILY_API_KEY` | all three |
| Places | `GOOGLE_PLACES_API_KEY` · `AZURE_MAPS_KEY` | neither — both need a cloud project |
| Crawling | `FIRECRAWL_API_KEY` · `JINA_API_KEY` | both |
| Contact enrichment | `HUNTER_API_KEY` · `FULLENRICH_API_KEY` | Hunter only |

Two keys for one capability resolve in **table order**, which answers "which wins" with the better
product. That is a different question from "which do we tell a newcomer to get", and conflating them
is how a cold boot ended up telling people to go and start a sales conversation. `instantKey` and
`shortestPath()` answer the second; only the suggestion reads them, never the resolution.

`MYCEL_SEARCH_PROVIDER`, `MYCEL_PLACES_PROVIDER`, `MYCEL_CRAWL_PROVIDER` and `MYCEL_ENRICH_PROVIDER`
override the order — and naming a provider whose key is missing is an error rather than a silent
fallback, because quietly using a different vendor is how a surprise bill arrives.

Adding one: put it in `PROVIDERS`, write the code, set `implemented: true`, and add it to
`.env.example`. `harness/test/provider-docs.test.ts` fails if the docs do not follow, in both
directions — an undocumented provider and a documented one that does not exist are both caught.

The kernel prints which of these are on at boot. `GET /v1/gtm/availability` answers the same live.

## Layout

```
harness/      /v1, orchestrator, sandbox, gate, stores
wedges/       services as config
skills/       procedures the agent reads mid-run
library/      what the kernel reads off disk while it runs: blueprints, packs,
              workflows, service-skills, design-systems, craft, templates
design/       the brand, and the vendored component library builds start from
docker/       sandbox image
docs/         contract, wedges, open-core, roadmap
scripts/      one-off tooling; nothing here runs in production
```

`library/` is one directory and one `COPY` on purpose. It was seven of each, and the Dockerfile
forgot six of them one at a time — every one of those resolvers fails soft, so the container stayed
healthy while a feature was silently absent. `packs/` was missing for the whole life of the feature:
production had 4,442 `workflow:*` calls and zero `pack:*`, ever, while four shipped wedges declared
packs in their manifests.

## Constraints worth knowing before you change anything

**The agent never holds a credential.** It gets an opaque nonce. The harness holds the secret, shows
a preview, executes on approve, writes an audit row. There is no code path from the sandbox to the
network that skips that gate — do not add one.

**Authored config cannot widen its own limits.** A generated wedge definition cannot set
`required: false` on an approval, ship executable workflow code, or raise a harness ceiling. The
plan clamps down, never up. Promotion is a human.

**A mechanism with tests and no callers fails CI.** `harness/test/connectivity.test.ts` enforces it:
*"A symbol with tests and no callers looks MORE finished than dead code, not less: it has a spec, it
passes CI, and its tests prove the thing works while proving nothing about whether it RUNS."* Wire
it, delete it, or name the seam (`_resetX`, `setXClient`, `xForTests`).

**Fail soft, but never silently.** A diagnostic must not take down the thing it diagnoses; a
capability that is off must say so in words rather than returning an empty result that reads as
"nothing to do".

## Conventions

- TypeScript throughout. No `any` where a type can be written.
- Comments explain **why**, and name the failure that forced the rule. A comment restating the code
  is noise; a comment naming the outage is the reason the next person keeps the guard.
- Tests assert the property, not the membership — a fixture copied from the source of truth is a
  test that cannot fail when the source changes.
- No `@mycel/react` and no client SDK. Generate UI against `/v1`.

## `/v1` surface

```
Auth   Authorization: Bearer <project key | member session>
       POST /v1/auth/login · GET /v1/me
Work   POST /v1/tasks · GET :id · GET :id/events (SSE) · POST :id/cancel
       POST /v1/approvals/:id/{approve,reject}
Who    clients · threads · cases · deliverables · invoices
Where  connections · channels · POST /v1/channels/:id/inbound
Wedge  GET /v1/wedges/:wedge · knowledge
```

Event reference: [docs/CONTRACT.md](docs/CONTRACT.md).
Integration and honest security limits: [docs/INTEGRATION.md](docs/INTEGRATION.md).
Writing a wedge: [docs/WEDGES.md](docs/WEDGES.md).
What the kernel still cannot express: [docs/ROADMAP.md](docs/ROADMAP.md).
