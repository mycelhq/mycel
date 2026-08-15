// Blueprints — the deployable unit of a *business*, not a task.
//
// This is what Cloud's "describe it and it goes live" actually resolves to: a named bundle of
// wedge + schedules + the connections it needs + seed knowledge. Applying one to a project creates
// everything in a single call and returns a readiness checklist of what the founder must still
// supply (credentials, mostly — the things only they have).
//
// Two deliberate choices:
//  - Schedules are provisioned DISABLED. A business whose bank feed has no token yet would
//    otherwise start firing daily syncs that fail, burning model spend and filling the timeline
//    with noise. They flip on when the project is ready (`activate`).
//  - Connections are created WITHOUT secrets, so the blueprint carries config and intent while the
//    founder supplies credentials through the normal encrypted path. A blueprint file is safe to
//    commit, share, and read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cadence, ConnectionKind } from "./contract";
import type { DomainStore } from "./domain";
import { firstRun } from "./scheduler";
import { connConfig as composioConnConfig } from "./composio";
import {
  CAPABILITIES,
  capabilityFault,
  isCapability,
  readToolsFor,
  resolveCapability,
  type CapabilityName,
  type CapabilityProvider,
} from "./capabilities";
import { hasSecret } from "./secrets";
import { loadWedge } from "./wedge";

/**
 * One thing a business needs before it can run.
 *
 * ═══ WHY THERE ARE TWO SHAPES HERE AND NOT ONE ═══
 *
 * A requirement is EITHER a capability or a specific connection, never both, and the split is the
 * whole point of this change.
 *
 * `capability` is the right shape whenever alternatives exist. `invoice-chaser` used to declare
 * `{"name": "stripe", "kind": "composio"}`, which asked a business paid by bank transfer to connect
 * a card processor before its accounts-receivable chaser would go live. It now declares
 * `{"capability": "read_payments"}` and the setup step offers Stripe, QuickBooks, Xero, Square,
 * PayPal, FreshBooks and Wave — whichever they pick binds to the same declared need.
 *
 * `kind` survives for the case where there is genuinely one thing: `linkedin` is a captured member
 * session behind a mandatory proxy rather than a brokered app, and a founder's own bespoke endpoint
 * is by definition theirs alone. Neither has alternatives to offer, so a capability would be an
 * abstraction over a set of one.
 *
 * `config` survives with it and is now VALIDATED. Two shipped blueprints carried
 * `"api_url": "https://api.example-bank.com"` and `"from": "books@yourdomain.com"` — placeholders
 * that every code path downstream treats as settings, and the second of which is a plausible sender
 * a client would have seen at the top of a receipt chase. `blueprintFaults` refuses them by name.
 */
export interface BlueprintConnection {
  /** The requirement's key. Stable; what a checklist item and a connection row join on. */
  name: string;
  /** Capability rows only. Resolved per project against whatever the founder connected. */
  capability?: CapabilityName;
  /** Specific-connection rows only. Absent on a capability row. */
  kind?: ConnectionKind;
  why: string;
  config?: Record<string, unknown>;
  secret_hint?: string;
}

export interface Blueprint {
  blueprint: string;
  title: string;
  summary: string;
  wedge: string;
  sells_as?: string;
  requires_connections: BlueprintConnection[];
  schedules: { name: string; task_type: string; cadence: Cadence; input?: Record<string, unknown> }[];
  seed_knowledge: { name: string; content: string; kind?: string }[];
}

/**
 * Config values that are a template author's placeholder, not a setting.
 *
 * ═══ THE FAILURE ═══
 *
 * `books-keeper.json` shipped to real customers with `"api_url": "https://api.example-bank.com"` and
 * `"from": "books@yourdomain.com"`. Nothing downstream can tell a placeholder from a setting: the
 * connection row is created with it, the action executor POSTs to it, and the second one is a
 * from-address that looks enough like a real one to reach a client at the top of a receipt chase.
 * "Nobody would leave that in" is not a mechanism, so this is one.
 *
 * Matched on the HOSTNAME/DOMAIN rather than on the whole string, because the failure is the domain:
 * `books@yourdomain.com` and `hello@yourdomain.com` are the same mistake.
 */
const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "example.net", "yourdomain.com", "yourcompany.com", "example-bank.com", "acme.com", "changeme.com"];

/** Anything in a blueprint that would ship a lie. Sentences, all of them, never the first only. */
export function blueprintFaults(slug: string, raw: unknown): string[] {
  const faults: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${slug}.json is not a JSON object`];
  const b = raw as Record<string, unknown>;
  const reqs = b.requires_connections;
  if (reqs !== undefined && !Array.isArray(reqs)) {
    return [`${slug}.json: "requires_connections" must be an array`];
  }
  for (const [i, row] of ((reqs ?? []) as unknown[]).entries()) {
    const at = `${slug}.json requires_connections[${i}]`;
    if (typeof row !== "object" || row === null) {
      faults.push(`${at} is not an object`);
      continue;
    }
    const r = row as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : `#${i}`;
    if (typeof r.name !== "string" || !r.name.trim()) faults.push(`${at} has no "name"`);
    const hasCapability = r.capability !== undefined;
    const hasKind = r.kind !== undefined;
    if (hasCapability && hasKind) {
      // Both would mean two different resolution paths for one requirement, and the checklist would
      // have to pick. A requirement that resolves two ways resolves neither predictably.
      faults.push(`${at} ("${name}") declares both "capability" and "kind" — a requirement is one or the other`);
    } else if (!hasCapability && !hasKind) {
      faults.push(`${at} ("${name}") declares neither "capability" nor "kind", so nothing can satisfy it`);
    }
    if (hasCapability) {
      const problem = typeof r.capability === "string" ? capabilityFault(r.capability) : `"capability" must be a string`;
      // A mistyped capability is REFUSED, not ignored. Ignored, the requirement vanishes from the
      // checklist, the business activates one requirement short, and the step it needed never runs.
      if (problem) faults.push(`${at} ("${name}"): ${problem}`);
      if (r.config !== undefined) {
        faults.push(`${at} ("${name}") is a capability and carries "config" — what to grant comes from the capability table, not the blueprint`);
      }
    }
    for (const [k, v] of Object.entries((r.config ?? {}) as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      const domain = PLACEHOLDER_DOMAINS.find((d) => v.toLowerCase().includes(d));
      if (domain) {
        faults.push(
          `${at} ("${name}") ships config.${k} = "${v}", which is a placeholder — ${domain} is not a real host. ` +
            `Either the requirement is a capability, or it is asked for in the flow that needs it. It must not ship.`,
        );
      }
    }
  }
  return faults;
}

/**
 * A blueprint may not ask a founder for a connection its own wedge can never be handed.
 *
 * ═══ THE FAILURE THIS EXISTS FOR ═══
 *
 * `recruiting-desk` and `security-questionnaire` shipped with no `capabilities` key in `wedge.json`
 * at all, while their blueprints required `read_crm`, `write_crm` and `send_email`. Grants are
 * derived from the MANIFEST (`runtime.ts`: `capabilityConnections(wedge.manifest.capabilities ?? [])`),
 * so every run of those wedges got zero connections — and the "what is missing" warning is derived
 * from THE SAME absent array, so `capabilityGaps` was empty too. The founder connected a CRM and a
 * mailbox because the blueprint's onboarding checklist asked them to, watched both go green, and
 * the agent was handed nothing. Nothing anywhere said so. Two derivations from one absent value
 * cannot disagree, which is exactly why nothing warned.
 *
 * So the two artefacts are cross-checked at boot, where a mismatch is a startup failure with the
 * fix in the message rather than a silent zero months later. It is deliberately one-directional: a
 * manifest may declare MORE capabilities than the blueprint asks for (a wedge that degrades
 * gracefully without a calendar is a legitimate wedge), but it may never declare fewer.
 */
export function manifestSatisfiesBlueprint(slug: string, raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const b = raw as Record<string, unknown>;
  const wedgeSlug = typeof b.wedge === "string" ? b.wedge : "";
  if (!wedgeSlug) return [];
  const manifest = loadWedge(wedgeSlug)?.manifest;
  // A blueprint naming a wedge this kernel does not carry is a different fault and is not ours to
  // report: a deployment may legitimately ship a subset of the catalogue.
  if (!manifest) return [];
  const declared = new Set(manifest.capabilities ?? []);
  const faults: string[] = [];
  for (const row of (Array.isArray(b.requires_connections) ? b.requires_connections : []) as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const cap = (row as Record<string, unknown>).capability;
    if (typeof cap !== "string" || declared.has(cap)) continue;
    faults.push(
      `${slug}.json requires the "${cap}" capability, but wedges/${wedgeSlug}/wedge.json does not declare it in ` +
        `"capabilities" — the founder would be asked to connect it and the agent would still be handed nothing. ` +
        `Add "${cap}" to that wedge's "capabilities".`,
    );
  }
  return faults;
}

export function blueprintsDir(): string {
  return process.env.MYCEL_BLUEPRINTS_DIR ?? join(process.cwd(), "blueprints");
}

export function listBlueprints(): Blueprint[] {
  const dir = blueprintsDir();
  if (!existsSync(dir)) return [];
  const out: Blueprint[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Blueprint);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Boot gate. Called once from `createServer`, and it THROWS.
 *
 * Deliberately not swallowed, for the reason `assertWedgeRolesValid` gives: a kernel that boots with
 * `books@yourdomain.com` in a blueprint runs for weeks and then puts that address on a real client's
 * email, whereas a kernel that refuses to boot gets looked at in the first minute. It is also the
 * only gate that can catch this — a placeholder is valid JSON and satisfies every type.
 */
export function assertBlueprintsValid(): void {
  const dir = blueprintsDir();
  if (!existsSync(dir)) return;
  const faults: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      faults.push(`${f} could not be parsed as JSON`);
      continue;
    }
    const slug = f.replace(/\.json$/, "");
    faults.push(...blueprintFaults(slug, parsed));
    faults.push(...manifestSatisfiesBlueprint(slug, parsed));
  }
  if (faults.length) {
    throw new Error(
      `[mycel] ${faults.length} problem(s) in blueprints under ${dir}:\n` + faults.map((x) => `  · ${x}`).join("\n"),
    );
  }
}

export function loadBlueprint(slug: string): Blueprint | null {
  if (!/^[a-z0-9_-]{1,64}$/i.test(slug)) return null; // no traversal
  const file = join(blueprintsDir(), `${slug}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Blueprint;
  } catch {
    return null;
  }
}

export interface ChecklistItem {
  what: string;
  why: string;
  done: boolean;
  /**
   * The requirement's name as the blueprint declares it — the key every path here joins on. Present
   * so a UI can address a requirement that has no row yet without parsing it back out of `what`,
   * which is prose and will be reworded.
   */
  name?: string;
  /** The connection kind, so a UI can offer "Connect" vs a paste box without guessing. */
  kind?: ConnectionKind;
  /** How the founder finishes it — an actual call, not a vague instruction. */
  action?: string;
  /**
   * Present only once the founder has actually started this one. A checklist item is a STATEMENT OF
   * NEED, and a need has no database row until somebody acts on it — see the header note on why
   * provisioning stopped creating them.
   */
  connection_id?: string;
  /** Brokered items only: the app slug to connect, so a UI can act without a row to point at. */
  toolkit?: string;
  /** Brokered items only: the read-only tools the blueprint wants granted when it connects. */
  read_tools?: string[];
  /** Capability items only: what the business needs to be able to do. */
  capability?: CapabilityName;
  /**
   * Capability items only: the question to put to the founder — "Which of these do you get paid
   * through?". It lives in the vocabulary rather than in the UI so that every surface asks it the
   * same way, and so that adding a capability cannot leave a screen with a blank label.
   */
  question?: string;
  /**
   * Capability items only: the alternatives, so the UI can ask WHICH OF THESE DO YOU USE rather than
   * demanding one brand.
   *
   * Every entry is connectable in one click and every entry satisfies the same requirement. This
   * array is the entire user-visible point of the change: it is the difference between "Connect
   * Xero" and a list with QuickBooks, FreshBooks and Wave in it.
   */
  options?: { toolkit: string; label: string; via: string; read_tools: string[]; action: string }[];
  /** Capability items only: what is already bound, and whether the kernel can actually read it. */
  connected?: { toolkit: string; label: string; connection_id: string; readable: boolean }[];
  /**
   * A sentence for a founder about the state of this requirement. Always present on a capability
   * item, including — especially — when it is unsatisfied. Degrading honestly means saying what is
   * missing, not showing an empty circle.
   */
  detail?: string;
}

export interface ProvisionResult {
  blueprint: string;
  project_id: string;
  /**
   * No `connections` key, and its absence is the point — see the header. Provisioning creates
   * schedules and knowledge; it does not create connections, so reporting a count of them would be
   * reporting work that did not happen.
   */
  created: { schedules: string[]; knowledge: string[] };
  /** Existing things we left alone — provisioning twice must not duplicate a business. */
  reused: { schedules: string[] };
  checklist: ChecklistItem[];
  ready: boolean;
}

/**
 * Apply a blueprint to a project. Idempotent: re-provisioning reuses schedules that already exist by
 * name, so a retry (or a founder clicking twice) doesn't create a second business.
 *
 * ═══ THIS NO LONGER CREATES CONNECTIONS, AND THAT IS THE FIX ═══
 *
 * It used to create one empty, secret-less row per `requires_connections` entry. Three things went
 * wrong with that, and only the third is cosmetic:
 *
 *  1. **It made the app catalogue lie.** `GET /v1/composio/toolkits` reports `pending: true` for any
 *     toolkit that has a connection row without `verified_at` — meaning "an OAuth flow was started
 *     and abandoned". A blueprint that declared `{toolkit: "xero"}` therefore made Xero read as
 *     half-authorised to a founder who had never once clicked it. A state that never happened,
 *     reported as fact.
 *  2. **An empty row is inert.** Nothing can execute against a connection with no credential: the
 *     grant resolver hands the sandbox a handle to nothing. The row's only observable effect was
 *     being listed.
 *  3. **It told the founder what trade he was in.** Setting up one packaged business left
 *     `bank-feed`, `books-email` and `xero` sitting on a shared surface for good, and the founder's
 *     words for that were "I'm not a bookkeeping company, for fuck's sake."
 *
 * Rows are now created at the moment the founder supplies something, by the two paths that already
 * did it idempotently: `POST /v1/composio/toolkits/:toolkit/connect` for a brokered app, and
 * `POST /v1/blueprints/:slug/connections/:name/secret` for a pasted credential (which creates the
 * row from this same spec — kind and config included — so nothing about the blueprint is lost).
 *
 * `buildChecklist` is unchanged in spirit and still names every requirement: what is missing is a
 * fact about the blueprint, not about our database, and it was never the rows that knew it.
 */
export async function provision(
  domain: DomainStore,
  blueprint: Blueprint,
  projectId: string,
): Promise<ProvisionResult> {
  const created = { schedules: [] as string[], knowledge: [] as string[] };
  const reused = { schedules: [] as string[] };

  // 1. schedules — DISABLED until the project is ready (see the header note)
  const existingScheds = (await domain.listSchedules()).filter((s) => s.project_id === projectId);
  const schedByName = new Set(existingScheds.map((s) => s.name));
  for (const spec of blueprint.schedules ?? []) {
    if (schedByName.has(spec.name)) {
      reused.schedules.push(spec.name);
      continue;
    }
    await domain.createSchedule({
      project_id: projectId,
      name: spec.name,
      wedge: blueprint.wedge,
      task_type: spec.task_type,
      input: spec.input ?? {},
      cadence: spec.cadence,
      enabled: false,
      next_run_at: firstRun(spec.cadence),
    });
    created.schedules.push(spec.name);
  }

  // 2. seed knowledge — skip names that already exist so a re-provision can't clobber edits
  const existingKnowledge = new Set((await domain.listKnowledge(blueprint.wedge, projectId)).map((k) => k.name));
  for (const k of blueprint.seed_knowledge ?? []) {
    if (existingKnowledge.has(k.name)) continue;
    await domain.createKnowledge({
      project_id: projectId,
      wedge: blueprint.wedge,
      name: k.name,
      content: k.content,
      kind: (k.kind as "document" | "fact" | "example" | "correction") ?? "document",
      source: "authored",
      // A blueprint is product content: authored by whoever wrote the template, identical for every
      // tenant that provisions it, and about no client because none exists yet at provision time.
      metadata: { from_blueprint: blueprint.blueprint, sensitivity: "house" },
    });
    created.knowledge.push(k.name);
  }

  const checklist = await buildChecklist(domain, blueprint, projectId);
  return {
    blueprint: blueprint.blueprint,
    project_id: projectId,
    created,
    reused,
    checklist,
    ready: checklist.every((i) => i.done),
  };
}

/**
 * Has this blueprint been set up in this project at all?
 *
 * Used to be inferred from "does a connection row exist with one of the declared names", which was
 * only ever true because provisioning created those rows. Now that it does not, the honest signal is
 * the thing provisioning actually creates: the blueprint's schedules. A UI that gets this wrong
 * shows a founder step one of a setup flow they already completed.
 */
export async function isProvisioned(
  domain: DomainStore,
  blueprint: Blueprint,
  projectId: string,
): Promise<boolean> {
  const names = new Set((blueprint.schedules ?? []).map((s) => s.name));
  if (names.size > 0) {
    return (await domain.listSchedules()).some((s) => s.project_id === projectId && names.has(s.name));
  }
  // A desk with no clock still seeds knowledge on provision. That is the durable mark — otherwise
  // step 1 of /start stays undone after a successful Set it up, step 2 (mailbox) never appears,
  // and Go live on Home is a disabled mystery. Observed on security-questionnaire when schedules
  // was `[]`.
  const seeded = (blueprint.seed_knowledge ?? []).map((k) => k.name);
  if (seeded.length === 0) return false;
  const have = new Set((await domain.listKnowledge(blueprint.wedge, projectId)).map((k) => k.name));
  return seeded.some((n) => have.has(n));
}

/**
 * What's still missing before this business can actually run.
 *
 * Every item names a requirement of the BLUEPRINT, whether or not anything exists in the database
 * for it yet — so `connection_id` is present only once the founder has started that one, and
 * `action` names the call that works in either case.
 */
export async function buildChecklist(
  domain: DomainStore,
  blueprint: Blueprint,
  projectId: string,
): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  const conns = (await domain.listConnections()).filter((c) => c.project_id === projectId);

  for (const spec of blueprint.requires_connections ?? []) {
    /**
     * A CAPABILITY REQUIREMENT — satisfied by any one of several apps.
     *
     * `done` comes from the binding, not from "a row called `stripe` exists". That is what lets the
     * same blueprint be finished by a QuickBooks business and a Stripe business, and it is why the
     * item carries `options` instead of a single toolkit: the checklist asks a question with real
     * answers in it rather than issuing an instruction about one vendor.
     */
    if (spec.capability && isCapability(spec.capability)) {
      const cap = spec.capability;
      const binding = resolveCapability(cap, conns, projectId);
      const optionOf = (p: CapabilityProvider) => ({
        toolkit: p.toolkit,
        label: p.label,
        via: p.via,
        read_tools: readToolsFor(cap, p.toolkit),
        // The read tools go in the connect call, so a founder who picks QuickBooks grants exactly the
        // QuickBooks slugs this capability needs — no more, and never a slug from another vendor.
        action:
          p.via === "composio"
            ? `POST /v1/composio/toolkits/${p.toolkit}/connect ${JSON.stringify({ read_tools: readToolsFor(cap, p.toolkit) })}`
            : `POST /v1/connections {"kind":"${p.via}"}`,
      });
      items.push({
        name: spec.name,
        capability: cap,
        question: CAPABILITIES[cap].question,
        what: CAPABILITIES[cap].title,
        why: spec.why,
        done: binding.ok,
        detail: binding.detail,
        options: binding.candidates.map(optionOf),
        connected: binding.bound.map((b) => ({
          toolkit: b.provider.toolkit,
          label: b.provider.label,
          connection_id: b.connection.id,
          readable: !b.unreadable,
        })),
        // No `action`: there is no single call, which is the point. The UI acts on one `options` row.
      });
      continue;
    }

    const conn = conns.find((c) => c.name === spec.name);
    // A brokered connection has nothing to paste — it's an OAuth click, and the token stays at
    // Composio. Telling a founder to "supply a credential" for Xero would send them looking for a
    // key that no longer exists in this flow.
    const brokered = spec.kind === "composio";
    const toolkit = brokered ? (conn ? composioConnConfig(conn).toolkit : String(spec.config?.toolkit ?? spec.name)) : "";
    const hasCred = conn
      ? brokered
        ? !!composioConnConfig(conn).connected_account_id
        : !!conn.secret_ref || (await hasSecret(conn.id))
      : false;
    const readTools = Array.isArray(spec.config?.read_tools)
      ? (spec.config.read_tools as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined;
    items.push({
      name: spec.name,
      what: brokered ? `Connect ${toolkit || spec.name}` : `Credential for “${spec.name}”`,
      why: spec.secret_hint ?? spec.why,
      done: hasCred,
      connection_id: conn?.id,
      kind: spec.kind,
      ...(brokered ? { toolkit: toolkit || spec.name, ...(readTools ? { read_tools: readTools } : {}) } : {}),
      /**
       * Never `undefined`. It used to be, for exactly the case that is now the COMMON one — no row
       * yet — which left the checklist saying "this is missing" and nothing at all about how to
       * finish it. Both of these routes create the row themselves, idempotently.
       */
      action: brokered
        ? conn
          ? `POST /v1/connections/${conn.id}/composio/connect`
          : `POST /v1/composio/toolkits/${toolkit || spec.name}/connect`
        : conn
          ? `POST /v1/connections/${conn.id}/secret {"value":"…"}`
          : `POST /v1/blueprints/${blueprint.blueprint}/connections/${spec.name}/secret {"value":"…"}`,
    });
  }

  // The wedge has to exist, or nothing else matters.
  items.push({
    what: `Wedge “${blueprint.wedge}” installed`,
    why: "Defines the task types, skills and knowledge this business runs on.",
    done: !!loadWedge(blueprint.wedge),
  });

  return items;
}
