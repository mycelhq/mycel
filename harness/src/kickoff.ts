// Post-close kickoff playbook — the glue that stops a won deal from orphaning week one.
//
// Convert already creates Client + Case. This arms the first asks: client connections, intake
// documents/decisions, and a money plan (plus an optional deposit draft). Same spine as books
// monthly close — ClientRequest + waits + invoices — not a second product.
import { loadProjectWedge } from "./authored";
import type { Case, CaseWait, ClientRequest, ClientRequestKind, Invoice } from "./contract";
import type { DomainStore } from "./domain";
import { isAuthoredSlug, loadWedge } from "./wedge";
import { getRequestStore, normalizeAsk, REQUEST_KINDS } from "./requests";
import {
  depositLine,
  draftInvoiceFromPlanLine,
  moneyPlanFromTemplate,
  readMoneyPlan,
  writeMoneyPlan,
  stampRetainerRecurrence,
  type MoneyPlan,
  type MoneyPlanTemplateLine,
} from "./money-plan";
import { ensureUpkeepQuietly } from "./upkeep";

export interface KickoffConnectionAsk {
  toolkit: string;
  ask: string;
  detail?: string;
}

export interface KickoffIntakeAsk {
  kind: ClientRequestKind;
  ask: string;
  detail?: string;
}

export interface KickoffSpec {
  client_connections?: KickoffConnectionAsk[];
  intake_asks?: KickoffIntakeAsk[];
  money_plan?: { currency: string; lines: MoneyPlanTemplateLine[] };
  deliverable_shapes?: Array<"document" | "file_set" | "link">;
}

export interface KickoffResult {
  case: Case;
  requests: ClientRequest[];
  money_plan?: MoneyPlan;
  deposit_invoice?: Invoice;
  /** The engagement wait kickoff parked, when the wedge declares `waits_for`. */
  wait?: CaseWait;
  /** True when we wrote anything new; false when kickoff was already done (idempotent). */
  applied: boolean;
}

/**
 * The task type whose `waits_for` kickoff uses to park the engagement.
 *
 * Kickoff is not itself a run, so it has no `task.task_type`. The wedge still has to declare how
 * waiting works — otherwise convert would raise asks and never put the case on the resume spine.
 * First `client_request` wait in the manifest wins; a wedge with none stays un-parked (fail soft).
 */
export function declaredWaitTaskType(wedge: string): string | undefined {
  const types = loadWedge(wedge)?.manifest.task_types;
  if (!types) return undefined;
  for (const [name, spec] of Object.entries(types)) {
    if (spec?.waits_for?.on === "client_request") return name;
  }
  return undefined;
}

const TOOLKIT_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * `manifest` is for a service already loaded with a tenant in hand (`loadProjectWedge`).
 * Without it, this falls through to `loadWedge`, which refuses authored slugs on purpose —
 * those callers must pass the manifest they already scoped.
 */
export function fulfillmentOf(
  wedge: string,
  manifest?: { fulfillment?: unknown },
): KickoffSpec | undefined {
  const raw = (manifest ?? loadWedge(wedge)?.manifest) as { fulfillment?: unknown } | undefined;
  const authored = isAuthoredSlug(wedge);
  const f = raw?.fulfillment;
  if (!f || typeof f !== "object" || Array.isArray(f)) {
    // An authored service with no fulfillment block still produces a document the client can
    // accept — otherwise the run goes green and Deliverables stay empty.
    return authored ? { deliverable_shapes: ["document"] } : undefined;
  }
  const o = f as Record<string, unknown>;

  const client_connections: KickoffConnectionAsk[] = [];
  if (Array.isArray(o.client_connections)) {
    for (const item of o.client_connections) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const c = item as Record<string, unknown>;
      const toolkit = String(c.toolkit ?? "")
        .trim()
        .toLowerCase();
      if (!TOOLKIT_RE.test(toolkit)) continue;
      const ask = normalizeAsk(c.ask) || `Connect your ${toolkit}`;
      client_connections.push({
        toolkit,
        ask,
        detail: typeof c.detail === "string" ? c.detail.slice(0, 5_000) : undefined,
      });
    }
  }

  const intake_asks: KickoffIntakeAsk[] = [];
  if (Array.isArray(o.intake_asks)) {
    for (const item of o.intake_asks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const a = item as Record<string, unknown>;
      const kind = REQUEST_KINDS.includes(a.kind as ClientRequestKind)
        ? (a.kind as ClientRequestKind)
        : "answer";
      // Connection asks belong in client_connections — refuse them here so a typo cannot skip OAuth.
      if (kind === "connection") continue;
      const ask = normalizeAsk(a.ask);
      if (!ask) continue;
      intake_asks.push({
        kind,
        ask,
        detail: typeof a.detail === "string" ? a.detail.slice(0, 5_000) : undefined,
      });
    }
  }

  let money_plan: KickoffSpec["money_plan"];
  if (o.money_plan && typeof o.money_plan === "object" && !Array.isArray(o.money_plan)) {
    const mp = o.money_plan as Record<string, unknown>;
    const currency = typeof mp.currency === "string" ? mp.currency : "USD";
    const lines: MoneyPlanTemplateLine[] = [];
    if (Array.isArray(mp.lines)) {
      for (const item of mp.lines) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const l = item as Record<string, unknown>;
        const label = String(l.label ?? "").trim();
        if (!label) continue;
        const kind = (["deposit", "milestone", "retainer", "period"] as const).includes(l.kind as never)
          ? (l.kind as MoneyPlanTemplateLine["kind"])
          : "milestone";
        lines.push({
          label,
          amount_minor: Math.max(0, Math.trunc(Number(l.amount_minor) || 0)),
          kind,
          ...(kind === "retainer" ? { recurrence: stampRetainerRecurrence(l.recurrence) } : {}),
        });
      }
    }
    if (lines.length) money_plan = { currency, lines };
  }

  let deliverable_shapes = Array.isArray(o.deliverable_shapes)
    ? o.deliverable_shapes.filter(
        (s): s is "document" | "file_set" | "link" =>
          s === "document" || s === "file_set" || s === "link",
      )
    : undefined;
  if (authored && !deliverable_shapes?.length) deliverable_shapes = ["document"];

  if (!client_connections.length && !intake_asks.length && !money_plan && !deliverable_shapes?.length) {
    return undefined;
  }
  return { client_connections, intake_asks, money_plan, deliverable_shapes };
}

/**
 * Run the kickoff playbook on an engagement.
 *
 * IDEMPOTENT via `data.kickoff_at`. A second convert click, or a founder re-running kickoff, must
 * not duplicate bank-statement asks and deposit drafts. Pass `force` only from an explicit
 * founder action that means "do it again".
 */
export async function runKickoffPlaybook(args: {
  domain: DomainStore;
  kase: Case;
  /** Optional overrides (e.g. founder-priced deposit on convert). */
  money_plan?: MoneyPlan;
  force?: boolean;
  /** Draft a deposit invoice when the plan has a priced deposit line. Default true. */
  draft_deposit?: boolean;
  /**
   * Thin convert: ask for a brief, do not invent a priced engagement.
   * Skips connection invites, money plan, and deposit.
   */
  intake_only?: boolean;
}): Promise<KickoffResult> {
  const { domain, kase } = args;
  if (!kase.project_id) throw new Error("kickoff requires a project on the case");
  if (!kase.client_id) throw new Error("kickoff requires a client on the case");

  const already = typeof kase.data?.kickoff_at === "string" && kase.data.kickoff_at;
  if (already && !args.force) {
    return {
      case: kase,
      requests: [],
      money_plan: readMoneyPlan(kase.data),
      applied: false,
    };
  }

  const loaded = await loadProjectWedge(kase.project_id, kase.wedge).catch(() => null);
  let spec = fulfillmentOf(kase.wedge, loaded?.manifest);
  if (args.intake_only) {
    const briefAsk: KickoffIntakeAsk = {
      kind: "answer",
      ask: "Send a brief for the first job",
      detail: "What you want done, by when, and any files we should work from.",
    };
    spec = {
      intake_asks: spec?.intake_asks?.length ? spec.intake_asks : [briefAsk],
      client_connections: [],
      deliverable_shapes: spec?.deliverable_shapes,
    };
  }
  const created: ClientRequest[] = [];
  const requests = getRequestStore();

  // ① Money plan first — deposit asks make no sense without a promise on the case.
  // Intake-only convert must not invent a priced engagement from the wedge template.
  let plan = args.intake_only ? undefined : (args.money_plan ?? readMoneyPlan(kase.data));
  if (!plan && spec?.money_plan) {
    plan = moneyPlanFromTemplate(spec.money_plan.currency, spec.money_plan.lines);
  }

  let data: Record<string, unknown> = { ...(kase.data ?? {}) };
  if (plan) data = writeMoneyPlan(data, plan);
  if (spec?.deliverable_shapes?.length) {
    data.deliverable_shapes = spec.deliverable_shapes;
  }
  data.kickoff_at = new Date().toISOString();

  const updated = await domain.updateCase(kase.id, { data });
  if (!updated) throw new Error("could not stamp kickoff on the case");

  // ② Connection invites — kind `connection`, toolkit on the row, portal OAuth clears it.
  for (const c of spec?.client_connections ?? []) {
    const row = await requests.createRequest({
      project_id: kase.project_id,
      client_id: kase.client_id,
      case_id: kase.id,
      kind: "connection",
      ask: c.ask,
      detail: c.detail,
      connection_toolkit: c.toolkit,
      party_role: "client",
    });
    created.push(row);
  }

  // ③ Intake asks — documents / answers / decisions the trade needs before first episode.
  // Attach a case-scoped client thread when a channel exists so document asks can accept uploads
  // on the portal (blocked.tsx only shows the uploader when `thread_id` is set).
  let kickoffThreadId: string | undefined;
  const channels = (await domain.listChannels()).filter(
    (ch) => !ch.project_id || ch.project_id === kase.project_id,
  );
  if (channels[0] && kase.client_id) {
    try {
      const thread = await domain.findOrCreateThread(
        kase.client_id,
        channels[0].id,
        kase.project_id,
        `Kickoff — ${kase.title || "engagement"}`,
        kase.id,
      );
      kickoffThreadId = thread.id;
    } catch (e) {
      console.error("[mycel] kickoff thread ensure failed:", e);
    }
  }

  for (const a of spec?.intake_asks ?? []) {
    const row = await requests.createRequest({
      project_id: kase.project_id,
      client_id: kase.client_id,
      case_id: kase.id,
      kind: a.kind,
      ask: a.ask,
      detail: a.detail,
      party_role: "client",
      ...(kickoffThreadId ? { thread_id: kickoffThreadId } : {}),
    });
    created.push(row);
  }

  // ④ Deposit draft — founder still sends; the leak we kill is "never raised".
  let deposit_invoice: Invoice | undefined;
  const livePlan = readMoneyPlan(updated.data);
  if (args.draft_deposit !== false && livePlan) {
    const dep = depositLine(livePlan);
    if (dep) {
      try {
        const out = await draftInvoiceFromPlanLine({
          domain,
          kase: updated,
          line: dep,
        });
        deposit_invoice = out.invoice;
        // refresh case after money-plan mutation
        Object.assign(updated, out.case);
      } catch {
        // Zero-amount or billing store not ready must not fail the whole kickoff.
      }
    }
  }

  await ensureUpkeepQuietly(domain, kase.project_id);

  // ⑤ Park. Convert used to create the asks and leave the engagement un-blocked, so Home showed
  // nudge moves and Clock showed nothing parked. `armDeclaredWait` grows an `all` join, so Xero +
  // the bank statement + the start decision are one wait, not three races. Fail soft: a wedge with
  // no `waits_for` still has the requests; it just is not on the resume spine yet.
  //
  // Dynamic import: a static waits import here cycles through server → scheduler → orchestrator → wrap.
  const { armDeclaredWait, ensureWaitSchedule } = await import("./waits");
  let wait: CaseWait | undefined;
  const waitOn = declaredWaitTaskType(kase.wedge);
  if (waitOn && created.length) {
    for (const row of created) {
      const parked = await armDeclaredWait(domain, {
        project_id: kase.project_id,
        case_id: kase.id,
        wedge: kase.wedge,
        task_type: waitOn,
        request_id: row.id,
        ask_label: row.ask,
        declaredBy: (w, t) => loadWedge(w)?.manifest.task_types?.[t]?.waits_for,
        declaresTaskType: (w, t) => !!loadWedge(w)?.manifest.task_types?.[t],
      }).catch(() => undefined);
      if (parked) wait = parked;
    }
    if (wait) await ensureWaitSchedule(domain, kase.project_id).catch(() => {});
  }

  return {
    case: (await domain.getCase(kase.id)) ?? updated,
    requests: created,
    money_plan: readMoneyPlan(((await domain.getCase(kase.id)) ?? updated).data),
    deposit_invoice,
    wait,
    applied: true,
  };
}
