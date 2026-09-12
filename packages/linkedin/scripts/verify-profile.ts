#!/usr/bin/env node
// Which profile-read candidate does LinkedIn actually answer, on a REAL session, today?
//
// This is the missing half of profile.ts. Nothing in this repo can log in to LinkedIn, so the
// strategy ladder is an ordered set of well-evidenced guesses until somebody with a live session
// runs them. This script is that somebody's tool: it takes cookies from the ENVIRONMENT, tries each
// candidate against one public id, and prints which one answered and what came out.
//
// ── IT SHIPS NO CREDENTIALS, BY CONSTRUCTION ─────────────────────────────────────────────────────
// There is no default cookie, no fixture session, no `.env` read and no file written. The cookies
// arrive as env vars, live in this process for the length of one run, and are never printed — the
// output contains a fingerprint (`li_at ends …abcd`) and never the value. Do not paste cookies onto
// a command line either (they land in shell history); export them, or use a here-doc.
//
//   export MYCEL_LI_AT='AQEDA…'                 # the li_at cookie from a logged-in browser
//   export MYCEL_JSESSIONID='"ajax:1234567890"' # JSESSIONID, quotes included
//   export MYCEL_LI_PROXY='http://user:pass@resi.example:8080'   # the account's residential proxy
//   npx tsx packages/linkedin/scripts/verify-profile.ts williamhgates
//
// Without a proxy the call is REFUSED (proxy.ts), which is the rule the whole surface rests on. To
// probe from your own IP anyway — fine for one read, not for a fleet — add MYCEL_LINKEDIN_ALLOW_DIRECT=1.
//
// Flags:
//   --all    probe every candidate rather than stopping at the first that works. Costs one extra
//            request per candidate against a real account, so it is opt-in; use it once, to learn
//            what is true, not on a schedule.
//   --json   print the machine-readable result and nothing else.
//
// WHAT TO DO WITH THE OUTPUT: if a candidate worked, nothing — the ladder will find it in
// production too. If NONE worked, the script prints the devtools capture list from health.ts; work
// through it and set MYCEL_LINKEDIN_QID_PROFILE or MYCEL_LINKEDIN_PROFILE_DECORATION, or paste the
// capture into an issue so the parser can be taught the shape.
import {
  PROFILE_STRATEGIES,
  profileStrategyState,
  readProfile,
  safeProfileId,
  _resetProfileStrategies,
  type ProfileRead,
  type ProfileStrategyName,
} from "../src/profile";
import { _resetLinkedInHealth, PROFILE_DEVTOOLS_CAPTURE } from "../src/health";
import { usageFor, _resetUsage } from "../src/meter";
import type { LinkedInSession, VoyagerCtx } from "../src/voyager";

/** A cookie, identifiable in a log without being disclosed in one. */
function fingerprint(v: string): string {
  return v.length <= 8 ? `${v.length} chars` : `${v.length} chars, ends …${v.slice(-4)}`;
}

interface Outcome {
  strategy: ProfileStrategyName | "ladder";
  ok: boolean;
  via?: ProfileStrategyName;
  attempts: ProfileRead["attempts"];
  profile?: Record<string, unknown> | null;
  error?: string;
}

async function probe(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  id: string,
  only?: ProfileStrategyName,
): Promise<Outcome> {
  // Each probe starts from a clean breaker and a clean ladder: this script is here to learn what
  // LinkedIn does, and a stop left over from the previous candidate would answer for it.
  _resetLinkedInHealth();
  if (only) _resetProfileStrategies();
  try {
    const read = await readProfile(session, ctx, id, "profile", only);
    return {
      strategy: only ?? "ladder",
      ok: !!read.profile,
      via: read.via,
      attempts: read.attempts,
      profile: (read.profile ?? null) as Record<string, unknown> | null,
    };
  } catch (e) {
    return {
      strategy: only ?? "ladder",
      ok: false,
      attempts: [],
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const asJson = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--"));

  const li_at = process.env.MYCEL_LI_AT ?? "";
  const jsessionid = process.env.MYCEL_JSESSIONID ?? "";
  const proxyUrl = process.env.MYCEL_LI_PROXY || undefined;
  const id = safeProfileId(target);

  if (!li_at || !jsessionid || !id) {
    console.error(
      "usage: MYCEL_LI_AT=… MYCEL_JSESSIONID=… [MYCEL_LI_PROXY=…] tsx verify-profile.ts <public-id> [--all] [--json]\n" +
        "  <public-id> is the slug in linkedin.com/in/<slug> — pick someone public, e.g. williamhgates.",
    );
    return 2;
  }

  const session: LinkedInSession = { li_at, jsessionid };
  const ctx: VoyagerCtx = { connectionId: "verify-profile", proxyUrl };
  _resetUsage();

  if (!asJson) {
    console.log(`session: li_at ${fingerprint(li_at)}, JSESSIONID ${fingerprint(jsessionid)}`);
    console.log(`proxy:   ${proxyUrl ? "configured" : "NONE (needs MYCEL_LINKEDIN_ALLOW_DIRECT=1)"}`);
    console.log(`target:  ${id}`);
    console.log(`known:   ${JSON.stringify(profileStrategyState())}\n`);
  }

  const outcomes: Outcome[] = [];
  if (all) {
    for (const name of PROFILE_STRATEGIES) outcomes.push(await probe(session, ctx, id, name));
  } else {
    outcomes.push(await probe(session, ctx, id));
  }

  const winner = outcomes.find((o) => o.ok);
  if (asJson) {
    console.log(JSON.stringify({ target: id, outcomes, usage: usageFor("verify-profile") }, null, 2));
    return winner ? 0 : 1;
  }

  for (const o of outcomes) {
    const head = o.ok ? `WORKS  via ${o.via ?? o.strategy}` : `fails  ${o.strategy}`;
    console.log(`${head}`);
    for (const a of o.attempts) {
      console.log(`   · ${a.strategy}: ${a.outcome}${a.status ? ` (${a.status})` : ""}${a.note ? ` — ${a.note}` : ""}`);
    }
    if (o.error) console.log(`   ! ${o.error}`);
    if (o.ok && o.profile) {
      console.log("   parsed:");
      for (const [k, v] of Object.entries(o.profile)) console.log(`     ${k}: ${String(v)}`);
      // The point of printing ABSENT fields separately: a tolerant parser is supposed to omit what
      // is not there, and "omitted" is only a good answer if you can see what was omitted.
      const wanted = ["public_id", "urn", "name", "headline", "location", "company", "photo_url"];
      const missing = wanted.filter((k) => !(k in (o.profile ?? {})));
      console.log(`     ABSENT: ${missing.length ? missing.join(", ") : "nothing — full shape"}`);
    }
    console.log("");
  }

  const bytes = usageFor("verify-profile");
  if (bytes) console.log(`transferred: ${bytes.requests} requests, ${bytes.wire_bytes} wire bytes\n`);

  if (!winner) {
    console.log("NO CANDIDATE WORKED. This is the case the ladder cannot fix on its own:\n");
    console.log(PROFILE_DEVTOOLS_CAPTURE);
    return 1;
  }
  console.log(`→ set nothing: the ladder latches onto ${winner.via ?? winner.strategy} by itself in production.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
    process.exit(1);
  },
);
