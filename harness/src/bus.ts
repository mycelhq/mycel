// In-process pub/sub for live SSE fan-out. Swap for Redis pub/sub to scale the API tier
// horizontally (use Redis to scale; see docs/ARCHITECTURE.md §5).
import { EventEmitter } from "node:events";
import type { TaskEvent } from "./contract";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(taskId: string, ev: TaskEvent): void {
  emitter.emit(taskId, ev);
}

export function subscribe(taskId: string, fn: (ev: TaskEvent) => void): () => void {
  emitter.on(taskId, fn);
  return () => emitter.off(taskId, fn);
}
