import { getDomainStore } from "./domain";
import { agentMailConfig, createInbox } from "./agentmail";

/**
 * EVERY ENGAGEMENT GETS AN ADDRESS TO ASK FROM, WITHOUT ANYONE BEING ASKED TO ARRANGE ONE.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT MADE THIS NECESSARY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured in production: twenty-one projects, ONE channel. The only project holding a mailbox was
 * the QA walkthrough — created by hand while testing. Not one real founder had ever ended up with
 * an address, across seven projects carrying a hundred and forty-three engagements between them.
 *
 * That single absence is upstream of the whole client loop. `kickoff.ts` creates a thread only when
 * `listChannels()` returns something, so with no channel there is no thread; with no thread every
 * ask it raises carries `thread_id: null`; and an ask with no thread cannot be emailed and — until
 * today — could not even be answered in the portal, because the uploader was gated on that same
 * field. Fifty-one asks written, three answered, none since August.
 *
 * The step to fix it existed and was good: one button, honest copy, in onboarding. It was still a
 * step, placed at a moment when a founder is three screens deep and has not yet seen why an address
 * matters, and the measured completion rate across real projects was zero. A capability nobody
 * reaches is indistinguishable from one that does not exist — and paying AgentMail for inboxes we
 * never create is the purest version of that.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY HERE, AND NOT AT SIGNUP
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An engagement opening is the first moment the address is certainly needed: kickoff is about to
 * raise intake asks at a named client. Provisioning at signup would mint an inbox for every trial
 * that never opens an engagement — a real cost, on an account with a quota, for projects that will
 * never send anything. Provisioning here is exactly-when-needed and it backfills by itself: any
 * project whose next engagement opens gets one, with no migration to run.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * IT MUST NEVER BE ABLE TO STOP AN ENGAGEMENT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A signed contract opening is worth more than an address. Every failure here — AgentMail down, no
 * key configured, a name collision, a timeout — returns a reason and lets the caller carry on. The
 * engagement still opens, kickoff still runs, and the asks it raises are still answerable in the
 * portal, because that path no longer depends on this one. This makes the loop better; it is not
 * allowed to become a new way for it to fail.
 */
export type EnsureMailboxResult =
  | { ok: true; address: string; created: boolean }
  | { ok: false; reason: string };

/** Lowercased, punctuation collapsed, capped — AgentMail accepts `[a-z0-9._-]{1,64}`. */
export function mailboxUsername(projectName: string | undefined): string {
  const base = (projectName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  /**
   * "hello" rather than the project name when there is nothing usable, matching what onboarding
   * offered. A client reading `hello@…` sees a business; a client reading `project-1@…` sees
   * software with a database behind it.
   */
  return base || "hello";
}

/**
 * Give this project an address if it has none. Safe to call on every engagement that opens.
 *
 * Idempotent by the CHANNEL, not by a flag: the channel is the thing kickoff actually looks for, so
 * checking anything else would let the two disagree. A project that already has one is left exactly
 * as it is — including one pointed at a different wedge, because that was somebody's choice.
 */
export async function ensureProjectMailbox(args: {
  project_id: string;
  wedge: string;
  task_type: string;
  /** The business's own name, for the address. Falls back to `hello`. */
  project_name?: string;
}): Promise<EnsureMailboxResult> {
  const { project_id, wedge, task_type } = args;
  if (!project_id || !wedge || !task_type) {
    // An inbox nothing runs on is a mailbox that swallows replies — the same refusal the manual
    // route makes, for the same reason.
    return { ok: false, reason: "project, wedge and task_type are all required" };
  }

  const domain = getDomainStore();
  const existing = (await domain.listChannels()).filter(
    (ch) => !ch.project_id || ch.project_id === project_id,
  );
  if (existing[0]) return { ok: true, address: existing[0].address, created: false };

  const cfg = agentMailConfig();
  if (!cfg) return { ok: false, reason: "AGENTMAIL_API_KEY is unset on this deployment" };

  const username = mailboxUsername(args.project_name);
  const res = await createInbox(cfg, { username, display_name: args.project_name || undefined }).catch(
    (e: unknown) => ({ ok: false as const, detail: e instanceof Error ? e.message : String(e), status: 0 }),
  );
  if (!("ok" in res) || !res.ok || !res.data?.inbox_id) {
    const detail = "detail" in res ? res.detail : "no inbox id returned";
    return { ok: false, reason: `AgentMail refused the inbox: ${detail}` };
  }

  const inboxId = res.data.inbox_id;
  /**
   * The address is the inbox id when AgentMail did not hand back a domain-qualified one. That is
   * what the manual route does too, and it is deliberately not invented here: a `from` we made up
   * is a `from` that bounces.
   */
  const address = inboxId;

  const conn = await domain.createConnection({
    project_id,
    kind: "agentmail",
    name: `mailbox ${address}`,
    owner: { kind: "founder", id: "founder" },
    // The sending identity AND the inbound routing key. Config, not payload — see agentmail.ts.
    config: { inbox_id: inboxId, address, from: address },
  });

  await domain.createChannel({
    project_id,
    connection_id: conn.id,
    kind: "agentmail",
    address,
    wedge,
    task_type,
  });

  return { ok: true, address, created: true };
}
