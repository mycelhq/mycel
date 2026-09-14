// WHAT A PERSON SEES WHILE A PREVIEW IS NOT READY YET.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE PREVIEW "NEVER WORKED"
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The proxy answered `{"error":"preview is not up yet"}` with a 503 for the entire window between a
// founder opening the tab and the dev server binding its port — which is `npm install` plus a Next.js
// cold boot, so tens of seconds on a good run. That JSON went into an `<iframe>`. What a founder saw
// was a blank frame, or a CDN's branded error page, for every second of the normal case.
//
// It was reported many times as "the preview has never worked". It was working; it was reporting the
// ordinary first minute of its life as a server failure, in a document format for machines.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE RULES A PREVIEW PROXY HAS TO HOLD
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Any proxy sitting in front of a sandbox meets the same three, and we were missing the reasoning
// for all of them:
//
//  1. EVERY STATE NEEDS A PAGE. "A preview address is a real website address: people paste it,
//     bookmark it, open it in a fresh tab, and send it to each other. Every state it can be in
//     therefore needs a page — not JSON, and not an intermediary's error interstitial."
//
//  2. THE TRANSIENT STATES ANSWER 200. Theirs, verbatim: "'The dev server has not bound the port
//     yet' is not a gateway failure — it is the ordinary first few seconds of a preview. Reporting
//     it as 502 was both wrong and fragile: Cloudflare replaces an origin 5xx with its own branded
//     error page, so the careful page below never reached the browser at all." They proved it: the
//     proxy-hop header was missing from what arrived, so it had been swapped rather than passed on.
//
//  3. THE IDENTITY STATES KEEP THEIR REAL STATUS. 401/403/404 are passed through by every
//     intermediary, and a crawler or a monitor should see them.
//
// The state is also named in a header on EVERY response, HTML included, so a probe or a log can
// attribute what happened without parsing a page — which is how the truth stays legible to machines
// after the body stopped being written for them.

/** Named on every response so nothing has to parse HTML to know what happened. */
export const PREVIEW_STATE_HEADER = "x-mycel-preview-state";

export type PreviewPageState =
  /** No such grant, or it expired. */
  | "unknown"
  /** The run has finished; the sandbox and its dev server are gone. */
  | "finished"
  /** The sandbox is up; the dev server has not been asked to start yet. */
  | "starting"
  /** `npm install` is running. The long one. */
  | "installing"
  /** The dev server is booting but has not bound its port. */
  | "booting"
  /** It bound, then stopped answering. */
  | "unreachable"
  /** The dev server exited. `detail` carries the tail of its log. */
  | "failed";

/** Transient states retry themselves; terminal ones do not. */
const TRANSIENT: ReadonlySet<PreviewPageState> = new Set(["starting", "installing", "booting", "unreachable"]);

/**
 * The status a state answers with.
 *
 * A transient state is 200 ON PURPOSE — see rule 2. `unknown` and `finished` keep 404/410, which
 * intermediaries pass through, and which are the honest answers to "is there a thing here".
 * `failed` is 200 as well: the dev server failing is not the PROXY failing, and the page carries the
 * log tail that says what actually happened. A 502 there would replace a diagnosis with a gateway's
 * guess about one.
 */
export function previewStatus(state: PreviewPageState): 200 | 404 | 410 {
  if (state === "unknown") return 404;
  if (state === "finished") return 410;
  return 200;
}

interface Copy {
  title: string;
  body: string;
}

/**
 * What each state says, in a sentence a founder can act on.
 *
 * Never "an error occurred". Every one of these names what is happening and, where there is one,
 * what it is waiting for — because the founder is watching this frame while a build runs and the
 * only question they have is whether anything is wrong.
 */
const COPY: Record<PreviewPageState, Copy> = {
  unknown: {
    title: "This preview link has expired",
    body: "Preview links are minted per run and are short-lived. Open the run again to get a fresh one.",
  },
  finished: {
    title: "The run has finished",
    body:
      "A live preview runs inside the build's own sandbox, and the sandbox is destroyed when the run " +
      "ends. The finished site is on the run's page — as a deployed address if it was published, and " +
      "as a downloadable workspace either way.",
  },
  starting: {
    title: "Starting the preview",
    body: "The sandbox is up. Bringing up the dev server now — this page will show it as soon as it answers.",
  },
  installing: {
    title: "Installing dependencies",
    body:
      "This is the long part of a first boot: a Next.js app's packages are thousands of files. It " +
      "usually takes under a minute, and this page is watching for it.",
  },
  booting: {
    title: "The dev server is starting",
    body: "Packages are in and the server is coming up. The first compile takes a few seconds.",
  },
  unreachable: {
    title: "The dev server stopped answering",
    body:
      "It was up a moment ago. This can happen while the agent edits a file that forces a restart — " +
      "still retrying.",
  },
  failed: {
    title: "The dev server could not start",
    body: "The last lines of its log are below. The build itself may still be fine — this is only the preview.",
  },
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The page.
 *
 * Self-contained: no external font, no script from anywhere, no network beyond the reload it
 * schedules for itself. It renders inside a sandboxed iframe with an opaque origin, so anything it
 * needed to fetch would fail — and a state page that cannot render is worse than the JSON it
 * replaced.
 *
 * The retry is a `<meta http-equiv="refresh">` rather than a timer in script, because the frame's
 * CSP sandbox may or may not permit scripts depending on how the proxy is configured that day, and
 * the one thing this page must always do is come back.
 */
export function previewPage(state: PreviewPageState, detail?: string): string {
  const copy = COPY[state];
  const retry = TRANSIENT.has(state);
  const tail = detail?.trim().slice(-1500);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${retry ? '<meta http-equiv="refresh" content="2">' : ""}
<title>${esc(copy.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background:Canvas; color:CanvasText; }
  main { max-width:34rem; padding:2rem; text-align:center; }
  h1 { font-size:15px; font-weight:600; margin:0 0 .5rem; }
  p { margin:0; opacity:.7; }
  pre { margin:1.25rem 0 0; padding:.75rem; text-align:left; overflow:auto; max-height:14rem;
        font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.75;
        background:color-mix(in srgb, CanvasText 6%, Canvas); border-radius:6px; }
  .dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:currentColor;
         opacity:.35; margin-right:.5rem; animation:p 1.4s ease-in-out infinite; }
  @keyframes p { 0%,100%{opacity:.2} 50%{opacity:.8} }
  @media (prefers-reduced-motion:reduce) { .dot { animation:none } }
</style>
</head><body><main>
<h1>${retry ? '<span class="dot"></span>' : ""}${esc(copy.title)}</h1>
<p>${esc(copy.body)}</p>
${tail ? `<pre>${esc(tail)}</pre>` : ""}
</main></body></html>`;
}
