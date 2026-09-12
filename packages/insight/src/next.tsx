"use client";
/**
 * The Next.js integration: one provider for the browser, one route-handler factory for the server.
 *
 * Two Next-specific facts shape everything below, and both have already cost this codebase time:
 *
 * **`NEXT_PUBLIC_*` is inlined at BUILD time.** It is a string substitution performed by the
 * bundler, not a variable read at runtime. So a `NEXT_PUBLIC_INSIGHT_KEY` baked into a build is
 * frozen until the next deploy — rotating the key in the hosting dashboard changes nothing, and the
 * failure is silent. That is why the ingest key here is a SERVER env var read inside the route
 * handler on every request, and why the provider is told whether analytics is on via a PROP passed
 * down from a Server Component rather than by reading an env var itself.
 *
 * **Server Components cannot set cookies.** Only a route handler or a server action can. This
 * package needs no cookie at all — the anonymous id is first-party `localStorage` written by the
 * browser after consent — so the constraint is satisfied by construction rather than worked around.
 * Worth stating explicitly, because "put the visitor id in a cookie so SSR can read it" is the
 * obvious next idea and it is the one that turns this into a cookie banner problem.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { onConsentChange, readConsent } from "./consent";
import type { Insight } from "./client";
import { LIMITS } from "./types";

export interface InsightProviderProps {
  /**
   * Whether this deployment collects anything. Pass `!!process.env.INSIGHT_INGEST_KEY` from a
   * Server Component — a server env read, evaluated per request, not inlined at build.
   */
  enabled?: boolean;
  /** Defaults to the route handler below, mounted at `/api/insight`. */
  endpoint?: string;
  /** The product's declared funnel. Without it events still land; drop-off just isn't computed. */
  funnel?: { name: string; steps: readonly string[] };
  children?: ReactNode;
}

/**
 * Mount once, in the root layout, inside a Server Component that passes `enabled`.
 *
 * The dynamic import is not an optimisation. It is the consent discipline from
 * `landing/components/analytics.tsx`: a visitor who has not said yes never downloads the tracking
 * code, so there is nothing on the page that COULD fire before they answer. A banner rendered
 * alongside an already-loaded tracker is a notice, not consent, and under UK/EU rules that makes
 * every event collected under it unlawful. Consent is checked before the import, and the import is
 * what creates the client.
 */
export function InsightProvider(props: InsightProviderProps): ReactNode {
  const { enabled = true, endpoint, funnel, children } = props;
  const insight = useRef<Insight | null>(null);
  const [granted, setGranted] = useState<boolean>(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const apply = (consent: string | null) => {
      if (!alive) return;
      setGranted(consent === "granted");
      if (consent !== "granted") {
        // Withdrawal: the client's own consent listener clears storage and drops the queue. Tearing
        // it down here as well means a re-grant re-imports fresh rather than reviving old state.
        insight.current?.shutdown();
        insight.current = null;
        return;
      }
      if (insight.current) return;
      void import("./client").then((mod) => {
        if (!alive || readConsent() !== "granted") return;
        insight.current = mod.initInsight({ enabled: true, endpoint, funnel });
        insight.current.pageview();
      });
    };

    apply(readConsent());
    const off = onConsentChange(apply);
    return () => {
      alive = false;
      off();
      insight.current?.shutdown();
      insight.current = null;
    };
    // `funnel` is a literal in practice; re-running on identity change would tear down the client on
    // every render, which is worse than missing a funnel edit that requires a deploy anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, endpoint]);

  /**
   * Client-side navigation, without importing `next/navigation`.
   *
   * `usePathname()` would be the idiomatic call, and it would make this package depend on Next's
   * types and pin it to the App Router. Patching the history methods works in the App Router, the
   * Pages Router and any other client router, and it is what the router itself calls — so there is
   * no navigation shape this misses. Restored on unmount so HMR doesn't stack wrappers.
   */
  useEffect(() => {
    if (!granted || typeof window === "undefined") return;
    let last = window.location.pathname;
    const changed = () => {
      const now = window.location.pathname;
      if (now === last) return;
      last = now;
      insight.current?.pageview(now);
    };
    const { pushState, replaceState } = window.history;
    window.history.pushState = function patched(...args: Parameters<History["pushState"]>) {
      pushState.apply(this, args);
      changed();
    };
    window.history.replaceState = function patched(...args: Parameters<History["replaceState"]>) {
      replaceState.apply(this, args);
      changed();
    };
    window.addEventListener("popstate", changed);
    return () => {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      window.removeEventListener("popstate", changed);
    };
  }, [granted]);

  return children ?? null;
}

// ── server ─────────────────────────────────────────────────────────────────────────────────────

export interface InsightRouteOptions {
  /** The kernel's base URL. Defaults to `MYCEL_KERNEL_URL`, then localhost for development. */
  kernelUrl?: string;
  /** The per-project ingest key. Defaults to `INSIGHT_INGEST_KEY` — deliberately NOT `NEXT_PUBLIC_`. */
  ingestKey?: string;
  /** Give up rather than hold a customer's request open while the kernel is slow. */
  timeoutMs?: number;
}

/**
 * The route handler the browser actually posts to.
 *
 *   // app/api/insight/route.ts
 *   export const { POST } = createInsightRoute();
 *
 * It exists to keep the ingest key server-side. A key shipped to the browser is a key anyone can
 * read and replay into a founder's analytics — not catastrophic (it can only append events to one
 * project) but it turns their funnel numbers into something a competitor can poison, and there is
 * no reason to accept that when a same-origin hop costs nothing.
 *
 * It is also the first bounds check. Treat this as a hostile input path: it is reachable by anyone
 * who can load the product's homepage.
 */
export function createInsightRoute(options: InsightRouteOptions = {}): {
  POST: (request: Request) => Promise<Response>;
} {
  const POST = async (request: Request): Promise<Response> => {
    // Read at REQUEST time, never at module scope: a module-scope read is evaluated during the
    // build on some hosts, which is how a rotated key silently keeps using the old one.
    const key = options.ingestKey ?? process.env.INSIGHT_INGEST_KEY ?? "";
    const base = options.kernelUrl ?? process.env.MYCEL_KERNEL_URL ?? "http://localhost:8787";
    // Unconfigured is a success, not an error. A founder running the template locally should see a
    // working product, not a console full of failed analytics posts.
    if (!key) return new Response(null, { status: 204 });

    // Cheap length check before reading the stream. `content-length` can lie, so the read is capped
    // as well — a chunked body with no length header is the obvious way past a header-only check.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > LIMITS.maxBodyBytes) return new Response(null, { status: 413 });
    let body: string;
    try {
      body = await request.text();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (body.length > LIMITS.maxBodyBytes) return new Response(null, { status: 413 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/insight/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });
      // The kernel's reason for refusing is not the browser's business — it would tell an attacker
      // which of the caps they tripped. Two outcomes leave this function: accepted, or not.
      return new Response(null, { status: res.ok ? 204 : 400 });
    } catch {
      return new Response(null, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  };
  return { POST };
}
