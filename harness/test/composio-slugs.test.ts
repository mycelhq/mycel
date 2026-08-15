/**
 * Composio send/book slug contract.
 *
 * Without a live API key we cannot prove Composio still exposes these tools — but we CAN prove the
 * capability table, the adapters, and the fixture stay aligned. Drift between those three is how a
 * "verified" comment becomes a lie. Live check: `COMPOSIO_API_KEY=… npx tsx harness/scripts/verify-composio-slugs.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityProviders } from "../src/capabilities";
import { BOOK_CALENDAR_ADAPTERS, SEND_EMAIL_ADAPTERS, hasActionShape } from "../src/capabilities.act";
import { EXPECTED_ACTION_SLUGS } from "../src/capabilities.slugs";
import { CALENDAR_SHAPES, hasShape } from "../src/capabilities.normalise";

test("send/book table slugs match the fixture and have adapters", () => {
  for (const [shape, slug] of Object.entries(EXPECTED_ACTION_SLUGS)) {
    if (shape === "google_calendar_events" || shape === "outlook_events") {
      assert.ok(hasShape("read_calendar", shape) || Object.hasOwn(CALENDAR_SHAPES, shape), `read shape ${shape} missing`);
      const found = capabilityProviders("read_calendar")
        .flatMap((p) => p.reads ?? [])
        .find((r) => r.shape === shape);
      assert.ok(found, `read_calendar table missing shape ${shape}`);
      assert.equal(found!.slug, slug);
      continue;
    }
    assert.ok(
      hasActionShape("send_email", shape) ||
        hasActionShape("book_calendar", shape) ||
        Object.hasOwn(SEND_EMAIL_ADAPTERS, shape) ||
        Object.hasOwn(BOOK_CALENDAR_ADAPTERS, shape),
      `action shape ${shape} has no adapter`,
    );

    const found = [...capabilityProviders("send_email"), ...capabilityProviders("book_calendar")]
      .flatMap((p) => p.actions ?? [])
      .find((a) => a.shape === shape);
    assert.ok(found, `capability table missing action shape ${shape}`);
    assert.equal(found!.slug, slug, `${shape} slug drifted from fixture`);
  }
});

test("gmail and outlook send shapes are wired for every composio send_email provider that declares actions", () => {
  for (const p of capabilityProviders("send_email")) {
    if (p.via !== "composio") continue;
    assert.ok(p.actions?.length, `${p.toolkit} send_email has no actions — agent would guess`);
    for (const a of p.actions ?? []) {
      assert.ok(Object.hasOwn(SEND_EMAIL_ADAPTERS, a.shape), `${a.shape} has no send adapter`);
      assert.ok(
        Object.values(EXPECTED_ACTION_SLUGS).includes(a.slug as never) || a.slug === "send_email",
        `unexpected send slug ${a.slug} on ${p.toolkit}`,
      );
    }
  }
});

test("UNVERIFIED composio slugs are named in source so they cannot silently become 'verified'", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8");
  // Ads / publish / bank still lack live reads — those blocks must stay marked UNVERIFIED.
  assert.match(src, /UNVERIFIED/);
  assert.match(src, /GMAIL_SEND_EMAIL/);
  assert.match(src, /OUTLOOK_OUTLOOK_SEND_EMAIL/);
  assert.match(src, /HUBSPOT_HUBSPOT_LIST_CONTACTS/);
  assert.match(src, /MYCEL_CAPABILITY_PROVIDERS/);
});
