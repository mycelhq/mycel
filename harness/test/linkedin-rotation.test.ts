// `lidc` is LinkedIn's DATACENTER ROUTING cookie: it says which datacenter holds your session and
// until when, and they reissue it on nearly every response. A browser follows. This client replayed
// a frozen one forever — and a STALE lidc is worse than none, because it routes the request to a
// datacenter that no longer has the session. LinkedIn answers 302 to re-route, `voyagerCall` reads
// that as "not signed in", stamps the challenge, and the breaker stops the channel.
//
// Observed on 31 August: the same jar returned 200 from /voyager/api/me and then 302 seconds later
// from an identical request. That is not a session dying. That is a routing hint going stale.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeSetCookie, setCookiesFrom } from "../src/linkedin/voyager";

const JAR = 'li_at=AQED-real; JSESSIONID="ajax:1"; bcookie=v=2&abc; lidc=b=OB01:s=OLD';

test("rotation: a reissued lidc replaces the stale one", () => {
  const out = mergeSetCookie(JAR, ['lidc="b=OB02:s=NEW"; Expires=Wed, 01 Sep 2027 12:00:00 GMT; Path=/']);
  assert.ok(out.includes('lidc="b=OB02:s=NEW"'), out);
  assert.ok(!out.includes("OLD"), "the stale routing hint must not survive");
  // Everything else is untouched: this merges, it does not replace the jar.
  assert.ok(out.includes("li_at=AQED-real") && out.includes("bcookie=v=2&abc"), out);
});

test("rotation: a cookie LinkedIn clears is stopped, not resent", () => {
  const maxAge = mergeSetCookie(JAR, ["bcookie=; Max-Age=0; Path=/"]);
  assert.ok(!maxAge.includes("bcookie="), maxAge);
  const past = mergeSetCookie(JAR, ["bcookie=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
  assert.ok(!past.includes("bcookie=x"), past);
});

test("rotation: a fresh auth cookie is taken too", () => {
  // LinkedIn does reissue li_at, and keeping the old one after that is a guaranteed 401.
  const out = mergeSetCookie(JAR, ["li_at=AQED-rotated; Path=/; HttpOnly"]);
  assert.ok(out.includes("li_at=AQED-rotated"), out);
  assert.ok(!out.includes("AQED-real"), out);
});

test("rotation: no Set-Cookie leaves the jar byte-identical", () => {
  // The equality check is what stops a database write on every single request.
  assert.equal(mergeSetCookie(JAR, []), JAR);
});

test("rotation: several cookies in one response are all applied", () => {
  const out = mergeSetCookie(JAR, [
    "lidc=b=NEW; Path=/",
    "JSESSIONID=\"ajax:2\"; Path=/",
    "li_gc=fresh; Path=/",
  ]);
  assert.ok(out.includes("lidc=b=NEW") && out.includes('JSESSIONID="ajax:2"') && out.includes("li_gc=fresh"), out);
});

test("rotation: Node folds repeated Set-Cookie, and getSetCookie unfolds it", () => {
  const h = new Headers();
  h.append("set-cookie", "a=1; Path=/");
  h.append("set-cookie", "b=2; Path=/");
  const got = setCookiesFrom(h);
  assert.equal(got.length, 2, `folded into one would lose a cookie: ${JSON.stringify(got)}`);
  assert.deepEqual(setCookiesFrom(undefined), []);
});
