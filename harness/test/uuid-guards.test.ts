// A MALFORMED ID IS A 500 IN PRODUCTION AND A MISS IN EVERY TEST.
//
// ═══ THE FAILURE THIS EXISTS FOR, FROM SENTRY ═══
//
//   error: invalid input syntax for type uuid: ""
//     domain.pg.ts:748  listThreadsForClient
//     graph.ts:507      expand            ← listThreadsForClient(node.client_id ?? "")
//     ask.ts:460        ask
//     chat.ts:314       chat              ← POST /v1/chat, 500
//
// `cases.client_id` is a NULLABLE uuid: a case with no client is legal and the schema says so. The
// graph walk coerced that null to `""` and handed it to a uuid column, so a founder asking "what's
// going on with this?" about a clientless engagement got a 500.
//
// ═══ WHY NOTHING CAUGHT IT ═══
//
// `InMemoryStore` filters JavaScript arrays. `""` matches no row, the method returns `[]`, and that is
// exactly what the caller wanted — so the entire suite passes on the backend that is not in production
// while the one that is throws. This is the same blind spot `pg-casts.test.ts` was written for, and the
// same remedy: assert the SQL layer's guard as source, because running it needs a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

test("every single-id read in the pg domain store refuses an id no row can have", () => {
  const pg = read("domain.pg.ts");
  /**
   * Found by SHAPE, not by a list of method names. A list is a thing the next method is not on — and
   * the next method is the one that takes the 500, because the author copies a sibling that was
   * written before the guard existed.
   */
  const unguarded: string[] = [];
  for (const m of pg.matchAll(/async (\w+)\(id: string\)[^{]*\{([\s\S]{0,600}?)\n  \}/g)) {
    const [, name, body] = m;
    if (!/pool\.query\(/.test(body!)) continue;
    // Only the reads keyed on a uuid column by a single parameter.
    if (!/(?:FROM|UPDATE|DELETE FROM)\s+\w+\s+WHERE\s+id=\$1/i.test(body!.replace(/\s+/g, " "))) continue;
    if (!/isUuid\(id\)/.test(body!)) unguarded.push(name!);
  }
  assert.deepEqual(
    unguarded,
    [],
    `these pass an unchecked id to a uuid column — "" is a 500, not a miss:\n  ${unguarded.join("\n  ")}`,
  );
});

test("listThreadsForClient answers an empty client with no threads", () => {
  // NOT a uuid check on the client: a non-empty id that is not a uuid still throws, and should —
  // something built an id rather than reading one, and hiding that would hide a real bug.
  const pg = read("domain.pg.ts");
  const fn = pg.slice(pg.indexOf("async listThreadsForClient"), pg.indexOf("async addMessage"));
  assert.match(fn, /if \(!clientId\) return \[\];/, "an empty client id reaches a uuid column");
});

test("the graph never coerces a missing client into an id", () => {
  /**
   * The call site, because the store's guard is the second line of defence and not the fix. A case with
   * no client has no threads, so the read is skipped — which is also one less query per walked node.
   */
  const graph = read("graph.ts");
  const code = graph.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  assert.ok(
    !/listThreadsForClient\([^)]*\?\?\s*""\)/.test(code),
    'graph.ts coerces a missing client to "" again — that is the 500 in POST /v1/chat',
  );
  assert.match(code, /node\.client_id\s*\n?\s*\?\s*\(await stores\.domain\.listThreadsForClient\(node\.client_id\)\)/,
    "the clientless branch must skip the read rather than coerce the id");
});
