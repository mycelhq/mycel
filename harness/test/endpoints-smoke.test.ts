/**
 * Hit every `/v1` GET the kernel registers. A toast on a product page is often a 500 with a
 * sentence, and those were slipping through because each route has its own test file — a new
 * handler that throws on an empty store never got a caller.
 *
 * 500 is the only failure. 401/403/404/400 are answers. SSE routes are skipped: they do not
 * finish, and a hang here would look like the suite wedged rather than a bad endpoint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, makeApp } from "./helpers";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function routeSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      routeSources(p, acc);
    } else if (
      name === "server.ts" ||
      name === "routes.ts" ||
      name.endsWith(".routes.ts") ||
      name === "portal-approvals.ts" ||
      name === "portal-threads.ts"
    ) {
      acc.push(p);
    }
  }
  return acc;
}

function registeredGets(): string[] {
  const found = new Set<string>();
  for (const f of routeSources(SRC)) {
    for (const m of readFileSync(f, "utf8").matchAll(/app\.get\(\s*"(\/v1\/[^"]+)"/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

function concrete(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, (_, name: string) => {
    if (name === "host") return "example.com";
    if (name === "wedge") return "invoice-chaser";
    if (name === "slug") return "invoice-chaser";
    if (name === "toolkit") return "xero";
    if (name === "domain") return "mail.example.test";
    return "missing";
  });
}

const SKIP = (path: string) => /\/events$|\/events\//.test(path);

test("every founder-facing GET answers without a 500", async () => {
  const { app } = makeApp();
  const routes = registeredGets();
  assert.ok(routes.length > 60, `expected the full GET surface, found ${routes.length}`);

  const failures: string[] = [];
  let hit = 0;
  for (const route of routes) {
    if (SKIP(route)) continue;
    const path = concrete(route);
    hit += 1;
    const res = await app.request(path, { headers: { authorization: `Bearer ${KEY}` } });
    const text = await res.text();
    if (res.status === 500) {
      failures.push(`${route} (${path}) → ${res.status} ${text.slice(0, 240)}`);
    }
  }
  assert.ok(hit > 50, `smoke skipped too much of the surface (${hit} GETs)`);
  assert.equal(failures.length, 0, `GET 500s:\n${failures.join("\n")}`);
});

test("cloud kernel() literals still exist as kernel routes", () => {
  /**
   * The other half of a toast: the console calls `kernel("payments/questions")` and the kernel
   * renamed the route. A source check, because the smoke above uses dummy ids and will 404 a
   * path that is registered — it will not catch a caller spelling a path the server never had.
   */
  const cloudRoot = join(SRC, "../../../cloud");
  if (!existsSync(cloudRoot) || !statSync(cloudRoot).isDirectory()) {
    return; // published kernel tree
  }

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
    }
    return acc;
  };

  const server = routeSources(SRC).map((f) => readFileSync(f, "utf8")).join("\n");

  const literals = new Set<string>();
  for (const file of walk(join(cloudRoot, "app")).concat(walk(join(cloudRoot, "lib")))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bkernel(?:Result|Public)?(?:<[^>]+>)?\(\s*"([^"?]+)/g)) {
      literals.add(m[1]!.split("?")[0]!);
    }
  }

  const missing: string[] = [];
  for (const lit of [...literals].sort()) {
    if (lit.includes("${")) continue;
    const first = lit.split("/")[0]!;
    // `me/prefs` is PATCH-only; a GET check would be the wrong question. Presence of the first
    // segment in a route string is enough to catch a rename of the collection.
    const needle = lit.replace(/\/$/, "");
    const routeLike = new RegExp(`"/v1/${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    const collection = new RegExp(`"/v1/${first}(?:/|")`);
    if (!routeLike.test(server) && !collection.test(server)) missing.push(lit);
  }
  assert.ok(literals.size > 20, `expected cloud to call a real surface, found ${literals.size}`);
  assert.equal(missing.length, 0, `cloud kernel() paths the server does not register:\n${missing.join("\n")}`);
});

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

/**
 * Walk a source file and find `kernel("literal")` GETs. `.catch(` immediately after the call is
 * how a page degrades; without it, a non-2xx is a Next error boundary (or a toast, on a client
 * action). The previous smoke in this file used the product API key and only failed on 500, so
 * a 400/501 that the console actually throws never showed up.
 */
function cloudKernelGets(): { path: string; caught: boolean; file: string }[] {
  const cloudRoot = join(SRC, "../../../cloud");
  if (!existsSync(cloudRoot) || !statSync(cloudRoot).isDirectory()) return [];

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (name === "page.tsx" || name === "layout.tsx") acc.push(p);
    }
    return acc;
  };

  const out: { path: string; caught: boolean; file: string }[] = [];
  for (const file of walk(join(cloudRoot, "app"))) {
    const text = readFileSync(file, "utf8");
    const re = /\bkernel(?:Result)?(?:<[^>]*>)?\(\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const path = m[1]!;
      if (path.includes("${")) continue;
      let i = text.indexOf("(", m.index);
      let depth = 0;
      let end = i;
      for (; end < text.length; end++) {
        const ch = text[end]!;
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const after = text.slice(end + 1, end + 120).replace(/\s+/g, "");
      const caught = after.startsWith(".catch(") || after.startsWith(".then(");
      out.push({ path, caught, file: file.slice(cloudRoot.length + 1) });
    }
  }
  return out;
}

test("console GETs as a logged-in founder do not crash the page", async () => {
  /**
   * The product never sends the API key. `cloud/lib/kernel.ts` sends the member session cookie
   * plus `X-Mycel-Project`. A 400 from invoices without that header, or a 501 from Composio
   * unset, is a KernelError — and on an uncaught Server Component fetch that is the error card,
   * not a toast.
   *
   * SKIPS when the cloud sibling is absent — the published open-source kernel ships without it, so
   * `cloudKernelGets()` reads nothing and there are no console GETs to smoke. Same guard as the
   * source-check test above; failing here instead is what kept the OSS snapshot from publishing.
   */
  const cloudRoot = join(SRC, "../../../cloud");
  if (!existsSync(cloudRoot) || !statSync(cloudRoot).isDirectory()) {
    return; // published kernel tree
  }

  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const loginText = await login.text();
  assert.equal(login.status, 200, loginText);
  const token = (JSON.parse(loginText) as { token: string }).token;
  assert.ok(token, "owner login must mint a member token — that is what the console sends");

  const meRes = await app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  const meText = await meRes.text();
  assert.equal(meRes.status, 200, meText);
  const me = JSON.parse(meText) as { projects?: { id: string }[] };
  const projectId = me.projects?.[0]?.id;
  assert.ok(projectId, "owner must have a project so X-Mycel-Project matches the product");

  const calls = cloudKernelGets();
  assert.ok(calls.length > 30, `expected the console to call a real GET surface, found ${calls.length}`);

  const extra = [
    "payments/questions",
    "payments/confidence",
    "payments/rails",
    "payments/instructions",
    "retainers",
    "imports/crm/confidence",
    "imports/calendar/confidence",
    "gtm/availability",
  ];

  const seen = new Set<string>();
  const crash: string[] = [];
  const notable: string[] = [];

  const hit = async (path: string, caught: boolean, via: string) => {
    const key = `${caught ? "soft" : "hard"} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const res = await app.request(`/v1/${path}`, {
      headers: { authorization: `Bearer ${token}`, "x-mycel-project": projectId },
    });
    const text = await res.text();
    const blank = res.status !== 204 && text.trim() === "";
    const line = `${via} GET /v1/${path} → ${res.status}${blank ? " empty" : ""} ${text.slice(0, 160)}`;
    if (res.status === 500 || (blank && res.status >= 200 && res.status < 300)) {
      crash.push(line);
      return;
    }
    if (!caught && res.status >= 400) {
      crash.push(line);
      return;
    }
    if (res.status >= 400) notable.push(line);
  };

  for (const c of calls) await hit(c.path, c.caught, c.file);
  for (const p of extra) await hit(p, true, "invoices/gtm helpers");

  if (notable.length) {
    console.log(`console GETs that 4xx but are caught (setup, not a crash):\n${notable.join("\n")}`);
  }
  assert.equal(crash.length, 0, `console-crashing GETs (uncaught 4xx/5xx or empty 2xx):\n${crash.join("\n")}`);
});
