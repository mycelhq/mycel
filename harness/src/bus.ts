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

export function publish(taskId: string, ev: TaskEvent): void {
  emitter.emit(taskId, ev);
}

export function subscribe(taskId: string, fn: (ev: TaskEvent) => void): () => void {
  emitter.on(taskId, fn);
  return () => emitter.off(taskId, fn);
}
