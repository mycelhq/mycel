import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimited } from "../src/rate-limit";
import { platformOfUrl } from "../src/meetings";
import { publicHttpsUrl } from "../src/gtm/firecrawl";
import { unsafeHost } from "../src/public-url";

test("rateLimited trips after max in the window", () => {
  const key = `rl-${Date.now()}-${Math.random()}`;
  assert.equal(rateLimited(key, 3), false);
  assert.equal(rateLimited(key, 3), false);
  assert.equal(rateLimited(key, 3), false);
  assert.equal(rateLimited(key, 3), true);
});

test("decimal and hex IP hosts are unsafe; trailing-dot Meet is still Meet", () => {
  assert.equal(unsafeHost("2130706433"), true);
  assert.equal(unsafeHost("0x7f000001"), true);
  assert.equal(unsafeHost("meet.google.com."), false);
  assert.equal(platformOfUrl("https://meet.google.com./aaa-bbbb-ccc"), "google_meet");
  assert.equal(publicHttpsUrl("https://169.254.169.254/latest"), undefined);
});
