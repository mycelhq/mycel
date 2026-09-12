// Working inside a system that has no API.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE BROWSER WAS BUILT FOR GEO AND IT IS NOT A GEO CAPABILITY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `operate` mounts browser-use so `probe_surface` can ask a question on a real answer engine. That
// is the narrowest possible use of the most general tool in this system, and everything else the
// shape could do was blocked by one line in the skill: **do not sign in to anything.**
//
// Which is correct for an answer engine and wrong for everything else, because the actual daily work
// of a service business is somebody logging into a system that has no API and moving information
// around. A supplier portal with the month's invoices. A council planning portal with an application
// status. An insurer's extranet. A wholesaler's order history. A client's own CMS.
//
// None of those have an API. All of them need a login. So the browser could see the whole internet
// and none of the six systems the work actually lives in.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE CONTAINMENT IS NOT A TOOL ALLOWLIST, WHICH WAS THE FIRST DESIGN
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The obvious move is to split browser-use's tools into read and write — allow `navigate`,
// `get_state`, `screenshot`; deny `click`, `type`, `upload` — and call the first set safe.
//
// It does not survive contact with a real portal. Reading a supplier's invoices means clicking
// through pagination, typing a date range into a filter, and expanding a row. Those are the same
// three tools that submit a form. Meanwhile `navigate` alone can delete something, because plenty of
// software still puts destructive actions behind a GET.
//
// So a verb-based split would forbid most reading and permit some writing: precisely inverted.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTAINMENT THAT WORKS, IN THREE LAYERS, NONE OF WHICH IS A PROMPT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. ONE ORIGIN. `BROWSER_USE_ALLOWED_DOMAINS` is enforced inside the browser session, not asked
//      for in a prompt. A run holding a credential for the client's WordPress cannot navigate to
//      their bank — not "is told not to", cannot. This is the layer that actually contains.
//
//   2. THE ACCOUNT'S OWN PERMISSIONS, WHICH ARE THE CLIENT'S TO SET. The honest answer to "what can
//      this thing do in my system" is not a promise we make; it is the role on the account they
//      hand over. A read-only user in their portal cannot publish, whatever our code does, and that
//      is a far stronger guarantee than anything enforceable from this side. `access` below records
//      what they SAID they granted so the founder can see it — it does not enforce it, and the
//      comment on the field says so, because a field that looks like a permission and is not one is
//      worse than no field.
//
//   3. THE TASK DECLARES WHETHER IT CHANGES ANYTHING, and the approval gate sits there — at the
//      task, where a human can read what is about to happen, rather than at the click, where they
//      would be approving `click index 14` with no idea what it does.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND THE CREDENTIAL NEVER REACHES THE MODEL
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// It is written into the browser's own cookie store inside the sandbox, the way the LinkedIn package
// already does it. Nothing about it enters the prompt, the transcript or an event. An agent that
// cannot read a session cookie cannot leak one, and this is the same reasoning `mcpbridge.ts` uses
// to keep provider keys out of a sandbox.
import type { Connection } from "./contract";

/** The connection kind. `config.origin` is the one system; the session lives in the vault. */
export const BROWSER_CONNECTION_KIND = "browser";

/**
 * What the founder says this account may do in the client's system.
 *
 * DECLARED, NOT ENFORCED, and the distinction matters enough to be in the type. The real permission
 * is the role on the account the client handed over — a read-only portal user cannot publish
 * whatever value sits here. This exists so the founder can see what they believed they were granted,
 * so a task that intends to change something can refuse a connection marked `read`, and so an audit
 * has something to compare against.
 *
 * A field that looked like a security boundary and was not one would be worse than no field at all.
 */
export type BrowserAccess = "read" | "act";

export interface BrowserTarget {
  connection_id: string;
  /** Scheme and host, normalised. `https://portal.example.com`. */
  origin: string;
  /** What goes in `BROWSER_USE_ALLOWED_DOMAINS`. Host only — the browser matches on host. */
  host: string;
  access: BrowserAccess;
  /** For the trace and the founder's screen. Never the credential. */
  name: string;
}

/**
 * The origin, normalised, or `undefined` if it is not one.
 *
 * Strict on purpose. This string becomes the domain lock, so a value that parses loosely produces a
 * lock that holds loosely — and the whole containment argument above rests on this one field being
 * exactly what it claims.
 */
export function normaliseOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  // HTTPS ONLY. A credential replayed over http: is a credential handed to whoever is on the path,
  // and there is no system worth working in that is worth doing that for.
  if (u.protocol !== "https:") return undefined;
  if (!u.hostname || !u.hostname.includes(".")) return undefined;
  return `https://${u.hostname.toLowerCase()}`;
}

/**
 * Read a connection into a target, or refuse it.
 *
 * Refuses rather than defaults, everywhere. A connection missing its origin is not a connection to
 * "anywhere"; it is a misconfiguration, and the failure mode of guessing is a credentialed browser
 * with no domain lock, which is the one outcome this file exists to prevent.
 */
export function browserTarget(conn: Connection | undefined): BrowserTarget | undefined {
  if (!conn || conn.kind !== BROWSER_CONNECTION_KIND) return undefined;
  const origin = normaliseOrigin((conn.config as { origin?: unknown } | undefined)?.origin);
  if (!origin) return undefined;
  const declared = (conn.config as { access?: unknown } | undefined)?.access;
  return {
    connection_id: conn.id,
    origin,
    host: new URL(origin).hostname,
    // `read` unless `act` was explicitly chosen. The safe reading of an absent or unrecognised value
    // is the smaller claim, and a connection written before this field existed made no claim at all.
    access: declared === "act" ? "act" : "read",
    name: conn.name,
  };
}

/**
 * The domain lock for a run, given its target.
 *
 * The bare host AND `*.host`. A portal that serves its login on `accounts.example.com` and its work
 * on `portal.example.com` is one system to the person using it, and a lock that only admitted the
 * exact host would break on the first redirect — which reads as "the portal is broken", not as "the
 * lock is too tight", and gets loosened by whoever debugs it at 2am.
 *
 * Note what this does NOT do: no second host, ever, however reasonable it looks. An identity
 * provider on a different domain is a real and common case, and it is a decision for whoever set up
 * the connection rather than a guess made here — `config.origin` can name the one that matters, or
 * the connection can be refused, and both are better than a lock that quietly widens itself.
 */
export function domainLock(t: BrowserTarget): string[] {
  return [t.host, `*.${t.host}`];
}

/**
 * Whether a task that intends to CHANGE something may use this connection.
 *
 * The declared access is a floor, not a guarantee. A task that only reads runs against either; a
 * task that writes refuses a connection the founder marked read-only, because the alternative is
 * discovering the mismatch by changing something in a client's live system.
 */
export function mayWrite(t: BrowserTarget): boolean {
  return t.access === "act";
}

/** The one-line reason a write task cannot use a read connection. Shown to the founder, not logged. */
export function refuseWrite(t: BrowserTarget): string {
  return (
    `"${t.name}" is connected for reading only, so this job cannot change anything in ${t.host}. ` +
    `Reconnect it with access to act if that is what you want it to do — and give it an account in ` +
    `${t.host} with exactly the permissions you are comfortable with, because that account's own ` +
    `role is what actually decides, not this setting.`
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GETTING THE SESSION INTO THE BROWSER WITHOUT IT PASSING THROUGH THE MODEL
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Verified against the pinned wheel rather than designed from hope.
//
// `browser_use/browser/watchdogs/storage_state_watchdog.py` loads `browser_profile.storage_state` on
// `BrowserConnected`. Given a PATH it reads the file and applies it over CDP — `Storage.setCookies`
// for cookies, and `origins` for localStorage and sessionStorage, which matters because plenty of
// modern portals keep their auth in localStorage and a cookies-only design would silently fail on
// exactly those.
//
// `browser_profile` reaches it from a config file, and `config.py`'s `BrowserProfileEntry` is
// `extra='allow'`, so `storage_state` passes through untouched. `BROWSER_USE_CONFIG_PATH` says which
// file. Three documented mechanisms, no patching.
//
// The important property: the session is written to a file the BROWSER reads. It is never in the
// prompt, the transcript or an event, so an agent that cannot see a cookie cannot leak one — the
// same reasoning mcpbridge.ts uses to keep provider keys out of a sandbox.

/** Inside the sandbox. Under the browser-use config dir, which is already its own. */
export const SESSION_PATH = "~/.config/browseruse/mycel-session.json";
export const BROWSER_CONFIG_PATH = "~/.config/browseruse/mycel-config.json";
/** browser-use resolves `~` itself for its own config dir, but not for a path we hand it. */
export const SESSION_PATH_ABS = "/root/.config/browseruse/mycel-session.json";

/** Playwright's `storageState` shape, which is what the watchdog parses. */
export interface StorageState {
  cookies?: unknown[];
  origins?: unknown[];
}

/**
 * The stored secret, parsed, or `undefined` if it is not a session.
 *
 * A vault value that is not valid JSON, or is JSON with neither cookies nor origins, is a
 * misconfiguration and not "an empty session". Returning `undefined` makes the run fail to
 * authenticate loudly at the portal's login page, which is diagnosable; silently mounting `{}` would
 * produce a run that browsed a login screen for twenty minutes and reported the portal as empty.
 */
export function parseSession(secret: string | undefined): StorageState | undefined {
  if (!secret?.trim()) return undefined;
  try {
    const v = JSON.parse(secret) as StorageState;
    if (!v || typeof v !== "object") return undefined;
    const hasCookies = Array.isArray(v.cookies) && v.cookies.length > 0;
    const hasOrigins = Array.isArray(v.origins) && v.origins.length > 0;
    return hasCookies || hasOrigins ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The browser-use config that points at the session.
 *
 * Written in the `DBStyleConfigJSON` shape the loader expects — a keyed map with `default: true`,
 * not a bare object. `_get_default_profile()` walks `db_config.browser_profile.values()` looking for
 * the default one, so a flat `{"storage_state": …}` would parse, validate, and be ignored.
 */
export function browserUseConfig(sessionPath = SESSION_PATH_ABS): Record<string, unknown> {
  return {
    browser_profile: {
      mycel: { id: "mycel", default: true, storage_state: sessionPath },
    },
  };
}

/**
 * Does this session actually contain anything for this host?
 *
 * ═══ THE ERROR THIS CATCHES IS THE ONE PEOPLE ACTUALLY MAKE ═══
 *
 * A session is captured by hand, from a browser, with several tabs open. Pasting the wrong tab's
 * storage state produces a connection that stores fine, mounts fine, and yields a run that browses a
 * login page for twenty minutes and reports the portal as empty.
 *
 * That failure is expensive precisely because nothing about it looks like a failure until somebody
 * reads the transcript. Checked at the moment of pasting, it is one sentence to whoever is standing
 * there with the right tab still open.
 *
 * ═══ MATCHING, AND WHY IT IS DELIBERATELY GENEROUS IN ONE DIRECTION ═══
 *
 * A cookie set on `.example.com` is valid for `portal.example.com`, so a parent-domain cookie
 * COUNTS. A cookie on `other.example.com` does not, and neither does one on `notexample.com` — the
 * suffix check is on a dot boundary, because `evil-example.com` ends with `example.com` as a string
 * and shares nothing with it as a domain.
 *
 * The direction of the generosity matters: being too strict here rejects a valid session and blocks
 * real work, while being too loose accepts one that will not authenticate — and the second failure
 * is caught immediately afterwards by the portal itself, which is the safer place to be wrong.
 */
export function sessionCovers(state: StorageState, host: string): boolean {
  const h = host.toLowerCase();
  const forHost = (raw: unknown): boolean => {
    if (typeof raw !== "string" || !raw) return false;
    const d = raw.toLowerCase().replace(/^\./, "");
    return h === d || h.endsWith(`.${d}`);
  };

  for (const c of state.cookies ?? []) {
    if (forHost((c as { domain?: unknown })?.domain)) return true;
  }
  for (const o of state.origins ?? []) {
    const origin = (o as { origin?: unknown })?.origin;
    if (typeof origin !== "string") continue;
    try {
      if (forHost(new URL(origin).hostname)) return true;
    } catch {
      // A malformed origin in a pasted blob is not a match and not a crash.
    }
  }
  return false;
}

/** What to tell whoever just pasted the wrong tab. Names both hosts — that is the whole diagnosis. */
export function wrongSessionFor(state: StorageState, host: string): string {
  const seen = new Set<string>();
  for (const c of state.cookies ?? []) {
    const d = (c as { domain?: unknown })?.domain;
    if (typeof d === "string" && d) seen.add(d.replace(/^\./, ""));
  }
  for (const o of state.origins ?? []) {
    const origin = (o as { origin?: unknown })?.origin;
    if (typeof origin !== "string") continue;
    try {
      seen.add(new URL(origin).hostname);
    } catch {
      /* ignore */
    }
  }
  const list = [...seen].sort().slice(0, 5);
  return (
    `That session has nothing for ${host}` +
    (list.length ? ` — it is for ${list.join(", ")}.` : ".") +
    ` Capture it again from a tab that is signed in to ${host}.`
  );
}
