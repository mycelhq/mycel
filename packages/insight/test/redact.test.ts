// Redaction. If any of these regress, the package has quietly become a data processor for material
// nobody agreed to send us — so these are assertions about a promise, not about a formatter.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSensitiveKey, redactEventName, redactPath, redactPropValue, redactProps } from "../src/redact";
import { LIMITS } from "../src/types";

test("a query string never survives — this is the magic sign-in link rule", () => {
  // The case this rule exists for: the token in that query string is a WORKING LOGIN. Capturing
  // `location.href` on the page a magic link lands on posts it to an analytics endpoint, where it
  // then lives in a database, a log, and whatever the retention policy turns out to be.
  assert.equal(redactPath("/auth/callback?token=abc123def456&email=jo@example.com"), "/auth/callback");
  assert.equal(redactPath("https://app.example.com/dashboard?utm_source=x#section"), "/dashboard");
  assert.equal(redactPath("/reset#access_token=zzz"), "/reset");
});

test("id-shaped path segments are masked, because a path can name a person", () => {
  assert.equal(redactPath("/orders/12345"), "/orders/:id");
  assert.equal(redactPath("/u/7f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"), "/u/:id");
  assert.equal(redactPath("/invite/jo%40example.com"), "/invite/:email");
  assert.equal(redactPath("/s/01ARZ3NDEKTSV4RRFFQ69G5FAV"), "/s/:id");
  // A real page name survives — the report is useless if every path is `:id`.
  assert.equal(redactPath("/services/deep-clean"), "/services/deep-clean");
});

test("redactPath never throws and always returns a path", () => {
  for (const input of [undefined, null, "", "not a path", "//", "%%%", "mailto:jo@example.com"]) {
    const out = redactPath(input as string);
    assert.equal(typeof out, "string");
    assert.ok(out.startsWith("/"), `${JSON.stringify(input)} → ${out}`);
  }
  const deep = redactPath("/" + Array.from({ length: 40 }, (_, i) => `seg${i}`).join("/"));
  assert.ok(deep.length <= LIMITS.maxPathLength);
  assert.ok(deep.endsWith("/…"));
});

test("props that could hold something a customer typed are dropped, not shortened", () => {
  const out = redactProps({
    email: "jo@example.com",
    full_name: "Jo Bloggs",
    message: "my back hurts",
    q: "cheapest divorce lawyer",
    api_key: "sk-live-1234",
    phone: "07700900000",
    service: "deep_clean",
    price_band: 3,
    is_repeat: true,
    referrer: "https://google.com/?q=secret",
  });
  assert.deepEqual(out, { is_repeat: true, price_band: 3, service: "deep_clean" });
  for (const key of ["email", "name", "user_name", "search", "otp", "card_number", "ip", "lat", "url"]) {
    assert.ok(isSensitiveKey(key), `${key} should be denied`);
  }
  // Not everything is denied, or the package collects nothing useful.
  for (const key of ["service", "plan_tier", "step_count", "variant"]) {
    assert.ok(!isSensitiveKey(key), `${key} should be allowed`);
  }
});

test("credential-shaped VALUES are dropped even under an innocent key", () => {
  assert.equal(redactPropValue("jo@example.com"), undefined);
  assert.equal(redactPropValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), undefined);
  assert.equal(redactPropValue("a3f9c8e1b2d4f6a8"), undefined, "long hex");
  assert.equal(redactPropValue("Ab3xY9zQ1mN4pR7sT2vW5uK8jL0hG6dF"), undefined, "mixed-case opaque token");
  // A slug someone actually wrote is not a token, and treating it as one would collect nothing.
  assert.equal(redactPropValue("residential_deep_clean"), "residential_deep_clean");
  assert.equal(redactPropValue(42), 42);
  assert.equal(redactPropValue(null), null);
  assert.equal(redactPropValue(Number.NaN), undefined);
  assert.equal(redactPropValue({ nested: true }), undefined, "objects would smuggle depth past the caps");
  assert.equal(redactPropValue("https://app.test/x?token=1"), "/x", "a URL in a prop is still a URL");
});

test("props are bounded — a hostile or buggy caller cannot make the payload grow", () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) many[`prop_${i}`] = `v${i}`;
  assert.equal(Object.keys(redactProps(many) ?? {}).length, LIMITS.maxProps);
  // Spaces on purpose: a long unbroken `[A-Za-z0-9_-]` run is treated as an opaque token and
  // dropped outright, which is a different rule (see the test above). This one is about truncation.
  const long = redactProps({ variant: "deep clean ".repeat(50) });
  assert.equal((long?.variant as string).length, LIMITS.maxPropString);
  assert.equal(redactProps([1, 2, 3]), undefined);
  assert.equal(redactProps("nope"), undefined);
  assert.equal(redactProps({ email: "jo@example.com" }), undefined, "nothing left means nothing sent");
});

test("event names are identifiers, not content", () => {
  assert.equal(redactEventName("Booking Confirmed!"), "booking_confirmed");
  assert.equal(redactEventName("$pageview"), "$pageview");
  assert.equal(redactEventName("x".repeat(500))?.length, LIMITS.maxEventName);
  assert.equal(redactEventName(""), null);
  assert.equal(redactEventName(123), null);
  assert.equal(redactEventName("___"), null);
});
