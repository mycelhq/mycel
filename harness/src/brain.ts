// The company brain — a read-only, per-org query facade over the stores that already hold the truth.
//
// WHAT THIS FIXES
//
// A run cannot see the business it is working for. It can read its own case, its own records, the
// knowledge mounted into its sandbox — and nothing else. "Who is this client, what have we sent
// them, what do they owe us" is unanswerable from a sandbox today, which means every agent that
// needs those answers either guesses or asks a human. Both are the failure this product exists to
// remove.
//
// WHAT IT IS NOT: A SECOND HOME FOR THE TRUTH
//
// client-context.ts:1-23 argues that adding a `ClientMemory` table would create a second place for
// the truth to live and immediately start disagreeing with the first. That comment is the decision,
// and this module obeys it. Nothing here owns a row. Every answer is dispatched to the store that
// already owns it — rules and knowledge items, `queryRecords`, cases, `BillingStore.listInvoices`,
// threads and messages — and this file contributes exactly two things those stores cannot: one
// authority, applied identically to all of them, and one shape of answer.
//
// RETRIEVAL IS STRUCTURED QUERY + TEXT MATCH. NO EMBEDDINGS. Deliberately. The questions this
// business actually asks are numeric, filtered and aggregate — "what did we invoice Northwind in
// March", "which receipts are missing", "how many open invoices are overdue". A vector index answers
// those approximately when the exact answer is one WHERE clause away, and an approximate answer
// about money is worse than no answer. The term matching below is the portable half of the same
// query a Postgres backend runs with FTS; both are exact, and neither can rank a row it is not
// allowed to read into view.
//
// ═══ THE AUTHORITY IS DERIVED, NEVER PASSED ═══
//
// `BrainAuthority` is branded with a module-private symbol, so an object literal shaped like one
// does NOT typecheck outside this file: the only way to obtain one is `deriveAuthority`, and the
// only input it takes is a task that was looked up from an action grant's nonce. There is
// deliberately no code path — not one — that builds a query scope from caller input. Request filters
// are intersected with the authority (`narrow`), so a filter can only ever make the answer smaller.
//
// That is the difference between this and every "just pass the project id" read that has leaked in
// this codebase: `POST /v1/internal/records/query` had to grow `if (!task.project_id) return 403`
// after the fact, because the scope was assembled at the call site and one call site forgot.
import { mayMount, ruleMayApply, type KnowledgeSensitivity } from "./knowledge";
import type { KnowledgeStore } from "./knowledge.store";
import type { DomainStore } from "./domain";
import type { BillingStore } from "./billing";
import { effectiveStatus, invoiceTotals } from "./billing";
import type { Task } from "./contract";
import type { ActionGrant } from "./actiongrants";

/** The stores the brain dispatches to. Passed in, never reached for: this module holds no singleton. */
export interface BrainStores {
  domain: DomainStore;
  billing: BillingStore;
  knowledge: KnowledgeStore;
}

/**
 * The brand. `unique symbol` in a non-exported const is unforgeable from outside this module: there
 * is no way to write a property whose key is a symbol you cannot name, so
 * `const a: BrainAuthority = { project_id: "…" }` is a type error at every call site in the repo.
 *
 * This is the private constructor, expressed in the only way TypeScript has one. It matters because
 * the whole safety argument is "the scope came from the nonce"; a structurally-typed authority would
 * let any handler assert its way past that with a plausible-looking literal, which is precisely the
 * mistake `/v1/internal/records/query` made in its first version.
 */
declare const BRAND: unique symbol;

/** WHAT THIS RUN MAY SEE. Derived from a task. Immutable, and only ever narrowed. */
export interface BrainAuthority {
  readonly [BRAND]: "brain-authority";
  readonly task_id: string;
  /** Tenant. Never empty — `deriveAuthority` refuses a task without one. */
  readonly project_id: string;
  readonly wedge: string;
  /**
   * The clients this run is working for. Empty means a house-wide run, and a house-wide run reads
   * NO client-owned row — not "all of them". The empty set is the tightest scope, never the widest;
   * reading it as "unfiltered" is the exact bug this family of leaks is made of.
   */
  readonly client_ids: readonly string[];
  readonly case_ids: readonly string[];
  /** `house` on a run with no client. `client` only when there is a named client to be about. */
  readonly max_sensitivity: KnowledgeSensitivity;
}

/**
 * The one constructor.
 *
 * Returns undefined for a task with no project — the same refusal as `POST
 * /v1/internal/records/query`'s `if (!task.project_id) return 403`, made unforgettable by living
 * here instead of at each call site. An unattributed task reads nothing rather than everything.
 *
 * The grant contributes only its `caseId`: it is the case the harness itself attached to this run,
 * so it is authority, not input. Nothing else from the request participates.
 */
export function deriveAuthority(task: Task | undefined, grant?: Pick<ActionGrant, "caseId">): BrainAuthority | undefined {
  if (!task?.project_id) return undefined;
  const clientIds = task.client_id ? [task.client_id] : [];
  const caseIds = [task.case_id, grant?.caseId].filter((v): v is string => !!v);
  return {
    task_id: task.id,
    project_id: task.project_id,
    wedge: task.wedge,
    client_ids: Object.freeze(clientIds),
    case_ids: Object.freeze([...new Set(caseIds)]),
    max_sensitivity: clientIds.length ? "client" : "house",
  } as BrainAuthority;
}

/**
 * Founder-plane authority: everything in THIS project the founder is allowed to see.
 *
 * Distinct from `deriveAuthority` on purpose. A run with empty `client_ids` is house-wide and
 * reads NO client row. A founder looking at their own business is the opposite — they own every
 * client in the project. Passing the full client and case sets makes `narrow` still able to
 * shrink the answer (pick one client) without ever inventing a "empty means all" path for runs.
 *
 * `task_id` is the literal `"founder"` so a trace that somehow mixed planes would be obvious.
 */
export function founderAuthority(args: {
  project_id: string;
  wedge: string;
  client_ids: readonly string[];
  case_ids: readonly string[];
}): BrainAuthority {
  if (!args.project_id) {
    throw new Error("founderAuthority: project_id is required");
  }
  return {
    task_id: "founder",
    project_id: args.project_id,
    wedge: args.wedge,
    client_ids: Object.freeze([...args.client_ids]),
    case_ids: Object.freeze([...args.case_ids]),
    // Founder can read client-sensitivity knowledge; house items still pass mayMount/ruleMayApply.
    max_sensitivity: "client",
  } as BrainAuthority;
}

export const BRAIN_SOURCES = ["rules", "knowledge", "records", "cases", "invoices", "threads", "clients"] as const;
export type BrainSource = (typeof BRAIN_SOURCES)[number];

/** What a caller may ask. Every field NARROWS; none of them can widen anything. */
export interface BrainRequest {
  /** Free text. Terms are AND-ed, case-insensitively, against each row's searchable text. */
  q?: string;
  sources?: BrainSource[];
  client_id?: string;
  case_id?: string;
  limit?: number;
}

/** A single answer, with the handle needed to fetch it in full. */
export interface BrainHit {
  source: BrainSource;
  id: string;
  /**
   * The handle for `/v1/internal/brain/get`. Opaque on purpose, and NEVER trusted on the way back
   * in: `get` re-derives the authority from the nonce and re-runs the same gate from scratch. A ref
   * is a convenience, not a capability — treating it as one would make the authority forgeable by
   * anyone who ever saw a hit.
   */
  source_ref: string;
  title: string;
  /** Enough to decide whether to fetch. Clipped — a search result that returns the corpus is a dump. */
  snippet: string;
  at?: string;
  client_id?: string;
}

/**
 * The counts that ride on every response.
 *
 * `authority_excluded` is a COUNT ONLY, and that is the entire design. It tells the agent that the
 * brain holds rows it is not allowed to read, so the honest move is to stop guessing and raise a gap
 * — and it discloses nothing about them: not an id, not a client, not a title. A zero here means
 * "you saw everything there was"; a non-zero means "do not extrapolate from what you saw".
 */
export interface BrainCounts {
  returned: number;
  matched: number;
  truncated: boolean;
  authority_excluded: number;
}

export interface BrainAnswer extends BrainCounts {
  digest: string;
  hits: BrainHit[];
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SNIPPET = 240;

const clip = (s: string, n = SNIPPET): string => (s.length <= n ? s : `${s.slice(0, n)}…`);
const terms = (q?: string): string[] =>
  (q ?? "").toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 12);

/** AND over terms, substring per term. Exact and explainable; no term, everything matches. */
export function textMatches(haystack: string, ts: string[]): boolean {
  if (!ts.length) return true;
  const h = haystack.toLowerCase();
  return ts.every((t) => h.includes(t));
}

/** The effective scope: authority ∩ request. Intersection only — there is no union anywhere here. */
export interface BrainScope {
  project_id: string;
  wedge: string;
  client_ids: string[];
  case_ids: string[];
  sources: BrainSource[];
  terms: string[];
  limit: number;
}

/**
 * Apply a caller's filters to an authority.
 *
 * A named client that is not in the authority yields the EMPTY set, not an error and not the
 * authority's own set: asking for someone else's client returns nothing, says how much it withheld
 * in aggregate, and reveals neither whether that client exists nor whether we work for them.
 */
export function narrow(auth: BrainAuthority, req: BrainRequest): BrainScope {
  const wanted = req.sources?.filter((s): s is BrainSource => (BRAIN_SOURCES as readonly string[]).includes(s));
  return {
    project_id: auth.project_id,
    wedge: auth.wedge,
    client_ids: req.client_id ? auth.client_ids.filter((c) => c === req.client_id) : [...auth.client_ids],
    case_ids: req.case_id ? auth.case_ids.filter((k) => k === req.case_id) : [...auth.case_ids],
    sources: wanted?.length ? wanted : [...BRAIN_SOURCES],
    terms: terms(req.q),
    limit: Math.min(Math.max(1, Math.floor(req.limit ?? DEFAULT_LIMIT)), MAX_LIMIT),
  };
}

/** Is this row, which belongs to `owner`, readable under `scope`? Unowned rows are house-wide. */
const ownerAllowed = (scope: BrainScope, owner?: string): boolean =>
  !owner ? true : scope.client_ids.includes(owner);

/**
 * Knowledge (and rules) are stored per wedge. A founder asking "how many clients do I have" is
 * asking the BUSINESS, not the first schedule's wedge — which is often internal machinery
 * (`harness-operator`) and holds nothing a founder would recognise as an answer.
 *
 * Empty `scope.wedge` means every wedge in the project. A run always pins one.
 */
async function knowledgeFor(stores: BrainStores, scope: BrainScope): Promise<import("./contract").KnowledgeItem[]> {
  if (scope.wedge) return stores.domain.listKnowledge(scope.wedge, scope.project_id);
  const [cases, schedules] = await Promise.all([
    stores.domain.listCases({ project_id: scope.project_id }),
    stores.domain.listSchedules(),
  ]);
  const wedges = new Set<string>();
  for (const k of cases) if (k.wedge) wedges.add(k.wedge);
  for (const s of schedules) if (s.project_id === scope.project_id && s.wedge) wedges.add(s.wedge);
  const nested = await Promise.all([...wedges].map((w) => stores.domain.listKnowledge(w, scope.project_id)));
  return nested.flat();
}

interface Gathered {
  hits: BrainHit[];
  excluded: number;
  /** Raw totals for the digest — what the brain HOLDS, stated without holding it. */
  totals: Record<string, number>;
}

/**
 * Read every source the scope allows.
 *
 * Each block follows the same three steps in the same order, and the order is the safety property:
 * ask the store with the tenant pushed INTO the query, drop what the authority forbids (counting
 * it), then match text. Text matching last means a query string can never be the thing that admits
 * a row — it only ever removes one.
 */
async function gather(stores: BrainStores, scope: BrainScope): Promise<Gathered> {
  const hits: BrainHit[] = [];
  const totals: Record<string, number> = {};
  let excluded = 0;
  const want = (s: BrainSource) => scope.sources.includes(s);

  if (want("rules")) {
    const rules = await stores.knowledge.listRules(scope.project_id, {
      // `undefined` is "every wedge". Passing `""` would match only rules whose wedge is the empty
      // string, which is how a founder-plane read with no pinned wedge returned nothing.
      ...(scope.wedge ? { wedge: scope.wedge } : {}),
      status: "active",
    });
    for (const r of rules) {
      // The same gate the prompt uses. A rule that may not be inlined may not be searched for
      // either — an agent that can read a rule through the brain has read the rule.
      const readable = scope.client_ids.length
        ? scope.client_ids.some((c) => ruleMayApply(r, c))
        : ruleMayApply(r, undefined);
      if (!readable) { excluded++; continue; }
      totals.rules = (totals.rules ?? 0) + 1;
      if (!textMatches(`${r.text} ${r.subject}`, scope.terms)) continue;
      hits.push({
        source: "rules", id: r.id, source_ref: `rules:${r.id}`,
        title: `${r.kind.toUpperCase()} ${r.subject}`, snippet: clip(r.text),
        at: r.updated_at, client_id: r.client_id,
      });
    }
  }

  if (want("knowledge")) {
    const items = await knowledgeFor(stores, scope);
    for (const k of items) {
      const readable = scope.client_ids.length
        ? scope.client_ids.some((c) => mayMount(k, c))
        : mayMount(k, undefined);
      if (!readable) { excluded++; continue; }
      totals.knowledge = (totals.knowledge ?? 0) + 1;
      if (!textMatches(`${k.name} ${k.content}`, scope.terms)) continue;
      hits.push({
        source: "knowledge", id: k.id, source_ref: `knowledge:${k.id}`,
        title: k.name, snippet: clip(k.content), at: k.updated_at,
        client_id: typeof k.metadata?.client_id === "string" ? (k.metadata.client_id as string) : undefined,
      });
    }
  }

  if (want("records")) {
    // Resolve case → client once, so a record's ownership is the case's ownership and not "whatever
    // the caller hoped". Without this a house-wide run (empty case_ids) skipped the case filter
    // entirely and read every client-tied ledger row in the project — the same "empty means all"
    // bug the rest of this module exists to make unwriteable.
    const cases = await stores.domain.listCases({
      project_id: scope.project_id,
      ...(scope.wedge ? { wedge: scope.wedge } : {}),
    });
    const clientByCase = new Map(cases.map((k) => [k.id, k.client_id] as const));
    const rows = await stores.domain.queryRecords({
      project_id: scope.project_id,
      ...(scope.wedge ? { wedge: scope.wedge } : {}),
    });
    for (const rec of rows) {
      if (rec.case_id) {
        // Tied to a case ⇒ client-owned via that case. Empty case_ids is the TIGHTEST scope
        // (house-wide), so those rows are withheld — never "all of them".
        if (!scope.case_ids.length || !scope.case_ids.includes(rec.case_id)) {
          excluded++;
          continue;
        }
        const owner = clientByCase.get(rec.case_id);
        if (owner && !ownerAllowed(scope, owner)) {
          excluded++;
          continue;
        }
      }
      totals.records = (totals.records ?? 0) + 1;
      const body = JSON.stringify(rec.data ?? {});
      if (!textMatches(`${rec.collection} ${rec.key} ${body}`, scope.terms)) continue;
      const owner = rec.case_id ? clientByCase.get(rec.case_id) : undefined;
      hits.push({
        source: "records", id: rec.id, source_ref: `records:${rec.id}`,
        title: `${rec.collection}/${rec.key}`, snippet: clip(body), at: rec.updated_at,
        client_id: owner,
      });
    }
  }

  if (want("cases")) {
    const cases = await stores.domain.listCases({
      project_id: scope.project_id,
      ...(scope.wedge ? { wedge: scope.wedge } : {}),
    });
    for (const k of cases) {
      if (!ownerAllowed(scope, k.client_id)) { excluded++; continue; }
      totals.cases = (totals.cases ?? 0) + 1;
      if (k.status === "open") totals.open_cases = (totals.open_cases ?? 0) + 1;
      if (!textMatches(`${k.title} ${k.stage} ${JSON.stringify(k.data ?? {})}`, scope.terms)) continue;
      hits.push({
        source: "cases", id: k.id, source_ref: `cases:${k.id}`,
        title: k.title, snippet: clip(`${k.stage} · ${k.status}${k.due_at ? ` · due ${k.due_at}` : ""}`),
        at: k.updated_at, client_id: k.client_id,
      });
    }
  }

  if (want("invoices")) {
    // Project-wide, then filtered here. Deliberate: it is what makes `authority_excluded` a true
    // count rather than a number that happens to be zero because we never looked.
    const invoices = await stores.billing.listInvoices({ project_id: scope.project_id });
    for (const inv of invoices) {
      if (!ownerAllowed(scope, inv.client_id)) { excluded++; continue; }
      const status = effectiveStatus(inv);
      totals.invoices = (totals.invoices ?? 0) + 1;
      if (status !== "paid" && status !== "void") totals.open_invoices = (totals.open_invoices ?? 0) + 1;
      if (status === "overdue") totals.overdue_invoices = (totals.overdue_invoices ?? 0) + 1;
      const t = invoiceTotals(inv);
      const body = `${inv.number} ${status} ${inv.currency} ${inv.lines.map((l) => l.description).join(" ")}`;
      if (!textMatches(body, scope.terms)) continue;
      hits.push({
        source: "invoices", id: inv.id, source_ref: `invoices:${inv.id}`,
        title: `${inv.number} · ${status}`,
        snippet: clip(`${inv.currency} ${t.total} total, ${t.amount_due} outstanding${inv.due_date ? `, due ${inv.due_date}` : ""}`),
        at: inv.updated_at, client_id: inv.client_id,
      });
    }
  }

  if (want("clients")) {
    const clients = (await stores.domain.listClients()).filter((cl) => cl.project_id === scope.project_id);
    for (const cl of clients) {
      if (!scope.client_ids.includes(cl.id)) { excluded++; continue; }
      totals.clients = (totals.clients ?? 0) + 1;
      const handles = (cl.handles ?? []).join(" ");
      // "client"/"clients"/"customer" are on the haystack so a count question matches the noun,
      // not only a name. A house-wide run never reaches here: empty client_ids excludes every row.
      const hay = `${cl.display_name} ${handles} client clients customer customers`;
      if (!textMatches(hay, scope.terms)) continue;
      hits.push({
        source: "clients",
        id: cl.id,
        source_ref: `clients:${cl.id}`,
        title: cl.display_name || handles || cl.id,
        snippet: clip(handles ? `${cl.display_name} · ${handles}` : cl.display_name || cl.id),
        at: cl.updated_at,
        client_id: cl.id,
      });
    }
  }

  if (want("threads")) {
    // Threads hang off clients, so the excluded count is computed over the project's clients rather
    // than over threads we deliberately never fetched.
    const clients = (await stores.domain.listClients()).filter((cl) => cl.project_id === scope.project_id);
    for (const cl of clients) {
      if (!scope.client_ids.includes(cl.id)) { excluded++; continue; }
      for (const th of await stores.domain.listThreadsForClient(cl.id)) {
        // A thread with no project is legacy and goes dark, exactly like an unlabelled rule.
        if (th.project_id !== scope.project_id) { excluded++; continue; }
        const messages = await stores.domain.listMessages(th.id);
        totals.threads = (totals.threads ?? 0) + 1;
        totals.messages = (totals.messages ?? 0) + messages.length;
        for (const m of messages) {
          if (!textMatches(m.body, scope.terms)) continue;
          hits.push({
            source: "threads", id: m.id, source_ref: `threads:${th.id}:${m.id}`,
            title: `${th.subject ?? "conversation"} · ${m.direction}`,
            snippet: clip(m.body), at: m.created_at, client_id: cl.id,
          });
        }
      }
    }
  }

  return { hits, excluded, totals };
}

/**
 * WHAT THE BRAIN HOLDS, STATED WITHOUT HOLDING IT.
 *
 * ~400 characters of counts, put in the run's grounding. It is the index, not the content: "12 open
 * invoices, 3 overdue; 61 messages on 2 threads" tells the agent that asking is worth it and that
 * silence would be a guess, while disclosing no client, no amount and no sentence. Counts are
 * already authority-filtered, so the digest cannot describe rows the run may not read.
 */
export function digestOf(totals: Record<string, number>): string {
  const n = (k: string) => totals[k] ?? 0;
  const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (n("clients")) parts.push(counted(n("clients"), "client"));
  if (n("open_invoices") || n("invoices")) {
    parts.push(
      `${counted(n("open_invoices"), "open invoice")}${n("overdue_invoices") ? `, ${n("overdue_invoices")} overdue` : ""} of ${n("invoices")} total`,
    );
  }
  if (n("cases")) parts.push(`${counted(n("open_cases"), "open case")} of ${n("cases")}`);
  if (n("threads")) parts.push(`${counted(n("messages"), "message")} on ${counted(n("threads"), "thread")}`);
  if (n("records")) parts.push(counted(n("records"), "record"));
  if (n("knowledge")) parts.push(counted(n("knowledge"), "knowledge file"));
  if (n("rules")) parts.push(counted(n("rules"), "learned rule"));
  if (!parts.length) return "The company brain holds nothing readable for this run.";
  return clip(`The company brain holds: ${parts.join("; ")}. Ask it rather than guessing.`, 400);
}

/**
 * `POST /v1/internal/brain/ask`.
 *
 * Sort is recency-major across sources: the question is nearly always "what is the state of this
 * now", and a deterministic tiebreak on the ref keeps two identical timestamps from reordering
 * between calls (a search that shuffles is a search an agent cannot page through).
 */
export async function ask(stores: BrainStores, auth: BrainAuthority, req: BrainRequest): Promise<BrainAnswer> {
  const scope = narrow(auth, req);
  const { hits, excluded, totals } = await gather(stores, scope);
  hits.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.source_ref.localeCompare(b.source_ref));
  const returned = hits.slice(0, scope.limit);
  return {
    digest: digestOf(totals),
    hits: returned,
    returned: returned.length,
    matched: hits.length,
    truncated: hits.length > returned.length,
    authority_excluded: excluded,
  };
}

/**
 * The digest alone, for the run's grounding.
 *
 * Runs the same authority-filtered gather with no query, and keeps only the counts. It is the index
 * of the brain, not its content: the agent learns that twelve invoices exist and must ASK to learn
 * anything about them. Cheap enough to sit on the prompt path, and worth it — an agent that does not
 * know the brain has anything will never call it, and will guess instead.
 */
export async function digestFor(stores: BrainStores, auth: BrainAuthority): Promise<string> {
  const { totals } = await gather(stores, narrow(auth, {}));
  return digestOf(totals);
}

/** The full row behind a hit, or a refusal that says nothing about why. */
export interface BrainDocument {
  source: BrainSource;
  id: string;
  source_ref: string;
  title: string;
  content: string;
  at?: string;
  client_id?: string;
}

/**
 * `POST /v1/internal/brain/get` — RE-AUTHORISED FROM SCRATCH.
 *
 * The ref is parsed as three strings and then thrown away: the row is fetched by id from its store
 * and re-checked against a freshly derived authority, using the same predicates `ask` used. It is
 * implemented as a re-run of the narrowed search rather than a direct read for one reason — a direct
 * read would be a second gate, and a second gate is a place for the two to disagree. There is
 * exactly one definition of what this run may see, and both verbs go through it.
 *
 * A ref for a row this run may not read returns undefined — the same answer as a ref that does not
 * exist, so the refusal itself leaks nothing.
 */
export async function get(stores: BrainStores, auth: BrainAuthority, ref: string): Promise<BrainDocument | undefined> {
  const [source, ...rest] = String(ref ?? "").split(":");
  if (!(BRAIN_SOURCES as readonly string[]).includes(source ?? "")) return undefined;
  const src = source as BrainSource;
  const scope = narrow(auth, { sources: [src] });
  const { hits } = await gather(stores, scope);
  const hit = hits.find((h) => h.source_ref === ref);
  if (!hit) return undefined;

  const id = rest[rest.length - 1] ?? "";
  const content = await bodyOf(stores, src, hit, id, scope);
  return { source: src, id: hit.id, source_ref: hit.source_ref, title: hit.title, content, at: hit.at, client_id: hit.client_id };
}

/** The untruncated body, fetched only AFTER the row has been re-authorised. */
async function bodyOf(
  stores: BrainStores,
  src: BrainSource,
  hit: BrainHit,
  id: string,
  scope: BrainScope,
): Promise<string> {
  switch (src) {
    case "knowledge": {
      // Re-read inside the same (project, wedge) the gate ran in, then match by id. Fetching by id
      // alone would be a read that has forgotten its tenant.
      const items = await knowledgeFor(stores, scope);
      return items.find((k) => k.id === id)?.content ?? hit.snippet;
    }
    case "records": {
      const rec = await stores.domain.getRecord(id);
      return rec ? JSON.stringify(rec.data ?? {}, null, 2) : hit.snippet;
    }
    case "invoices": {
      const inv = await stores.billing.getInvoice(id);
      return inv ? JSON.stringify({ ...inv, internal_note: undefined, totals: invoiceTotals(inv) }, null, 2) : hit.snippet;
    }
    case "cases": {
      const k = await stores.domain.getCase(id);
      return k ? JSON.stringify({ title: k.title, stage: k.stage, status: k.status, data: k.data, history: k.history }, null, 2) : hit.snippet;
    }
    case "rules": {
      const r = await stores.knowledge.getRule(id, scope.project_id);
      return r ? `${r.kind.toUpperCase()}: ${r.text}\n\n${r.provenance.before ?? ""}\n---\n${r.provenance.after ?? ""}`.trim() : hit.snippet;
    }
    case "threads": {
      const messages = await stores.domain.listMessages(hit.source_ref.split(":")[1] ?? "");
      return messages.find((m) => m.id === id)?.body ?? hit.snippet;
    }
    case "clients": {
      const cl = await stores.domain.getClient(id);
      if (!cl || cl.project_id !== scope.project_id) return hit.snippet;
      return JSON.stringify({ display_name: cl.display_name, handles: cl.handles, metadata: cl.metadata }, null, 2);
    }
  }
}
