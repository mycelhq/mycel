// A stranger wrote first. Capture them as a prospect, do not drop them on the floor.
//
// ═══ THE GAP THIS CLOSES ═══
//
// Inbox sync has always stopped sequences when someone we contacted answers. Anyone else — a warm
// inbound DM, a recruiter, a client who found the founder on LinkedIn — was filtered out of
// `noteInboundReplies` on purpose (they are not in the pacing denominator) and then forgotten.
// Pipeline never saw them. Home stayed quiet. The founder who paid for "inbound that lands" watched
// the message live only in LinkedIn itself, which is the trial-cancel: the product did not keep
// the conversation it was supposed to own.
//
// ═══ WHAT THIS WILL NOT DO ═══
//
// Count them as a reply for pacing. That would earn LinkedIn budget from people we never touched.
// Enrol them in a sending sequence. They already wrote; the next words are a human's, via the
// existing reply-handoff, not the sequencer.
// Write a `people` graph row keyed on a Voyager member urn. The CRM keys people on the public
// identifier ("jane-doe"); an ACoAA… urn is unmergeable landfill. The Case is the record.
import { randomUUID } from "node:crypto";
import type { DomainStore } from "../domain";
import { CAMPAIGN_COLLECTION, gtmWedge } from "./stages";
import type { InboundLike } from "./replies";

/** Stable record key so one LinkedIn seat has one inbound bucket, not one per poll. */
export const inboundCampaignKey = (connectionId: string): string => `inbound:${connectionId}`;

export const INBOUND_CAMPAIGN_NAME = "They wrote first";

/** Trailing segment of a Voyager urn, or the id itself. `unknown` is not a person. */
export function profileIdOf(fromId: string | undefined): string | undefined {
  const raw = fromId?.trim();
  if (!raw || raw === "unknown") return undefined;
  const tail = raw.split(":").pop()?.trim();
  return tail || undefined;
}

/**
 * Open a Case at `replied` for every inbound message that does not already belong to a prospect
 * on this account. Returns how many NEW cases were opened — never the raw inbound count.
 *
 * Tenancy is a precondition, same as `noteInboundReplies`: an unscoped case read sees every tenant.
 */
export async function captureUnsolicitedInbound(
  domain: DomainStore,
  conn: { id: string; project_id: string },
  inbound: InboundLike[],
): Promise<number> {
  if (!conn.project_id) {
    throw new Error("captureUnsolicitedInbound needs the connection's project — an unscoped case read sees every tenant");
  }
  if (!inbound?.length) return 0;

  const cases = await domain.listCases({ project_id: conn.project_id, wedge: gtmWedge() });
  const mine = cases.filter((k) => (k.data as Record<string, unknown> | undefined)?.connection_id === conn.id);
  const byThread = new Set<string>();
  const byPerson = new Set<string>();
  for (const k of mine) {
    const d = (k.data ?? {}) as Record<string, unknown>;
    if (typeof d.thread === "string" && d.thread) byThread.add(d.thread);
    if (typeof d.profile_id === "string" && d.profile_id) byPerson.add(d.profile_id);
  }

  const fresh: InboundLike[] = [];
  const seen = new Set<string>();
  for (const msg of inbound) {
    const pid = profileIdOf(msg.from?.id);
    if (msg.thread_id && byThread.has(msg.thread_id)) continue;
    if (pid && byPerson.has(pid)) continue;
    const key = msg.thread_id || pid;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(msg);
  }
  if (!fresh.length) return 0;

  const campaignId = await ensureInboundCampaign(domain, conn);
  const at = new Date().toISOString();
  let opened = 0;
  for (const msg of fresh) {
    const pid = profileIdOf(msg.from?.id);
    const name = msg.from?.name?.trim() || pid || "Someone";
    const snippet = (msg.text ?? "").trim().slice(0, 140);
    await domain.createCase({
      project_id: conn.project_id,
      wedge: gtmWedge(),
      title: name,
      stage: "replied",
      status: "open",
      due_at: at,
      data: {
        campaign_id: campaignId,
        connection_id: conn.id,
        profile_id: pid,
        thread: msg.thread_id,
        name,
        inbound_unsolicited: true,
        has_reply: true,
        replied_at: msg.sent_at ?? at,
        touch_count: 0,
      },
      history: [
        {
          at,
          kind: "created",
          to: "replied",
          note: snippet
            ? `${name} wrote first — ${snippet}`
            : `${name} wrote first — sequence never started, this one is yours`,
          actor: "system",
        },
      ],
    });
    opened++;
    if (pid) byPerson.add(pid);
    if (msg.thread_id) byThread.add(msg.thread_id);
  }
  return opened;
}

/**
 * One campaign-shaped bucket per LinkedIn seat, with no steps and no approval.
 *
 * Empty steps are the safety property: `campaignEnvelope` refuses any action that is not a
 * persisted step, so this bucket cannot authorise a send even if a caller hands it to the
 * sequencer. Cases land at `replied`, which is already terminal.
 */
async function ensureInboundCampaign(
  domain: DomainStore,
  conn: { id: string; project_id: string },
): Promise<string> {
  const key = inboundCampaignKey(conn.id);
  const existing = await domain.queryRecords({
    project_id: conn.project_id,
    wedge: gtmWedge(),
    collection: CAMPAIGN_COLLECTION,
    where: { inbound: true, connection_id: conn.id },
    limit: 1,
  });
  const found = existing[0]?.data as Record<string, unknown> | undefined;
  if (typeof found?.id === "string" && found.id) return found.id;
  if (typeof found?.campaign_id === "string" && found.campaign_id) return found.campaign_id;

  const id = randomUUID();
  const at = new Date().toISOString();
  await domain.upsertRecord({
    project_id: conn.project_id,
    wedge: gtmWedge(),
    collection: CAMPAIGN_COLLECTION,
    key,
    data: {
      id,
      campaign_id: id,
      project_id: conn.project_id,
      connection_id: conn.id,
      name: INBOUND_CAMPAIGN_NAME,
      steps: [],
      inbound: true,
      approval_id: "",
      task_id: "",
      expires_at: "",
      created_at: at,
    },
  });
  return id;
}
