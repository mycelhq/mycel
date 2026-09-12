// One place events are emitted: persist to the store, publish for live SSE, trace to observers.
import { publish } from "./bus";
import type { EventType } from "./contract";
import type { Store } from "./store";
import { getObserver } from "./tracing";

export async function emitEvent(
  store: Store,
  taskId: string,
  type: EventType,
  data: Record<string, unknown> = {},
): Promise<void> {
  const ev = await store.appendEvent(taskId, type, data);
  publish(taskId, ev);
  // One process-wide observer. Events used to be routed to a per-project observer so a founder's
  // traces landed in their own Langfuse project; that sink is gone (see tracing.ts) and tenancy is
  // now enforced where it always mattered — on the read side, by the scope check on
  // `GET /v1/tasks/:id/trace`. Nothing here needs the task's project, so nothing here reads it.
  const observer = await getObserver();
  // Tracing must never take down a task — swallow, don't leave an unhandled rejection.
  void Promise.resolve(observer.onEvent(taskId, ev)).catch((e) =>
    console.error("[mycel] observer.onEvent error:", e),
  );
}
