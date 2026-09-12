// Electronic signature — envelopes, evidence, and a certificate anybody can check.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS IN THE KERNEL AND NOT A DOCUSIGN LINE ITEM
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A service business's contract is the moment its revenue becomes real, and every part a signature
// needs already existed here, unconnected:
//
//   · `portal.ts`        a magic link the counterparty had to receive by email to hold
//   · `audit.ts`         a hash chain where each entry embeds the previous one
//   · `render/report.ts` a PDF renderer we control end to end
//   · `portal-approvals` a client acting in their own plane, on a `client:` allowlist
//
// Bolting a vendor on top would have added an invoice, a second identity system, and a second
// source of truth about what was agreed — while making the evidence WEAKER. A vendor certifies
// that it recorded a click. The chain here certifies that the executed document is byte-identical
// to the one each signer was shown, because their signature embeds its hash and the entry embeds
// the hash before it. That is the property a dispute actually turns on and it is the one most
// e-signature products do not have.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE LAW REQUIRES, AND WHERE EACH REQUIREMENT LIVES
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// ESIGN (15 U.S.C. §7001), UETA, eIDAS Article 25 and the UK ECA all want the same five things of a
// simple electronic signature. Each maps to a field below rather than to a comment, because a
// requirement that is only described is a requirement nobody can test:
//
//   1. INTENT TO SIGN — a deliberate act, distinguishable from reading.
//        → `SigningEvidence.typed_name`. The signer types their own name. We never prefill it and
//          we compare it to the name on the envelope. A button alone is an act you can perform by
//          scrolling into it; typing your name is not.
//
//   2. CONSENT TO TRANSACT ELECTRONICALLY — given BEFORE, not with, the signature.
//        → `SigningEvidence.consented_at`, a separate timestamp that must strictly precede
//          `signed_at`. Almost every implementation collapses these into one click, which is the
//          one thing ESIGN §101(c) is explicit about not being enough.
//
//   3. ATTRIBUTION — the signature is attributable to that person.
//        → `SigningEvidence.auth_method` + `auth_subject`. Today that is possession of a portal
//          link delivered to the address on the envelope, plus the session it was exchanged for.
//          The subject is read off the resolved credential, never typed by the signer, so it cannot
//          be asserted by the person it is meant to identify.
//
//   4. RECORD INTEGRITY — the document cannot change after signing.
//        → `SigningEvidence.document_sha256`, captured per signer at the moment of signing and
//          compared to the envelope's sealed hash on every subsequent act. See `SEALED` below.
//
//   5. RETENTION AND REPRODUCTION — both parties can keep and reproduce it.
//        → `certificate()` renders the whole history, and the executed PDF is an artifact on the
//          case that both planes can read.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SEALED AT SEND, CHECKED AT EVERY SIGNATURE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `send()` records the document's sha256 on the envelope. From that moment the bytes are frozen:
// every `sign()` recomputes the hash of what the signer was actually served and refuses if it
// differs.
//
// The refusal VOIDS the envelope rather than returning an error and leaving it open. A document
// that changed mid-signature is either a bug or an attack, and in both cases the correct outcome is
// that nobody can add a second signature to a paper the first signer never saw. Recovering means
// sending a new envelope, which is exactly what a paper process would make you do.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE AUDIT WRITE IS PART OF THE SIGNATURE, NOT A LOG OF IT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `audit()` in audit.ts deliberately swallows its errors — a failed log entry must never fail the
// work it was describing. That is right for a log and wrong here. An executed contract whose
// evidence never persisted is worse than a failed signature, because it looks complete and cannot
// be defended.
//
// So signing goes through `auditOrThrow()`. If the chain cannot be written, the signature does not
// happen and the signer is told to try again.
import { createHash, randomUUID } from "node:crypto";
import { audit, auditList, canonical, type AuditEntry } from "./audit";
import { databaseUrl } from "./config";

/** How long an unsigned envelope stays signable. A proposal nobody signed in a month is dead. */
export const ENVELOPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * ═══ TWO ROUNDS OF CHANGES, AND THEN IT IS A CONVERSATION ═══
 *
 * The system is biased towards the agency being paid, and this constant is where that bias lives.
 *
 * An unbounded "request changes" button is unbounded unpaid work. Clients do not self-limit — not
 * out of malice, but because each individual ask is small and reasonable and there is no moment at
 * which asking again feels like the fourth time. The agency is the only party who experiences the
 * cumulative cost, and they experience it as a week they did not bill for.
 *
 * Two is the number every real statement of work uses. It is enough for the two things that
 * genuinely need settling on most deals — usually the price and the term — and short of the number
 * at which a proposal has quietly become a project.
 *
 * ═══ AND IT IS ON THE PAPER, NOT ONLY IN THE CODE ═══
 *
 * The proposal states it in its terms block. That is what makes the third ask a conversation rather
 * than an argument: a limit the client agreed to in writing is a limit, and a limit they discover
 * when a button disappears is a grievance.
 *
 * Past the cap nothing is refused outright — the client is asked to talk to the founder, and the
 * founder can still revise as many times as they choose. The cap binds the SELF-SERVICE loop, which
 * is the one that runs without anybody deciding it should.
 */
export const INCLUDED_CHANGE_ROUNDS = 2;

/**
 * `sent` and `partially_signed` are the only statuses from which anything can happen.
 *
 * `executed`, `declined`, `voided` and `expired` are TERMINAL and are enforced as such in one place
 * (`assertOpen`) rather than checked at each call site — a status machine whose transitions are
 * spread across five functions is a status machine with a path somebody forgot.
 */
export type EnvelopeStatus =
  | "draft"
  | "sent"
  | "partially_signed"
  | "executed"
  /**
   * "YES, BUT" — AND IT IS NOT "NO".
   *
   * An envelope had `declined` and nothing else, so a client saying "the scope is right, can we do
   * six months instead of twelve" and a client saying "we are going with someone else" produced the
   * same row. Those are opposite facts: one is a deal in progress and the other is a deal lost, and
   * the follow-up for each is the opposite of the follow-up for the other.
   *
   * A service business runs on the first one. The proposal that gets signed is almost never the one
   * that was sent — it is the third, a week later, after they asked about the term and the setup fee
   * came out. Modelling only the clean path left the product with nothing to say about the week in
   * which the work actually happens.
   *
   * `deliverables` has carried `changes_requested` since it was written, for exactly this shape. The
   * vocabulary was already in the product; the contract had just not been given it.
   *
   * TERMINAL FOR SIGNING, which is not a contradiction. A paper under renegotiation must not stay
   * signable — the counterparty could sign the superseded terms while the new ones are being
   * drafted, and they would be right to think they had a deal. `reviseEnvelope` opens the successor.
   */
  | "changes_requested"
  | "declined"
  | "voided"
  | "expired";

export type SignerRole = "client" | "provider";
export type SignerStatus = "pending" | "signed" | "declined";

export interface SigningEvidence {
  /**
   * How we know it was them.
   *
   * `portal_link` means possession of a single-use link delivered to the address on the envelope.
   * `member_session` is the provider side signing from their own authenticated session.
   */
  auth_method: "portal_link" | "member_session";
  /** The subject the credential RESOLVED to. Read from the session; never sent by the client. */
  auth_subject: string;
  ip?: string;
  user_agent?: string;
  /** ESIGN §101(c). Must strictly precede `signed_at`; `sign()` refuses otherwise. */
  consented_at: string;
  /** The affirmative act: the signer's own name, typed by them. Compared, never prefilled. */
  typed_name: string;
  signed_at: string;
  /** The bytes this signer was shown, hashed at the moment they signed. */
  document_sha256: string;
  /**
   * A DRAWN SIGNATURE, WHEN ONE WAS ASKED FOR — and it is evidence, not the signature.
   *
   * ═══ THE LEGAL POSITION, STATED SO NOBODY HAS TO GUESS ═══
   *
   * Click-to-accept in an authenticated portal already meets the threshold of intent under ESIGN
   * §101 and eIDAS Article 25, and `typed_name` is deliberately stronger than a click. A drawing
   * adds nothing to the legal test. It is optional here for that reason and required only when the
   * envelope says so.
   *
   * What it adds is EVIDENTIAL WEIGHT with a human audience. On a $50k enterprise agreement the
   * reader of the certificate is a general counsel deciding whether to argue, and a page with a
   * signature on it settles that faster than a page with a timestamp on it — not because the mark
   * is harder to forge, but because it is what everyone in that conversation expects to see.
   *
   * ═══ IT DOES NOT REPLACE THE TYPED NAME ═══
   *
   * The affirmative act stays the typed name, which is compared against the envelope. A drawing is
   * unverifiable against anything — nobody holds a specimen — so accepting a scrawl INSTEAD of a
   * name would weaken the instrument while looking more serious. Both, or the name alone.
   *
   * The image is hashed like the document, so the certificate can say the mark on the page is the
   * mark that was drawn.
   */
  drawn?: {
    /** PNG bytes, base64, no data-URL prefix. Bounded — see `MAX_DRAWN_BYTES`. */
    png: string;
    sha256: string;
  };
}

export interface Signer {
  role: SignerRole;
  name: string;
  email: string;
  /**
   * 1-based signing order. Everyone sharing an order signs in parallel; a higher order cannot sign
   * until every lower one has.
   *
   * Ordering matters commercially rather than legally: an agency countersigning first has agreed to
   * terms the client can still change, and the countersignature is then evidence of nothing.
   */
  order: number;
  status: SignerStatus;
  evidence?: SigningEvidence;
  declined_reason?: string;
  declined_at?: string;
}

export interface EnvelopeDocument {
  /** The artifact id on the case. What both planes fetch to read the paper. */
  artifact_id: string;
  filename: string;
  /** Sealed at `send()`. Every later act is checked against this. */
  sha256: string;
  /** Bytes, for the hash check and for re-rendering the certificate. */
  size_bytes: number;
}

export interface Envelope {
  id: string;
  project_id: string;
  client_id?: string;
  case_id?: string;
  /** What the signer sees named at the top of the certificate. "Engagement — Hart's Bakery". */
  title: string;
  document: EnvelopeDocument;
  signers: Signer[];
  status: EnvelopeStatus;
  created_at: string;
  sent_at?: string;
  completed_at?: string;
  expires_at: string;
  voided_reason?: string;
  /**
   * Ask every signer to draw as well as type.
   *
   * Declared per envelope rather than inferred from the amount, because "high stakes" is a judgement
   * about the relationship and not a number — a £4k engagement with a new client can matter more
   * than a £60k renewal with one you have had for years. `proposal-envelope.ts` sets it from the
   * price; a founder sending a paper by hand chooses.
   */
  require_drawn?: boolean;
  /**
   * ═══ THE NEGOTIATION, AS A CHAIN ═══
   *
   * `supersedes` points back at the envelope this one replaces; `superseded_by` points forward. Both
   * are set by `reviseEnvelope`, so the lineage is walkable from either end.
   *
   * Kept because the round trip IS the record. "They asked twice about the term and we moved once"
   * is what a founder needs when the same client renegotiates next year, and it is what the file
   * should show: an agreement reached on the third attempt is not less agreed, and hiding the first
   * two makes the relationship look thinner than it was.
   */
  supersedes?: string;
  superseded_by?: string;
  /** 1 for the first attempt. Printed on the proposal, so both sides are discussing the same one. */
  revision: number;
  /** What the client asked to change, when this envelope ended in `changes_requested`. */
  change_requested?: { by: string; asked: string; at: string };
  /**
   * ═══ THE TERMS THE PAPER WAS RENDERED FROM ═══
   *
   * The price lives in the PDF, which is the right place for a client to read it and the wrong place
   * for anything to LEARN from it. Without this, "you proposed twelve months and signed six" is a
   * question nobody can answer without parsing a document.
   *
   * With it, every revision chain is evidence: what was asked for, what moved, and what it cost to
   * get to signed. A business that has done thirty deals through here is carrying thirty worked
   * examples of its own negotiation, and nothing was reading them.
   *
   * Copied from the structured proposal at render time, so it is the same numbers `ship_checks`
   * verified and the same ones on the page — not a second transcription that can drift from either.
   */
  terms?: {
    price_minor: number;
    currency: string;
    cadence?: "one_off" | "monthly" | "quarterly";
    term_months?: number;
  };
  /**
   * What executing this envelope MEANS, declared when it is created rather than decided afterwards.
   *
   * A contract that is signed and then does nothing is the failure this whole path exists to
   * remove. The consequence is data on the envelope so that the thing which starts the work reads
   * it from the signed record — not from a task input somebody could have edited in between.
   */
  on_execute?: { kind: "start_engagement"; money_plan_id?: string; note?: string };
}

export class SigningError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "not_open"
      | "not_your_turn"
      | "unknown_signer"
      | "already_signed"
      | "document_changed"
      | "consent_missing"
      | "name_mismatch"
      | "expired"
      | "change_not_said"
      | "changes_exhausted"
      | "drawing_required"
      | "drawing_invalid"
      | "evidence_not_recorded",
  ) {
    super(message);
    this.name = "SigningError";
  }
}

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/**
 * A drawn signature is a few strokes on a small canvas. 256KB is generous for that and mean for
 * anything else — this is base64 that goes into a database row, an audit detail and a PDF, and a
 * signer who can post arbitrary bytes into all three has found a much more interesting hole than a
 * large image.
 */
export const MAX_DRAWN_BYTES = 256 * 1024;

/** PNG magic. Checked because "it is a PNG" is asserted by the caller and must not be believed. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DrawnSignature {
  png: string;
  sha256: string;
}

/**
 * Accept a drawn signature, or say precisely why not.
 *
 * Strips a `data:image/png;base64,` prefix, because that is what every canvas `toDataURL()` produces
 * and refusing it would make the field awkward for the only client that will ever fill it.
 *
 * Everything else is a refusal. This value is rendered into a PDF that a court may read: a caller
 * that says "PNG" and sends something else is either broken or probing, and neither should reach
 * the decoder.
 */
export function readDrawn(raw: unknown): { ok: true; drawn: DrawnSignature } | { ok: false; why: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, why: "no signature was drawn" };
  const b64 = raw.trim().replace(/^data:image\/png;base64,/, "");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return { ok: false, why: "that signature could not be read" };
  }
  if (bytes.length === 0) return { ok: false, why: "that signature was empty" };
  if (bytes.length > MAX_DRAWN_BYTES) return { ok: false, why: "that signature image is too large" };
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, why: "a drawn signature has to be a PNG" };
  return { ok: true, drawn: { png: b64, sha256: sha256(bytes) } };
}

/**
 * Names match on SHAPE, not on bytes.
 *
 * A signer typing "sam hart" or "Sam  Hart" has performed the affirmative act; refusing them is a
 * usability failure dressed as rigour, and the person it stops is the honest signer on a phone
 * keyboard. What must not pass is a different name or an empty one — a blank box is a click, and a
 * click is what `typed_name` exists to be more than.
 */
export function nameMatches(typed: string, expected: string): boolean {
  const norm = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const t = norm(typed);
  const e = norm(expected);
  if (!t || !e) return false;
  if (t === e) return true;
  // "Samuel Hart" signing as "Sam Hart", or a middle name either way: every word of the shorter
  // name appears in the longer one, in order. A surname alone does not pass — one word is not a
  // name typed with intent when the envelope carries two.
  const tw = t.split(" ");
  const ew = e.split(" ");
  if (tw.length < 2 && ew.length >= 2) return false;
  const [short, long] = tw.length <= ew.length ? [tw, ew] : [ew, tw];
  let i = 0;
  for (const w of long) if (short[i] && (w === short[i] || w.startsWith(short[i]!) || short[i]!.startsWith(w))) i++;
  return i === short.length;
}

/** Whose turn it is: the lowest order with anyone still pending. */
export function currentOrder(env: Envelope): number | undefined {
  const pending = env.signers.filter((s) => s.status === "pending").map((s) => s.order);
  return pending.length ? Math.min(...pending) : undefined;
}

function assertOpen(env: Envelope, now: number): void {
  if (env.status === "draft") throw new SigningError("this envelope has not been sent", "not_open");
  if (env.status !== "sent" && env.status !== "partially_signed")
    throw new SigningError(`this envelope is ${env.status}`, "not_open");
  if (Date.parse(env.expires_at) <= now) throw new SigningError("this envelope has expired", "expired");
}

/**
 * The chain write that is PART of the act rather than a note about it.
 *
 * `audit()` returns void and logs its own failures, so a caller cannot tell a written entry from a
 * dropped one. Here we write, then read the tail back and confirm our entry is in it. That is a
 * round trip, and it is the correct cost: the alternative is an executed contract whose evidence
 * exists only in a log line on a container that has since been replaced.
 */
async function auditOrThrow(
  e: Parameters<typeof audit>[0],
  what: string,
): Promise<AuditEntry> {
  await audit(e);
  const tail = await auditList(e.project_id, 25).catch(() => [] as AuditEntry[]);
  const mine = tail.find(
    (x) =>
      x.action === e.action &&
      x.entity_id === e.entity_id &&
      canonical(x.detail) === canonical(e.detail),
  );
  if (!mine)
    throw new SigningError(
      `${what} could not be recorded, so it did not happen — please try again`,
      "evidence_not_recorded",
    );
  return mine;
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────────
//
// Same shape as `portal.ts`: an in-process map that is a cache, and a database that is the copy
// which matters. A signature that only exists on the replica that took the request is not a
// signature — and unlike a session, you cannot fix it by asking the person to do it again.

const envelopes = new Map<string, Envelope>();
let pg: import("./signing.pg").SigningPg | null = null;

export async function initSigningStore(): Promise<{ backend: "postgres" | "memory" }> {
  const url = databaseUrl();
  if (!url) return { backend: "memory" };
  const { SigningPg } = await import("./signing.pg");
  pg = await SigningPg.connect(url);
  return { backend: "postgres" };
}

export async function closeSigningStore(): Promise<void> {
  await pg?.close().catch(() => {});
  pg = null;
}

async function put(env: Envelope): Promise<void> {
  envelopes.set(env.id, env);
  if (pg) await pg.put(env);
}

export async function getEnvelope(id: string): Promise<Envelope | undefined> {
  const cached = envelopes.get(id);
  if (cached) return cached;
  const row = await pg?.get(id).catch(() => undefined);
  if (row) envelopes.set(row.id, row);
  return row;
}

export async function listEnvelopes(projectId: string, opts: { client_id?: string; case_id?: string } = {}): Promise<Envelope[]> {
  const rows = pg
    ? await pg.list(projectId).catch(() => [...envelopes.values()].filter((e) => e.project_id === projectId))
    : [...envelopes.values()].filter((e) => e.project_id === projectId);
  return rows
    .filter((e) => (opts.client_id ? e.client_id === opts.client_id : true))
    .filter((e) => (opts.case_id ? e.case_id === opts.case_id : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── the acts ────────────────────────────────────────────────────────────────────────────────────

export async function createEnvelope(args: {
  project_id: string;
  client_id?: string;
  case_id?: string;
  title: string;
  document: EnvelopeDocument;
  signers: Omit<Signer, "status" | "evidence">[];
  require_drawn?: boolean;
  /** Set by `reviseEnvelope`. A first attempt passes neither. */
  revision?: number;
  supersedes?: string;
  terms?: Envelope["terms"];
  on_execute?: Envelope["on_execute"];
  now?: number;
}): Promise<Envelope> {
  const now = args.now ?? Date.now();
  if (!args.signers.length) throw new SigningError("an envelope with no signers cannot be signed", "unknown_signer");
  /**
   * ═══ A SIGNER WITH NO NAME MAKES AN ENVELOPE NOBODY CAN COMPLETE ═══
   *
   * `signEnvelope` checks the typed name against `signer.name`. When that is empty, nothing matches
   * it — and the refusal reads "please type your name as it appears on the document: " with nothing
   * after the colon, which is unanswerable.
   *
   * The reason this is a REFUSAL AT CREATION and not a better error at signing: signing is ordered.
   * The client goes first, on the commercial argument a few lines below. So a nameless PROVIDER
   * signer fails only after the client has already typed their name and been recorded — leaving a
   * `partially_signed` contract that binds one party, can never execute, and gives the founder no
   * way to fix it. Observed exactly that way: `openProposalEnvelope` read the provider's name off
   * `kit.display_name`, which is deliberately EMPTY for a project that has not said who it is (see
   * brandkit.ts — a blank masthead is honest, a wrong one is a mistake), and the client signed a
   * document their supplier could not countersign.
   *
   * Nothing is committed at creation, so refusing here costs a caller an error and costs a client
   * nothing.
   */
  const nameless = args.signers.find((s) => !s.name?.trim());
  if (nameless) {
    throw new SigningError(
      `the ${nameless.role} on this document has no name, and a signature is checked against one — ` +
        `set a name before opening an envelope`,
      "name_mismatch",
    );
  }
  const env: Envelope = {
    id: randomUUID(),
    project_id: args.project_id,
    ...(args.client_id ? { client_id: args.client_id } : {}),
    ...(args.case_id ? { case_id: args.case_id } : {}),
    title: args.title,
    document: args.document,
    signers: args.signers.map((s) => ({ ...s, email: s.email.trim().toLowerCase(), status: "pending" as const })),
    status: "draft",
    revision: args.revision ?? 1,
    ...(args.supersedes ? { supersedes: args.supersedes } : {}),
    ...(args.terms ? { terms: args.terms } : {}),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ENVELOPE_TTL_MS).toISOString(),
    ...(args.require_drawn ? { require_drawn: true } : {}),
    ...(args.on_execute ? { on_execute: args.on_execute } : {}),
  };
  await put(env);
  return env;
}

/**
 * SEND — the moment the document is sealed.
 *
 * The hash is recomputed here from the bytes actually stored rather than trusted from the caller,
 * because a caller that computed it earlier is a caller that could be describing a different file.
 */
export async function sendEnvelope(id: string, bytes: Buffer, now = Date.now()): Promise<Envelope> {
  const env = await getEnvelope(id);
  if (!env) throw new SigningError("no such envelope", "not_found");
  if (env.status !== "draft") throw new SigningError(`this envelope is ${env.status}`, "not_open");
  const next: Envelope = {
    ...env,
    document: { ...env.document, sha256: sha256(bytes), size_bytes: bytes.length },
    status: "sent",
    sent_at: new Date(now).toISOString(),
    expires_at: new Date(now + ENVELOPE_TTL_MS).toISOString(),
  };
  await auditOrThrow(
    {
      project_id: env.project_id,
      actor: "system",
      action: "signature.sent",
      entity: "envelope",
      entity_id: env.id,
      detail: {
        title: env.title,
        document_sha256: next.document.sha256,
        signers: next.signers.map((s) => ({ email: s.email, role: s.role, order: s.order })),
      },
    },
    "sending this for signature",
  );
  await put(next);
  return next;
}

/**
 * SIGN — the act, and everything that has to be true for it to count.
 *
 * The checks are ordered by what they protect, cheapest refusal first, with one exception:
 * `document_changed` runs before the turn check even though it is more expensive, because a changed
 * document must void the envelope no matter who noticed.
 */
export async function signEnvelope(args: {
  envelope_id: string;
  signer_email: string;
  typed_name: string;
  consented_at: string;
  auth_method: SigningEvidence["auth_method"];
  auth_subject: string;
  served_bytes: Buffer;
  /** Raw from the pad. Validated by `readDrawn`; never trusted as PNG because it says so. */
  drawn_png?: string;
  ip?: string;
  user_agent?: string;
  now?: number;
}): Promise<Envelope> {
  const now = args.now ?? Date.now();
  const env = await getEnvelope(args.envelope_id);
  if (!env) throw new SigningError("no such envelope", "not_found");
  assertOpen(env, now);

  const email = args.signer_email.trim().toLowerCase();
  const signer = env.signers.find((s) => s.email === email);
  if (!signer) throw new SigningError("you are not a signer on this document", "unknown_signer");
  if (signer.status === "signed") throw new SigningError("you have already signed this", "already_signed");
  if (signer.status === "declined") throw new SigningError("you declined this", "not_open");

  // INTEGRITY FIRST. A document that changed between send and signature voids the envelope, whoever
  // is holding it — returning an error and leaving it open would let the next signer add their name
  // to a paper the first one never saw.
  const served = sha256(args.served_bytes);
  if (served !== env.document.sha256) {
    await voidEnvelope(env.id, `the document changed after it was sent (served ${served.slice(0, 12)}, sealed ${env.document.sha256.slice(0, 12)})`, now);
    throw new SigningError("this document has changed since it was sent and can no longer be signed", "document_changed");
  }

  const turn = currentOrder(env);
  if (turn !== undefined && signer.order > turn)
    throw new SigningError("it is not your turn to sign yet", "not_your_turn");

  // CONSENT STRICTLY BEFORE INTENT. Equal timestamps fail: they mean one click was recorded twice,
  // which is the thing ESIGN §101(c) asks for a separate act to rule out.
  const consented = Date.parse(args.consented_at);
  if (!Number.isFinite(consented) || consented >= now)
    throw new SigningError("consent to sign electronically has to be given before signing", "consent_missing");

  if (!nameMatches(args.typed_name, signer.name))
    throw new SigningError(`please type your name as it appears on the document: ${signer.name}`, "name_mismatch");

  /**
   * The drawing, when the envelope asked for one.
   *
   * Checked AFTER the name, deliberately. The typed name is the affirmative act and the drawing is
   * corroboration, so a signer who typed the wrong name should be told that first — being asked to
   * redraw and then told the name was wrong is two trips for one mistake.
   */
  let drawn: DrawnSignature | undefined;
  if (args.drawn_png !== undefined || env.require_drawn) {
    const read = readDrawn(args.drawn_png);
    if (!read.ok) {
      // An envelope that did not ask for one and got something unreadable is refused too, rather
      // than silently dropping it: a signer who drew a signature must not be told they signed
      // without one being kept.
      throw new SigningError(read.why, env.require_drawn && args.drawn_png === undefined ? "drawing_required" : "drawing_invalid");
    }
    drawn = read.drawn;
  }

  const evidence: SigningEvidence = {
    auth_method: args.auth_method,
    auth_subject: args.auth_subject,
    ...(args.ip ? { ip: args.ip } : {}),
    ...(args.user_agent ? { user_agent: args.user_agent.slice(0, 300) } : {}),
    consented_at: new Date(consented).toISOString(),
    typed_name: args.typed_name.trim(),
    signed_at: new Date(now).toISOString(),
    document_sha256: served,
    ...(drawn ? { drawn } : {}),
  };

  const signers = env.signers.map((s) => (s.email === email ? { ...s, status: "signed" as const, evidence } : s));
  const done = signers.every((s) => s.status === "signed");
  const next: Envelope = {
    ...env,
    signers,
    status: done ? "executed" : "partially_signed",
    ...(done ? { completed_at: new Date(now).toISOString() } : {}),
  };

  await auditOrThrow(
    {
      project_id: env.project_id,
      actor: evidence.auth_subject,
      action: "signature.signed",
      entity: "envelope",
      entity_id: env.id,
      // Everything a dispute asks for, and nothing that is a secret. The IP and user agent are
      // evidence of circumstance; the hash is evidence of WHAT.
      detail: {
        signer: signer.email,
        role: signer.role,
        typed_name: evidence.typed_name,
        consented_at: evidence.consented_at,
        signed_at: evidence.signed_at,
        document_sha256: evidence.document_sha256,
        auth_method: evidence.auth_method,
        ...(evidence.ip ? { ip: evidence.ip } : {}),
        ...(evidence.user_agent ? { user_agent: evidence.user_agent } : {}),
        // The HASH of the drawing, never the drawing. An audit detail is read in bulk and this one
        // is a quarter of a megabyte; the hash is what proves the mark on the certificate is the
        // mark that was made, which is the only question the chain is being asked.
        ...(evidence.drawn ? { drawn_sha256: evidence.drawn.sha256 } : {}),
      },
    },
    "your signature",
  );
  if (done) {
    await auditOrThrow(
      {
        project_id: env.project_id,
        actor: "system",
        action: "signature.executed",
        entity: "envelope",
        entity_id: env.id,
        detail: { title: env.title, document_sha256: env.document.sha256, signers: signers.map((s) => s.email) },
      },
      "completing this agreement",
    );
  }
  await put(next);
  return next;
}

/**
 * DECLINE — a first-class outcome, not the absence of a signature.
 *
 * Modelled because "they never signed" and "they read it and said no" are different facts about a
 * deal, and only one of them is worth a follow-up. The reason is carried so the founder finds out
 * what was wrong with the proposal rather than that it went quiet.
 */
export async function declineEnvelope(args: {
  envelope_id: string;
  signer_email: string;
  reason: string;
  auth_subject: string;
  now?: number;
}): Promise<Envelope> {
  const now = args.now ?? Date.now();
  const env = await getEnvelope(args.envelope_id);
  if (!env) throw new SigningError("no such envelope", "not_found");
  assertOpen(env, now);
  const email = args.signer_email.trim().toLowerCase();
  const signer = env.signers.find((s) => s.email === email);
  if (!signer) throw new SigningError("you are not a signer on this document", "unknown_signer");
  if (signer.status === "signed") throw new SigningError("you have already signed this", "already_signed");

  const next: Envelope = {
    ...env,
    signers: env.signers.map((s) =>
      s.email === email
        ? { ...s, status: "declined" as const, declined_reason: args.reason.slice(0, 500), declined_at: new Date(now).toISOString() }
        : s,
    ),
    status: "declined",
    completed_at: new Date(now).toISOString(),
  };
  await auditOrThrow(
    {
      project_id: env.project_id,
      actor: args.auth_subject,
      action: "signature.declined",
      entity: "envelope",
      entity_id: env.id,
      detail: { signer: email, reason: args.reason.slice(0, 500), at: next.completed_at },
    },
    "your decline",
  );
  await put(next);
  return next;
}

/**
 * REQUEST CHANGES — the client saying "yes, but".
 *
 * ═══ WHY THIS IS NOT `decline` WITH NICER WORDING ═══
 *
 * A decline ends a conversation. This continues one, and the difference is the whole reason both
 * exist: the founder's next move after a decline is to find out what went wrong, and after this it
 * is to send a new number. Collapsing them meant the product could not tell a deal in progress from
 * a deal lost, on the one screen where that is the only question.
 *
 * `asked` is required, and required to be more than a shrug. "They want changes" is what a CRM field
 * records; what the next proposal needs is the sentence they actually wrote.
 *
 * ═══ IT CLOSES THE ENVELOPE, AND THAT IS DELIBERATE ═══
 *
 * A paper under renegotiation must not stay signable. Leaving it open would let the counterparty
 * sign the superseded terms while the new ones are being drafted — and they would be right to think
 * they had a deal, because they would.
 *
 * So this is terminal for SIGNING and open for BUSINESS. `reviseEnvelope` opens the successor and
 * links the two, so the round trip is a chain rather than a pile of unrelated envelopes.
 */
export async function requestChanges(args: {
  envelope_id: string;
  signer_email: string;
  asked: string;
  auth_subject: string;
  now?: number;
}): Promise<Envelope> {
  const now = args.now ?? Date.now();
  const env = await getEnvelope(args.envelope_id);
  if (!env) throw new SigningError("no such envelope", "not_found");
  assertOpen(env, now);
  const email = args.signer_email.trim().toLowerCase();
  const signer = env.signers.find((s) => s.email === email);
  if (!signer) throw new SigningError("you are not a signer on this document", "unknown_signer");
  if (signer.status === "signed") throw new SigningError("you have already signed this", "already_signed");

  const asked = args.asked.trim();
  // A blank ask is the same as no ask. The whole value of this act over a decline is the sentence.
  if (asked.length < 3) throw new SigningError("tell us what to change and we will send a new one", "change_not_said");

  /**
   * THE CAP, READ OFF THE CHAIN rather than off this row.
   *
   * `revision` counts attempts, so a client looking at their third proposal has already had two
   * rounds. Checking the chain and not this envelope is what closes the obvious hole: otherwise a
   * client could ask once per envelope for ever and every individual envelope would look compliant.
   *
   * The message names the founder rather than the rule. "You have used your revisions" is a contract
   * term read aloud; "we will get you on a call" is what a business would actually say, and it moves
   * the conversation to the place where scope and price get settled together — which is also the
   * place where the agency can say no.
   */
  if (env.revision > INCLUDED_CHANGE_ROUNDS) {
    throw new SigningError(
      `That is past the ${INCLUDED_CHANGE_ROUNDS} rounds of changes included. Reply to the email and we will get you on a call — it is faster than another draft.`,
      "changes_exhausted",
    );
  }

  const next: Envelope = {
    ...env,
    status: "changes_requested",
    completed_at: new Date(now).toISOString(),
    change_requested: { by: email, asked: asked.slice(0, 2000), at: new Date(now).toISOString() },
  };
  await auditOrThrow(
    {
      project_id: env.project_id,
      actor: args.auth_subject,
      action: "signature.changes_requested",
      entity: "envelope",
      entity_id: env.id,
      detail: { signer: email, asked: asked.slice(0, 2000), revision: env.revision },
    },
    "your request",
  );
  await put(next);
  return next;
}

/**
 * REVISE — the next attempt, linked to the last one.
 *
 * ═══ THE PROPOSAL THAT GETS SIGNED IS ALMOST NEVER THE ONE THAT WAS SENT ═══
 *
 * It is the third one, a week later, after they asked about the term and the setup fee came out.
 * Without this the founder's only option was to create an unrelated envelope, and the file then said
 * a client signed a twelve-month agreement with no record that they had asked twice about six.
 *
 * The chain is walkable from either end: the old envelope gets `superseded_by`, the new one gets
 * `supersedes`, and the revision number increments. An agreement reached on the third attempt is
 * not less agreed, and hiding the first two makes the file look thinner than the relationship was.
 *
 * ═══ WHAT IT CARRIES FORWARD, AND WHAT IT DOES NOT ═══
 *
 * Signers, title, client and case carry over — those are the relationship, and retyping them is how
 * a revision ends up addressed to the wrong person.
 *
 * SIGNATURES DO NOT. A revision is a different document, and a signature is evidence about the
 * bytes it was made against; carrying one forward would assert that somebody signed a paper they
 * have never seen. Everyone signs again, which is what happens on paper too.
 */
export async function reviseEnvelope(args: {
  previous_id: string;
  /** The new paper. A revision with the same document as its predecessor is not a revision. */
  document: EnvelopeDocument;
  title?: string;
  /** The new terms, when they moved. Absent carries the previous ones forward. */
  terms?: Envelope["terms"];
  now?: number;
}): Promise<Envelope> {
  const now = args.now ?? Date.now();
  const prev = await getEnvelope(args.previous_id);
  if (!prev) throw new SigningError("no such envelope", "not_found");
  if (prev.status === "executed")
    throw new SigningError("that agreement is already executed — a change to it is a new agreement", "not_open");
  if (prev.superseded_by) throw new SigningError("that envelope has already been revised", "not_open");

  // An open predecessor is closed first. Two live envelopes for one agreement is two papers the
  // client could sign, and the one they pick would not be the one we meant.
  if (prev.status === "sent" || prev.status === "partially_signed") {
    await voidEnvelope(prev.id, "superseded by a revision", now);
  }

  const next = await createEnvelope({
    project_id: prev.project_id,
    ...(prev.client_id ? { client_id: prev.client_id } : {}),
    ...(prev.case_id ? { case_id: prev.case_id } : {}),
    title: args.title ?? prev.title,
    document: args.document,
    // Stripped back to pending. See the note above: a signature is evidence about specific bytes.
    signers: prev.signers.map((s) => ({ role: s.role, name: s.name, email: s.email, order: s.order })),
    ...(prev.require_drawn ? { require_drawn: true } : {}),
    ...(prev.on_execute ? { on_execute: prev.on_execute } : {}),
    // Carried so a revision that changed only the scope still has terms; the caller overwrites them
    // when the price moved, which is the case that makes the chain worth reading.
    ...(args.terms ?? prev.terms ? { terms: args.terms ?? prev.terms } : {}),
    revision: prev.revision + 1,
    supersedes: prev.id,
    now,
  });

  const closed = (await getEnvelope(prev.id)) ?? prev;
  const linked: Envelope = { ...closed, superseded_by: next.id };
  envelopes.set(linked.id, linked);
  // THROUGH THE NAMED ESCAPE, because `put` refuses to write a terminal row — which is the guard
  // that makes a settled agreement settled in the database too. See `linkSuccessor` in signing.pg.
  if (pg) await pg.linkSuccessor(prev.id, next.id).catch((e) => console.error("[mycel] could not link the revision:", e));
  await audit({
    project_id: prev.project_id,
    actor: "system",
    action: "signature.revised",
    entity: "envelope",
    entity_id: prev.id,
    detail: { supersededBy: next.id, revision: next.revision, was: closed.status },
  });
  return next;
}

/** VOID — the provider withdrawing it, or the integrity check refusing it. One way, always. */
export async function voidEnvelope(id: string, reason: string, now = Date.now()): Promise<Envelope> {
  const env = await getEnvelope(id);
  if (!env) throw new SigningError("no such envelope", "not_found");
  if (env.status === "executed") throw new SigningError("an executed agreement cannot be voided", "not_open");
  const next: Envelope = { ...env, status: "voided", voided_reason: reason.slice(0, 500), completed_at: new Date(now).toISOString() };
  // NOT `auditOrThrow`. Voiding is how we refuse a signature, and a void that throws because the
  // chain is briefly unreachable would leave a suspect envelope open — the exact state voiding
  // exists to prevent. Best effort here is the safe direction; everywhere else it is not.
  await audit({
    project_id: env.project_id,
    actor: "system",
    action: "signature.voided",
    entity: "envelope",
    entity_id: env.id,
    detail: { reason: next.voided_reason },
  });
  await put(next);
  return next;
}


/**
 * THE SWEEP THAT WAS NEVER CALLED, now global and on a timer.
 *
 * `expireEnvelopes` had existed, tested, since signing shipped, and nothing in the kernel ever
 * invoked it. This replaces it. `assertOpen` refuses a signature past `expires_at`, so no contract was ever
 * signed late and nothing here is a security fix — but the STATUS never moved. An envelope that
 * ran out sat at `sent` for ever: the dashboard kept telling a founder to chase a client about an
 * agreement that could no longer be signed, the client got "this envelope has expired" as a
 * surprise at the moment of clicking, and no `signature.expired` entry was ever written, so the
 * audit chain simply had nothing where the ending should be.
 *
 * The tell was in signing.pg.ts: `signature_envelopes_open_idx` indexes exactly `(status,
 * expires_at)` with a comment about "the sweep", built for a caller that was never written.
 *
 * Global by default, because expiry is a clock rather than somebody's request, and a per-project
 * loop would need an enumeration of projects that exists nowhere and would only grow. `projectId`
 * narrows it, which is what the deleted `expireEnvelopes` did — it was a second copy of this logic
 * that only tests ever called, and two implementations of "what counts as expired" is one more
 * than a status this load-bearing can safely have.
 *
 * ONE AT A TIME AND FAILURE IS PER ENVELOPE. `audit` before `put`: if the chain write throws, that
 * envelope keeps its old status and is picked up on the next pass.
 * The alternative — mark expired, then fail to record why — produces exactly the silent status
 * change that the audit trail exists to make impossible.
 */
export async function sweepExpiredEnvelopes(now = Date.now(), projectId?: string): Promise<number> {
  const iso = new Date(now).toISOString();
  const open = (e: Envelope) =>
    (e.status === "sent" || e.status === "partially_signed") && Date.parse(e.expires_at) <= now;
  const all = pg ? await pg.dueForExpiry(iso) : [...envelopes.values()].filter(open);
  const due = projectId ? all.filter((e) => e.project_id === projectId) : all;
  let expired = 0;
  for (const env of due) {
    try {
      await audit({
        project_id: env.project_id,
        actor: "system",
        action: "signature.expired",
        entity: "envelope",
        entity_id: env.id,
        detail: { title: env.title, expired_at: iso },
      });
      await put({ ...env, status: "expired", completed_at: iso });
      expired++;
    } catch (e) {
      console.error(`[mycel] could not expire envelope ${env.id}:`, e);
    }
  }
  return expired;
}

/** Hourly. An envelope has a thirty-day life, so the cost of being an hour late is nothing. */
export const ENVELOPE_SWEEP_MS = 60 * 60 * 1000;

/**
 * The timer. Same shape as the starvation sweep: overlap-guarded, unref'd, and it swallows its own
 * errors — a watchdog that can take the process down is worse than the thing it watches.
 *
 * No boot tick. Every kernel replica runs this, and on a deploy they all start together; a sweep
 * one interval in costs nothing and keeps the boot path free of a database round trip that has
 * never been urgent. Concurrent replicas are safe by construction: expiring an already-expired
 * envelope is not possible, because `dueForExpiry` only returns open ones.
 */
export function startEnvelopeExpirySweep(intervalMs = ENVELOPE_SWEEP_MS): { stop(): void; tick(): Promise<number> } {
  let running = false;
  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const n = await sweepExpiredEnvelopes();
      if (n) console.log(`[mycel] expired ${n} signature envelope(s) past their date`);
      return n;
    } catch (e) {
      console.error("[mycel] envelope expiry sweep error:", e);
      return 0;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), tick };
}

// ── the certificate ─────────────────────────────────────────────────────────────────────────────

export interface CertificateEvent {
  at: string;
  what: string;
  who: string;
  detail: string;
}

export interface Certificate {
  envelope_id: string;
  title: string;
  status: EnvelopeStatus;
  document: { filename: string; sha256: string; size_bytes: number };
  signers: {
    name: string;
    email: string;
    role: SignerRole;
    status: SignerStatus;
    signed_at?: string;
    consented_at?: string;
    typed_name?: string;
    ip?: string;
    document_sha256?: string;
    /** Whether the bytes this signer saw are the bytes in the executed file. */
    hash_matches?: boolean;
    /** The mark, for the page. Present only when one was drawn. */
    drawn_png?: string;
    drawn_sha256?: string;
  }[];
  events: CertificateEvent[];
  /** The chain, verified. This is the sentence the whole file exists to be able to print. */
  chain: { ok: boolean; checked: number; broken_at?: number };
}

/**
 * The certificate is DERIVED, never stored.
 *
 * A stored certificate is a second account of what happened, and the moment there are two accounts
 * there is a question about which one is true. This one is computed from the envelope and the audit
 * chain every time it is asked for, so it cannot drift from the evidence — and if the chain has
 * been tampered with, the certificate says so on its face rather than rendering a clean page over a
 * broken log.
 */
export async function certificate(env: Envelope): Promise<Certificate> {
  const entries = (await auditList(env.project_id, 100_000).catch(() => [] as AuditEntry[]))
    .filter((e) => e.entity === "envelope" && e.entity_id === env.id)
    .sort((a, b) => a.seq - b.seq);

  const { verifyChain } = await import("./audit");
  const all = await auditList(env.project_id, 100_000).catch(() => [] as AuditEntry[]);
  const chain = verifyChain(all.slice().sort((a, b) => a.seq - b.seq));

  const label: Record<string, string> = {
    "signature.sent": "Sent for signature",
    "signature.signed": "Signed",
    "signature.declined": "Declined",
    "signature.voided": "Voided",
    "signature.expired": "Expired",
    "signature.executed": "Fully executed",
  };

  return {
    envelope_id: env.id,
    title: env.title,
    status: env.status,
    document: { filename: env.document.filename, sha256: env.document.sha256, size_bytes: env.document.size_bytes },
    signers: env.signers.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role,
      status: s.status,
      ...(s.evidence?.signed_at ? { signed_at: s.evidence.signed_at } : {}),
      ...(s.evidence?.consented_at ? { consented_at: s.evidence.consented_at } : {}),
      ...(s.evidence?.typed_name ? { typed_name: s.evidence.typed_name } : {}),
      ...(s.evidence?.ip ? { ip: s.evidence.ip } : {}),
      ...(s.evidence?.document_sha256 ? { document_sha256: s.evidence.document_sha256 } : {}),
      ...(s.evidence ? { hash_matches: s.evidence.document_sha256 === env.document.sha256 } : {}),
      ...(s.evidence?.drawn ? { drawn_png: s.evidence.drawn.png, drawn_sha256: s.evidence.drawn.sha256 } : {}),
    })),
    events: entries.map((e) => ({
      at: e.at,
      what: label[e.action] ?? e.action,
      who: String(e.detail.signer ?? e.actor),
      detail:
        e.action === "signature.signed"
          ? `typed "${String(e.detail.typed_name ?? "")}"${e.detail.ip ? ` from ${String(e.detail.ip)}` : ""}`
          : e.action === "signature.declined"
            ? String(e.detail.reason ?? "")
            : e.action === "signature.voided"
              ? String(e.detail.reason ?? "")
              : `document ${String(e.detail.document_sha256 ?? env.document.sha256).slice(0, 16)}`,
    })),
    chain: {
      ok: chain.ok,
      checked: all.length,
      ...(chain.ok ? {} : { broken_at: chain.broken_at ?? -1 }),
    },
  };
}

export function _resetSigning(): void {
  envelopes.clear();
}
