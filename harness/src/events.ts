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
  const observer = await getObserver();
  void observer.onEvent(taskId, ev);
}
