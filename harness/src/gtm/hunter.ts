// Hunter — the other paid email resolver, and the one a stranger can actually sign up for.
//
// ═══ WHY A SECOND ENRICH PROVIDER ═══
//
// `enrich.ts` makes the case for FullEnrich: it is not one data vendor but a waterfall of fifteen
// behind a single call, which is what makes the provenance screen a real sequence of hops rather
// than a decoration. That is still true and this does not replace it. It is a sales-led product
// with a quote-shaped onboarding, and it was the only paid door in the repo — so for anybody
// cloning this, "find an email address" ended at a form.
//
// Hunter has a free tier with 25 searches a month and a key on the dashboard. That is not a volume
// anybody runs a business on, and it is exactly enough to watch the waterfall work once.
//
// ═══ WHAT IT DOES NOT DO, SAID HERE SO NOBODY LOOKS FOR IT ═══
//
// One address per call, keyed on domain + name. No phones, no photo, no LinkedIn URL, no company
// logo — so the profile half of enrichment stays dark on this provider and the fields simply do not
// appear. `parseRichProfile` is FullEnrich-only and must not be pointed at this.
//
// It is SYNCHRONOUS and per-person, where FullEnrich submits a batch and polls. That is the reason
// this is its own module: the two shapes do not share a call path, only a result.
//
// ═══ THE VERDICT IS THE VENDOR'S, KEPT VERBATIM ═══
//
// `verification.status` is `valid` | `accept_all` | `unknown`, and `score` is Hunter's confidence
// 0-100. An `accept_all` domain answers yes to every address, so it is NOT a deliverable one, and
// flattening those two into a boolean here would hand the sender a bounce it had been warned about.
// The status travels up uppercased, matching how FullEnrich's own verdicts are stored.

import { fetchWithDeadline } from "../http";

export const HUNTER_KEY_ENV = "HUNTER_API_KEY";

const base = (): string => (process.env.HUNTER_BASE_URL ?? "https://api.hunter.io/v2").replace(/\/$/, "");

const redact = (s: string, key: string): string => (key ? s.split(key).join("«HUNTER_API_KEY»") : s);

/** One person's result, in the shape `enrich.ts` joins on. */
export interface HunterHop {
  email?: string;
  /** Hunter's own verdict, uppercased: `VALID` | `ACCEPT_ALL` | `UNKNOWN`. Never flattened. */
  status?: string;
  /** Hunter's confidence, 0-100. Recorded as-is; it is not a probability we computed. */
  score?: number;
  /** Why there is no address. Present on every miss, so "not found" never reads as "no such person". */
  detail?: string;
}

/** `"Ada Lovelace"` → first/last. Hunter needs both, or a `full_name`. */
export function hunterName(name?: string): { first_name?: string; last_name?: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return {};
  return { first_name: parts[0], last_name: parts[parts.length - 1] };
}

/**
 * Find one work address.
 *
 * NEVER THROWS, and a miss always carries a `detail` — this spends money and the founder has to be
 * able to tell "Hunter has never seen this person" from "the key is out of searches".
 */
export async function hunterFind(target: {
  name?: string;
  company_domain?: string;
  company?: string;
}): Promise<HunterHop> {
  const key = (process.env[HUNTER_KEY_ENV] ?? "").trim();
  if (!key) return { detail: `set ${HUNTER_KEY_ENV} to look addresses up` };

  const who = hunterName(target.name);
  if (!who.first_name) return { detail: "no full name to look up — Hunter matches on a person, not a company" };

  const domain = (target.company_domain ?? "").trim().toLowerCase();
  const company = (target.company ?? "").trim();
  if (!domain && !company) return { detail: "no company domain or name to look this person up against" };

  const qs = new URLSearchParams({
    ...who,
    ...(domain ? { domain } : { company }),
    api_key: key,
  });

  try {
    const r = await fetchWithDeadline(
      `${base()}/email-finder?${qs.toString()}`,
      { headers: { accept: "application/json" } },
      // Hunter's own `max_duration` tops out at 20s; past that it has stopped looking.
      //
      // The key rides in the QUERY STRING — Hunter takes it no other way — so it is in the URL that
      // a timeout or transport error would otherwise quote back. `redact` is not optional here.
      { deadlineMs: 25_000, redact: (m) => redact(m, key) },
    );
    if (r.status === 0) return { detail: `hunter ${r.detail ?? "unreachable"}` };

    const body = (r.json ?? {}) as {
      data?: { email?: unknown; score?: unknown; verification?: { status?: unknown } };
      errors?: Array<{ details?: unknown }>;
    };

    if (!r.ok) {
      // Carry Hunter's own sentence. A 401 and a 429 are different problems with different fixes,
      // and "hunter 4xx" sends somebody reading code instead of reading their dashboard.
      const said = body.errors?.find((e) => typeof e.details === "string")?.details;
      return { detail: redact(typeof said === "string" ? said : `hunter answered ${r.status}`, key) };
    }

    const email = typeof body.data?.email === "string" ? body.data.email.trim().toLowerCase() : "";
    if (!email) {
      // A 200 with a null email is Hunter's "I looked and found nothing", which is a real answer and
      // a spent search. It is not an error and must not be reported as one.
      return { detail: "hunter has no address on file for this person" };
    }
    const status = typeof body.data?.verification?.status === "string"
      ? body.data.verification.status.toUpperCase()
      : undefined;
    const score = typeof body.data?.score === "number" ? body.data.score : undefined;
    return { email, status, score };
  } catch (e) {
    return { detail: redact((e as Error).message ?? "hunter failed", key) };
  }
}
