// Local state. SQLite in the founder's home directory, and it never leaves the laptop.
//
// ═══ WHY NOT THE PRODUCT'S DATABASE ═══
//
// Three of these four LinkedIn accounts belong to the founder's siblings and friends. Their
// sessions are not company data and must not sit in the same Postgres as the client pipeline,
// where a support query or a future migration would sweep them up. The people we are contacting
// come FROM Postgres — read once, cached here — but everything about the accounts stays local.
//
// ═══ WHY THERE IS NO PASSWORD COLUMN ═══
//
// There is nothing to steal because we never keep one. `rally connect` asks for the password,
// hands it straight to the login flow, and drops it; from then on the SESSION lives in that
// seat's Chrome profile directory, exactly as it would if a person had typed it. That is also
// why the verification code is needed once per account and not once per run.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RALLY_HOME = process.env.RALLY_HOME ?? join(homedir(), ".mycel", "rally");
export const seatProfileDir = (seat: string): string => join(RALLY_HOME, "seats", seat);

/** Where a target is in the conversation. The order here IS the funnel. */
export type TargetState =
  | "queued" // never touched
  /**
   * You upvoted and commented on THEIR launch.
   *
   * Deliberately before `invited` in the funnel, because that is the order that works: Product Hunt
   * makers reciprocate, and arriving with "I left a note on your launch" converts far better than
   * a cold request. It is also the only ask that is allowed — soliciting upvotes gets a launch
   * delisted, supporting someone else's does not.
   */
  | "supported"
  | "invited" // connection request sent, no answer yet
  | "accepted" // they accepted; we may now message them
  | "messaged" // we sent the first message
  | "replied" // they answered — a human should look
  | "seen_no_reply" // messaged, they read it, nothing came back → worth one more touch
  | "followed_up" // the one more touch has been sent
  | "declined" // withdrawn, ignored past the horizon, or refused
  | "failed"; // something broke on our side; detail says what

export interface Seat {
  name: string;
  /** Vestigial: it tracked the deleted Playwright session. "connected" now just means "in use". */
  status: "new" | "connected" | "challenged" | "restricted";
  firstRunAt: number | null;
  memberName: string | null;
  timezone: string;
  observedWeeklyCap: number | null;
  capObservedAt: number | null;
  profile: "new" | "personal" | "established";
  /** e.g. `chrome`, `chrome:Profile 1`, `brave`, `safari`. Null = the system default browser. */
  browser: string | null;
}

export interface Target {
  personKey: string;
  name: string;
  headline: string | null;
  linkedinUrl: string;
  seat: string | null;
  state: TargetState;
  priority: number;
  /** One line a human can read: why this person is near the top of the list. */
  why: string | null;
  avatarUrl: string | null;
  phUrl: string | null;
  xHandle: string | null;
  product: string | null;
  /** Their launch page — where you upvote and comment. */
  productUrl: string | null;
  supportedAt: number | null;
  invitedAt: number | null;
  acceptedAt: number | null;
  messagedAt: number | null;
  repliedAt: number | null;
  detail: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seats (
  name        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'new',
  first_run_at INTEGER,
  member_name TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Europe/Paris',
  created_at  INTEGER NOT NULL,
  -- LinkedIn's real weekly allowance for this seat, learned from its own refusal. See pace.ts.
  observed_weekly_cap INTEGER,
  cap_observed_at     INTEGER,
  -- 'default' for a dormant family account, 'established' for one with outreach history.
  profile     TEXT NOT NULL DEFAULT 'personal',
  -- WHICH BROWSER WINDOW THIS SEAT'S LINKS OPEN IN. See work.ts#openFor.
  browser     TEXT
);
CREATE TABLE IF NOT EXISTS targets (
  person_key   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  headline     TEXT,
  linkedin_url TEXT NOT NULL,
  seat         TEXT,
  state        TEXT NOT NULL DEFAULT 'queued',
  priority     INTEGER NOT NULL DEFAULT 0,
  why          TEXT,
  avatar_url   TEXT,
  ph_url       TEXT,
  product_url  TEXT,
  supported_at INTEGER,
  x_handle     TEXT,
  product      TEXT,
  invited_at   INTEGER,
  accepted_at  INTEGER,
  messaged_at  INTEGER,
  replied_at   INTEGER,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS targets_state ON targets(state, seat, priority DESC);
CREATE TABLE IF NOT EXISTS actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seat       TEXT NOT NULL,
  person_key TEXT,
  action     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS actions_seat_at ON actions(seat, at);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seat       TEXT NOT NULL,
  person_key TEXT NOT NULL,
  direction  TEXT NOT NULL,
  body       TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_person ON messages(person_key, at);
`;

/**
 * Columns added after a database already existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so every column
 * added later has to be applied separately or the schema silently lags the code — which is exactly
 * what happened the first time the CRM was run against a database made an hour earlier:
 * "table targets has no column named avatar_url".
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each is attempted and a duplicate is ignored. That
 * is safe because the statements are additive and idempotent by construction.
 */
const MIGRATIONS = [
  "ALTER TABLE targets ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE targets ADD COLUMN why TEXT",
  "ALTER TABLE targets ADD COLUMN avatar_url TEXT",
  "ALTER TABLE targets ADD COLUMN ph_url TEXT",
  "ALTER TABLE targets ADD COLUMN x_handle TEXT",
  "ALTER TABLE targets ADD COLUMN product TEXT",
  "ALTER TABLE targets ADD COLUMN product_url TEXT",
  "ALTER TABLE targets ADD COLUMN supported_at INTEGER",
  "ALTER TABLE seats ADD COLUMN observed_weekly_cap INTEGER",
  "ALTER TABLE seats ADD COLUMN cap_observed_at INTEGER",
  "ALTER TABLE seats ADD COLUMN profile TEXT NOT NULL DEFAULT 'personal'",
  "ALTER TABLE seats ADD COLUMN browser TEXT",
];

export function open(path = join(RALLY_HOME, "rally.db")): DatabaseSync {
  mkdirSync(RALLY_HOME, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) {
    try {
      db.exec(m);
    } catch (e) {
      // "duplicate column name" is the expected outcome on every run after the first.
      if (!/duplicate column/i.test(String(e))) throw e;
    }
  }
  return db;
}

// ── Seats ───────────────────────────────────────────────────────────────────

export function addSeat(db: DatabaseSync, name: string, timezone = "Europe/Paris"): void {
  db.prepare(`INSERT OR IGNORE INTO seats (name, timezone, created_at) VALUES (?, ?, ?)`).run(
    name,
    timezone,
    Date.now(),
  );
}

/** Mark a seat as an account with outreach history, so it gets the faster ramp. */
export function setSeatProfile(db: DatabaseSync, name: string, profile: "new" | "personal" | "established"): void {
  db.prepare(`UPDATE seats SET profile = ? WHERE name = ?`).run(profile, name);
}

/** Point a seat at the browser (and profile) its LinkedIn account is signed into. */
export function setSeatBrowser(db: DatabaseSync, name: string, browser: string | null): void {
  db.prepare(`UPDATE seats SET browser = ? WHERE name = ?`).run(browser, name);
}

export function setSeatStatus(db: DatabaseSync, name: string, status: Seat["status"], memberName?: string | null): void {
  db.prepare(`UPDATE seats SET status = ?, member_name = COALESCE(?, member_name) WHERE name = ?`).run(
    status,
    memberName ?? null,
    name,
  );
}

export function seats(db: DatabaseSync): Seat[] {
  return db.prepare(`SELECT * FROM seats ORDER BY created_at`).all().map((r) => ({
    name: String(r.name),
    status: String(r.status) as Seat["status"],
    firstRunAt: r.first_run_at === null ? null : Number(r.first_run_at),
    memberName: r.member_name === null ? null : String(r.member_name),
    timezone: String(r.timezone),
    observedWeeklyCap: r.observed_weekly_cap == null ? null : Number(r.observed_weekly_cap),
    capObservedAt: r.cap_observed_at == null ? null : Number(r.cap_observed_at),
    profile: ((): "new" | "personal" | "established" => {
      const v = String(r.profile ?? "personal");
      // "default" is the old name for the cautious ramp; it now means what it always described.
      if (v === "established") return "established";
      if (v === "new" || v === "default") return "new";
      return "personal";
    })(),
    browser: r.browser == null ? null : String(r.browser),
  }));
}

// ── History, in the shape pace.ts wants ─────────────────────────────────────

export interface SeatHistoryRow {
  actions: number[];
  invites: number[];
  firstRunAt: number | null;
  observedWeeklyCap: number | null;
}

export function historyFor(db: DatabaseSync, seat: string): SeatHistoryRow {
  const week = Date.now() - 8 * 86_400_000;
  const actions = db
    .prepare(`SELECT at FROM actions WHERE seat = ? AND at >= ? AND ok = 1 AND action <> 'check' ORDER BY at`)
    .all(seat, week)
    .map((r) => Number(r.at));
  const invites = db
    .prepare(`SELECT at FROM actions WHERE seat = ? AND at >= ? AND ok = 1 AND action = 'invite' ORDER BY at`)
    .all(seat, week)
    .map((r) => Number(r.at));
  const row = db.prepare(`SELECT first_run_at, observed_weekly_cap, cap_observed_at FROM seats WHERE name = ?`).get(seat);
  // A measured ceiling goes stale: LinkedIn raises an account's allowance as it earns trust, so a
  // reading older than four weeks is discarded and the seat probes again rather than being held
  // down forever by one bad week.
  const observedAt = row?.cap_observed_at == null ? null : Number(row.cap_observed_at);
  const fresh = observedAt !== null && Date.now() - observedAt < 28 * 86_400_000;
  return {
    actions,
    invites,
    firstRunAt: row?.first_run_at == null ? null : Number(row.first_run_at),
    observedWeeklyCap: fresh && row?.observed_weekly_cap != null ? Number(row.observed_weekly_cap) : null,
  };
}

/** Record what LinkedIn actually allowed this seat, at the moment it refused. */
export function recordWeeklyCeiling(db: DatabaseSync, seat: string, sentThisWeek: number): void {
  db.prepare(`UPDATE seats SET observed_weekly_cap = ?, cap_observed_at = ? WHERE name = ?`).run(
    Math.max(1, sentThisWeek),
    Date.now(),
    seat,
  );
}

/** How many invites this seat has sent in the rolling seven days. */
export function invitesThisWeek(db: DatabaseSync, seat: string): number {
  const r = db
    .prepare(`SELECT count(*) n FROM actions WHERE seat = ? AND action = 'invite' AND ok = 1 AND at >= ?`)
    .get(seat, Date.now() - 7 * 86_400_000);
  return Number(r?.n ?? 0);
}

export function recordAction(
  db: DatabaseSync,
  seat: string,
  action: string,
  personKey: string | null,
  ok: boolean,
  detail?: string,
): void {
  const at = Date.now();
  db.prepare(`INSERT INTO actions (seat, person_key, action, at, ok, detail) VALUES (?,?,?,?,?,?)`).run(
    seat,
    personKey,
    action,
    at,
    ok ? 1 : 0,
    detail ?? null,
  );
  // The ramp starts at a seat's FIRST successful outbound action, not at the moment it was added,
  // so a seat connected on Monday and first used on Thursday still gets day one's small budget.
  if (ok && action !== "check") {
    db.prepare(`UPDATE seats SET first_run_at = COALESCE(first_run_at, ?) WHERE name = ?`).run(at, seat);
  }
}

// ── Targets ─────────────────────────────────────────────────────────────────

export function upsertTarget(
  db: DatabaseSync,
  t: Pick<Target, "personKey" | "name" | "headline" | "linkedinUrl"> & {
    priority?: number;
    why?: string | null;
    avatarUrl?: string | null;
    phUrl?: string | null;
    xHandle?: string | null;
    product?: string | null;
    productUrl?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO targets (person_key, name, headline, linkedin_url, priority, why, avatar_url, ph_url, x_handle, product, product_url)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(person_key) DO UPDATE SET
       name = excluded.name, headline = excluded.headline,
       priority = excluded.priority, why = excluded.why,
       -- COALESCE: a re-import that could not read a photo must never erase one we have.
       avatar_url = COALESCE(excluded.avatar_url, targets.avatar_url),
       ph_url = COALESCE(excluded.ph_url, targets.ph_url),
       x_handle = COALESCE(excluded.x_handle, targets.x_handle),
       product = COALESCE(excluded.product, targets.product),
       product_url = COALESCE(excluded.product_url, targets.product_url)`,
  ).run(
    t.personKey, t.name, t.headline, t.linkedinUrl, t.priority ?? 0, t.why ?? null,
    t.avatarUrl ?? null, t.phUrl ?? null, t.xHandle ?? null, t.product ?? null, t.productUrl ?? null,
  );
}

/**
 * The next people this seat should contact, best first.
 *
 * Highest priority first, and `queued` only — the whole point of the list is that the founder
 * never has to decide who is next, and never sees the same person twice.
 *
 * ═══ THE RAMP ADVISES, IT DOES NOT BLOCK ═══
 *
 * This used to be called with the day's remaining budget and truncated there, so the list simply
 * ended at the ramp. That is the wrong shape for a tool where a person does the clicking: it hides
 * work rather than describing a limit, and the founder cannot see what they would be choosing.
 *
 * The arithmetic says the ramp is nearly free anyway — LinkedIn's ~100/week is the binding
 * constraint, so 12/day and 98-on-day-one both land at 100 for the week. The ramp spends it in a
 * shape that looks like a person instead of one anomalous burst. That is worth defaulting to and
 * not worth enforcing against the account's owner.
 */
export function upNext(db: DatabaseSync, seat: string, limit: number): Target[] {
  return db
    .prepare(
      `SELECT * FROM targets WHERE state = 'queued' AND seat = ?
        ORDER BY priority DESC, person_key LIMIT ?`,
    )
    .all(seat, limit)
    .map(rowToTarget);
}

export function setTargetState(
  db: DatabaseSync,
  personKey: string,
  state: TargetState,
  stampColumn?: "invited_at" | "accepted_at" | "messaged_at" | "replied_at" | "supported_at",
  detail?: string,
): void {
  const sql = stampColumn
    ? `UPDATE targets SET state = ?, ${stampColumn} = ?, detail = ? WHERE person_key = ?`
    : `UPDATE targets SET state = ?, detail = ? WHERE person_key = ?`;
  if (stampColumn) db.prepare(sql).run(state, Date.now(), detail ?? null, personKey);
  else db.prepare(sql).run(state, detail ?? null, personKey);
}

/**
 * Stamp that we upvoted and commented on THEIR launch, without moving them along the funnel.
 *
 * Support is not a funnel position, it is a thing that happened. Somebody supported and then
 * invited in the same sitting is `invited` with both stamps set — and `funnel()` counts
 * `supported_at IS NOT NULL` rather than the state, so they show up in both places correctly.
 * Writing it as a state transition instead would mean an invite immediately overwrote the record
 * of the support, which is the one fact the first message depends on.
 */
export function markSupported(db: DatabaseSync, personKey: string): void {
  db.prepare(`UPDATE targets SET supported_at = COALESCE(supported_at, ?) WHERE person_key = ?`).run(
    Date.now(),
    personKey,
  );
}

/** The next person this seat should invite. Round-robin by assignment, oldest queued first. */
export function nextToInvite(db: DatabaseSync, seat: string): Target | null {
  const r =
    db.prepare(`SELECT * FROM targets WHERE state = 'queued' AND seat = ? LIMIT 1`).get(seat) ??
    db.prepare(`SELECT * FROM targets WHERE state = 'queued' AND seat IS NULL LIMIT 1`).get(seat);
  return r ? rowToTarget(r) : null;
}

/** People who accepted and have not been messaged yet. */
export function nextToMessage(db: DatabaseSync, seat: string): Target | null {
  const r = db
    .prepare(`SELECT * FROM targets WHERE state = 'accepted' AND seat = ? ORDER BY accepted_at LIMIT 1`)
    .get(seat);
  return r ? rowToTarget(r) : null;
}

/**
 * People who were messaged, read it, and said nothing — the cohort worth one more touch.
 *
 * `afterMs` is deliberately a parameter and not a constant: a rally the day before a launch wants
 * a much shorter horizon than ordinary outreach, and that is a decision for the caller.
 */
export function nextToFollowUp(db: DatabaseSync, seat: string, afterMs: number): Target | null {
  const r = db
    .prepare(
      `SELECT * FROM targets WHERE state IN ('messaged','seen_no_reply') AND seat = ?
         AND messaged_at IS NOT NULL AND messaged_at <= ? ORDER BY messaged_at LIMIT 1`,
    )
    .get(seat, Date.now() - afterMs);
  return r ? rowToTarget(r) : null;
}

export function assignUnassigned(db: DatabaseSync, seatNames: readonly string[]): number {
  if (seatNames.length === 0) return 0;
  const rows = db.prepare(`SELECT person_key FROM targets WHERE seat IS NULL AND state = 'queued'`).all();
  const upd = db.prepare(`UPDATE targets SET seat = ? WHERE person_key = ?`);
  rows.forEach((r, i) => upd.run(seatNames[i % seatNames.length]!, String(r.person_key)));
  return rows.length;
}

export interface Funnel {
  queued: number;
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
  supported: number;
  seenNoReply: number;
  followedUp: number;
  declined: number;
  failed: number;
}

/**
 * The funnel, counted CUMULATIVELY.
 *
 * The first version grouped by current state, so a person who accepted stopped counting as
 * invited. Two acceptances off two invitations rendered as `invited 0 · accepted 2` and
 * "accepted 0% of invitations" — a board that reports a division by zero as zero, on the one
 * screen that is read every morning to decide whether any of this is working.
 *
 * So the four progress columns count the STAMP, not the state: anybody with `invited_at` was
 * invited, whatever happened next. `queued` and the two terminal buckets are genuine states and
 * stay as they are.
 */
export function funnel(db: DatabaseSync, seat?: string): Funnel {
  const where = seat ? `WHERE seat = ?` : "";
  const args = seat ? [seat] : [];
  const r =
    db
      .prepare(
        `SELECT
           count(*) FILTER (WHERE state = 'queued')            AS queued,
           count(*) FILTER (WHERE supported_at IS NOT NULL)    AS supported,
           count(*) FILTER (WHERE invited_at  IS NOT NULL)     AS invited,
           count(*) FILTER (WHERE accepted_at IS NOT NULL)     AS accepted,
           count(*) FILTER (WHERE messaged_at IS NOT NULL)     AS messaged,
           count(*) FILTER (WHERE replied_at  IS NOT NULL)     AS replied,
           count(*) FILTER (WHERE state = 'seen_no_reply')     AS seen_no_reply,
           count(*) FILTER (WHERE state = 'followed_up')       AS followed_up,
           count(*) FILTER (WHERE state = 'declined')          AS declined,
           count(*) FILTER (WHERE state = 'failed')            AS failed
         FROM targets ${where}`,
      )
      .get(...args) ?? {};
  const g = (k: string) => Number((r as Record<string, unknown>)[k] ?? 0);
  return {
    queued: g("queued"),
    supported: g("supported"),
    invited: g("invited"),
    accepted: g("accepted"),
    messaged: g("messaged"),
    replied: g("replied"),
    seenNoReply: g("seen_no_reply"),
    followedUp: g("followed_up"),
    declined: g("declined"),
    failed: g("failed"),
  };
}

function rowToTarget(r: Record<string, unknown>): Target {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    personKey: String(r.person_key),
    name: String(r.name),
    headline: str(r.headline),
    linkedinUrl: String(r.linkedin_url),
    seat: str(r.seat),
    state: String(r.state) as TargetState,
    priority: Number(r.priority ?? 0),
    why: str(r.why),
    avatarUrl: str(r.avatar_url),
    phUrl: str(r.ph_url),
    xHandle: str(r.x_handle),
    product: str(r.product),
    productUrl: str(r.product_url),
    supportedAt: num(r.supported_at),
    invitedAt: num(r.invited_at),
    acceptedAt: num(r.accepted_at),
    messagedAt: num(r.messaged_at),
    repliedAt: num(r.replied_at),
    detail: str(r.detail),
  };
}
