import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { recoverTasks } from "./recovery";
import { createServer } from "./server";
import { createStore } from "./store";

const { store, backend } = await createStore();
const recovered = await recoverTasks(store);
const app = createServer(store);
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port });
console.log(
  `mycel-harness v0.1 on http://localhost:${port}  ` +
    `[sandbox=${cfg.sandboxBackend} store=${backend} model=${cfg.model}]` +
    (recovered ? `  recovered ${recovered} interrupted task(s)` : ""),
);
