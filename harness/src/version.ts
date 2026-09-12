// The version the kernel says it is, read from the one place that already knows.
//
// FOUND IN A STRANGER-INSTALL WALKTHROUGH: the boot banner printed `mycel-harness v0.1` while
// `package.json` said `0.2.0`. A hardcoded literal in the banner drifts the moment anyone bumps the
// package, and the number in the banner is exactly the number someone pastes into a bug report — so
// the one string a stranger quotes back to us was the one string guaranteed to be wrong.
//
// `readFileSync` rather than `import … with { type: "json" }` so this stays a plain ESM module under
// tsx with no resolveJsonModule/import-attributes requirements.
import { readFileSync } from "node:fs";

function read(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    // A missing or unreadable package.json must not stop the kernel booting: the version is a label,
    // not a capability. Say "unknown" rather than lying with a stale literal.
    return "unknown";
  }
}

export const KERNEL_VERSION = read();
