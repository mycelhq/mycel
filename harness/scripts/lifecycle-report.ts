/**
 * How far has a real engagement actually got — read off a live kernel, over HTTP, changing nothing.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `STANDARD.md` opens with a table of five numbers and says of them: "Measured by `lifecycle.ts`,
 * run against production, not staging." There was no way to do that. `simulation/lifecycle.ts`
 * exports `observe`, `report` and `headline`, they are covered by tests, and NOTHING IN THE REPO
 * CALLED THEM against anything real. Every figure in that table was therefore either hand-counted
 * once or inherited from the previous edit of the file.
 *
 * That is the same failure as the deliverable edit route — a capability built, tested, and never
 * wired — and it is worse here, because the thing left unwired is the instrument the whole product
 * is graded with. The number that matters most in the company, `revision_accepted`, is one somebody
 * has to be able to check on a Sunday without opening a database.
 *
 * ═══ IT READS. IT DOES NOT WRITE. ═══
 *
 * Every call in this file is a GET. That is not a convention, it is the reason this script is
 * allowed to point at production at all, and it is why it deliberately does NOT use the two guards
 * `simulate.ts` lives under:
 *
 *   · `assertLoopback` — right for the simulator, which fabricates a business and must never do so
 *     against a real one. Wrong here: the whole point is to reach the tenant that has real clients.
 *   · `assertMemoryStore` — same. The simulator refuses to run against a durable store; this one is
 *     useless anywhere else.
 *
 * The safety property is therefore the HTTP verb and nothing else, so it is worth saying plainly:
 * if you ever add a POST to this file, you have changed what it is, and both guards above have to
 * come back with it.
 *
 * ═══ WHAT IT COUNTS, AND WHY THE HIGH-WATER MARK IS THE HONEST NUMBER ═══
 *
 * `report()` keeps the FIRST time each stage was seen and reports the furthest ever reached, not
 * the current one. An engagement parked at `awaiting_client` today may have delivered last week,
 * and a report that said "cannot deliver" would be alarming and false. Both are printed.
 *
 * `headline()` counts stages OBSERVED rather than depth, for the reason documented at that function:
 * the first version printed 14/15 for an engagement that had reached seven, because one invoice
 * happened to be marked paid and depth credits everything underneath the high-water mark.
 *
 * ═══ USAGE ═══
 *
 *   MYCEL_URL=https://api.mycelai.dev \
 *   MYCEL_API_KEY=<a project api key> \
 *     npx tsx harness/scripts/lifecycle-report.ts
 *
 * Or with an owner login instead of a key:
 *
 *   MYCEL_URL=… MYCEL_OWNER_EMAIL=… MYCEL_OWNER_PASSWORD=… npx tsx harness/scripts/lifecycle-report.ts
 *
 * `--json` prints the report as JSON instead of prose, for pasting into `STANDARD.md` without
 * transcribing numbers by hand — which is how two of that file's figures came to be wrong.
 */

import { headline, observe, report, STAGES, type Observation } from "../src/simulation/lifecycle";

const BASE = (process.env.MYCEL_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const AS_JSON = process.argv.includes("--json");

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

interface Auth {
  token: string;
  project?: string;
}

/**
 * Two ways in, and the API key is preferred.
 *
 * A project key is already scoped to one project, which is the scope this report wants — a founder
 * with three projects asking "how far has it got" means one of them. The owner login is the fallback
 * for the operator who has a password and not a key, and it then has to be told which project.
 */
async function signIn(): Promise<Auth> {
  const key = process.env.MYCEL_API_KEY;
  if (key) return { token: key, project: process.env.MYCEL_PROJECT_ID };

  const email = process.env.MYCEL_OWNER_EMAIL;
  const password = process.env.MYCEL_OWNER_PASSWORD;
  if (!email || !password) {
    die("Set MYCEL_API_KEY, or MYCEL_OWNER_EMAIL and MYCEL_OWNER_PASSWORD.");
  }
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) die(`Sign-in failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) die("Sign-in returned no token.");

  const project = process.env.MYCEL_PROJECT_ID ?? (await firstProject(body.token));
  return { token: body.token, project };
}

async function firstProject(token: string): Promise<string | undefined> {
  const res = await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return undefined;
  const me = (await res.json()) as { projects?: { id: string; name?: string }[] };
  const projects = me.projects ?? [];
  if (projects.length > 1) {
    // Naming the alternatives rather than silently taking the first. Reporting one project's
    // numbers under another project's name is exactly the kind of quiet wrongness this whole file
    // exists to stop.
    console.error(
      `  Note: ${projects.length} projects on this account; reading "${projects[0]?.name ?? projects[0]?.id}".` +
        `\n  Set MYCEL_PROJECT_ID to pick another: ${projects.map((p) => p.id).join(", ")}\n`,
    );
  }
  return projects[0]?.id;
}

/** Every read in this script. Returns `[]` rather than dying on a 404 — a tenant with no invoices
 *  is not an error, and a stage that cannot be observed is exactly what the report is for. */
async function list<T>(auth: Auth, path: string): Promise<T[]> {
  const res = await fetch(`${BASE}/v1/${path}`, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(auth.project ? { "x-mycel-project": auth.project } : {}),
    },
  });
  if (!res.ok) {
    console.error(`  · GET /v1/${path} → ${res.status} (treated as empty)`);
    return [];
  }
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as T[];
  // The list routes wrap under their own plural key: { deliverables: [...] }, { cases: [...] }.
  const rec = body as Record<string, unknown>;
  const arr = Object.values(rec).find(Array.isArray);
  return (arr as T[]) ?? [];
}

interface DeliverableRow {
  id: string;
  created_at: string;
  status: string;
}
interface VersionRow {
  version: number;
  created_at: string;
  accepted_at?: string;
  change_requested_at?: string;
}

async function main(): Promise<void> {
  const auth = await signIn();

  const [clients, cases, requests, tasks, deliverableRows, invoices] = await Promise.all([
    list<{ created_at: string }>(auth, "clients"),
    list<{ created_at: string; data?: Record<string, unknown> }>(auth, "cases"),
    list<{ created_at: string; status: string; resolved_at?: string; response_artifact_ids?: string[] }>(auth, "requests"),
    list<{ created_at: string; status: string; task_type: string }>(auth, "tasks?limit=500"),
    list<DeliverableRow>(auth, "deliverables?limit=200"),
    list<{ created_at: string; status: string; paid_at?: string }>(auth, "invoices"),
  ]);

  /**
   * THE VERSIONS COST ONE READ EACH, AND THEY ARE THE POINT.
   *
   * `GET /v1/deliverables` deliberately omits versions — forty deliverables would be forty version
   * reads on a list route. But `revised`, `revision_requested` and `revision_accepted` are ALL
   * version-level facts, and they are the three stages the whole report exists to find. So they are
   * fetched here, one detail call per deliverable, which is the right place to pay that cost:
   * a report somebody runs on a Sunday, not a screen somebody loads all day.
   */
  const versions: VersionRow[] = [];
  const verdicts: { at: string; decision: string; version?: number }[] = [];
  for (const d of deliverableRows) {
    const detail = await fetch(`${BASE}/v1/deliverables/${d.id}`, {
      headers: {
        authorization: `Bearer ${auth.token}`,
        ...(auth.project ? { "x-mycel-project": auth.project } : {}),
      },
    });
    if (!detail.ok) continue;
    const body = (await detail.json()) as { versions?: VersionRow[] };
    for (const v of body.versions ?? []) {
      versions.push(v);
      // The client's verdict is not a separate row anywhere — it is a pair of timestamps ON the
      // version. Reconstructed here into the shape `observe` reads, rather than teaching `observe`
      // about this API's shape, because that function's whole design is that it takes plain objects
      // and can therefore read a fixture, a dump or a live response.
      if (v.change_requested_at) verdicts.push({ at: v.change_requested_at, decision: "changes", version: v.version });
      if (v.accepted_at) verdicts.push({ at: v.accepted_at, decision: "accepted", version: v.version });
    }
  }

  const observations: Observation[] = observe({
    clients,
    cases,
    requests,
    tasks,
    deliverables: deliverableRows,
    versions,
    verdicts,
    invoices,
    // `prospects`, `outreach` and `replies` are GTM-side and live behind the campaign routes rather
    // than a flat list. Left out deliberately rather than approximated: a report that guessed at
    // `outreach_sent` would report a stage nobody can check, and an unreached early stage next to
    // reached later ones already shows up in `skipped`, which is the honest way for this absence to
    // appear.
  });

  const r = report(observations);

  if (AS_JSON) {
    console.log(JSON.stringify({ base: BASE, project: auth.project, headline: headline(r), ...r }, null, 2));
    return;
  }

  const reached = STAGES.length - r.neverReached.length;
  console.log(`\n  ${BASE}${auth.project ? `  ·  project ${auth.project}` : ""}\n`);
  console.log(`  ${headline(r)}\n`);

  for (const stage of STAGES) {
    const hit = r.timeline.filter((o) => o.stage === stage).sort((a, b) => a.at - b.at)[0];
    const mark = hit ? "✓" : r.skipped.includes(stage) ? "!" : "·";
    const when = hit ? new Date(hit.at).toISOString().slice(0, 10) : "";
    console.log(`  ${mark}  ${stage.padEnd(20)} ${when.padEnd(12)} ${hit?.evidence ?? ""}`);
  }

  /**
   * THE ONE LINE THAT IS NOT A LIST.
   *
   * `STANDARD.md`: "The one that matters most is `revision_accepted`. Delivering proves the product
   * works. Being told it was wrong and coming back correctly proves the BUSINESS works, and it is
   * the only thing that produces a second month." So it gets said in words, at the bottom, where
   * the reader stops.
   */
  const retainer = r.timeline.some((o) => o.stage === "revision_accepted");
  console.log(
    `\n  ${retainer ? "✓" : "✗"}  revision_accepted — ${
      retainer
        ? "a client objected and accepted the fix. The business works."
        : "never. Delivering is proven; coming back correctly after an objection is not, and that is what produces a second month."
    }\n  ${reached}/${STAGES.length} stages, ${observations.length} observations.\n`,
  );
}

main().catch((e) => die(String(e?.stack ?? e)));
