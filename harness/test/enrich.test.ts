// Email enrichment: the one paid hop, and the honesty of the waterfall that renders it.
//
// The bug this file is written against is a UI one with a data cause. `cloud/app/(app)/gtm/page.tsx`
// renders a multi-hop email-enrichment waterfall under every face, and there was no email resolver
// in the codebase at all — LinkedIn does not return addresses, so `person.email` was unresolvable by
// construction. Every face therefore showed empty hops and $0.00, which reads as a broken feature
// rather than an absent one.
//
// The failure mode the tests below actually guard is the OPPOSITE over-correction, and it is worse:
// a resolver that fakes the waterfall. `FULLENRICH_API_KEY` does not exist in any environment yet,
// so the common path in production today is "not configured", and the temptation is to write a
// plausible-looking `fullenrich` hop with `ok: false` so the screen has something on it. That would
// put a claim on a founder's screen — "we tried and it missed" — about a request that never left the
// building, in the one part of this product whose entire value is that its claims are checkable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore } from "../src/secrets";
import { getDomainStore } from "../src/domain";
import {
  bestEmail,
  emailProvenance,
  enrichEmails,
  enrichableFromGraph,
  fullEnrichConfigured,
  FULLENRICH_KEY_ENV,
  FULLENRICH_RATE_ENV,
  FULLENRICH_RESOLVER,
} from "../src/gtm/enrich";
import { PEOPLE_COLLECTION, VOYAGER_RESOLVER } from "../src/linkedin/graph";
import { gtmWedge } from "../src/gtm/stages";

await initSecretStore();
const domain = () => getDomainStore();

/** Run `fn` with the vendor configured, and always put the environment back. */
async function withKey(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A `people` row as `writePeople` leaves it: found on LinkedIn, no address, Voyager provenance. */
async function person(projectId: string, key: string, extra: Record<string, unknown> = {}) {
  return domain().upsertRecord({
    project_id: projectId,
    wedge: gtmWedge(),
    collection: PEOPLE_COLLECTION,
    key,
    data: {
      profile_id: key,
      name: "Dana Okafor",
      company_domain: "acme.com",
      linkedin_url: `https://www.linkedin.com/in/${key}`,
      provenance: { search: { by: VOYAGER_RESOLVER, cost_usd: 0, at: new Date().toISOString() } },
      ...extra,
    },
  });
}

test("with no key the resolver is cleanly ABSENT — no error, no row, and above all no invented hop", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: undefined, FIRECRAWL_API_KEY: undefined }, async () => {
    assert.equal(fullEnrichConfigured(), false);
    await person("p-unset", "dana-okafor");

    const r = await enrichEmails(domain(), { project_id: "p-unset" }, [{ key: "dana-okafor", name: "Dana Okafor" }]);
    assert.equal(r.ok, false);
    assert.equal(r.written, 0);
    assert.match(r.reason!, /FULLENRICH_API_KEY/, "the founder must be told the variable, not just that it failed");

    // THE ASSERTION THIS FILE EXISTS FOR. The row is untouched: no `email`, and no `provenance.email`
    // entry claiming a vendor was tried. The waterfall honestly shows the one hop that happened.
    const rows = await domain().queryRecords({ project_id: "p-unset", wedge: gtmWedge(), collection: PEOPLE_COLLECTION });
    const d = rows.find((x) => x.key === "dana-okafor")!.data as Record<string, unknown>;
    const prov = d.provenance as Record<string, unknown>;
    assert.equal(d.email, undefined);
    assert.equal(prov.email, undefined, "a hop was written for a request that never left the building");
    assert.ok(prov.search, "and the free hop that DID happen is still there");
  });
});

test("enrichment refuses without a project rather than writing into the wrong tenant", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key" }, async () => {
    // `upsertRecord` keys on (project, wedge, collection, key). An absent project does not fail — it
    // silently lands a paid-for email somewhere it does not belong. This codebase has had one
    // incident from a scoping argument that was optional-with-a-default; this one refuses first,
    // BEFORE the key check, so no money can be spent on an unscoped call either.
    const r = await enrichEmails(domain(), { project_id: "" }, [{ key: "dana-okafor" }]);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /needs a project/);
  });
});

test("the waterfall records the free MISS before the paid hit — otherwise the screen proves nothing", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key", [FULLENRICH_RATE_ENV]: undefined }, async () => {
    const p = emailProvenance("2026-01-01T00:00:00.000Z", true, 2).email as Record<string, unknown>;
    const attempts = p.attempts as Array<Record<string, unknown>>;

    assert.equal(attempts.length, 2, "one hop is not a waterfall — the point is that the cheap one was tried first");
    assert.equal(attempts[0].by, VOYAGER_RESOLVER);
    assert.equal(attempts[0].ok, false, "LinkedIn genuinely does not carry email — recording it as a hit is a lie");
    assert.equal(attempts[0].cost_usd, 0, "and Voyager's zero is a finding, so it stays explicit");
    assert.equal(attempts[1].by, FULLENRICH_RESOLVER);
    assert.equal(attempts[1].ok, true);
    assert.equal(attempts[1].credits, 2);

    // NO `cost_usd` ON THE PAID HOP when the plan rate is unknown. `cloud/lib/gtm.ts`
    // `readProvenance` SUMS hop costs into the total a founder reads as money spent, so a zero here
    // would under-report real spend — and it would destroy the meaning of Voyager's zero, which is
    // the one place in this product where $0.00 is a genuine claim.
    assert.equal(attempts[1].cost_usd, undefined, "unpriced credits were reported as free");
    assert.equal(p.cost_usd, undefined);
  });
});

test("a configured credit price turns credits into the dollars the waterfall totals", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key", [FULLENRICH_RATE_ENV]: "0.05" }, async () => {
    const p = emailProvenance("2026-01-01T00:00:00.000Z", true, 14).email as Record<string, unknown>;
    assert.equal(p.cost_usd, 0.7);
    assert.equal((p.attempts as Array<Record<string, unknown>>)[1].cost_usd, 0.7);
  });
});

test("a known-bad address is dropped — no address beats one that will certainly bounce", () => {
  // Ranked rather than first-wins. Putting a CATCH_ALL in front of a founder as though it were
  // verified is how a sending domain gets burned, and an INVALID is the one result guaranteed to
  // bounce, so it is worse than nothing.
  assert.deepEqual(bestEmail([{ email: "a@x.com", status: "CATCH_ALL" }, { email: "b@x.com", status: "DELIVERABLE" }]), {
    email: "b@x.com",
    status: "DELIVERABLE",
  });
  assert.equal(bestEmail([{ email: "a@x.com", status: "INVALID" }, { email: "b@x.com", status: "INVALID_DOMAIN" }]), undefined);
  assert.equal(bestEmail([]), undefined);
  assert.equal(bestEmail(undefined), undefined);
  assert.equal(bestEmail([{ email: "not-an-address", status: "DELIVERABLE" }]), undefined);
});

test("a result is matched back by the round-tripped key, never by array position", async () => {
  // FullEnrich returns `custom` unchanged, and the vendor gives no promise that `data` comes back in
  // the order it was sent — it is an asynchronous multi-provider waterfall, and rows finish when
  // they finish. Matching by index would put a paid-for email on the wrong prospect, which is both a
  // privacy problem and the sort of bug nobody notices for months.
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key", FULLENRICH_POLL_MS: "0", FULLENRICH_BASE_URL: "https://fullenrich.test/api/v2" }, async () => {
    await person("p-order", "dana-okafor");
    await person("p-order", "rui-silva", { name: "Rui Silva" });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = (h: unknown, status = 200) =>
        ({ ok: true, status, text: async () => JSON.stringify(h) }) as unknown as Response;
      if (init?.method === "POST") {
        // The key must be sent as a bearer token and must never appear anywhere else.
        assert.match(String((init.headers as Record<string, string>).authorization), /^Bearer test-key$/);
        return body({ enrichment_id: "job-1" });
      }
      return body({
        status: "FINISHED",
        cost: { credits: 4 },
        // REVERSED relative to the request, and only one of them resolved.
        data: [
          { custom: { user_id: "rui-silva" }, contact_info: { emails: [{ email: "rui@brightlane.io", status: "DELIVERABLE" }] } },
          { custom: { user_id: "dana-okafor" }, contact_info: { emails: [] } },
          { custom: { user_id: "somebody-we-never-sent" }, contact_info: { emails: [{ email: "x@x.com", status: "DELIVERABLE" }] } },
        ],
      });
    }) as typeof fetch;

    try {
      const targets = await enrichableFromGraph(domain(), "p-order", ["dana-okafor", "rui-silva"]);
      assert.equal(targets.length, 2);
      const r = await enrichEmails(domain(), { project_id: "p-order" }, targets);

      assert.equal(r.ok, true);
      assert.equal(r.found, 1);
      assert.equal(r.credits, 4);
      assert.equal(r.written, 2, "a miss is still written — its provenance is the record that we paid to look");

      const rows = await domain().queryRecords({ project_id: "p-order", wedge: gtmWedge(), collection: PEOPLE_COLLECTION });
      const rui = rows.find((x) => x.key === "rui-silva")!.data as Record<string, unknown>;
      const dana = rows.find((x) => x.key === "dana-okafor")!.data as Record<string, unknown>;

      assert.equal(rui.email, "rui@brightlane.io", "the address landed on the wrong person, or not at all");
      assert.equal(rui.email_status, "DELIVERABLE");
      // The miss writes NO email key. An explicit null would erase an address an earlier run found —
      // `upsertRecord` is a shallow merge, so a null really would overwrite.
      assert.equal(dana.email, undefined);
      assert.ok((dana.provenance as Record<string, unknown>).email, "the miss is still part of the story");
      // And the earlier Voyager provenance survives the merge, which is what makes it read as history.
      assert.ok((rui.provenance as Record<string, unknown>).search);

      const ruiEmail = (rui.provenance as { email?: { attempts?: Array<{ credits?: number }> } }).email;
      const danaEmail = (dana.provenance as { email?: { attempts?: Array<{ credits?: number }> } }).email;
      const ruiCredits = ruiEmail?.attempts?.[1]?.credits ?? 0;
      const danaCredits = danaEmail?.attempts?.[1]?.credits ?? 0;
      assert.equal(ruiCredits + danaCredits, 4, "batch credits must not be billed once per face");

      // A result for somebody we never submitted is dropped rather than written — an unrequested row
      // is either a vendor bug or a mixed-up job, and neither is a reason to create a person.
      assert.equal(rows.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("somebody who already has an address is not re-enriched — that is a credit for a known answer", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key" }, async () => {
    await person("p-skip", "already-known", { email: "known@acme.com" });
    await person("p-skip", "needs-one", {});
    const targets = await enrichableFromGraph(domain(), "p-skip", ["already-known", "needs-one", "not-in-graph"]);
    assert.deepEqual(targets.map((t) => t.key), ["needs-one"]);
    const empty = await enrichEmails(domain(), { project_id: "p-skip" }, []);
    assert.equal(empty.ok, false, "an empty selection is not a successful enrichment");
    assert.match(empty.reason!, /nobody to enrich/);
  });
});

test("another tenant's people are invisible to this project's enrichment", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key" }, async () => {
    await person("p-a", "shared-person");
    await person("p-b", "shared-person");
    // The same public identifier in two projects is normal — two customers may prospect the same
    // person. The read is scoped, so p-a can never spend credits on, or write an address onto, p-b.
    const targets = await enrichableFromGraph(domain(), "p-a", ["shared-person"]);
    assert.equal(targets.length, 1);
    const rows = await domain().queryRecords({ project_id: "p-a", wedge: gtmWedge(), collection: PEOPLE_COLLECTION });
    assert.equal(rows.length, 1);
  });
});

test("out of credits is a sentence a founder can act on, not a stack trace", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "test-key", FULLENRICH_POLL_MS: "0", FULLENRICH_BASE_URL: "https://fullenrich.test/api/v2" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(init?.method === "POST" ? { enrichment_id: "job-2" } : { status: "CREDITS_INSUFFICIENT" }),
      }) as unknown as Response) as typeof fetch;
    try {
      const r = await enrichEmails(domain(), { project_id: "p-credits" }, [{ key: "dana-okafor" }]);
      assert.equal(r.ok, false);
      assert.match(r.reason!, /out of credits/);
      assert.equal(r.written, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a vendor outage never throws, and never leaks the key into the reason a founder reads", async () => {
  await withKey({ [FULLENRICH_KEY_ENV]: "super-secret-key", FULLENRICH_POLL_MS: "0", FULLENRICH_BASE_URL: "https://fullenrich.test/api/v2" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED super-secret-key");
    }) as typeof fetch;
    try {
      const r = await enrichEmails(domain(), { project_id: "p-down" }, [{ key: "dana-okafor" }]);
      assert.equal(r.ok, false);
      assert.ok(r.reason);
      // The detail is surfaced to a founder and stored on a task. A vendor that echoes the request,
      // or an error string built from it, is how a credential ends up in a support screenshot.
      assert.ok(!r.reason!.includes("super-secret-key"), "the API key reached a message a human reads");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ─────── an unavailable path says so, instead of returning empty ───────

test("gtm: an unavailable enrichment path says so instead of returning an empty list", async () => {
  /**
   * THE BUG THIS NAMES. `FULLENRICH_API_KEY` has never been set in ANY environment of this
   * product — it is absent from `.env.example`, from the Terraform, from the buildspec and from
   * Secrets Manager. So email enrichment has never once worked in production. `enrichEmails`
   * refuses honestly, which was always right, but the refusal was only ever legible to whoever
   * POSTed at the route: no surface anywhere reported that the capability was off, so the only way
   * to find out was to design an outreach motion around it and then watch it 501.
   *
   * The assertion is not "it returns nothing" — it always did. It is that the emptiness ARRIVES
   * WITH ITS REASON ATTACHED, naming the variable a founder can act on, and that `ok` is false so
   * no caller can mistake it for a successful enrichment that found nobody.
   */
  await withKey({ [FULLENRICH_KEY_ENV]: undefined, FIRECRAWL_API_KEY: undefined }, async () => {
    assert.equal(fullEnrichConfigured(), false, "the fixture only means anything with the key off");

    const r = await enrichEmails(domain(), { project_id: "proj-a" }, [
      { key: "ada-l", name: "Ada Lovelace", company_domain: "analytical.co" },
    ]);

    // Not merely empty — refused, with the variable named.
    assert.equal(r.ok, false, "an unavailable path must never report success");
    assert.ok(r.reason, "an empty result with no reason is the silent failure this repo keeps paying for");
    assert.match(r.reason!, new RegExp(FULLENRICH_KEY_ENV), "name the thing a founder can actually set");
    assert.equal(r.written, 0);
    assert.equal(r.found, 0);

    // And nothing was invented to fill the screen: no credits, no cost, no fabricated hop claiming
    // "we tried and missed" about a request that never left the building.
    assert.equal(r.credits, 0);
    assert.equal(r.cost_usd, undefined);
    assert.deepEqual(r.people, []);
  });
});

test("gtm: enrichment that is paid for and then not stored is a failure, not a success", async () => {
  /**
   * THE BUG THIS NAMES. Each per-person `upsertRecord` is wrapped in a `try/catch` that logs and
   * continues — correct per row, because one bad record must not discard a batch already charged
   * for. But with the graph unreachable EVERY row takes that branch, `written` lands on 0, and this
   * function used to return `ok: true` regardless. The founder was charged, told it worked, and had
   * an empty CRM; no caller anywhere branched on `written`, so nothing downstream could notice on
   * their behalf.
   *
   * Driven through the real function with a store whose writes throw, so the assertion is about the
   * behaviour and not about a hand-made result object.
   */
  // Only the WRITE is broken; every other method behaves normally, so this exercises the real path
  // right up to the point of storage rather than a store that fails at the first touch.
  const broken = new Proxy(domain(), {
    get(target, prop, receiver) {
      if (prop === "upsertRecord") {
        return async () => {
          throw new Error("graph unreachable");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  await withKey(
    {
      [FULLENRICH_KEY_ENV]: "test-key",
      FULLENRICH_POLL_MS: "0",
      FULLENRICH_BASE_URL: "https://fullenrich.test/api/v2",
    },
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
        const body = (h: unknown) =>
          ({ ok: true, status: 200, text: async () => JSON.stringify(h) }) as unknown as Response;
        if (init?.method === "POST") return body({ enrichment_id: "job-broken" });
        return body({
          status: "FINISHED",
          cost: { credits: 3 },
          data: [
            {
              custom: { user_id: "ada-l" },
              contact_info: { emails: [{ email: "ada@analytical.co", status: "DELIVERABLE" }] },
            },
          ],
        });
      }) as typeof fetch;

      try {
        const r = await enrichEmails(broken, { project_id: "proj-broken" }, [
          { key: "ada-l", name: "Ada Lovelace", company_domain: "analytical.co" },
        ]);
        // The vendor answered and charged us: the address really was found.
        assert.equal(r.found, 1);
        assert.equal(r.credits, 3);
        // And none of it survived.
        assert.equal(r.written, 0);
        assert.equal(r.ok, false, "credits spent and nothing kept is a failure, whatever the HTTP call did");
        assert.match(
          r.reason ?? "",
          /not saved|could be written/i,
          "say what was LOST — the founder needs to know the addresses were paid for and are gone",
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );
});
