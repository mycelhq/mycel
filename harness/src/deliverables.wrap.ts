// After a fulfillment run succeeds, the work has to become a Deliverable — not stay an artifact
// keyed to a task id that the founder never opens and the client can never see.
//
// ═══ THE GAP THIS CLOSES ═══
//
// `runTask` writes `result.txt`, the run goes green, and there it stopped. Deliverables already
// exist as a noun (portal, versions, founder gate, accept → invoice). Almost nothing created one.
// Kickoff does not start production work. So Deliverables stayed empty on a business that was
// doing the work, which is the most expensive empty screen in the product: the founder thinks
// nothing shipped, the client has nothing to accept, and accepted work never becomes an invoice.
//
// ═══ WHAT THIS WILL NOT WRAP ═══
//
// Chase, nudge, GTM, clock ticks, shaping — either they declare no `fulfillment.deliverable_shapes`,
// or they share a wedge that does (books-keeper chase_receipts) and are skipped by task type.
// A mock run (`MYCEL_RUNTIME=mock`) is the caller's to skip — `[mock]` strings are not a delivery.
// A run with no case or no client cannot be billed or shown, so it is refused here the same way
// the founder-plane route refuses it.
import { loadProjectWedge } from "./authored";
import { clipToBoundary } from "./client-ready";
import type { Deliverable, Task, DeliverableVersion } from "./contract";
import { getDeliverableStore } from "./deliverables";
import { getDomainStore } from "./domain";
import { fulfillmentOf } from "./kickoff";
import { isLivePageUrl, looksLikeHtmlPage } from "./pages";

export { looksLikeHtmlPage };

/** Task types that speak to a client but are not a piece of work they review. */
const OPERATIONAL_TASK =
  /^(chase_|nudge_|check_in|send_receipt|daily_sync|outreach_|propose_|find_prospects|advance_)/;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ONE QUESTION: DOES THIS TASK TYPE PRODUCE WORK A CLIENT RECEIVES?
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Exported so the ignition sweep and this wrapper share ONE definition — the sweep must never pick
 * an operational type as the thing to produce, for the same reason the wrapper never turns one into
 * a deliverable. That was the original note, and it was half the problem.
 *
 * THERE WERE THREE VOCABULARIES FOR THIS, each read by a different module:
 *
 *   · this name-prefix regex           — `deliverables.wrap`, `fulfillment-ignite`
 *   · `internal: true`                 — `deliverable-grade`
 *   · `client_facing: false`           — `delivery-precondition`
 *
 * So three modules gave three answers about the same task type. `geo-monitor/probe_surface` is the
 * measured case: it declares `internal: true`, it is one measurement that feeds `weekly_report`, and
 * because THIS function saw only the name it came all the way to the client-ready gate and put "not
 * delivered — the summary is written for an operator, not a client" on a founder's timeline. The
 * wedge had already said so. Nobody asked it.
 *
 * `deliverable_verdict` is the same shape from the other direction: the SPINE declares
 * `client_facing: false` on it, and the wrapper wrapped it anyway.
 *
 * So the predicate takes the spec and reads all three. A declaration beats a name — a prefix is a
 * guess about what an author meant, a flag is the author saying it. The regex stays for the types
 * that declare nothing.
 *
 * `spec` is optional so the ignition sweep, which has only a name at the point it asks, keeps
 * working exactly as before.
 */
export function isOperationalTaskType(
  taskType: string,
  spec?: { internal?: unknown; client_facing?: unknown } | null,
): boolean {
  if (spec?.internal === true) return true;
  if (spec?.client_facing === false) return true;
  return OPERATIONAL_TASK.test(taskType);
}

/**
 * The run's own output object, which is never a deliverable file.
 *
 * `result.txt` is how `runtime.ts` records what the agent returned. It is the input to a rendered
 * document and to the client-ready check; it is not a thing a customer opens. Matched by name
 * because that is what the writer uses, and kept here next to the only consumer that has to exclude
 * it.
 */
export const RUN_OUTPUT = /^result\.(txt|json)$/i;

/** A client-facing page filename from the run's slug. Never `result.html`. */
export function htmlPageFilename(slug?: string): string {
  const s = (slug ?? "page")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${s || "page"}.html`;
}

/**
 * The run's own files, ONE PER NAME, latest wins.
 *
 * A close called its figures workflow twice — once to compute, once after revising a category — and
 * the client received two identical spreadsheets in the same envelope. Nothing was wrong with
 * either; there were simply two, which reads as carelessness and leaves the reader wondering which
 * one is current.
 *
 * Deduped here rather than at the point of writing, because a rewrite is a legitimate thing for a
 * run to do and the second version is the better one. What a client must never receive is both.
 * `result.txt` is excluded throughout: that is the machine's output object and handing it over is
 * the leak `file_set` was fixed for.
 */
function authoredIds(all: { id: string; name: string }[]): string[] {
  const byName = new Map<string, string>();
  for (const a of all) {
    if (RUN_OUTPUT.test(a.name)) continue;
    byName.set(a.name, a.id); // Later wins: `listArtifacts` returns them in the order they were written.
  }
  return [...byName.values()];
}

export async function wrapFulfillmentDeliverable(args: {
  task: Task;
  artifactId: string;
  summary: string;
  /** The run's full text output — rendered into a branded PDF for a `document` deliverable. */
  content?: string;
  /**
   * Turn the run's markdown into a branded document artifact, returning its id. Injected by the
   * caller because rendering needs the main store, the project's brand kit and the artifact backend,
   * none of which this wrapper reaches. Absent (or returning undefined) keeps the plain-text
   * artifact, so a document deliverable is never blocked on a render.
   */
  renderDocument?: (a: { task: Task; content: string; title: string }) => Promise<string | undefined>;
  /**
   * Every artifact this run wrote, for a `file_set` delivery. Injected for the same reason as
   * `renderDocument`: the artifact backend is not reachable from this module, and importing it
   * would make the wrapper untestable without a database.
   */
  listArtifacts?: (taskId: string) => Promise<{ id: string; name: string }[]>;
  /**
   * A publishable page the run put in its output (`html`), written as an artifact so a `file_set`
   * can ship it. Decide-shaped runs have no workspace, so the page would otherwise die inside
   * `result.txt`. Injected for the same reason as `renderDocument`.
   */
  writePage?: (a: { task: Task; name: string; html: string }) => Promise<string | undefined>;
  /**
   * THE INDEPENDENT READ, on the path that actually delivers.
   *
   * Injected rather than imported for the same reason as `renderDocument`: this module has to stay
   * testable without a model, a database or an org. Absent means no review ran — which is treated
   * below as "not gradeable", and a deliverable that could not be graded is never auto-released.
   */
  review?: (a: {
    artifactIds: readonly string[];
    kind: string;
    summary: string;
  }) => Promise<DeliverableVersion["review"] | undefined>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * ONE CHANCE TO FIX WHAT THE INDEPENDENT READER FOUND
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * The reviewer already reads the finished bytes and names disqualifying faults — an invented
   * figure, or an artefact that is not the thing that was promised. Measured on a real deliverable:
   * handed a well-formed configuration note instead of the weekly digest it was asked for, it
   * scored the artefact 0 and said so in a sentence anybody could act on.
   *
   * And then nothing acted on it. The run was over, the sandbox still alive for another few lines,
   * and the only outcome was a hold — a founder opening a job that needs rewriting, with the rewrite
   * note already written by a machine that could not do anything with it.
   *
   * This hands that sentence back to the run. Supplied by the orchestrator, which is the only thing
   * holding a sandbox; absent everywhere else, and absent means the behaviour before this existed.
   *
   * ── WHY THIS CANNOT MAKE A GOOD DELIVERY WORSE ──
   *
   * It is only ever called when the verdict names something DISQUALIFYING, which is exactly the
   * condition that was about to hold the work for a person. Nothing that would have auto-released
   * enters this branch. The worst case is a repair that is no better and a hold that happens anyway,
   * one model pass later — and the best case is the founder never has to open it.
   *
   * ── ONE ROUND ──
   *
   * The same rule the schema retry follows next door: a model that fails twice with the reason in
   * front of it does not know the answer, and a second round buys a longer wait for the same hold.
   */
  repair?: (a: {
    artifactIds: readonly string[];
    /** The reviewer's own words. Handed over verbatim — a paraphrase is a different instruction. */
    faults: readonly string[];
    headline?: string;
  }) => Promise<readonly string[] | undefined>;
  /** The run's `html` field — a full document, not a fragment. */
  pageHtml?: string;
  /** Becomes the artifact filename. */
  pageSlug?: string;
  /**
   * For a `link` deliverable: the https URL the client opens. A staging site, or a page we already
   * hosted. Absent means wrap will try `publishPage` from `pageHtml`. Still absent after that is
   * not a delivery — we refuse rather than shipping an iframe of a file.
   */
  pageUrl?: string;
  /**
   * Host the authored HTML at an unlisted public URL. Injected so wrap stays testable without
   * the page store. Returning undefined (or a URL that is not live) fails closed: no file_set
   * fallback, no sandboxed preview as the product.
   */
  publishPage?: (a: { html: string; title?: string; slug?: string }) => Promise<{ url: string } | undefined>;
  /** Overrides the case title on the deliverable card — a page title, a site name. */
  title?: string;
  /** Has this wedge/client pairing earned release without a human? Absent means no. */
  autoRelease?: (a: { project_id: string; client_id: string; wedge: string }) => Promise<boolean>;
  /** Actually release it, stamp it as unreviewed, and note it on the engagement. */
  release?: (a: { deliverable_id: string; version: number }) => Promise<void>;
  /**
   * ═══ WHY NOTHING SHIPPED, SAID OUT LOUD ═══
   *
   * Eight paths in this function returned `undefined`, and the caller emitted nothing when they did.
   * A close ran for five minutes, reconciled sixteen transactions, cleared every gate, was judged
   * `deliver` — and the founder's timeline ended on "fixed — the second answer clears the contract"
   * with no deliverable and no explanation anywhere. The case had no `client_id`, so line one bailed.
   *
   * A verdict of `deliver` followed by silence is the failure this repo keeps rediscovering under
   * different names: succeeding loudly and failing quietly. Every bail-out now says which one it
   * was, in a sentence the founder can act on.
   */
  onSkip?: (reason: string) => Promise<void>;
}): Promise<Deliverable | undefined> {
  const { task, artifactId, summary, content, renderDocument, listArtifacts } = args;
  const skip = async (reason: string): Promise<undefined> => {
    await args.onSkip?.(reason);
    return undefined;
  };
  const projectId = task.project_id;
  if (!projectId) return skip("this run belongs to no project, so there is nobody to deliver it to");
  if (!task.case_id) {
    return skip("this run is not attached to an engagement, so there is nothing to deliver it against");
  }

  // Chases, nudges, check-ins and receipts are operational — wrapping them as something the client
  // must "accept" fills Deliverables with mail the founder already sent and never becomes an invoice.
  // Checked on the NAME first so the common case costs no manifest read; the spec-aware check below
  // catches the ones that declare it instead of spelling it.
  if (OPERATIONAL_TASK.test(task.task_type)) return undefined;

  const loaded = await loadProjectWedge(projectId, task.wedge).catch(() => null);

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * A TASK TYPE THAT SAYS IT IS INTERNAL IS INTERNAL
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `internal: true` already exists on the manifest and `deliverable-grade.ts` already honours it —
   * `clientFacing()` there reads `spec.internal || isOperationalTaskType(name)`. This function read
   * only the name prefix, so the two consumers of "is this operational" disagreed, which is exactly
   * the drift the export comment above `isOperationalTaskType` was written to prevent.
   *
   * `geo-monitor/probe_surface` is the measured case: it declares `internal: true`, it is a single
   * measurement that feeds `weekly_report`, and every run of it came here, failed the client-ready
   * gate and put "not delivered — the summary is written for an operator, not a client" on a
   * founder's timeline. The wedge had already said so and nobody asked.
   *
   * The prefix regex stays, because it covers types that never declared anything. Declaration wins
   * where it exists, which is the right precedence: a name is a guess, a flag is an author's
   * statement.
   */
  if (isOperationalTaskType(task.task_type, loaded?.manifest.task_types?.[task.task_type])) {
    return skip("this task type is internal — it feeds other work rather than going to a client");
  }

  const spec = fulfillmentOf(task.wedge, loaded?.manifest);
  const declaredKind = loaded?.manifest.task_types?.[task.task_type]?.deliverable_kind;
  let pageUrl = (args.pageUrl ?? "").trim();
  let linkReady = isLivePageUrl(pageUrl);
  const kind =
    declaredKind === "document" || declaredKind === "file_set" || declaredKind === "link"
      ? declaredKind
      : linkReady && spec?.deliverable_shapes?.includes("link")
        ? "link"
        : spec?.deliverable_shapes?.find((s) => s === "document" || s === "file_set");
  if (!kind) {
    return skip(
      `"${task.wedge}" does not say what a "${task.task_type}" hands over — declare ` +
        `\`deliverable_kind\` on the task type, or \`fulfillment.deliverable_shapes\` on the wedge`,
    );
  }

  const kase = await getDomainStore().getCase(task.case_id);
  if (!kase) return skip("the engagement this run belongs to no longer exists");
  if (!kase.client_id) {
    return skip(
      `the engagement "${kase.title}" has no client on it, so this work has nobody to go to — ` +
        `set a client on the engagement and the next run delivers`,
    );
  }
  if (kase.project_id && kase.project_id !== projectId) {
    return skip("the engagement belongs to a different project than the run — nothing delivered");
  }
  const clientId = task.client_id || kase.client_id;

  const store = getDeliverableStore();
  /**
   * ═══ ALREADY DELIVERED BY THE RUN ITSELF — BUT ONLY IF IT ACTUALLY DELIVERED SOMETHING ═══
   *
   * A run may submit its own deliverable (see the deliverables block in AGENTS.md), and when it has,
   * wrapping again would give the client the same work twice. So a deliverable already carrying a
   * version from this task is returned as-is.
   *
   * Unconditionally, it was also the way to lose the work entirely. An agent brute-forcing the
   * submit API — twenty-five calls, because the prompt documented a two-step flow the route refuses
   * — eventually found that `link` is the only kind a bare create can satisfy, and posted
   * `{"kind":"link"}` with a loopback URL. Empty title-only deliverable, no covering note, no files.
   * This check then found a version with the task's id and handed it straight back, so the properly
   * assembled document the wrapper was about to build was never built. The client scored it 1 out of
   * 10: "they have sent me a title rather than a monthly bookkeeping close."
   *
   * An EMPTY version is not a delivery. No files and no summary means the run reached the API and
   * not the client, and the right response is to build the real one rather than to honour the
   * artifact of a failed attempt. A version with either is the run's own considered work and stands.
   */
  const open = await store.listDeliverables({ project_id: projectId, case_id: kase.id, open: true });
  for (const d of open) {
    const versions = await store.listVersions(projectId, d.id);
    const own = versions.filter((v) => v.task_id === task.id);
    if (!own.length) continue;
    if (own.some((v) => (v.artifact_ids?.length ?? 0) > 0 || (v.summary ?? "").trim())) return d;
    await args.onSkip?.(
      `this run submitted an empty "${d.kind}" deliverable with no files and no note — ` +
        `assembling the delivery from its own work instead`,
    );
  }

  /**
   * A `link` is a place the client opens, not a file the inspector iframes.
   *
   * GEO `ship_page` used to wrap as `file_set` so the portal could `srcdoc` the HTML. That is a
   * preview of the work, and it is the thing a sales meeting cannot demo on a phone. If we cannot
   * put the page at a live URL, this is not a delivery — we do not fall back to the file.
   */
  if (kind === "link" && !linkReady) {
    const html = args.pageHtml?.trim() ?? "";
    if (looksLikeHtmlPage(html) && args.publishPage) {
      const published = await args
        .publishPage({ html, title: args.title, slug: args.pageSlug })
        .catch(() => undefined);
      const hosted = (published?.url ?? "").trim();
      if (isLivePageUrl(hosted)) {
        pageUrl = hosted;
        linkReady = true;
      }
    }
  }
  if (kind === "link" && !linkReady) {
    return skip("this delivers a live link and the page was never published — nothing to hand over");
  }

  const at = new Date().toISOString();
  /**
   * THE THIRD CAP, and the one that was actually cutting.
   *
   * `MAX_BODY` in client-ready and a `.slice(0, 2_000)` in the orchestrator were both fixed to cut on
   * a boundary; the note still reached a client ending "…confirm and I". Three places truncated the
   * same string and this was the tightest, so fixing the other two changed nothing a client could
   * see. One helper now, in all three, because a limit that only some callers respect properly is a
   * limit that will be got wrong again by whoever adds the fourth.
   */
  const note = clipToBoundary(summary || "First version from this run.", 4_000);
  const title = (args.title?.trim() || kase.title || "Work ready for review").slice(0, 200);

  // The document half of the top-20: a `document` deliverable ships as a branded PDF, not the raw
  // `result.txt` the run wrote. Only `document` (exactly one artifact) is rendered — a `file_set` is
  // several files the run authored on purpose, and reducing them to one PDF would be lossy. A failed
  // render falls back to the plain-text artifact, because a document a client can read beats a
  // delivery blocked on a renderer.
  let delivered: string[] = kind === "link" ? [] : [artifactId];
  if (kind === "document" && content && renderDocument) {
    const rendered = await renderDocument({ task, content, title }).catch(() => undefined);
    if (rendered) delivered = [rendered];

    /**
     * ═══ THE COVERING NOTE IS NOT THE WORK ═══
     *
     * A `document` shipped the rendered PDF and nothing else. The August close wrote
     * `august-2026-reconciled-ledger.csv` and `august-2026-vat-working-paper.md` to `./output/`,
     * exactly as the `deliver` shape instructs, and the client received a one-paragraph summary of
     * them. The working papers were discarded on the way out.
     *
     * That is the complaint a client scored 3/10, arriving one layer lower than where it was fixed:
     * the runtime tells the run to write real files, `ship_requires` holds it if it names none, and
     * then the wrapper threw them away. A service business does not sell a note about reconciled
     * books; the note is what you read first and the ledger is what you paid for.
     *
     * The PDF stays FIRST — it is the thing they open — and the authored files ride with it. The
     * run's own `result.txt` never does: that is the machine's output object, and handing it over is
     * the leak `file_set` was fixed for. Deduped because the render above is itself an artifact of
     * this task and would otherwise come back in the list twice.
     */
    if (listArtifacts) {
      const all = await listArtifacts(task.id).catch(() => []);
      delivered = [...new Set([...delivered, ...authoredIds(all)])].slice(0, 50);
    }
  }

  /**
   * A `file_set` ships THE FILES THE RUN AUTHORED, and never `result.txt`.
   *
   * The comment above always said a file_set is "several files the run authored on purpose" — and
   * the code attached exactly one artifact, the run's own `result.txt`, which is the machine's
   * output object and the very thing a client must not be handed. So the shape was wrong in both
   * directions at once: it shipped the one file that should never go, and none of the ones that
   * should.
   *
   * It never fired in production because every wedge declaring `file_set` also declared `document`
   * first and `find` took the earlier match. That is luck, not design. A task type that declares
   * `deliverable_kind: file_set` is the first that is supposed to fire, and handing the JSON blob
   * would be the same customer-facing leak.
   *
   * Decide-shaped runs have no workspace, so a page authored as `html` in the output never becomes
   * a file unless we write it here. After that write, `listArtifacts` must see at least one
   * non-result file or this is not a delivery — we refuse rather than fall back to `result.txt`.
   */
  if (kind === "file_set") {
    const html = args.pageHtml?.trim() ?? "";
    if (html && looksLikeHtmlPage(html) && args.writePage) {
      await args
        .writePage({ task, name: htmlPageFilename(args.pageSlug), html })
        .catch(() => undefined);
    }
    if (!listArtifacts) return skip("this delivers a set of files and the run's files could not be read");
    const all = await listArtifacts(task.id).catch(() => []);
    const authored = authoredIds(all);
    if (!authored.length) {
      return skip("this delivers a set of files and the run wrote none — there is nothing in the folder");
    }
    delivered = authored.slice(0, 50);
  }

  const target =
    open.find(
      (d) =>
        d.kind === kind && (d.status === "changes_requested" || d.status === "drafting"),
    ) ??
    (await store.createDeliverable({
      project_id: projectId,
      case_id: kase.id,
      client_id: clientId,
      title,
      kind,
    }));

  /**
   * EARN THE RIGHT TO SKIP THE REVIEW, OR DO NOT.
   *
   * Called here rather than on the founder's release route, because this is the moment the work
   * becomes releasable and the founder is not present. The route stays exactly as it was — a human
   * pressing release is still a human pressing release; this is the path where nobody does.
   *
   * Fail-soft in the GATED direction. A record that cannot be read, a policy that cannot be
   * resolved, a database that blips — every one of those ends with the work waiting for a person,
   * which is the outcome that was already correct before this feature existed.
   */
  /**
   * ═══ THE SECOND READER, ON THE PATH THAT DELIVERS ═══
   *
   * This ran only on the HTTP submit route. The orchestrator finishes a run, decides `deliver`, and
   * arrives here — so the primary path by which work becomes a client deliverable was never graded
   * by anything, and `autoRelease` below could then hand it to a client with no human in the loop.
   * The product's central claim was true of the path an agent chose to take and false of the one it
   * takes by default.
   *
   * FAIL-SOFT FOR THE SUBMIT. The work is already written; a grader having a bad minute must never
   * be able to lose it. An undefined verdict submits exactly as before, with `reviewed: false` and
   * the reason on the version, and the founder reads it themselves — which is the outcome that was
   * already correct before any of this existed.
   */
  const readBack = async (ids: readonly string[]) =>
    args.review ? await args.review({ artifactIds: ids, kind, summary: note }).catch(() => undefined) : undefined;

  let review = await readBack(delivered);

  /**
   * THE REPAIR ROUND. See the `repair` parameter for why this is safe and why it is only one.
   *
   * Entered only on a verdict that REVIEWED successfully and named something disqualifying. An
   * unreachable reviewer is not a fault in the work and must not trigger a rewrite — that path
   * already holds the work unread, which is the correct answer to "we could not check it".
   */
  const serious = review?.reviewed ? (review.verdict?.serious ?? []) : [];
  if (args.repair && serious.length > 0) {
    const faults = serious.map((f) => (typeof f === "string" ? f : String((f as { note?: string }).note ?? f)));
    await args.onSkip?.(
      `a reader that did not write this found ${faults.length} disqualifying ${faults.length === 1 ? "problem" : "problems"} — trying once more before it comes to you`,
    );
    const repaired = await args.repair({ artifactIds: delivered, faults, headline: review?.verdict?.headline }).catch(() => undefined);
    if (repaired?.length) {
      const second = await readBack(repaired);
      /**
       * KEEP THE REPAIR ONLY IF IT IS ACTUALLY BETTER.
       *
       * A rewrite that introduced a NEW disqualifying fault is worse than the original, and
       * "it ran again" is not evidence of improvement — the same reasoning `a-guard-can-run-and-do-
       * nothing` records elsewhere in this repo. Fewer serious faults, or none, or the comparison
       * is refused and the first version stands.
       */
      const before = serious.length;
      const after = second?.reviewed ? (second.verdict?.serious ?? []).length : Number.POSITIVE_INFINITY;
      if (after < before) {
        delivered = [...repaired];
        review = second;
      }
    }
  }

  /**
   * FAIL-CLOSED FOR THE RELEASE, and the asymmetry is the whole point.
   *
   * Submitting unreviewed work parks it in front of a founder. AUTO-RELEASING unreviewed work sends
   * it to a paying client with nobody having read it — the single worst thing this path can do. So
   * a standing permission buys the founder's absence, not the reviewer's: no verdict, or a verdict
   * naming anything disqualifying, and the work waits for a person.
   *
   * `serious` is the reviewer's own word for disqualifying — an invented figure, or an artefact that
   * is not the thing that was promised. Exactly the two faults a client notices immediately and a
   * founder never recovers from having sent.
   */
  const gradeAllows = !!review?.reviewed && (review.verdict?.serious?.length ?? 0) === 0;
  const autoRelease =
    args.autoRelease && gradeAllows
      ? await args
          .autoRelease({ project_id: projectId, client_id: clientId, wedge: task.wedge })
          .catch(() => false)
      : false;
  if (args.autoRelease && !gradeAllows) {
    await args.onSkip?.(
      review?.reviewed
        ? `held for you — a reader that did not write this found ${review.verdict?.serious?.length} disqualifying ${
            (review.verdict?.serious?.length ?? 0) === 1 ? "problem" : "problems"
          }: ${review.verdict?.headline ?? "see the version"}`
        : `held for you — this could not be independently reviewed${review?.because ? ` (${review.because})` : ""}, so it is not going out unread`,
    );
  }

  const result = await store.submitVersion({
    project_id: projectId,
    deliverable_id: target.id,
    allowedFrom: ["drafting", "changes_requested"],
    version: {
      summary: note,
      artifact_ids: delivered,
      task_id: task.id,
      ...(review ? { review } : {}),
      ...(kind === "link" ? { url: pageUrl } : {}),
    },
    at,
  });
  const settled = result?.deliverable ?? target;
  if (autoRelease && result && args.release) {
    // Released, stamped, and SAID OUT LOUD on the engagement. A founder discovering months later
    // that work has been going out unreviewed is the way to lose their trust permanently, even if
    // every single one was right.
    await args.release({ deliverable_id: settled.id, version: result.version.version }).catch(() => {});
  }
  return settled;
}
