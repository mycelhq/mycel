// Which trades have anything to show in a founder's first hour — and why the rest do not.
//
// `first-hour-live.ts` states the stake: "Activate enables schedules and fires one tick. That tick
// is often a sync/chase, not a client engagement. Quiet Clock after 'we're live' is the #1 'is this
// fake?' moment." `cold_start` is the flag that answers it, and sign-up is now open, so a stranger
// on the wrong trade meets that quiet room unattended.
//
// This test exists because the flag is LAX — `wedge.ts` says a wrong answer here "means the founder
// is offered a first job that turns out to need something". Lax means nothing else will catch a
// wedge that claims it can start cold and cannot, so the claim is checked against the one property
// that makes it true: every client-facing job it would run must be satisfiable from what onboarding
// already knows, with no upload and no human wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { wedgesDir } from "../src/wedge";

const manifests = readdirSync(wedgesDir())
  .filter((d) => existsSync(join(wedgesDir(), d, "wedge.json")))
  .map((slug) => ({ slug, m: JSON.parse(readFileSync(join(wedgesDir(), slug, "wedge.json"), "utf8")) }));

/** What `draft_shape` produces during onboarding, before a client or a document exists. */
const KNOWN_AT_SIGNUP = new Set(["sells", "sells_to", "name", "domain", "client_id", "client", "period", "today"]);

test("a wedge claiming cold_start can actually run one of its jobs from what signup knows", () => {
  const claimed = manifests.filter((w) => w.m.cold_start);
  assert.ok(claimed.length > 0, "no wedge can start cold — every new account meets a quiet Clock");

  for (const { slug, m } of claimed) {
    const jobs = Object.entries(m.task_types ?? {}) as [string, Record<string, unknown>][];
    const runnable = jobs.filter(([, tt]) => {
      if (tt.internal) return false;
      const required: string[] = (tt.input_schema as { required?: string[] })?.required ?? [];
      return required.every((f) => KNOWN_AT_SIGNUP.has(f));
    });
    assert.ok(
      runnable.length > 0,
      `${slug} declares cold_start but every client-facing job needs input signup does not have — ` +
        `a founder would be offered a first job that immediately asks them for something`,
    );
  }
});

test("the trades that cannot start cold are NOT quietly flagged as if they could", () => {
  /**
   * The honest half, and the reason this is a test rather than a comment. `cold_start` is the
   * difference between a first hour that shows work and one that shows an empty room, so the
   * temptation when sign-up is open is to flag everything.
   *
   * These four cannot, by the flag's own definition — "given only who the client is, a domain, a
   * name". A ledger, a contract, a questionnaire and a role brief are not that, and a wedge that
   * claims otherwise sends a stranger to a job that stops and asks for a document on their first
   * morning. That is worse than a quiet room, because it looks like the product is broken rather
   * than empty.
   */
  for (const slug of ["books-keeper", "contract-desk", "security-questionnaire", "recruiting-desk"]) {
    const w = manifests.find((x) => x.slug === slug);
    if (!w) continue;
    assert.notEqual(w.m.cold_start, true, `${slug} cannot produce a readable artifact without intake`);
  }
});
