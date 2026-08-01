/**
 * Client-context façade — one read (and one write) over the objects that already hold a customer's
 * history. This is NOT a new memory model, and that is the point: adding a `ClientMemory` table
 * would create a second place for the truth to live and immediately start disagreeing with the
 * first. It aggregates what exists:
 *
 *   Client (profile + preferences)
 *   + Thread / Message           conversation history
 *   + Case                       long-lived engagements for this client
 *   + Artifacts from their Tasks "prior deliverables"
 *   + KnowledgeItem tagged with metadata.client_id  (optional grounding about them)
 *
 * Two definitions worth being explicit about, because both were ambiguous before:
 * - **preferences** = `Client.preferences` — operational settings (tone, timezone, billing day).
 *   Not a KnowledgeItem tag; the agent should be able to read one without a search.
 * - **prior deliverables** = Artifacts on tasks whose `client_id` is this client. Not a new
 *   artifact subtype — artifacts are already the work-product primitive, and now that Task carries
 *   a top-level `client_id` the join is enough.
 *
 * Artifacts come back WITHOUT content (`listArtifactsForTasks`). A context read fans out over a
 * client's whole history, so inlining bodies here is how you serialise a few hundred megabytes into
 * one JSON response.
 */
import type { Artifact, Case, Client, KnowledgeItem, Message, Thread } from "./contract";
import type { DomainStore } from "./domain";
import type { Store } from "./store";

export interface ClientContextThread extends Thread {
  messages: Message[];
}

export interface ClientContext {
  client: Client;
  threads: ClientContextThread[];
  cases: Case[];
  /** Artifacts from this client's tasks, metadata only — the concrete meaning of "prior deliverables". */
  deliverables: Omit<Artifact, "content">[];
  /** Knowledge items whose `metadata.client_id` matches (optional client-specific grounding). */
  knowledge: KnowledgeItem[];
}

export interface ClientContextPatch {
  display_name?: string;
  handles?: string[];
  metadata?: Record<string, unknown>;
  /** Merged into existing preferences (shallow) — a patch of one key must not drop the others. */
  preferences?: Record<string, unknown>;
}

/** How many of a client's tasks to consider. A long-running account can have thousands. */
const TASK_WINDOW = 200;

export async function getClientContext(
  domain: DomainStore,
  store: Store,
  clientId: string,
): Promise<ClientContext | undefined> {
  const client = await domain.getClient(clientId);
  if (!client) return undefined;

  const threads = await domain.listThreadsForClient(clientId);
  const threadsWithMessages: ClientContextThread[] = await Promise.all(
    threads.map(async (t) => ({ ...t, messages: await domain.listMessages(t.id) })),
  );

  // Scoped to the client's own project, not just their client_id: the id came in on a URL, and a
  // tenant filter that is only enforced one level up is a tenant filter waiting to be bypassed.
  const cases = await domain.listCases({ project_id: client.project_id, client_id: clientId });

  const tasks = await store.listTasks({ client_id: clientId, limit: TASK_WINDOW });
  const deliverables = await store.listArtifactsForTasks(tasks.map((t) => t.id));

  // Optional: knowledge tagged for this client. Knowledge is wedge-scoped, so we only scan the
  // wedges that actually appear on this client's cases and tasks rather than every wedge installed.
  const wedges = new Set<string>();
  for (const k of cases) wedges.add(k.wedge);
  for (const t of tasks) wedges.add(t.wedge);
  const knowledge: KnowledgeItem[] = [];
  for (const wedge of wedges) {
    const items = await domain.listKnowledge(wedge, client.project_id ?? "");
    for (const item of items) {
      if (item.metadata?.client_id === clientId) knowledge.push(item);
    }
  }

  return { client, threads: threadsWithMessages, cases, deliverables, knowledge };
}

export async function updateClientContext(
  domain: DomainStore,
  clientId: string,
  patch: ClientContextPatch,
): Promise<Client | undefined> {
  const existing = await domain.getClient(clientId);
  if (!existing) return undefined;

  const next: Parameters<DomainStore["updateClient"]>[1] = {};
  if (patch.display_name !== undefined) next.display_name = patch.display_name;
  if (patch.handles !== undefined) next.handles = patch.handles;
  // metadata and preferences MERGE rather than replace. Callers here are UIs and agents patching a
  // single key; a replace would silently erase every other preference the business had captured.
  if (patch.metadata !== undefined) next.metadata = { ...existing.metadata, ...patch.metadata };
  if (patch.preferences !== undefined) {
    next.preferences = { ...(existing.preferences ?? {}), ...patch.preferences };
  }
  return domain.updateClient(clientId, next);
}
