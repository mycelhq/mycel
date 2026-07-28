import { serve } from "@hono/node-server";
import { API_KEY_GENERATED, loadConfig } from "./config";
import { recoverTasks } from "./recovery";
import { createServer } from "./server";
import { createStore } from "./store";

const { store, backend } = await createStore();
const recovered = await recoverTasks(store);
const app = createServer(store);
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 4000);

const server = serve({ fetch: app.fetch, port });
console.log(
  `mycel-harness v0.1 on http://localhost:${port}  ` +
    `[sandbox=${cfg.sandboxBackend} store=${backend} model=${cfg.model}]` +
    (recovered ? `  recovered ${recovered} interrupted task(s)` : ""),
);
if (API_KEY_GENERATED) {
  console.log(
    `\n  ⚠  No MYCEL_API_KEY set — generated an ephemeral key for this run:\n` +
      `     ${cfg.apiKey}\n` +
      `     Send it as 'Authorization: Bearer <key>' on /v1 calls. Set MYCEL_API_KEY to keep it stable.\n`,
  );
}

// Graceful shutdown: stop accepting connections, let in-flight work settle briefly, release the
// store (pg pool), then exit. Prevents dropped connections and leaked pools on deploy/restart.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[mycel] ${signal} — shutting down…`);
  server.close();
  try {
    await store.close?.();
  } catch (e) {
    console.error("[mycel] store close error:", e);
  }
  setTimeout(() => process.exit(0), 250).unref?.();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
