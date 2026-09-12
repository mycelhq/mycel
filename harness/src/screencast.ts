// Watching the agent work — a live picture of the browser it is driving.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The `operate` shape puts a real Chromium in the sandbox and lets the agent work inside somebody
// else's software. Everything a founder can see of that today is a list of tool calls —
// `browseruse_browser_click {index: 14}` — which is an audit trail and not a thing anybody watches.
//
// A run that produced the wrong result is also almost impossible to diagnose from that list, because
// the interesting information is what the PAGE did, and the page is invisible. "It clicked 14" tells
// you nothing when 14 turned out to be a cookie banner.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// HOW: THE DEVTOOLS SCREENCAST, WHICH IS WHAT DEVTOOLS ITSELF USES
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `Page.startScreencast` makes Chromium push a base64 JPEG on every meaningful repaint. It is cheap
// (the browser is already compositing), it needs no extra process, and it is the same mechanism
// behind the device-mode view in DevTools — so it is well-trodden rather than clever.
//
// CDP allows MULTIPLE clients on one browser. browser-use holds its own connection and drives; this
// opens a second one and only listens. Nothing here sends an input event, navigates, or evaluates
// script — see the `SAFE_METHODS` allowlist, which exists so that stays true by construction rather
// than by everyone remembering.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE PORT IS DISCOVERED, NOT ASSUMED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The obvious plan was to expose browser-use's `CHROME_DEBUG_PORT = 9242`. That constant is a
// red herring: `local_browser_watchdog.py` calls `self._find_free_port()` and passes the result to
// `--remote-debugging-port`, so the real port is random per launch and 9242 is never used.
//
// Chromium already solves this. It writes the port it actually bound to as the first line of
// `DevToolsActivePort` inside its user-data-dir — the documented mechanism every DevTools client
// uses — so `readDevToolsPort` reads the fact instead of guessing at it. That also means this works
// unchanged if browser-use ever changes how it picks a port, which a hardcoded 9242 would not.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ONE FRAME, NOT A STREAM
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This keeps only the LATEST frame and throws the rest away, and the console polls for it. Same
// decision `live-preview.tsx` documents for its status ladder, and unapologetically so: a viewer
// wants to see what the browser is showing NOW, and a buffered stream of what it showed thirty
// seconds ago is worse than useless on a run that is still going. It also means a reader who opens
// the tab late is immediately current, there is nothing to seek, and a dropped connection costs one
// frame rather than a resync.

import { Buffer } from "node:buffer";

/** The only CDP methods this client will ever send. Listening, and the two calls that start it. */
const SAFE_METHODS = new Set([
  "Page.enable",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
]);

export interface Frame {
  /** JPEG bytes, ready to serve. */
  bytes: Buffer;
  /** When Chromium painted it, not when we received it. */
  at: number;
  width: number;
  height: number;
}

export interface ScreencastOptions {
  /** JPEG quality, 1–100. Low on purpose: this is a moving picture of a UI, not an artifact. */
  quality?: number;
  /** Cap the long edge. A 1440-wide page at 60 quality is ~40KB a frame, which is the budget. */
  maxWidth?: number;
  maxHeight?: number;
  /** How long to wait for the browser to answer at all. */
  connectTimeoutMs?: number;
}

/**
 * The first page target, from CDP's own HTTP discovery endpoint.
 *
 * `type === "page"` and not the first entry: a Chromium with extensions loaded lists service
 * workers and background pages first, and attaching a screencast to a service worker produces a
 * connection that succeeds and never paints — which is the single most confusing failure this
 * feature could have.
 */
export async function findPageTarget(
  cdpBase: string,
  timeoutMs = 5_000,
): Promise<{ webSocketDebuggerUrl: string; title?: string; url?: string } | undefined> {
  try {
    const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const targets = (await res.json()) as {
      type?: string;
      url?: string;
      title?: string;
      webSocketDebuggerUrl?: string;
    }[];
    const page = targets.find(
      (t) =>
        t.type === "page" &&
        typeof t.webSocketDebuggerUrl === "string" &&
        // `about:blank` is what browser-use keeps open as a keep-alive tab. A real page is better
        // to watch, but a blank one beats nothing — so it is the fallback, never the first choice.
        !!t.url,
    );
    const real = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url && t.url !== "about:blank");
    const chosen = real ?? page;
    return chosen?.webSocketDebuggerUrl
      ? { webSocketDebuggerUrl: chosen.webSocketDebuggerUrl, title: chosen.title, url: chosen.url }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first line of `DevToolsActivePort`, which is the port Chromium actually bound to.
 *
 * The file's second line is the browser's own websocket path and is deliberately ignored: it points
 * at the BROWSER target, which cannot be screencast. The page target is found over HTTP above.
 *
 * Takes a reader rather than a path so the caller decides where the bytes come from — the same file
 * is read off a local disk in tests and out of a sandbox with `exec` in production, and this module
 * has no business knowing which.
 */
export function readDevToolsPort(contents: string): number | undefined {
  const first = contents.split("\n")[0]?.trim();
  const port = Number(first);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/**
 * A live view of one page, as a single always-current frame.
 *
 * Deliberately not an EventEmitter and deliberately not a queue. `latest()` is the whole read
 * surface: whoever asks gets the newest frame or nothing, and there is no backlog to drain, no
 * subscriber to leak and no ordering to get wrong.
 */
export class Screencast {
  private ws?: WebSocket;
  private frame?: Frame;
  private nextId = 1;
  private closed = false;
  /** Set when the socket dies, so a poller can say why instead of showing a stale picture forever. */
  private failure?: string;

  private constructor(private readonly opts: Required<Pick<ScreencastOptions, "quality" | "maxWidth" | "maxHeight">>) {}

  /**
   * Attach and start painting.
   *
   * Resolves as soon as the socket is open and the two start calls are sent — NOT on the first
   * frame. Chromium sends nothing until something repaints, so a page that is finished loading and
   * sitting still can legitimately take seconds to produce one, and blocking on that would make a
   * quiet page indistinguishable from a broken connection.
   */
  static async attach(webSocketDebuggerUrl: string, opts: ScreencastOptions = {}): Promise<Screencast> {
    const self = new Screencast({
      quality: opts.quality ?? 60,
      maxWidth: opts.maxWidth ?? 1280,
      maxHeight: opts.maxHeight ?? 800,
    });
    await self.open(webSocketDebuggerUrl, opts.connectTimeoutMs ?? 10_000);
    return self;
  }

  private open(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Node 22 ships a global WebSocket. No dependency, which matters for a kernel whose whole
      // argument is that it installs in three packages.
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        reject(new Error(`the browser did not accept a debugger connection within ${timeoutMs}ms`));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        this.send("Page.enable");
        this.send("Page.startScreencast", {
          format: "jpeg",
          quality: this.opts.quality,
          maxWidth: this.opts.maxWidth,
          maxHeight: this.opts.maxHeight,
          // Chromium coalesces repaints for us when this is set; without it a page with a spinner
          // pushes a frame per animation tick and we throw almost all of them away.
          everyNthFrame: 1,
        });
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        this.failure = "the debugger connection failed";
        reject(new Error(this.failure));
      };
      ws.onclose = () => {
        this.closed = true;
        this.failure ??= "the browser closed the debugger connection";
      };
      ws.onmessage = (e) => this.receive(String(e.data));
    });
  }

  private send(method: string, params?: Record<string, unknown>): void {
    // The allowlist is the safety property, not a formality: this connection is on a browser holding
    // a customer's logged-in session, and the difference between watching and driving is exactly
    // which strings can leave here.
    if (!SAFE_METHODS.has(method)) throw new Error(`refusing to send ${method} — this connection only watches`);
    this.ws?.send(JSON.stringify({ id: this.nextId++, method, ...(params ? { params } : {}) }));
  }

  private receive(raw: string): void {
    let msg: { method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method !== "Page.screencastFrame") return;
    const p = (msg.params ?? {}) as {
      data?: string;
      sessionId?: number;
      metadata?: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
    };
    if (typeof p.data === "string" && p.data) {
      this.frame = {
        bytes: Buffer.from(p.data, "base64"),
        // Chromium's timestamp is in seconds since the epoch, as a float.
        at: p.metadata?.timestamp ? Math.round(p.metadata.timestamp * 1000) : Date.now(),
        width: Math.round(p.metadata?.deviceWidth ?? 0),
        height: Math.round(p.metadata?.deviceHeight ?? 0),
      };
    }
    /**
     * THE ACK IS NOT OPTIONAL, and forgetting it is the classic way this feature "works for two
     * frames and then stops". Chromium will not send frame N+1 until N is acknowledged — it is the
     * backpressure mechanism, and it is what stops a slow consumer drowning in JPEGs.
     */
    if (typeof p.sessionId === "number") this.send("Page.screencastFrameAck", { sessionId: p.sessionId });
  }

  /** The newest frame, or undefined if none has arrived yet. */
  latest(): Frame | undefined {
    return this.frame;
  }

  /** Why there is no picture, when there is no picture. */
  why(): string | undefined {
    return this.frame ? undefined : (this.failure ?? "waiting for the browser to paint");
  }

  get alive(): boolean {
    return !this.closed;
  }

  stop(): void {
    this.closed = true;
    try {
      // Best effort. A browser that has already gone will not hear this, which is fine — the
      // sandbox is destroyed with the run and takes the whole thing with it.
      if (this.ws?.readyState === 1) this.send("Page.stopScreencast");
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}
