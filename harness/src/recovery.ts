// Crash recovery. On boot, any non-terminal task in a durable store was interrupted mid-run —
// its sandbox and OpenCode session are gone, so it can't be resumed in place. Mark it failed so
// nothing is stuck forever and any reconnecting SSE stream closes cleanly. In-memory persists
// nothing across restarts, so this is a no-op there.
import { markCancelled } from "./cancel";
import { emitEvent } from "./events";
import type { Store } from "./store";

export async function recoverTasks(store: Store): Promise<number> {
  const stuck = await store.listUnfinished();
  for (const t of stuck) {
    markCancelled(t.id);
    await store.setStatus(t.id, "failed");
    await emitEvent(store, t.id, "task.finished", {
      status: "failed",
      error: "interrupted by a restart",
    });
  }
  return stuck.length;
}
