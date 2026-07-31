// The service-surface store: clients, connections, channels, threads, messages. This is the CRM +
// comms layer that turns the task engine into a service business — who the work is for, where it
// comes from and goes, and the external capabilities behind it.
//
// v0.1 ships an in-memory reference implementation (zero setup). Postgres backing mirrors the
// task tables and is the next step; the task engine itself is already durable (store.pg.ts).
import { databaseUrl } from "./config";
import { randomUUID } from "node:crypto";
import type { KnowledgeGap } from "./intake";
import type { Case, CaseEvent, Channel, Record_, Client, Connection, KnowledgeItem, Message, Schedule, Thread, TriggerSub } from "./contract";

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

  // threads + messages
  createThread(t: Omit<Thread, "id" | "created_at" | "updated_at">): Promise<Thread>;
  getThread(id: string): Promise<Thread | undefined>;
  findOrCreateThread(clientId: string, channelId: string, projectId?: string, subject?: string): Promise<Thread>;
  listThreadsForClient(clientId: string): Promise<Thread[]>;
  addMessage(m: Omit<Message, "id" | "created_at">): Promise<Message>;
  listMessages(threadId: string): Promise<Message[]>;

  // records (structured, queryable per-wedge state)
  /** Idempotent: matches on (wedge, collection, key) and updates in place. */
  upsertRecord(r: Omit<Record_, "id" | "created_at" | "updated_at">): Promise<Record_>;
  getRecord(id: string): Promise<Record_ | undefined>;
  /** `where` matches equality on top-level data fields. */
  queryRecords(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown>; limit?: number }): Promise<Record_[]>;
  deleteRecord(id: string): Promise<boolean>;
  countRecords(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown> }): Promise<number>;

  // cases (long-lived engagements)
  createCase(c: Omit<Case, "id" | "created_at" | "updated_at" | "history"> & { history?: CaseEvent[] }): Promise<Case>;
  getCase(id: string): Promise<Case | undefined>;
  listCases(filter?: { wedge?: string; status?: Case["status"]; client_id?: string; stage?: string }): Promise<Case[]>;
  updateCase(
    id: string,
    patch: Partial<Pick<Case, "stage" | "status" | "data" | "title" | "due_at" | "closed_at">>,
    event?: CaseEvent,
  ): Promise<Case | undefined>;

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
  listKnowledge(wedge: string): Promise<KnowledgeItem[]>;
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

  async createThread(t: Omit<Thread, "id" | "created_at" | "updated_at">): Promise<Thread> {
    const th: Thread = { ...t, id: randomUUID(), created_at: now(), updated_at: now() };
    this.threads.set(th.id, th);
    this.messages.set(th.id, []);
    return th;
  }
  async getThread(id: string): Promise<Thread | undefined> {
    return this.threads.get(id);
  }
  async findOrCreateThread(clientId: string, channelId: string, projectId?: string, subject?: string): Promise<Thread> {
    const existing = [...this.threads.values()].find(
      (t) => t.client_id === clientId && t.channel_id === channelId && t.status === "open",
    );
    if (existing) return existing;
    return this.createThread({ project_id: projectId, client_id: clientId, channel_id: channelId, subject, status: "open" });
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
  private recKey = (r: { project_id?: string; wedge: string; collection: string; key: string }) =>
    `${r.project_id ?? "-"}|${r.wedge}|${r.collection}|${r.key}`;
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
  private matches(r: Record_, q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown> }): boolean {
    if (q.wedge && r.wedge !== q.wedge) return false;
    if (q.collection && r.collection !== q.collection) return false;
    if (q.case_id && r.case_id !== q.case_id) return false;
    for (const [k, v] of Object.entries(q.where ?? {})) {
      if (JSON.stringify(r.data?.[k]) !== JSON.stringify(v)) return false;
    }
    return true;
  }
  async queryRecords(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown>; limit?: number }): Promise<Record_[]> {
    return [...this.records.values()]
      .filter((r) => this.matches(r, q))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, q.limit ?? 200);
  }
  async deleteRecord(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
  async countRecords(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown> }): Promise<number> {
    return [...this.records.values()].filter((r) => this.matches(r, q)).length;
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
  async listCases(filter: { wedge?: string; status?: Case["status"]; client_id?: string; stage?: string } = {}): Promise<Case[]> {
    return [...this.cases.values()]
      .filter((k) =>
        (!filter.wedge || k.wedge === filter.wedge) &&
        (!filter.status || k.status === filter.status) &&
        (!filter.client_id || k.client_id === filter.client_id) &&
        (!filter.stage || k.stage === filter.stage))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  async updateCase(
    id: string,
    patch: Partial<Pick<Case, "stage" | "status" | "data" | "title" | "due_at" | "closed_at">>,
    event?: CaseEvent,
  ): Promise<Case | undefined> {
    const k = this.cases.get(id);
    if (!k) return undefined;
    Object.assign(k, defined(patch));
    if (event) k.history = [...k.history, event];
    k.updated_at = now();
    return k;
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
  async listKnowledge(wedge: string): Promise<KnowledgeItem[]> {
    return [...this.knowledge.values()].filter((k) => k.wedge === wedge);
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
