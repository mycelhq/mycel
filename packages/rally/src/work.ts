// `rally work <seat>` — the founder does the clicking, the machine does the deciding.
//
// ═══ WHY THIS REPLACED THE AUTOMATION ═══
//
// The first version drove the browser: find the Connect button, click it, handle the modal. That
// works until LinkedIn moves a selector, and it spends account trust on every attempt — on
// accounts belonging to the founder's siblings.
//
// It was also solving the wrong half. The hard part of a rally is not clicking Connect; a person
// can do that in two seconds. The hard part is knowing WHO to click, from WHICH of four accounts,
// in what order, and when to stop for the day. That is bookkeeping, it is genuinely difficult to
// hold in your head across four accounts and a thousand people, and it is exactly what a computer
// should be doing.
//
// So the split is: the machine owns the queue, the priority, the per-seat budget and the record.
// The human owns the click. Nothing here automates LinkedIn, which means there is no selector to
// break and no automated behaviour to detect — the traffic is a person, because it is one.

import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { phaseOf, stillWorth, type Launch } from "./copy";
import { budgetToday, paceFor, type PaceConfig } from "./pace";
import {
  historyFor,
  invitesThisWeek,
  markSupported,
  recordAction,
  setTargetState,
  upNext,
  type Seat,
  type Target,
} from "./store";

const ESC = "\x1b[";
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;

/**
 * Open a URL in THIS SEAT'S browser.
 *
 * ═══ WHY A SEAT NEEDS ITS OWN WINDOW ═══
 *
 * Four LinkedIn accounts cannot share one browser: cookies are per profile, so whichever account
 * is signed in there is the account that sends. `open <url>` goes to the system default, which
 * would have quietly sent all four seats' invitations from one account — and the first sign of it
 * would have been three seats with no acceptances and one with a restriction.
 *
 * So each seat names where its account lives. On macOS a Chrome profile is addressable directly:
 *
 *   chrome              Chrome, whichever profile it opens with
 *   chrome:Profile 1    Chrome, that specific profile directory
 *   brave               Brave
 *   safari              Safari
 *   (unset)             the system default browser
 *
 * `-n` forces a NEW instance so the profile flag is honoured rather than the URL being handed to
 * an already-running window belonging to a different account.
 */
export function openFor(url: string, browser: string | null | undefined): void {
  const spec = (browser ?? "").trim();
  if (!spec) {
    execFile("open", [url], () => {});
    return;
  }
  const [app = "", profile] = spec.split(":");
  const appName =
    { chrome: "Google Chrome", brave: "Brave Browser", safari: "Safari", edge: "Microsoft Edge", firefox: "Firefox" }[
      app.toLowerCase()
    ] ?? app;
  const args = profile
    ? ["-na", appName, "--args", `--profile-directory=${profile}`, url]
    : ["-a", appName, url];
  execFile("open", args, () => {});
}

/** Kept for callers that genuinely want the default browser. */
export function openInBrowser(url: string): void {
  execFile("open", [url], () => {});
}

export interface WorkDeps {
  ask: (q: string) => Promise<string>;
  open?: (url: string) => void;
}

/** How much this seat has left today, given what it has already done. */
export function remainingToday(db: DatabaseSync, seat: Seat, pace?: PaceConfig): number {
  const cfg = pace ?? paceFor(seat.profile);
  const hist = historyFor(db, seat.name);
  const budget = budgetToday(cfg, hist, Date.now());
  const sentToday = hist.invites.filter((t) => t >= Date.now() - 86_400_000).length;
  const weekLeft = (hist.observedWeeklyCap ?? cfg.weeklyProbeCeiling) - invitesThisWeek(db, seat.name);
  return Math.max(0, Math.min(budget - sentToday, weekLeft));
}

/**
 * Is their launch still live enough to be worth commenting on?
 *
 * The reciprocity only works while the launch is on the leaderboard: a comment on a six-week-old
 * page is seen by nobody and reads as research rather than support. `why` already carries the age
 * the ranking computed, so this asks the same question the CRM's "Live launches" tab asks.
 */
export function supportable(t: Target): boolean {
  return Boolean(t.productUrl) && /launched (today|[1-3]d ago)/.test(t.why ?? "");
}

function card(t: Target, n: number, total: number): string {
  const head = t.headline ? `\n     ${dim(t.headline.slice(0, 78))}` : "";
  const why = t.why ? `\n     ${dim(t.why)}` : "";
  const launch = supportable(t)
    ? `\n     ${green("their launch is live")} ${cyan(t.productUrl!)}`
    : "";
  return (
    `\n  ${dim(`[${n}/${total}]`)}  ${bold(t.name)}${head}${why}${launch}\n` +
    `     ${cyan(t.linkedinUrl)}\n`
  );
}

/**
 * Walk this seat's list until the day's budget is spent or the founder stops.
 *
 * Every answer is recorded, including "skip" — a person passed over on purpose must not come back
 * tomorrow at the top of the list, or the queue quietly stops being a queue.
 */
export async function workSeat(db: DatabaseSync, seat: Seat, deps: WorkDeps & { launch?: Launch }): Promise<void> {
  const openUrl = deps.open ?? ((u: string) => openFor(u, seat.browser));

  // A launch rally is finite by construction. Left running past the date it becomes ordinary cold
  // outreach with a stale reason attached, sent from four accounts borrowed for one week — and the
  // product's own Product Hunt campaign sat paused for seven days past its date precisely because
  // nothing checked. So the check lives here, where the sending happens.
  if (deps.launch) {
    const phase = phaseOf(deps.launch.at, new Date());
    if (!stillWorth(phase)) {
      console.log(`\n  The launch was on ${deps.launch.at.toISOString().slice(0, 10)}. There is nothing left to ask for.`);
      console.log(`  ${dim("Set a new RALLY_LAUNCH_AT, or `rally daily uninstall` to stop the morning scrape.")}\n`);
      return;
    }
    console.log(dim(`\n  ${phase === "launch" ? "LAUNCH DAY" : phase === "eve" ? "launch is tomorrow" : "pre-launch"} — messages will say so.`));
  }

  const left = remainingToday(db, seat);

  if (left === 0) {
    console.log(`\n  ${seat.name}: nothing left today — the ramp is spent. Come back tomorrow.\n`);
    return;
  }

  const queue = upNext(db, seat.name, left);
  if (queue.length === 0) {
    console.log(`\n  ${seat.name}: the queue is empty. Run \`rally import\`.\n`);
    return;
  }

  const live = queue.filter(supportable).length;
  console.log(
    `\n  ${bold(seat.name)} — ${left} invitation${left === 1 ? "" : "s"} to send today` +
      dim(`  (${seat.profile} pace)`) +
      (live > 0 ? `\n  ${green(`${live} of these launched in the last three days`)}` : "") +
      `\n  ${dim("enter = sent it   ·   s = skip   ·   q = stop for now")}\n`,
  );

  let sent = 0;
  let supported = 0;
  for (const [i, t] of queue.entries()) {
    console.log(card(t, i + 1, queue.length));

    /**
     * ═══ THEIR LAUNCH FIRST, THEN THE INVITE ═══
     *
     * `supported` sits before `invited` in the funnel because that is the order that works:
     * makers reciprocate, and "I left a note on your launch" is a reason to accept where a bare
     * request is not. It is also the only ask allowed — soliciting upvotes for your own launch
     * gets it delisted, supporting someone else's does not.
     *
     * The CRM has had this since the support track shipped; the terminal did not, so working from
     * here skipped the whole play and sent a cold invite instead. Only offered while the launch is
     * actually live, because a comment on a six-week-old page reads as research, not support.
     */
    if (supportable(t)) {
      openUrl(t.productUrl!);
      const s = (await deps.ask(`     ${dim("upvote + comment, then enter  ·  s = skip them  ·  n = invite without it  ")}`))
        .trim()
        .toLowerCase();
      if (s === "q") break;
      if (s === "s") {
        setTargetState(db, t.personKey, "declined", undefined, "skipped by hand");
        recordAction(db, seat.name, "skip", t.personKey, true, "skipped by hand");
        continue;
      }
      if (s !== "n") {
        markSupported(db, t.personKey);
        recordAction(db, seat.name, "support", t.personKey, true, "upvoted and commented by hand");
        supported++;
      }
    }

    openUrl(t.linkedinUrl);
    const a = (await deps.ask("     ")).trim().toLowerCase();

    if (a === "q") break;
    if (a === "s") {
      setTargetState(db, t.personKey, "declined", undefined, "skipped by hand");
      recordAction(db, seat.name, "skip", t.personKey, true, "skipped by hand");
      continue;
    }
    setTargetState(db, t.personKey, "invited", "invited_at");
    recordAction(db, seat.name, "invite", t.personKey, true, "sent by hand");
    sent++;
  }

  console.log(
    `\n  ${green(`${sent} sent`)}${supported > 0 ? green(`, ${supported} launch${supported === 1 ? "" : "es"} supported`) : ""} from ${seat.name}. ` +
      dim(`${remainingToday(db, seat)} left in today's budget.`) +
      `\n  ${dim("Check back with `rally accepted " + seat.name + "` once people start accepting.")}\n`,
  );
}

/**
 * Mark people who accepted. Also by hand: LinkedIn shows this on the founder's own screen and
 * reading it out is faster than any automation we could keep working.
 */
export async function markAccepted(db: DatabaseSync, seat: Seat, names: readonly string[]): Promise<number> {
  let n = 0;
  for (const raw of names) {
    const row = db
      .prepare(`SELECT person_key FROM targets WHERE seat = ? AND state = 'invited' AND lower(name) LIKE lower(?) LIMIT 1`)
      .get(seat.name, `%${raw}%`);
    if (!row) continue;
    setTargetState(db, String(row.person_key), "accepted", "accepted_at");
    recordAction(db, seat.name, "accepted", String(row.person_key), true, "confirmed by hand");
    n++;
  }
  return n;
}
