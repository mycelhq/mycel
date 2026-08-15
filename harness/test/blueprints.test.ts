import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, makeApp, makeFreshApp } from "./helpers";
import { blueprintFaults, loadBlueprint, listBlueprints, manifestSatisfiesBlueprint } from "../src/blueprints";
import { ALL_CAPABILITIES } from "../src/capabilities";
import { setSecret, initSecretStore, _resetKeyCache } from "../src/secrets";
import { getDomainStore } from "../src/domain";

const BP = "books-keeper";

type Item = {
  name?: string;
  kind?: string;
  capability?: string;
  what: string;
  why: string;
  done: boolean;
  action?: string;
  toolkit?: string;
  connection_id?: string;
  detail?: string;
  options?: { toolkit: string; label: string; via: string; read_tools: string[]; action: string }[];
  connected?: { toolkit: string; label: string; connection_id: string; readable: boolean }[];
};

/**
 * Stand in for the OAuth round trip.
 *
 * `verified_at` is what makes a row a CONNECTED provider rather than an authorise screen somebody
 * opened and closed. Setting only `connected_account_id` — which is what this helper used to do — is
 * the state an abandoned connect leaves behind, and it must not satisfy a checklist.
 */
async function connectToolkit(app: Parameters<typeof api>[0], toolkit: string, readTools: string[] = []): Promise<void> {
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const existing = (await domain.listConnections()).find(
    (x) => x.project_id === projectId && x.kind === "composio" && x.config?.toolkit === toolkit,
  );
  const config = { toolkit, connected_account_id: "ca_test", verified_at: new Date().toISOString(), read_tools: readTools };
  if (existing) await domain.updateConnection(existing.id, { config: { ...existing.config, ...config } });
  else
    await domain.createConnection({
      project_id: projectId,
      kind: "composio",
      name: toolkit,
      owner: { kind: "founder", id: "founder" },
      config,
    });
}

/**
 * Finish the checklist the way a founder does, now that a requirement is a CAPABILITY rather than a
 * brand: read the options the checklist offers, pick one, connect that.
 *
 * `pick` exists so one test can choose QuickBooks where another chooses Xero, and both can assert
 * the same blueprint goes live — which is the entire behaviour this change adds.
 */
async function satisfyChecklist(app: Parameters<typeof api>[0], pick: Record<string, string> = {}): Promise<void> {
  const { checklist } = (await api(app, `blueprints/${BP}/readiness`)).json as { checklist: Item[] };
  for (const item of checklist) {
    if (item.done) continue;
    if (item.capability) {
      const options = item.options ?? [];
      const chosen = options.find((o) => o.toolkit === pick[item.capability]) ?? options.find((o) => o.via === "composio");
      assert.ok(chosen, `${item.capability} offered nothing connectable`);
      await connectToolkit(app, chosen.toolkit, chosen.read_tools);
      continue;
    }
    if (!item.kind) continue;
    const r = await api(app, `blueprints/${BP}/connections/${item.name}/secret`, {
      method: "POST",
      body: JSON.stringify({ value: `tok-${item.name}` }),
    });
    assert.equal(r.json.ok, true, r.text);
  }
}

test("blueprints: only real slugs load — no path traversal", () => {
  assert.ok(loadBlueprint(BP));
  for (const bad of ["../../etc/passwd", "a/b", "x.json", ""]) {
    assert.equal(loadBlueprint(bad), null, `should reject: ${bad}`);
  }
  assert.ok(listBlueprints().length >= 2, "the shipped blueprints are discoverable");
});

test("blueprints: a blueprint file is safe to commit — it carries no secrets", () => {
  for (const b of listBlueprints()) {
    const text = JSON.stringify(b);
    assert.ok(!/sk_live|sk-ant|secret_value|"password"/i.test(text), `${b.blueprint} must not embed credentials`);
    for (const conn of b.requires_connections ?? []) {
      assert.ok(conn.why, `${b.blueprint}/${conn.name} must explain WHY it needs the connection`);
      assert.ok(!("secret" in conn), "a blueprint declares the need for a credential, never the value");
    }
  }
});

test("blueprints: provisioning creates a whole business and reports what's missing", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  const { app } = makeApp();

  assert.equal((await api(app, "blueprints/ghost/provision", { method: "POST" })).status, 404);

  const res = await api(app, `blueprints/${BP}/provision`, { method: "POST" });
  assert.equal(res.status, 201);
  const r = res.json;
  assert.equal(r.blueprint, BP);
  assert.equal(r.created.schedules.length, 3, "daily sync + receipt chase + month-end close");
  assert.ok(r.created.knowledge.length >= 1, "seed knowledge written");

  /**
   * NOT ONE CONNECTION ROW, and that is the assertion this test exists for.
   *
   * Provisioning used to create an empty, secret-less row per requirement. Nothing could execute
   * against those rows, and they were the entire content of a "still to connect" nag that followed
   * a founder around the product for a trade he was not in. What is missing is a fact about the
   * blueprint; the checklist below still knows every bit of it.
   */
  assert.equal((await api(app, "connections")).json.length, 0, "provisioning creates no connections");
  assert.ok(!("connections" in r.created), "and does not claim to have created any");

  // it is NOT ready — the founder still owes credentials, and we say so precisely
  assert.equal(r.ready, false);
  const missing = (r.checklist as Item[]).filter((i) => !i.done);
  assert.equal(missing.length, 3, "a bank feed, a ledger and a mailbox, none of them connected");
  for (const item of missing) {
    assert.ok(item.why, "every requirement says why it's needed");
    assert.equal(item.connection_id, undefined, "nothing exists yet, so nothing is pointed at");
    // Every item names a way to finish it. For a capability that is one call PER OPTION rather than
    // one call, because there is no single app — asserting `action` alone here is what used to hide
    // the fact that the single call named a vendor.
    if (item.capability) {
      assert.ok(item.options?.length, `${item.what} must offer something to connect`);
      for (const o of item.options) assert.match(o.action, /^POST \/v1\//);
    } else {
      assert.ok(item.action, `${item.what} must say how to finish it`);
      assert.match(item.action, /^POST \/v1\//);
    }
  }

  /**
   * THE BUG THIS TEST NOW PREVENTS: a bookkeeper on QuickBooks being told to connect Xero.
   *
   * The ledger requirement is a capability with real alternatives in it. Xero may be one of them —
   * it is a perfectly good answer — but it must not be the question, and nothing in the checklist
   * may present it as the only way to finish.
   */
  const ledger = (r.checklist as Item[]).find((i) => i.capability === "read_invoices");
  assert.ok(ledger, "the ledger requirement is on the checklist");
  assert.equal(ledger.kind, undefined, "a capability is not a connection kind");
  const slugs = (ledger.options ?? []).map((o) => o.toolkit);
  assert.ok(slugs.includes("quickbooks") && slugs.includes("xero"), `both are offered, got ${slugs.join(", ")}`);
  assert.ok(slugs.length >= 3, "and it is a real choice, not two");
  assert.ok(
    !/xero/i.test(ledger.what) && !/xero/i.test(ledger.why) && !/xero/i.test(ledger.detail ?? ""),
    "and no prose anywhere on the requirement names one vendor",
  );
  // Degrading honestly: an unsatisfied capability says what is missing, in a sentence.
  assert.match(ledger.detail!, /no accounting system is connected/);

  const mailbox = (r.checklist as Item[]).find((i) => i.capability === "send_email");
  assert.ok((mailbox?.options ?? []).some((o) => o.toolkit === "gmail"), "a founder's own Gmail is an answer to 'send email'");

  // the crux: schedules must NOT be live yet, or a credential-less business starts failing on a timer
  const scheds = (await api(app, "schedules")).json;
  assert.equal(scheds.length, 3);
  assert.ok(scheds.every((s: { enabled: boolean }) => s.enabled === false), "provisioned disabled");

  // And readiness SAYS it has been set up, rather than leaving Cloud to infer it from the existence
  // of connection rows — an inference that now always answers "never set up".
  assert.equal((await api(app, `blueprints/${BP}/readiness`)).json.provisioned, true);
});

test("blueprints: a desk with no clock still reports provisioned once seed knowledge exists", async () => {
  // isProvisioned used to return false when `schedules` was empty, so step 2 of /start never
  // appeared after Set it up. recruiting-desk now has a morning clock; this still covers the
  // knowledge fallback by asserting provisioned after a successful provision either way.
  const { app } = makeApp();
  const slug = "recruiting-desk";
  const before = (await api(app, `blueprints/${slug}/readiness`)).json;
  assert.equal(before.provisioned, false);
  await api(app, `blueprints/${slug}/provision`, { method: "POST", body: "{}" });
  assert.equal((await api(app, `blueprints/${slug}/readiness`)).json.provisioned, true);
});

test("blueprints: provisioning twice does not create a second business", async () => {
  // The domain store is a process singleton, so an earlier test in this file may already have
  // provisioned. Assert the ORDER-INDEPENDENT invariant: after N provisions the business exists
  // exactly once, and the last call created nothing.
  const { app } = makeApp();
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });
  const second = (await api(app, `blueprints/${BP}/provision`, { method: "POST" })).json;

  assert.equal(second.created.schedules.length, 0, "nothing new created on a repeat provision");
  assert.equal(second.reused.schedules.length, 3);

  const scheds = (await api(app, "schedules")).json as { name: string }[];
  assert.equal(scheds.filter((s) => s.name === "month-end close").length, 1, "exactly one close schedule");
});

test("blueprints: activation is REFUSED until the checklist is satisfied, then goes live", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 6).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  const { app } = makeApp();
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });

  // refused while credentials are missing — a business that would fail on its first tick
  const refused = await api(app, `blueprints/${BP}/activate`, { method: "POST" });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "not ready");
  assert.equal(refused.json.missing.length, 3);

  // supply the credentials the way a founder would
  await satisfyChecklist(app);

  const readiness = await api(app, `blueprints/${BP}/readiness`);
  assert.equal(readiness.json.ready, true, "checklist now satisfied");

  const live = await api(app, `blueprints/${BP}/activate`, { method: "POST" });
  assert.equal(live.status, 200);
  assert.equal(live.json.activated.length, 3);

  const scheds = ((await api(app, "schedules")).json as { wedge: string; enabled: boolean }[]).filter(
    (s) => s.wedge === BP,
  );
  assert.ok(scheds.length > 0 && scheds.every((s) => s.enabled), "the business is now running on its own clock");
});

test("blueprints: provisioning is recorded in the tamper-evident audit chain", async () => {
  const { app } = makeApp();
  const me = (await api(app, "me")).json;
  const projectId = me.projects[0].id;
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });

  const chain = (await api(app, `audit?project_id=${projectId}`)).json as { action: string; entity_id: string }[];
  assert.ok(chain.some((e) => e.action === "project.created" && e.entity_id === BP), "provisioning is auditable");
  assert.equal((await api(app, `audit/verify?project_id=${projectId}`)).json.ok, true);
});

test("blueprints: activating runs one job now instead of promising tomorrow", async () => {
  // next_run_at is the next strictly-future occurrence, computed at provision time. A founder who
  // finished setting up at 10:00 on a wedge that runs daily at 06:00 saw "your business is running"
  // and then nothing for twenty hours — right after being asked for credentials and taught the
  // thing their trade.
  const { app } = makeApp();
  const slug = "books-keeper";

  await api(app, `blueprints/${slug}/provision`, { method: "POST", body: "{}" });
  await satisfyChecklist(app);
  assert.equal((await api(app, `blueprints/${slug}/readiness`)).json.ready, true);

  const before = (await api(app, "tasks")).json.length;
  const activated = await api(app, `blueprints/${slug}/activate`, { method: "POST", body: "{}" });
  assert.equal(activated.status, 200, activated.text);
  assert.ok(activated.json.activated.length > 0, "schedules are on");

  // The point of the change: something to look at on the very next screen.
  assert.ok(activated.json.first_task_id, "activation returns the run it started");
  const after = (await api(app, "tasks")).json;
  assert.equal(after.length, before + 1);
  assert.ok(after.some((t: { id: string }) => t.id === activated.json.first_task_id));
});

test("blueprints: a pasted credential creates its connection, once", async () => {
  /**
   * The counterpart of provisioning creating nothing. Until this route existed there was no id to
   * POST a secret to unless provisioning had already made an empty row — which is the thing that
   * put a bookkeeping stack on the screen of a founder who is not a bookkeeper.
   *
   * Run against a FIXTURE blueprint, because no shipped one has a pasted requirement any more: both
   * of them used to, and both were the vendor-bound rows this change deleted. What survives the
   * change is `kind` for a thing that genuinely has no alternatives — a founder's own endpoint — and
   * that is exactly what this fixture declares.
   */
  const dir = mkdtempSync(join(tmpdir(), "mycel-bp-"));
  writeFileSync(
    join(dir, "bespoke.json"),
    JSON.stringify({
      blueprint: "bespoke",
      title: "A trade with one bespoke endpoint",
      summary: "s",
      wedge: "books-keeper",
      requires_connections: [
        { name: "yard-scales", kind: "custom", why: "Read the weighbridge.", config: { api_url: "https://scales.internal.acme-yard.co.uk" } },
        // `read_invoices` rather than an arbitrary capability: the boot gate now refuses a blueprint
        // asking for something its wedge's manifest does not declare (see the load-time-fault test
        // below), and `books-keeper` declares this one. The scene under test is the pasted
        // credential, not the capability — any declared capability serves.
        { name: "payments", capability: "read_invoices", why: "Know what has been billed." },
      ],
      schedules: [],
      seed_knowledge: [],
    }),
  );
  const prev = process.env.MYCEL_BLUEPRINTS_DIR;
  process.env.MYCEL_BLUEPRINTS_DIR = dir;
  try {
    const { app } = makeApp();
    const path = `blueprints/bespoke/connections/yard-scales/secret`;
    const first = await api(app, path, { method: "POST", body: JSON.stringify({ value: "tok-1" }) });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.created, true);

    const rows = (await api(app, "connections")).json as { name: string; kind: string; config: Record<string, unknown> }[];
    const row = rows.find((x) => x.name === "yard-scales");
    assert.ok(row, "the row appears the moment the founder supplies something, and not before");
    assert.equal(row.kind, "custom");
    // The blueprint's config comes with it. A bare row would leave the wedge holding a token with no
    // idea where to send it — a credential stored successfully and useless.
    assert.equal(row.config.api_url, "https://scales.internal.acme-yard.co.uk");

    // Replacing a credential must not leave two rows, one of which the wedge might pick.
    const again = await api(app, path, { method: "POST", body: JSON.stringify({ value: "tok-2" }) });
    assert.equal(again.json.created, false);
    assert.equal(again.json.connection_id, first.json.connection_id);
    assert.equal(((await api(app, "connections")).json as { name: string }[]).filter((x) => x.name === "yard-scales").length, 1);

    /**
     * A CAPABILITY HAS NO CREDENTIAL TO PASTE, and this is the newer half of the same bug.
     *
     * Taking a key here would create a connection row of some arbitrary kind, vault the founder's
     * credential in it, and answer `{ok: true}` on a requirement that is still unsatisfied — a
     * success report for work that did not happen, which is this repo's most expensive failure.
     */
    const cap = await api(app, `blueprints/bespoke/connections/payments/secret`, {
      method: "POST",
      body: JSON.stringify({ value: "sk-nope" }),
    });
    assert.equal(cap.status, 400);
    assert.match(cap.json.error, /read_invoices/, "and it says which capability, so the founder knows what to go and pick");
    assert.equal(((await api(app, "connections")).json as { name: string }[]).filter((x) => x.name === "payments").length, 0);

    // And it is not a general "create any connection you like and put a secret in it" route.
    const invented = await api(app, `blueprints/bespoke/connections/whatever/secret`, {
      method: "POST",
      body: JSON.stringify({ value: "x" }),
    });
    assert.equal(invented.status, 404);
  } finally {
    if (prev === undefined) delete process.env.MYCEL_BLUEPRINTS_DIR;
    else process.env.MYCEL_BLUEPRINTS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blueprints: a placeholder in a shipped config is refused at boot, not emailed to a client", () => {
  /**
   * THE BUG: `books-keeper.json` shipped `"api_url": "https://api.example-bank.com"` and
   * `"from": "books@yourdomain.com"` to real customers. Nothing downstream can tell a placeholder
   * from a setting — the row is created with it, the executor POSTs to it, and the second is a
   * plausible sender a client would have seen at the top of a receipt chase.
   *
   * Two assertions, and both matter: the shipped blueprints are clean NOW, and a new one that is not
   * stops the kernel rather than reaching a customer.
   */
  for (const b of listBlueprints()) {
    assert.deepEqual(blueprintFaults(b.blueprint, b), [], `${b.blueprint} ships something it should not`);
    const json = JSON.stringify(b);
    assert.ok(!/yourdomain\.com|example-bank\.com/i.test(json), `${b.blueprint} still carries a placeholder`);
  }

  const faults = blueprintFaults("bad", {
    requires_connections: [{ name: "mail", kind: "email", why: "w", config: { from: "books@yourdomain.com" } }],
  });
  assert.equal(faults.length, 1);
  assert.match(faults[0], /placeholder/);
  assert.match(faults[0], /must not ship/);
});

test("blueprints: a mistyped capability is refused, never silently dropped", () => {
  /**
   * THE BUG: ignore it, and the requirement vanishes from the checklist. The business then activates
   * one requirement short, the step it needed never runs, and every screen says it is ready. A typo
   * that removes a safety check is strictly worse than the vendor hardcode it replaced, because the
   * hardcode at least worked.
   */
  const faults = blueprintFaults("bad", {
    requires_connections: [{ name: "p", capability: "read_payment", why: "w" }],
  });
  assert.equal(faults.length, 1);
  assert.match(faults[0], /read_payment/);
  assert.match(faults[0], /did you mean "read_payments"/, "and it names the fix rather than listing the vocabulary");

  // A capability nobody could have meant gets the whole vocabulary instead of a wrong guess.
  const wild = blueprintFaults("bad", { requires_connections: [{ name: "p", capability: "fly_to_mars", why: "w" }] });
  assert.match(wild[0], /known capabilities: /);

  // Neither declared is also a refusal: a requirement nothing can satisfy is not a requirement.
  assert.match(blueprintFaults("bad", { requires_connections: [{ name: "p", why: "w" }] })[0], /neither/);
  // And both is a refusal, because a requirement that resolves two ways resolves neither predictably.
  assert.match(
    blueprintFaults("bad", { requires_connections: [{ name: "p", why: "w", kind: "email", capability: "send_email" }] })[0],
    /one or the other/,
  );
});

test("blueprints: a QuickBooks bookkeeper finishes the same setup, and never sees the word Xero", async () => {
  /**
   * THE BUG, in one sentence: `books-keeper.json` said `{"name": "xero"}`, so a bookkeeper who runs
   * QuickBooks was shown a checklist demanding an app they do not have, with no second option.
   *
   * This walks the whole flow picking QuickBooks at every step and asserts two things — that the
   * business actually goes live, and that no surface a founder reads mentions Xero at all.
   */
  const { app } = await makeFreshApp();
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });
  await satisfyChecklist(app, { read_invoices: "quickbooks", read_bank_transactions: "quickbooks" });

  const readiness = (await api(app, `blueprints/${BP}/readiness`)).json as { ready: boolean; checklist: Item[] };
  assert.equal(readiness.ready, true, "a QuickBooks business is as ready as a Xero one");

  const ledger = readiness.checklist.find((i) => i.capability === "read_invoices");
  assert.deepEqual(
    (ledger?.connected ?? []).map((c) => c.toolkit),
    ["quickbooks"],
    "and it is bound to what they actually use",
  );
  assert.ok(ledger?.connected?.[0].readable, "and the kernel can genuinely read it, not merely record that it exists");

  // The prose a founder reads, for every requirement still outstanding or satisfied.
  const prose = readiness.checklist.map((i) => `${i.what} ${i.why} ${i.detail ?? ""}`).join(" ");
  assert.ok(!/xero/i.test(prose), `no surface names another vendor: ${prose}`);
});

test("blueprints: an abandoned OAuth screen does not satisfy a requirement", async () => {
  /**
   * THE BUG: a connection row exists from the moment "Connect" is clicked, before the founder has
   * authorised anything — that is what the connect route does. Counting the row would turn a
   * half-finished OAuth into a green tick and a business that activates with no hands.
   */
  const { app } = await makeFreshApp();
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;
  await domain.createConnection({
    project_id: projectId,
    kind: "composio",
    name: "quickbooks",
    owner: { kind: "founder", id: "founder" },
    // Started, never finished: an account id and no `verified_at`.
    config: { toolkit: "quickbooks", connected_account_id: "ca_started", read_tools: ["QUICKBOOKS_QUERY_INVOICES"] },
  });

  const readiness = (await api(app, `blueprints/${BP}/readiness`)).json as { ready: boolean; checklist: Item[] };
  const ledger = readiness.checklist.find((i) => i.capability === "read_invoices");
  assert.equal(ledger?.done, false, "an unfinished connect is not a connection");
  assert.deepEqual(ledger?.connected, [], "and nothing is reported as bound");
  assert.equal((await api(app, `blueprints/${BP}/activate`, { method: "POST" })).status, 409);
});

test("capabilities: a capability nothing provides degrades honestly and says why", async () => {
  /**
   * THE BUG this prevents is the one `whyNoWedge` prevents one axis over: a feature with no provider
   * either crashing, or — worse — rendering an empty state that reads as "nothing to do here".
   * Most service businesses are paid by bank transfer and will never connect a payment provider.
   * That is a legitimate install, and it has to SAY what is missing rather than look finished.
   */
  const { app } = await makeFreshApp();
  const res = await api(app, "capabilities");
  assert.equal(res.status, 200, res.text);
  const items = res.json.items as { capability: string; ok: boolean; detail: string; options: unknown[] }[];
  assert.equal(items.length, ALL_CAPABILITIES.length, "every capability is reported, including the unmet ones");
  for (const i of items) {
    assert.equal(i.ok, false);
    assert.ok(i.detail.length > 20, `${i.capability} must say what is missing, got "${i.detail}"`);
    assert.ok(i.options.length > 0, `${i.capability} must offer a way out of the empty state`);
  }
  assert.match(
    items.find((i) => i.capability === "read_payments")!.detail,
    /bank transfer or a cash payment would not show up/,
    "and the payment one is worded exactly as paymentConfidence's `unverifiable` is, because they are the same fact",
  );
});

test("blueprints: a requirement the wedge cannot be granted is a load-time fault", () => {
  /**
   * THE BUG. `recruiting-desk` and `security-questionnaire` shipped with NO `capabilities` key in
   * their `wedge.json`, while their blueprints required `read_crm`, `write_crm` and `send_email`.
   * Connection grants are derived from the manifest, so every run of those wedges was handed zero
   * connections — and `capabilityGaps`, the thing that tells the agent what it is missing, is
   * derived from the SAME absent array, so nothing warned either. A founder connected a CRM and a
   * mailbox because the blueprint's checklist asked them to, saw both go green, and the agent got
   * nothing. Two derivations from one absent value cannot contradict each other.
   */
  const bad = {
    blueprint: "recruiting-desk",
    title: "t",
    summary: "s",
    wedge: "recruiting-desk",
    requires_connections: [{ name: "crm", capability: "read_payments", why: "w" }],
    schedules: [],
    seed_knowledge: [],
  };
  const faults = manifestSatisfiesBlueprint("recruiting-desk", bad);
  assert.equal(faults.length, 1, "a requirement the manifest cannot answer must be named");
  assert.match(faults[0], /read_payments/);
  assert.match(faults[0], /wedge\.json/, "and it says which file to fix");

  // The shipped catalogue satisfies its own blueprints — this is the assertion that would have
  // caught the bug on the day it landed.
  for (const bp of listBlueprints()) {
    assert.deepEqual(
      manifestSatisfiesBlueprint(bp.blueprint, bp),
      [],
      `${bp.blueprint} asks for a capability its wedge does not declare`,
    );
  }
});
