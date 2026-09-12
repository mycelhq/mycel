// THE FIRM'S OWN PALETTE, MEASURED — "the numbers are measured, not remembered".
//
// Every house style we assigned before this was `chosen`, `derived` or `default`: a designer-authored
// system picked off a shelf of twenty-nine. Good taste, correctly argued, and not theirs. opendesign's
// argument is that an AI asked for "Stripe-ish blue" returns the average of its training data, and an
// average has no brand — so the values have to come off something real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describeMeasured, measureStyle } from "../src/house-style.measure";
import { measureSite, siteUrl } from "../src/house-style.fetch";
import { api, makeFreshApp } from "./helpers";

/**
 * An owner SESSION, not the project API key.
 *
 * `canManageMembers` gates every branding route, and the `api` helper defaults to the project key —
 * which is a machine credential with no role, so it lands as 403. Changing a firm's brand is a
 * person's act; a run must not be able to repaint the business it is working for.
 */
async function asOwner() {
  const { app } = await makeFreshApp();
  const login = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@test.co", password: "secret" }),
  });
  return { app, session: login.json.token as string, projectId: login.json.projects[0].id as string };
}
import { getIdentityStore } from "../src/identity";
import { resolveStyle } from "../src/house-style";
import { resolveBrandKit } from "../src/brandkit";

/** Enough declarations to clear the floor, with a brand colour and a face repeated like a real site. */
const site = (extra: string) =>
  Array.from({ length: 45 }, (_, i) => `.f${i} { margin: ${i}px }`).join("\n") + "\n" + extra;

test("measure: the brand colour is the one that repeats", () => {
  const css = site(`
    .a { color: #c8102e } .b { background: #c8102e } .c { border-top-color: #c8102e }
    .d { color: #00a3ad } .e { background-color: #00a3ad }
    .one-off { color: #7b2d8e }
    body { font-family: "Sohne", Helvetica, sans-serif } h1 { font-family: Sohne, serif }
  `);
  const m = measureStyle(css);
  assert.deepEqual(m.colors, ["#c8102e", "#00a3ad"], "frequency did not rank the brand colours first");
  // Once is not a brand — it is an illustration, a badge, a third-party embed.
  assert.ok(!m.colors.includes("#7b2d8e"));
  assert.deepEqual(m.fonts, ["sohne"]);
  assert.equal(m.problem, undefined);
});

test("measure: neutrals are dropped, or every firm gets the same three", () => {
  // Every site on earth ships more #fff, #000 and #f5f5f5 than anything else. An unfiltered count
  // returns those for everybody and tells us nothing about anybody.
  const css = site(`
    body { background: #ffffff } .p { background: #ffffff } .q { background: #ffffff }
    .r { color: #111111 } .s { color: #111111 } .t { color: #f5f5f5 } .u { color: #f5f5f5 }
    .brand { color: #c8102e } .brand2 { background: #c8102e }
  `);
  assert.deepEqual(measureStyle(css).colors, ["#c8102e"]);
});

test("measure: a stack's first name is the choice; the rest are fallbacks nobody picked", () => {
  const css = site(`
    body { font-family: "GT America", Helvetica, Arial, sans-serif }
    p { font-family: 'GT America', system-ui }
    code { font-family: monospace }
  `);
  const m = measureStyle(css);
  assert.deepEqual(m.fonts, ["gt america"]);
  // Counting the generics would rank "sans-serif" as every firm's brand face.
  assert.ok(!m.fonts.includes("helvetica") && !m.fonts.includes("monospace"));
});

test("measure: short hex and rgb() both normalise to one colour", () => {
  const css = site(`.a { color: #c03 } .b { background: rgb(204, 0, 51) } .c { border-color: #cc0033 }`);
  assert.deepEqual(measureStyle(css).colors, ["#cc0033"], "the same colour was counted as three");
});

test("measure: colours inside images and gradients are illustration, not brand", () => {
  // A bare hex sweep counts everything in `background-image` gradients and SVG data URIs. On a site
  // with one big hero that noise outweighs everything real.
  const css = site(`
    .hero { background-image: linear-gradient(#ff0088, #8800ff), url("data:image/svg+xml,%3Csvg fill='%2300ff00'") }
    .brand { color: #c8102e } .brand2 { border-color: #c8102e }
  `);
  assert.deepEqual(measureStyle(css).colors, ["#c8102e"]);
});

test("measure: too little CSS is a named problem, not an empty answer", () => {
  // The commonest real cause by a distance: the site styles itself with JavaScript, so the sheet we
  // fetched is a shell. A founder can act on that sentence; a zero cannot.
  const m = measureStyle(".a { color: #c8102e } .b { color: #c8102e }");
  assert.deepEqual(m.colors, []);
  assert.match(m.problem ?? "", /JavaScript/);
  assert.equal(describeMeasured(m), m.problem);
});

test("measure: a readable but colourless site says so rather than returning nothing", () => {
  const m = measureStyle(site(`.a { color: #111 } .b { color: #111 } .c { background: #fff } .d { background: #fff }`));
  assert.deepEqual(m.colors, []);
  assert.match(m.problem ?? "", /black, white and grey/);
});

test("measure: at most three colours and three faces reach a run", () => {
  // Three colours and two faces is a brand. Twelve of each is a screenshot of a stylesheet, and a run
  // handed that produces a document wearing everything at once.
  const many = Array.from({ length: 9 }, (_, i) => {
    const h = `#${(i + 1).toString(16)}0${(9 - i).toString(16)}0c8`;
    return `.x${i} { color: ${h} } .y${i} { background: ${h} }`;
  }).join("\n");
  assert.equal(measureStyle(site(many)).colors.length, 3);
});

test("measure: the readout is specific, because specificity is the proof we opened it", () => {
  const m = measureStyle(site(`
    .a { color: #c8102e } .b { background: #c8102e }
    body { font-family: Sohne, serif } p { font-family: Sohne, serif }
  `));
  const said = describeMeasured(m);
  assert.match(said, /#c8102e/, "a founder cannot check a claim that does not quote a value");
  assert.match(said, /sohne/i);
});

test("measure: nothing here reaches the network or a model", () => {
  // Same property `file-shape.ts` and `design-lint.ts` have. The part that must be exactly right
  // should be testable without either — and a measurement that asked a model what a site looks like
  // is the remembering this module exists to replace.
  const text = readFileSync(new URL("../src/house-style.measure.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const banned of ["fetch(", "import(", "openai", "anthropic", "await "]) {
    assert.ok(!text.includes(banned), `the measurement module reaches for ${banned}`);
  }
});

// ── the fetching half ────────────────────────────────────────────────────────────────────────────

test("fetch: a private or non-public address is refused before any request is made", async () => {
  // WITHOUT THIS THE FIELD IS SERVER-SIDE REQUEST FORGERY WITH A FRIENDLY LABEL. A founder — or
  // anyone who can set that field — types the cloud metadata address and the worker fetches instance
  // credentials on their behalf.
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",
    "localhost:3000",
    "http://127.0.0.1",
    // A `.internal` host, and deliberately NOT ours.
    //
    // This was our real internal hostname, which taught the test nothing extra — the rule under
    // examination is that a non-public address is refused, and any `.internal` name proves it. What
    // it DID do was block `publish-oss.sh`, whose scanner refuses to ship a staged tree containing
    // an internal hostname. That guard is right, and it is the reason the public repo went 491
    // commits stale: the publish failed on a test fixture and nobody chased it.
    "kernel.example.internal",
    "printer.local",
    "10.0.0.1",
    "not a url",
    "",
  ]) {
    assert.equal(siteUrl(bad), undefined, `${bad} was accepted`);
    let called = 0;
    const r = await measureSite(bad, async () => {
      called++;
      return { ok: true, body: "<style>.a{color:#c8102e}</style>" };
    });
    assert.equal(called, 0, `${bad} reached the network`);
    assert.ok(r.problem, `${bad} produced no explanation`);
  }
});

test("fetch: http is upgraded to https rather than followed", async () => {
  // A founder typing `example.com` means their website. Following that to http would let anyone on
  // the path choose the CSS we then store as this firm's brand.
  assert.equal(siteUrl("http://acme.test"), "https://acme.test/");
  assert.equal(siteUrl("acme.test"), "https://acme.test/");
  assert.equal(siteUrl("https://acme.test/about"), "https://acme.test/about");
});

test("fetch: inline styles and linked sheets are both read, relative hrefs resolved", async () => {
  const seen: string[] = [];
  const rule = (n: number) => Array.from({ length: n }, (_, i) => `.f${i}{margin:${i}px}`).join("");
  const r = await measureSite("acme.test", async (url) => {
    seen.push(url);
    if (url === "https://acme.test/")
      return {
        ok: true,
        url: "https://acme.test/",
        body: `<html><head><style>.a{color:#c8102e}.b{background:#c8102e}</style>
               <link rel="stylesheet" href="/s/site.css">
               <link rel="preload" href="/s/nope.css">
               </head><body></body></html>`,
      };
    return { ok: true, body: `${rule(50)} .c{border-color:#c8102e} body{font-family:Sohne,serif} p{font-family:Sohne,serif}` };
  });
  assert.deepEqual(seen, ["https://acme.test/", "https://acme.test/s/site.css"], "a preload link was fetched as a stylesheet");
  assert.deepEqual(r.colors, ["#c8102e"]);
  assert.deepEqual(r.fonts, ["sohne"]);
  assert.equal(r.sheets, 1);
  // A claim needs a source the founder can check.
  assert.equal(r.url, "https://acme.test/");
});

test("fetch: an unreachable site is a sentence, never a throw", async () => {
  const boom = await measureSite("acme.test", async () => {
    throw new Error("ENOTFOUND");
  });
  assert.match(boom.problem ?? "", /could not reach/i);
  const empty = await measureSite("acme.test", async () => ({ ok: false, body: "" }));
  assert.match(empty.problem ?? "", /could not read/i);
});

test("fetch: one unreachable stylesheet does not lose the reading", async () => {
  const rule = Array.from({ length: 50 }, (_, i) => `.f${i}{margin:${i}px}`).join("");
  const r = await measureSite("acme.test", async (url) => {
    if (url.endsWith("/broken.css")) throw new Error("500");
    if (url === "https://acme.test/") {
      return {
        ok: true,
        body: `<link rel=stylesheet href="/broken.css"><link rel=stylesheet href="/good.css">`,
      };
    }
    return { ok: true, body: `${rule} .a{color:#c8102e} .b{background:#c8102e}` };
  });
  assert.deepEqual(r.colors, ["#c8102e"]);
  assert.equal(r.sheets, 1);
});

// ── the routes, which are the part that has to exist for any of the above to matter ──────────────

test("route: reading a site stores evidence and changes nothing that renders", async () => {
  const { app, session, projectId } = await asOwner();

  const real = globalThis.fetch;
  const rule = Array.from({ length: 60 }, (_, i) => `.f${i}{margin:${i}px}`).join("");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith("https://acme.test")) return real(input as never);
    const body =
      u === "https://acme.test/"
        ? `<link rel=stylesheet href="/a.css">`
        : `${rule} .a{color:#c8102e} .b{background:#c8102e} body{font-family:Sohne,serif} p{font-family:Sohne,serif}`;
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const r = await api(app, `projects/${projectId}/branding/measure`, {
      method: "POST",
      body: JSON.stringify({ website: "acme.test" }),
    }, session);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.measured.colors, ["#c8102e"]);
    assert.deepEqual(r.json.measured.fonts, ["sohne"]);
    // STORING IS NOT ADOPTING. Nothing that renders may change until the founder says yes.
    assert.equal(r.json.measured.accepted_at, undefined);
    assert.equal(resolveStyle(getIdentityStore().brandKit(projectId)).evidence !== "measured", true);

    const acc = await api(app, `projects/${projectId}/branding/measure/accept`, { method: "POST" }, session);
    assert.equal(acc.status, 200);
    assert.ok(acc.json.measured.accepted_at);
    const pinned = resolveStyle(getIdentityStore().brandKit(projectId));
    assert.equal(pinned.evidence, "measured");
    assert.equal(pinned.accent, "#c8102e", "the accepted reading did not reach the pin");
  } finally {
    globalThis.fetch = real;
  }
});

test("route: a re-read drops the old confirmation rather than inheriting it", async () => {
  // A new measurement is a NEW claim. Carrying the old `accepted_at` across would let a re-read
  // silently repaint work the founder already accepted in a different palette.
  const { app, session, projectId } = await asOwner();
  const real = globalThis.fetch;
  const rule = Array.from({ length: 60 }, (_, i) => `.f${i}{margin:${i}px}`).join("");
  let colour = "#c8102e";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith("https://acme.test")) return real(input as never);
    // A `<style>` block, not raw CSS: the page is HTML and the measurement reads inline blocks and
    // linked sheets. Returning bare CSS as a page body measured nothing and read as a code bug.
    return new Response(`<html><head><style>${rule} .a{color:${colour}} .b{background:${colour}}</style></head></html>`, {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await api(app, `projects/${projectId}/branding/measure`, { method: "POST", body: JSON.stringify({ website: "acme.test" }) }, session);
    await api(app, `projects/${projectId}/branding/measure/accept`, { method: "POST" }, session);
    assert.equal(resolveStyle(getIdentityStore().brandKit(projectId)).evidence, "measured");

    colour = "#00a3ad";
    await api(app, `projects/${projectId}/branding/measure`, { method: "POST", body: JSON.stringify({ website: "acme.test" }) }, session);
    const after = resolveStyle(getIdentityStore().brandKit(projectId));
    assert.notEqual(after.evidence, "measured", "a re-read inherited the previous confirmation");
  } finally {
    globalThis.fetch = real;
  }
});

test("route: accepting nothing is refused, so a confirmation always has a claim under it", async () => {
  /**
   * ITS OWN PROJECT, because the identity store is process-wide.
   *
   * `makeFreshApp` resets the domain store; the seeded owner and their first project survive every
   * test in this file. So this asserted "nothing measured" against a project an earlier test had
   * measured and accepted, and passed or failed on declaration order — which is a test that proves
   * whatever ran before it.
   */
  const { app, session } = await asOwner();
  const made = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "Unmeasured Ltd" }) }, session);
  assert.equal(made.status, 201, made.text);
  const projectId = made.json.project.id as string;
  const r = await api(app, `projects/${projectId}/branding/measure/accept`, { method: "POST" }, session);
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /nothing measured/);
});

test("route: a private address never reaches the network, through the route as well", async () => {
  // The guard is in `siteUrl`, and this proves it is actually in the path a caller reaches rather
  // than only in a unit test of a function the route might have bypassed.
  const { app, session, projectId } = await asOwner();
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    called++;
    return real(input as never);
  }) as typeof fetch;
  try {
    const r = await api(app, `projects/${projectId}/branding/measure`, {
      method: "POST",
      body: JSON.stringify({ website: "http://169.254.169.254/latest/meta-data/" }),
    }, session);
    assert.equal(r.status, 200);
    assert.match(String(r.json.measured.problem), /public website address/);
    assert.equal(called, 0, "the worker fetched cloud instance metadata on a founder's behalf");
  } finally {
    globalThis.fetch = real;
  }
});

test("measure: hsl is read, because a stylesheet written in it is not a colourless brand", async () => {
  // Stripe's stylesheet uses `hsl` twenty-seven times. Without this a firm whose CSS is written in
  // it reads as having no brand colour at all — the most confidently wrong answer this can give.
  const css = site(`
    .a { color: hsl(210, 40%, 50%) } .b { background: hsl(210 40% 50%) }
    .c { border-color: hsla(210,40%,50%,0.8) }
  `);
  assert.deepEqual(measureStyle(css).colors, ["#4d80b3"], "both hsl spellings must fold to one colour");
});

test("measure: oklch is deliberately not parsed, because it is always behind a variable", async () => {
  // Every real use found on live sites is `oklch(var(--brand-blue))` — the components live in a
  // custom property, so parsing the function without resolving the cascade yields nothing. Guessing
  // would be worse than the honest "we found no colour".
  const m = measureStyle(site(`.a { color: oklch(var(--blue)) } .b { background: oklch(var(--blue)) }`));
  assert.deepEqual(m.colors, []);
  assert.match(m.problem ?? "", /black, white and grey/);
});

// ── over a real socket, not a stub ───────────────────────────────────────────────────────────────

/**
 * THE GAP A STUBBED FETCHER CANNOT CLOSE.
 *
 * Every test above hands `measureSite` a function that returns a string. That proves the parsing and
 * the link-following and proves nothing about whether the thing works against an HTTP server — which
 * is the only mode it runs in. So these bind a real one on an ephemeral loopback port and drive the
 * same fetcher shape the route uses.
 *
 * `127.0.0.1` is refused by `siteUrl`, correctly and on purpose, so these call `measureStyle` through
 * a fetcher that has actually spoken HTTP rather than going through the host guard. The guard has its
 * own tests; this one is about sockets.
 */
async function serving(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; close: () => void }> {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

const realFetcher = async (url: string) => {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(4_000) });
  return { ok: res.ok, body: await res.text(), url };
};

test("socket: a page and its linked sheet are fetched and measured for real", async () => {
  const rule = Array.from({ length: 50 }, (_, i) => `.f${i}{margin:${i}px}`).join("");
  const { base, close } = await serving((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><head><link rel="stylesheet" href="/brand.css"></head><body></body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/css" });
    res.end(`${rule} .a{color:#c8102e} .b{background:#c8102e} body{font-family:Sohne,serif} p{font-family:Sohne,serif}`);
  });
  try {
    // `measureSite`'s host guard refuses loopback, so drive the same two steps it does.
    const page = await realFetcher(`${base}/`);
    const href = /href\s*=\s*"([^"]+)"/.exec(page.body)![1]!;
    const sheet = await realFetcher(new URL(href, `${base}/`).toString());
    const m = measureStyle(sheet.body);
    assert.deepEqual(m.colors, ["#c8102e"]);
    assert.deepEqual(m.fonts, ["sohne"]);
  } finally {
    close();
  }
});

test("socket: a server that lies about its encoding is a sentence, not a crash", async () => {
  // THE FAILURE THIS PINS. A CDN or a proxy that sets `content-encoding: gzip` over plain bytes makes
  // `fetch` reject while reading the body — after the response headers have already succeeded. If
  // that were unhandled it would take the worker down on the day one customer's site misbehaves.
  //
  // It is catchable: `fetch` rejects with a TypeError and `fetchWithDeadline`'s try/catch turns it
  // into `ok: false`, which `measureSite` reports as "we could not read anything at that address".
  const { base, close } = await serving((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    res.end("<style>.a{color:#c8102e}</style>");
  });
  try {
    let threw: unknown;
    await realFetcher(`${base}/`).catch((e) => {
      threw = e;
    });
    assert.ok(threw, "a lying content-encoding no longer throws — this test is now vacuous");

    // And through `measureSite`, which is what the route actually calls: a sentence, never a throw.
    const r = await measureSite("acme.test", () => Promise.reject(threw));
    assert.match(r.problem ?? "", /could not reach/i);
  } finally {
    close();
  }
});

// ── the chain has to reach the client, or it is half a brand ─────────────────────────────────────

test("chain: an accepted colour reaches the client portal, not just the deliverable", async () => {
  // THE GAP THIS CLOSES. resolveStyle put the measured colour on the deliverable pin. The BRAND KIT
  // — which is what `/v1/portal/business` returns and the portal's rule and mark are drawn from —
  // had a precedence of typed hex → system → look → default, with no measurement in it. So a founder
  // read their site, said "that's us", and their client's portal still wore our green. Half a brand
  // is worse than none: it is the product saying it heard and then not acting.
  const { app, session, projectId } = await asOwner();
  const real = globalThis.fetch;
  const rule = Array.from({ length: 60 }, (_, i) => `.f${i}{margin:${i}px}`).join("");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith("https://acme.test")) return real(input as never);
    return new Response(`<html><head><style>${rule} .a{color:#c8102e}.b{background:#c8102e}</style></head></html>`, {
      status: 200,
    });
  }) as typeof fetch;

  try {
    await api(app, `projects/${projectId}/branding/measure`, {
      method: "POST",
      body: JSON.stringify({ website: "acme.test" }),
    }, session);

    // Unaccepted: the portal must NOT be repainted on a reading nobody agreed to.
    assert.notEqual(getIdentityStore().brandKit(projectId)?.accent, "#c8102e", "an unconfirmed reading repainted the client's portal");

    await api(app, `projects/${projectId}/branding/measure/accept`, { method: "POST" }, session);
    assert.equal(getIdentityStore().brandKit(projectId)?.accent, "#c8102e", "the confirmed colour never reached the kit");
  } finally {
    globalThis.fetch = real;
  }
});

test("chain: a hex the founder typed still beats one we read", () => {
  // Typing is a direct statement; accepting is agreeing with one we proposed. When both exist the
  // more deliberate act wins.
  const kit = resolveBrandKit(
    { accent: "#123456", measured: { at: "", colors: ["#c8102e"], fonts: [], accepted_at: "2026-09-08T00:00:00.000Z" } } as never,
    "Acme",
  );
  assert.equal(kit.accent, "#123456");
});

test("chain: a measured value that is not a colour never reaches a style attribute", () => {
  // It was produced by a regex over bytes we did not write, and it ends up in a style attribute and
  // a PDF colour operator.
  const kit = resolveBrandKit(
    { measured: { at: "", colors: ["red; background:url(x)", "#c8102e"], fonts: [], accepted_at: "2026-09-08T00:00:00.000Z" } } as never,
    "Acme",
  );
  assert.equal(kit.accent, "#c8102e", "it took the first entry without validating it");
});
