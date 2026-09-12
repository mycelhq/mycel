import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSetCookie, cookieFromInit, withCookie } from "../src/cookies";
import {
  bindJarPersist,
  noteSessionRotated,
  voyagerHeaders,
  _resetJarPersist,
} from "../src/voyager";
import { proxiedFetch, _setFetch } from "../src/proxy";

const PROXY = "http://user:pw@resi.example:8080";
const API = "https://www.linkedin.com/voyager/api/relationships/connections";

test("voyagerHeaders uses the UA the session was born with", () => {
  const born = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const h = voyagerHeaders({ li_at: "a", jsessionid: '"ajax:1"', ua: born });
  assert.equal(h["user-agent"], born);
});

test("bindJarPersist writes the latest jar and does not drop a rotation that arrives while writing", async () => {
  _resetJarPersist();
  const store = new Map<string, string>([
    ["c1", JSON.stringify({ li_at: "a", jsessionid: "b", cookies: "lidc=old" })],
  ]);
  let sets = 0;
  bindJarPersist({
    get: async (k) => store.get(k),
    set: async (k, v) => {
      sets += 1;
      store.set(k, v);
    },
  });
  noteSessionRotated("c1", "lidc=first");
  noteSessionRotated("c1", "lidc=latest");
  await new Promise((r) => setTimeout(r, 50));
  const saved = JSON.parse(store.get("c1")!);
  assert.equal(saved.cookies, "lidc=latest");
  assert.equal(saved.li_at, "a");
  assert.ok(sets >= 1);
  _resetJarPersist();
});

test("a 302 to the same Voyager URL with a fresh lidc is retried, not returned as signed-out", async () => {
  const cookiesSent: string[] = [];
  let n = 0;
  _setFetch(async (_url, init) => {
    n += 1;
    cookiesSent.push(cookieFromInit(init ?? {}));
    if (n === 1) {
      return {
        ok: false,
        status: 302,
        headers: {
          get: (h: string) => (h.toLowerCase() === "location" ? API : h.toLowerCase() === "set-cookie" ? "lidc=fresh" : null),
          getSetCookie: () => ["lidc=fresh; Path=/"],
        },
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => "{}",
    } as unknown as Response;
  });
  try {
    const res = await proxiedFetch(
      API,
      { method: "GET", headers: { cookie: "li_at=x; JSESSIONID=y; lidc=stale" } },
      PROXY,
      "voyager connections",
    );
    assert.equal(res.status, 200);
    assert.equal(n, 2);
    assert.match(cookiesSent[0] ?? "", /lidc=stale/);
    assert.match(cookiesSent[1] ?? "", /lidc=fresh/);
  } finally {
    _setFetch(null);
  }
});

test("withCookie replaces the request jar without dropping other headers", () => {
  const next = withCookie({ headers: { accept: "application/json", cookie: "lidc=old" } }, "lidc=new");
  assert.equal(cookieFromInit(next), "lidc=new");
  assert.equal((next.headers as Record<string, string>).accept, "application/json");
});

test("mergeSetCookie replaces lidc and honours deletions", () => {
  const jar = "li_at=a; lidc=old; bcookie=x";
  assert.match(mergeSetCookie(jar, ["lidc=new; Path=/"]), /lidc=new/);
  assert.doesNotMatch(mergeSetCookie(jar, ["bcookie=; Max-Age=0; Path=/"]), /bcookie=/);
});
