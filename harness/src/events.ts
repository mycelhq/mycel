// One place events are emitted: persist to the store, publish for live SSE, trace to observers.
import { publish } from "./bus";
import type { EventType } from "./contract";
import type { Store } from "./store";
import { getObserverFor } from "./tracing";
import { getIdentityStore } from "./identity";

/**
 * Which project a task belongs to.
 *
 * A task's project never changes, so this is safe to remember for the process's lifetime. Bounded
 * because a long-lived worker would otherwise accumulate one entry per task it has ever run.
 */
const taskProject = new Map<string, string | undefined>();
const TASK_PROJECT_MAX = 5000;

async function projectOf(store: Store, taskId: string): Promise<string | undefined> {
  if (taskProject.has(taskId)) return taskProject.get(taskId);
  const task = await store.getTask(taskId);
  if (taskProject.size >= TASK_PROJECT_MAX) taskProject.clear();
  taskProject.set(taskId, task?.project_id);
  return task?.project_id;
}

export async function emitEvent(
  store: Store,
  taskId: string,
  type: EventType,
  data: Record<string, unknown> = {},
): Promise<void> {
  const ev = await store.appendEvent(taskId, type, data);
  publish(taskId, ev);
  // Routed to the task's own project, so a founder's events land in their own Langfuse project.
  // The task→project mapping is memoised: a token-heavy run emits thousands of events, and looking
  // the task up on each one turned tracing into a per-event database query.
  const projectId = await projectOf(store, taskId);
  const observer = await getObserverFor(projectId, projectId ? getIdentityStore().getProject(projectId)?.name : undefined);
  // Tracing must never take down a task — swallow, don't leave an unhandled rejection.
  void Promise.resolve(observer.onEvent(taskId, ev)).catch((e) =>
    console.error("[mycel] observer.onEvent error:", e),
  );
}
