// The product-eval LinkedIn mock: the connect handshake (/me) succeeds offline with no real account.
import test from "node:test";
import assert from "node:assert/strict";
import { installLinkedInMock } from "../src/linkedin/mock";
import { fetchSelf } from "../src/linkedin/voyager";
import { _setFetch } from "../src/linkedin/proxy";

test("MYCEL_LINKEDIN_MOCK: fetchSelf returns a canned identity, no network", async () => {
  installLinkedInMock();
  try {
    // Any session + a direct-allowed ctx; the mock answers /me before the wire is touched.
    const session: any = { li_at: "mock", jsessionid: "mock", cookie: "li_at=mock" };
    const ctx: any = { connectionId: "conn-mock", proxyUrl: undefined };
    const prevDirect = process.env.MYCEL_LINKEDIN_ALLOW_DIRECT;
    process.env.MYCEL_LINKEDIN_ALLOW_DIRECT = "1"; // requireProxy passes; the override then answers
    try {
      const self = await fetchSelf(session, ctx);
      assert.ok(self, "fetchSelf returned null under the mock");
      assert.match(String(self!.self_urn), /mock-eval-self/);
      assert.equal(self!.name, "Eval Operator");
    } finally {
      if (prevDirect === undefined) delete process.env.MYCEL_LINKEDIN_ALLOW_DIRECT;
      else process.env.MYCEL_LINKEDIN_ALLOW_DIRECT = prevDirect;
    }
  } finally {
    _setFetch(null);
  }
});
