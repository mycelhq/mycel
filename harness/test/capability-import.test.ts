/**
 * CRM / calendar import — normalisers + pull → clients / events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDomainStore } from "../src/domain";
import {
  CRM_SHAPES,
  hasShape as hasNormShape,
  normaliseAttioPeople,
  normaliseHubspotContacts,
  normalisePipedrivePersons,
  normaliseSalesforceContacts,
} from "../src/capabilities.normalise";
import { EXPECTED_CRM_READ_SLUGS } from "../src/capabilities.slugs";
import { capabilityProviders } from "../src/capabilities";
import { importCrmClients, setImportDeps, syncCalendar } from "../src/capability-import";
import type { Connection } from "../src/contract";

const PROJECT = "proj-import";

test("CRM table slugs match the fixture and have normalisers", () => {
  for (const [shape, slug] of Object.entries(EXPECTED_CRM_READ_SLUGS)) {
    assert.ok(hasNormShape("read_crm", shape) || Object.hasOwn(CRM_SHAPES, shape), `missing shape ${shape}`);
    const found = capabilityProviders("read_crm")
      .flatMap((p) => p.reads ?? [])
      .find((r) => r.shape === shape);
    assert.ok(found, `read_crm table missing ${shape}`);
    assert.equal(found!.slug, slug);
  }
});

test("HubSpot / Pipedrive / Salesforce / Attio normalisers skip contacts without email", () => {
  const hs = normaliseHubspotContacts({
    results: [
      { id: "1", properties: { email: "a@ex.com", firstname: "Ada", lastname: "Lovelace" } },
      { id: "2", properties: { firstname: "No", lastname: "Mail" } },
    ],
  });
  assert.equal(hs.items.length, 1);
  assert.equal(hs.items[0].email, "a@ex.com");
  assert.equal(hs.skipped.length, 1);

  const pd = normalisePipedrivePersons({
    data: [
      { id: 9, name: "Bob", email: [{ value: "b@ex.com", primary: true }] },
      { id: 10, name: "Silent" },
    ],
  });
  assert.equal(pd.items.length, 1);
  assert.equal(pd.items[0].external_id, "9");

  const sf = normaliseSalesforceContacts({
    records: [
      { Id: "003", FirstName: "C", LastName: "Dee", Email: "c@ex.com" },
      { Id: "004", LastName: "Nope" },
    ],
  });
  assert.equal(sf.items.length, 1);

  const at = normaliseAttioPeople({
    data: [
      {
        id: { record_id: "rec_1" },
        values: { email_addresses: [{ email_address: "d@ex.com" }], name: [{ full_name: "Dee" }] },
      },
      { id: { record_id: "rec_2" }, values: { name: [{ full_name: "No email" }] } },
    ],
  });
  assert.equal(at.items.length, 1);
  assert.equal(at.items[0].email, "d@ex.com");
});

test("importCrmClients creates clients by email and matches on second pass", async () => {
  const domain = new InMemoryDomainStore();
  const hubspot = {
    id: "conn-hs",
    project_id: PROJECT,
    kind: "composio",
    name: "HubSpot",
    owner: { kind: "founder", id: "f" },
    config: {
      toolkit: "hubspot",
      connected_account_id: "ca",
      verified_at: "2026-01-01T00:00:00.000Z",
      read_tools: ["HUBSPOT_HUBSPOT_LIST_CONTACTS"],
    },
    created_at: new Date().toISOString(),
  } as Connection;

  setImportDeps({
    listConnections: async () => [hubspot],
    execute: async () => ({
      ok: true,
      data: {
        results: [
          { id: "1", properties: { email: "ada@ex.com", firstname: "Ada", lastname: "L" } },
          { id: "2", properties: { email: "bob@ex.com", firstname: "Bob" } },
        ],
      },
    }),
    domain,
  });

  const first = await importCrmClients({ project_id: PROJECT });
  assert.equal(first.ok, true);
  assert.equal(first.created, 2);
  assert.equal((await domain.listClients()).length, 2);

  const second = await importCrmClients({ project_id: PROJECT });
  assert.equal(second.ok, true);
  assert.equal(second.created, 0);
  assert.equal(second.matched, 2);
  assert.equal((await domain.listClients()).length, 2);

  setImportDeps(null);
});

test("syncCalendar persists events and reports next busy", async () => {
  const domain = new InMemoryDomainStore();
  const gcal = {
    id: "conn-gcal",
    project_id: PROJECT,
    kind: "composio",
    name: "Google Calendar",
    owner: { kind: "founder", id: "f" },
    config: {
      toolkit: "googlecalendar",
      connected_account_id: "ca",
      verified_at: "2026-01-01T00:00:00.000Z",
      read_tools: ["GOOGLECALENDAR_EVENTS_LIST"],
    },
    created_at: new Date().toISOString(),
  } as Connection;

  setImportDeps({
    listConnections: async () => [gcal],
    execute: async () => ({
      ok: true,
      data: {
        items: [
          {
            id: "e1",
            summary: "Standup",
            start: { dateTime: "2099-03-05T09:00:00Z", timeZone: "UTC" },
            end: { dateTime: "2099-03-05T09:30:00Z" },
          },
        ],
      },
    }),
    domain,
  });

  const summary = await syncCalendar({ project_id: PROJECT, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(summary.ok, true);
  assert.equal(summary.observed, 1);
  assert.equal(summary.busy_next, "2099-03-05T09:00:00.000Z");
  const rows = await domain.queryRecords({
    project_id: PROJECT,
    wedge: "kernel",
    collection: "calendar_events",
  });
  assert.equal(rows.length, 1);

  setImportDeps(null);
});
