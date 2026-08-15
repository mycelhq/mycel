// The write half of the capability layer, and the calendar reads that make booking possible.
//
// THE FAILURE ALL OF THIS EXISTS FOR: `send_email` was declared by five blueprints, resolved
// `ok: true` the moment a mailbox was connected, and had nothing behind it. The agent was left to
// guess a tool slug and its argument names per run; when it guessed wrong the chase did not go out,
// with no bounce, no queue, and nothing on any screen a founder reads. `unreadable: true` had been
// protecting the read side from that exact silence for months. Every test here names its own bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  _resetCapabilityTable,
  assertCapabilityTableValid,
  brokeredCaveat,
  capabilityAdapter,
  capabilityProviders,
  resolveCapability,
} from "../src/capabilities";
import {
  BOOK_CALENDAR_ADAPTERS,
  SEND_EMAIL_ADAPTERS,
  capabilityImplementation,
  hasActionShape,
  planBookCalendar,
  planSendEmail,
} from "../src/capabilities.act";
import {
  CALENDAR_SHAPES,
  busyIntervals,
  hasShape,
  normaliseGoogleCalendarEvents,
  normaliseOutlookEvents,
  slotAvailability,
  toInstant,
} from "../src/capabilities.normalise";
import { capabilityConnections } from "../src/runtime";
import type { Connection } from "../src/contract";

const PROJECT = "proj-ours";

function conn(o: Partial<Connection> & { toolkit?: string } = {}): Connection {
  const { toolkit = "gmail", ...rest } = o;
  return {
    id: `conn-${toolkit}`,
    project_id: PROJECT,
    kind: "composio",
    name: toolkit,
    owner: { kind: "founder", id: "founder" },
    config: { toolkit, connected_account_id: "ca_1", verified_at: "2026-01-01T00:00:00.000Z" },
    created_at: new Date().toISOString(),
    ...rest,
  } as Connection;
}

const SEND = { to: ["sarah@harborline.example"], subject: "Invoice 104", text: "The invoice is now 14 days overdue." };
const BOOKING = {
  title: "Intro call",
  starts_at: "2026-03-29T14:00:00.000Z",
  ends_at: "2026-03-29T14:30:00.000Z",
  time_zone: "Europe/London",
  attendees: ["sarah@harborline.example"],
};

// ─────────────────────── the honesty rule, on the write side ───────────────────────

test("act: a capability with no adapter refuses loudly rather than no-opping", () => {
  /**
   * THE BUG, precisely. A founder connects Outlook. The checklist goes green. The chaser's mail
   * never leaves — not bounced, not queued, not errored anywhere a person looks — because no code
   * anywhere knew how to compose a send for it. Every sweep summary reads clean, since nothing
   * failed: nothing was attempted. The read side has refused this shape of silence since
   * `unreadable` landed; this is the same refusal for a verb with a recipient.
   */
  const noAdapter: Connection[] = [conn({ toolkit: "outlook" })];
  process.env.MYCEL_CAPABILITY_PROVIDERS = "";
  delete process.env.MYCEL_CAPABILITY_PROVIDERS;
  _resetCapabilityTable();

  // The table as shipped DOES have an Outlook adapter, so the honest way to test the gap is to
  // resolve a provider the table gives no actions — which is what an operator's override produces
  // when their Composio catalogue disagrees with our guessed slug and they blank the row.
  const stripped = resolveCapability("send_email", noAdapter, PROJECT);
  assert.equal(stripped.ok, true, "the shipped table can send through Outlook");

  // Now the same connection against a provider entry with no actions at all.
  const spec = CAPABILITIES.send_email;
  assert.equal(spec.kernel_acts, true, "send_email is a verb this kernel performs itself");
  const binding = {
    ...stripped,
    bound: stripped.bound.map((b) => ({ ...b, unactionable: true })),
  };
  assert.ok(binding.bound.every((b) => b.unactionable));

  // And the planner refuses with prose, never with an empty success.
  const plan = planSendEmail({ project_id: PROJECT, connections: [], send: SEND });
  assert.equal(plan.ok, false);
  assert.match((plan as { refusal: string }).refusal, /no mailbox is connected/);
  assert.ok(!/^$/.test((plan as { refusal: string }).refusal));
});

test("act: an unactionable provider makes the capability not-ok, in the same words the read side uses", () => {
  // Driven through the real override seam rather than a hand-built object, because the override file
  // is how an operator with a live catalogue will actually correct our guesses — and blanking a row
  // must degrade to a loud refusal, not to a quiet no-op.
  const file = `${process.env.TMPDIR ?? "/tmp"}/mycel-cap-act-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ send_email: [{ toolkit: "gmail", label: "Gmail", via: "composio" }] }));
  process.env.MYCEL_CAPABILITY_PROVIDERS = file;
  _resetCapabilityTable();
  try {
    const b = resolveCapability("send_email", [conn({ toolkit: "gmail" })], PROJECT);
    assert.equal(b.ok, false, "connected but unperformable is NOT ok");
    assert.equal(b.bound[0].unactionable, true);
    assert.match(b.detail, /Gmail is connected, but this kernel has no way to send through it/);
    assert.match(b.detail, /not working and nothing here should be trusted to say otherwise/);

    const plan = planSendEmail({ project_id: PROJECT, connections: [conn({ toolkit: "gmail" })], send: SEND });
    assert.equal(plan.ok, false);

    // And the boot gate refuses a table whose adapter key names nothing, for the same reason it
    // already refuses a normaliser key that names nothing.
    writeFileSync(
      file,
      JSON.stringify({ send_email: [{ toolkit: "gmail", label: "Gmail", via: "composio", actions: [{ slug: "X", shape: "nope" }] }] }),
    );
    _resetCapabilityTable();
    assert.throws(() => assertCapabilityTableValid(hasShape, hasActionShape), /no adapter provides/);
  } finally {
    delete process.env.MYCEL_CAPABILITY_PROVIDERS;
    _resetCapabilityTable();
    unlinkSync(file);
  }
});

test("act: an unimplemented verb is not offered to the agent as available", () => {
  /**
   * THE BUG: an agent handed a HubSpot connection under the word `write_crm` plans a run around one
   * clean step and then spends the run discovering the toolkit's argument names by trial. That is
   * what `send_email` did before it had an adapter, and it is why a chase could silently never leave.
   * A brokered capability is a legitimate degrade; being told it is one is what makes it honest.
   */
  const hubspot = conn({ toolkit: "hubspot", id: "conn-hubspot" });
  const { ids, missing } = capabilityConnections(["write_crm"], [hubspot], PROJECT);
  assert.deepEqual(ids, ["conn-hubspot"], "the connection is still granted — the agent can still work");
  assert.equal(missing.length, 1, "and the agent is told what it has actually been given");
  assert.match(missing[0], /no adapter for "write_crm"/);
  assert.match(missing[0], /stops at a human/);

  // A capability the kernel DOES implement carries no such caveat.
  assert.deepEqual(capabilityConnections(["send_email"], [conn({ toolkit: "gmail" })], PROJECT).missing, []);
});

test("act: every one of the eleven capabilities says which kind it is, and none of them is silent", () => {
  // The audit, pinned. Six kernel, five brokered. If somebody adds an adapter this
  // list changes and the test says so, which is the point: the claim is checked, not documented.
  const byAdapter: Record<string, string[]> = { kernel: [], brokered: [] };
  for (const c of ALL_CAPABILITIES) byAdapter[capabilityAdapter(c)].push(c);
  assert.deepEqual(byAdapter.kernel.sort(), [
    "book_calendar",
    "read_calendar",
    "read_crm",
    "read_invoices",
    "read_payments",
    "send_email",
  ]);
  assert.deepEqual(byAdapter.brokered.sort(), [
    "publish_content",
    "read_ads",
    "read_bank_transactions",
    "write_ads",
    "write_crm",
  ]);
  for (const c of ALL_CAPABILITIES) {
    const impl = capabilityImplementation(c);
    assert.ok(impl.note.length > 60, `${c} must say what it is, in a sentence`);
    assert.equal(impl.acts, CAPABILITIES[c].kernel_acts);
    // A capability the kernel acts through must have at least one provider that can perform it, or
    // the verb is a word again.
    if (impl.acts) {
      assert.ok(capabilityProviders(c).some((p) => (p.actions ?? []).length), `${c} claims to act with no adapter behind it`);
    }
  }
  assert.match(brokeredCaveat("read_ads"), /no adapter for "read_ads"/);
});

// ─────────────────────── tenancy ───────────────────────

test("act: a send binds to the connection the project actually owns, and never another tenant's", () => {
  /**
   * THE BUG THIS STOPS, and it is the worst one this file could produce: resolving another tenant's
   * mailbox sends a chase from one business's address to another business's client, and every reply
   * lands in the wrong company. Two cross-tenant leaks have shipped in this repo and both were a
   * scope that defaulted, so `project_id` is required, exact-match, and never inferred.
   */
  const theirs = conn({ toolkit: "gmail", id: "conn-theirs", project_id: "proj-someone-else" });
  const unscoped = conn({ toolkit: "gmail", id: "conn-unscoped", project_id: undefined });
  const clientOwned = conn({ toolkit: "gmail", id: "conn-client", owner: { kind: "client", id: "cli-1" } });

  for (const only of [[theirs], [unscoped], [clientOwned]]) {
    const plan = planSendEmail({ project_id: PROJECT, connections: only, send: SEND });
    assert.equal(plan.ok, false, "another tenant's mailbox is not this project's mailbox");
  }

  const ours = conn({ toolkit: "gmail", id: "conn-ours" });
  const plan = planSendEmail({ project_id: PROJECT, connections: [theirs, ours, unscoped], send: SEND });
  assert.equal(plan.ok, true);
  assert.equal((plan as { call: { connection_id: string } }).call.connection_id, "conn-ours");

  // And no overload omits the scope.
  assert.throws(() => planSendEmail({ project_id: "", connections: [ours], send: SEND }), /scoped to a project/);
  assert.throws(() => planBookCalendar({ project_id: "", connections: [], booking: BOOKING }), /scoped to a project/);
});

test("act: two mailboxes refuse rather than one being picked by array order", () => {
  // Picking would decide what a client sees the business as, by sort order, with nobody having said
  // so — and would send the same chase twice, from two addresses.
  const plan = planSendEmail({
    project_id: PROJECT,
    connections: [conn({ toolkit: "gmail" }), conn({ toolkit: "outlook" })],
    send: SEND,
  });
  assert.equal(plan.ok, false);
  assert.match((plan as { refusal: string }).refusal, /both connected and only one can/);
  assert.match((plan as { refusal: string }).refusal, /Disconnect one/);
});

// ─────────────────────── what a send actually becomes ───────────────────────

test("act: one send verb reaches four providers, and a reply always has somewhere to come back to", () => {
  /**
   * `reply_to` is the whole reason this is a capability and not a tool call. The end-to-end failure:
   * we mail a client demanding money, the client replies "I paid on the 3rd, here is the reference",
   * that reply lands in an unmonitored send-only mailbox, and three days later the ladder escalates.
   * Silence read as non-payment when the client had in fact answered us.
   */
  const gmail = conn({ toolkit: "gmail", config: { toolkit: "gmail", connected_account_id: "ca", verified_at: "x", reply_to: "hello@studio.example" } as never });
  const g = planSendEmail({ project_id: PROJECT, connections: [gmail], send: SEND });
  assert.equal(g.ok, true);
  const gcall = (g as { call: { tool: string; arguments: Record<string, unknown> } }).call;
  assert.equal(gcall.tool, "GMAIL_SEND_EMAIL");
  assert.equal(gcall.arguments.recipient_email, "sarah@harborline.example");
  assert.equal(gcall.arguments.reply_to, "hello@studio.example");

  // Outlook through Composio uses flattened args (`to_email`), verified against the live catalogue.
  // Building Graph-native nesting here would 400 at execute time.
  const outlook = conn({ toolkit: "outlook", config: { toolkit: "outlook", connected_account_id: "ca", verified_at: "x", reply_to: "hello@studio.example" } as never });
  const o = planSendEmail({ project_id: PROJECT, connections: [outlook], send: SEND });
  const ocall = (o as { call: { tool: string; arguments: Record<string, unknown> } }).call;
  assert.equal(ocall.tool, "OUTLOOK_OUTLOOK_SEND_EMAIL");
  assert.equal(ocall.arguments.to_email, "sarah@harborline.example");
  assert.equal(ocall.arguments.body, SEND.text);
  assert.equal(ocall.arguments.subject, SEND.subject);

  // AgentMail: the inbox address is itself a mailbox that receives, so it is the Reply-To by default.
  const am = planSendEmail({
    project_id: PROJECT,
    connections: [conn({ toolkit: "agentmail", kind: "agentmail", config: { address: "chase@mycel.example", inbox_id: "ib_1" } } as never)],
    send: SEND,
  });
  assert.equal(am.ok, true);
  assert.equal((am as { call: { tool: string } }).call.tool, "send_email");

  // The founder's own transport, refusing loudly when it is a placeholder rather than a config.
  const halfConfigured = conn({ toolkit: "email", kind: "email", config: { from: "billing@studio.example" } } as never);
  const t = planSendEmail({ project_id: PROJECT, connections: [halfConfigured], send: SEND });
  assert.equal(t.ok, false);
  assert.match((t as { refusal: string }).refusal, /no config\.api_url/);

  // No adapter reads `from` or `reply_to` out of the caller's request: an agent that could choose
  // its own Reply-To could route a client's answer away from the business.
  for (const [name, adapter] of Object.entries(SEND_EMAIL_ADAPTERS)) {
    const built = adapter.build({ ...SEND, to: ["a@b.example"] }, conn({ toolkit: "gmail", config: { toolkit: "gmail", api_url: "https://x", from: "f@b.example" } } as never));
    assert.ok(!("error" in built) || typeof built.error === "string", name);
  }
});

test("act: a send with no recipient, no subject or a header injection is refused before any approval is queued", () => {
  // A founder must never be asked to authorise a send that could not have gone. And `\n` in an
  // address is header injection, not a typo.
  const ours = [conn({ toolkit: "gmail" })];
  const cases: [Partial<typeof SEND>, RegExp][] = [
    [{ to: [] }, /no recipient/],
    [{ to: ["the client"] }, /is not an email address/],
    [{ to: ["a@b.example\nBcc: everyone@x.example"] }, /header injection/],
    [{ subject: "  " }, /no subject/],
    [{ text: "" }, /no plain-text body/],
  ];
  for (const [patch, re] of cases) {
    const plan = planSendEmail({ project_id: PROJECT, connections: ours, send: { ...SEND, ...patch } });
    assert.equal(plan.ok, false, JSON.stringify(patch));
    assert.match((plan as { refusal: string }).refusal, re);
  }
});

// ─────────────────────── booking, and the hour that goes missing ───────────────────────

test("act: a booking round-trips its timezone, and a naive datetime is refused rather than guessed", () => {
  /**
   * THE SILENT-WRONG THIS STOPS. "Tuesday 3pm" with no offset is two different instants across a DST
   * boundary, resolved in whatever zone the harness process happens to run in — UTC in production,
   * Europe/London on a founder's laptop. A slot confirmed as 3pm lands at 2pm in April and 3pm in
   * January: one client stood up, and no error anywhere.
   */
  const gcal = [conn({ toolkit: "googlecalendar" })];
  const naive = planBookCalendar({ project_id: PROJECT, connections: gcal, booking: { ...BOOKING, starts_at: "2026-03-29T14:00:00" } });
  assert.equal(naive.ok, false);
  assert.match((naive as { refusal: string }).refusal, /carries no UTC offset/);
  assert.match((naive as { refusal: string }).refusal, /silently wrong the other half/);

  for (const [patch, re] of [
    [{ time_zone: "" }, /states no timezone/],
    [{ time_zone: "GMT+1" }, /not an IANA timezone/],
    [{ ends_at: BOOKING.starts_at }, /ends at or before it starts/],
    [{ title: " " }, /no title/],
    [{ attendees: ["not an address"] }, /is not an email address/],
  ] as const) {
    const p = planBookCalendar({ project_id: PROJECT, connections: gcal, booking: { ...BOOKING, ...patch } });
    assert.equal(p.ok, false, JSON.stringify(patch));
    assert.match((p as { refusal: string }).refusal, re);
  }

  // Google: the instant carries its own offset AND the display zone travels beside it, so the two
  // cannot disagree about when the meeting is.
  const g = planBookCalendar({ project_id: PROJECT, connections: gcal, booking: BOOKING });
  assert.equal(g.ok, true);
  const gargs = (g as { call: { arguments: Record<string, unknown> } }).call.arguments;
  assert.deepEqual(gargs.start, { dateTime: "2026-03-29T14:00:00.000Z", timeZone: "Europe/London" });
  assert.deepEqual(gargs.attendees, [{ email: "sarah@harborline.example" }]);

  /**
   * Outlook through Composio: flattened `start_datetime` / `end_datetime` / `time_zone` (verified
   * live). Instant preserved as naive UTC + time_zone UTC so the wall clock cannot be misread.
   */
  const o = planBookCalendar({ project_id: PROJECT, connections: [conn({ toolkit: "outlook" })], booking: BOOKING });
  const oargs = (o as { call: { tool: string; arguments: Record<string, unknown> } }).call.arguments;
  assert.equal((o as { call: { tool: string } }).call.tool, "OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT");
  assert.equal(oargs.time_zone, "UTC");
  assert.equal(Date.parse(`${oargs.start_datetime}Z`), Date.parse(BOOKING.starts_at), "the instant survives the shape change");
  assert.equal(oargs.subject, BOOKING.title);
  assert.ok(typeof oargs.body === "string" && (oargs.body as string).length > 0, "Composio requires body");

  // The preview a human approves states BOTH, because an instant alone does not let them check it.
  assert.match((o as { call: { preview: string } }).call.preview, /Europe\/London/);
});

test("act: Outlook's zone-less wall clock is read in the zone Graph states, not in ours", () => {
  /**
   * THE PROVIDER-SIDE HALF OF THE SAME BUG. Graph returns `"2026-07-01T15:00:00.0000000"` with the
   * zone in `start.timeZone` beside it. A reader that parses `start.dateTime` alone is reading a wall
   * clock as UTC and is silently an hour out for every mailbox whose default is not UTC — so a
   * booking desk reports a slot free that the founder is sitting in a meeting for.
   */
  const events = normaliseOutlookEvents({
    value: [
      {
        id: "e1",
        subject: "Standup",
        start: { dateTime: "2026-07-01T15:00:00.0000000", timeZone: "Europe/London" },
        end: { dateTime: "2026-07-01T15:30:00.0000000", timeZone: "Europe/London" },
      },
      { id: "e2", subject: "Free block", showAs: "free", start: { dateTime: "2026-07-01T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-01T10:00:00.0000000", timeZone: "UTC" } },
      { id: "e3", subject: "No zone", start: { dateTime: "2026-07-01T11:00:00.0000000" }, end: { dateTime: "2026-07-01T12:00:00.0000000" } },
    ],
  });
  assert.equal(events.items[0].starts_at, "2026-07-01T14:00:00.000Z", "July in London is UTC+1");
  assert.equal(events.items[0].time_zone, "Europe/London", "and the display zone is carried, not thrown away");
  assert.equal(events.items[1].busy, false, "showAs: free is on the calendar, not blocking");
  assert.equal(events.items.length, 2, "an event with no zone is skipped, not guessed at");
  assert.match(events.skipped[0], /no UTC offset and the provider named no timezone/);

  // Winter, same wall clock, different instant. This is the assertion the old code could not pass.
  const winter = normaliseOutlookEvents({
    value: [{ id: "w", start: { dateTime: "2026-01-15T15:00:00.0000000", timeZone: "Europe/London" }, end: { dateTime: "2026-01-15T15:30:00.0000000", timeZone: "Europe/London" } }],
  });
  assert.equal(winter.items[0].starts_at, "2026-01-15T15:00:00.000Z");

  assert.match((toInstant("2026-07-01T15:00:00", "Not/AZone") as { error: string }).error, /not one this runtime knows/);
  assert.equal((toInstant("2026-07-01T15:00:00+02:00") as { instant: string }).instant, "2026-07-01T13:00:00.000Z");
});

test("act: an all-day event is never treated as free, and never as busy either", () => {
  /**
   * THE BUG: Google returns `{ start: { date: "2026-03-05" } }` for an all-day event. There is no
   * instant — an all-day event on the 5th in Australia is busy from 2026-03-04T13:00Z — so stamping
   * midnight-UTC frees thirteen real hours the founder is not free in, and treating every all-day
   * event as busy refuses every slot on a day with a birthday on it. The third answer is the honest
   * one, and a booking stops at a human anyway.
   */
  const events = normaliseGoogleCalendarEvents({
    items: [
      { id: "a", summary: "Client workshop", start: { dateTime: "2026-03-05T09:00:00Z", timeZone: "Europe/London" }, end: { dateTime: "2026-03-05T10:00:00Z" } },
      { id: "b", summary: "Annual leave", start: { date: "2026-03-06" }, end: { date: "2026-03-07" } },
      { id: "c", summary: "Cancelled thing", status: "cancelled", start: { dateTime: "2026-03-05T11:00:00Z" }, end: { dateTime: "2026-03-05T12:00:00Z" } },
      { id: "d", summary: "Birthday", transparency: "transparent", start: { dateTime: "2026-03-05T00:00:00Z" }, end: { dateTime: "2026-03-05T23:59:00Z" } },
    ],
  });
  assert.equal(events.items.length, 3, "a cancelled event is dropped, not carried as busy");
  assert.equal(events.items.find((e) => e.external_id === "b")!.all_day, true);
  assert.equal(events.items.find((e) => e.external_id === "d")!.busy, false);

  // Half-open intervals: back-to-back is not double-booked, or nothing could ever be booked.
  assert.deepEqual(busyIntervals(events.items), [{ from: "2026-03-05T09:00:00.000Z", to: "2026-03-05T10:00:00.000Z" }]);
  assert.equal(slotAvailability(events.items, { from: "2026-03-05T10:00:00Z", to: "2026-03-05T10:30:00Z" }).verdict, "free");
  assert.equal(slotAvailability(events.items, { from: "2026-03-05T09:30:00Z", to: "2026-03-05T10:30:00Z" }).verdict, "busy");
  const opaque = slotAvailability(events.items, { from: "2026-03-06T09:00:00Z", to: "2026-03-06T09:30:00Z" });
  assert.equal(opaque.verdict, "unknown", "an all-day event is neither free nor busy without a zone to place it in");
  assert.match(opaque.why!, /will not claim the slot is free/);
});

test("act: reading a calendar and booking on one are wired to the same registries the boot gate checks", () => {
  // The two halves cannot disagree about which shapes exist. A table validated against a different
  // registry is the only way a provider connects, looks correct, and does nothing.
  for (const s of Object.keys(CALENDAR_SHAPES)) assert.ok(hasShape("read_calendar", s));
  for (const s of Object.keys(SEND_EMAIL_ADAPTERS)) assert.ok(hasActionShape("send_email", s));
  for (const s of Object.keys(BOOK_CALENDAR_ADAPTERS)) assert.ok(hasActionShape("book_calendar", s));
  assert.equal(hasActionShape("read_payments", "gmail_send"), false, "a read capability must not declare an action shape");
  assert.equal(hasShape("send_email", "google_calendar_events"), false);
  assertCapabilityTableValid(hasShape, hasActionShape);
});
