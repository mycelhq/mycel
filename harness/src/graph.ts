// The ontology graph — traversal over the nouns that already exist.
//
// ═══ WHAT THIS FIXES ═══
//
// vision.md:53 says the nouns are "clients, engagements, owed work, evidence, approvals, artifacts,
// invoices, and outcomes". Every one of them is already a row (contract.ts) and every relationship
// between them is already a foreign key (`Case.client_id`, `Thread.case_id`, `Invoice.case_id`,
// `ClientRequest.case_id`, `Task.case_id`, `MoveOutcome.move_id`). What did not exist was anything
// that could WALK them.
//
// So "what is going on with Acme?" was six queries — clients, cases, threads, invoices, requests,
// tasks — and a human doing the join in their head. That is the difference between a database and an
// ontology, and it is why every agent run rediscovers the business from prompts: there was no read
// that returned a situation, only reads that returned tables.
//
// ═══ EDGES ARE DERIVED, NEVER STORED ═══
//
// There is deliberately NO edge table. An edge here is a pure function of the foreign key that is
// already on the row (`edgesFrom` below), computed at read time from the same query the node came
// from.
//
// A stored edge table would be a second copy of a relationship whose first copy is the row itself,
// and the two would disagree the first time anything wrote one without the other:
// `DomainStore.updateThread` re-points `case_id`, `updateCase` re-points `client_id` when a prospect
// converts, and `resolveRequest` closes a request — none of them know an edge table exists, and none
// of them should have to. This module makes the same argument brain.ts:11 makes about `ClientMemory`
// and client-context.ts:1-23 makes about a second home for the truth: nothing here owns a row, and
// nothing here owns a relationship. If the FK changes, the graph changed, with no migration and no
// backfill and no window in which the two disagree.
//
// The cost of deriving is that traversal is N queries rather than one recursive CTE. That cost is
// paid down by the bounds below, which exist anyway.
//
// ═══ EVERY TRAVERSAL IS BOUNDED, AND THAT IS NOT A TUNING KNOB ═══
//
// An unbounded traversal on a busy client is an unbounded response. A client with four years of
// engagements has thousands of messages, and "what is going on with Acme" must not be a mechanism
// for turning one HTTP request into the entire history of a business — not for the founder's browser
// and CERTAINLY not for a model context window, where it is also a bill. Three independent bounds
// apply at once (depth, total nodes, per-node fan-out) because each one alone has a shape that
// defeats it: depth alone loses to a client with 5,000 threads at depth 1, fan-out alone loses to a
// deep chain, and a node cap alone gives an arbitrary slice with no shape.
import type { DomainStore } from "./domain";
import type { BillingStore } from "./billing";
import type { RequestStore } from "./requests";
import type { DeliverableStore } from "./deliverables";
import type { Store } from "./store";
import { effectiveStatus, invoiceTotals } from "./billing";
import { readMoneyPlan } from "./money-plan";
import type { BrainAuthority } from "./brain";
import { MOVES_WEDGE, OUTCOME_COLLECTION, type MoveAuthority, type MoveOutcome } from "./moves";

/**
 * The stores a traversal reads. Passed in, never reached for — the same rule as `BrainStores` and
 * `MoveStores`, so a test can hand this module three fakes and no singleton leaks between them.
 *
 * `tasks` is optional and narrowed to two methods. It is the ONLY store here whose list method has
 * no tenant filter (`Store.listTasks` takes status/wedge/client_id and no project), so every read of
 * it below is guarded twice — once by asking only for an authorised `client_id`, once by checking
 * `task.project_id` on the way out. Narrowing the type to the two methods used means this module
 * cannot grow a third, less careful, call into it without someone editing this line.
 */
export interface GraphStores {
  domain: DomainStore;
  billing: BillingStore;
  requests: RequestStore;
  tasks?: Pick<Store, "listTasks" | "listArtifacts">;
  deliverables?: Pick<DeliverableStore, "listDeliverables">;
}

// ── authority ────────────────────────────────────────────────────────────────────────────────────
//
// ═══ WHY THIS IS A THIRD BRAND, AND WHY IT STILL IS NOT A THIRD DERIVATION PATH ═══
//
// The brief asked whether `BrainAuthority` composes. It does not, and the reason is the same one
// moves.ts:78 gives for `MoveAuthority`, only sharper here.
//
// `BrainAuthority` holds exactly ONE `wedge`, and it is right to: it gates knowledge and rules by
// sensitivity, and a run belongs to one wedge and reads that wedge's knowledge. But a traversal is
// the opposite shape. "What is going on with Acme" spans the books-keeper case, the gtm-operator
// prospect it came from, and the invoice-chaser ladder chasing the fee — a single-wedge traversal
// would silently return a THIRD of the client's situation and look complete while doing it, which is
// worse than refusing. Widening `BrainAuthority.wedge` to a set to serve traversal would loosen the
// knowledge-sensitivity gate that every brain read depends on, to serve a module that reads no
// knowledge at all.
//
// So the shape must be multi-wedge. But minting a third pair of constructors that turn a project id
// into a scope would be a third place for the "just pass the project id" leak to happen, and this
// codebase has already shipped two of those. Hence the rule that makes this cheap:
//
//   ══ A `GraphAuthority` CAN ONLY BE MINTED FROM AN AUTHORITY THAT WAS ITSELF DERIVED. ══
//
// `fromBrain` and `fromMove` are the only constructors, and both take an already-branded, already-
// derived authority whose sets came from a task nonce or from the founder's own session. There is no
// function in this file that takes a `project_id: string`. That is strictly stronger than copying
// the constructor pattern a third time: adding a new way to scope a traversal requires first adding
// a new way to scope a brain read or a move proposal, where the scrutiny already lives.
declare const BRAND: unique symbol;

/** WHAT THIS TRAVERSAL MAY SEE. Immutable, and only ever narrowed. */
export interface GraphAuthority {
  readonly [BRAND]: "graph-authority";
  /** `"founder"` on the founder plane, a task id on the run plane — so a mixed trace is obvious. */
  readonly task_id: string;
  /** Tenant. Never empty: neither source authority can be constructed without one. */
  readonly project_id: string;
  /**
   * The wedges whose cases may be walked. Empty means NOTHING, never "all of them" — the empty set
   * is the tightest scope here exactly as it is in `BrainAuthority.client_ids`.
   */
  readonly wedges: readonly string[];
  /**
   * The clients whose rows may be read. Empty is a house-wide caller and reads NO client-owned row.
   * Reading empty as "unfiltered" is the bug family this whole pattern exists to make unwriteable.
   */
  readonly client_ids: readonly string[];
  readonly case_ids: readonly string[];
}

/**
 * Run plane. One wedge, because the source authority has one and widening it here would invent
 * exactly the scope this module refuses to build.
 */
export function graphAuthorityFromBrain(auth: BrainAuthority): GraphAuthority {
  return {
    task_id: auth.task_id,
    project_id: auth.project_id,
    wedges: Object.freeze([auth.wedge].filter(Boolean)),
    client_ids: Object.freeze([...auth.client_ids]),
    case_ids: Object.freeze([...auth.case_ids]),
  } as GraphAuthority;
}

/**
 * Founder plane (and any multi-wedge run plane). `MoveAuthority` already carries the exact shape a
 * traversal needs — project, wedge SET, clients, cases — and it is already derived-only, so this is
 * a re-brand rather than a new scope.
 */
export function graphAuthorityFromMove(auth: MoveAuthority): GraphAuthority {
  return {
    task_id: auth.task_id,
    project_id: auth.project_id,
    wedges: Object.freeze([...auth.wedges]),
    client_ids: Object.freeze([...auth.client_ids]),
    case_ids: Object.freeze([...auth.case_ids]),
  } as GraphAuthority;
}

// ── the bounds ───────────────────────────────────────────────────────────────────────────────────

/**
 * How far a traversal walks. Three is the number the questions need and not one more:
 * `client → case → invoice → chase` and `client → case → thread → message` are both exactly three
 * hops from the root a founder names, and nothing a founder asks in one sentence is four.
 */
export const MAX_DEPTH = 3;
/** Total nodes in one neighbourhood, root included. The response ceiling. */
export const MAX_NODES = 120;
/** Neighbours ONE node may contribute. Stops a single 5,000-message thread from being the answer. */
export const MAX_FANOUT = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// ── the nouns and the relationships ──────────────────────────────────────────────────────────────

export const NODE_KINDS = [
  "client",
  "case",
  "thread",
  "message",
  "invoice",
  "request",
  "task",
  "deliverable",
  "artifact",
  "move",
  "outcome",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * The relationships. Each one names the foreign key it is derived from, because that key IS the
 * edge — if you cannot point at the column, there is no edge to draw.
 */
export const EDGE_RELS = [
  "client.cases", //     Case.client_id
  "case.threads", //     Thread.case_id
  "thread.messages", //  Message.thread_id
  "case.invoices", //    Invoice.case_id
  "invoice.chases", //   Task.input.invoice_id
  "case.requests", //    ClientRequest.case_id
  "case.tasks", //       Task.case_id
  "case.deliverables", // Deliverable.case_id — the outbound fulfilment half, previously unreachable
  "task.artifacts", //   Artifact.task_id
  "case.artifacts", //   Artifact.task_id ∘ Task.case_id — the two-hop the brief names as one edge
  "move.outcome", //     MoveOutcome.move_id
  "move.entity", //      Move.entity.id
  "client.threads", //   Thread.client_id (the general conversation, which has no case)
  "client.invoices", //  Invoice.client_id (billing not tied to an engagement)
  "client.requests", //  ClientRequest.client_id
] as const;
export type EdgeRel = (typeof EDGE_RELS)[number];

export interface NodeRef {
  kind: NodeKind;
  id: string;
}

/**
 * One noun, flattened to what an answer can actually say about it.
 *
 * `facts` is a small flat bag of already-safe scalars, not the row. The row would carry
 * `Invoice.internal_note` (explicitly never crossing to a client plane), `ClientRequest.task_id`
 * (founder-plane only) and free-form `data`/`metadata` blobs whose contents nobody has audited. A
 * traversal that returns rows is a traversal that leaks whatever gets added to a row next year, so
 * this is an allowlist and it is per-kind.
 */
export interface GraphNode extends NodeRef {
  /** One line a human reads. Already clipped. */
  label: string;
  /** ISO instant this node is "as of", for recency ordering. */
  at?: string;
  client_id?: string;
  case_id?: string;
  facts: Record<string, string | number>;
  /** Where the founder UI can open it. Relative, always. */
  href?: string;
}

export interface GraphEdge {
  from: NodeRef;
  to: NodeRef;
  rel: EdgeRel;
}

export interface Neighbourhood {
  root: GraphNode;
  /** Includes the root, at index 0. Never longer than `MAX_NODES`. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** How deep it actually walked. */
  depth: number;
  /** True when a bound stopped the walk — the caller is holding a slice, not the situation. */
  truncated: boolean;
  /**
   * Rows the authority refused. A COUNT ONLY, for the same reason as `BrainCounts.authority_excluded`
   * — it lets an answer say "there are 3 more you cannot see" without saying anything about them.
   */
  authority_excluded: number;
}

const CLIP = 160;
const clip = (s: string, n = CLIP): string => (s.length <= n ? s : `${s.slice(0, n)}…`);
const key = (r: NodeRef) => `${r.kind}:${r.id}`;

/** Is a row owned by `owner` readable here? Unowned rows are house-wide, as everywhere else. */
const ownerAllowed = (auth: GraphAuthority, owner?: string): boolean =>
  !owner ? true : auth.client_ids.includes(owner);

// ── node builders (the allowlist, one per kind) ──────────────────────────────────────────────────

const clientNode = (c: { id: string; display_name?: string; created_at: string; updated_at: string }): GraphNode => ({
  kind: "client",
  id: c.id,
  label: clip(c.display_name || "client"),
  at: c.updated_at,
  client_id: c.id,
  facts: { since: c.created_at.slice(0, 10) },
  href: `/clients/${c.id}`,
});

/**
 * The money PROMISE on a case, summarised from `Case.data.money_plan`.
 *
 * The graph walks issued invoices but the plan they are drawn from — the deposit, the milestones,
 * the retainer state — lived only in `case.data` and was invisible to "what's going on with Acme?".
 * These are derived on read, never a second copy: the numbers come straight off the stored plan, and
 * a case with no plan contributes no fields (rather than a row of zeros that reads as "priced at 0").
 */
const planFacts = (data: unknown): Record<string, string | number> => {
  const plan = readMoneyPlan(data as Record<string, unknown> | undefined);
  if (!plan?.lines?.length) return {};
  const sum = (pred: (s: string) => boolean) =>
    plan.lines.reduce((n, l) => n + (pred(l.status) ? l.amount_minor || 0 : 0), 0);
  const retainer = plan.lines.find((l) => l.kind === "retainer" && l.recurrence);
  return {
    plan_currency: plan.currency,
    plan_total_minor: sum(() => true),
    plan_paid_minor: sum((s) => s === "paid"),
    plan_outstanding_minor: sum((s) => s === "planned" || s === "invoiced"),
    ...(retainer?.recurrence ? { retainer: retainer.recurrence.state } : {}),
  };
};

const caseNode = (k: import("./contract").Case): GraphNode => ({
  kind: "case",
  id: k.id,
  label: clip(k.title),
  at: k.updated_at,
  client_id: k.client_id,
  case_id: k.id,
  facts: {
    wedge: k.wedge,
    stage: k.stage,
    status: k.status,
    ...(k.due_at ? { due_at: k.due_at } : {}),
    ...planFacts(k.data),
  },
  href: `/work/${k.id}`,
});

const threadNode = (t: import("./contract").Thread): GraphNode => ({
  kind: "thread",
  id: t.id,
  label: clip(t.subject ?? "conversation"),
  at: t.updated_at,
  client_id: t.client_id,
  case_id: t.case_id,
  facts: { status: t.status },
});

const messageNode = (m: import("./contract").Message, clientId: string, caseId?: string): GraphNode => ({
  kind: "message",
  id: m.id,
  // The body IS the fact here — a message whose label hides its text is a citation to nothing.
  label: clip(m.body),
  at: m.created_at,
  client_id: clientId,
  case_id: caseId,
  facts: { direction: m.direction },
});

const invoiceNode = (inv: import("./contract").Invoice): GraphNode => {
  const t = invoiceTotals(inv);
  return {
    kind: "invoice",
    id: inv.id,
    label: `${inv.number} · ${effectiveStatus(inv)}`,
    at: inv.updated_at,
    client_id: inv.client_id,
    case_id: inv.case_id,
    facts: {
      status: effectiveStatus(inv),
      currency: inv.currency,
      total_minor: t.total,
      outstanding_minor: t.amount_due,
      ...(inv.due_date ? { due_date: inv.due_date } : {}),
      ...(inv.last_chased_at ? { last_chased_at: inv.last_chased_at } : {}),
    },
    href: `/invoices/${inv.id}`,
  };
};

const deliverableNode = (d: import("./contract").Deliverable): GraphNode => ({
  kind: "deliverable",
  id: d.id,
  label: clip(d.title),
  at: d.updated_at,
  client_id: d.client_id,
  case_id: d.case_id,
  // The allowlist: state and version, never the version list, the change comments or the artifact
  // ids — those are the founder/portal plane's, read through the deliverable routes, not a traversal.
  facts: {
    kind: d.kind,
    status: d.status,
    version: d.current_version,
    ...(d.accepted_at ? { accepted_at: d.accepted_at } : {}),
  },
  href: `/deliverables/${d.id}`,
});

const requestNode = (r: import("./contract").ClientRequest): GraphNode => ({
  kind: "request",
  id: r.id,
  label: clip(r.ask),
  at: r.updated_at,
  client_id: r.client_id,
  case_id: r.case_id,
  facts: {
    kind: r.kind,
    status: r.status,
    ...(r.due_at ? { due_at: r.due_at } : {}),
    nudges: r.nudge_count ?? 0,
  },
  href: `/requests/${r.id}`,
});

const taskNode = (t: import("./contract").Task): GraphNode => ({
  kind: "task",
  id: t.id,
  label: clip(`${t.task_type} · ${t.status}`),
  at: t.updated_at ?? t.created_at,
  client_id: t.client_id,
  case_id: t.case_id,
  facts: { wedge: t.wedge, task_type: t.task_type, status: t.status },
});

const artifactNode = (
  // `Omit<…, "content">` deliberately: `listArtifacts` returns metadata without bytes, and taking the
  // narrower type here means this function CANNOT be handed a row carrying content that it might
  // then put in a fact. The type is the guard.
  a: Omit<import("./contract").Artifact, "content">,
  clientId?: string,
  caseId?: string,
): GraphNode => ({
  kind: "artifact",
  id: a.id,
  label: clip(a.name),
  at: a.created_at,
  client_id: clientId,
  case_id: caseId,
  // Metadata only. Artifact BYTES are served by `/v1/artifacts/:id` under its own check; a traversal
  // that inlined them would turn "summarise this client" into an exfiltration primitive.
  facts: { content_type: a.content_type, size_bytes: a.size_bytes ?? 0 },
  href: `/artifacts/${a.id}`,
});

const outcomeNode = (o: MoveOutcome, id: string): GraphNode => ({
  kind: "outcome",
  id,
  label: `${o.kind} → ${o.result}`,
  at: o.at,
  facts: { kind: o.kind, result: o.result, by: o.by, entity_id: o.entity_id },
});

// ── expansion ────────────────────────────────────────────────────────────────────────────────────

interface Expansion {
  nodes: GraphNode[];
  rel: EdgeRel;
}

/**
 * The neighbours of one node.
 *
 * Every block follows the same three steps in the same order, and the order is the safety property —
 * it is lifted verbatim from `gather` in brain.ts and `proposeMoves` in moves.ts, because three
 * differently-written versions of this is how the first leak happened:
 *
 *   1. ask the store with the tenant pushed INTO the query,
 *   2. drop what the authority forbids, COUNTING it,
 *   3. only then clip to the fan-out bound.
 *
 * Step 3 last is what makes the count honest. Truncating first and filtering after would report
 * `authority_excluded: 0` for a project full of rows it may not read, and "you saw everything" is the
 * one lie this number must never tell.
 */
async function expand(
  stores: GraphStores,
  auth: GraphAuthority,
  node: GraphNode,
  excluded: { n: number },
): Promise<Expansion[]> {
  const out: Expansion[] = [];
  const take = (nodes: GraphNode[], rel: EdgeRel) => {
    if (nodes.length) out.push({ nodes: nodes.slice(0, MAX_FANOUT), rel });
  };
  const keep = <T>(rows: T[], owner: (r: T) => string | undefined): T[] => {
    const kept: T[] = [];
    for (const r of rows) {
      if (!ownerAllowed(auth, owner(r))) {
        excluded.n++;
        continue;
      }
      kept.push(r);
    }
    return kept;
  };
  const byRecency = <T extends { at?: string }>(ns: T[]) =>
    [...ns].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  switch (node.kind) {
    case "client": {
      if (!ownerAllowed(auth, node.id)) return out;
      // Cases are asked for one wedge at a time because `CaseFilter.wedge` is the tenant-adjacent
      // filter the store honours; an authority with no wedges therefore reads no case at all, which
      // is the correct answer for a business that has not started a wedge.
      const cases: import("./contract").Case[] = [];
      for (const wedge of auth.wedges) {
        cases.push(...(await stores.domain.listCases({ project_id: auth.project_id, wedge, client_id: node.id })));
      }
      take(byRecency(keep(cases, (k) => k.client_id).map(caseNode)), "client.cases");

      // Threads with NO case: the general conversation. Threads already under a case arrive via
      // `case.threads`, and emitting them twice would let one busy engagement eat the fan-out twice.
      const threads = (await stores.domain.listThreadsForClient(node.id)).filter(
        (t) => t.project_id === auth.project_id && !t.case_id,
      );
      take(byRecency(keep(threads, (t) => t.client_id).map(threadNode)), "client.threads");

      const invoices = await stores.billing.listInvoices({ project_id: auth.project_id, client_id: node.id });
      take(byRecency(keep(invoices, (i) => i.client_id).map(invoiceNode).filter((n) => !n.case_id)), "client.invoices");

      const requests = await stores.requests.listRequests({ project_id: auth.project_id, client_id: node.id });
      take(byRecency(keep(requests, (r) => r.client_id).map(requestNode).filter((n) => !n.case_id)), "client.requests");
      return out;
    }

    case "case": {
      if (!auth.case_ids.includes(node.id)) {
        // A case outside the authority contributes nothing and is COUNTED. It is also never reached
        // as a root — `nodeOf` refuses it first — so this is the defence for a case that arrived as
        // somebody else's neighbour.
        excluded.n++;
        return out;
      }
      const threads = (await stores.domain.listThreadsForClient(node.client_id ?? "")).filter(
        (t) => t.project_id === auth.project_id && t.case_id === node.id,
      );
      take(byRecency(keep(threads, (t) => t.client_id).map(threadNode)), "case.threads");

      const invoices = await stores.billing.listInvoices({ project_id: auth.project_id, case_id: node.id });
      take(byRecency(keep(invoices, (i) => i.client_id).map(invoiceNode)), "case.invoices");

      const requests = await stores.requests.listRequests({ project_id: auth.project_id, case_id: node.id });
      take(byRecency(keep(requests, (r) => r.client_id).map(requestNode)), "case.requests");

      // The outbound half of the engagement: the work this case shipped. Previously the graph walked
      // the invoices owed for a deliverable but never the deliverable itself, so "what's going on with
      // Acme?" could see the bill and not the work it was for.
      if (stores.deliverables) {
        const deliverables = await stores.deliverables.listDeliverables({ project_id: auth.project_id, case_id: node.id });
        take(byRecency(keep(deliverables, (d) => d.client_id).map(deliverableNode)), "case.deliverables");
      }

      const tasks = (await tasksForClient(stores, auth, node.client_id)).filter((t) => t.case_id === node.id);
      take(byRecency(tasks.map(taskNode)), "case.tasks");
      return out;
    }

    case "thread": {
      if (!ownerAllowed(auth, node.client_id)) {
        excluded.n++;
        return out;
      }
      const messages = await stores.domain.listMessages(node.id);
      // Newest first, then clipped: an old thread's answer should be what was said LAST, not what
      // was said first. Slicing in arrival order would answer "where does this stand" with the
      // opening pleasantry.
      take(byRecency(messages.map((m) => messageNode(m, node.client_id ?? "", node.case_id))), "thread.messages");
      return out;
    }

    case "invoice": {
      if (!ownerAllowed(auth, node.client_id)) {
        excluded.n++;
        return out;
      }
      // The chases. `Task.input.invoice_id` is the key `chaseTaskInput` writes (dunning.ts:125), so
      // this is derived from the run's own input rather than from a chase log nobody maintains.
      const tasks = (await tasksForClient(stores, auth, node.client_id)).filter(
        (t) => (t.input as Record<string, unknown> | undefined)?.invoice_id === node.id,
      );
      take(byRecency(tasks.map(taskNode)), "invoice.chases");
      return out;
    }

    case "task": {
      if (!ownerAllowed(auth, node.client_id)) {
        excluded.n++;
        return out;
      }
      if (!stores.tasks) return out;
      const artifacts = await stores.tasks.listArtifacts(node.id);
      take(
        byRecency(artifacts.map((a) => artifactNode(a, node.client_id, node.case_id))),
        // `case.artifacts` when this task hangs off a case: the brief names case→artifacts as one
        // edge and it IS one relationship, but the only column joining them is `Artifact.task_id`
        // composed with `Task.case_id`. Naming the composed relationship rather than inventing a
        // column keeps the edge derived.
        node.case_id ? "case.artifacts" : "task.artifacts",
      );
      return out;
    }

    case "move": {
      // A move is not a stored row — it is recomputed on every read (moves.ts). Its OUTCOMES are
      // rows, keyed `${move_id}:${uuid}`, so this is the one edge that walks from a computed node
      // into persisted evidence.
      const rows = await stores.domain.queryRecords({
        project_id: auth.project_id,
        wedge: MOVES_WEDGE,
        collection: OUTCOME_COLLECTION,
        limit: MAX_OUTCOME_SCAN,
      });
      const mine = rows.filter((r) => r.key.startsWith(`${node.id}:`));
      take(
        byRecency(
          mine
            .map((r) => {
              const o = r.data as unknown as MoveOutcome | undefined;
              return o ? outcomeNode(o, r.id) : undefined;
            })
            .filter((n): n is GraphNode => !!n),
        ),
        "move.outcome",
      );
      return out;
    }

    default:
      return out;
  }
}

/** Outcome rows one traversal will scan. Mirrors `MAX_OUTCOME_ROWS` in moves.ts, smaller. */
const MAX_OUTCOME_SCAN = 500;

/**
 * Tasks for a client, tenant-checked twice.
 *
 * `Store.listTasks` is the one list in the kernel with no `project_id` filter. Asking by
 * `client_id` — which is only ever an id the authority already holds — means the query cannot return
 * another tenant's row in the first place, and the `project_id` check on the way out covers the case
 * where a client id was somehow reused. Belt and braces, on the only unscoped read here.
 */
async function tasksForClient(
  stores: GraphStores,
  auth: GraphAuthority,
  clientId: string | undefined,
): Promise<import("./contract").Task[]> {
  if (!stores.tasks || !clientId || !ownerAllowed(auth, clientId)) return [];
  const rows = await stores.tasks.listTasks({ client_id: clientId, limit: MAX_TASK_SCAN });
  return rows.filter((t) => t.project_id === auth.project_id);
}

const MAX_TASK_SCAN = 100;

// ── the read ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Fetch one node by reference, under the authority.
 *
 * A reference the authority forbids returns `undefined` — the SAME answer as a reference that does
 * not exist, so the refusal itself leaks nothing. That is `brain.get`'s rule and `getDeployment`'s
 * rule, and it is the property that makes "ask about another tenant's client" indistinguishable from
 * "ask about a client that was never created".
 */
export async function nodeOf(
  stores: GraphStores,
  auth: GraphAuthority,
  ref: NodeRef,
): Promise<GraphNode | undefined> {
  switch (ref.kind) {
    case "client": {
      if (!auth.client_ids.includes(ref.id)) return undefined;
      const c = await stores.domain.getClient(ref.id);
      // The authority set is built from this project's clients, but the row is re-checked anyway:
      // "the set was built correctly" is an assumption, and `getClient` takes no tenant.
      return c && c.project_id === auth.project_id ? clientNode(c) : undefined;
    }
    case "case": {
      if (!auth.case_ids.includes(ref.id)) return undefined;
      const k = await stores.domain.getCase(ref.id);
      if (!k || k.project_id !== auth.project_id) return undefined;
      if (!auth.wedges.includes(k.wedge)) return undefined;
      if (!ownerAllowed(auth, k.client_id)) return undefined;
      return caseNode(k);
    }
    case "invoice": {
      // Listed by (project, id-less) filter then matched, because `getInvoice` takes no tenant and
      // fetch-then-compare is the shape that leaks. `listInvoices` fails closed on project_id.
      const inv = (await stores.billing.listInvoices({ project_id: auth.project_id })).find((i) => i.id === ref.id);
      return inv && ownerAllowed(auth, inv.client_id) ? invoiceNode(inv) : undefined;
    }
    case "request": {
      const r = await stores.requests.getRequest(auth.project_id, ref.id);
      return r && ownerAllowed(auth, r.client_id) ? requestNode(r) : undefined;
    }
    case "thread": {
      const t = await stores.domain.getThread(ref.id);
      if (!t || t.project_id !== auth.project_id) return undefined;
      return ownerAllowed(auth, t.client_id) ? threadNode(t) : undefined;
    }
    case "task": {
      const rows = await stores.tasks?.listTasks({ limit: MAX_TASK_SCAN });
      const t = rows?.find((r) => r.id === ref.id);
      if (!t || t.project_id !== auth.project_id) return undefined;
      return ownerAllowed(auth, t.client_id) ? taskNode(t) : undefined;
    }
    case "move":
      // Computed, not stored: the caller already holds the `Move` (it came from `proposeMoves` under
      // its own authority), so this is a handle to hang outcomes off rather than a fetch.
      return { kind: "move", id: ref.id, label: "move", facts: {} };
    default:
      return undefined;
  }
}

export interface NeighbourhoodOptions {
  depth?: number;
  maxNodes?: number;
}

/**
 * WHAT SURROUNDS THIS ENTITY.
 *
 * Breadth-first, so the bound cuts the LEAST relevant thing. A depth-first walk that hits
 * `maxNodes` returns one client's entire first engagement in forensic detail and nothing about the
 * other four — a technically-bounded answer that is wrong about the business. Breadth-first spends
 * the budget on the closest ring first, which is what "what is going on with Acme" means.
 */
export async function neighbourhood(
  stores: GraphStores,
  auth: GraphAuthority,
  ref: NodeRef,
  opts: NeighbourhoodOptions = {},
): Promise<Neighbourhood | undefined> {
  const maxDepth = clamp(Math.floor(opts.depth ?? MAX_DEPTH), 0, MAX_DEPTH);
  const maxNodes = clamp(Math.floor(opts.maxNodes ?? MAX_NODES), 1, MAX_NODES);

  const root = await nodeOf(stores, auth, ref);
  if (!root) return undefined;

  const excluded = { n: 0 };
  const nodes = new Map<string, GraphNode>([[key(root), root]]);
  const edges: GraphEdge[] = [];
  let truncated = false;
  let reached = 0;

  let frontier: GraphNode[] = [root];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const exp of await expand(stores, auth, node, excluded)) {
        for (const n of exp.nodes) {
          const k = key(n);
          if (!nodes.has(k)) {
            if (nodes.size >= maxNodes) {
              truncated = true;
              continue;
            }
            nodes.set(k, n);
            next.push(n);
          }
          // The edge is recorded even when the node was already known, because the edge is the
          // relationship and a diamond (a task reachable via its case and via its invoice) is real.
          edges.push({ from: { kind: node.kind, id: node.id }, to: { kind: n.kind, id: n.id }, rel: exp.rel });
        }
        // A fan-out that hit its cap is a slice, and the caller has to know.
        if (exp.nodes.length >= MAX_FANOUT) truncated = true;
      }
    }
    if (next.length) reached = d + 1;
    frontier = next;
  }

  return {
    root,
    nodes: [...nodes.values()],
    edges,
    depth: reached,
    truncated,
    authority_excluded: excluded.n,
  };
}
