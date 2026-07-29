// The service-surface store: clients, connections, channels, threads, messages. This is the CRM +
// comms layer that turns the task engine into a service business — who the work is for, where it
// comes from and goes, and the external capabilities behind it.
//
// v0.1 ships an in-memory reference implementation (zero setup). Postgres backing mirrors the
// task tables and is the next step; the task engine itself is already durable (store.pg.ts).
import { randomUUID } from "node:crypto";
import type { Channel, Client, Connection, KnowledgeItem, Message, Thread } from "./contract";

export interface DomainStore {
  // connections (secrets referenced, never stored in the clear here)
  createConnection(c: Omit<Connection, "id" | "created_at">): Promise<Connection>;
  getConnection(id: string): Promise<Connection | undefined>;
  listConnections(): Promise<Connection[]>;

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

  // living knowledge (per wedge)
  createKnowledge(k: Omit<KnowledgeItem, "id" | "created_at" | "updated_at">): Promise<KnowledgeItem>;
  getKnowledge(id: string): Promise<KnowledgeItem | undefined>;
  listKnowledge(wedge: string): Promise<KnowledgeItem[]>;
  updateKnowledge(id: string, patch: Partial<Pick<KnowledgeItem, "name" | "content" | "metadata">>): Promise<KnowledgeItem | undefined>;
  deleteKnowledge(id: string): Promise<boolean>;
}

const now = () => new Date().toISOString();
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
  async listConnections(): Promise<Connection[]> {
    return [...this.connections.values()];
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
  const url = process.env.MYCEL_DATABASE_URL;
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
