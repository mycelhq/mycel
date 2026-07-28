import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createServer } from "./server";
import { createStore } from "./store";

const { store, backend } = await createStore();
const app = createServer(store);
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port });
console.log(
  `mycel-harness v0.1 on http://localhost:${port}  ` +
    `[sandbox=${cfg.sandboxBackend} store=${backend} model=${cfg.model}]`,
);
