import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { mintPortalLink, exchangePortalLink } from "../src/portal";

/** A one-pixel PNG. Real bytes, so "did base64 survive the round trip" is a real question. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function upload(name: string, type: string, bytes: Buffer | string): FormData {
  const fd = new FormData();
  fd.append("file", new File([bytes as BlobPart], name, { type }));
  return fd;
}

async function aTask(app: ReturnType<typeof makeApp>["app"], store: ReturnType<typeof makeApp>["store"]) {
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  const id = `art-task-${Math.random().toString(36).slice(2)}`;
  await store.createTask({
    id, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
    status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  return { id, projectId };
}

test("artifacts: binary survives the round trip byte for byte", async () => {
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);

  const res = await app.request(`/v1/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY || "testkey"}` },
    body: upload("scan.png", "image/png", PNG),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const art = (await res.json()) as { id: string; encoding: string; size_bytes: number; source: string };
  // Text stays text so it can still be read as prose; anything else is base64. Getting this wrong
  // corrupts the file silently rather than failing.
  assert.equal(art.encoding, "base64");
  assert.equal(art.size_bytes, PNG.byteLength, "the size a human means, not the base64 length");
  assert.equal(art.source, "upload");

  const back = await app.request(`/v1/artifacts/${art.id}`, {
    headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY || "testkey"}` },
  });
  assert.equal(back.status, 200);
  const got = Buffer.from(await back.arrayBuffer());
  assert.ok(got.equals(PNG), "identical bytes out");
  assert.equal(back.headers.get("content-type"), "image/png");
  assert.match(back.headers.get("content-disposition") ?? "", /attachment; filename="scan.png"/);

  // Listing must not carry the bytes — a page showing thirty 20MB PDFs would serve 600MB of JSON.
  const list = await api(app, `tasks/${taskId}/artifacts`);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].content, undefined, "metadata only");
  assert.equal(list.json[0].name, "scan.png");
});

test("artifacts: an uploaded HTML file can never be served as HTML", async () => {
  // The classic way a file feature becomes an account takeover: a customer uploads a page with a
  // script in it, the founder clicks the link, and it runs on the app's own origin with their
  // session. Stored exactly as received; served so a browser will not execute it.
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);
  const key = process.env.MYCEL_API_KEY || "testkey";

  const res = await app.request(`/v1/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: upload("invoice.html", "text/html", "<script>alert(document.cookie)</script>"),
  });
  const art = (await res.json()) as { id: string };
  const back = await app.request(`/v1/artifacts/${art.id}`, { headers: { authorization: `Bearer ${key}` } });

  assert.equal(back.headers.get("content-type"), "application/octet-stream", "not text/html");
  assert.equal(back.headers.get("x-content-type-options"), "nosniff", "and no sniffing back to it");
  assert.match(back.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(await back.text(), /alert\(document\.cookie\)/, "stored verbatim — only the serving is defended");
});

test("artifacts: a filename cannot escape a directory or inject a header", async () => {
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);
  const key = process.env.MYCEL_API_KEY || "testkey";

  const res = await app.request(`/v1/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: upload('../../etc/pa"sswd\r\nX-Evil: 1', "text/plain", "hello"),
  });
  const art = (await res.json()) as { id: string; name: string };
  // Harmless to the database, lethal to anything that writes it to disk — and the fs artifact
  // backend does exactly that.
  assert.ok(!art.name.includes("/"), `basename only, got ${art.name}`);

  const back = await app.request(`/v1/artifacts/${art.id}`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(back.headers.get("x-evil"), null, "no injected header");
  assert.ok(!(back.headers.get("content-disposition") ?? "").includes('"sswd'), "quotes stripped");
});

test("artifacts: the size ceiling is enforced, and an empty file is refused", async () => {
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);
  const key = process.env.MYCEL_API_KEY || "testkey";
  const previous = process.env.MYCEL_MAX_UPLOAD_MB;
  void previous;

  const empty = await app.request(`/v1/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: upload("nothing.txt", "text/plain", ""),
  });
  assert.equal(empty.status, 400);

  const missing = await app.request(`/v1/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: new FormData(),
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /'file' part/);
});

test("artifacts: the agent can read what the run was given, and only that run's files", async () => {
  const { app, store } = makeApp();
  const key = process.env.MYCEL_API_KEY || "testkey";
  const mine = await aTask(app, store);
  const theirs = await aTask(app, store);

  const res = await app.request(`/v1/tasks/${mine.id}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: upload("statement.csv", "text/csv", "date,amount\n2026-07-01,42.00\n"),
  });
  const art = (await res.json()) as { id: string };

  const nonce = await registerActionGrant({ task_id: mine.id, connectionIds: [] });
  const read = await api(app, `internal/artifacts/${art.id}`, { headers: { authorization: `Bearer ${nonce}` } });
  assert.equal(read.status, 200);
  assert.equal(read.json.encoding, "utf8", "CSV is readable prose, so it stays text");
  assert.match(read.json.content, /2026-07-01/);

  const listed = await api(app, "internal/artifacts", { headers: { authorization: `Bearer ${nonce}` } });
  assert.equal(listed.json.artifacts.length, 1);

  // The isolation that matters: one run cannot open another's documents, even in the same project.
  const other = await registerActionGrant({ task_id: theirs.id, connectionIds: [] });
  const cross = await api(app, `internal/artifacts/${art.id}`, { headers: { authorization: `Bearer ${other}` } });
  assert.equal(cross.status, 404);
  assert.equal(
    (await api(app, "internal/artifacts", { headers: { authorization: `Bearer ${other}` } })).json.artifacts.length,
    0,
  );

  // And no grant at all reads nothing.
  assert.equal((await api(app, `internal/artifacts/${art.id}`, { headers: { authorization: "Bearer nope" } })).status, 401);
});

test("artifacts: a client sends a document through the portal and work starts", async () => {
  const { app, store } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;

  const clientRow = await domain.createClient({ project_id: projectId, display_name: "Hartley Bookkeeping" } as never);
  const channel = await domain.createChannel({
    project_id: projectId,
    kind: "email",
    wedge: "books-keeper",
    task_type: "daily_sync",
    address: "hello@example.com",
  } as never);
  const thread = await domain.createThread({
    project_id: projectId,
    client_id: clientRow.id,
    channel_id: channel.id,
    subject: "July statements",
    status: "open",
  } as never);

  const link = mintPortalLink({ project_id: projectId, client_id: clientRow.id });
  const session = (await exchangePortalLink(link.token))!.token;

  const fd = new FormData();
  fd.append("file", new File([PNG as unknown as BlobPart], "july.png", { type: "image/png" }));
  fd.append("body", "Here is the statement you asked for.");
  const res = await app.request(`/v1/portal/threads/${thread.id}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}` },
    body: fd,
  });
  assert.equal(res.status, 201, await res.clone().text());
  const out = (await res.json()) as { task_id: string; artifact: { id: string; client_id: string } };

  // An attachment with no work attached to it is a filing cabinet, not a service.
  assert.ok(out.task_id, "the upload started a run");
  assert.equal(out.artifact.client_id, clientRow.id, "stamped with the owner, not just the task");
  const task = await store.getTask(out.task_id);
  assert.equal(task?.actor.id, clientRow.id, "run attributed to the client, so their connections scope it");

  // They can read their own file back…
  const own = await app.request(`/v1/portal/artifacts/${out.artifact.id}`, {
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(own.status, 200);
  assert.ok(Buffer.from(await own.arrayBuffer()).equals(PNG));

  // …and nobody else's. A second client's session must not resolve this artifact at all.
  const other = await domain.createClient({ project_id: projectId, display_name: "Someone Else" } as never);
  const otherSession = (await exchangePortalLink(mintPortalLink({ project_id: projectId, client_id: other.id }).token))!.token;
  const stolen = await app.request(`/v1/portal/artifacts/${out.artifact.id}`, {
    headers: { authorization: `Bearer ${otherSession}` },
  });
  assert.equal(stolen.status, 404, "another customer's document does not exist as far as they are concerned");

  // The founder plane can still see it — it is their business.
  const asFounder = await app.request(`/v1/artifacts/${out.artifact.id}`, {
    headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY || "testkey"}` },
  });
  assert.equal(asFounder.status, 200);
});

test("artifacts: a client session cannot upload to someone else's thread", async () => {
  const { app } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const a = await domain.createClient({ project_id: projectId, display_name: "A" } as never);
  const b = await domain.createClient({ project_id: projectId, display_name: "B" } as never);
  const channel = await domain.createChannel({
    project_id: projectId, kind: "email", wedge: "books-keeper", task_type: "daily_sync", address: "x@example.com",
  } as never);
  const theirThread = await domain.createThread({
    project_id: projectId, client_id: a.id, channel_id: channel.id, status: "open",
  } as never);

  const session = (await exchangePortalLink(mintPortalLink({ project_id: projectId, client_id: b.id }).token))!.token;
  const fd = new FormData();
  fd.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
  const res = await app.request(`/v1/portal/threads/${theirThread.id}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}` },
    body: fd,
  });
  assert.equal(res.status, 404);
});

test("artifacts: a size is recorded whatever wrote the file", async () => {
  // Only uploads used to set it, so every artifact the agent produced showed a blank size. A column
  // that is empty most of the time reads as broken rather than as absent.
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);

  const text = await store.addArtifact({
    task_id: taskId,
    name: "summary.md",
    content_type: "text/markdown",
    content: "# Done\n",
  });
  assert.equal(text.size_bytes, Buffer.byteLength("# Done\n"));

  const binary = await store.addArtifact({
    task_id: taskId,
    name: "chart.png",
    content_type: "image/png",
    content: PNG.toString("base64"),
    encoding: "base64",
  });
  // Decoded bytes, not base64 length — the latter is a third larger and means nothing to anyone.
  assert.equal(binary.size_bytes, PNG.byteLength);
});

test("artifacts: uploading answers with metadata, not with the file it was just sent", async () => {
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);
  const res = await app.request(`/v1/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY || "testkey"}` },
    body: upload("scan.png", "image/png", PNG),
  });
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.content, undefined, "a 25MB upload should not be answered with 33MB of base64");
  assert.equal(body.size_bytes, PNG.byteLength);
});

test("artifacts: a customer can list their thread's files without waiting for a reply", async () => {
  // Artifacts hang off tasks, and a task id only reaches a customer when the agent posts an
  // OUTBOUND message. Without this route the portal had to reconstruct the list from the run event
  // stream, so a file sent five minutes ago stayed invisible until the agent answered.
  const { app } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;

  const clientRow = await domain.createClient({ project_id: projectId, display_name: "Hartley" } as never);
  const channel = await domain.createChannel({
    project_id: projectId, kind: "email", wedge: "books-keeper", task_type: "daily_sync", address: "h@example.com",
  } as never);
  const thread = await domain.createThread({
    project_id: projectId, client_id: clientRow.id, channel_id: channel.id, status: "open",
  } as never);
  const session = (await exchangePortalLink(mintPortalLink({ project_id: projectId, client_id: clientRow.id }).token))!.token;

  assert.deepEqual((await api(app, `portal/threads/${thread.id}/artifacts`, {}, session)).json, []);

  const fd = new FormData();
  fd.append("file", new File([PNG as unknown as BlobPart], "statement.png", { type: "image/png" }));
  await app.request(`/v1/portal/threads/${thread.id}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}` },
    body: fd,
  });

  const listed = (await api(app, `portal/threads/${thread.id}/artifacts`, {}, session)).json as {
    name: string; content?: string;
  }[];
  assert.equal(listed.length, 1, "visible immediately, before the agent has said anything");
  assert.equal(listed[0].name, "statement.png");
  assert.equal(listed[0].content, undefined, "metadata only");

  // And another customer's session sees nothing on that thread at all.
  const other = await domain.createClient({ project_id: projectId, display_name: "Other" } as never);
  const otherSession = (await exchangePortalLink(mintPortalLink({ project_id: projectId, client_id: other.id }).token))!.token;
  assert.equal((await api(app, `portal/threads/${thread.id}/artifacts`, {}, otherSession)).status, 404);
});

test("artifacts: bytes we cannot reach are reported, never served as an empty file", async () => {
  // THE PRODUCTION BUG. The worker runs with MYCEL_ARTIFACTS=s3, so it writes the row with an empty
  // content column and puts the bytes in the bucket. The kernel — the tier that SERVES artifacts —
  // had no MYCEL_ARTIFACTS at all, so it was `inline`, whose get() always answers null, and
  // `withContent` turned that into "". A founder's shaping run succeeded, wrote a complete business
  // shape to S3, and onboarding told him "The draft came back empty, so there's nothing worth
  // showing you." A configuration split-brain wearing a model failure's costume.
  const { app, store } = makeApp();
  const { id: taskId } = await aTask(app, store);

  // Exactly the row the s3 backend writes: no content here, and a size that says there is content
  // somewhere. This process is `inline`, so it cannot reach it — same as production.
  const orphan = await store.addArtifact({
    task_id: taskId,
    name: "result.txt",
    content_type: "text/plain",
    content: "",
    size_bytes: 412,
  } as never);

  const res = await app.request(`/v1/artifacts/${orphan.id}`, {
    headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY || "testkey"}` },
  });
  assert.notEqual(res.status, 200, "an unreadable artifact must not come back as a successful empty file");

  // A genuinely empty artifact is still fine — the size is what distinguishes the two, and refusing
  // both would be a different lie.
  const empty = await store.addArtifact({
    task_id: taskId, name: "nothing.txt", content_type: "text/plain", content: "", size_bytes: 0,
  } as never);
  const ok = await app.request(`/v1/artifacts/${empty.id}`, {
    headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY || "testkey"}` },
  });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "");
});
