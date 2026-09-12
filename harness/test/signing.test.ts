// The electronic signature, and the five things the law asks of one.
//
// Each block below is a requirement from ESIGN §101 / UETA / eIDAS Article 25 rather than a
// function from signing.ts, because the thing under test is whether an executed agreement would
// survive being argued with — not whether a status field changed. A test named after the code can
// pass while the evidence is worthless.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEnvelope,
  sendEnvelope,
  signEnvelope,
  declineEnvelope,
  voidEnvelope,
  sweepExpiredEnvelopes,
  getEnvelope,
  certificate,
  nameMatches,
  currentOrder,
  sha256,
  SigningError,
  _resetSigning,
  type Envelope,
} from "../src/signing";
import { auditList, auditVerify } from "../src/audit";

const PDF = Buffer.from("%PDF-1.4 the engagement letter, in full");
const OTHER = Buffer.from("%PDF-1.4 a different engagement letter");

/**
 * A FRESH PROJECT PER TEST, because the audit chain deliberately has no reset.
 *
 * That is the right shape for the thing being tested: a chain you can truncate between tests is a
 * chain something else could truncate in production. So isolation here is a new project id rather
 * than a cleared log — which also means every assertion below runs against a chain that has real
 * neighbours in it, the way it will in a tenant with a year of history.
 */
let n = 0;
function fresh(): string {
  _resetSigning();
  return `p-sign-${++n}`;
}

async function envelope(project: string, over: Partial<Parameters<typeof createEnvelope>[0]> = {}): Promise<Envelope> {
  return createEnvelope({
    project_id: project,
    client_id: "c1",
    case_id: "k1",
    title: "Engagement — Hart's Bakery",
    document: { artifact_id: "a1", filename: "engagement.pdf", sha256: "", size_bytes: 0 },
    signers: [
      { role: "client", name: "Sam Hart", email: "Sam@hartsbakery.example", order: 1 },
      { role: "provider", name: "Ada Bell", email: "ada@northbound.example", order: 2 },
    ],
    ...over,
  });
}

const signArgs = (env: Envelope, email: string, name: string, over: Record<string, unknown> = {}) => ({
  envelope_id: env.id,
  signer_email: email,
  typed_name: name,
  consented_at: new Date(Date.now() - 30_000).toISOString(),
  auth_method: "portal_link" as const,
  auth_subject: `client:${email}`,
  served_bytes: PDF,
  ip: "203.0.113.9",
  user_agent: "Mozilla/5.0",
  ...over,
});

test("a signature carries every fact a dispute asks for, and the chain proves none of it moved", async () => {
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  assert.equal(env.status, "sent");
  assert.equal(env.document.sha256, sha256(PDF), "the hash is computed from the bytes, not taken from the caller");

  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(env.status, "partially_signed", "one of two signers is not an executed agreement");
  env = await signEnvelope(signArgs(env, "ada@northbound.example", "Ada Bell", { auth_method: "member_session", auth_subject: "member:ada" }));
  assert.equal(env.status, "executed");
  assert.ok(env.completed_at);

  const sam = env.signers.find((s) => s.email === "sam@hartsbakery.example")!;
  // ATTRIBUTION (ESIGN §101(a)). The subject is read off the resolved credential; a signer cannot
  // assert who they are, which is the whole point of it being evidence.
  assert.equal(sam.evidence!.auth_subject, "client:sam@hartsbakery.example");
  assert.equal(sam.evidence!.auth_method, "portal_link");
  assert.equal(sam.evidence!.ip, "203.0.113.9");
  // INTEGRITY. The bytes this signer saw, hashed when they signed.
  assert.equal(sam.evidence!.document_sha256, sha256(PDF));
  // INTENT. Their own name, as they typed it — not the name on the envelope copied across.
  assert.equal(sam.evidence!.typed_name, "Sam Hart");
  // CONSENT strictly before intent.
  assert.ok(Date.parse(sam.evidence!.consented_at) < Date.parse(sam.evidence!.signed_at));

  const cert = await certificate(env);
  assert.equal(cert.status, "executed");
  assert.ok(cert.chain.ok, "the certificate has to be able to say the record is intact");
  assert.deepEqual(cert.signers.map((s) => s.hash_matches), [true, true], "both signed the file that was executed");
  assert.deepEqual(
    cert.events.map((e) => e.what),
    ["Sent for signature", "Signed", "Signed", "Fully executed"],
  );
  // The typed name reaches the certificate, because "they clicked a button" and "they typed their
  // name" are different claims and only one of them is worth printing.
  assert.match(cert.events[1]!.detail, /typed "Sam Hart".*203\.0\.113\.9/);
  assert.ok((await auditVerify(P)).ok);
});

test("a document that changed after it was sent voids the envelope rather than refusing one signer", async () => {
  /**
   * The interesting half is the VOID.
   *
   * Returning an error and leaving the envelope open looks like the polite behaviour and is the
   * dangerous one: signer two could then add their name to a paper signer one never saw, and the
   * executed agreement would carry two signatures over two different documents. A changed document
   * is a bug or an attack, and in both cases the right outcome is that this envelope is finished.
   */
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));

  await assert.rejects(
    () => signEnvelope(signArgs(env, "ada@northbound.example", "Ada Bell", { served_bytes: OTHER })),
    (e: SigningError) => e.code === "document_changed",
  );
  const after = (await getEnvelope(env.id))!;
  assert.equal(after.status, "voided");
  assert.match(after.voided_reason!, /changed after it was sent/);

  // And a voided envelope is finished for everyone, including the signer whose bytes were correct.
  await assert.rejects(
    () => signEnvelope(signArgs(after, "ada@northbound.example", "Ada Bell")),
    (e: SigningError) => e.code === "not_open",
  );
  // The void is on the chain, so the reason survives the row being read later.
  const voided = (await auditList(P)).find((e) => e.action === "signature.voided");
  assert.ok(voided, "voiding an envelope is a consequential act and belongs on the chain");
});

test("consent has to be a separate, earlier act than the signature", async () => {
  // ESIGN §101(c) is explicit that consent to transact electronically is its own step. Almost every
  // implementation collapses it into the signing click, which is the one thing it asks not to do.
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);

  const now = Date.now();
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart", { consented_at: new Date(now + 5_000).toISOString(), now })),
    (e: SigningError) => e.code === "consent_missing",
  );
  // Simultaneous fails too: one click recorded twice is the thing being ruled out.
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart", { consented_at: new Date(now).toISOString(), now })),
    (e: SigningError) => e.code === "consent_missing",
  );
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart", { consented_at: "not a date" })),
    (e: SigningError) => e.code === "consent_missing",
  );
});

test("the typed name is the act of signing, so it is compared and not merely collected", async () => {
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);

  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "")),
    (e: SigningError) => e.code === "name_mismatch",
  );
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Jordan Reeve")),
    (e: SigningError) => e.code === "name_mismatch",
  );

  // FORGIVING ON SHAPE, STRICT ON IDENTITY. The person this must not stop is the honest signer on a
  // phone keyboard; the person it must stop is somebody typing a different name.
  assert.ok(nameMatches("sam hart", "Sam Hart"));
  assert.ok(nameMatches("  Sam   Hart ", "Sam Hart"));
  assert.ok(nameMatches("Samuel Hart", "Sam Hart"), "a fuller first name is the same person signing");
  assert.ok(nameMatches("Sam Hart", "Sam J. Hart"), "a middle initial either way is not a different person");
  assert.ok(nameMatches("Renée Dubois", "Renee Dubois"), "an accent typed or not typed is not a forgery");
  assert.equal(nameMatches("Hart", "Sam Hart"), false, "a surname alone is not a name typed with intent");
  assert.equal(nameMatches("", "Sam Hart"), false);
  assert.equal(nameMatches("Sam Hart", ""), false);
});

test("signing order is enforced, so a countersignature always follows the terms it countersigns", async () => {
  // Commercial rather than legal: an agency that signs first has agreed to terms the client can
  // still change, and its signature is then evidence of nothing.
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  assert.equal(currentOrder(env), 1);

  await assert.rejects(
    () => signEnvelope(signArgs(env, "ada@northbound.example", "Ada Bell")),
    (e: SigningError) => e.code === "not_your_turn",
  );
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(currentOrder(env), 2);
  env = await signEnvelope(signArgs(env, "ada@northbound.example", "Ada Bell"));
  assert.equal(env.status, "executed");

  // Same order means parallel: two clients on one agreement do not wait for each other.
  const P2 = fresh();
  let both = await envelope(P2, {
    signers: [
      { role: "client", name: "Sam Hart", email: "sam@hartsbakery.example", order: 1 },
      { role: "client", name: "Kit Hart", email: "kit@hartsbakery.example", order: 1 },
    ],
  });
  both = await sendEnvelope(both.id, PDF);
  both = await signEnvelope(signArgs(both, "kit@hartsbakery.example", "Kit Hart"));
  assert.equal(both.status, "partially_signed");
  both = await signEnvelope(signArgs(both, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(both.status, "executed");
});

test("declining is an outcome with a reason, not the absence of a signature", async () => {
  // "They never signed" and "they read it and said the price was wrong" are different facts about a
  // deal, and only one of them tells the founder what to do next.
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  env = await declineEnvelope({
    envelope_id: env.id,
    signer_email: "sam@hartsbakery.example",
    reason: "The scope is right but we cannot start before October.",
    auth_subject: "client:sam@hartsbakery.example",
  });
  assert.equal(env.status, "declined");
  assert.equal(env.signers[0]!.status, "declined");
  assert.match(env.signers[0]!.declined_reason!, /before October/);

  const cert = await certificate(env);
  assert.equal(cert.events.at(-1)!.what, "Declined");
  assert.match(cert.events.at(-1)!.detail, /before October/);
  // Declined is terminal: nobody countersigns a refusal.
  await assert.rejects(
    () => signEnvelope(signArgs(env, "ada@northbound.example", "Ada Bell")),
    (e: SigningError) => e.code === "not_open",
  );
});

test("terminal is terminal — an executed agreement cannot be voided, reopened or signed again", async () => {
  const P = fresh();
  let env = await envelope(P, { signers: [{ role: "client", name: "Sam Hart", email: "sam@hartsbakery.example", order: 1 }] });
  env = await sendEnvelope(env.id, PDF);
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(env.status, "executed");

  await assert.rejects(() => voidEnvelope(env.id, "changed our mind"), (e: SigningError) => e.code === "not_open");
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart")),
    (e: SigningError) => e.code === "not_open",
  );
  await assert.rejects(
    () => declineEnvelope({ envelope_id: env.id, signer_email: "sam@hartsbakery.example", reason: "no", auth_subject: "x" }),
    (e: SigningError) => e.code === "not_open",
  );
  assert.equal((await getEnvelope(env.id))!.status, "executed");
});

test("an envelope nobody signed expires, which is a different fact from being withdrawn", async () => {
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  const later = Date.parse(env.expires_at) + 1000;

  assert.equal(await sweepExpiredEnvelopes(later, P), 1);
  assert.equal((await getEnvelope(env.id))!.status, "expired");
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart", { now: later })),
    (e: SigningError) => e.code === "not_open",
  );
  // A second sweep does not re-expire what it already closed.
  assert.equal(await sweepExpiredEnvelopes(later + 1000, P), 0);
});

test("the sweep crosses projects, because expiry is a clock and not one project's request", async () => {
  // THE PROPERTY THAT WAS MISSING, not the one that was tested. The old per-project helper was
  // correct and never ran; what the kernel needs at boot is a sweep that reaches an envelope in a
  // project nobody is currently looking at, which is where a forgotten agreement actually sits.
  const a = fresh();
  const b = fresh();
  const ea = await sendEnvelope((await envelope(a)).id, PDF);
  const eb = await sendEnvelope((await envelope(b)).id, PDF);
  const later = Math.max(Date.parse(ea.expires_at), Date.parse(eb.expires_at)) + 1000;

  const swept = await sweepExpiredEnvelopes(later);
  assert.ok(swept >= 2, `an unscoped sweep skipped a project (expired ${swept})`);
  assert.equal((await getEnvelope(ea.id))!.status, "expired");
  assert.equal((await getEnvelope(eb.id))!.status, "expired");
});

test("expiry does not touch what is already finished", async () => {
  // An executed agreement past its date must stay executed. `expires_at` is a deadline for
  // signing, not a shelf life for the contract — quietly restatusing a signed one would be the
  // worst bug in this file.
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  for (const s of env.signers) env = await signEnvelope(signArgs(env, s.email, s.name));
  assert.equal(env.status, "executed");
  await sweepExpiredEnvelopes(Date.parse(env.expires_at) + 1000);
  assert.equal((await getEnvelope(env.id))!.status, "executed");
});

test("a stranger cannot sign, and neither can the same person twice", async () => {
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  await assert.rejects(
    () => signEnvelope(signArgs(env, "someone@else.example", "Someone Else")),
    (e: SigningError) => e.code === "unknown_signer",
  );
  env = await signEnvelope(signArgs(env, "SAM@HARTSBAKERY.EXAMPLE", "Sam Hart"));
  assert.equal(env.signers[0]!.status, "signed", "an address is matched case-insensitively, as addresses are");
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart")),
    (e: SigningError) => e.code === "already_signed",
  );
});

test("the certificate is derived from the chain, so a tampered record cannot render a clean page", async () => {
  /**
   * The reason `certificate()` computes rather than stores.
   *
   * A stored certificate is a second account of what happened, and two accounts raise a question
   * about which is true. This one is built from the envelope and the audit chain every time it is
   * asked for — so when the chain is broken the certificate says so on its face, which is the only
   * behaviour that makes it worth anything as evidence.
   */
  const P = fresh();
  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));

  const clean = await certificate(env);
  assert.equal(clean.chain.ok, true);
  assert.equal(clean.signers.find((s) => s.role === "provider")!.status, "pending");
  // A pending signer has no evidence and therefore no hash claim — absent, not false.
  assert.equal(clean.signers.find((s) => s.role === "provider")!.hash_matches, undefined);

  const entries = await auditList(P);
  const target = entries.find((e) => e.action === "signature.signed")!;
  (target.detail as Record<string, unknown>).typed_name = "Someone Else";
  const broken = await certificate(env);
  assert.equal(broken.chain.ok, false, "editing what was signed has to break the certificate");
  assert.ok(typeof broken.chain.broken_at === "number");
});

test("an envelope with no signers is refused at creation, not discovered at signing", async () => {
  const P = fresh();
  await assert.rejects(() => envelope(P, { signers: [] }), (e: SigningError) => e.code === "unknown_signer");
});

test("nothing can be signed before it is sent", async () => {
  // The seal happens at send. Signing a draft would mean signing bytes nobody froze.
  const P = fresh();
  const env = await envelope(P);
  assert.equal(env.status, "draft");
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart")),
    (e: SigningError) => e.code === "not_open",
  );
  await assert.rejects(() => sendEnvelope(env.id, PDF).then(() => sendEnvelope(env.id, PDF)), (e: SigningError) => e.code === "not_open");
});

test("the certificate renders as a document, and says on its face when the record is broken", async () => {
  /**
   * A signature that cannot be shown to a third party is a row in a database. This is the artifact
   * that makes it evidence, so the rendering is part of the instrument rather than a nicety.
   *
   * The taste assertion is the load-bearing one. `certificate.ts` was written with hand-picked
   * point sizes and the linter refused it three times over — eight sizes on one page, 7.5 and 8
   * both present, twenty-six unbroken body lines — and then found four separate collisions as the
   * layout was fixed. The last of those truncated every timestamp in the history to "16:…", which
   * would have shipped a certificate whose history nobody could read.
   */
  const P = fresh();
  const { render } = await import("../src/render");
  const { resolveBrandKit } = await import("../src/brandkit");
  const { tasteFindings, isBlocking } = await import("../src/render/taste");
  const { certificateScene } = await import("../src/render/certificate");
  const kit = resolveBrandKit({ display_name: "Northbound Search", accent: "#0f766e" }, "Northbound");

  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));
  env = await signEnvelope(signArgs(env, "ada@northbound.example", "Ada Bell", { auth_method: "member_session", auth_subject: "member:ada" }));
  const cert = await certificate(env);

  const doc = render("certificate", { certificate: cert, reference: "Monthly retainer" }, kit, "pdf");
  assert.deepEqual(doc.taste, [], JSON.stringify(doc.taste));
  assert.ok(doc.size_bytes > 2000, "a certificate with nothing on it is not a certificate");
  assert.match(doc.name, /certificate/);

  // The hash is printed IN FULL, in two halves. A truncated hash is a hash nobody can check, which
  // is the only thing that line is for.
  const scene = certificateScene({ certificate: cert }, kit);
  const texts = JSON.stringify(scene);
  assert.ok(texts.includes(cert.document.sha256.slice(0, 32)), "the first half of the hash");
  assert.ok(texts.includes(cert.document.sha256.slice(32)), "the second half of the hash");
  // And the timestamps carry their time. The history is three columns on one line and the first
  // version silently cut this to "30 August 2026, 16:…".
  assert.match(texts, /\d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC/);
  assert.ok(texts.includes("This record is intact."));
  // The per-signer verdict is stated in WORDS beside the hash, not left as two hex strings to
  // compare. A reader asked to diff those by eye is a reader who will assume they match.
  assert.match(texts, /Signed the document above/);
  // And the page identifies itself as an instrument before it says anything: a masthead band, a
  // bordered record block, a ruled trail. See the header of certificate.ts for why that is not
  // decoration on a document whose whole job is to be believed by a stranger.
  assert.ok(texts.includes("CERTIFICATE OF COMPLETION"));
  assert.ok(texts.includes("DOCUMENT FINGERPRINT"));
  assert.ok(texts.includes("AUDIT TRAIL"));

  // A BROKEN CHAIN IS PRINTED. A certificate that renders a clean page over a tampered log is worse
  // than no certificate: it is a document asserting something false with our name on it.
  const broken = { ...cert, chain: { ok: false, checked: 12, broken_at: 7 } };
  const warned = JSON.stringify(certificateScene({ certificate: broken }, kit));
  assert.ok(warned.includes("THIS RECORD HAS BEEN ALTERED."));
  assert.ok(warned.includes("breaks at entry 7 of 12"));
  assert.equal(warned.includes("This record is intact."), false);
  assert.deepEqual(tasteFindings([certificateScene({ certificate: broken }, kit)]).filter(isBlocking), []);

  // An envelope only half signed renders too — the pending signer says so rather than being absent,
  // because "not yet signed" is the fact the page is being asked about.
  const half = { ...cert, status: "partially_signed" as const, signers: [cert.signers[0]!, { ...cert.signers[1]!, status: "pending" as const, signed_at: undefined, hash_matches: undefined }] };
  const partial = JSON.stringify(certificateScene({ certificate: half }, kit));
  // Set as a status chip in the signature block's own corner, upper-cased like the others.
  assert.ok(partial.includes("NOT YET SIGNED"));
  assert.ok(partial.includes("Awaiting a signature"));
});

test("the proposal is rendered from the checked fields, and the client's own words are on the page", async () => {
  /**
   * The seam between the two halves of a close: the model wrote the engagement and `ship_checks`
   * verified it, and from here nothing a model SAID is trusted again — only what it filled in.
   *
   * Rendering a proposal from prose would mean the price on the page came from a sentence while the
   * price the gate checked came from a number, and nothing would notice when the two disagreed.
   */
  const { proposalScene } = await import("../src/render/proposal");
  const { render } = await import("../src/render");
  const { resolveBrandKit } = await import("../src/brandkit");
  const { tasteFindings, isBlocking } = await import("../src/render/taste");
  const kit = resolveBrandKit({ display_name: "Northbound Search", accent: "#0f766e" }, "Northbound");

  const input = {
    client: "Hart's Bakery",
    headline: "Getting Hart's named when Bristol asks an AI where to buy bread",
    scope: [
      {
        what: "Weekly check of 12 buying questions across ChatGPT, Perplexity and Google's AI answers, with the answers kept word for word.",
        said: "I typed 'best sourdough in Bristol' into ChatGPT and it gave me two places that aren't us.",
      },
      { what: "One page written and published each month against the question you are losing.", said: "We've got nothing on the site about wholesale." },
    ],
    out_of_scope: ["Paid advertising of any kind.", "Rebuilding the existing website."],
    price_minor: 95000,
    currency: "GBP",
    cadence: "monthly" as const,
    term_months: 6,
    starts: "Monday 7 September",
    assumptions: ["The price was the one discussed on the call."],
    from_client: ["Access to publish on hartsbakery.co.uk."],
  };

  const doc = render("proposal", input, kit, "pdf");
  assert.deepEqual(doc.taste, [], JSON.stringify(doc.taste));
  const text = JSON.stringify(proposalScene(input, kit));

  // THE MONEY IS FORMATTED ONCE, from minor units, by the function the invoice uses. A proposal and
  // the invoice that follows it must never disagree about what a client agreed to pay.
  assert.ok(text.includes("£950.00"), "95000 minor units is £950.00");
  assert.equal(text.includes("95000"), false, "the raw minor-unit figure never reaches the page");
  // The term is a labelled row in the bordered terms block now, not a note beside the price. A
  // client deciding whether to sign is answering four questions — price, term, cadence, start date
  // — and presenting them as a block is what lets somebody photograph that section and send it to
  // their partner, which is what actually happens.
  assert.ok(text.includes("Term"));
  assert.ok(text.includes("6 months"));
  assert.ok(text.includes("Work starts"));

  // THE QUOTE IS PRINTED, not merely collected. A founder reviewing the draft can see line by line
  // whether the model read the call or invented a plausible engagement; hiding the quote would
  // leave them approving a document whose provenance they cannot check.
  assert.ok(text.includes("best sourdough in Bristol"));

  // What it does NOT include is on the page. A proposal that only says what is included is the one
  // argued about in month three.
  assert.ok(text.includes("WHAT THIS DOES NOT INCLUDE"));
  assert.ok(text.includes("Paid advertising of any kind."));
  // And the page says how signing works, because somebody about to type their name into a web page
  // is entitled to know beforehand what that will mean.
  assert.ok(text.includes("type your name"));

  /**
   * A LONG BOLD LINE STAYS INSIDE THE MARGIN.
   *
   * Found by rendering one and looking at it. `wrapped` took the base role while the caller passed
   * `{ weight: "bold" }` separately, so every bold line was measured in the regular face and set in
   * the bold one — bold is wider, and the scope ran 35pt past the right margin. Inside the page, so
   * `off-page` never fired; outside the text block, which reads to a client as a broken document.
   */
  const scene = proposalScene(input, kit);
  const ops = scene.nodes.filter((n): n is Extract<typeof n, { t: "text" }> => n.t === "text" && n.anchor !== "end");
  assert.ok(ops.length > 15, `the scene has to actually contain text for this to check anything — found ${ops.length}`);
  const { designFor } = await import("../src/render/design");
  const d = designFor(kit, { base: 10, page: (await import("../src/render/scene")).A4 });
  const { fontFor, textWidth } = await import("../src/render/fonts");
  for (const o of ops) {
    // Measured in the weight it was actually set in, which is the whole point: measuring bold text
    // in the regular face is what produced the overflow.
    const right = o.x + textWidth(o.text, fontFor(o.family, o.weight), o.size);
    assert.ok(right <= d.right + 1, `"${o.text.slice(0, 40)}" ends at ${Math.round(right)}, past the ${Math.round(d.right)}pt margin`);
  }

  assert.deepEqual(tasteFindings([proposalScene(input, kit)]).filter(isBlocking), []);
});

test("a drawn signature is corroboration, and never a substitute for typing your name", async () => {
  /**
   * ═══ THE LEGAL POSITION, TESTED SO NOBODY HAS TO GUESS ═══
   *
   * Click-to-accept in an authenticated portal already meets the threshold of intent under ESIGN
   * §101 and eIDAS Article 25, and `typed_name` is deliberately stronger than a click. A drawing
   * adds nothing to that test.
   *
   * What it adds is weight with a HUMAN audience: on a large agreement the reader of the certificate
   * is a lawyer deciding whether to argue, and a page with a signature settles that faster than a
   * page with a timestamp.
   *
   * Which is exactly why it must not REPLACE the name. A drawing is unverifiable against anything —
   * nobody holds a specimen — so accepting a scrawl instead would weaken the instrument while
   * looking more serious.
   */
  const { readDrawn, MAX_DRAWN_BYTES } = await import("../src/signing");
  const P = fresh();

  // A one-pixel PNG is a real PNG, which is all this layer can honestly check.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const b64 = PNG.toString("base64");

  let env = await envelope(P, { require_drawn: true });
  env = await sendEnvelope(env.id, PDF);

  // TYPING IS STILL REQUIRED. A drawing with the wrong name is refused on the name, because that is
  // the affirmative act and the drawing is corroboration of it.
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Jordan Reeve", { drawn_png: b64 })),
    (e: SigningError) => e.code === "name_mismatch",
  );
  // And on an envelope that asked for one, a name alone is not enough.
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart")),
    (e: SigningError) => e.code === "drawing_required",
  );

  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart", { drawn_png: `data:image/png;base64,${b64}` }));
  const sam = env.signers[0]!.evidence!;
  assert.equal(sam.typed_name, "Sam Hart", "the name is still the act");
  assert.equal(sam.drawn?.png, b64, "the data-URL prefix a canvas produces is stripped, not refused");
  assert.equal(sam.drawn?.sha256, sha256(PNG));

  // THE HASH GOES ON THE CHAIN, NEVER THE IMAGE. An audit detail is read in bulk and this one is up
  // to a quarter of a megabyte; the hash is what proves the mark shown is the mark made.
  const entry = (await auditList(P)).find((e) => e.action === "signature.signed")!;
  assert.equal(entry.detail.drawn_sha256, sha256(PNG));
  assert.equal(JSON.stringify(entry.detail).includes(b64), false, "the image itself must not be on the chain");

  // WHAT IS REFUSED, and every one of these ends up rendered into a PDF a court may read.
  assert.equal(readDrawn(undefined).ok, false);
  assert.equal(readDrawn("").ok, false);
  assert.match((readDrawn("bm90IGEgcG5n") as { why: string }).why, /has to be a PNG/);
  assert.match((readDrawn(`data:image/png;base64,${"A".repeat(MAX_DRAWN_BYTES * 2)}`) as { why: string }).why, /too large/);

  // AND AN UNASKED-FOR DRAWING THAT IS UNREADABLE IS STILL REFUSED. A signer who drew a signature
  // must never be told they signed while it was quietly dropped.
  const P2 = fresh();
  let plain = await envelope(P2);
  plain = await sendEnvelope(plain.id, PDF);
  await assert.rejects(
    () => signEnvelope(signArgs(plain, "sam@hartsbakery.example", "Sam Hart", { drawn_png: "bm90IGEgcG5n" })),
    (e: SigningError) => e.code === "drawing_invalid",
  );
  // A plain envelope with no drawing at all is unaffected — this is optional by design.
  plain = await signEnvelope(signArgs(plain, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(plain.signers[0]!.evidence!.drawn, undefined);
});

test("the certificate is a FILE, because retention means a copy you keep", async () => {
  /**
   * `render/certificate.ts` was written, tested, and reachable from nothing — the routes returned it
   * as JSON, which is a thing a program reads. ESIGN's fifth limb is retention and reproduction:
   * both parties can keep a copy and produce it later. A JSON body is not that.
   *
   * The sixth orphan found in this codebase in one day, and the one with a legal requirement
   * attached to it.
   */
  const P = fresh();
  const { render } = await import("../src/render");
  const { resolveBrandKit } = await import("../src/brandkit");
  const { certificateScene } = await import("../src/render/certificate");
  const kit = resolveBrandKit({ display_name: "Northbound Search", accent: "#0f766e" }, "Northbound");
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  let env = await envelope(P, { require_drawn: true });
  env = await sendEnvelope(env.id, PDF);
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart", { drawn_png: PNG.toString("base64") }));
  env = await signEnvelope(
    signArgs(env, "ada@northbound.example", "Ada Bell", {
      auth_method: "member_session",
      auth_subject: "member:ada",
      drawn_png: PNG.toString("base64"),
    }),
  );
  const cert = await certificate(env);

  const doc = render("certificate", { certificate: cert }, kit, "pdf");
  assert.deepEqual(doc.taste, [], JSON.stringify(doc.taste));
  assert.equal(doc.content_type, "application/pdf");

  // The mark is on the page, as an image, and the page says which mark it is.
  const scene = certificateScene({ certificate: cert }, kit);
  const drawings = scene.nodes.filter((n) => n.t === "image");
  assert.equal(drawings.length, 2, "one per signer who drew");
  assert.ok(JSON.stringify(scene).includes("Drawn by hand"));
  // Not stretched to fill its box. A distorted signature looks forged, which is the opposite of the
  // reason it is on the page.
  for (const d of drawings) assert.ok(d.w / d.h <= 3.3, `aspect ${d.w}/${d.h} is too wide to be a signature`);
});

test("a client can say \"yes, but\" — and gets two rounds, not unlimited ones", async () => {
  /**
   * ═══ THE STATE THIS PRODUCT WAS MISSING, AND THE LIMIT THAT MAKES IT SAFE ═══
   *
   * An envelope had `declined` and nothing else, so "the scope is right, can we do six months
   * instead of twelve" and "we are going with someone else" produced the same row. Opposite facts:
   * one is a deal in progress, the other is a deal lost, and the follow-up for each is the opposite
   * of the follow-up for the other.
   *
   * But an unbounded request-changes button is unbounded unpaid work. Clients do not self-limit —
   * each ask is individually small and reasonable, and there is no moment at which asking again
   * feels like the fourth time. The agency is the only party who experiences the cumulative cost.
   *
   * Two rounds, which is what every real statement of work says, and the proposal says it too.
   */
  const { requestChanges, reviseEnvelope, INCLUDED_CHANGE_ROUNDS, getEnvelope } = await import("../src/signing");
  const P = fresh();
  const V2 = Buffer.from("%PDF-1.4 the engagement letter, six months");
  const V3 = Buffer.from("%PDF-1.4 the engagement letter, six months, no setup fee");

  let env = await envelope(P);
  env = await sendEnvelope(env.id, PDF);
  assert.equal(env.revision, 1);

  env = await requestChanges({
    envelope_id: env.id,
    signer_email: "sam@hartsbakery.example",
    asked: "Scope is right. Can we do six months instead of twelve?",
    auth_subject: "client:sam@hartsbakery.example",
  });
  // NOT `declined`. The distinction is the whole point.
  assert.equal(env.status, "changes_requested");
  assert.match(env.change_requested!.asked, /six months/);
  // Terminal for SIGNING: a paper under renegotiation must not stay signable, or the counterparty
  // could sign the superseded terms while the new ones are being drafted.
  await assert.rejects(
    () => signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart")),
    (e: SigningError) => e.code === "not_open",
  );
  // A blank ask is no ask — the entire value of this over a decline is the sentence. Asserted on a
  // second envelope in the SAME project: `fresh()` clears the store, so calling it mid-test would
  // delete the chain being built.
  const blankable = await sendEnvelope((await envelope(P)).id, PDF);
  await assert.rejects(
    () => requestChanges({ envelope_id: blankable.id, signer_email: "sam@hartsbakery.example", asked: "  ", auth_subject: "x" }),
    (e: SigningError) => e.code === "change_not_said",
  );

  // ── the revision, linked both ways ──
  let v2 = await reviseEnvelope({
    previous_id: env.id,
    document: { artifact_id: "a2", filename: "engagement-v2.pdf", sha256: "", size_bytes: V2.length },
  });
  assert.equal(v2.revision, 2);
  assert.equal(v2.supersedes, env.id);
  assert.equal((await getEnvelope(env.id))!.superseded_by, v2.id, "walkable from either end");
  // Signatures do NOT carry forward: a revision is different bytes, and a signature is evidence
  // about the bytes it was made against.
  assert.deepEqual(v2.signers.map((s) => s.status), ["pending", "pending"]);
  // The relationship does: retyping signers is how a revision reaches the wrong person.
  assert.deepEqual(v2.signers.map((s) => s.email), env.signers.map((s) => s.email));

  v2 = await sendEnvelope(v2.id, V2);
  v2 = await requestChanges({
    envelope_id: v2.id,
    signer_email: "sam@hartsbakery.example",
    asked: "Nearly there — can the setup fee come out?",
    auth_subject: "client:sam@hartsbakery.example",
  });

  // ── round three is where the cap bites ──
  let v3 = await reviseEnvelope({
    previous_id: v2.id,
    document: { artifact_id: "a3", filename: "engagement-v3.pdf", sha256: "", size_bytes: V3.length },
  });
  assert.equal(v3.revision, 3);
  v3 = await sendEnvelope(v3.id, V3);

  await assert.rejects(
    () =>
      requestChanges({
        envelope_id: v3.id,
        signer_email: "sam@hartsbakery.example",
        asked: "And could we add a second location?",
        auth_subject: "client:sam@hartsbakery.example",
      }),
    (e: SigningError) => {
      assert.equal(e.code, "changes_exhausted");
      // It names the founder, not the rule. "You have used your revisions" is a contract term read
      // aloud; a call is what a business would actually offer, and it is the place where scope and
      // price get settled together — which is also where the agency can say no.
      assert.match(e.message, /on a call/);
      return true;
    },
  );
  assert.equal(INCLUDED_CHANGE_ROUNDS, 2);

  // THE CAP BINDS THE CLIENT, NOT THE FOUNDER. A business that wants to send a fourth draft because
  // the deal is worth it sends a fourth draft. The cap stops unpaid work happening by DEFAULT.
  const v4 = await reviseEnvelope({
    previous_id: v3.id,
    document: { artifact_id: "a4", filename: "engagement-v4.pdf", sha256: "", size_bytes: 10 },
  });
  assert.equal(v4.revision, 4);

  // And they can still sign the one in front of them at any point.
  const signable = await sendEnvelope(v4.id, PDF);
  const signed = await signEnvelope(signArgs(signable, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(signed.status, "partially_signed");
});

test("an executed agreement is not revisable, and neither is one already revised", async () => {
  // A change to a signed contract is a NEW agreement, not an edit of the old one — that is true on
  // paper and the code should not be the place somebody discovers otherwise.
  const { reviseEnvelope } = await import("../src/signing");
  const P = fresh();
  let env = await envelope(P, { signers: [{ role: "client", name: "Sam Hart", email: "sam@hartsbakery.example", order: 1 }] });
  env = await sendEnvelope(env.id, PDF);
  env = await signEnvelope(signArgs(env, "sam@hartsbakery.example", "Sam Hart"));
  assert.equal(env.status, "executed");
  await assert.rejects(
    () => reviseEnvelope({ previous_id: env.id, document: { artifact_id: "x", filename: "x.pdf", sha256: "", size_bytes: 1 } }),
    (e: SigningError) => /already executed/.test(e.message),
  );

  // And a chain does not fork. Two live successors is two papers the client could sign, and the one
  // they pick would not be the one we meant.
  const open2 = await sendEnvelope((await envelope(P)).id, PDF);
  await reviseEnvelope({ previous_id: open2.id, document: { artifact_id: "b", filename: "b.pdf", sha256: "", size_bytes: 2 } });
  await assert.rejects(
    () => reviseEnvelope({ previous_id: open2.id, document: { artifact_id: "c", filename: "c.pdf", sha256: "", size_bytes: 3 } }),
    (e: SigningError) => /already been revised/.test(e.message),
  );
});

test("the revision allowance is on the paper, and the two numbers agree", async () => {
  /**
   * A limit the client agreed to in writing is a limit. A limit they meet when a button disappears
   * is a grievance — and the grievance lands on the founder, who did not choose the number.
   */
  const { PROPOSAL_CHANGE_ROUNDS, proposalScene } = await import("../src/render/proposal");
  const { INCLUDED_CHANGE_ROUNDS } = await import("../src/signing");
  const { resolveBrandKit } = await import("../src/brandkit");
  assert.equal(
    PROPOSAL_CHANGE_ROUNDS,
    INCLUDED_CHANGE_ROUNDS,
    "the paper and the gate must promise the same number of rounds",
  );

  const kit = resolveBrandKit({ display_name: "Northbound", accent: "#0f766e" }, "N");
  const text = JSON.stringify(
    proposalScene(
      {
        client: "Hart's Bakery",
        headline: "AI visibility",
        scope: [{ what: "A weekly check", said: "they asked for it" }],
        price_minor: 95000,
        currency: "GBP",
        revision: 3,
      },
      kit,
    ),
  );
  assert.ok(text.includes("CHANGES"));
  assert.match(text, /Two rounds of changes/);
  // And the revision is in the MASTHEAD. Two people arguing about a price while looking at
  // different drafts is the most expensive confusion in a negotiation, and it costs one word.
  assert.ok(text.includes("PROPOSAL · REVISION 3"));
});
