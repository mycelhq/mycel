/**
 * Cookie-jar helpers shared by Voyager and the redirect walker.
 *
 * Lives in its own file so `proxy.ts` can merge `Set-Cookie` onto the next hop without importing
 * `voyager.ts` (that cycle is how a 302's fresh `lidc` used to be discarded before the retry).
 */

/** Node's fetch folds repeated Set-Cookie into one header; `getSetCookie` splits them correctly. */
export function setCookiesFrom(headers: Headers | undefined): string[] {
  if (!headers) return [];
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

/**
 * Merge `Set-Cookie` into a Cookie request-header string. Deletions (`Max-Age=0`, past Expires)
 * are honoured — sending a cookie LinkedIn just cleared is the same class of mistake as sending a
 * stale `lidc`.
 */
export function mergeSetCookie(current: string, setCookie: readonly string[]): string {
  if (setCookie.length === 0) return current;
  const jar = new Map<string, string>();
  for (const part of current.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
  for (const raw of setCookie) {
    const [pair, ...attrs] = raw.split(/;\s*/);
    const eq = (pair ?? "").indexOf("=");
    if (eq <= 0) continue;
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1);
    const expired = attrs.some(
      (a) => /^max-age=0$/i.test(a.trim()) || (/^expires=/i.test(a) && new Date(a.slice(8)).getTime() < Date.now()),
    );
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function cookieFromInit(init: Record<string, unknown>): string {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers.cookie ?? headers.Cookie ?? "";
}

export function withCookie(init: Record<string, unknown>, cookie: string): Record<string, unknown> {
  const headers = { ...((init.headers as Record<string, string>) ?? {}), cookie };
  return { ...init, headers };
}
