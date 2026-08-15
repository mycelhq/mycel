// The service-surface store: clients, connections, channels, threads, messages. This is the CRM +
// comms layer that turns the task engine into a service business — who the work is for, where it
// comes from and goes, and the external capabilities behind it.
//
// v0.1 ships an in-memory reference implementation (zero setup). Postgres backing mirrors the
// task tables and is the next step; the task engine itself is already durable (store.pg.ts).
import { databaseUrl } from "./config";
import { randomUUID } from "node:crypto";
import type { KnowledgeGap } from "./intake";
import type { Case, CaseEvent, CaseWait, Channel, Deployment, Record_, Client, Connection, KnowledgeItem, Message, Schedule, Thread, TriggerSub, WaitCondition, WaitPart, WaitStatus } from "./contract";

/**
 * Filter for `listDeployments`.
 *
 * `project_id` is REQUIRED here, and that shape has now been copied onto `RecordQuery`,
 * `CaseFilter` and `InvoiceFilter` (billing.ts) rather than left as this table's exception.
 * Optionality had to be defended by a fail-closed check in two separate backends per table to stay
 * safe; a required argument cannot be forgotten at a call site, so those checks become a second
 * belt rather than the only one. The cross-tenant leak this codebase already had (see
 * `listKnowledge` below) got in through exactly that kind of optional filter.
 */
export interface DeploymentQuery {
  project_id: string;
  status?: Deployment["status"];
  limit?: number;
}

/** Shared shape for the record read paths so the tenant filter can't be added to one and not the other. */
export interface RecordQuery {
  /**
   * Tenant scope. REQUIRED, and it still fails closed inside both backends — see `queryRecords`.
   * There is no operator-wide record read: the only caller that wanted one (`GET /v1/records`)
   * post-filtered instead, and a `limit` on a post-filtered read returns another tenant's rows.
   * Making this required is what removes the option of writing that bug again.
   */
  project_id: string;
  wedge?: string;
  collection?: string;
  case_id?: string;
  where?: Record<string, unknown>;
  /** Inclusive lower bound on `observed_at` (ISO). Point-in-time rows (no observation) never match. */
  observed_from?: string;
  /** Inclusive upper bound on `observed_at` (ISO). */
  observed_to?: string;
  /**
   * When true, keep only the newest observation per `key` within the filter.
   * Meaningless without a time range or a collection that uses `observed_at`.
   */
  latest_per_key?: boolean;
}

/**
 * What `createWait` is given. `parts` is absent because a wait is born with no progress, and
 * `status` because a wait is born `waiting` — both are the store's to set, not a caller's.
 */
export type NewWait = Omit<
  CaseWait,
  "id" | "created_at" | "updated_at" | "nudge_count" | "rearm_count" | "status" | "parts"
> & { nudge_count?: number };

/** Filter for `listWaits`. `project_id` is the REQUIRED tenant scope and fails closed. */
export interface WaitFilter {
  project_id: string;
  case_id?: string;
  status?: CaseWait["status"];
  /** Only waits whose `nudge_at` or `expires_at` is at or before this instant. Used by the sweep. */
  limit?: number;
}

/** Filter for `listCases`. `project_id` is the REQUIRED tenant scope and fails closed (see `listCases`). */
export interface CaseFilter {
  project_id: string;
  wedge?: string;
  status?: Case["status"];
  client_id?: string;
  stage?: string;
}

/**
 * One atomic increment of a connection's pacing bookkeeping (`config.pacing`).
 *
 * Deliberately dumb: it carries pre-computed instants rather than a policy, so the store does
 * arithmetic and pacing.ts keeps the judgment about how long a window is. The store must never
 * decide what a week means.
 */
export interface PacingBump {
  /** The touch counter to increment. Omit for an engagement-only bump (a reply, an acceptance). */
  kind?: string;
  /** When this happened. */
  at: string;
  /** Reset the counter to zero first if its window started at or before this instant. */
  windowResetBefore?: string;
  /** The window start to stamp when a reset happens. */
  windowStart?: string;
  /** Added to the engagement counters. */
  engagement?: { sent?: number; accepted?: number; replied?: number; flagged?: number };
}

/**
 * The keys inside `Case.data` that `claimCaseMarker` is allowed to stamp.
 *
 * A CLOSED UNION rather than a string, and the closure is the safety property. `Case.data` is a free
 * jsonb bag that the sequencer, the campaign machinery and the enrichment path all read from —
 * `campaign_id`, `profile_id`, `last_touch_at`, `thread`. A claim primitive taking an arbitrary key
 * would let a caller atomically overwrite any of them with a timestamp, and the symptom would be a
 * prospect whose campaign vanished, three modules away from the line that did it.
 *
 *   · `last_checked_in_at` — one status update per engagement per cooldown. See checkin.ts.
 *   · `last_taken_touch_at` — one HAND-TAKEN outreach touch per short window, so a double click and
 *     an overlapping sequencer tick cannot both dispatch. See `startNextTouch` in gtm/sequence.ts.
 *     Deliberately NOT `last_touch_at`, which means "when a message actually went out" and is what
 *     `noteReplyToTouch` attributes replies to — merging the two would credit a click with a reply.
 *   · `fulfillment_ignited_at` — one production run started per engagement per sweep interval, so two
 *     replicas ticking the ignition sweep in the same second cannot both spawn the work. See
 *     `sweepFulfillmentIgnition` in fulfillment-ignite.ts.
 */
export type CaseClaimMarker =
  | "last_checked_in_at"
  | "last_taken_touch_at"
  | "fulfillment_ignited_at";

export interface DomainStore {
  // connections (secrets referenced, never stored in the clear here)
  createConnection(c: Omit<Connection, "id" | "created_at">): Promise<Connection>;
  getConnection(id: string): Promise<Connection | undefined>;
  listConnections(): Promise<Connection[]>;
  /** Patch a connection's non-secret fields. Used to record a broker's connected-account id. */
  updateConnection(
    id: string,
    patch: Partial<Pick<Connection, "name" | "config" | "secret_ref">>,
  ): Promise<Connection | undefined>;
  /**
   * Remove the row. LinkedIn disconnect uses this so a Find-plan session slot is actually freed —
   * clearing the vault and leaving the row counted as a session forever, which is how reconnect
   * 402'd after the first connect.
   */
  deleteConnection(id: string): Promise<boolean>;
  /**
   * ATOMICALLY increment the pacing counters on a connection.
   *
   * THE GUARANTEE: concurrent bumps for the same connection never lose an increment. `updateConnection`
   * cannot promise that — it reads the row into JS, merges, and writes back, so two workers that
   * read `used.message = 7` both write 8 and one real send becomes invisible to the safety check
   * that is supposed to keep the account alive. On Postgres this is one statement whose SET
   * expression reads the row's own current value (`… + 1`), which READ COMMITTED re-evaluates
   * against the winning row version after the row lock is released — the same reason
   * `UPDATE t SET n = n + 1` is safe. In memory it is a read-and-write with no `await` between the
   * two, which the single-threaded event loop makes indivisible.
   *
   * Returns the updated connection so a caller can see the new totals without a second read.
   */
  bumpPacing(connectionId: string, bump: PacingBump): Promise<Connection | undefined>;
  /**
   * ATOMICALLY claim the right to run one periodic READ against this connection's session.
   *
   * Returns true to EXACTLY ONE caller per window and false to every other, then arms the next
   * window at `nextAtIso`. It is `claimDueSchedules` for a connection rather than a schedule, and it
   * exists for the same reason: with N replicas, "check a timestamp, then do the thing" is two
   * statements, and both replicas pass the check before either one writes.
   *
   * Two properties this has that `updateConnection` cannot give it:
   *   · IT MERGES. `updateConnection` writes the whole `config` jsonb from a value the caller read
   *     moments earlier, so a poll cursor written from a stale read silently erases whatever
   *     `bumpPacing` incremented in between — the pacing counter, written by the send path,
   *     disappearing because a READ happened. Only the single `polling.<kind>` key is touched here.
   *   · IT IS CONDITIONAL. The claim succeeds only if the previous window has actually elapsed.
   *
   * The next window is armed BEFORE the poll runs, never after: a poll that throws must cost one
   * skipped cycle, not an unbounded retry loop against LinkedIn.
   */
  claimPoll(connectionId: string, kind: string, nowIso: string, nextAtIso: string): Promise<boolean>;

  // trigger subscriptions (reactive counterpart to schedules)
  createTriggerSub(t: Omit<TriggerSub, "id" | "created_at" | "updated_at">): Promise<TriggerSub>;
  getTriggerSub(id: string): Promise<TriggerSub | undefined>;
  listTriggerSubs(): Promise<TriggerSub[]>;
  /**
   * Find the subscription a delivery belongs to. Composio's `trigger_id` is the only field on a
   * webhook that we minted ourselves, so it is the only one allowed to decide routing; the
   * (connection, slug) fallback exists because a legacy V2 envelope may omit it.
   */
  findTriggerSub(q: { trigger_id?: string; connection_id?: string; trigger_slug?: string }): Promise<TriggerSub | undefined>;
  updateTriggerSub(
    id: string,
    patch: Partial<Pick<TriggerSub, "enabled" | "trigger_id" | "wedge" | "task_type" | "config" | "last_event_at" | "last_task_id">>,
  ): Promise<TriggerSub | undefined>;
  deleteTriggerSub(id: string): Promise<boolean>;

  // channels
  createChannel(c: Omit<Channel, "id" | "created_at">): Promise<Channel>;
  getChannel(id: string): Promise<Channel | undefined>;
  listChannels(): Promise<Channel[]>;

  // clients
  createClient(c: Omit<Client, "id" | "created_at" | "updated_at">): Promise<Client>;
  getClient(id: string): Promise<Client | undefined>;
  listClients(): Promise<Client[]>;
  findClientByHandle(handle: string): Promise<Client | undefined>;
  /**
   * Patch profile / handles / metadata / preferences. Clients were create-and-read-only until now,
   * so a customer's timezone or tone preference could only be captured by rewriting the whole row.
   */
  updateClient(
    id: string,
    patch: Partial<Pick<Client, "display_name" | "handles" | "metadata" | "preferences">>,
  ): Promise<Client | undefined>;

  // threads + messages
  createThread(t: Omit<Thread, "id" | "created_at" | "updated_at">): Promise<Thread>;
  getThread(id: string): Promise<Thread | undefined>;
  /**
   * The conversation an inbound message belongs to.
   *
   * Thread identity is (client, channel, case) — NOT (client, channel). The old key meant one
   * client on one channel had exactly one thread for ever, so a message about their year-end
   * reopened the conversation about their tax return and the run spawned from it inherited the
   * wrong history. See `Thread.case_id`.
   *
   * `caseId` undefined matches ONLY threads that also have no case. That is deliberate on both
   * sides: an unattributed inbound (a new lead) must not be silently filed under whichever
   * engagement happens to be open, and it must not be dropped either — it gets the general thread.
   */
  findOrCreateThread(
    clientId: string,
    channelId: string,
    projectId?: string,
    subject?: string,
    caseId?: string,
  ): Promise<Thread>;
  /**
   * Attach a general thread to an engagement, or retitle/close one.
   *
   * `case_id` is WRITE-ONCE: a thread that already names a case keeps it. A conversation is the
   * evidence of what was said about a job, and letting a later call move it wholesale under a
   * different case rewrites that evidence — the caller wanting a different case wants a different
   * thread, which `findOrCreateThread` will give them.
   */
  updateThread(
    id: string,
    patch: Partial<Pick<Thread, "case_id" | "subject" | "status">>,
  ): Promise<Thread | undefined>;
  listThreadsForClient(clientId: string): Promise<Thread[]>;
  addMessage(m: Omit<Message, "id" | "created_at">): Promise<Message>;
  listMessages(threadId: string): Promise<Message[]>;

  // records (structured, queryable per-wedge state)
  /**
   * Idempotent on (project, wedge, collection, key[, observed_at]).
   * Point-in-time (no observed_at) replaces. A series sample with observed_at inserts/updates that
   * instant only — last week's visibility score is not erased by this week's.
   */
  upsertRecord(r: Omit<Record_, "id" | "created_at" | "updated_at">): Promise<Record_>;
  getRecord(id: string): Promise<Record_ | undefined>;

  // deployments — what is live for a project, and how it got there
  createDeployment(d: Omit<Deployment, "id" | "created_at" | "updated_at">): Promise<Deployment>;
  /**
   * By id AND by project. The project is a required ARGUMENT rather than something the caller
   * checks on the returned row, because "fetch then compare" is the shape that leaks: it is one
   * forgotten `if` away from handing a deployment — including its build id and its error text — to
   * whoever guessed the uuid. A wrong project is indistinguishable from a missing row, on purpose.
   */
  getDeployment(id: string, projectId: string): Promise<Deployment | undefined>;
  listDeployments(q: DeploymentQuery): Promise<Deployment[]>;
  /**
   * In-flight deploys across every project — `building` and `queued` only.
   *
   * THE ONLY CALLER IS THE RECONCILER. This is deliberately not on `DeploymentQuery`, because that
   * type requires `project_id` and making it optional would reopen the exact cross-tenant list path
   * the rest of this interface spent a week closing. A method that can ONLY return in-flight rows
   * (never `live`, never a finished history) cannot answer "show me another project's app".
   */
  listInFlightDeployments(limit?: number): Promise<Deployment[]>;
  /**
   * Advance a deployment's lifecycle. Scoped for the same reason `getDeployment` is: a status write
   * that only takes an id lets any caller mark any tenant's app failed.
   *
   * Returns undefined when the row is not in that project, rather than throwing — the caller is a
   * reconciler polling CodeBuild, and a row that has since been deleted is not an error.
   */
  updateDeployment(
    id: string,
    projectId: string,
    patch: Partial<Pick<Deployment, "status" | "build_id" | "url" | "error">>,
  ): Promise<Deployment | undefined>;
  /**
   * Mark every OTHER deployment of this project superseded, atomically with nothing else.
   *
   * Called when one goes live. Without it a project accumulates rows that all claim to be `live`,
   * and "what is my URL" has several answers — which is how a customer ends up shown a URL that a
   * later deploy replaced. Excludes `keepId` rather than taking a timestamp, because two deploys
   * that finish in the same millisecond would otherwise both survive.
   */
  supersedeDeployments(projectId: string, keepId: string): Promise<number>;
  /**
   * `where` matches equality on top-level data fields.
   *
   * `project_id` is the TENANT filter and it fails closed: pass it and you get only rows whose
   * project_id is exactly that string — a row with no project_id is NOT in scope. Callers that
   * hold a single project (the action proxy, the portal) must push the id down here rather than
   * filter the result, because a post-filter only protects the rows the query happened to return
   * and silently leaks once a `limit` truncates someone else's data into the window.
   */
  queryRecords(q: RecordQuery & { limit?: number }): Promise<Record_[]>;
  /**
   * Look up ONE record by wedge/collection/key across every project.
   *
   * Used only for AgentMail shared-inbox thread routing: the key is a provider thread id WE wrote on
   * send, so resolving it returns our own project scope rather than trusting the webhook payload.
   * Do not use this as a general cross-tenant read — `queryRecords` stays fail-closed on project_id.
   */
  findRecordByNaturalKey(q: { wedge: string; collection: string; key: string }): Promise<Record_ | undefined>;
  deleteRecord(id: string): Promise<boolean>;
  countRecords(q: RecordQuery): Promise<number>;

  // cases (long-lived engagements)
  createCase(c: Omit<Case, "id" | "created_at" | "updated_at" | "history"> & { history?: CaseEvent[] }): Promise<Case>;
  getCase(id: string): Promise<Case | undefined>;
  /**
   * `project_id` is the TENANT filter and it fails closed, exactly like `queryRecords`: a Case with
   * no project_id is never returned when a project is asked for. Cases carry a client's whole
   * engagement history, so "unscoped row is visible to everyone" is not an acceptable default.
   */
  listCases(filter: CaseFilter): Promise<Case[]>;
  /**
   * `client_id` is patchable, and that is not an oversight being corrected loosely.
   *
   * A case for a PROSPECT necessarily begins before the client exists — that is what a prospect is.
   * With client_id write-once-at-create there was no way to say "this one converted", so `won` was
   * a stage nothing could act on and `ProspectDraft.client_id` was a field nothing ever populated:
   * outbound and delivery were two halves of the business with no join between them. Re-pointing a
   * linked case at a DIFFERENT client is refused at the route (server.ts), not here — a store
   * primitive that silently forbade a correction would be the wrong place for that judgement.
   */
  updateCase(
    id: string,
    patch: Partial<Pick<Case, "stage" | "status" | "data" | "title" | "due_at" | "closed_at" | "client_id">>,
    event?: CaseEvent,
  ): Promise<Case | undefined>;

  /**
   * ATOMICALLY claim the right to do ONE client-facing thing to this engagement, once per window.
   *
   * ═══ WHY A CLAIM AND NOT A CHECK ═══
   *
   * Exactly `claimRequestForNudge`'s problem, on a different row. Next-move ids are DETERMINISTIC,
   * so the same silent engagement is the same move on Tuesday as it was on Monday — which makes a
   * founder double-clicking Take the expected case rather than the exotic one. "Read the case, see
   * nothing recent, write that we checked in" passes the read in both tabs before either writes, and
   * the client gets two identical "just checking in" emails on one morning. That is the most
   * embarrassing failure this product can produce, because it is the one the client sees.
   *
   * ONE statement, with the precondition in the WHERE clause. The loser gets `undefined`, and the
   * carrier turns that into "we have already been in touch" rather than into an error.
   *
   * ═══ WHY A MARKER ARGUMENT AND NOT TWO METHODS ═══
   *
   * Two callers wanted the same guarantee about the same row for different reasons — a check-in
   * (`checkin.ts`) and a hand-taken outreach touch (`gtm/sequence.ts`). Two near-identical
   * conditional UPDATEs is how one of them ends up without the tenant in its WHERE clause; this
   * codebase has shipped that bug twice. The marker is a CLOSED UNION rather than a string so a
   * caller cannot claim against — and therefore overwrite — `campaign_id` or `last_touch_at`, which
   * are load-bearing fields the sequencer reads.
   *
   * `notSince` is the caller's floor. The cadence that computes it lives with the carrier that owns
   * it, never here: a store primitive with an opinion about how often we may talk to somebody is a
   * second ladder, and this codebase has already paid for one of those.
   *
   * The marker lives in `data` rather than in a new column — a column would be a migration for one
   * string, and `data` is already where the sequencer keeps `last_touch_at` for the identical
   * purpose (see `noteReplyToTouch`). Returns the CLAIMED row, so the caller builds its run's input
   * from what was actually written rather than from the copy it read a moment ago.
   */
  claimCaseMarker(args: {
    /** REQUIRED tenant scope, in the WHERE clause. Never a post-filter — see `listWaits`. */
    project_id: string;
    id: string;
    marker: CaseClaimMarker;
    /** Claim only if the marker is absent or strictly older than this instant. */
    notSince: string;
    at: string;
  }): Promise<Case | undefined>;

  // ── waits (an engagement blocked on a named condition) ──
  //
  // See `CaseWait` in contract.ts for why this is a row anchored to a Case rather than a field on
  // one. The three mutating methods below are ALL conditional single statements, for the same reason
  // `claimDueSchedules` and `claimPoll` are: with N replicas, "read a row, decide, write it back" is
  // two statements and both replicas pass the check before either one writes.
  createWait(w: NewWait): Promise<CaseWait>;
  /**
   * By id AND by project, like `getDeployment` and `getRequest`. A wrong tenant is indistinguishable
   * from a missing row on purpose: "fetch then compare" is one forgotten `if` away from a leak.
   */
  getWait(projectId: string, id: string): Promise<CaseWait | undefined>;
  /** `project_id` is the REQUIRED tenant scope and fails closed. There is no operator-wide wait read. */
  listWaits(f: WaitFilter): Promise<CaseWait[]>;
  /**
   * ATOMICALLY claim the right to resume this wait: `waiting` → `resuming`, in ONE statement.
   *
   * THE GUARANTEE, and the whole reason this module exists: exactly one caller gets the row back and
   * every other gets `undefined`. That covers both halves of the double-send problem —
   *   · two REPLICAS sweeping the same project in the same second, and
   *   · one condition satisfied TWICE (the client replies, then replies again), because the second
   *     evaluation finds a row that is no longer `waiting`.
   *
   * It does NOT release. A resume that crashes after the claim leaves the wait in `resuming`, where
   * a founder can see it, rather than making it eligible again — because the failure mode a lease
   * would reintroduce is the invoice going out twice, which is the one this is for.
   */
  claimWait(
    projectId: string,
    id: string,
    satisfiedBy: string,
    nowIso: string,
    /**
     * WHICH condition won, for an `any` wait. Written in the SAME statement as the claim, never in a
     * follow-up update: a claim that recorded the winner separately could be interrupted between the
     * two and leave a resume that knows it may proceed and not why — and "why" is what the resumed
     * run branches on.
     */
    satisfiedIndex?: number,
  ): Promise<CaseWait | undefined>;
  /**
   * Record that ONE condition of an `all` wait has come good. Idempotent by index.
   *
   * Append-if-absent in one statement, for the reason every mutation here is one statement — but
   * note what it is NOT protecting. Parts are evidence, not a gate (see `WaitPart`): the join's
   * completeness is recomputed from the world on every sweep, so a lost or duplicated part cannot
   * cause a second resume. What the conditional append buys is a truthful timeline — "the March
   * receipt landed on the 4th" written once, rather than moving forward every time a replica sweeps.
   *
   * Only from `waiting`. A wait that is already resuming has nothing left to make progress on.
   */
  recordWaitPart(projectId: string, id: string, part: WaitPart): Promise<CaseWait | undefined>;
  /**
   * ADD one condition to a live JOIN. The other half of "a month-end close waits on several".
   *
   * The motivating failure is `armDeclaredWait`: a run that asks the client for four receipts calls
   * the gap route four times, the first ask parks the engagement, and the next three are refused by
   * the one-live-wait-per-case index and silently dropped. The close then resumed on receipt one and
   * filed a quarter of a month. This is what turns those three drops into a seven-part join.
   *
   * Every guard is in the WHERE clause, none is read first:
   *   · `status='waiting'` — a wait that is already resuming has been decided; widening what it was
   *     waiting for after the claim would mean a run that resumed on a complete join reading an
   *     incomplete one.
   *   · `mode='all'` — appending an exit to an OR wait is not growth, it is a different wait.
   *   · not already present — idempotent by the condition's SUBJECT, so a retried ask does not make
   *     the join permanently one part longer than the number of things actually outstanding.
   *   · a length ceiling, passed by the caller from `MAX_CONDITIONS`.
   *
   * APPEND-ONLY, never reorder: `WaitPart.index` points into this array, and a sort would silently
   * re-point every banked part at the wrong receipt.
   */
  growWait(projectId: string, id: string, condition: WaitCondition, maxConditions: number): Promise<CaseWait | undefined>;
  /**
   * Move a wait to a terminal state. Conditional on the state it is allowed to come FROM, so a
   * settle cannot resurrect or double-write a wait that something else already finished.
   */
  settleWait(
    projectId: string,
    id: string,
    to: Exclude<WaitStatus, "waiting" | "resuming">,
    patch?: { resumed_task_id?: string; error?: string },
    from?: readonly WaitStatus[],
  ): Promise<CaseWait | undefined>;
  /**
   * ATOMICALLY claim ONE nudge: bump `nudge_count` and re-arm `nudge_at`, only if a nudge is due and
   * the budget is not spent. Same shape as `claimPoll`, same reason — two replicas that both decide
   * a nudge is due chase the client twice on the same morning.
   */
  claimWaitNudge(projectId: string, id: string, nowIso: string, nextNudgeIso: string | undefined): Promise<CaseWait | undefined>;
  /**
   * ATOMICALLY hand a STALLED wait back to the sweep: `resuming` → `waiting`, in ONE statement.
   *
   * ═══ WHY THIS IS NOT A LEASE ═══
   *
   * `claimWait` deliberately never releases, because a lease that expired would make a resume that is
   * merely SLOW eligible a second time, and the second resume of an invoice chase is the duplicate
   * invoice the whole module exists to prevent. That trade leaves one real state behind: a replica
   * that died between the claim and the spawn, whose engagement now sits in `resuming` for ever. This
   * is the only door out of it, and it is a HUMAN one — the founder is asserting the stalled resume
   * never ran, which is a fact about the world that no query can establish (see `rearmWait` in
   * waits.ts for the three mechanical guards that bound what that assertion can cost).
   *
   * Every guard lives in the WHERE clause and none of them is read first:
   *   · `status='resuming'` — a `waiting`, `resumed` or terminal wait is not stuck, and two founders
   *     clicking twice produce one winner and one `undefined`, exactly like `claimWait`.
   *   · `resumed_task_id IS NULL` — a resume that got far enough to record its run DID run. Re-arming
   *     that one is how you get two.
   *   · `updated_at <= stuckBefore` — a resume in flight right now is not stuck, it is busy.
   *   · `rearm_count < maxRearms` — see `CaseWait.rearm_count`.
   *
   * `satisfied_by`/`satisfied_at` are CLEARED. The re-armed wait is evaluated from scratch by the
   * next sweep, so it goes back through `evaluateWait` → `claimWait` → `spawnTask` and passes every
   * gate a fresh run passes. Carrying the old evidence forward would let a re-arm shortcut the
   * evaluation, which is the one thing a re-arm must never become.
   */
  rearmWait(args: {
    projectId: string;
    id: string;
    /** Only re-arm a wait untouched since this instant. See the guard list above. */
    stuckBefore: string;
    maxRearms: number;
    by: string;
    nowIso: string;
  }): Promise<CaseWait | undefined>;

  // schedules (recurring work)
  createSchedule(s: Omit<Schedule, "id" | "created_at">): Promise<Schedule>;
  getSchedule(id: string): Promise<Schedule | undefined>;
  listSchedules(): Promise<Schedule[]>;
  /** Enabled schedules whose next_run_at is at or before `nowIso`. Read-only (portal/inspection). */
  listDueSchedules(nowIso: string): Promise<Schedule[]>;
  /**
   * ATOMICALLY claim due schedules for execution: advance `next_run_at` and return what was won.
   * With N kernel replicas this is what guarantees a schedule fires ONCE — without it, every
   * replica would fire it and a client would get N duplicate emails. `advance` computes the next
   * due time for a cadence (injected so the store stays free of scheduling logic).
   */
  claimDueSchedules(nowIso: string, advance: (s: Schedule, now: Date) => string, limit?: number): Promise<Schedule[]>;
  updateSchedule(
    id: string,
    patch: Partial<Pick<Schedule, "enabled" | "next_run_at" | "last_run_at" | "last_task_id" | "input" | "cadence" | "name">>,
  ): Promise<Schedule | undefined>;
  deleteSchedule(id: string): Promise<boolean>;

  // living knowledge (per wedge)
  createKnowledge(k: Omit<KnowledgeItem, "id" | "created_at" | "updated_at">): Promise<KnowledgeItem>;
  getKnowledge(id: string): Promise<KnowledgeItem | undefined>;
  listKnowledge(wedge: string, projectId: string): Promise<KnowledgeItem[]>;
  updateKnowledge(id: string, patch: Partial<Pick<KnowledgeItem, "name" | "content" | "metadata">>): Promise<KnowledgeItem | undefined>;
  deleteKnowledge(id: string): Promise<boolean>;

  // knowledge gaps — what the agent discovered it doesn't know, on real jobs
  recordGap(g: Omit<KnowledgeGap, "hits" | "task_ids" | "status" | "first_seen" | "last_seen"> & { task_id?: string }): Promise<KnowledgeGap>;
  listGaps(projectId: string, wedge: string): Promise<KnowledgeGap[]>;
  setGapStatus(id: string, projectId: string, status: KnowledgeGap["status"]): Promise<KnowledgeGap | undefined>;
}

const now = () => new Date().toISOString();

/**
 * Drop keys whose value is `undefined`.
 *
 * `Object.assign(row, patch)` assigns `undefined` over real data, so a PATCH-style route that builds
 * `{enabled: true, name: undefined, cadence: undefined}` silently ERASES the name and cadence. That
 * actually happened: pausing a schedule from the UI left it enabled with no cadence and no next run,
 * so it could never fire again.
 *
 * The Postgres store already got this right via `COALESCE`, which made it worse than a plain bug —
 * the two backends disagreed, so memory-backed tests couldn't catch it.
 */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
export const normalizeHandle = (h: string): string => h.trim().toLowerCase();

export class InMemoryDomainStore implements DomainStore {
  private connections = new Map<string, Connection>();
  private channels = new Map<string, Channel>();
  private clients = new Map<string, Client>();
  private threads = new Map<string, Thread>();
  private messages = new Map<string, Message[]>(); // threadId -> messages

  async createConnection(c: Omit<Connection, "id" | "created_at">): Promise<Connection> {
    const conn: Connection = { ...c, id: randomUUID(), created_at: now() };
    this.connections.set(conn.id, conn);
    return conn;
  }
  async getConnection(id: string): Promise<Connection | undefined> {
    return this.connections.get(id);
  }
  async updateConnection(
    id: string,
    patch: Partial<Pick<Connection, "name" | "config" | "secret_ref">>,
  ): Promise<Connection | undefined> {
    const c = this.connections.get(id);
    if (!c) return undefined;
    Object.assign(c, defined(patch));
    return c;
  }
  async listConnections(): Promise<Connection[]> {
    return [...this.connections.values()];
  }
  async deleteConnection(id: string): Promise<boolean> {
    const existed = this.connections.delete(id);
    for (const [sid, s] of this.triggerSubs) {
      if (s.connection_id === id) this.triggerSubs.delete(sid);
    }
    for (const [cid, ch] of this.channels) {
      if (ch.connection_id === id) this.channels.delete(cid);
    }
    return existed;
  }
  async bumpPacing(connectionId: string, bump: PacingBump): Promise<Connection | undefined> {
    const c = this.connections.get(connectionId);
    if (!c) return undefined;
    // NOT A SINGLE `await` BELOW THIS LINE, and that is the whole guarantee in this backend: an
    // async function only yields at an await, so read-merge-write with none of them is indivisible
    // however many callers are in flight. Add one and two concurrent sends silently share a
    // counter. (Postgres gets the real one — see domain.pg.ts.)
    const cfg = { ...(c.config ?? {}) } as Record<string, unknown>;
    const p = { ...((cfg.pacing ?? {}) as Record<string, unknown>) };
    const used = { ...((p.used ?? {}) as Record<string, number>) };
    const windows = { ...((p.windows ?? {}) as Record<string, string>) };
    const lastAt = { ...((p.last_at ?? {}) as Record<string, string>) };
    const eng = { sent: 0, accepted: 0, replied: 0, flagged: 0, ...((p.engagement ?? {}) as Record<string, number>) };

    if (bump.kind) {
      const started = Date.parse(windows[bump.kind] ?? "");
      const cutoff = Date.parse(bump.windowResetBefore ?? "");
      const expired = !Number.isFinite(started) || (Number.isFinite(cutoff) && started <= cutoff);
      used[bump.kind] = expired ? 1 : (used[bump.kind] ?? 0) + 1;
      if (expired && bump.windowStart) windows[bump.kind] = bump.windowStart;
      lastAt[bump.kind] = bump.at;
    }
    for (const k of ["sent", "accepted", "replied", "flagged"] as const) {
      eng[k] = (eng[k] ?? 0) + (bump.engagement?.[k] ?? 0);
    }

    c.config = { ...cfg, pacing: { ...p, used, windows, last_at: lastAt, engagement: eng } };
    return c;
  }
  async claimPoll(connectionId: string, kind: string, nowIso: string, nextAtIso: string): Promise<boolean> {
    const c = this.connections.get(connectionId);
    if (!c) return false;
    // Same rule as `bumpPacing`: NO `await` below this line. The check and the write have to be one
    // indivisible step or two ticks racing on one connection both decide the poll is due.
    const cfg = { ...(c.config ?? {}) } as Record<string, unknown>;
    const polling = { ...((cfg.polling ?? {}) as Record<string, string>) };
    const dueAt = Date.parse(polling[kind] ?? "");
    // An unparseable or absent cursor means "never polled", which is due. That is the permissive
    // direction, but only by one poll — the write immediately below closes it.
    if (Number.isFinite(dueAt) && dueAt > Date.parse(nowIso)) return false;
    polling[kind] = nextAtIso;
    c.config = { ...cfg, polling };
    return true;
  }

  private triggerSubs = new Map<string, TriggerSub>();

  async createTriggerSub(t: Omit<TriggerSub, "id" | "created_at" | "updated_at">): Promise<TriggerSub> {
    const ts = now();
    const slug = t.trigger_slug.toUpperCase();
    // Upsert on (connection, slug), matching the Postgres unique index. Subscribing twice to the
    // same event on the same account is ONE subscription — two rows would mean two runs per
    // delivery, which is the exact failure the idempotency key exists to prevent, reintroduced
    // one level up. The two backends must agree here or memory-backed tests can't catch it.
    const existing = [...this.triggerSubs.values()].find(
      (s) => s.connection_id === t.connection_id && s.trigger_slug === slug,
    );
    if (existing) {
      Object.assign(existing, defined({ ...t, trigger_slug: slug, trigger_id: t.trigger_id ?? existing.trigger_id }));
      existing.updated_at = ts;
      return existing;
    }
    const sub: TriggerSub = { ...t, trigger_slug: slug, id: randomUUID(), created_at: ts, updated_at: ts };
    this.triggerSubs.set(sub.id, sub);
    return sub;
  }
  async getTriggerSub(id: string): Promise<TriggerSub | undefined> {
    return this.triggerSubs.get(id);
  }
  async listTriggerSubs(): Promise<TriggerSub[]> {
    return [...this.triggerSubs.values()];
  }
  async findTriggerSub(q: {
    trigger_id?: string;
    connection_id?: string;
    trigger_slug?: string;
  }): Promise<TriggerSub | undefined> {
    const all = [...this.triggerSubs.values()];
    if (q.trigger_id) {
      const hit = all.find((s) => s.trigger_id === q.trigger_id);
      if (hit) return hit;
    }
    if (q.connection_id && q.trigger_slug) {
      return all.find(
        (s) =>
          s.connection_id === q.connection_id &&
          s.trigger_slug.toUpperCase() === q.trigger_slug!.toUpperCase(),
      );
    }
    return undefined;
  }
  async updateTriggerSub(
    id: string,
    patch: Partial<Pick<TriggerSub, "enabled" | "trigger_id" | "wedge" | "task_type" | "config" | "last_event_at" | "last_task_id">>,
  ): Promise<TriggerSub | undefined> {
    const s = this.triggerSubs.get(id);
    if (!s) return undefined;
    Object.assign(s, defined(patch));
    s.updated_at = now();
    return s;
  }
  async deleteTriggerSub(id: string): Promise<boolean> {
    return this.triggerSubs.delete(id);
  }

  async createChannel(c: Omit<Channel, "id" | "created_at">): Promise<Channel> {
    const ch: Channel = { ...c, id: randomUUID(), created_at: now() };
    this.channels.set(ch.id, ch);
    return ch;
  }
  async getChannel(id: string): Promise<Channel | undefined> {
    return this.channels.get(id);
  }
  async listChannels(): Promise<Channel[]> {
    return [...this.channels.values()];
  }

  async createClient(c: Omit<Client, "id" | "created_at" | "updated_at">): Promise<Client> {
    const cl: Client = {
      ...c,
      handles: (c.handles ?? []).map(normalizeHandle),
      id: randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    this.clients.set(cl.id, cl);
    return cl;
  }
  async getClient(id: string): Promise<Client | undefined> {
    return this.clients.get(id);
  }
  async listClients(): Promise<Client[]> {
    return [...this.clients.values()];
  }
  async findClientByHandle(handle: string): Promise<Client | undefined> {
    const h = normalizeHandle(handle);
    return [...this.clients.values()].find((c) => c.handles.includes(h));
  }
  async updateClient(
    id: string,
    patch: Partial<Pick<Client, "display_name" | "handles" | "metadata" | "preferences">>,
  ): Promise<Client | undefined> {
    const c = this.clients.get(id);
    if (!c) return undefined;
    // `defined()` for the same reason every other patch here uses it: an absent key must not
    // assign `undefined` over real data. Handles are re-normalized so lookup keeps working.
    const clean = defined(patch);
    if (clean.handles) clean.handles = clean.handles.map(normalizeHandle);
    Object.assign(c, clean);
    c.updated_at = now();
    return c;
  }

  async createThread(t: Omit<Thread, "id" | "created_at" | "updated_at">): Promise<Thread> {
    const th: Thread = { ...t, id: randomUUID(), created_at: now(), updated_at: now() };
    this.threads.set(th.id, th);
    this.messages.set(th.id, []);
    return th;
  }
  async getThread(id: string): Promise<Thread | undefined> {
    return this.threads.get(id);
  }
  async findOrCreateThread(
    clientId: string,
    channelId: string,
    projectId?: string,
    subject?: string,
    caseId?: string,
  ): Promise<Thread> {
    const existing = [...this.threads.values()].find(
      (t) =>
        t.client_id === clientId &&
        t.channel_id === channelId &&
        t.status === "open" &&
        // `?? undefined` so a stored `null` (or a legacy row that never had the column) compares
        // equal to "no case" rather than being a third value that matches nothing.
        (t.case_id ?? undefined) === (caseId ?? undefined),
    );
    if (existing) return existing;
    return this.createThread({
      project_id: projectId,
      client_id: clientId,
      channel_id: channelId,
      case_id: caseId,
      subject,
      status: "open",
    });
  }
  async updateThread(
    id: string,
    patch: Partial<Pick<Thread, "case_id" | "subject" | "status">>,
  ): Promise<Thread | undefined> {
    const t = this.threads.get(id);
    if (!t) return undefined;
    const clean = defined(patch);
    // Write-once (see the interface). Dropping the field rather than refusing the whole call keeps
    // "rename this thread and attach it to a case" working when it is already attached.
    if (t.case_id) delete clean.case_id;
    Object.assign(t, clean);
    t.updated_at = now();
    return t;
  }
  async listThreadsForClient(clientId: string): Promise<Thread[]> {
    return [...this.threads.values()].filter((t) => t.client_id === clientId);
  }
  async addMessage(m: Omit<Message, "id" | "created_at">): Promise<Message> {
    const msg: Message = { ...m, id: randomUUID(), created_at: now() };
    (this.messages.get(m.thread_id) ?? this.messages.set(m.thread_id, []).get(m.thread_id)!).push(msg);
    const th = this.threads.get(m.thread_id);
    if (th) th.updated_at = now();
    return msg;
  }
  async listMessages(threadId: string): Promise<Message[]> {
    return this.messages.get(threadId) ?? [];
  }

  private records = new Map<string, Record_>();
  private recKey = (r: { project_id?: string; wedge: string; collection: string; key: string; observed_at?: string }) =>
    `${r.project_id ?? "-"}|${r.wedge}|${r.collection}|${r.key}|${r.observed_at ?? ""}`;
  async upsertRecord(r: Omit<Record_, "id" | "created_at" | "updated_at">): Promise<Record_> {
    const k = this.recKey(r);
    const existing = [...this.records.values()].find((x) => this.recKey(x) === k);
    if (existing) {
      existing.data = { ...existing.data, ...r.data };
      if (r.case_id) existing.case_id = r.case_id;
      existing.updated_at = now();
      return existing;
    }
    const rec: Record_ = { ...r, id: randomUUID(), created_at: now(), updated_at: now() };
    this.records.set(rec.id, rec);
    return rec;
  }
  async getRecord(id: string): Promise<Record_ | undefined> {
    return this.records.get(id);
  }
  private matches(r: Record_, q: RecordQuery): boolean {
    // Fail closed: once a project is named, an unscoped row (project_id undefined) is OUT, not in.
    // `q.project_id && r.project_id !== q.project_id` would have let every legacy unscoped record
    // answer every tenant's query.
    if (r.project_id !== q.project_id) return false;
    if (q.wedge && r.wedge !== q.wedge) return false;
    if (q.collection && r.collection !== q.collection) return false;
    if (q.case_id && r.case_id !== q.case_id) return false;
    if (q.observed_from || q.observed_to) {
      // Point-in-time rows have no observation instant — a time-range query must not pretend they
      // were measured in the window. They are current state, not history.
      if (!r.observed_at) return false;
      if (q.observed_from && r.observed_at < q.observed_from) return false;
      if (q.observed_to && r.observed_at > q.observed_to) return false;
    }
    for (const [k, v] of Object.entries(q.where ?? {})) {
      if (JSON.stringify(r.data?.[k]) !== JSON.stringify(v)) return false;
    }
    return true;
  }
  async queryRecords(q: RecordQuery & { limit?: number }): Promise<Record_[]> {
    let rows = [...this.records.values()]
      .filter((r) => this.matches(r, q))
      .sort((a, b) => {
        // Prefer observation time when present so a series reads newest-first by the measurement,
        // not by when we happened to write the row.
        const aT = a.observed_at ?? a.created_at;
        const bT = b.observed_at ?? b.created_at;
        return aT < bT ? 1 : -1;
      });
    if (q.latest_per_key) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
      });
    }
    return rows.slice(0, q.limit ?? 200);
  }
  async findRecordByNaturalKey(q: { wedge: string; collection: string; key: string }): Promise<Record_ | undefined> {
    if (!q.wedge || !q.collection || !q.key) return undefined;
    // Newest write wins if two projects somehow share a key (should not happen for AgentMail thread ids).
    const rows = [...this.records.values()]
      .filter((r) => r.wedge === q.wedge && r.collection === q.collection && r.key === q.key && !r.observed_at)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return rows[0];
  }
  async deleteRecord(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
  async countRecords(q: RecordQuery): Promise<number> {
    return [...this.records.values()].filter((r) => this.matches(r, q)).length;
  }

  private deployments = new Map<string, Deployment>();
  async createDeployment(d: Omit<Deployment, "id" | "created_at" | "updated_at">): Promise<Deployment> {
    // The tenant is checked at the door rather than trusted from the caller. Every other write path
    // in this store accepts an optional project and defends itself on read; a deployment with an
    // empty project would be a live URL with no owner, which no read-side check can repair.
    if (!d.project_id) throw new Error("deployment requires a project_id");
    const dep: Deployment = { ...d, id: randomUUID(), created_at: now(), updated_at: now() };
    this.deployments.set(dep.id, dep);
    return dep;
  }
  async getDeployment(id: string, projectId: string): Promise<Deployment | undefined> {
    const d = this.deployments.get(id);
    // Fail closed on BOTH halves: no row, or a row in another project, is the same answer.
    if (!d || !projectId || d.project_id !== projectId) return undefined;
    return d;
  }
  async listDeployments(q: DeploymentQuery): Promise<Deployment[]> {
    if (!q.project_id) return [];
    return [...this.deployments.values()]
      .filter((d) => d.project_id === q.project_id && (!q.status || d.status === q.status))
      // Newest first: the caller almost always wants "what is live now", which is row zero.
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, q.limit ?? 50);
  }
  async listInFlightDeployments(limit = 50): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter((d) => d.status === "building" || d.status === "queued")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }
  async updateDeployment(
    id: string,
    projectId: string,
    patch: Partial<Pick<Deployment, "status" | "build_id" | "url" | "error">>,
  ): Promise<Deployment | undefined> {
    const d = await this.getDeployment(id, projectId);
    if (!d) return undefined;
    // `defined` for the same reason schedules needed it: an explicit `undefined` in a patch must
    // mean "leave it alone", not "erase it". A reconciler that reports status without a build id
    // would otherwise wipe the only handle that leads to the build log.
    Object.assign(d, defined(patch), { updated_at: now() });
    return d;
  }
  async supersedeDeployments(projectId: string, keepId: string): Promise<number> {
    if (!projectId) return 0;
    let n = 0;
    for (const d of this.deployments.values()) {
      if (d.project_id !== projectId || d.id === keepId) continue;
      // Only what was actually serving traffic. A `failed` row is history and must stay failed —
      // rewriting it to `superseded` would erase the evidence that a deploy broke.
      if (d.status !== "live") continue;
      d.status = "superseded";
      d.updated_at = now();
      n++;
    }
    return n;
  }

  private cases = new Map<string, Case>();
  async createCase(c: Omit<Case, "id" | "created_at" | "updated_at" | "history"> & { history?: CaseEvent[] }): Promise<Case> {
    const kase: Case = { ...c, history: c.history ?? [], id: randomUUID(), created_at: now(), updated_at: now() };
    this.cases.set(kase.id, kase);
    return kase;
  }
  async getCase(id: string): Promise<Case | undefined> {
    return this.cases.get(id);
  }
  async listCases(filter: CaseFilter): Promise<Case[]> {
    return [...this.cases.values()]
      .filter((k) =>
        // Tenant scope first, and strict — an unscoped Case is invisible to a scoped query.
        k.project_id === filter.project_id &&
        (!filter.wedge || k.wedge === filter.wedge) &&
        (!filter.status || k.status === filter.status) &&
        (!filter.client_id || k.client_id === filter.client_id) &&
        (!filter.stage || k.stage === filter.stage))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  async updateCase(
    id: string,
    patch: Partial<Pick<Case, "stage" | "status" | "data" | "title" | "due_at" | "closed_at" | "client_id">>,
    event?: CaseEvent,
  ): Promise<Case | undefined> {
    const k = this.cases.get(id);
    if (!k) return undefined;
    Object.assign(k, defined(patch));
    if (event) k.history = [...k.history, event];
    k.updated_at = now();
    return k;
  }
  async claimCaseMarker(args: {
    project_id: string; id: string; marker: CaseClaimMarker; notSince: string; at: string;
  }): Promise<Case | undefined> {
    const k = this.cases.get(args.id);
    // NO `await` from here to the end, exactly like `claimWait` — see the comment above `waits`. An
    // async function only yields at an await, so a check-then-write with none of them is indivisible
    // however many clicks are in flight, and the whole suite runs on this backend: an `await` here
    // would make the double-check-in test pass while Postgres was the only thing holding the line.
    if (!k || !args.project_id || k.project_id !== args.project_id) return undefined;
    if (k.status !== "open") return undefined;
    const last = (k.data as Record<string, unknown> | undefined)?.[args.marker];
    if (typeof last === "string" && last >= args.notSince) return undefined;
    k.data = { ...(k.data ?? {}), [args.marker]: args.at };
    k.updated_at = args.at;
    return { ...k };
  }

  // ── waits ──
  //
  // NOT A SINGLE `await` inside `claimWait` / `settleWait` / `claimWaitNudge`, exactly like
  // `bumpPacing` and `claimPoll` above. An async function only yields at an await, so a
  // check-then-write with none of them is indivisible however many callers are in flight. Add one
  // and this backend stops making the guarantee its own interface documents — and because the whole
  // test suite runs on this backend, the double-resume test would pass while Postgres was the only
  // thing actually holding the line.
  private waits = new Map<string, CaseWait>();

  async createWait(w: NewWait): Promise<CaseWait> {
    if (!w.project_id) throw new Error("a wait requires a project_id");
    if (!w.case_id) throw new Error("a wait requires a case_id");
    // A wait with no way out can only expire. Refused at the store as well as at `armWait`, because
    // this is the one invariant every read below assumes (`conditions[0]` is never undefined) and a
    // caller that skipped the arming path would otherwise write a row that parks an engagement for
    // ninety days with nothing that could release it.
    if (!w.conditions?.length) throw new Error("a wait requires at least one condition");
    // One open wait per case, matching the partial unique index in Postgres. Two live waits on one
    // engagement means two resumes racing to advance the same stage, which is the double-invoice
    // bug arriving from inside the house.
    for (const existing of this.waits.values()) {
      if (existing.case_id === w.case_id && (existing.status === "waiting" || existing.status === "resuming")) {
        throw new Error(`case ${w.case_id} is already waiting (${existing.id})`);
      }
    }
    const ts = now();
    const row: CaseWait = {
      ...w, nudge_count: w.nudge_count ?? 0, rearm_count: 0, parts: [],
      // Copied, not aliased. The caller's array outliving this row would let an arm-site mutation
      // reorder `conditions` under a `WaitPart.index` that already points into it.
      conditions: [...w.conditions],
      status: "waiting", id: randomUUID(), created_at: ts, updated_at: ts,
    };
    this.waits.set(row.id, row);
    return row;
  }
  async getWait(projectId: string, id: string): Promise<CaseWait | undefined> {
    const w = this.waits.get(id);
    // Fail closed on BOTH halves: no row, or a row in another project, is the same answer.
    if (!w || !projectId || w.project_id !== projectId) return undefined;
    return w;
  }
  async listWaits(f: WaitFilter): Promise<CaseWait[]> {
    if (!f.project_id) return [];
    return [...this.waits.values()]
      .filter((w) => w.project_id === f.project_id && (!f.case_id || w.case_id === f.case_id) && (!f.status || w.status === f.status))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, f.limit ?? 200);
  }
  async claimWait(
    projectId: string, id: string, satisfiedBy: string, nowIso: string, satisfiedIndex?: number,
  ): Promise<CaseWait | undefined> {
    const w = this.waits.get(id);
    if (!w || !projectId || w.project_id !== projectId) return undefined;
    if (w.status !== "waiting") return undefined; // ← the exactly-once gate. No await above this line.
    w.status = "resuming";
    w.satisfied_by = satisfiedBy;
    w.satisfied_index = satisfiedIndex;
    w.satisfied_at = nowIso;
    w.updated_at = nowIso;
    return { ...w };
  }
  async recordWaitPart(projectId: string, id: string, part: WaitPart): Promise<CaseWait | undefined> {
    const w = this.waits.get(id);
    // NO `await` from here to the end, exactly like `claimWait` — see the comment above `waits`.
    if (!w || !projectId || w.project_id !== projectId) return undefined;
    if (w.status !== "waiting") return undefined;
    // Idempotent BY INDEX and not by whole-value equality: `client_reply` names a different message
    // every time somebody writes on the thread, so equality would append a new part per sweep and
    // "3 of 7" would climb past 7.
    if (w.parts.some((p) => p.index === part.index)) return undefined;
    w.parts = [...w.parts, part];
    w.updated_at = now();
    return { ...w };
  }
  async settleWait(
    projectId: string,
    id: string,
    to: Exclude<WaitStatus, "waiting" | "resuming">,
    patch?: { resumed_task_id?: string; error?: string },
    from: readonly WaitStatus[] = ["waiting", "resuming"],
  ): Promise<CaseWait | undefined> {
    const w = this.waits.get(id);
    if (!w || !projectId || w.project_id !== projectId) return undefined;
    if (!from.includes(w.status)) return undefined;
    w.status = to;
    if (patch?.resumed_task_id) w.resumed_task_id = patch.resumed_task_id;
    if (patch?.error) w.error = patch.error;
    w.updated_at = now();
    return { ...w };
  }
  async claimWaitNudge(projectId: string, id: string, nowIso: string, nextNudgeIso: string | undefined): Promise<CaseWait | undefined> {
    const w = this.waits.get(id);
    if (!w || !projectId || w.project_id !== projectId) return undefined;
    if (w.status !== "waiting") return undefined;
    if (!w.nudge_at || w.nudge_at > nowIso) return undefined;
    if (w.nudge_count >= w.max_nudges) return undefined;
    w.nudge_count += 1;
    // Re-armed BEFORE the nudge is delivered, never after — the same rule `claimPoll` states: a
    // nudge that throws must cost one cycle, not become an unbounded retry loop at a client's inbox.
    w.nudge_at = w.nudge_count >= w.max_nudges ? undefined : nextNudgeIso;
    w.updated_at = nowIso;
    return { ...w };
  }
  async growWait(
    projectId: string, id: string, condition: WaitCondition, maxConditions: number,
  ): Promise<CaseWait | undefined> {
    const w = this.waits.get(id);
    // NO `await` from here to the end, exactly like `claimWait` — see the comment above `waits`.
    if (!w || !projectId || w.project_id !== projectId) return undefined;
    if (w.status !== "waiting" || w.mode !== "all") return undefined;
    if (w.conditions.length >= maxConditions) return undefined;
    const subject = JSON.stringify([condition.kind, Object.entries(condition).find(([k]) => k !== "kind" && k !== "label")?.[1]]);
    const already = w.conditions.some(
      (c) => JSON.stringify([c.kind, Object.entries(c).find(([k]) => k !== "kind" && k !== "label")?.[1]]) === subject,
    );
    if (already) return undefined;
    w.conditions = [...w.conditions, condition];
    w.updated_at = now();
    return { ...w };
  }
  async rearmWait(args: {
    projectId: string; id: string; stuckBefore: string; maxRearms: number; by: string; nowIso: string;
  }): Promise<CaseWait | undefined> {
    const w = this.waits.get(args.id);
    // NO `await` from here to the end, exactly like `claimWait` — see the comment above `waits`. A
    // re-arm that yielded mid-check is two founders both moving one wait back to `waiting`, and the
    // sweep then finds it twice.
    if (!w || !args.projectId || w.project_id !== args.projectId) return undefined;
    if (w.status !== "resuming") return undefined;
    if (w.resumed_task_id) return undefined;
    if (w.updated_at > args.stuckBefore) return undefined;
    if (w.rearm_count >= args.maxRearms) return undefined;
    w.status = "waiting";
    // `parts` is deliberately NOT cleared. The evidence of the claim is (the wait was satisfied);
    // the evidence of the JOIN is not — those four receipts really did arrive, and wiping them would
    // make a re-armed month-end close re-report "0 of 7 in" to a founder who watched four land.
    w.satisfied_by = undefined;
    w.satisfied_index = undefined;
    w.satisfied_at = undefined;
    w.rearm_count += 1;
    w.rearmed_at = args.nowIso;
    w.rearmed_by = args.by;
    w.updated_at = args.nowIso;
    return { ...w };
  }

  private schedules = new Map<string, Schedule>();
  async createSchedule(s: Omit<Schedule, "id" | "created_at">): Promise<Schedule> {
    const sched: Schedule = { ...s, id: randomUUID(), created_at: now() };
    this.schedules.set(sched.id, sched);
    return sched;
  }
  async getSchedule(id: string): Promise<Schedule | undefined> {
    return this.schedules.get(id);
  }
  async listSchedules(): Promise<Schedule[]> {
    return [...this.schedules.values()];
  }
  async listDueSchedules(nowIso: string): Promise<Schedule[]> {
    return [...this.schedules.values()].filter((s) => s.enabled && s.next_run_at <= nowIso);
  }
  async claimDueSchedules(nowIso: string, advance: (s: Schedule, now: Date) => string, limit = 50): Promise<Schedule[]> {
    // In-memory is single-process by definition, so "claim" is just read-then-advance. The JS event
    // loop makes this atomic enough — there is no second replica to race with.
    const due = (await this.listDueSchedules(nowIso)).slice(0, limit);
    const now = new Date(nowIso);
    for (const s of due) {
      s.next_run_at = advance(s, now);
      s.last_run_at = nowIso;
    }
    return due;
  }
  async updateSchedule(
    id: string,
    patch: Partial<Pick<Schedule, "enabled" | "next_run_at" | "last_run_at" | "last_task_id" | "input" | "cadence" | "name">>,
  ): Promise<Schedule | undefined> {
    const s = this.schedules.get(id);
    if (!s) return undefined;
    Object.assign(s, defined(patch));
    return s;
  }
  async deleteSchedule(id: string): Promise<boolean> {
    return this.schedules.delete(id);
  }

  private knowledge = new Map<string, KnowledgeItem>();
  async createKnowledge(k: Omit<KnowledgeItem, "id" | "created_at" | "updated_at">): Promise<KnowledgeItem> {
    const item: KnowledgeItem = { ...k, id: randomUUID(), created_at: now(), updated_at: now() };
    this.knowledge.set(item.id, item);
    return item;
  }
  async getKnowledge(id: string): Promise<KnowledgeItem | undefined> {
    return this.knowledge.get(id);
  }
  /**
   * Knowledge for a wedge, scoped to a tenant.
   *
   * `projectId` is REQUIRED and the filter fails CLOSED, matching `listCases`/`queryRecords`: a row
   * with no project belongs to nobody rather than to everybody.
   *
   * It used to filter on `wedge` alone, and `runtime.ts` mounts the result into `./knowledge/` in
   * the sandbox with AGENTS.md instructing the agent to read it before acting. So every tenant
   * running a given wedge received every other tenant's uploaded knowledge, intake answers (pricing,
   * fee schedules, policies) and human corrections.
   *
   * It was also silent CORRUPTION, not only disclosure: intake filenames are deterministic
   * (`intake/late-fee.md` is the same name for every tenant) and the runtime keys a Map by name
   * ordered by created_at, so the last tenant to answer a question overwrote everyone else's answer
   * and the agent quoted a stranger's late fee to your client.
   */
  async listKnowledge(wedge: string, projectId: string): Promise<KnowledgeItem[]> {
    if (!projectId) return [];
    return [...this.knowledge.values()].filter((k) => k.wedge === wedge && k.project_id === projectId);
  }
  async updateKnowledge(
    id: string,
    patch: Partial<Pick<KnowledgeItem, "name" | "content" | "metadata">>,
  ): Promise<KnowledgeItem | undefined> {
    const k = this.knowledge.get(id);
    if (!k) return undefined;
    if (patch.name !== undefined) k.name = patch.name;
    if (patch.content !== undefined) k.content = patch.content;
    if (patch.metadata !== undefined) k.metadata = patch.metadata;
    k.updated_at = now();
    return k;
  }
  private gaps = new Map<string, KnowledgeGap>();
  private gapKey(projectId: string, id: string) {
    return `${projectId}::${id}`;
  }
  async recordGap(
    g: Omit<KnowledgeGap, "hits" | "task_ids" | "status" | "first_seen" | "last_seen"> & { task_id?: string },
  ): Promise<KnowledgeGap> {
    const key = this.gapKey(g.project_id, g.id);
    const existing = this.gaps.get(key);
    const ts = now();
    if (existing) {
      // Recurrence is the ranking signal, so the same gap hit twice increments rather than duplicates.
      existing.hits += 1;
      existing.last_seen = ts;
      if (g.task_id && !existing.task_ids.includes(g.task_id)) existing.task_ids.push(g.task_id);
      if (g.fallback) existing.fallback = g.fallback;
      // Something the founder already answered has come up again — the answer didn't cover it.
      if (existing.status === "answered") existing.status = "open";
      return existing;
    }
    const created: KnowledgeGap = {
      ...g,
      hits: 1,
      task_ids: g.task_id ? [g.task_id] : [],
      status: "open",
      first_seen: ts,
      last_seen: ts,
    };
    this.gaps.set(key, created);
    return created;
  }
  async listGaps(projectId: string, wedge: string): Promise<KnowledgeGap[]> {
    return [...this.gaps.values()].filter((g) => g.project_id === projectId && g.wedge === wedge);
  }
  async setGapStatus(id: string, projectId: string, status: KnowledgeGap["status"]): Promise<KnowledgeGap | undefined> {
    const g = this.gaps.get(this.gapKey(projectId, id));
    if (!g) return undefined;
    g.status = status;
    return g;
  }
  async deleteKnowledge(id: string): Promise<boolean> {
    return this.knowledge.delete(id);
  }
}

export function createDomainStore(): DomainStore {
  return new InMemoryDomainStore();
}

// Process-wide singleton so the server, orchestrator, runtime, and action proxy all share it
// without threading it through every call. getDomainStore() stays synchronous (it's on hot paths);
// initDomainStore() is awaited once at boot to swap in the durable backend.
let cached: DomainStore | null = null;
export function getDomainStore(): DomainStore {
  if (!cached) cached = createDomainStore();
  return cached;
}

/** Boot-time backend selection: Postgres when MYCEL_DATABASE_URL is set, else in-memory. */
export async function initDomainStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  if (url) {
    const { PostgresDomainStore } = await import("./domain.pg");
    cached = await PostgresDomainStore.connect(url);
    return { backend: "postgres" };
  }
  cached = createDomainStore();
  return { backend: "memory" };
}

/** Release the domain store (pg pool) on graceful shutdown. */
export async function closeDomainStore(): Promise<void> {
  await (cached as DomainStore & { close?: () => Promise<void> })?.close?.();
}
