// Carrying what the client handed over into the run that asked for it.
//
// ═══ THE WIRE THAT WAS NEVER CONNECTED ═══
//
// Both ends of this already existed and neither knew about the other.
//
//   THE DOOR IN.  `client_requests` has `response_artifact_ids`. The portal collects files against
//                 an open request, `resolveRequest(project, id, response, artifactIds)` stores them,
//                 and the row goes `open → resolved`. All shipped, all working.
//   THE DOOR OUT. `runtime.ts` writes every entry of `task.input.documents` into the sandbox's
//                 `./inputs/`, and the system prompt tells the agent to read there before acting.
//                 Also shipped, also working.
//
// Nothing wrote the second from the first. A client could upload their March statement, watch it
// land in the portal, and the bookkeeping run three hours later would report — correctly, and
// devastatingly — that "the latest bank statement is not yet available". The file was in the
// database the whole time. That is the entire content of the four refusals sitting in production.
//
// This module is the wire. It is deliberately the smallest thing that can be: a read of the case's
// resolved requests, text extraction that already exists, and a `documents` array.
//
// ═══ WHY RESOLVED REQUESTS AND NOT EVERY FILE ON THE CASE ═══
//
// The generous version — mount every artifact anyone ever attached to this client — is wrong twice.
// It sweeps in our own outputs (last month's close, a rejected draft), so a run reads its own prior
// work as if the client had supplied it and compounds a mistake it cannot see. And it removes the
// client's control: a file dropped in a chat to ask a question becomes an input to billed work
// nobody agreed it would feed.
//
// A resolved request is the one artifact class with an unambiguous meaning: WE ASKED FOR THIS, AND
// THEY SENT IT FOR THIS CASE. That provenance is the whole justification for putting it in front of
// an agent, so it is the only thing this reads.
//
// ═══ WHY EXTRACTION IS BOUNDED HERE TOO ═══
//
// `extractText` already refuses politely and caps at `MAX_TEXT_CHARS`. What this adds is a ceiling
// on the NUMBER of documents, because the failure mode differs: one enormous file is refused by the
// existing guard, but eleven ordinary statements are eleven acceptable files that together bury the
// instruction in a context window. A run that reads six documents and says so beats one that reads
// thirty and silently attends to four.

import { extractText, MAX_ATTACHMENT_BYTES } from "./attachments";
import type { Artifact, ClientRequest } from "./contract";

/** Per run. Six is more material than any single episode of this work legitimately needs. */
export const MAX_MATERIALS = 6;

export interface MaterialDoc {
  /** The filename the agent sees at `./inputs/<name>`. */
  name: string;
  /** Extracted text. `runtime.ts` only writes documents whose content is a string. */
  content: string;
}

export interface MaterialsResult {
  documents: MaterialDoc[];
  /** Files we could not read, by name, so the run can say so instead of silently missing them. */
  unreadable: string[];
  /** Files beyond the ceiling, so the omission is reported rather than invisible. */
  omitted: number;
}

/**
 * Filenames are attacker-influenced: a client uploads them.
 *
 * `sandbox.writeFile("inputs/" + name)` with a name of `../../etc/profile` writes outside the
 * directory. The sandbox is a disposable microVM and the blast radius is small, but "small blast
 * radius" is not a reason to pass an unsanitised path — it is the reason this bug survives review
 * everywhere it ships. Basename only, safe characters only, always a name.
 */
export function safeName(raw: string, index: number): string {
  const base = String(raw || "").split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || `document-${index + 1}`;
}

/** Decode an artifact's stored bytes regardless of how the backend kept them. */
export function artifactBytes(a: Pick<Artifact, "content" | "encoding">): Buffer | undefined {
  const content = (a as { content?: unknown }).content;
  if (typeof content !== "string" || !content) return undefined;
  const enc = (a as { encoding?: unknown }).encoding;
  return Buffer.from(content, enc === "base64" ? "base64" : "utf8");
}

/**
 * Everything the client has provided for this case, as documents an agent can read.
 *
 * `fetchArtifact` is injected rather than imported: this module is pure enough to test against a
 * map, and the artifact backend is one of the two things in this kernel (with the pool) that makes
 * a module untestable the moment it is reached for directly.
 *
 * NEWEST FIRST. When a client sends February's statement and then March's, the ceiling should drop
 * February — the recent material is what the current period's work is about, and an ordering that
 * favours whatever was uploaded first gets steadily more wrong as an engagement runs.
 */
const resolvedAt = (r: ClientRequest): string => String(r.resolved_at ?? r.created_at ?? "");

/**
 * What the client TYPED, as a document the run can read.
 *
 * ═══ THE HALF OF THE LOOP THAT WAS STILL MISSING ═══
 *
 * `gatherMaterials` mounted uploaded files and nothing else, so a client who answered a question in
 * the portal — "July 2026", "20% standard rate, dental treatment is exempt" — had their answer
 * stored on the request and read by absolutely nobody. The next run reported that the month and the
 * rate were still not available, which from the client's side is the business asking twice for
 * something they already sent.
 *
 * That is the same shape as every other failure here: a door that exists, works, and nothing reads.
 *
 * And it matters more than the file path, not less. Most client answers are SENTENCES. A month, a
 * rate, a confirmation, a preference. Requiring an attachment to be heard means the product only
 * listens to the minority of answers that happen to be documents.
 */
export function answersDocument(requests: ClientRequest[]): MaterialDoc | undefined {
  const answered = requests
    .filter((r) => r.status === "resolved" && typeof r.response === "string" && r.response.trim())
    .sort((a, b) => resolvedAt(a).localeCompare(resolvedAt(b)));
  if (!answered.length) return undefined;

  // Question and answer together. The answer alone is unreadable — "July 2026" means nothing
  // without the question it settles, and the run has no other way to learn which ask it belongs to.
  const lines = answered.map((r) => `## ${r.ask.trim()}\n\n${String(r.response).trim()}`);
  return {
    name: "client-answers.md",
    content: `# What the client has told us\n\nThese are their own words, in reply to what we asked.\nTreat them as authoritative and do not ask for them again.\n\n${lines.join("\n\n")}`.slice(0, 20_000),
  };
}

export async function gatherMaterials(
  requests: ClientRequest[],
  fetchArtifact: (id: string) => Promise<Artifact | undefined>,
): Promise<MaterialsResult> {
  const resolved = requests
    .filter((r) => r.status === "resolved")
    .sort((a, b) => resolvedAt(b).localeCompare(resolvedAt(a)));

  const ids: string[] = [];
  for (const r of resolved) {
    for (const id of r.response_artifact_ids ?? []) {
      if (id && !ids.includes(id)) ids.push(id);
    }
  }

  const documents: MaterialDoc[] = [];
  const unreadable: string[] = [];
  let omitted = 0;

  for (const id of ids) {
    if (documents.length >= MAX_MATERIALS) {
      omitted++;
      continue;
    }
    const art = await fetchArtifact(id).catch(() => undefined);
    if (!art) continue;

    const name = safeName(art.name || id, documents.length);
    const bytes = artifactBytes(art);
    if (!bytes || bytes.length === 0) {
      unreadable.push(name);
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      unreadable.push(name);
      continue;
    }

    const got = extractText(art.name || name, art.content_type || "", bytes);
    if (got.ok && got.text.trim()) {
      documents.push({ name: extractedName(name), content: got.text });
    } else {
      unreadable.push(name);
    }
  }

  // The typed answers go FIRST, because they are usually the thing that unblocks the work and a
  // run that reads them early asks for less.
  const answers = answersDocument(requests);
  if (answers) documents.unshift(answers);

  return { documents, unreadable, omitted };
}

/**
 * A PDF that has become text should not still be called `.pdf` in `./inputs/`.
 *
 * The agent reads the directory listing before it reads the files. A name promising a binary it
 * cannot parse invites exactly the wasted turns `runtime.ts` documents around the empty-inputs case:
 * the agent reaches for a PDF tool, finds none, and burns the episode discovering that the file was
 * text all along.
 */
export function extractedName(name: string): string {
  return /\.(pdf|docx?|xlsx|xls|pptx?)$/i.test(name) ? `${name.replace(/\.[^.]+$/, "")}.txt` : name;
}

/**
 * The bound version: everything the client provided for THIS task's case.
 *
 * Scoped to the case, never to the client. An agency running bookkeeping and recruiting with us has
 * two engagements, and the CV they sent for a hire has no business being mounted into the run that
 * closes their books — it is not relevant, it costs context, and it is a small disclosure of one
 * piece of their business into another's working notes. `case_id` is the boundary the client would
 * draw themselves.
 *
 * No case means no materials: a task outside an engagement has no client-provided anything, and
 * widening the query to fill the gap is how the isolation above gets lost.
 */
export async function materialsForTask(
  task: { project_id?: string; case_id?: string },
  requests: { listRequests: (f: { project_id: string; case_id?: string; status?: "resolved" }) => Promise<ClientRequest[]> },
  fetchArtifact: (id: string) => Promise<Artifact | undefined>,
): Promise<MaterialsResult | undefined> {
  if (!task.project_id || !task.case_id) return undefined;
  const rows = await requests.listRequests({
    project_id: task.project_id,
    case_id: task.case_id,
    status: "resolved",
  });
  if (!rows.length) return undefined;
  const got = await gatherMaterials(rows, fetchArtifact);
  return got.documents.length || got.unreadable.length ? got : undefined;
}

/**
 * The line the run is told about its own inputs.
 *
 * Says what arrived AND what did not. A run that knows one of five files was unreadable can ask for
 * that one specifically; a run told only about the four it got will confidently report on partial
 * material and never mention the gap — which is the failure the client discovers, not us.
 */
export function materialsNote(m: MaterialsResult): string | undefined {
  if (!m.documents.length && !m.unreadable.length) return undefined;
  const parts: string[] = [];
  if (m.documents.length) {
    parts.push(`${m.documents.length} document(s) the client provided: ${m.documents.map((d) => d.name).join(", ")}`);
  }
  if (m.unreadable.length) parts.push(`could not read: ${m.unreadable.join(", ")}`);
  if (m.omitted) parts.push(`${m.omitted} older file(s) left out for budget`);
  return parts.join(" — ");
}
