// A campaign: the thing a founder approves ONCE, and the envelope that authorises its sends.
//
// WHY NOT PER-SEND APPROVAL. `awaitApproval` blocks the run in-process on a ~5 minute TTL. That is
// exactly right for "email this client an invoice" and catastrophic here: 200 prospects is 200
// suspended runs, most of them expiring unanswered at 3am, and the founder's queue becomes 200
// cards that all say roughly the same thing. A gate nobody reads is worse than no gate, because it
// launders the decision.
//
// So the unit of consent is the CAMPAIGN. One Approval, a 7-day TTL, a preview that summarises
// (who, how many, which steps, from which account) and an Artifact holding the full per-person copy
// for anyone who wants to read all 200 before saying yes. Approve once; every send inside that
// campaign then auto-approves and STILL LANDS IN THE APPROVALS QUEUE with a `policy_reason`. That
// last part is the difference between autonomy and a bypass: the founder can review afterwards,
// per message, and the audit trail says which envelope allowed it and why.
//
// THE ATTACK THIS IS SHAPED AGAINST. A previous design let the envelope match on the action NAME,
// so an agent that called its capability `send_followup` — a string it chose — authorised itself.
// Nothing here matches on anything the agent can write:
//
//   · the campaign id comes off the CASE, which enrollment created, not off a payload;
//   · the allowed actions are the steps PERSISTED in the approved campaign record, compared exactly;
//   · the connection is compared to the one the campaign was approved for;
//   · the case must belong to that campaign AND that project;
//   · and the approval row must literally be `approved` — a human decision, re-read from the store
//     at send time, not a boolean somebody set on the campaign.
//
// Every one of those is verified server-side, in the harness, on the same read path that does the
// send. There is no client-supplied token in the chain at all.
import { randomUUID } from "node:crypto";
import type { Case, Connection } from "../contract";
import type { DomainStore } from "../domain";
import type { Store } from "../store";
import { capability, riskFor } from "../linkedin/capabilities";
import { evaluateCondition, factsUsed, ConditionError } from "./conditions";
import { CAMPAIGN_COLLECTION, GTM_WEDGE, STAGES, type Stage } from "./stages";

/** One step of the sequence: what to do, when the case is sitting at `from`. */
export interface SequenceStep {
  /** The stage this step acts on. One step per stage keeps the machine a machine. */
  from: Stage;
  /**
   * A capability id from linkedin/capabilities.ts — NOT a name invented here.
   *
   * That is load-bearing rather than tidy: because a step's action is a capability id, `riskFor`
   * and `touchFor` are automatically correct for any step anyone composes later, and a capability
   * added next month arrives with its risk and its budget cost already declared.
   */
  action: string;
  /** Where the case moves when this step succeeds. */
  advance_to: Stage;
  /** `only_if` expression (see conditions.ts). Absent means unconditional. */
  only_if?: string;
  /** Cadence floor: don't run this step until this many days after the previous touch. */
  wait_days?: number;
}

/**
 * The default sequence.
 *
 * Warm, invite, wait, converse — the order capabilities.ts already documents, because it is the
 * order that actually earns acceptances. `comment_on_post` is deliberately absent: capabilities.ts
 * is right that a generic comment is worse than silence, and a comment is public and permanent
 * under the founder's name. A machine should not be writing those.
 */
export const DEFAULT_SEQUENCE: SequenceStep[] = [
  { from: "queued", action: "view_profile", advance_to: "warmed" },
  // A day between the view and the invitation: the warm-up only works if it is noticed first.
  { from: "warmed", action: "send_invite", advance_to: "invited", wait_days: 1, only_if: "!connected" },
  // The single highest-leverage message in outreach is the one sent within a day of acceptance.
  { from: "connected", action: "send_message", advance_to: "dm1", only_if: "connected AND !replied" },
  { from: "dm1", action: "send_message", advance_to: "dm2", wait_days: 4, only_if: "connected AND !replied" },
];

/**
 * What an approved campaign may auto-approve.
 *
 * A ceiling on top of whatever the steps say, so a campaign cannot be composed into blanket
 * autonomy. Publishing (`create_post`) and commenting are absent on purpose — they are public and
 * permanent, and no batch consent covers them.
 */
export const AUTO_APPROVABLE = new Set(["view_profile", "follow_person", "send_invite", "send_message"]);

/** Facts a condition may read. A step naming anything else is rejected at propose time. */
export const KNOWN_FACTS = ["connected", "replied", "invited", "warmed", "opted_out", "has_thread"] as const;

export interface Campaign {
  id: string;
  project_id: string;
  connection_id: string;
  name: string;
  steps: SequenceStep[];
  /** The single Approval the founder decides. Re-read from the store on every send. */
  approval_id: string;
  /** Full per-person copy, for the founder who wants to read all of it before approving. */
  artifact_id?: string;
  /** The run that proposed it — what the Approval and Artifact hang off. */
  task_id: string;
  /** Consent has a horizon. An envelope with no expiry is a standing grant nobody revisits. */
  expires_at: string;
  created_at: string;
}

/** A prospect as the founder is asked to approve them: who, and exactly what they will receive. */
export interface ProspectDraft {
  profile_id: string;
  name?: string;
  /** The conversation urn, when one already exists. Needed before a DM can be sent. */
  thread?: string;
  client_id?: string;
  /** The approved copy, per step action. Written once, at propose time — never at send time. */
  copy?: Record<string, string>;
}

export class CampaignError extends Error {}

/** Validate a sequence before a human is asked to approve it. Throws with a readable reason. */
export function validateSteps(steps: SequenceStep[]): void {
  if (!steps.length) throw new CampaignError("a campaign needs at least one step");
  const seen = new Set<string>();
  for (const s of steps) {
    if (!STAGES.includes(s.from)) throw new CampaignError(`unknown stage "${s.from}"`);
    if (!STAGES.includes(s.advance_to)) throw new CampaignError(`unknown stage "${s.advance_to}"`);
    if (seen.has(s.from)) throw new CampaignError(`two steps act on stage "${s.from}" — a stage has one step`);
    seen.add(s.from);
    if (STAGES.indexOf(s.advance_to) <= STAGES.indexOf(s.from)) {
      // Not pedantry: a step that moves a case backwards or sideways is an infinite sequence, and
      // an infinite sequence on LinkedIn is an account.
      throw new CampaignError(`step "${s.action}" must advance the case ("${s.from}" → "${s.advance_to}" does not)`);
    }
    if (!capability(s.action)) throw new CampaignError(`"${s.action}" is not a declared LinkedIn capability`);
    if (!AUTO_APPROVABLE.has(s.action)) {
      throw new CampaignError(`"${s.action}" cannot run under a campaign envelope — it needs a human, every time`);
    }
    if (s.only_if) {
      let used: string[];
      try {
        used = factsUsed(s.only_if);
      } catch (e) {
        throw new CampaignError(`step "${s.action}": ${(e as ConditionError).message}`);
      }
      const unknown = used.filter((f) => !(KNOWN_FACTS as readonly string[]).includes(f));
      if (unknown.length) {
        // Fail loudly here rather than quietly at send time: an unknown fact evaluates false, so a
        // typo would silently stop the campaign and look like nothing happening.
        throw new CampaignError(`step "${s.action}" reads unknown fact(s): ${unknown.join(", ")}`);
      }
    }
  }
}

const campaignKey = (id: string) => `campaign:${id}`;

/**
 * Propose a campaign: write the record, the artifact and ONE approval. Does not block, does not
 * wait, does not send. The founder decides in their own time — up to 7 days.
 */
export async function proposeCampaign(
  store: Store,
  domain: DomainStore,
  input: {
    task_id: string;
    project_id: string;
    connection_id: string;
    name: string;
    prospects: ProspectDraft[];
    steps?: SequenceStep[];
    /** How long the envelope stays valid once approved. Consent with no horizon is not consent. */
    valid_days?: number;
    ttl_ms?: number;
    now?: Date;
  },
): Promise<{ campaign: Campaign; approval_id: string }> {
  const steps = input.steps ?? DEFAULT_SEQUENCE;
  validateSteps(steps);
  if (!input.prospects.length) throw new CampaignError("a campaign needs at least one prospect");
  if (!input.project_id) throw new CampaignError("a campaign must belong to a project");

  const now = input.now ?? new Date();
  const id = randomUUID();

  // The FULL copy goes in an artifact, not in the preview. A preview is a summary a human can hold
  // in their head; 200 messages pasted into an approval card is how you train someone to click yes.
  const lines = [
    `# ${input.name}`,
    "",
    `${input.prospects.length} prospects · account: ${input.connection_id}`,
    "",
    "## Sequence",
    ...steps.map((s) => `- at **${s.from}** → \`${s.action}\` → ${s.advance_to}${s.only_if ? ` _(only if ${s.only_if})_` : ""}${s.wait_days ? ` _(after ${s.wait_days}d)_` : ""}`),
    "",
    "## Every message, in full",
    ...input.prospects.flatMap((p) => [
      "",
      `### ${p.name ?? p.profile_id}`,
      ...Object.entries(p.copy ?? {}).map(([step, text]) => `- **${step}**: ${text}`),
    ]),
  ];
  const artifact = await store.addArtifact({
    task_id: input.task_id,
    name: `campaign-${id}.md`,
    content_type: "text/markdown",
    content: lines.join("\n"),
  });

  const approval = await store.createApproval({
    task_id: input.task_id,
    // The action string records WHAT was consented to, and it contains the campaign id so an
    // approval row is meaningful on its own in the queue. Nothing matches on it (see the header).
    action: `gtm:campaign:${id}`,
    risk: steps.some((s) => riskFor(s.action) === "high") ? "high" : "medium",
    preview: {
      campaign: input.name,
      prospects: input.prospects.length,
      steps: steps.map((s) => `${s.from} → ${s.action}`),
      account: input.connection_id,
      full_copy_artifact: artifact.id,
      // Three names is enough to recognise the list; the artifact has all of them.
      sample: input.prospects.slice(0, 3).map((p) => p.name ?? p.profile_id),
      preview:
        `Approve once and ${input.prospects.length} prospects run this ${steps.length}-step sequence, ` +
        `paced across working hours. Every send still appears here afterwards.`,
    },
    // 7 days. A campaign is a decision a founder should be allowed to sleep on; the 5-minute
    // default belongs to a message that is already half-sent.
    ttlMs: input.ttl_ms ?? 7 * 24 * 60 * 60 * 1000,
  });

  const campaign: Campaign = {
    id,
    project_id: input.project_id,
    connection_id: input.connection_id,
    name: input.name,
    steps,
    approval_id: approval.approval_id,
    artifact_id: artifact.id,
    task_id: input.task_id,
    expires_at: new Date(now.getTime() + (input.valid_days ?? 30) * 86_400_000).toISOString(),
    created_at: now.toISOString(),
  };
  await domain.upsertRecord({
    project_id: input.project_id,
    wedge: GTM_WEDGE,
    collection: CAMPAIGN_COLLECTION,
    key: campaignKey(id),
    // `campaign_id` is duplicated into data because that is what `queryRecords.where` can match on.
    data: { ...campaign, campaign_id: id } as unknown as Record<string, unknown>,
  });
  return { campaign, approval_id: approval.approval_id };
}

/** Load a campaign, scoped to a project. Fails closed: a campaign in another tenant is not found. */
export async function loadCampaign(
  domain: DomainStore,
  projectId: string | undefined,
  campaignId: string,
): Promise<Campaign | undefined> {
  if (!projectId || !campaignId) return undefined;
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: GTM_WEDGE,
    collection: CAMPAIGN_COLLECTION,
    where: { campaign_id: campaignId },
    limit: 1,
  });
  return rows[0] ? (rows[0].data as unknown as Campaign) : undefined;
}

export interface EnvelopeDecision {
  auto: boolean;
  /** Recorded as `policy_reason` on the approval — the audit trail for a batch review. */
  reason: string;
}

/**
 * May this send proceed without stopping for a human?
 *
 * Read the checks as a list of things an attacker would have to control, and note that none of them
 * is a string the agent produced. `policy.ts` is not consulted at all here: its rate counters are
 * in-process `Map`s, so with N replicas they permit N× what they say and they fail OPEN when the
 * process restarts. They are fine as a nuisance limiter on a wedge's own actions and they are NOT a
 * ceiling on LinkedIn sends. `pacing.ts` is the real ceiling — it is store-backed, it fails closed,
 * and it is consulted separately on every single send in sequence.ts.
 */
export async function campaignEnvelope(
  store: Store,
  domain: DomainStore,
  args: {
    campaign: Campaign;
    /** The case being advanced — its `campaign_id` must match, and it must be in the same project. */
    kase: Case;
    /** The connection the send would actually go out on. */
    connection: Pick<Connection, "id" | "project_id">;
    /** The capability about to run. Compared to the campaign's persisted steps, exactly. */
    action: string;
    now?: Date;
  },
): Promise<EnvelopeDecision> {
  const { campaign, kase, connection, action } = args;
  const now = args.now ?? new Date();

  const caseCampaign = (kase.data as Record<string, unknown> | undefined)?.campaign_id;
  if (caseCampaign !== campaign.id) {
    return { auto: false, reason: `case ${kase.id} does not belong to campaign ${campaign.id}` };
  }
  // Tenancy, three ways, because each of them is a real hole if it is the one missing.
  if (!campaign.project_id || kase.project_id !== campaign.project_id) {
    return { auto: false, reason: "case and campaign are in different projects" };
  }
  if (connection.project_id !== campaign.project_id) {
    return { auto: false, reason: "connection is not in the campaign's project" };
  }
  if (connection.id !== campaign.connection_id) {
    // THE ONE THAT MATTERS MOST: an envelope approved for the founder's account must not authorise
    // a send from a different LinkedIn account that happens to be in the same project.
    return { auto: false, reason: "this campaign was approved for a different account" };
  }
  if (!campaign.steps.some((s) => s.action === action)) {
    return { auto: false, reason: `"${action}" is not a step in the approved campaign` };
  }
  if (!AUTO_APPROVABLE.has(action)) {
    return { auto: false, reason: `"${action}" always needs a human` };
  }
  if (Date.parse(campaign.expires_at) <= now.getTime()) {
    return { auto: false, reason: "the campaign's approval window has expired — re-approve it" };
  }

  // The consent itself, re-read from the store rather than cached on the campaign: a founder who
  // rejects the approval must stop the campaign, and a boolean copied at propose time cannot do
  // that. `auto_approved` is deliberately NOT accepted — a policy envelope approving the creation
  // of another policy envelope is a loop with no human anywhere in it.
  const approval = await store.getApproval(campaign.approval_id);
  if (!approval) return { auto: false, reason: "the campaign's approval no longer exists" };
  if (approval.status !== "approved") {
    return {
      auto: false,
      reason:
        approval.status === "pending"
          ? "waiting for you to approve this campaign"
          : `the campaign approval was ${approval.status}`,
    };
  }

  return {
    auto: true,
    reason:
      `auto-approved by campaign "${campaign.name}" (${campaign.id}), approved by a human on ` +
      `${approval.decided_at ?? "approval"} for account ${campaign.connection_id}; step "${action}"`,
  };
}

/**
 * Enrol a prospect: one Case, per prospect, per campaign.
 *
 * Due immediately by default — "immediately" meaning "the sequencer may look at it on its next
 * tick", where pacing then decides whether anything actually goes out. Nothing here bursts.
 */
export async function enrollProspect(
  domain: DomainStore,
  campaign: Campaign,
  p: ProspectDraft,
  now: Date = new Date(),
): Promise<Case> {
  return domain.createCase({
    project_id: campaign.project_id,
    wedge: GTM_WEDGE,
    title: p.name ?? p.profile_id,
    client_id: p.client_id,
    stage: "queued",
    status: "open",
    due_at: now.toISOString(),
    data: {
      campaign_id: campaign.id,
      connection_id: campaign.connection_id,
      profile_id: p.profile_id,
      thread: p.thread,
      name: p.name,
      copy: p.copy ?? {},
      touch_count: 0,
    },
    history: [{ at: now.toISOString(), kind: "created", note: `enrolled in ${campaign.name}`, actor: "system" }],
  });
}
