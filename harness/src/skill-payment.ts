// THE END OF THE LOOP — somebody paid for it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS WORTH THE FIVE HOPS IT TAKES
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Every other signal in `skill-scales.ts` is an opinion. A founder releasing a deliverable thinks it
// is good enough; a client accepting it says the same more slowly. Both are worth having and both are
// free to be wrong, and neither costs the person holding the opinion anything.
//
// A settled invoice is the one event in this system where somebody moved money because of work an
// agent did. It is the only evidence here that is not somebody's judgement about quality, and it is
// therefore the only one that cannot be talked out of.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE JOIN, AND WHY IT NEEDED NO SCHEMA CHANGE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
//   invoice → its case → the money-plan line carrying `invoice_id` → that line's `deliverable_id`
//           → the deliverable's released version → its `task_id` → the skills that run read.
//
// `draftInvoiceFromPlanLine` already writes both `invoice_id` and `deliverable_id` onto the line when
// it raises an invoice from accepted work, precisely so a founder can see which money belongs to
// which deliverable. That link is the join, and it has been sitting there unused.
//
// EVERY HOP IS ALLOWED TO FAIL, and most of them will. An invoice raised by hand has no plan line. A
// line with no `deliverable_id` was a deposit rather than a piece of work. A deliverable whose
// versions carry no `task_id` was written by a human. None of those is an error — they are invoices
// that are simply not evidence about a skill, and the correct response to each is to stop quietly.
// The one thing this must never do is guess: attributing a deposit to whichever skill ran most
// recently would put the strongest signal in the system behind the weakest inference in it.
import type { DomainStore } from "./domain";
import type { Invoice } from "./contract";
import { getDeliverableStore } from "./deliverables";
import { readMoneyPlan } from "./money-plan";
import { recordDeliverableVerdict } from "./skill-scales";
import { getDomainStore } from "./domain";

/** What the walk found, or how far it got. Returned rather than logged so a test can read it. */
export interface PaymentAttribution {
  /** The task whose skills earned the money, when there is one. */
  task_id?: string;
  /** Votes cast. Zero when the run read no skills. */
  votes: number;
  /** Where it stopped, when it stopped. Always set on a miss, never a fault. */
  why?: string;
}

/**
 * Credit the skills that produced the work an invoice was raised against.
 *
 * Fail-soft by construction: the caller has already taken the money, and nothing here may undo that
 * or make it look like it failed. A thrown error would turn a successful payment into a 500.
 */
export async function weighPaidInvoice(
  domain: DomainStore,
  invoice: Pick<Invoice, "id" | "project_id" | "case_id">,
): Promise<PaymentAttribution> {
  if (!invoice.project_id) return { votes: 0, why: "the invoice has no project" };
  if (!invoice.case_id) return { votes: 0, why: "the invoice is not against an engagement" };

  const kase = await domain.getCase(invoice.case_id).catch(() => undefined);
  // The tenant of the case and of the invoice must match. An invoice id is a caller's input, and a
  // vote written under the wrong project silently trains another agency's scale — the same rule
  // `noteInvoiceSettled` states about move outcomes, and it is load-bearing for the same reason.
  if (!kase || kase.project_id !== invoice.project_id) {
    return { votes: 0, why: "that engagement is not this project's" };
  }

  const plan = readMoneyPlan(kase.data);
  if (!plan) return { votes: 0, why: "the engagement has no money plan" };

  const line = plan.lines.find((l) => l.invoice_id === invoice.id);
  if (!line) return { votes: 0, why: "no money-plan line names this invoice — it was raised by hand" };
  if (!line.deliverable_id) {
    return { votes: 0, why: "that line is not against a deliverable — a deposit or a retainer, not a piece of work" };
  }

  const deliverable = await getDeliverableStore()
    .getDeliverable(invoice.project_id, line.deliverable_id)
    .catch(() => undefined);
  if (!deliverable) return { votes: 0, why: "the deliverable that line points at no longer exists" };

  const versions = await getDeliverableStore()
    .listVersions(invoice.project_id, deliverable.id)
    .catch(() => []);
  /**
   * The version the CLIENT was shown, not the newest.
   *
   * They paid for what they received. A later draft may exist — a fix started after the invoice went
   * out — and crediting its run would attribute the money to work the payer never saw. Falls back to
   * the current version only when nothing was ever released, which means the money arrived against a
   * deliverable that never reached anybody and is worth nobody's credit anyway.
   */
  const released = [...versions].reverse().find((v) => !!v.released_at);
  const version = released ?? versions.find((v) => v.version === deliverable.current_version);
  if (!version?.task_id) {
    return { votes: 0, why: "no run produced the version that was paid for — a human wrote it" };
  }
  // A version the founder rewrote is not evidence about a skill, for the same reason `/release`
  // refuses to credit one: what was paid for is not what the agent wrote.
  if (version.author === "founder") {
    return { task_id: version.task_id, votes: 0, why: "the founder wrote the version that was paid for" };
  }

  const votes = await recordDeliverableVerdict(domain, {
    project_id: invoice.project_id,
    task_id: version.task_id,
    verdict: "paid",
  });
  return { task_id: version.task_id, votes };
}

/**
 * Every path that settles an invoice passes through here, and that is the whole point of it existing.
 *
 * There are three — the manual record, the Stripe webhook, and the reconciliation sweep — and the
 * codebase has already paid for the lesson that a gather repeated at N call sites is N chances for
 * one to be forgotten (`runtime.ts` says it about mounting client materials, after a door that
 * existed and was never called). So the credit is attached to the transition itself.
 *
 * Fail-soft and `void`: the money is already taken by the time this runs, and a scoreboard that
 * cannot be written must never turn a successful payment into an error.
 */
export function creditSkillsForPayment(invoice: { id: string; project_id: string; case_id?: string }): void {
  void weighPaidInvoice(getDomainStore(), invoice).catch((e) =>
    console.error("[mycel] could not credit the skills for a settled invoice:", e),
  );
}
