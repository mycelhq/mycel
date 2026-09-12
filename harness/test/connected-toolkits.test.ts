/**
 * `GET /v1/composio/toolkits?connected=1` — the marks of the apps a business actually runs on.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS FOR, WHICH I SHIPPED
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The first version read `connected` only at the filtering step, so without `all=1` the fetch was
 * Composio's FIRST PAGE and the filter answered "which of the first fifty toolkits have you
 * connected". A founder whose Xero sits on page three would have seen no marks at all.
 *
 * Silent, too: an empty list is a legitimate answer for an account with nothing connected, so the
 * failure looks exactly like the healthy case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const route = src.slice(
  src.indexOf('app.get("/v1/composio/toolkits"'),
  src.indexOf('app.get("/v1/composio/categories"'),
);

test("needed=1 hides our own plumbing from the founder's marks", () => {
  // `connected` alone put a Supabase logo on Home under the words "Your service". Seven of this
  // tenant's ten connected toolkits are infrastructure — neon, tavily, firecrawl, codeinterpreter.
  // Deliberately not a denylist: that list grows every time we add one, and the failure is silent.
  assert.match(route, /const neededOnly = yes\(c\.req\.query\("needed"\)\);/,
    "the marks are back to showing every connected toolkit");
  assert.match(route, /capabilityProviders\(cap\)\.map\(\(p\) => p\.toolkit\.toLowerCase\(\)\)/,
    "the capability -> toolkit mapping is no longer consulted");
});

test("connected=1 reads the whole catalogue, not one page of it", () => {
  assert.match(route, /const all = yes\(c\.req\.query\("all"\)\) \|\| connectedOnly;/,
    "`connected` no longer implies the full catalogue — it can only see the first page");
});

test("the flag is read once, so the fetch and the filter cannot disagree", () => {
  // Two independent reads of the same query param is how one branch ends up filtering a page the
  // other branch did not fetch.
  assert.equal((route.match(/c\.req\.query\("connected"\)/g) ?? []).length, 1,
    "`connected` is parsed more than once in this route");
});

test("a pending OAuth flow is not an app this business runs on", () => {
  // `POST /connect` writes the row before the founder authorises anything. Showing that logo would
  // claim a capability the agent does not have.
  assert.match(route, /!connectedOnly \|\| isLive\(mine\.get\(t\.slug\)\)/,
    "the filter no longer tests `isLive`, so half-finished connections would show");
});
