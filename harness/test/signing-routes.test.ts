// The signature over HTTP — the two planes, and what neither of them may do.
//
// signing.test.ts covers the instrument: consent before intent, the typed name, the sealed hash,
// terminal statuses. This file covers the part an attacker touches, which is a different question:
// a valid credential doing something it should not be able to do.
//
// Three of these would each, on their own, have made every executed agreement worthless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";
import { _resetSigning, sha256 } from "../src/signing";

const PDF = "%PDF-1.4 the engagement letter";

async function world() {
  _resetPortal();
  _resetSigning();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();

  const mk = async (name: string) => {
    const client = await domain.createClient({
      project_id: projectId,
      display_name: name,
      handles: [`${name}@sign.test`],
      metadata: {},
    });
    const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
    const token = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json
      .token as string;
    return { client, h: { authorization: `Bearer ${token}` } };
  };

  const a = await mk("acme");
  const b = await mk("beta");

  // A real artifact on a real task, because `readArtifact` resolves the bytes through the task to
  // check the project — the tenancy boundary lives there, and a fabricated id would not exercise it.
  const task = await api(app, "tasks", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      wedge: "books-keeper",
      task_type: "daily_sync",
      input: {},
      client_id: a.client.id,
      actor: { kind: "user", id: a.client.id },
    }),
  });
  assert.equal(task.status, 201, task.text);
  const artifact = await store.addArtifact({
    task_id: task.json.id,
    name: "engagement.pdf",
    content_type: "application/pdf",
    content: PDF,
  });

  return { app, store, projectId, artifact, a, b };
}

const envelopeBody = (clientId: string, artifactId: string, clientEmail = "sam@acme.test") => ({
  client_id: clientId,
  title: "Engagement — Acme",
  artifact_id: artifactId,
  filename: "engagement.pdf",
  signers: [
    { role: "client", name: "Sam Hart", email: clientEmail, order: 1 },
    { role: "provider", name: "Ada Bell", email: "ada@northbound.test", order: 2 },
  ],
});

const P = (projectId: string) => ({ "x-mycel-project": projectId });

test("signing over HTTP: the founder sends, the client signs, and the certificate proves it", async () => {
  const { app, projectId, artifact, a } = await world();

  const made = await api(app, "envelopes", { method: "POST", headers: P(projectId), body: JSON.stringify(envelopeBody(a.client.id, artifact.id)) });
  assert.equal(made.status, 201, made.text);
  const id = made.json.envelope.id as string;
  assert.equal(made.json.envelope.status, "draft");

  // A DRAFT IS INVISIBLE TO THE CLIENT. Learning a proposal exists before the founder sent it is
  // the same leak `visibleVersions` prevents for deliverables.
  assert.equal((await api(app, "portal/envelopes", { headers: a.h })).json.envelopes.length, 0);
  assert.equal((await api(app, `portal/envelopes/${id}`, { headers: a.h })).status, 404);

  const sent = await api(app, `envelopes/${id}/send`, { method: "POST", headers: P(projectId) });
  assert.equal(sent.status, 200, sent.text);
  // The hash is read off the stored bytes, not off anything the caller said.
  assert.equal(sent.json.envelope.document.sha256, sha256(Buffer.from(PDF, "utf8")));

  // The client is served the BYTES. This is what `sign` will hash, which is why it is a file and
  // not a description of one.
  const doc = await api(app, `portal/envelopes/${id}/document`, { headers: a.h });
  assert.equal(doc.status, 200);
  assert.equal(doc.text, PDF, "the client is served the file itself, byte for byte");

  const signed = await api(app, `portal/envelopes/${id}/sign`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({ typed_name: "Sam Hart", consented_at: new Date(Date.now() - 20_000).toISOString() }),
  });
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.json.envelope.status, "partially_signed");

  const counter = await api(app, `envelopes/${id}/sign`, {
    method: "POST",
    headers: P(projectId),
    body: JSON.stringify({
      signer_email: "ada@northbound.test",
      typed_name: "Ada Bell",
      consented_at: new Date(Date.now() - 10_000).toISOString(),
    }),
  });
  assert.equal(counter.status, 200, counter.text);
  assert.equal(counter.json.envelope.status, "executed");

  const cert = (await api(app, `envelopes/${id}`, { headers: P(projectId) })).json.certificate;
  assert.equal(cert.status, "executed");
  assert.ok(cert.chain.ok);
  assert.deepEqual(cert.signers.map((s: any) => s.hash_matches), [true, true]);
  // The two signatures were made under DIFFERENT credentials, and the certificate says which.
  assert.deepEqual(cert.signers.map((s: any) => s.status), ["signed", "signed"]);
});

test("a client cannot sign as the counterparty, even holding a valid session", async () => {
  /**
   * THE ATTACK THIS EXISTS FOR.
   *
   * The route takes `signer_email` in the body, which is the obvious way to let an envelope carry
   * two client contacts. Trusting it would let any customer with a working portal link execute the
   * agency's countersignature — every agreement in the system self-executing, from a credential
   * that is supposed to be the weaker one.
   *
   * So the signer is resolved from the envelope's CLIENT-side signers only. The body may pick
   * between them; it may not introduce one.
   */
  const { app, projectId, artifact, a } = await world();
  const id = (
    await api(app, "envelopes", { method: "POST", headers: P(projectId), body: JSON.stringify(envelopeBody(a.client.id, artifact.id)) })
  ).json.envelope.id as string;
  await api(app, `envelopes/${id}/send`, { method: "POST", headers: P(projectId) });

  const attempt = await api(app, `portal/envelopes/${id}/sign`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({
      signer_email: "ada@northbound.test",
      typed_name: "Ada Bell",
      consented_at: new Date(Date.now() - 20_000).toISOString(),
    }),
  });
  // Rejected for the right reason: the client-side set has exactly one member, so the request is
  // signed AS THE CLIENT and the typed name then fails to match. Either way Ada's signature is not
  // obtainable from this credential.
  assert.notEqual(attempt.status, 200);
  const env = (await api(app, `envelopes/${id}`, { headers: P(projectId) })).json.envelope;
  assert.equal(env.signers.find((s: any) => s.role === "provider").status, "pending");
  assert.equal(env.status, "sent");
});

test("another client's envelope does not exist as far as this client is concerned", async () => {
  const { app, projectId, artifact, a, b } = await world();
  const id = (
    await api(app, "envelopes", { method: "POST", headers: P(projectId), body: JSON.stringify(envelopeBody(a.client.id, artifact.id)) })
  ).json.envelope.id as string;
  await api(app, `envelopes/${id}/send`, { method: "POST", headers: P(projectId) });

  // 404, not 403 — a 403 confirms it exists, which is half of what somebody probing wanted.
  assert.equal((await api(app, `portal/envelopes/${id}`, { headers: b.h })).status, 404);
  assert.equal((await api(app, `portal/envelopes/${id}/document`, { headers: b.h })).status, 404);
  assert.equal((await api(app, `portal/envelopes/${id}/sign`, { method: "POST", headers: b.h, body: "{}" })).status, 404);
  assert.equal((await api(app, "portal/envelopes", { headers: b.h })).json.envelopes.length, 0);
  assert.equal((await api(app, "portal/envelopes", { headers: a.h })).json.envelopes.length, 1);
});

test("the client plane never learns the counterparty's address", async () => {
  // A signer list is a contact list. The client needs to know Ada Bell has not signed yet; they do
  // not need her address, and a second client contact on the same envelope must not learn the
  // first one's either.
  const { app, projectId, artifact, a } = await world();
  const id = (
    await api(app, "envelopes", { method: "POST", headers: P(projectId), body: JSON.stringify(envelopeBody(a.client.id, artifact.id)) })
  ).json.envelope.id as string;
  await api(app, `envelopes/${id}/send`, { method: "POST", headers: P(projectId) });

  const seen = (await api(app, `portal/envelopes/${id}`, { headers: a.h })).json.envelope;
  assert.deepEqual(Object.keys(seen.signers[0]).sort(), ["name", "order", "role", "status"]);
  assert.equal(JSON.stringify(seen).includes("@"), false, "no address of any kind reaches the client plane");
});

test("declining needs a reason, and the founder can read it", async () => {
  const { app, projectId, artifact, a } = await world();
  const id = (
    await api(app, "envelopes", { method: "POST", headers: P(projectId), body: JSON.stringify(envelopeBody(a.client.id, artifact.id)) })
  ).json.envelope.id as string;
  await api(app, `envelopes/${id}/send`, { method: "POST", headers: P(projectId) });

  const no = await api(app, `portal/envelopes/${id}/decline`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({ reason: "Price is right, timing is not — ask us in October." }),
  });
  assert.equal(no.status, 200, no.text);
  assert.equal(no.json.envelope.status, "declined");

  const env = (await api(app, `envelopes/${id}`, { headers: P(projectId) })).json.envelope;
  assert.match(env.signers[0].declined_reason, /ask us in October/);
  // "They went quiet" and "they said the timing was wrong" are different facts, and only one of
  // them tells the founder to put a date in the diary.
  const cert = (await api(app, `envelopes/${id}`, { headers: P(projectId) })).json.certificate;
  assert.equal(cert.events.at(-1).what, "Declined");
});

test("an envelope whose document is missing cannot be sent", async () => {
  // Sealing a hash of nothing would produce an envelope that can never be signed — and would look
  // fine until the client opened it.
  const { app, projectId, a } = await world();
  const made = await api(app, "envelopes", {
    method: "POST",
    headers: P(projectId),
    body: JSON.stringify({ ...envelopeBody(a.client.id, "no-such-artifact") }),
  });
  const sent = await api(app, `envelopes/${made.json.envelope.id}/send`, { method: "POST", headers: P(projectId) });
  assert.equal(sent.status, 409);
  assert.match(sent.json.error, /missing/);
});
