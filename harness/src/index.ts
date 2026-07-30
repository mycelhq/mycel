import { serve } from "@hono/node-server";
import { API_KEY_GENERATED, loadConfig } from "./config";
import { closeAuditStore, initAuditStore } from "./audit";
import { closeDomainStore, getDomainStore, initDomainStore } from "./domain";
import { getIdentityStore, initIdentityStore } from "./identity";
import { recoverTasks } from "./recovery";
import { closeSecretStore, initSecretStore } from "./secrets";
import { startScheduler } from "./scheduler";
import { createServer } from "./server";
import { createStore } from "./store";
import { flushLogs } from "./tracing";

const { store, backend } = await createStore();
await initDomainStore(); // durable service surface when MYCEL_DATABASE_URL is set
await initIdentityStore(); // durable tenants (stable default ids either way)
await initSecretStore(); // encrypted-at-rest vault (AES-256-GCM)
await initAuditStore(); // tamper-evident audit chain
const identity = getIdentityStore();
const recovered = await recoverTasks(store);
const app = createServer(store);
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 4000);

const server = serve({ fetch: app.fetch, port });
const scheduler = startScheduler(store, getDomainStore());
console.log(
  `mycel-harness v0.1 on http://localhost:${port}  ` +
    `[sandbox=${cfg.sandboxBackend} store=${backend} model=${cfg.model}]` +
    (recovered ? `  recovered ${recovered} interrupted task(s)` : ""),
);
if (API_KEY_GENERATED) {
  console.log(
    `\n  ⚠  No MYCEL_API_KEY set — generated an ephemeral key for this run:\n` +
      `     ${cfg.apiKey}\n` +
      `     Send it as 'Authorization: Bearer <key>' on /v1 calls (products). Set MYCEL_API_KEY to keep it stable.`,
  );
}
if (identity.generatedPassword) {
  console.log(
    `\n  ⚠  No MYCEL_OWNER_PASSWORD set — generated an owner login for the portal:\n` +
      `     ${identity.ownerEmail}  /  ${identity.generatedPassword}\n` +
      `     Set MYCEL_OWNER_EMAIL / MYCEL_OWNER_PASSWORD to keep it stable.\n`,
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
  scheduler.stop();
  try {
    await store.close?.();
    await closeDomainStore();
    await closeSecretStore();
    await closeAuditStore();
    // Queued JSONL lines are still in memory (appends are non-blocking by design), so drain them
    // before exiting or the tail of an in-flight run is lost.
    await flushLogs();
  } catch (e) {
    console.error("[mycel] store close error:", e);
  }
  setTimeout(() => process.exit(0), 250).unref?.();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
