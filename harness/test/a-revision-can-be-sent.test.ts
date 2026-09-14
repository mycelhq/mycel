// The founder's answer to "can you change this" — and until now there wasn't one.
//
// A client presses "ask for a change" in their portal, the agreement lands at `changes_requested`
// with their words on it, and the founder's only control was WITHDRAW. So the honest flow was: void
// the paper the client is looking at, regenerate it, send a new one, and let them watch the thing
// they commented on disappear.
//
// `POST /v1/envelopes/:id/revise` has existed the whole time. It took an `artifact_id`, and an
// artifact has to hang off a task — so a browser with a PDF and no idea which run owns the original
// could not complete the flow. That is why it sat on the "owed a surface" list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";
import { _resetSigning, sha256 } from "../src/signing";

const V1 = "%PDF-1.4 the engagement letter";
const V2 = "%PDF-1.4 the engagement letter, at the number they asked for";

async function world() {
  _resetPortal();
  _resetSigning();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const client = await domain.createClient({
    project_id: projectId,
    display_name: "acme",
    handles: ["acme@sign.test"],
    metadata: {},
  });
  const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
  const token = (
    await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })
  ).json.token as string;

  const task = await api(app, "tasks", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      wedge: "books-keeper",
      task_type: "daily_sync",
      input: {},
      client_id: client.id,
      actor: { kind: "user", id: client.id },
    }),
  });
  const artifact = await store.addArtifact({
    task_id: task.json.id,
    name: "engagement.pdf",
    content_type: "application/pdf",
    content: V1,
  });

  const made = await api(app, "envelopes", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      client_id: client.id,
      title: "Engagement — Acme",
      artifact_id: artifact.id,
      filename: "engagement.pdf",
      signers: [
        { role: "client", name: "Sam Hart", email: "sam@acme.test", order: 1 },
        { role: "provider", name: "Ada Bell", email: "ada@northbound.test", order: 2 },
      ],
    }),
  });
  await api(app, `envelopes/${made.json.envelope.id}/send`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
  });

  return {
    app,
    store,
    projectId,
    taskId: task.json.id as string,
    envelopeId: made.json.envelope.id as string,
    h: { authorization: `Bearer ${token}` },
  };
}

/** A multipart body with one file part, the way a browser's file input produces it. */
function upload(name: string, body: string, type = "application/pdf"): FormData {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  return form;
}

/**
 * POST a multipart body, WITHOUT the JSON content-type `api()` forces on every request.
 *
 * Not a detail: the route decides which door to take from the content type, and a multipart body
 * labelled `application/json` reads as an empty JSON object — which is exactly the "the document for
 * the revision is missing" that this helper's absence produced. The boundary has to come from the
 * FormData, which means nobody may set the header by hand.
 */
async function post(
  app: Parameters<typeof api>[0],
  path: string,
  body: FormData,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await app.request(`/v1/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer testkey", ...headers },
    body,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

test("a client asks for a change and the founder answers with a new document", async () => {
  const { app, projectId, envelopeId, h } = await world();

  const asked = await api(app, `portal/envelopes/${envelopeId}/request-change`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ asked: "Can we do £1,800 a month instead?" }),
  });
  assert.equal(asked.status, 200, asked.text);
  assert.equal(asked.json.envelope.status, "changes_requested");

  const revised = await post(app, `envelopes/${envelopeId}/revise`, upload("engagement-v2.pdf", V2), {
    "x-mycel-project": projectId,
  });
  assert.equal(revised.status, 201, revised.text);

  const next = revised.json.envelope;
  assert.equal(next.revision, 2);
  assert.equal(next.document.filename, "engagement-v2.pdf");
  /*
    THE LINEAGE IS THE POINT, not the convenience. "They asked for a lower number twice and signed
    the third" is a fact about a deal that only exists if the versions are linked — and the previous
    flow, withdraw-and-resend, destroyed it every time.
  */
  assert.equal(next.supersedes, envelopeId);
  const old = await api(app, `envelopes/${envelopeId}`, { headers: { "x-mycel-project": projectId } });
  assert.equal(old.json.envelope.superseded_by, next.id);

  // And the new paper is REAL: sending it seals a hash of the bytes that were uploaded, which is the
  // same check the original goes through.
  const sent = await api(app, `envelopes/${next.id}/send`, { method: "POST", headers: { "x-mycel-project": projectId } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.envelope.document.sha256, sha256(Buffer.from(V2, "utf8")));

  // The client sees the version they are being asked to sign, byte for byte.
  const doc = await api(app, `portal/envelopes/${next.id}/document`, { headers: h });
  assert.equal(doc.text, V2);
});

test("the revision is filed against the run that produced the original", async () => {
  const { app, projectId, envelopeId, taskId, store } = await world();

  await post(app, `envelopes/${envelopeId}/revise`, upload("engagement-v2.pdf", V2), {
    "x-mycel-project": projectId,
  });

  /*
    Not "whatever task happened to be handy". The revision belongs with the work that produced the
    original, so the trace of that engagement holds every version of the paper — and it is also what
    makes the tenancy check possible at all: the upload lands on a task already proven to be in this
    project.
  */
  const files = await store.listArtifacts(taskId);
  assert.ok(
    files.some((f) => f.name === "engagement-v2.pdf"),
    "the revision was not filed with the original's run",
  );
});

test("an empty upload is refused, and says so", async () => {
  const { app, projectId, envelopeId } = await world();
  const empty = new FormData();
  empty.set("file", new File([], "nothing.pdf", { type: "application/pdf" }));
  const res = await post(app, `envelopes/${envelopeId}/revise`, empty, { "x-mycel-project": projectId });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /empty/);
});

test("the JSON door still works, because a run that regenerated the paper has an artifact id", async () => {
  const { app, store, projectId, taskId, envelopeId } = await world();
  const art = await store.addArtifact({
    task_id: taskId,
    name: "regenerated.pdf",
    content_type: "application/pdf",
    content: V2,
  });
  const res = await api(app, `envelopes/${envelopeId}/revise`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ artifact_id: art.id, filename: "regenerated.pdf" }),
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.envelope.document.filename, "regenerated.pdf");
});

test("a missing original is a refusal, not a revision filed somewhere random", async () => {
  const { app, store, projectId, envelopeId } = await world();
  /*
    The artifact the agreement points at has gone — expired out of the store, or a run cleaned up.
    `attachRevision` files the upload against the run that owns the PREVIOUS document, so with no
    previous document there is no honest place to put it. Saying so beats inventing one.
  */
  const env = await api(app, `envelopes/${envelopeId}`, { headers: { "x-mycel-project": projectId } });
  await store.deleteArtifact?.(env.json.envelope.document.artifact_id);

  const res = await post(app, `envelopes/${envelopeId}/revise`, upload("v2.pdf", V2), {
    "x-mycel-project": projectId,
  });
  if ((store as { deleteArtifact?: unknown }).deleteArtifact) {
    assert.equal(res.status, 409, res.text);
    assert.match(res.json.error, /no longer on file/);
  }
});

test("an agreement pointing at another tenant's document cannot file an upload onto their run", async () => {
  const { app, store, projectId } = await world();
  /*
    `POST /v1/envelopes` takes `artifact_id` ON TRUST — the project check happens at SEND, where
    `readArtifact` refuses to resolve bytes from another tenant. So an envelope in MY project CAN be
    created naming somebody else's artifact; it simply cannot be sent.

    Which makes this the branch that matters: revise must not take the founder's upload and file it
    against the stranger's task just because the envelope pointed there. The refusal is the same
    sentence as a missing original, deliberately — "not yours" and "not there" are the same fact
    from the caller's side, and distinguishing them would confirm that somebody else's artifact id
    is real.
  */
  /*
    Written straight to the store, not through the API, and that is the only way to build this: the
    API refuses to create a task in a project this key cannot write to — which is the OUTER guard,
    and the reason the first version of this test quietly created the "foreign" task in my own
    project and passed while proving nothing.
  */
  const at = new Date().toISOString();
  const theirTask = await store.createTask({
    id: `t-foreign-${Date.now()}`,
    project_id: "proj_someone_else",
    wedge: "books-keeper",
    task_type: "daily_sync",
    actor: { kind: "system", id: "test" },
    input: {},
    constraints: { max_runtime_s: 60, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "succeeded",
    cost_usd: 0,
    created_at: at,
    updated_at: at,
  } as never);
  const foreign = await store.addArtifact({
    task_id: theirTask.id,
    name: "not-yours.pdf",
    content_type: "application/pdf",
    content: "%PDF-1.4 theirs",
  });

  const made = await api(app, "envelopes", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      title: "Engagement",
      artifact_id: foreign.id,
      filename: "not-yours.pdf",
      signers: [
        { role: "client", name: "Sam", email: "sam@acme.test", order: 1 },
        { role: "provider", name: "Ada", email: "ada@northbound.test", order: 2 },
      ],
    }),
  });
  assert.equal(made.status, 201, made.text);

  const res = await post(app, `envelopes/${made.json.envelope.id}/revise`, upload("mine.pdf", V2), {
    "x-mycel-project": projectId,
  });
  assert.equal(res.status, 409, res.text);
  const theirFiles = await store.listArtifacts(theirTask.id);
  assert.ok(!theirFiles.some((f) => f.name === "mine.pdf"), "the upload landed on another tenant's run");
});

test("another tenant cannot revise this agreement", async () => {
  const { app, envelopeId } = await world();
  /*
    `visible()` is the gate and it is keyed on the project the envelope belongs to, not on anything
    in the request. Without a project header the caller's accessible set does not contain it.
  */
  const res = await post(app, `envelopes/${envelopeId}/revise`, upload("sneaky.pdf", "%PDF-1.4 mine now"), {
    "x-mycel-project": "proj_not_yours",
  });
  assert.equal(res.status, 404);
});
