// WHAT A PERSON SEES WHILE A PREVIEW IS NOT READY.
//
// The proxy answered `{"error":"preview is not up yet"}` with a 503 for the whole window between a
// founder opening the tab and the dev server binding — `npm install` plus a Next.js cold boot, so
// tens of seconds on a GOOD run. That JSON went into an iframe. It was reported many times as "the
// preview has never worked"; it was working, and reporting its ordinary first minute as a server
// failure, in a document format for machines.
//
// The rules are from kortix-ai/suna's `sandbox-proxy/preview-state-page.ts`, which had already paid
// for them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_STATE_HEADER, previewPage, previewStatus, type PreviewPageState } from "../src/preview-page";

const ALL: PreviewPageState[] = ["unknown", "finished", "starting", "installing", "booting", "unreachable", "failed"];

test("a transient state answers 200, because intermediaries swap 5xx for their own page", () => {
  // Suna proved this rather than assumed it: their proxy-hop header was MISSING from what arrived,
  // so Cloudflare had replaced the origin's careful page. A 503 here means the founder sees a
  // gateway's guess instead of what is actually happening.
  for (const s of ["starting", "installing", "booting", "unreachable"] as const) {
    assert.equal(previewStatus(s), 200, s);
  }
});

test("a dev server that failed is still not a PROXY failure", () => {
  // 200 with the log tail beats 502 with a gateway's guess about it.
  assert.equal(previewStatus("failed"), 200);
  const html = previewPage("failed", "Error: Cannot find module 'next'\n  at Module._resolve");
  assert.match(html, /Cannot find module/);
});

test("the identity states keep a real status, which intermediaries pass through", () => {
  assert.equal(previewStatus("unknown"), 404);
  assert.equal(previewStatus("finished"), 410);
});

test("every state has a page, and none of them says 'an error occurred'", () => {
  for (const s of ALL) {
    const html = previewPage(s);
    assert.match(html, /^<!doctype html>/i, s);
    assert.match(html, /<title>/, s);
    assert.doesNotMatch(html, /an error occurred/i, s);
    // A person is watching this frame while a build runs. Their only question is whether something
    // is wrong, so every page has to answer it in a sentence.
    assert.ok(html.length > 400, `${s} page is too thin to say anything`);
  }
});

test("only the transient states retry themselves", () => {
  // A terminal page that reloaded every two seconds would hammer the proxy for as long as the tab
  // stayed open, and would never show anything different.
  for (const s of ["starting", "installing", "booting", "unreachable"] as const) {
    assert.match(previewPage(s), /http-equiv="refresh"/, s);
  }
  for (const s of ["unknown", "finished", "failed"] as const) {
    assert.doesNotMatch(previewPage(s), /http-equiv="refresh"/, s);
  }
});

test("the page needs nothing from the network to render", () => {
  // It renders inside a sandboxed iframe with an opaque origin, so anything it fetched would fail —
  // and a state page that cannot render is worse than the JSON it replaced.
  for (const s of ALL) {
    const html = previewPage(s, "detail");
    assert.doesNotMatch(html, /<script/i, s);
    assert.doesNotMatch(html, /https?:\/\//, `${s} reaches off-origin`);
  }
});

test("a log tail is escaped, never interpolated", () => {
  // The tail comes from a dev server's stderr inside a sandbox running model-authored code. It is
  // the least trusted string in this file.
  const html = previewPage("failed", "<img src=x onerror=alert(1)> & \"quoted\"");
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&amp;/);
});

test("a giant log is bounded, and keeps the END", () => {
  // A stack trace's diagnosis is in its last lines; its noise is in the first thousand.
  const html = previewPage("failed", "x".repeat(50_000) + "THE ACTUAL ERROR");
  assert.ok(html.length < 12_000, `page was ${html.length} bytes`);
  assert.match(html, /THE ACTUAL ERROR/);
});

test("the state is named for machines, since the body stopped being written for them", () => {
  assert.equal(PREVIEW_STATE_HEADER, "x-mycel-preview-state");
});
