// The CRM. A local HTTP server and one HTML page, and deliberately no framework.
//
// This is a tool one person uses for one week on one laptop. A build step, a node_modules tree and
// a bundler would all have to keep working at 3am on launch day to show a table of six hundred
// people. So: node:http, one page, no dependencies. It starts instantly and cannot break in a way
// that needs a rebuild.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { phaseOf, voiceFor, type Launch } from "./copy";
import { plan } from "./plan";
import { funnel, historyFor, invitesThisWeek, recordAction, seats, setTargetState, type TargetState } from "./store";
import { remainingToday } from "./work";
import { BOOKMARKLET } from "./bookmarklet";
import { PAGE } from "./page";

const STATES: TargetState[] = ["queued", "supported", "invited", "accepted", "messaged", "replied", "seen_no_reply", "declined"];

const STAMP: Partial<Record<TargetState, "invited_at" | "accepted_at" | "messaged_at" | "replied_at" | "supported_at">> = {
  supported: "supported_at",
  invited: "invited_at",
  accepted: "accepted_at",
  messaged: "messaged_at",
  replied: "replied_at",
};

function state(db: DatabaseSync, launch: Launch | null) {
  const all = seats(db);
  const phase = launch ? phaseOf(launch.at, new Date()) : "early";
  const days = launch ? Math.max(0, Math.ceil((launch.at.getTime() - Date.now()) / 86_400_000)) : 7;

  const seatRows = all.map((s) => {
    const f = funnel(db, s.name);
    const h_ = historyFor(db, s.name);
    const h = h_;
    return {
      name: s.name,
      profile: s.profile,
      browser: s.browser,
      remainingToday: remainingToday(db, s),
      // Where today's ramp runs out, as a marker on a list that keeps going. See store.upNext.
      rampEndsAt: h_.invites.filter((t) => t >= Date.now() - 86_400_000).length + remainingToday(db, s),
      sentToday: h.invites.filter((t) => t >= Date.now() - 86_400_000).length,
      sentThisWeek: invitesThisWeek(db, s.name),
      weekCap: h.observedWeeklyCap,
      funnel: f,
    };
  });

  const total = funnel(db);
  const p = plan({
    queued: total.queued,
    invited: total.invited,
    accepted: total.accepted,
    messaged: total.messaged,
    replied: total.replied,
    seats: seatRows,
    daysToLaunch: days,
  });

  const people = db
    .prepare(
      `SELECT person_key, name, headline, product, product_url, linkedin_url, ph_url, x_handle, avatar_url,
              seat, state, priority, why, invited_at, accepted_at, messaged_at, replied_at, supported_at
         FROM targets ORDER BY priority DESC, name`,
    )
    .all();

  const voice = launch ? voiceFor(phase, launch) : null;
  return {
    launch: launch ? { at: launch.at.toISOString().slice(0, 10), url: launch.url ?? null, phase, days } : null,
    seats: seatRows,
    total,
    plan: p,
    people,
    sample: voice ? { first: voice.firstMessage("Firstname"), follow: voice.followUp("Firstname") } : null,
  };
}

export function serve(db: DatabaseSync, launch: Launch | null, port = 5174): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (v: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };

    if (url.pathname === "/api/state") return json({ ...state(db, launch), bookmarklet: BOOKMARKLET });

    /**
     * Mark several at once.
     *
     * The natural rhythm is "open ten, connect in the tabs, come back and say ten went out" —
     * marking them one at a time afterwards is the same work done twice, and it is where a count
     * drifts from the truth. `openNext` pre-selects what it opened, so the second half is one click.
     */
    if (url.pathname === "/api/mark-batch" && req.method === "POST") {
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      });
      const { keys, to } = JSON.parse(body || "{}") as { keys: string[]; to: TargetState };
      if (!STATES.includes(to)) return json({ error: `unknown state ${to}` }, 400);
      const seatOf = new Map(
        db.prepare(`SELECT person_key, seat FROM targets`).all().map((r) => [String(r.person_key), String(r.seat ?? "?")]),
      );
      for (const k of (keys ?? []).slice(0, 500)) {
        setTargetState(db, k, to, STAMP[to]);
        recordAction(db, seatOf.get(k) ?? "?", to === "invited" ? "invite" : to, k, true, "marked in bulk");
      }
      return json({ marked: (keys ?? []).length, state: state(db, launch) });
    }

    if (url.pathname === "/api/mark" && req.method === "POST") {
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      });
      const { personKey, to, seat } = JSON.parse(body || "{}") as { personKey: string; to: TargetState; seat: string };
      if (!STATES.includes(to)) return json({ error: `unknown state ${to}` }, 400);
      setTargetState(db, personKey, to, STAMP[to]);
      // Only an invitation spends the daily budget; the rest are bookkeeping about their reply.
      recordAction(db, seat ?? "?", to === "invited" ? "invite" : to, personKey, true, "marked in the CRM");
      return json(state(db, launch));
    }

    /**
     * Re-read the list from Postgres without leaving the page.
     *
     * The queue only changes when somebody imports: the morning scrape adds makers, and the avatar
     * backfill fills faces in behind it. Without this the founder's answer to "where are the new
     * people" is to quit the CRM and run a command, which is the kind of small friction that ends
     * with the tool not being used on the day it matters.
     */
    if (url.pathname === "/api/sync" && req.method === "POST") {
      const dsn = process.env.DATABASE_URL;
      if (!dsn) return json({ error: "DATABASE_URL is not set for this process" }, 400);
      try {
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: dsn });
        await client.connect();
        const { importFromPostgres } = await import("./import");
        const r = await importFromPostgres(db, client, { source: process.env.RALLY_SOURCE ?? "producthunt", limit: 5000 });
        await client.end();
        return json({ ...r, state: state(db, launch) });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    /**
     * Open several at once, in the background, each in its own seat's browser.
     *
     * The unit of work is not one profile: it is "queue up the next ten, go through the tabs,
     * come back and mark them". One at a time makes the founder alternate between two windows
     * six hundred times.
     *
     * Staggered by 250ms because macOS drops URLs handed to a cold browser too quickly.
     */
    if (url.pathname === "/api/open-batch" && req.method === "POST") {
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      });
      const { items } = JSON.parse(body || "{}") as { items: { link: string; browser?: string | null }[] };
      const list = items ?? [];

      /**
       * A CEILING THAT SAYS NO, RATHER THAN ONE THAT QUIETLY OPENS A QUARTER.
       *
       * The first version sliced at 25 and reported success, so asking for a hundred opened
       * twenty-five and said nothing. Removing the slice replaced that with a worse failure: a
       * single request opened two hundred tabs across three browsers, which is both unusable and
       * — two hundred profile views in fifty seconds from one account — exactly the velocity
       * signature this whole package exists to avoid.
       *
       * So there is a limit, it is generous, and exceeding it is an error the caller can read.
       */
      const MAX = Number(process.env.RALLY_MAX_TABS ?? 60);
      if (list.length > MAX) {
        return json({ error: `refusing to open ${list.length} tabs at once (limit ${MAX}). Select fewer, or raise RALLY_MAX_TABS.` }, 400);
      }

      /**
       * ANSWER FIRST, OPEN AFTER.
       *
       * The stagger is 250ms so macOS does not drop URLs handed to a cold browser, which is fine
       * for ten and twenty-five seconds for a hundred. Holding the response open for that long
       * meant the page sat there looking dead, and the old fix for that was a hard slice at 25 —
       * which silently opened a quarter of what was asked for.
       *
       * So the count goes back immediately and the opening continues behind it. There is nothing
       * to report afterwards: `open` either hands the URL to the browser or it does not, and a
       * failure shows up as a missing tab in front of the founder either way.
       */
      json({ opened: list.length, queued: true });
      void (async () => {
        for (const it of list) {
          const spec = (it.browser ?? "").trim();
          const [app = "", profile] = spec.split(":");
          const named =
            { chrome: "Google Chrome", brave: "Brave Browser", safari: "Safari", edge: "Microsoft Edge", firefox: "Firefox" }[
              app.toLowerCase()
            ] ?? app;
          const args = !spec
            ? ["-g", it.link]
            : profile
              ? ["-na", named, "--args", `--profile-directory=${profile}`, it.link]
              : ["-g", "-a", named, it.link];
          execFile("open", args, () => {});
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      return;
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      });
      const { link, browser } = JSON.parse(body || "{}") as { link: string; browser?: string | null };
      // Opening happens server-side because only the server knows which browser this seat uses —
      // and a target=_blank from the page would always land in whichever browser is showing it.
      const spec = (browser ?? "").trim();
      const [app = "", profile] = spec.split(":");
      const named =
        { chrome: "Google Chrome", brave: "Brave Browser", safari: "Safari", edge: "Microsoft Edge", firefox: "Firefox" }[
          app.toLowerCase()
        ] ?? app;
      // `-g` opens the tab WITHOUT raising the browser, which is the whole ask: queue up ten
      // profiles and stay on the CRM. Without it every click yanks the founder out of the list
      // they are working, and the list is the thing that knows what comes next.
      //
      // Not with `-n`: a new instance has to come to the front to exist, so a seat pinned to a
      // Chrome PROFILE is raised and the others are not. That is a real limitation and it is the
      // price of profiles; the common case (one browser per seat) stays in the background.
      const args = !spec
        ? ["-g", link]
        : profile
          ? ["-na", named, "--args", `--profile-directory=${profile}`, link]
          : ["-g", "-a", named, link];
      // Errors were swallowed here, so "the link does nothing" and "the browser is not installed"
      // looked identical from the page. Report it instead.
      return await new Promise((resolve) => {
        execFile("open", args, (err) => {
          if (err) console.error(`[open] ${named || "default browser"}: ${err.message}`);
          resolve(json(err ? { ok: false, error: `could not open ${named || "the default browser"}` } : { ok: true }));
        });
      });
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  server.listen(port, () => {
    const at = `http://localhost:${port}`;
    console.log(`\n  rally CRM  →  ${at}\n`);
    execFile("open", [at], () => {});
  });
}
