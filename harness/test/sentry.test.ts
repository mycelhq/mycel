import { test } from "node:test";
import assert from "node:assert/strict";
import { safeUrl, scrub } from "../src/sentry.ts";

test("safeUrl strips query strings and collapses opaque ids", () => {
  assert.equal(safeUrl("https://kernel.example/v1/tasks/abcdefghijklmnopqrstuvwxyz12?token=secret"), "https://kernel.example/v1/tasks/:id");
  assert.equal(safeUrl("/v1/portal/enter?token=abc"), "/v1/portal/enter");
  assert.equal(safeUrl(""), undefined);
});

test("scrub drops request body, cookies, headers, and emails", () => {
  const event = scrub({
    request: {
      method: "POST",
      url: "https://x/v1/approvals/abcdefghijklmnopqrstuvwxyz12?foo=1",
      headers: { authorization: "Bearer live", cookie: "mycel_session=abc" },
      data: { api_key: "sk_live" },
    },
    user: { id: "mem_1", email: "founder@agency.com", ip_address: "1.2.3.4" },
    server_name: "ip-10-0-0-1",
    breadcrumbs: [
      { category: "console", message: "MYCEL_API_KEY=secret" },
      { category: "http", data: { method: "GET", url: "https://x/v1/me?token=1", status_code: 200 } },
    ],
  });

  assert.deepEqual(event.request, {
    method: "POST",
    url: "https://x/v1/approvals/:id",
  });
  assert.deepEqual(event.user, { id: "mem_1" });
  assert.equal(event.server_name, undefined);
  assert.equal(event.breadcrumbs?.some((c) => c.category === "console"), false);
  assert.equal((event.breadcrumbs?.[0]?.data as { url?: string })?.url, "https://x/v1/me");
});
