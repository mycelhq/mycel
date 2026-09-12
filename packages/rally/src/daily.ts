// `rally daily install` — a launchd agent that tops the list up every morning until launch day.
//
// launchd rather than cron because this needs the founder's GUI session: the scrape drives a real
// visible Chrome, which is the whole reason it gets past Cloudflare. A LaunchAgent runs in that
// session; a root cron does not, and would be blocked every morning in a way nobody would notice.
//
// `RunAtLoad` is false on purpose. The point is a morning top-up, not a scrape every time the
// laptop wakes.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const LABEL = "ai.mycel.rally.daily";
const CRM_LABEL = "ai.mycel.rally.crm";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const crmPlistPath = join(homedir(), "Library", "LaunchAgents", `${CRM_LABEL}.plist`);

export function plist(repo: string, hour: number, launchAt: string | null): string {
  const script = join(repo, "packages", "rally", "scripts", "daily-scrape.sh");
  /**
   * AWS_PROFILE AND HOME ARE NOT OPTIONAL, AND THEIR ABSENCE IS SILENT.
   *
   * daily-scrape.sh resolves DATABASE_URL by calling `aws secretsmanager get-secret-value` with
   * `2>/dev/null`, so a credentials failure produces an empty string and the script prints
   * "no DATABASE_URL — skipping" and exits 0-ish. That is indistinguishable in the log from a
   * quiet morning.
   *
   * A LaunchAgent inherits almost nothing: not the shell profile that exports AWS_PROFILE, and not
   * HOME, which is where the AWS CLI looks for ~/.aws/config. The CRM agent sets both; this one did
   * not, so the morning top-up ran on 8 September for the first time and its entire output was one
   * line saying it had skipped. Every lead it was meant to add, on every day it was meant to run,
   * was never fetched.
   */
  const env = [
    `    <key>RALLY_REPO</key><string>${repo}</string>`,
    launchAt ? `    <key>RALLY_LAUNCH_AT</key><string>${launchAt}</string>` : "",
    `    <key>AWS_PROFILE</key><string>${process.env.AWS_PROFILE ?? "mycel"}</string>`,
    `    <key>HOME</key><string>${homedir()}</string>`,
    `    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`,
  ]
    .filter(Boolean)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${script}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>10</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${join(homedir(), ".mycel", "rally", "daily-launchd.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), ".mycel", "rally", "daily-launchd.log")}</string>
</dict>
</plist>
`;
}

export async function install(repo: string, hour: number, launchAt: string | null): Promise<string> {
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(homedir(), ".mycel", "rally"), { recursive: true });
  writeFileSync(plistPath, plist(repo, hour, launchAt));
  await run("launchctl", ["unload", plistPath]).catch(() => undefined);
  await run("launchctl", ["load", plistPath]);
  return plistPath;
}

export async function uninstall(): Promise<boolean> {
  if (!existsSync(plistPath)) return false;
  await run("launchctl", ["unload", plistPath]).catch(() => undefined);
  unlinkSync(plistPath);
  return true;
}

export const agentPath = plistPath;


// ── The CRM itself, kept up ─────────────────────────────────────────────────
//
// `KeepAlive` so a crash restarts it, `RunAtLoad` so it is there after a reboot. The founder asked
// for it always open, and "always" cannot mean "until something goes wrong at 3am on launch day".
//
// Nothing here needs the network to be up or a secret to be readable: the CRM serves from the
// local SQLite file, and only the Sync button touches Postgres.
export function crmPlist(repo: string, port: number, launchAt: string | null, launchUrl: string | null): string {
  const script = join(repo, "packages", "rally", "scripts", "serve.sh");
  const env = [
    `    <key>RALLY_REPO</key><string>${repo}</string>`,
    `    <key>RALLY_PORT</key><string>${port}</string>`,
    launchAt ? `    <key>RALLY_LAUNCH_AT</key><string>${launchAt}</string>` : "",
    launchUrl ? `    <key>RALLY_LAUNCH_URL</key><string>${launchUrl}</string>` : "",
    `    <key>AWS_PROFILE</key><string>${process.env.AWS_PROFILE ?? "mycel"}</string>`,
    `    <key>HOME</key><string>${homedir()}</string>`,
    `    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`,
  ]
    .filter(Boolean)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CRM_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${script}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(homedir(), ".mycel", "rally", "crm-launchd.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), ".mycel", "rally", "crm-launchd.log")}</string>
</dict>
</plist>
`;
}

export async function installCrm(
  repo: string,
  port: number,
  launchAt: string | null,
  launchUrl: string | null,
): Promise<string> {
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(homedir(), ".mycel", "rally"), { recursive: true });
  writeFileSync(crmPlistPath, crmPlist(repo, port, launchAt, launchUrl));
  await run("launchctl", ["unload", crmPlistPath]).catch(() => undefined);
  await run("launchctl", ["load", crmPlistPath]);
  return crmPlistPath;
}

export async function uninstallCrm(): Promise<boolean> {
  if (!existsSync(crmPlistPath)) return false;
  await run("launchctl", ["unload", crmPlistPath]).catch(() => undefined);
  unlinkSync(crmPlistPath);
  return true;
}

export const crmAgentPath = crmPlistPath;
