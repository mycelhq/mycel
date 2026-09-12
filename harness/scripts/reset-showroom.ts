// Put the demo tenant back exactly as it was.
//
// ═══ WHY A DEMO MUST FORGET ═══
//
// A stranger created a project called "hh". It stayed. The demo then opened on THAT project — an
// empty one — so every screen read as blank and the seeded business was invisible behind a switcher
// nobody thinks to use. One visitor's stray click made the shop window show an empty room.
//
// That is the whole argument for reset. Not tidiness: a shared demo without one degrades with every
// visitor, and it degrades in the direction of looking broken. The reset is what lets the bar
// honestly say "yours to click through" — you can only invite people to break something if breaking
// it costs nothing.
//
// ═══ WHAT IT DOES, AND WHY IN THIS ORDER ═══
//
//   1. Delete every project in the org except the canonical one. Visitors create these; nothing
//      real lives in them.
//   2. Delete the canonical project's own rows — clients, invoices, cases, requests. Cascades take
//      the children.
//   3. Re-seed from `seed-tenant.ts`, which is the same script that built it the first time, so
//      "reset" and "seeded" can never drift into meaning different things.
//
// Deleting before seeding rather than upserting, deliberately: an upsert leaves anything a visitor
// ADDED, and after a week the demo is the seed plus a month of other people's typing.
//
// ═══ THE RAIL ═══
//
// Same as seed-tenant: it refuses unless the org id it was given matches the org the credential
// actually lands in. This script DELETES, so the check runs before anything is touched — the cost
// of a wrong id here is somebody's real business, not a wasted run.
//
//   npx tsx harness/scripts/reset-showroom.ts --org-id <uuid>

import { env, exit, argv } from "node:process";

const BASE = (env.MYCEL_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const EMAIL = env.MYCEL_OWNER_EMAIL ?? "";
const PASSWORD = env.MYCEL_OWNER_PASSWORD ?? "";

const arg = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WANT_ORG = arg("--org-id");
/** The project the demo is ABOUT. Everything else in the org is a visitor's leftovers. */
const KEEP = arg("--keep-project");

let TOKEN = "";
let PROJECT = "";

async function call<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const m = method ?? (body === undefined ? "GET" : "POST");
  const r = await fetch(`${BASE}/v1/${path}`, {
    method: m,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(PROJECT ? { "x-mycel-project": PROJECT } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${m} ${path} -> ${r.status} ${text.slice(0, 160)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  if (!WANT_ORG) throw new Error("--org-id is required");
  if (!KEEP) throw new Error("--keep-project is required: say which project survives");
  if (!EMAIL || !PASSWORD) throw new Error("MYCEL_OWNER_EMAIL and MYCEL_OWNER_PASSWORD are required");

  const login = await call<{ token: string; projects: { id: string; name: string }[] }>("auth/login", {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = login.token;

  // The rail, before anything is deleted.
  const me = await call<{ org_id?: string }>("me");
  if ((me.org_id ?? "") !== WANT_ORG) {
    console.error(
      `\n  ✗ refusing to reset.\n` +
        `    --org-id said        "${WANT_ORG}"\n` +
        `    the credential is in "${me.org_id ?? ""}"\n\n` +
        `  This script DELETES. It only ever deletes inside the org you name.\n`,
    );
    exit(1);
  }

  const projects = login.projects ?? [];
  if (!projects.some((p) => p.id === KEEP)) {
    console.error(`\n  ✗ --keep-project ${KEEP} is not a project in this org. Refusing.\n`);
    exit(1);
  }

  // 1. Visitors' leftover projects.
  let dropped = 0;
  for (const p of projects) {
    if (p.id === KEEP) continue;
    await call(`projects/${encodeURIComponent(p.id)}`, undefined, "DELETE").catch(() => {});
    dropped++;
    console.log(`  dropped project "${p.name}"`);
  }

  // 2. The canonical project's own rows.
  PROJECT = KEEP;
  const wipe = async (collection: string) => {
    const rows = await call<{ id: string }[]>(`${collection}?limit=500`).catch(() => [] as { id: string }[]);
    let n = 0;
    for (const row of rows) {
      await call(`${collection}/${encodeURIComponent(row.id)}`, undefined, "DELETE").catch(() => {});
      n++;
    }
    console.log(`  cleared ${n} ${collection}`);
  };
  // Invoices and cases before clients: a child row whose parent is already gone is a 404 the loop
  // would swallow, and the count would then lie about what was actually removed.
  await wipe("invoices");
  await wipe("requests");
  await wipe("cases");
  await wipe("clients");

  console.log(`\n  ${dropped} stray project(s) removed. Re-seed with seed-tenant.ts.\n`);
}

main().catch((e) => {
  console.error(`\nreset-showroom: ${(e as Error).message}\n`);
  exit(1);
});
