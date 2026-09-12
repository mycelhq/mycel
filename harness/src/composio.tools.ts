// Composio TOOL SCHEMAS — what a connection can actually do, in a form that fits a prompt.
//
// THE BUG THIS FILE EXISTS TO FIX
//
// `buildAgentsMd` used to tell the agent this, and only this:
//
//     Available connections:
//     - **Xero** (composio) — id `conn_7f2…`
//
// A name and an id. Not one tool slug, not one argument, not one return value. The agent was then
// instructed to POST to `$MYCEL_ACTIONS_URL/<capability>` — where `<capability>` IS the Composio
// tool slug — with no way to know that the slug is `XERO_CREATE_INVOICE` and not `create_invoice`,
// `xero.invoice.create`, or `createInvoice`. What actually happened on those runs is what always
// happens when a model is asked to guess an identifier: it guessed, the proxy 400'd on an unknown
// slug, and the run reported "I was unable to create the invoice" while a perfectly good, fully
// authorised Xero connection sat one correct string away. The connection worked. The prompt did
// not describe it.
//
// THE OPPOSITE MISTAKE, WHICH IS WORSE
//
// The obvious fix — paste the toolkit's tools into the prompt — is not a fix. Composio toolkits are
// not small: the catalogue carries `tools_count` precisely because a 4-tool toolkit and an 871-tool
// one are not the same offer (see `Toolkit` in composio.ts), and several of the toolkits a service
// business actually connects (Gmail, HubSpot, Google Sheets) are in the hundreds. Rendering all of
// them is tens of thousands of tokens of JSON Schema, spent before the agent has read the job, on a
// `decide` profile whose entire budget is smaller than that. A run that gets three well-described
// tools beats one that gets ninety names, and a run that gets nine hundred gets nothing at all: the
// task drowns.
//
// So this file is two things, and the second is the interesting one:
//
//   1. A cached fetch of Composio's published tool schemas (`GET /api/v3/tools?toolkit_slug=…`).
//   2. A SELECTION RULE that decides which of them are worth prompt tokens on THIS run.
//
// THE SELECTION RULE, stated once so it can be argued with:
//
//   (a) Only granted connections. Never a widening — this operates on the output of
//       `selectGrantableConnections`, which already encodes the per-client tenant boundary. This
//       file must never fetch, score or render a connection that was not passed to it.
//   (b) DECLARED tools always win. A slug the founder listed in `config.read_tools`, or that the
//       wedge names in its capabilities/approvals, is a slug someone deliberately said this
//       business uses. It goes in ahead of anything a scorer likes.
//   (c) The remaining budget is filled by relevance to the words of THIS task — its type, its
//       wedge, its intent, its subject. Score must be strictly positive: a tool that shares no
//       word with the job is not a weak candidate, it is noise, and noise crowds out the task.
//   (d) Hard caps, per connection and overall, so a business that connects six apps cannot
//       assemble a prompt six times the size of a business that connected one.
//   (e) Every schema is truncated: description clipped, top-level parameters only, ten of them,
//       one line each. The agent needs to know an argument EXISTS and what it is called. The
//       provider's full recursive JSON Schema for a Gmail message is not context, it is a document.
//
// Nothing here ever touches a credential. Tool schemas are public metadata about a toolkit; the
// Composio API key used to fetch them stays in the harness exactly as it does everywhere else, and
// what crosses into the sandbox is prose in AGENTS.md.
import { listTools, type ComposioConfig, type ToolSummary } from "./composio";

/**
 * One tool, compacted to the smallest thing an agent can still call correctly.
 *
 * `returns` is not decoration. The whole point of item C — results coming back as usable context —
 * is defeated if the agent does not know that `XERO_CREATE_INVOICE` answers with an `invoiceID` it
 * is supposed to carry into the next step. A tool whose return shape is undocumented gets called
 * and its answer gets discarded.
 */
export interface CompactTool {
  slug: string;
  summary: string;
  params: CompactParam[];
  /** Top-level keys of the tool's documented response, if Composio published any. */
  returns: string[];
  /** True when this slug is on the connection's `read_tools` allowlist (ungated read path). */
  read: boolean;
  /** True when a founder or a wedge named this slug, as opposed to the scorer picking it. */
  declared: boolean;
  /** How many parameters were dropped by the cap, so the agent knows the list is partial. */
  dropped_params: number;
}

export interface CompactParam {
  name: string;
  type: string;
  required: boolean;
  note?: string;
}

/** The budget knobs, in one place so a test can shrink them instead of asserting on magic numbers. */
export interface ToolContextLimits {
  perConnection: number;
  total: number;
  summaryChars: number;
  params: number;
  paramChars: number;
}

/**
 * Defaults chosen against the `decide` profile, which is the tightest real budget we run.
 *
 * Eight tools per connection at roughly 60-90 tokens each is under a thousand tokens for a single
 * connected app; twenty-four total caps a multi-app business at around three thousand. That is the
 * size of one knowledge file — a price worth paying for the difference between an agent that can
 * name its tools and one that cannot.
 */
export const DEFAULT_TOOL_LIMITS: ToolContextLimits = {
  perConnection: 8,
  total: 24,
  summaryChars: 180,
  params: 10,
  paramChars: 90,
};

// ── the catalogue cache ───────────────────────────────────────────────────────────────────────
//
// Per-toolkit, process-local, TTL'd. Every run that touches Xero would otherwise pay a round trip
// to Composio during sandbox setup — on the critical path, before the agent has done anything, and
// serialised with every other setup step. Tool schemas change when a provider ships a new API, i.e.
// on the order of weeks, so an hours-long TTL is not a staleness risk worth a per-run request.
//
// A FAILED fetch is cached too, briefly and negatively. Composio being down must not turn into one
// timed-out HTTP call per run per toolkit for as long as the outage lasts: the prompt degrades to
// the old name-and-id form, which is survivable, and hanging sandbox setup is not.

interface CacheEntry {
  at: number;
  items: ToolSummary[];
}

const CATALOGUE: Map<string, CacheEntry> = new Map();
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;

/** Seed or clear the cache. Tests only — there is no live Composio account in CI. */
export function __setToolCatalogue(toolkit: string, items: ToolSummary[] | undefined): void {
  if (items === undefined) CATALOGUE.delete(toolkit.toLowerCase());
  else CATALOGUE.set(toolkit.toLowerCase(), { at: Date.now(), items });
}

export function __clearToolCatalogue(): void {
  CATALOGUE.clear();
}

/**
 * Every tool Composio publishes for a toolkit, cached.
 *
 * Capped at 200 (the API's own page ceiling) rather than paged: we are about to throw all but eight
 * of these away, and a toolkit whose 201st tool is the relevant one is a selection problem that
 * more pages would not solve. Declared slugs — the ones a founder actually named — are looked up
 * separately below and are never subject to this cap.
 */
export async function toolCatalogue(cfg: ComposioConfig, toolkit: string): Promise<ToolSummary[]> {
  const key = toolkit.toLowerCase();
  const hit = CATALOGUE.get(key);
  if (hit && Date.now() - hit.at < (hit.items.length ? OK_TTL_MS : FAIL_TTL_MS)) return hit.items;
  try {
    const items = await listTools(cfg, { toolkit, limit: 200 });
    CATALOGUE.set(key, { at: Date.now(), items });
    return items;
  } catch (e) {
    // Negative-cached and swallowed on purpose. See the cache note above: the caller's fallback is
    // a thinner prompt, and a thinner prompt beats a sandbox that takes 30s longer to boot.
    console.error(`[mycel] composio tool catalogue for "${toolkit}" failed:`, (e as Error)?.message);
    CATALOGUE.set(key, { at: Date.now(), items: [] });
    return [];
  }
}

// ── compaction ────────────────────────────────────────────────────────────────────────────────

function clip(s: unknown, max: number): string {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A JSON Schema `type`, rendered as one word.
 *
 * Composio publishes plenty of unions and `anyOf`s. The agent does not need the lattice; it needs
 * to know whether to send a string or a list, and an honest "string|number" beats both a wrong
 * guess and a paragraph of schema.
 */
function typeName(schema: unknown): string {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (typeof s.type === "string") {
    if (s.type === "array") {
      const it = (s.items ?? {}) as Record<string, unknown>;
      return typeof it.type === "string" ? `${it.type}[]` : "array";
    }
    return s.type;
  }
  if (Array.isArray(s.type)) return (s.type as unknown[]).map(String).join("|");
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    const v = s[k];
    if (Array.isArray(v) && v.length) return v.map(typeName).join("|");
  }
  if (typeof s.enum !== "undefined" && Array.isArray(s.enum)) return "enum";
  return "any";
}

function schemaProps(raw: unknown): { props: Record<string, unknown>; required: Set<string> } {
  const s = (raw ?? {}) as Record<string, unknown>;
  const props = (s.properties ?? {}) as Record<string, unknown>;
  const required = new Set(
    Array.isArray(s.required) ? (s.required as unknown[]).map((x) => String(x)) : [],
  );
  return { props: typeof props === "object" && props ? props : {}, required };
}

/**
 * Compact one tool. TOP-LEVEL PARAMETERS ONLY, and required ones first.
 *
 * Recursing was tried and is what makes this section explode: a single Gmail send descends through
 * attachments, headers and MIME parts into several hundred lines. The failure mode of not
 * recursing is that the agent sends a flat value where a nested object was wanted, gets a clear
 * validation error back from Composio through the action proxy, and corrects it — one wasted call.
 * The failure mode of recursing is that the task never gets read.
 */
export function compactTool(
  t: ToolSummary,
  opts: { read: boolean; declared: boolean; limits?: ToolContextLimits },
): CompactTool {
  const lim = opts.limits ?? DEFAULT_TOOL_LIMITS;
  const { props, required } = schemaProps(t.input_parameters);
  const names = Object.keys(props);
  // Required first: an agent that reads only the head of the list still learns the mandatory
  // arguments, which is the half that decides whether the call succeeds at all.
  names.sort((a, b) => Number(required.has(b)) - Number(required.has(a)) || a.localeCompare(b));
  const kept = names.slice(0, lim.params);
  const params: CompactParam[] = kept.map((n) => {
    const p = (props[n] ?? {}) as Record<string, unknown>;
    const note = clip(p.description ?? "", lim.paramChars);
    return { name: n, type: typeName(p), required: required.has(n), ...(note ? { note } : {}) };
  });
  const out = schemaProps((t as { output_parameters?: unknown }).output_parameters);
  return {
    slug: t.slug,
    summary: clip(t.description ?? t.name ?? t.slug, lim.summaryChars),
    params,
    // `data` is Composio's own envelope key on essentially every tool and tells the agent nothing;
    // showing it as a "return value" is worse than showing none, because it looks like an answer.
    returns: Object.keys(out.props)
      .filter((k) => k !== "data")
      .slice(0, 8),
    read: opts.read,
    declared: opts.declared,
    dropped_params: Math.max(0, names.length - kept.length),
  };
}

// ── relevance ─────────────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "this", "that", "get",
  "set", "new", "all", "any", "from", "by", "is", "are", "it", "your", "you", "we", "us",
  // Toolkit-name words are stripped because EVERY tool in a toolkit contains them: leaving "gmail"
  // in the query made every Gmail tool score 1 and the ranking collapsed into alphabetical order.
]);

export function words(s: unknown): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Overlap between a tool and the words of the task.
 *
 * Deliberately dumb — set intersection, slug weighted double. An embedding model would rank better
 * and would also mean a network call and a second failure mode during sandbox setup, for a decision
 * whose whole job is to pick eight items out of a hundred. The important property is not that the
 * ranking is optimal; it is that a score of ZERO excludes, so an irrelevant tool cannot be padded
 * in just because there was budget left.
 */
export function relevance(t: ToolSummary, query: Set<string>): number {
  if (query.size === 0) return 0;
  let score = 0;
  for (const w of new Set(words(t.slug))) if (query.has(w)) score += 2;
  for (const w of new Set([...words(t.name), ...words(t.description)])) if (query.has(w)) score += 1;
  return score;
}

/**
 * The words this run is about.
 *
 * Task type and wedge are the reliable signal; the input keys and any subject/intent the intake
 * normalised are the specific one. `input` is agent-adjacent data, so it is READ but never trusted
 * for anything but ranking — the worst a poisoned value can do here is get a wrong tool described
 * in the prompt, and describing a tool grants nothing. Authorisation is `selectGrantableConnections`
 * and the approval gate, both upstream and both unaffected by anything in this set.
 */
export function taskQuery(parts: {
  type?: string;
  wedge?: string;
  input?: Record<string, unknown>;
  extra?: string[];
}): Set<string> {
  const bag: string[] = [...words(parts.type), ...words(parts.wedge)];
  for (const e of parts.extra ?? []) bag.push(...words(e));
  const input = parts.input ?? {};
  for (const [k, v] of Object.entries(input)) {
    bag.push(...words(k));
    // Scalars only, and short ones. A whole email body would swamp the query with common words and
    // make every tool score alike, which is the same failure as having no query.
    if (typeof v === "string" && v.length <= 200) bag.push(...words(v));
  }
  return new Set(bag);
}

// ── selection ─────────────────────────────────────────────────────────────────────────────────

export interface ConnectionToolRequest {
  connection_id: string;
  connection_name: string;
  toolkit: string;
  /** Slugs the connection lists as readable — always declared, and marked as ungated reads. */
  read_tools: string[];
  /** Slugs the wedge or the task named. Declared, and gated like any other write. */
  named_tools: string[];
}

export interface ConnectionTools {
  connection_id: string;
  connection_name: string;
  toolkit: string;
  tools: CompactTool[];
  /** How many of the toolkit's tools exist but did not fit. Told to the agent, not hidden. */
  omitted: number;
}

/**
 * Apply the rule. See the header for what the rule IS and why.
 *
 * `requests` must already be the granted set. This function does no entitlement work of its own and
 * must not start doing any: a second, weaker copy of the tenant check is how the cross-tenant leak
 * this codebase already had gets reintroduced. If a connection reaches here, something upstream
 * decided the run may act through it.
 */
export async function selectToolContext(
  cfg: ComposioConfig | undefined,
  requests: ConnectionToolRequest[],
  query: Set<string>,
  limits: ToolContextLimits = DEFAULT_TOOL_LIMITS,
): Promise<ConnectionTools[]> {
  if (!cfg || requests.length === 0) return [];
  const out: ConnectionTools[] = [];
  let budget = limits.total;

  for (const req of requests) {
    if (budget <= 0) break;
    if (!req.toolkit) continue;
    const catalogue = await toolCatalogue(cfg, req.toolkit);
    if (catalogue.length === 0) continue;

    const bySlug = new Map(catalogue.map((t) => [t.slug.toUpperCase(), t]));
    const readSet = new Set(req.read_tools.map((s) => s.toUpperCase()));
    const declaredSlugs = [...req.read_tools, ...req.named_tools].map((s) => s.toUpperCase());

    const chosen: CompactTool[] = [];
    const taken = new Set<string>();
    const room = Math.min(limits.perConnection, budget);

    // (b) declared first, in the order they were declared.
    for (const slug of declaredSlugs) {
      if (chosen.length >= room) break;
      if (taken.has(slug)) continue;
      const t = bySlug.get(slug);
      // A declared slug Composio does not publish is still worth naming: the founder configured it,
      // and a stub line ("declared, no published schema") is how they find out it is misspelled.
      // Silently dropping it is how a read allowlist rots without anyone noticing.
      taken.add(slug);
      chosen.push(
        t
          ? compactTool(t, { read: readSet.has(slug), declared: true, limits })
          : {
              slug,
              summary: "declared on this connection; Composio published no schema for it",
              params: [],
              returns: [],
              read: readSet.has(slug),
              declared: true,
              dropped_params: 0,
            },
      );
    }

    // (c) fill the rest by strictly-positive relevance.
    if (chosen.length < room) {
      const ranked = catalogue
        .filter((t) => !taken.has(t.slug.toUpperCase()))
        .map((t) => ({ t, s: relevance(t, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.t.slug.localeCompare(b.t.slug));
      for (const { t } of ranked) {
        if (chosen.length >= room) break;
        taken.add(t.slug.toUpperCase());
        chosen.push(compactTool(t, { read: readSet.has(t.slug.toUpperCase()), declared: false, limits }));
      }
    }

    if (chosen.length === 0) continue;
    budget -= chosen.length;
    out.push({
      connection_id: req.connection_id,
      connection_name: req.connection_name,
      toolkit: req.toolkit,
      tools: chosen,
      omitted: Math.max(0, catalogue.length - chosen.length),
    });
  }
  return out;
}

/**
 * Render the selection into AGENTS.md.
 *
 * One line per parameter, no JSON. The agent is going to write a `curl` or call an MCP tool, and
 * both want "amount: number (required)" far more than they want a schema fragment. The `omitted`
 * count is printed because an agent that believes it has seen the whole toolkit will conclude a
 * capability does not exist rather than asking for it.
 */
export function renderToolContext(groups: ConnectionTools[]): string[] {
  const lines: string[] = [];
  for (const g of groups) {
    lines.push("");
    lines.push(`### ${g.connection_name} — Composio \`${g.toolkit}\` (connection id \`${g.connection_id}\`)`);
    for (const t of g.tools) {
      const tags = [t.read ? "read: no approval needed" : "needs approval", t.declared ? "declared" : "suggested"];
      lines.push(`- \`${t.slug}\` (${tags.join(", ")}) — ${t.summary}`);
      for (const p of t.params) {
        lines.push(`    - \`${p.name}\`: ${p.type}${p.required ? " **(required)**" : ""}${p.note ? ` — ${p.note}` : ""}`);
      }
      if (t.dropped_params) {
        lines.push(`    - (…${t.dropped_params} further optional argument(s) exist; ask if you need one)`);
      }
      if (t.returns.length) lines.push(`    - returns: ${t.returns.map((r) => `\`${r}\``).join(", ")}`);
    }
    if (g.omitted) {
      lines.push(
        `- (${g.omitted} further \`${g.toolkit}\` tool(s) exist but were not described on this run. ` +
          `If you need one, say what you need rather than guessing a slug — a guessed slug fails.)`,
      );
    }
  }
  return lines;
}
