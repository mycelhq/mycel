// Working inside a system that has no API.
//
// `operate` could drive a browser and could not hold a credential, so it could see the whole
// internet and none of the six systems a service business actually works in. The containment for
// fixing that is a domain lock and the target account's own role — not a tool allowlist, which
// would forbid most reading and permit some writing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserTarget,
  browserUseConfig,
  domainLock,
  mayWrite,
  normaliseOrigin,
  parseSession,
  refuseWrite,
  sessionCovers,
  wrongSessionFor,
} from "../src/browser-work";
import type { Connection } from "../src/contract";

const conn = (config: Record<string, unknown>, kind = "browser"): Connection =>
  ({ id: "c1", kind, name: "Acme portal", owner: { kind: "founder", id: "founder" }, config, created_at: "2026-08-30T00:00:00Z" }) as Connection;

test("http is refused outright", () => {
  // A session cookie replayed over http: is a session cookie handed to whoever is on the path, and
  // there is no portal worth working in that is worth doing that for.
  assert.equal(normaliseOrigin("http://portal.example.com"), undefined);
  assert.equal(normaliseOrigin("https://portal.example.com"), "https://portal.example.com");
});

test("an origin is normalised to scheme and host, and nothing else", () => {
  // The path is not part of the lock. A portal that logs in at /wp-admin and works at /wp-json is
  // one system, and a lock carrying a path would break on the first navigation.
  assert.equal(normaliseOrigin("https://Portal.Example.com/wp-admin/?x=1#y"), "https://portal.example.com");
  assert.equal(normaliseOrigin("https://localhost"), undefined, "no dot is not a host worth trusting");
  assert.equal(normaliseOrigin("  "), undefined);
  assert.equal(normaliseOrigin("not a url"), undefined);
  assert.equal(normaliseOrigin(undefined), undefined);
});

test("a connection with no usable origin is refused, never defaulted", () => {
  /**
   * THE FAILURE THIS PREVENTS.
   *
   * A connection missing its origin is not a connection to "anywhere". Defaulting would produce a
   * credentialed browser with no domain lock, which is the single outcome this whole area exists to
   * make impossible — the run would hold a client's session and be free to navigate to their bank.
   */
  assert.equal(browserTarget(conn({})), undefined);
  assert.equal(browserTarget(conn({ origin: "" })), undefined);
  assert.equal(browserTarget(conn({ origin: "http://portal.example.com" })), undefined);
  assert.equal(browserTarget(conn({ origin: "https://portal.example.com" }, "email")), undefined, "wrong kind");
  assert.equal(browserTarget(undefined), undefined);
});

test("access defaults to read, because absent is not a claim to act", () => {
  // A connection written before this field existed made no claim at all, and the safe reading of an
  // absent or unrecognised value is the smaller one.
  assert.equal(browserTarget(conn({ origin: "https://p.example.com" }))!.access, "read");
  assert.equal(browserTarget(conn({ origin: "https://p.example.com", access: "nonsense" }))!.access, "read");
  assert.equal(browserTarget(conn({ origin: "https://p.example.com", access: "act" }))!.access, "act");
});

test("the domain lock covers the host and its subdomains, and no second host", () => {
  /**
   * Subdomains, because a portal serving login on `accounts.` and work on `portal.` is one system to
   * the person using it, and a lock admitting only the exact host breaks on the first redirect —
   * which reads as "the portal is broken" and gets loosened by whoever debugs it at 2am.
   *
   * And no second host EVER, however reasonable. An identity provider on another domain is real and
   * common, and it is a decision for whoever set the connection up rather than a guess made here.
   */
  const t = browserTarget(conn({ origin: "https://portal.example.com" }))!;
  assert.deepEqual(domainLock(t), ["portal.example.com", "*.portal.example.com"]);
  assert.ok(!domainLock(t).some((d) => d === "*"), "a wildcard here is no lock at all");
});

test("a write task refuses a read-only connection, and says what to do about it", () => {
  const read = browserTarget(conn({ origin: "https://portal.example.com" }))!;
  const act = browserTarget(conn({ origin: "https://portal.example.com", access: "act" }))!;
  assert.equal(mayWrite(read), false);
  assert.equal(mayWrite(act), true);

  // The refusal has to name the thing that ACTUALLY decides, or the founder will believe this
  // setting is the security boundary. It is not: the role on the account they handed over is.
  const why = refuseWrite(read);
  assert.match(why, /portal\.example\.com/);
  assert.match(why, /that account's own\s+role is what actually decides/);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// GETTING THE SESSION INTO THE BROWSER
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test("a vault value that is not a session is refused, not mounted empty", () => {
  /**
   * A misconfiguration must not read as "an empty session". Mounting `{}` would produce a run that
   * browsed a login screen for twenty minutes and reported the portal as empty — a wrong answer
   * that looks like work. Refusing means the run hits the sign-in page and says so, which is
   * diagnosable in one line of the trace.
   */
  assert.equal(parseSession(undefined), undefined);
  assert.equal(parseSession(""), undefined);
  assert.equal(parseSession("not json"), undefined);
  assert.equal(parseSession("{}"), undefined);
  assert.equal(parseSession('{"cookies":[]}'), undefined, "an empty jar is not a session");
  assert.equal(parseSession('"a string"'), undefined);
});

test("cookies OR origins is a session, because portals keep auth in both", () => {
  // localStorage-only auth is common in modern portals, and a cookies-only check would silently
  // fail on exactly those — the run would look logged out with a perfectly valid stored session.
  assert.ok(parseSession('{"cookies":[{"name":"s","value":"x"}]}'));
  assert.ok(parseSession('{"origins":[{"origin":"https://p.example.com","localStorage":[]}]}'));
});

test("the config is in the keyed shape the loader actually reads", () => {
  /**
   * PINNED AGAINST THE WHEEL. `config.py`'s `DBStyleConfigJSON.browser_profile` is a
   * `dict[str, BrowserProfileEntry]`, and `_get_default_profile()` walks `.values()` for the default
   * one. A flat `{"storage_state": …}` would parse, validate, and be silently ignored — the run
   * would start logged out with no error anywhere.
   */
  const cfg = browserUseConfig("/root/.config/browseruse/mycel-session.json") as {
    browser_profile: Record<string, { default?: boolean; storage_state?: string }>;
  };
  const entries = Object.values(cfg.browser_profile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.default, true, "not the default means not read");
  assert.equal(entries[0]!.storage_state, "/root/.config/browseruse/mycel-session.json");
  // Absolute: browser-use resolves `~` for its own config dir, not for a path we hand it.
  assert.ok(entries[0]!.storage_state!.startsWith("/"));
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE WRONG TAB
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Sessions are captured by hand from a browser with several tabs open. Pasting the wrong one stores
// fine, mounts fine, and yields a run that browses a login page for twenty minutes and reports the
// portal as empty. Nothing about that looks like a failure until somebody reads a transcript.

const cookie = (domain: string) => ({ name: "s", value: "x", domain });

test("a session for another host is refused, and both hosts are named", () => {
  const state = { cookies: [cookie("app.other.com"), cookie(".mail.google.com")] };
  assert.equal(sessionCovers(state, "portal.example.com"), false);
  const why = wrongSessionFor(state, "portal.example.com");
  assert.match(why, /nothing for portal\.example\.com/);
  assert.match(why, /app\.other\.com/, "naming what it IS for is the whole diagnosis");
  assert.match(why, /mail\.google\.com/, "the leading dot is not part of the host");
});

test("a parent-domain cookie counts, because that is how cookies work", () => {
  // A cookie set on `.example.com` is valid for `portal.example.com`. Rejecting it would block a
  // genuinely working session, which is the more expensive direction to be wrong in — a too-loose
  // match is caught seconds later by the portal itself.
  assert.ok(sessionCovers({ cookies: [cookie(".example.com")] }, "portal.example.com"));
  assert.ok(sessionCovers({ cookies: [cookie("example.com")] }, "portal.example.com"));
  assert.ok(sessionCovers({ cookies: [cookie("portal.example.com")] }, "portal.example.com"));
});

test("a sibling subdomain does not count, and neither does a lookalike", () => {
  assert.equal(sessionCovers({ cookies: [cookie("other.example.com")] }, "portal.example.com"), false);
  // `evil-example.com` ends with `example.com` as a STRING and shares nothing with it as a domain.
  // The suffix check is on a dot boundary for exactly this.
  assert.equal(sessionCovers({ cookies: [cookie("evil-example.com")] }, "example.com"), false);
  assert.equal(sessionCovers({ cookies: [cookie("notexample.com")] }, "example.com"), false);
});

test("localStorage origins count too, and a malformed one is not a crash", () => {
  // Plenty of portals keep auth in localStorage. A cookies-only check would reject a valid session
  // for exactly those.
  assert.ok(sessionCovers({ origins: [{ origin: "https://portal.example.com" }] }, "portal.example.com"));
  assert.equal(sessionCovers({ origins: [{ origin: "not a url" }, { origin: 7 }] }, "portal.example.com"), false);
  assert.equal(sessionCovers({ cookies: [{ name: "x" }] }, "portal.example.com"), false, "no domain, no match");
});
