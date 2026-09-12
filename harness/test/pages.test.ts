// Live unlisted pages — the URL a client opens, not an iframe of a file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./helpers";
import {
  _resetPages,
  getPublishedPage,
  isLivePageUrl,
  isPageToken,
  PUBLISHED_PAGE_CSP,
  publishPage,
  publishedPageUrl,
  sanitizePublishedHtml,
  shippedPageFaults,
} from "../src/pages";

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>How much does Invisalign cost in Portland?</title>
  <meta name="description" content="Harborline Dental's Invisalign treatment in Portland typically costs $3,500 to $6,500."/>
</head>
<body>
  <h1>How much does Invisalign cost in Portland?</h1>
  <p>Harborline Dental's Invisalign treatment in Portland typically costs $3,500 to $6,500. Most cases finish in 12 to 18 months.</p>
  <p>The range depends on how many aligners you need, which we confirm at the first visit.</p>
</body>
</html>`;

test("isLivePageUrl accepts https and loopback http, nothing else", () => {
  assert.equal(isLivePageUrl("https://pages.mycel.test/p/abc"), true);
  assert.equal(isLivePageUrl("http://127.0.0.1:4000/p/abc"), true);
  assert.equal(isLivePageUrl("http://localhost:4000/p/abc"), true);
  assert.equal(isLivePageUrl("http://insecure.test/p/abc"), false);
  assert.equal(isLivePageUrl("ftp://pages.mycel.test/p/abc"), false);
  assert.equal(isLivePageUrl("not a url"), false);
});

test("sanitizePublishedHtml strips executable tags and keeps JSON-LD", () => {
  const dirty = PAGE.replace(
    "</body>",
    `<script>alert(document.cookie)</script>
     <script type="application/ld+json">{"@type":"FAQPage"}</script>
     <img src="x" onerror="alert(1)"/>
     </body>`,
  );
  const clean = sanitizePublishedHtml(dirty);
  assert.ok(clean);
  assert.doesNotMatch(clean!, /alert\(document\.cookie\)/);
  assert.match(clean!, /application\/ld\+json/);
  assert.doesNotMatch(clean!, /onerror/i);
  assert.match(clean!, /noindex/);
});

test("sanitizePublishedHtml refuses a stub", () => {
  assert.equal(sanitizePublishedHtml("<p>too short</p>"), undefined);
});

test("GET /p/:token serves the page as text/html with CSP, no auth", async () => {
  _resetPages();
  const prev = process.env.MYCEL_PAGES_URL;
  process.env.MYCEL_PAGES_URL = "https://pages.mycel.test";
  try {
    const page = await publishPage({
      project_id: "proj-1",
      html: PAGE.replace("</body>", `<script>alert(1)</script></body>`),
      title: "How much does Invisalign cost in Portland?",
    });
    assert.ok(page);
    assert.ok(isPageToken(page!.token));
    assert.equal(publishedPageUrl(page!.token), `https://pages.mycel.test/p/${page!.token}`);
    assert.doesNotMatch(page!.html, /alert\(1\)/);

    const { app } = makeApp();
    const res = await app.request(`/p/${page!.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("content-security-policy"), PUBLISHED_PAGE_CSP);
    assert.match(PUBLISHED_PAGE_CSP, /script-src 'none'|default-src 'none'/);
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    const body = await res.text();
    assert.match(body, /Invisalign/);
    assert.doesNotMatch(body, /<script>alert/);

    const missing = await app.request("/p/not-a-real-token-value-xx");
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "not found");
    assert.equal(await getPublishedPage("nope"), undefined);
  } finally {
    if (prev === undefined) delete process.env.MYCEL_PAGES_URL;
    else process.env.MYCEL_PAGES_URL = prev;
    _resetPages();
  }
});

test("publishPage fails closed when the public base is not a live URL", async () => {
  _resetPages();
  const prev = process.env.MYCEL_PAGES_URL;
  process.env.MYCEL_PAGES_URL = "http://internal.cluster";
  try {
    const page = await publishPage({ project_id: "proj-1", html: PAGE });
    assert.equal(page, undefined, "an internal http host is not a page a client can open");
  } finally {
    if (prev === undefined) delete process.env.MYCEL_PAGES_URL;
    else process.env.MYCEL_PAGES_URL = prev;
    _resetPages();
  }
});

test("shippedPageFaults refuses a stub and accepts the structural bar, not a vertical", () => {
  assert.ok(shippedPageFaults(PAGE).length > 0);
  const copy =
    "The number they already publish is 12. Each section stands alone. ".repeat(90);
  const ok = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>A question they already answer</title>
  <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>
</head>
<body>
  <header><nav><a href="#facts">Facts</a></nav></header>
  <h1>A question they already answer</h1>
  <p>The answer is 12, the figure already on their card.</p>
  <h2>Facts</h2>
  <table><tr><th>What</th><th>Number</th></tr><tr><td>The published figure</td><td>12</td></tr></table>
  <h2>Process</h2><p>${copy}</p>
  <h2>Questions</h2>
  <dl><dt>What is the number?</dt><dd>12, the figure already on their card.</dd></dl>
  <footer>The business · the place</footer>
</body>
</html>`;
  assert.deepEqual(shippedPageFaults(ok), []);
});
