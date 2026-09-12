// The live view. Plain ANSI, redrawn on a timer — no TUI framework, because the whole screen is
// one table and a log, and a dependency that renders it is a dependency that breaks at 3am on
// launch day.
//
// It answers the three questions asked of it, in this order:
//   how many replied · how many read it and said nothing · how many are still waiting to be asked

import type { DatabaseSync } from "node:sqlite";
import { funnel, invitesThisWeek, seats, type Funnel } from "./store";

const ESC = "\x1b[";
const clear = () => `${ESC}2J${ESC}H`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const num = (n: number, w = 5) => String(n).padStart(w);

function totals(a: Funnel, b: Funnel): Funnel {
  return {
    queued: a.queued + b.queued,
    supported: a.supported + b.supported,
    invited: a.invited + b.invited,
    accepted: a.accepted + b.accepted,
    messaged: a.messaged + b.messaged,
    replied: a.replied + b.replied,
    seenNoReply: a.seenNoReply + b.seenNoReply,
    followedUp: a.followedUp + b.followedUp,
    declined: a.declined + b.declined,
    failed: a.failed + b.failed,
  };
}

export function render(db: DatabaseSync, log: readonly string[], launchAt: Date | null): string {
  const all = seats(db);
  let out = clear();
  const left = launchAt ? Math.round((launchAt.getTime() - Date.now()) / 3_600_000) : null;
  out += bold("  mycel rally") + dim(`   ${new Date().toLocaleTimeString()}`);
  if (left !== null) out += dim(`   ·  ${left > 0 ? `${left}h to launch` : `${-left}h since launch`}`);
  out += "\n\n";

  out += dim("  seat            status        week/cap  invited  accepted  messaged  REPLIED  quiet  queued\n");
  let sum: Funnel = { queued: 0, supported: 0, invited: 0, accepted: 0, messaged: 0, replied: 0, seenNoReply: 0, followedUp: 0, declined: 0, failed: 0 };
  for (const s of all) {
    const f = funnel(db, s.name);
    sum = totals(sum, f);
    const status =
      s.status === "connected" ? green("connected  ") : s.status === "challenged" ? red("CHALLENGED ") : s.status === "restricted" ? red("RESTRICTED ") : yellow("not linked ");
    // The ceiling is shown as measured-or-unknown, never as a number we made up: "?" means
    // LinkedIn has not yet told us this seat's allowance and the seat is still probing for it.
    const week = invitesThisWeek(db, s.name);
    const cap = s.observedWeeklyCap === null ? "?" : String(s.observedWeeklyCap);
    out += `  ${pad(s.name, 15)} ${status} ${pad(`${week}/${cap}`, 8)}  ${num(f.invited)}  ${num(f.accepted, 8)}  ${num(f.messaged, 8)}  ${bold(num(f.replied, 7))}  ${num(f.seenNoReply + f.followedUp, 5)}  ${num(f.queued, 6)}\n`;
  }
  out += dim("  " + "─".repeat(86) + "\n");
  out += `  ${pad("all seats", 15)} ${pad("", 11)} ${pad("", 8)}  ${num(sum.invited)}  ${num(sum.accepted, 8)}  ${num(sum.messaged, 8)}  ${bold(green(num(sum.replied, 7)))}  ${num(sum.seenNoReply + sum.followedUp, 5)}  ${num(sum.queued, 6)}\n\n`;

  const acceptRate = sum.invited > 0 ? Math.round((sum.accepted / sum.invited) * 100) : 0;
  const replyRate = sum.messaged > 0 ? Math.round((sum.replied / sum.messaged) * 100) : 0;
  out += dim(`  accepted ${acceptRate}% of invitations   ·   replied ${replyRate}% of messages`);
  if (sum.failed > 0) out += red(`   ·   ${sum.failed} failed`);
  out += "\n\n";

  out += dim("  recent\n");
  for (const line of log.slice(-12)) out += `  ${dim("·")} ${line}\n`;
  out += "\n" + dim("  ctrl-c to stop. sessions stay logged in.\n");
  return out;
}
