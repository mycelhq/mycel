#!/usr/bin/env npx tsx
/**
 * Live check: every EXPECTED_ACTION_SLUGS + EXPECTED_CRM_READ_SLUGS entry exists in the Composio
 * catalogue for its toolkit.
 *
 * Skips (exit 0) without COMPOSIO_API_KEY. Fail (exit 1) when a fixture slug is missing live —
 * that is the signal to correct via MYCEL_CAPABILITY_PROVIDERS or update the fixture.
 */
import { EXPECTED_ACTION_SLUGS, EXPECTED_CRM_READ_SLUGS } from "../src/capabilities.slugs";
import { capabilityProviders } from "../src/capabilities";
import { listTools } from "../src/composio";

const key = process.env.COMPOSIO_API_KEY;
if (!key) {
  console.log("COMPOSIO_API_KEY unset — skipping live slug verification");
  process.exit(0);
}

const toolkitForShape = (shape: string): string | undefined => {
  for (const cap of ["send_email", "book_calendar", "read_calendar", "read_crm"] as const) {
    for (const p of capabilityProviders(cap)) {
      for (const a of p.actions ?? []) {
        if (a.shape === shape) return p.toolkit;
      }
      for (const r of p.reads ?? []) {
        if (r.shape === shape) return p.toolkit;
      }
    }
  }
  return undefined;
};

let failed = 0;
for (const [shape, slug] of Object.entries({ ...EXPECTED_ACTION_SLUGS, ...EXPECTED_CRM_READ_SLUGS })) {
  const toolkit = toolkitForShape(shape);
  if (!toolkit) {
    console.error(`no toolkit for shape ${shape}`);
    failed++;
    continue;
  }
  try {
    const tools = await listTools(
      { apiKey: key, baseUrl: process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev" },
      { toolkit, limit: 200 },
    );
    const hit = tools.some((t) => t.slug?.toUpperCase() === slug.toUpperCase());
    if (!hit) {
      console.error(`MISSING ${slug} in toolkit ${toolkit} (shape ${shape})`);
      failed++;
    } else {
      console.log(`ok ${toolkit}/${slug}`);
    }
  } catch (e) {
    console.error(`catalogue fetch failed for ${toolkit}:`, (e as Error).message);
    failed++;
  }
}

process.exit(failed ? 1 : 0);
