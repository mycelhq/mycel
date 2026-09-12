// The profile read, after LinkedIn retired the only endpoint we had.
//
// On 2026-08-18 `/identity/profiles/{id}/profileView` began answering 410 Gone and every LinkedIn
// read in the product died at once: `get_profile`, `view_profile`, and — because an invitation is
// addressed by member urn and a slug cannot be computed into one — `send_invite` as well.
// linkedin-health.test.ts covers the half of the fix that made that failure QUIET. This file covers
// the half that makes it SURVIVABLE: a ladder of candidate endpoints, a latch onto whichever one
// answers, a parser tolerant enough to read whichever shape comes back, and — when nothing works —
// a permanent, named failure carrying the exact devtools capture that would fix it.
//
// What is verified here and what is not, stated plainly, because the distinction is the whole
// problem: every branch of the LADDER is verified against a mocked transport, and every shape the
// PARSER accepts is verified against a fixture. What no test in this repo can verify is which
// candidate LinkedIn actually answers today — that needs a live session, and
// `packages/linkedin/scripts/verify-profile.ts` is the tool for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore } from "../src/secrets";
import { getDomainStore } from "../src/domain";
import { connectWithSession, sendLinkedInInvite, _setVerifier } from "../src/linkedin/connect";
import { _setFetch } from "../src/linkedin/proxy";
import { _resetUsage } from "../src/linkedin/meter";
import {
  parseProfile,
  parseProfilePage,
  profileQueryIdFromHtml,
  profileStrategyState,
  readProfile,
  _resetProfileStrategies,
} from "../src/linkedin/profile";
import { resolveProfileUrn } from "../src/linkedin/invites";
import {
  PROFILE_DEVTOOLS_CAPTURE,
  PROFILE_ENDPOINT_UNKNOWN_CODE,
  classifyVoyagerFailure,
  linkedinBlocked,
  _resetLinkedInHealth,
} from "../src/linkedin/health";

const SESSION = { li_at: "AQEDx", jsessionid: '"ajax:1"' };
const ctx = (id = "conn-profile") => ({ connectionId: id, proxyUrl: "http://u:p@resi.example:8080" });

function reset(): void {
  _resetProfileStrategies();
  _resetLinkedInHealth();
  _resetUsage();
}

function res(status: number, body: string, json = true): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "content-length" ? String(body.length) : null) },
    text: async () => body,
  } as unknown as Response;
}

const jsonRes = (status: number, body: unknown) => res(status, JSON.stringify(body));

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

/** The dash finder's answer: `elements[0]`, attributed strings, positions in a sibling collection. */
const DASH = {
  elements: [
    {
      publicIdentifier: "dana-okafor",
      firstName: { text: "Dana" },
      lastName: { text: "Okafor" },
      entityUrn: "urn:li:fsd_profile:ACoAAADANA",
      headline: { text: "VP Engineering at Acme" },
      geoLocation: { defaultLocalizedName: "Austin, Texas" },
      industry: { name: "Software" },
      profilePicture: {
        displayImageReference: {
          vectorImage: {
            rootUrl: "https://media.licdn.com/dms/image/",
            artifacts: [
              { width: 100, fileIdentifyingUrlPathSegment: "small.jpg" },
              { width: 800, fileIdentifyingUrlPathSegment: "large.jpg" },
            ],
          },
        },
      },
      profileTopPosition: {
        elements: [
          {
            title: "VP Engineering",
            companyName: "Acme",
            companyUrn: "urn:li:fsd_company:1234",
            company: { universalName: "acme", companyPageUrl: "https://www.acme.com/about" },
          },
        ],
      },
    },
  ],
};

/** The legacy profileView document. Kept as a fixture because the parser must still read it. */
const LEGACY = {
  profile: {
    publicIdentifier: "dana-okafor",
    firstName: "Dana",
    lastName: "Okafor",
    entityUrn: "urn:li:fs_miniProfile:ACoAAADANA",
    headline: "VP Engineering at Acme",
    geoLocationName: "Austin, Texas",
    industryName: "Software",
    summary: "Builds platform teams.",
  },
  positionView: {
    elements: [
      { title: "VP Engineering", companyName: "Acme", company: { universalName: "acme", companyPageUrl: "https://acme.com" } },
    ],
  },
};

/** The GraphQL envelope: the same entity, wrapped twice and split across `included`. */
const GRAPHQL = {
  data: {
    data: {
      identityDashProfilesByMemberIdentity: {
        elements: [{ entityUrn: "urn:li:fsd_profile:ACoAAADANA", publicIdentifier: "dana-okafor" }],
      },
    },
  },
  included: [
    {
      entityUrn: "urn:li:fsd_profile:ACoAAADANA",
      firstName: "Dana",
      lastName: "Okafor",
      headline: "VP Engineering at Acme",
      geoLocation: { defaultLocalizedName: "Austin, Texas" },
    },
    {
      entityUrn: "urn:li:fsd_profilePosition:(ACoAAADANA,1)",
      title: "VP Engineering",
      companyName: "Acme",
      companyUrn: "urn:li:fsd_company:1234",
    },
  ],
};

/** A real, sparse profile: a name and nothing else. The one nobody writes a fixture for. */
const SPARSE = { elements: [{ publicIdentifier: "quiet-person", firstName: { text: "Quiet" }, lastName: { text: "Person" } }] };

/**
 * A flagship profile document. Two people are in it — the member, and a "people also viewed" card —
 * which is the trap: picking the first person-shaped node returns a stranger.
 */
const PAGE_HTML = `<html><head>
<meta property="og:title" content="Dana Okafor - VP Engineering - Acme | LinkedIn"/>
<meta property="og:image" content="https://media.licdn.com/dms/image/large.jpg"/>
</head><body>
<code id="bpr-guid-1"><!--{"included":[
{"publicIdentifier":"rui-silva","firstName":"Rui","lastName":"Silva","entityUrn":"urn:li:fsd_profile:ACoAAARUI","headline":"CTO at Brightlane"},
{"publicIdentifier":"dana-okafor","firstName":"Dana","lastName":"Okafor","entityUrn":"urn:li:fsd_profile:ACoAAADANA","headline":"VP Engineering at Acme","geoLocation":{"defaultLocalizedName":"Austin, Texas"}}
]}--></code>
<script>fetch("/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.abc123def456&variables=(vanityName:dana-okafor)")</script>
</body></html>`;

// ── the parser ───────────────────────────────────────────────────────────────────────────────────

test("the parser reads every shape LinkedIn is known to answer in, off one code path", () => {
  for (const [name, payload] of [["dash", DASH], ["legacy", LEGACY], ["graphql", GRAPHQL]] as const) {
    const p = parseProfile(payload, "dana-okafor");
    assert.ok(p, `${name} produced no profile`);
    // The caller field set, in full. graph.ts writes exactly these and the CRM reads them back.
    assert.equal(p!.public_id, "dana-okafor", name);
    assert.equal(p!.urn, "urn:li:fsd_profile:ACoAAADANA", name);
    assert.equal(p!.name, "Dana Okafor", name);
    assert.equal(p!.headline, "VP Engineering at Acme", name);
    assert.equal(p!.location, "Austin, Texas", name);
    assert.equal(p!.company, "Acme", name);
    assert.equal(p!.title, "VP Engineering", name);
    assert.equal(p!.profile_url, "https://www.linkedin.com/in/dana-okafor", name);
  }
  // The urn is the field `send_invite` cannot work without, and it is normalised to the fsd_ form
  // the invitation endpoints address — from `fs_miniProfile` on the legacy shape.
  assert.equal(parseProfile(LEGACY)!.urn, "urn:li:fsd_profile:ACoAAADANA");
  // Rebuilt from the VectorImage root+artifact, largest artifact — not the 100px one.
  assert.equal(parseProfile(DASH)!.photo_url, "https://media.licdn.com/dms/image/large.jpg");
  assert.equal(parseProfile(DASH)!.company_domain, "acme.com");
  assert.equal(parseProfile(DASH)!.company_slug, "acme");
});

test("a payload missing every optional field yields a partial row — with the keys ABSENT, not empty", () => {
  const p = parseProfile(SPARSE, "quiet-person");
  assert.ok(p, "a name and a slug is a usable person; refusing it loses a real prospect");
  assert.equal(p!.name, "Quiet Person");
  assert.equal(p!.public_id, "quiet-person");
  // THE POINT. graph.ts MERGES these rows, so an empty string is not a harmless default — it
  // overwrites a headline a previous read already learned. Absent must stay absent.
  for (const k of ["headline", "title", "company", "company_domain", "location", "photo_url", "industry", "summary", "urn"]) {
    assert.ok(!(k in (p as Record<string, unknown>)), `${k} must be absent, not empty (got ${JSON.stringify((p as any)[k])})`);
  }
  // And nothing throws on the way through the missing halves of the document.
  assert.equal(parseProfile({ elements: [{}] }), null);
  assert.equal(parseProfile({}), null);
  assert.equal(parseProfile(null), null);
  assert.equal(parseProfile("not json at all"), null);
  assert.equal(parseProfile({ elements: [{ firstName: { text: "Solo" } }] })!.name, "Solo");
});

test("the page parser picks the MEMBER out of a document full of other people", () => {
  const p = parseProfilePage(PAGE_HTML, "dana-okafor");
  assert.ok(p);
  assert.equal(p!.public_id, "dana-okafor");
  assert.equal(p!.name, "Dana Okafor");
  assert.equal(p!.urn, "urn:li:fsd_profile:ACoAAADANA");
  // Returning Rui here would file a stranger under Dana's key and, one step later, invite him.
  assert.notEqual(p!.name, "Rui Silva");

  // The og: floor, for the day the JSON islands change format. Thin, but actionable.
  const bare = parseProfilePage(
    `<meta property="og:title" content="Dana Okafor - VP Engineering - Acme | LinkedIn"/>`,
    "dana-okafor",
  );
  assert.equal(bare!.name, "Dana Okafor");
  assert.equal(bare!.headline, "VP Engineering - Acme");
  assert.equal(parseProfilePage("<html>nothing here</html>", "dana-okafor"), null);
});

test("a queryId is harvested, never invented", () => {
  assert.equal(profileQueryIdFromHtml(PAGE_HTML), "voyagerIdentityDashProfiles.abc123def456");
  assert.equal(profileQueryIdFromHtml("<html>no persisted query here</html>"), undefined);
});

// ── the ladder ───────────────────────────────────────────────────────────────────────────────────

/** A transport that answers per URL pattern and records every URL it was asked for. */
function wire(handler: (url: string) => Response): string[] {
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(url);
    return handler(url);
  });
  return urls;
}

test("the first candidate that answers is LATCHED — the ladder costs extra requests once, not per prospect", async () => {
  reset();
  const urls = wire((url) => (url.includes("/identity/dash/profiles") ? jsonRes(200, DASH) : jsonRes(200, {})));
  try {
    const first = await readProfile(SESSION, ctx(), "dana-okafor");
    assert.equal(first.via, "dash-profiles");
    assert.equal(first.profile?.name, "Dana Okafor");
    assert.equal(profileStrategyState().latched, "dash-profiles");
    assert.equal(urls.length, 1, "the cheapest candidate is first, so the happy path is one request");

    await readProfile(SESSION, ctx(), "rui-silva");
    assert.equal(urls.length, 2, "the latched candidate is tried first and answers");
  } finally {
    _setFetch(null);
    reset();
  }
});

test("a 410 retires ONE candidate and the ladder walks on — the incident, survived", async () => {
  reset();
  const urls = wire((url) => {
    if (url.includes("/identity/dash/profiles")) return res(410, "");
    if (url.includes("linkedin.com/in/")) return res(200, PAGE_HTML, false);
    return jsonRes(200, {});
  });
  try {
    const read = await readProfile(SESSION, ctx("conn-410"), "dana-okafor");
    assert.equal(read.via, "profile-page");
    assert.equal(read.profile?.name, "Dana Okafor");
    assert.deepEqual(
      read.attempts.map((a) => `${a.strategy}:${a.outcome}`),
      ["dash-profiles:gone", "graphql-dash-profiles:skipped", "profile-page:parsed"],
    );
    // The 410 stamped the connection inside voyager.ts. Left standing it would have refused the
    // NEXT candidate before a byte went out, and the ladder could never get past its first dead rung.
    assert.equal(linkedinBlocked("conn-410"), null);
    assert.deepEqual(profileStrategyState().retired, ["dash-profiles"]);
    assert.equal(profileStrategyState().latched, "profile-page");
    // Harvested on the way past: the hash we would never invent is now known for the cheap candidate.
    assert.equal(profileStrategyState().queryId, "voyagerIdentityDashProfiles.abc123def456");

    // The retired candidate is not asked again, for any prospect, for the life of the process.
    urls.length = 0;
    await readProfile(SESSION, ctx("conn-410"), "rui-silva");
    assert.ok(!urls.some((u) => u.includes("/identity/dash/profiles")), urls.join("\n"));
  } finally {
    _setFetch(null);
    reset();
  }
});

test("a 200 in a shape we cannot read retires that candidate too — we do not pay for it twice", async () => {
  reset();
  const urls = wire((url) =>
    url.includes("/identity/dash/profiles")
      ? jsonRes(200, { elements: [], paging: { total: 0 } })
      : res(200, PAGE_HTML, false),
  );
  try {
    const read = await readProfile(SESSION, ctx(), "dana-okafor");
    assert.equal(read.via, "profile-page");
    assert.deepEqual(profileStrategyState().retired, ["dash-profiles"]);
    urls.length = 0;
    await readProfile(SESSION, ctx(), "dana-okafor");
    assert.ok(!urls.some((u) => u.includes("dash/profiles")));
  } finally {
    _setFetch(null);
    reset();
  }
});

test("EVERY candidate dead is PERMANENT, named, and says exactly what to capture from devtools", async () => {
  reset();
  wire(() => res(410, ""));
  try {
    const failure = await readProfile(SESSION, ctx("conn-dead"), "dana-okafor").then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(failure, "a total failure must not look like an empty answer");
    assert.equal(failure!.name, "LinkedInProfileEndpointUnknownError");

    // The classification is what makes gtm/sequence.ts wait a DAY rather than come back in an hour
    // and ask LinkedIn the same dead question 308 more times.
    const f = classifyVoyagerFailure(failure);
    assert.equal(f.permanent, true);
    assert.equal(f.code, PROFILE_ENDPOINT_UNKNOWN_CODE);

    // And the message is an instruction, not a status code: the six things to copy, and where.
    assert.ok(failure!.message.includes(PROFILE_DEVTOOLS_CAPTURE));
    for (const needle of ["devtools", "queryId", "MYCEL_LINKEDIN_QID_PROFILE", "verify-profile.ts"]) {
      assert.match(failure!.message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), needle);
    }
    // The last rung's stop stands: nothing is left to try, so the account stops calling LinkedIn.
    assert.ok(linkedinBlocked("conn-dead"));
  } finally {
    _setFetch(null);
    reset();
  }
});

test("'nobody by that name' is an ANSWER, and a rate limit stops the ladder instead of walking it", async () => {
  reset();
  wire(() => jsonRes(404, {}));
  try {
    // 404/403 from every candidate is null — private and out-of-network profiles are ordinary, and
    // treating them as a broken endpoint would stop a healthy account on its first shy prospect.
    const read = await readProfile(SESSION, ctx("conn-404"), "nobody-here");
    assert.equal(read.profile, null);
    assert.equal(read.via, undefined);
    assert.equal(linkedinBlocked("conn-404"), null, "not finding someone is not a fault");
  } finally {
    _setFetch(null);
  }

  reset();
  const urls = wire(() => jsonRes(429, {}));
  try {
    await assert.rejects(() => readProfile(SESSION, ctx("conn-429"), "dana-okafor"), /429/);
    // Walking three more endpoints while LinkedIn is asking us to slow down is how the next
    // incident starts. One request, then stop.
    assert.equal(urls.length, 1);
    assert.deepEqual(profileStrategyState().retired, [], "a rate limit is not evidence about an endpoint");
  } finally {
    _setFetch(null);
    reset();
  }
});

// ── urn resolution: the half of send_invite that broke ───────────────────────────────────────────

test("urn resolution rides on whichever candidate worked, and short-circuits when it needs nothing", async () => {
  reset();
  wire((url) => (url.includes("/identity/dash/profiles") ? jsonRes(200, DASH) : jsonRes(200, {})));
  try {
    const c = ctx();
    const resolved = await resolveProfileUrn(SESSION, c, "dana-okafor", (id) =>
      readProfile(SESSION, c, id).then((r) => r.profile),
    );
    assert.equal(resolved.urn, "urn:li:fsd_profile:ACoAAADANA");
    assert.equal((resolved.profile as { name?: string })?.name, "Dana Okafor");

    // A member urn needs no read at all: the invitation endpoints address exactly this string.
    const direct = await resolveProfileUrn(SESSION, c, "urn:li:fs_miniProfile:ACoAAAX", async () => {
      throw new Error("a urn must never cost a profile read");
    });
    assert.equal(direct.urn, "urn:li:fsd_profile:ACoAAAX");

    // A profile that came back without a urn is a PER-PROSPECT miss, not an outage: null urn, no throw.
    const noUrn = await resolveProfileUrn(SESSION, c, "quiet-person", async () => parseProfile(SPARSE, "quiet-person"));
    assert.equal(noUrn.urn, undefined);
    assert.ok(noUrn.profile, "and the row is still handed back to be written to the graph");
  } finally {
    _setFetch(null);
    reset();
  }
});

test("with no working read path at all, urn resolution fails PERMANENTLY rather than generically", async () => {
  reset();
  wire(() => res(410, ""));
  try {
    const c = ctx("conn-invite-dead");
    const e = await resolveProfileUrn(SESSION, c, "dana-okafor", (id) =>
      readProfile(SESSION, c, id).then((r) => r.profile),
    ).then(() => null, (err: Error) => err);
    assert.ok(e, "'could not resolve that person' would read as one unlucky prospect, 5,000 times");
    assert.equal(classifyVoyagerFailure(e).code, PROFILE_ENDPOINT_UNKNOWN_CODE);
    assert.equal(classifyVoyagerFailure(e).permanent, true);
  } finally {
    _setFetch(null);
    reset();
  }
});

// ── end to end: what a founder's sequencer actually sees ─────────────────────────────────────────

/** Hours to add to now so the account's derived local time is a Tuesday at 10:00 — inside hours. */
function workingHoursOffset(now = new Date()): number {
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  while (target.getUTCDay() !== 2) target.setUTCDate(target.getUTCDate() + 1);
  return (target.getTime() - now.getTime()) / 3_600_000;
}

test("send_invite with no working profile read fails with the PERMANENT code, not 'invitation failed'", async () => {
  reset();
  await initSecretStore();
  _setVerifier(async () => ({ self_urn: "urn:li:fs_miniProfile:ME", mailbox_urn: "urn:li:fsd_profile:ME", name: "Founder" }));
  const urls = wire((url) =>
    url.includes("normInvitations") || url.includes("verifyQuotaAndCreate")
      ? jsonRes(200, { value: {} })
      : res(410, ""),
  );
  try {
    const r = await connectWithSession({
      li_at: "AQEDx",
      jsessionid: '"ajax:1"',
      proxyUrl: "http://u:p@resi.example:8080",
      project_id: "p-invite-dead",
    });
    assert.equal(r.phase, "connected", r.error);
    const conn = (await getDomainStore().getConnection(r.connection_id))!;
    const ready = (await getDomainStore().updateConnection(conn.id, {
      config: {
        ...conn.config,
        tier: "premium",
        account_age_days: 365,
        utc_offset: workingHoursOffset(),
        pacing: { engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 } },
      },
    }))!;

    reset(); // the connect handshake's own /me call is not what this test is about
    urls.length = 0;
    const sent = await sendLinkedInInvite(ready, "dana-okafor", "hi Dana");
    assert.equal(sent.ok, false);
    // THE ASSERTION. A code is what makes gtm/sequence.ts wait a day; without it the case comes
    // back in an hour, for ever, and the founder reads "invitation failed" five thousand times.
    assert.equal(sent.code, PROFILE_ENDPOINT_UNKNOWN_CODE);
    assert.match(sent.detail ?? "", /devtools/i);
    // And the invitation itself never went out on an unresolved urn.
    assert.ok(
      !urls.some((u) => u.includes("normInvitations") || u.includes("verifyQuotaAndCreate")),
      urls.join("\n"),
    );
  } finally {
    _setFetch(null);
    reset();
  }
});
