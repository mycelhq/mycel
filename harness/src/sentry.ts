/**
 * Sentry for the kernel. Cloud and landing already report; this process did not, so a thrown
 * rejection in a tick or a 500 on /v1 died in CloudWatch if anyone was looking, and nowhere if not.
 *
 * Same two properties as cloud/sentry.shared.ts:
 *   1. No DSN → no init, no request. Self-host "nothing phoning home" stays true.
 *   2. The event is not a vault. Bodies, cookies, Authorization, query strings, emails: dropped.
 *
 * Import this module first from index.ts so init runs before any other kernel import can throw.
 */
import * as Sentry from "@sentry/node";

export const SENTRY_DSN = process.env.SENTRY_DSN || "";
export const SENTRY_ENABLED = Boolean(SENTRY_DSN);

const OPAQUE = /^[A-Za-z0-9_-]{16,}$/;

/** The slice of a Sentry event we actually touch. Avoids pinning to SDK ErrorEvent generics. */
export interface ScrubEvent {
  request?: { method?: string; url?: unknown; headers?: unknown; data?: unknown; cookies?: unknown };
  user?: { id?: string | number; email?: string; ip_address?: string; username?: string };
  server_name?: string;
  contexts?: { response?: { status_code?: number; [k: string]: unknown } };
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
}

export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const u = new URL(raw, "http://relative.invalid");
    const path = u.pathname
      .split("/")
      .map((seg) => (OPAQUE.test(seg) ? ":id" : seg))
      .join("/");
    return u.origin === "http://relative.invalid" ? path : `${u.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function scrub<T extends ScrubEvent>(event: T): T {
  if (event.request) {
    event.request = { method: event.request.method, url: safeUrl(event.request.url) };
  }
  event.user = event.user?.id != null && event.user.id !== "" ? { id: String(event.user.id) } : undefined;
  event.server_name = undefined;
  if (event.contexts?.response) {
    event.contexts.response = { status_code: event.contexts.response.status_code };
  }
  event.breadcrumbs = event.breadcrumbs
    ?.filter((c) => c.category !== "console")
    .map((crumb) => {
      if (crumb.category === "http" || crumb.category === "fetch") {
        const data = crumb.data ?? {};
        return { ...crumb, data: { method: data.method, status_code: data.status_code, url: safeUrl(data.url) } };
      }
      return crumb;
    });
  return event;
}

if (SENTRY_ENABLED) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.MYCEL_CLOUD === "1" ? "production" : process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      scrub(event as unknown as ScrubEvent);
      return event;
    },
  });
}

/** Report a thrown that escaped a route or a tick. No-op when Sentry is off. */
/**
 * `context` is optional and is the difference between a report somebody can act on and one they
 * scroll past. "release-policy schema failed" in a stack trace is a line of code; the same error
 * tagged `impact: auto-release disabled` is a feature outage, and the second one gets fixed.
 */
export function captureKernelException(err: unknown, context?: Record<string, string>): void {
  if (!SENTRY_ENABLED) return;
  if (context) {
    Sentry.captureException(err, { tags: context });
    return;
  }
  Sentry.captureException(err);
}

export async function flushSentry(): Promise<void> {
  if (!SENTRY_ENABLED) return;
  await Sentry.flush(2000);
}
