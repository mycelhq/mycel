/**
 * Consent, and the anonymous id it gates.
 *
 * The discipline is copied deliberately from `landing/lib/consent.ts`, because this codebase
 * already decided what "consent" means and shipping a weaker version inside a founder's product
 * would be worse than not shipping analytics at all — it would be us handing every one of our
 * customers a compliance liability with our name on it.
 *
 * The rules that survive from that file, restated because they are easy to erode:
 *
 * - **Unanswered is a refusal.** `null` is not "not yet decided, so carry on". Nothing is written
 *   and nothing is sent until the answer is exactly `"granted"`.
 * - **No consent cookie.** Refusing must leave the browser as it was found; a cookie set by the act
 *   of refusing cookies is the classic own goal. First-party `localStorage`, nothing else.
 * - **Withdrawal is real.** `denied` after `granted` clears the anonymous id, the session id and
 *   the pending queue. The "Cookie settings" link has to be a control, not a decoration — and in
 *   the marketing site's case that meant discovering that the SDK's own `reset()` ROTATED the id
 *   rather than removing it. Here we own the storage, so there is no SDK to be surprised by; the
 *   prefix sweep is kept anyway so a key added later can't outlive a withdrawal.
 *
 * Everything is prefixed `mycel_insight_` so the sweep can be by prefix rather than by a hardcoded
 * list that goes stale the first time someone adds a key.
 */

export type Consent = "granted" | "denied";

const PREFIX = "mycel_insight_";
const CONSENT_KEY = `${PREFIX}consent`;
export const ANON_KEY = `${PREFIX}aid`;
export const SESSION_KEY = `${PREFIX}sid`;
export const SESSION_SEEN_KEY = `${PREFIX}seen`;

/** Dispatched on this window when the answer changes; `storage` covers the other tabs. */
const CHANGED = "mycel:insight-consent-changed";

const hasWindow = (): boolean => typeof window !== "undefined";

/** The stored answer, or `null` if it has never been asked — which is not consent. */
export function readConsent(): Consent | null {
  if (!hasWindow()) return null;
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    // Private mode, or storage blocked entirely. No record means no consent: the safe answer
    // rather than the convenient one.
    return null;
  }
}

export function setConsent(value: Consent): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // The answer still applies to this page view; it just won't survive a reload.
  }
  if (value === "denied") forgetEverything();
  window.dispatchEvent(new CustomEvent<Consent>(CHANGED, { detail: value }));
}

/** Subscribe to changes, in this tab and in others. Returns an unsubscribe. */
export function onConsentChange(fn: (value: Consent | null) => void): () => void {
  if (!hasWindow()) return () => {};
  const here = (e: Event) => fn((e as CustomEvent<Consent>).detail ?? readConsent());
  const elsewhere = (e: StorageEvent) => {
    if (e.key === CONSENT_KEY) fn(readConsent());
  };
  window.addEventListener(CHANGED, here);
  window.addEventListener("storage", elsewhere);
  return () => {
    window.removeEventListener(CHANGED, here);
    window.removeEventListener("storage", elsewhere);
  };
}

/**
 * Erase everything this package wrote.
 *
 * By prefix, not by name: the marketing site's version of this function exists because a
 * hardcoded key list left an id behind, and the fix that lasted was sweeping the namespace. There
 * are no cookies to expire here because this package never sets one — that is the whole reason the
 * id lives in `localStorage`.
 */
export function forgetEverything(): void {
  if (!hasWindow()) return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (const k of Object.keys(store)) {
        // The consent answer itself survives: forgetting that someone said no would mean asking
        // again on the next page, and re-asking a refusal is how a banner becomes nagware.
        if (k.startsWith(PREFIX) && k !== CONSENT_KEY) store.removeItem(k);
      }
    } catch {
      // Storage blocked; there was nothing to clear.
    }
  }
}

/** 128 bits of randomness, base36. Not derived from anything about the person — that is the point. */
function randomId(): string {
  const bytes = new Uint8Array(16);
  const c = hasWindow() ? window.crypto : undefined;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += (b as number).toString(16).padStart(2, "0");
  return out;
}

/**
 * The anonymous id, minted on first grant.
 *
 * Only ever called behind a granted consent check, so an unconsented visitor leaves no trace in
 * storage at all. Returns a throwaway id when storage is unavailable rather than throwing: a
 * private-mode visitor is counted as a fresh visitor, which is the honest answer anyway.
 */
export function anonymousId(): string {
  if (!hasWindow()) return "";
  try {
    const existing = window.localStorage.getItem(ANON_KEY);
    if (existing) return existing;
    const fresh = randomId();
    window.localStorage.setItem(ANON_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

/**
 * The session id, in `sessionStorage` so it dies with the tab.
 *
 * Rotated after `idleMs` of inactivity — the web-analytics convention, and the mechanism that makes
 * "how many sessions" answerable server-side WITHOUT the kernel keeping a set of ids per day. The
 * client emits one `$session` event per new id; the kernel just counts those.
 */
export function sessionId(idleMs: number, now: number = Date.now()): { id: string; fresh: boolean } {
  if (!hasWindow()) return { id: "", fresh: false };
  try {
    const last = Number(window.sessionStorage.getItem(SESSION_SEEN_KEY) ?? 0);
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    const expired = !existing || !last || now - last > idleMs;
    const id = expired ? randomId() : existing;
    window.sessionStorage.setItem(SESSION_KEY, id);
    window.sessionStorage.setItem(SESSION_SEEN_KEY, String(now));
    return { id, fresh: expired };
  } catch {
    return { id: randomId(), fresh: true };
  }
}
