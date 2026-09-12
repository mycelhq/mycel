// In-process pub/sub for live SSE fan-out.
//
// This is a LATENCY OPTIMISATION, not the transport. Every event is persisted before it is
// published, with a monotonic per-task id, and the SSE endpoint already replays from the store using
// `Last-Event-ID`. So a browser attached to instance B can see an event emitted on instance A by
// reading the log — no shared broker required.
//
// That's why the kernel does not need Redis pub/sub to run more than one replica: the durable event
// log IS the bus, and this emitter just avoids waiting for the next poll on the common path where
// the producer and the subscriber happen to be the same process.
import { EventEmitter } from "node:events";
import type { TaskEvent } from "./contract";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * The firehose channel: every event, whatever task it belongs to.
 *
 * A task id is a valid channel name and `"*"` is not one, so there is no collision to worry about.
 * It exists for the org-wide feed (`GET /v1/events`), which cannot subscribe per task because the
 * task it most wants to hear about is the one that has not been created yet.
 *
 * `TaskEvent` already carries `task_id`, so nothing extra is plumbed through `emitEvent` — and,
 * importantly, nothing here knows about tenancy. A subscriber to this channel sees every project in
 * the process and MUST scope what it forwards itself. That check lives in server.ts, on the read
 * side, exactly like it does for `eventsAfter`.
 */
const ALL = "*";

export function publish(taskId: string, ev: TaskEvent): void {
  emitter.emit(taskId, ev);
  emitter.emit(ALL, ev);
}

export function subscribe(taskId: string, fn: (ev: TaskEvent) => void): () => void {
  emitter.on(taskId, fn);
  return () => emitter.off(taskId, fn);
}

/** Every event emitted by THIS process, unscoped. See the note on `ALL`. */
export function subscribeAll(fn: (ev: TaskEvent) => void): () => void {
  emitter.on(ALL, fn);
  return () => emitter.off(ALL, fn);
}
