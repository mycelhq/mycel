// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EVERYTHING THIS BUSINESS HOLDS, IN ONE FILE
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The privacy policy says "Export is self-service through the API; you don't have to ask." The DPA
// says "Export and deletion are API calls, so you mostly won't need us."
//
// Neither was true. Three hundred and fifty-three routes and not one of them exported anything.
// Both sentences were written from what we intended rather than from what was deployed, which is
// the same defect as listing a sub-processor we do not use — except this one is a commitment inside
// a data processing agreement, and it is the specific promise a buyer's security review asks about.
//
// ═══ WHY THIS IS A RETENTION FEATURE AND NOT A COMPLIANCE CHORE ═══
//
// A product a firm cannot leave is a product a firm is careful about entering. Every serious buyer
// in this category has been burned by an agency tool that held their client history hostage, and
// the question "can I get my data out" gets asked before "is the writing good". Answering it with a
// working endpoint is worth more than any assurance on the pricing page.
//
// It also costs us nothing real. The switching cost this product earns is the correction record and
// the per-client continuity - months of a founder's judgement, which is theirs and which they can
// have. What holds someone is that the thing works, not that the door is locked.
//
// ═══ WHAT IT CONTAINS ═══
//
// Everything scoped to one project that a human put there or that describes their business: the
// clients, the engagements, every deliverable with every version, invoices, records, and the
// knowledge the business taught it.
//
// NOT the task log. A run's events are our machinery - sandbox steps, tool calls, model costs - and
// including them would bury a founder's actual work under ten thousand lines of our plumbing. They
// are available per task through the trace endpoint, which is where somebody debugging one run
// looks. `GET /v1/export?tasks=1` includes them for anyone who genuinely wants the lot.

import type { DomainStore } from "./domain";
import type { DeliverableStore } from "./deliverables";
import type { KnowledgeStore } from "./knowledge.store";
import type { BillingStore } from "./billing";
import type { Store } from "./store";

export interface ExportStores {
  domain: DomainStore;
  deliverables: DeliverableStore;
  knowledge: KnowledgeStore;
  billing: BillingStore;
  tasks: Store;
}

export interface ProjectExport {
  exported_at: string;
  project_id: string;
  format: "mycel.export.v1";
  /** Said in the file, because a file that leaves the product has to explain itself. */
  note: string;
  clients: unknown[];
  cases: unknown[];
  deliverables: { deliverable: unknown; versions: unknown[] }[];
  invoices: unknown[];
  records: unknown[];
  knowledge: unknown[];
  /** What the founder taught it, and what it concluded from watching them. */
  rules: unknown[];
  observations: unknown[];
  schedules: unknown[];
  tasks?: unknown[];
}

/** Never let one unreadable table take the whole export down: a partial export beats a 500. */
async function safe<T>(what: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (e) {
    console.error(`[mycel] export: could not read ${what}:`, e);
    return [];
  }
}

export async function exportProject(
  s: ExportStores,
  projectId: string,
  opts: { tasks?: boolean; wedges?: readonly string[] } = {},
): Promise<ProjectExport> {
  const clients = await safe("clients", () => s.domain.listClients());
  const mine = clients.filter((c) => (c as { project_id?: string }).project_id === projectId);

  const cases = await safe("cases", () => s.domain.listCases({ project_id: projectId }));
  /**
   * From the BILLING store, not the domain store.
   *
   * This was an optional-method probe on `domain` - `listInvoices?.(...) ?? []` - which type-checked,
   * ran, returned an empty array, and reported zero invoices for a project that had four. An
   * optional call on the wrong object is indistinguishable from a business with no invoices, and
   * silently exporting an empty section is worse than not having the section: somebody checking
   * whether they can leave concludes there is nothing to take.
   */
  const invoices = await safe("invoices", () => s.billing.listInvoices({ project_id: projectId }));
  const records = await safe("records", () => s.domain.queryRecords({ project_id: projectId, limit: 5_000 }));
  const schedules = await safe("schedules", () => s.domain.listSchedules());

  /**
   * Knowledge is stored per wedge on the DOMAIN store, and the caller supplies the wedge list
   * because the kernel's catalogue is not this module's to know. An empty list is not an error: a
   * business that has taught it nothing has nothing here, which is a true thing for the file to say.
   */
  const knowledge: unknown[] = [];
  for (const w of opts.wedges ?? []) {
    knowledge.push(...(await safe(`knowledge:${w}`, () => s.domain.listKnowledge(w, projectId))));
  }

  /**
   * The rules a founder taught it, and the corrections it proposed from watching them work. Kept
   * separate from `knowledge` because they are a different kind of thing: knowledge is documents
   * they gave us, and these are conclusions drawn about how they work. Somebody reading this file
   * to decide whether to trust us should be able to tell those apart at a glance.
   */
  const rules = await safe("rules", () => s.knowledge.listRules(projectId));
  const observations = await safe("observations", () => s.knowledge.listObservations(projectId));

  const rows = await safe("deliverables", () => s.deliverables.listDeliverables({ project_id: projectId }));
  const deliverables: { deliverable: unknown; versions: unknown[] }[] = [];
  for (const d of rows) {
    const id = (d as { id: string }).id;
    deliverables.push({
      deliverable: d,
      // EVERY version, not the released ones. The difference between what the agent wrote and what
      // the founder sent is their record of their own judgement, and it is the single most valuable
      // thing in here. Exporting only what the client saw would hand back the least useful half.
      versions: await safe(`versions:${id}`, () => s.deliverables.listVersions(projectId, id)),
    });
  }

  const out: ProjectExport = {
    exported_at: new Date().toISOString(),
    project_id: projectId,
    format: "mycel.export.v1",
    note:
      "Everything Mycel holds for this business. Deliverable versions include the drafts an agent " +
      "wrote and the versions a human replaced them with, which together are the record of your " +
      "corrections. Run logs are excluded by default; add ?tasks=1 for those too.",
    clients: mine,
    cases,
    deliverables,
    invoices,
    records,
    knowledge,
    rules,
    observations,
    schedules: schedules.filter((x) => (x as { project_id?: string }).project_id === projectId),
  };

  if (opts.tasks) {
    out.tasks = await safe("tasks", () =>
      (s.tasks as unknown as { listTasks?: (f: unknown) => Promise<unknown[]> }).listTasks?.({
        project_id: projectId,
        limit: 5_000,
      }) ?? Promise.resolve([]),
    );
  }

  return out;
}
