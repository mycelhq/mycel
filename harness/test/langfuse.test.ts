import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";
import { initSecretStore } from "../src/secrets";
import { keysForProject, orgCredentials, perProjectTracing, traceUrlFor } from "../src/langfuse.provision";

/**
 * A stand-in Langfuse.
 *
 * The real one needs an account and a network round trip, which is exactly why this code path went
 * unwritten for so long — and its failure mode is silence, so "untested" reads like "working".
 * This records what we sent and hands back the shapes the published OpenAPI spec promises.
 */
interface Call {
  method: string;
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}
async function fakeLangfuse(
  calls: Call[],
  opts: { failProjects?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "";
      calls.push({
        method: req.method ?? "",
        path,
        auth: req.headers.authorization as string | undefined,
        body: raw ? JSON.parse(raw) : {},
      });
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/api/public/projects") {
        if (opts.failProjects) return send(403, { message: "no entitlement" });
        return send(200, { id: `lf-proj-${++n}`, name: "x" });
      }
      if (/^\/api\/public\/projects\/.+\/apiKeys$/.test(path)) {
        return send(200, {
          id: `key-${n}`,
          createdAt: new Date(0).toISOString(),
          publicKey: `pk-lf-${n}`,
          secretKey: `sk-lf-${n}`,
          displaySecretKey: "sk-...",
        });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function withOrgKeys(url: string) {
  const before = { ...process.env };
  process.env.LANGFUSE_HOST = url;
  process.env.LANGFUSE_ORG_PUBLIC_KEY = "pk-org";
  process.env.LANGFUSE_ORG_SECRET_KEY = "sk-org";
  return () => {
    process.env.LANGFUSE_HOST = before.LANGFUSE_HOST;
    if (before.LANGFUSE_ORG_PUBLIC_KEY === undefined) delete process.env.LANGFUSE_ORG_PUBLIC_KEY;
    if (before.LANGFUSE_ORG_SECRET_KEY === undefined) delete process.env.LANGFUSE_ORG_SECRET_KEY;
  };
}

test("langfuse: off unless an organisation key is configured", () => {
  delete process.env.LANGFUSE_ORG_PUBLIC_KEY;
  delete process.env.LANGFUSE_ORG_SECRET_KEY;
  assert.equal(perProjectTracing(), false);
  assert.equal(orgCredentials(), undefined);
});

test("langfuse: each business gets its own project and its own keys", async () => {
  await initSecretStore();
  const calls: Call[] = [];
  const lf = await fakeLangfuse(calls);
  const restore = withOrgKeys(lf.url);
  try {
    assert.equal(perProjectTracing(), true);

    const a = await keysForProject("project-aaa", "Hartley Bookkeeping");
    const b = await keysForProject("project-bbb", "Someone Else Ltd");
    assert.ok(a && b);

    // The whole point. Two businesses, two Langfuse projects, two key pairs — so a founder's key
    // reads their traces and nothing else. A shared project filtered by tag is a promise about our
    // query construction; this is a boundary.
    assert.notEqual(a!.projectId, b!.projectId);
    assert.notEqual(a!.secretKey, b!.secretKey);

    // Organisation-scoped Basic auth, per the public API.
    assert.equal(calls[0].auth, `Basic ${Buffer.from("pk-org:sk-org").toString("base64")}`);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/public/projects");
    // `retention` is required by the spec; omitting it is a 400 that would look like "tracing is
    // just broken" from the outside.
    assert.equal(calls[0].body.retention, 0);
    assert.match(String(calls[0].body.name), /Hartley Bookkeeping/);
    // Two founders can both call their business "Bookkeeping"; a human reading the Langfuse sidebar
    // still needs to tell them apart.
    assert.match(String(calls[0].body.name), /project-/);

    // Provisioned once and remembered. Doing it per run would create a project per run.
    const again = await keysForProject("project-aaa", "Hartley Bookkeeping");
    assert.deepEqual(again, a);
    assert.equal(calls.filter((c) => c.path === "/api/public/projects").length, 2, "no third project");

    // And the deep link points at that project, not at a shared dashboard.
    const url = await traceUrlFor("project-aaa");
    assert.equal(url, `${lf.url}/project/${a!.projectId}/traces`);
    assert.equal(await traceUrlFor("never-run"), undefined, "nothing to link to before it exists");
  } finally {
    restore();
    await lf.close();
  }
});

test("langfuse: a broken Langfuse does not break a customer's run", async () => {
  // Losing a trace is never worth failing work someone is paying for. This is the failure mode that
  // matters most, because the third party is outside our control and its outage is not our outage.
  await initSecretStore();
  const calls: Call[] = [];
  const lf = await fakeLangfuse(calls, { failProjects: true });
  const restore = withOrgKeys(lf.url);
  try {
    const keys = await keysForProject("project-doomed", "Doomed Ltd");
    assert.equal(keys, undefined, "reports failure rather than throwing");
  } finally {
    restore();
    await lf.close();
  }

  // Unreachable host, same answer.
  const restore2 = withOrgKeys("http://127.0.0.1:1");
  try {
    assert.equal(await keysForProject("project-offline", "Offline Ltd"), undefined);
  } finally {
    restore2();
  }
});

test("langfuse: the founder is told whether they have a project of their own, and where", async () => {
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;

  const off = await api(app, `projects/${projectId}/tracing`);
  assert.equal(off.status, 200);
  assert.equal(off.json.per_project, false);
  // Null rather than a link to an empty dashboard — the exact failure the tracing state exists for.
  assert.equal(off.json.url, null);

  // Another tenant's project is not readable.
  const other = getIdentityStore().createProject(
    getIdentityStore().createOrgWithOwner("lf-other", `lf-${Date.now()}@example.com`, "a-long-password").org.id,
    "Theirs",
  ).project;
  assert.equal((await api(app, `projects/${other.id}/tracing`)).status, 404);
});
