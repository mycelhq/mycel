// Shared host checks for anything that fetches a founder-pasted URL (meeting join, Firecrawl hop).
//
// Allowlists live at the call site (Meet/Zoom/Teams; public company pages). This file is the
// shapes that are never a real destination: userinfo, odd ports, IP literals, decimal/hex IPs,
// trailing-dot hosts, localhost. DNS rebinding of an allowlisted name is the provider's problem;
// a suffix host (`meet.google.com.evil.com`) is the call site's exact-match job.

export function parsePublicHttps(raw: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  if (u.port && u.port !== "443") return undefined;
  if (unsafeHost(u.hostname)) return undefined;
  return u;
}

/** True when the hostname is an SSRF shape, not a public DNS name a founder would paste. */
export function unsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  const labels = host.split(".");
  if (labels.some((p) => /^0x[0-9a-f]+$/i.test(p) || /^0[0-7]+$/.test(p))) return true;
  return false;
}

export function normalisedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}
