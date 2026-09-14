// WHAT THIS BUSINESS SAYS IT IS — read from the shaping run the founder did in onboarding.
//
// ═══ WHY THIS IS ITS OWN MODULE ═══
//
// It lived as a private function in `gtm/routes.ts`, which meant the only code that could ask "what
// is this business called, and what does it sell" was the GTM composer.
//
// `proposal-envelope.ts` then needed the name — a contract has to name the party signing it — and
// could not reach this. It read `kit.display_name` instead, which is deliberately EMPTY for a
// project that has not configured a brand, and opened an envelope with a nameless provider. The
// client signed. The provider could not. The founder had typed "Halden Freight Recruitment" into the
// first screen of onboarding twenty minutes earlier and the contract could not see it.
//
// The shape is not stored under a pointer. It IS "the newest succeeded `draft_shape` run in this
// project" (the same definition cloud/lib/shape.ts `readShape` uses), so this reads the run rather
// than a cache that could disagree with it.
import type { Store } from "./store";
import { wedgeForRole } from "./roles";
import { getIdentityStore } from "./identity";
import { isPlaceholderName } from "./brandkit";

export interface BusinessShape {
  sells?: string;
  sells_to?: string;
  name?: string;
  /**
   * The trade this business runs, as the shaping run decided it — `runs_as.wedge`, copied character
   * for character out of the catalogue it was given.
   *
   * This is the founder's own declaration of what they do, made on the first screen of onboarding,
   * and nothing read it. `openEngagementFromSignature` had to guess which desk a signed engagement
   * belongs on, found several candidates, and correctly refused to pick — while the answer sat in
   * the same artifact as the business name.
   *
   * Only when `fit` is `direct` or `adjacent`. `none` means the catalogue does not cover this trade,
   * which is exactly when a service gets WRITTEN for them, and a wedge slug read out of a `none`
   * answer would name something that is not running.
   *
   * READ `fit` BEFORE USING THIS FOR CLIENT WORK. See the field below.
   */
  wedge?: string;
  /**
   * How the shaping run judged the match, and the distinction is not a nuance.
   *
   * `direct` — this wedge IS what the firm sells. `adjacent` — it is a trade we ship that helps the
   * firm's OWN back office, which is a completely different thing and the shaper says so in its own
   * words. Read from production on 13 September:
   *
   *     Northlight Studio  (brand identity + Webflow)  → invoice-chaser  fit=adjacent
   *         covers: "Chases YOUR overdue invoices by email and escalates on a schedule."
   *     Harbourline Studio (brand + web design)        → invoice-chaser  fit=adjacent
   *         covers: "Chases YOUR overdue project deposits by email."
   *     Web app development for food businesses        → security-questionnaire  fit=adjacent
   *         covers: "Answers client questionnaires from YOUR mounted knowledge."
   *
   * Every one of those is about the founder's own business. Four of fifteen real signups are design
   * studios that landed on `invoice-chaser` this way. Treating that as the DELIVERY service would
   * open an engagement in a design client's name on invoice chasing and send them intake questions
   * about it — and since the engagement sweep now does this on a clock, at scale, quietly.
   */
  fit?: "direct" | "adjacent";
}

/**
 * Anything unreadable comes back `{}` rather than throwing.
 *
 * A missing shape means a founder can still draft from the campaign audience alone, whereas a throw
 * here takes down whichever surface asked — and the surfaces that ask are a compose button, an
 * outreach draft and a contract. None of them should 500 because a shaping run is missing.
 */
export async function readBusinessShape(store: Store, projectId: string): Promise<BusinessShape> {
  try {
    const shaper = wedgeForRole("business_shaping");
    if (!shaper) return {};
    const tasks = (await store.listTasks({ wedge: shaper, limit: 200 }))
      .filter((t) => t.project_id === projectId && t.task_type === "draft_shape" && t.status === "succeeded")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!tasks.length) return {};
    const arts = (await store.listArtifacts(tasks[0].id))
      .filter((a) => a.name === "result.txt")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!arts.length) return {};
    const full = await store.getArtifact(arts[0].id);
    let raw = full?.content ?? "";
    if (!raw) {
      const { getArtifactBackend } = await import("./artifacts");
      raw = (await (await getArtifactBackend()).get(arts[0].id)) ?? "";
    }
    if (!raw) return {};
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const parsed = JSON.parse((fenced?.[1] ?? raw).trim()) as Record<string, unknown>;
    // `[mock]` output is a canned run, not an answer. A mock business name on a real contract would
    // be the placeholder problem again, one layer further in.
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() && !v.startsWith("[mock]") ? v.trim() : undefined;
    const runs = (parsed.runs_as ?? {}) as Record<string, unknown>;
    const fit = str(runs.fit);
    return {
      sells: str(parsed.sells),
      sells_to: str(parsed.sells_to),
      name: str(parsed.name),
      wedge: fit === "direct" || fit === "adjacent" ? str(runs.wedge) : undefined,
      fit: fit === "direct" || fit === "adjacent" ? fit : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * ═══ WHAT THIS BUSINESS IS CALLED, RESOLVED ONCE ═══
 *
 * Three surfaces need a business's name and all three were resolving it differently:
 *
 *   · A CONTRACT read `kit.display_name` and, finding it empty, opened an envelope with a nameless
 *     provider — a document the client could sign and nobody could countersign.
 *   · THE CLIENT PORTAL read the same field and fell back to the literal words "Your account", so a
 *     real client was greeted with "Answer below and Your account keeps moving."
 *   · DOCUMENTS render an empty masthead, which is the right answer for a document and only there.
 *
 * All three were reasonable in isolation and all three skipped the same step: the founder ALREADY
 * SAID what their business is called, on the first screen of onboarding, and it has been sitting in
 * a `draft_shape` artifact ever since.
 *
 * The order is most-deliberate first. The brand kit is a field somebody filled in specifically for
 * documents. The shape is what they typed when asked. The project name is allocated at signup and
 * guarded by `isPlaceholderName`, because the bootstrap "default" must never reach a client or a
 * contract as a party.
 *
 * Returns "" rather than a placeholder — a caller with nothing has to decide what to do about it,
 * and those decisions genuinely differ: a contract must REFUSE (see proposal-envelope.ts), a portal
 * must show something rather than a blank heading, a document draws nothing at all. Inventing a
 * default here would take that decision away from all three.
 */
export async function businessDisplayName(
  store: Store,
  projectId: string,
  kitName?: string,
): Promise<string> {
  const fromKit = (kitName ?? "").trim();
  if (fromKit) return fromKit;
  const shaped = (await readBusinessShape(store, projectId).catch(() => ({}) as BusinessShape)).name?.trim();
  if (shaped) return shaped;
  const project = getIdentityStore().getProject(projectId);
  return isPlaceholderName(project?.name) ? "" : (project?.name ?? "").trim();
}
