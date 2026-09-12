#!/usr/bin/env node --experimental-sqlite
//
//   rally import              pull the LinkedIn-reachable list out of the product's Postgres, ranked
//   rally seats <name...>     register the accounts ('me!' = established, faster ramp)
//   rally browser <seat> <spec>  which browser/profile that account is signed into
//   rally up                  install the CRM as a login service — always open, restarts itself
//   rally crm                 run the board in the foreground instead
//   rally work <seat>         the same thing in the terminal, one at a time
//   rally accepted <seat> <name...>   mark people who accepted
//   rally status              the board: who replied, who went quiet, who is unasked
//   rally daily install       a launchd agent that tops the list up every morning until launch
//
// ═══ NOTHING HERE NEEDS A LINKEDIN PASSWORD ═══
//
// No command asks for a credential, stores one, or logs an account in. Each seat's account is
// signed in the way any person signs in: somebody types it into linkedin.com in a browser, once.
// `rally browser <seat> <spec>` records WHICH browser that was, and the CRM opens links there.
//
// The Playwright login, the Voyager actions and the automated send loop were all deleted on
// 8 September. They worked, and they were the wrong tool: every attempt spent account trust on
// accounts belonging to somebody's family, and the founder can click Connect faster than a
// selector can be kept working. What is left is the half worth having — the queue, the priority,
// the per-account budget and the record.
//
// Everything lives in ~/.mycel/rally: one SQLite file, and the per-seat state.

import { argv, exit, stdout } from "node:process";
import { prompter } from "./prompt";
import { render } from "./dashboard";
import { importFromPostgres } from "./import";
import { assignUnassigned, funnel, open, seats, setSeatBrowser, setSeatProfile, upNext } from "./store";
import { markAccepted, remainingToday, workSeat } from "./work";
import { serve } from "./serve";

const LAUNCH = process.env.RALLY_LAUNCH_AT ? new Date(process.env.RALLY_LAUNCH_AT) : null;

async function main(): Promise<void> {
  const [, , cmd = "status", ...rest] = argv;
  const db = open();

  if (cmd === "import") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("  DATABASE_URL is not set — that is the product's Postgres, read-only here.");
      exit(1);
    }
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const res = await importFromPostgres(db, client, {
      source: rest[0],
      limit: Number(process.env.RALLY_LIMIT ?? 5000),
    });
    await client.end();
    const names = seats(db).map((s) => s.name);
    const assigned = assignUnassigned(db, names);
    console.log(`  read ${res.seen}, imported ${res.imported}, skipped ${res.skipped} (no usable LinkedIn id, or duplicate)`);
    if (res.retired > 0) console.log(`  dropped ${res.retired} queued people no longer in the live list`);
    console.log(`  assigned ${assigned} across ${names.length || 0} seat(s)`);
    exit(0);
  }

  if (cmd === "seats") {
    if (rest.length === 0) {
      for (const s of seats(db)) console.log(`  ${s.name}  ${s.profile}  ${s.status}  ${remainingToday(db, s)} left today`);
      exit(0);
    }
    const { addSeat, setSeatStatus } = await import("./store");
    for (const raw of rest) {
      const established = raw.endsWith("!");
      const name = established ? raw.slice(0, -1) : raw;
      addSeat(db, name);
      // `work` needs no browser session of ours — the founder is signed in already, in their own
      // browser. Registering a seat is enough to give it a queue and a budget.
      setSeatStatus(db, name, "connected");
      if (established) setSeatProfile(db, name, "established");
      console.log(`  ${name}: registered${established ? " (established — faster ramp)" : ""}`);
    }
    console.log(`  assigned ${assignUnassigned(db, seats(db).map((s) => s.name))} people across ${seats(db).length} seats`);
    exit(0);
  }

  if (cmd === "pace") {
    const [name, profile] = rest;
    if (!name || !["new", "personal", "established"].includes(profile ?? "")) {
      console.log("  seat        pace          invites/day ramp");
      for (const s of seats(db)) {
        const r = (await import("./pace")).paceFor(s.profile).ramp.join(" → ");
        console.log(`  ${s.name.padEnd(11)} ${s.profile.padEnd(13)} ${r}`);
      }
      console.log("\n  rally pace <seat> new|personal|established");
      console.log("    new          a recently created account with little on it");
      console.log("    personal     a real account with history but no outreach habit  (default)");
      console.log("    established  an account that already does outreach");
      exit(0);
    }
    setSeatProfile(db, name, profile as "new" | "personal" | "established");
    console.log(`  ${name} → ${profile}`);
    exit(0);
  }

  if (cmd === "browser") {
    const [name, spec] = rest;
    if (!name) {
      console.log("  seat        browser");
      for (const s of seats(db)) console.log(`  ${s.name.padEnd(11)} ${s.browser ?? "(system default)"}`);
      console.log("\n  set with: rally browser <seat> 'chrome:Profile 1' | brave | safari");
      exit(0);
    }
    setSeatBrowser(db, name, spec ?? null);
    console.log(`  ${name} → ${spec ?? "(system default)"}`);
    exit(0);
  }

  if (cmd === "work") {
    const name = rest[0];
    const seat = seats(db).find((s) => s.name === name);
    if (!seat) {
      console.error(`  no such seat: ${name ?? "(none given)"}. Register one with \`rally seats ${name ?? "me"}\`.`);
      exit(1);
    }
    const p = prompter();
    try {
      await workSeat(db, seat, {
        ask: p.ask,
        launch: LAUNCH ? { at: LAUNCH, url: process.env.RALLY_LAUNCH_URL } : undefined,
      });
    } finally {
      p.close();
    }
    exit(0);
  }

  if (cmd === "accepted") {
    const [name, ...who] = rest;
    const seat = seats(db).find((s) => s.name === name);
    if (!seat) {
      console.error(`  no such seat: ${name ?? "(none given)"}`);
      exit(1);
    }
    console.log(`  marked ${await markAccepted(db, seat, who)} of ${who.length} as accepted`);
    exit(0);
  }

  if (cmd === "next") {
    const name = rest[0] ?? seats(db)[0]?.name;
    if (!name) {
      console.error("  no seats registered");
      exit(1);
    }
    for (const t of upNext(db, name, Number(rest[1] ?? 10))) {
      console.log(`  ${String(t.priority).padStart(3)}  ${t.name.padEnd(26)} ${t.linkedinUrl}`);
      if (t.why) console.log(`       ${t.why}`);
    }
    exit(0);
  }

  if (cmd === "up" || cmd === "install") {
    const { installCrm, crmAgentPath } = await import("./daily");
    const repo = process.env.RALLY_REPO ?? new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
    const port = Number(process.env.RALLY_PORT ?? 5174);
    await installCrm(repo, port, process.env.RALLY_LAUNCH_AT ?? null, process.env.RALLY_LAUNCH_URL ?? null);
    console.log(`  installed ${crmAgentPath}`);
    console.log(`  the CRM now starts at login and restarts if it dies — http://localhost:${port}`);
    console.log(`  log: ~/.mycel/rally/crm.log      stop with: rally down`);
    exit(0);
  }

  if (cmd === "down") {
    const { uninstallCrm, crmAgentPath } = await import("./daily");
    console.log((await uninstallCrm()) ? `  removed ${crmAgentPath} — the CRM will not restart` : "  nothing installed");
    exit(0);
  }

  if (cmd === "daily") {
    const { install, uninstall, agentPath } = await import("./daily");
    if (rest[0] === "uninstall") {
      console.log((await uninstall()) ? `  removed ${agentPath}` : "  nothing installed");
      exit(0);
    }
    const repo = process.env.RALLY_REPO ?? new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
    const hour = Number(process.env.RALLY_HOUR ?? 8);
    const p = await install(repo, hour, process.env.RALLY_LAUNCH_AT ?? null);
    console.log(`  installed ${p}`);
    console.log(`  runs every day at ${String(hour).padStart(2, "0")}:10, walking the last 2 days of Product Hunt`);
    console.log(`  it stops itself once RALLY_LAUNCH_AT has passed. Log: ~/.mycel/rally/daily-scrape.log`);
    exit(0);
  }

  if (cmd === "crm" || cmd === "serve") {
    serve(db, LAUNCH ? { at: LAUNCH, url: process.env.RALLY_LAUNCH_URL } : null, Number(process.env.RALLY_PORT ?? 5174));
    return; // the server owns the process from here
  }

  if (cmd === "status") {
    stdout.write(render(db, [], LAUNCH));
    const f = funnel(db);
    if (f.queued + f.invited === 0) console.log("  nothing queued yet — run `rally import`.\n");
    exit(0);
  }

  console.error(
    `  unknown command: ${cmd}\n\n` +
      `  seats <name...>          register accounts        ('me!' = established, faster ramp)\n` +
      `  browser <seat> <spec>    chrome | chrome:Profile 1 | brave | safari\n` +
      `  pace <seat> <profile>    new | personal | established — how fast it ramps\n` +
      `  import [source]          pull the ranked list from Postgres\n` +
      `  up / down                install (or remove) the always-on CRM at localhost:5174\n` +
      `  crm                      run the board in the foreground instead\n` +
      `  work <seat>              the same list in the terminal, one at a time\n` +
      `  accepted <seat> <name…>  mark people who accepted\n` +
      `  next [seat] [n]          peek at the queue without working it\n` +
      `  status                   the board\n` +
      `  daily install|uninstall  the 08:10 top-up scrape\n\n` +
      `  No command asks for a LinkedIn password. Accounts are signed in by a person, in a\n` +
      `  browser; \`browser\` just records which one.\n`,
  );
  exit(1);
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
