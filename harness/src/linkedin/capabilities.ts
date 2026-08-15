// What the agent may do on LinkedIn, declared rather than hardcoded.
//
// Three consumers read this one table, which is the point of it existing:
//
//   1. THE AGENT. The prompt lists these so it can plan. An agent that does not know endorsing a
//      skill is possible will never endorse a skill, and an agent given a bare list of function
//      names will use the wrong one — so each entry says what it is FOR, not just what it is
//      called. Freedom comes from knowing the surface, not from removing the guardrails.
//   2. THE PACING ENGINE. `touch` says what a capability costs against the account's weekly budget.
//      A profile view is nearly free; an invitation is the scarcest thing LinkedIn gives you.
//   3. THE APPROVAL GATE. `risk` replaces the hardcoded `risk: "high"` every action used to carry.
//      Reading a profile and messaging a stranger are not the same decision, and a gate that treats
//      them identically trains people to approve without looking — which is the failure mode that
//      makes the whole gate worthless.
//
// The risk levels are about REACH, not about difficulty. Anything a third party can see, or that
// arrives in their notifications with the founder's name on it, is at least medium. Anything
// irreversible is high.
import type { TouchKind } from "../pacing";
import { DECLARED_UNWIRED, PUBLIC_BANNED, READ_LIVE, RECOVERY_LIVE, SEQUENCE_LIVE, WARMUP_GATED } from "./verbs";

export type Risk = "low" | "medium" | "high";

export interface Capability {
  /** The slug the agent calls, and the key the action proxy dispatches on. */
  id: string;
  /** One line the agent reads to decide whether this is the right tool. Written for a reader. */
  what: string;
  /** When to reach for it — the difference between a list of verbs and something usable. */
  when?: string;
  /** Reads change nothing and need no approval. Writes reach a human being. */
  kind: "read" | "write";
  risk: Risk;
  /** What it spends from the pacing budget. `null` for reads that cost nothing. */
  touch: TouchKind | null;
  /** Arguments, described for an agent rather than for a compiler. */
  args: Record<string, string>;
  /** Anything that will surprise someone — quotas, irreversibility, etiquette. */
  caution?: string;
}

/**
 * The action surface.
 *
 * Ordered roughly by how a real outreach sequence uses them: find someone, learn about them, warm
 * up, connect, converse. That ordering is itself information for the agent.
 */
export const LINKEDIN_ACTIONS: Capability[] = [
  // ── finding people ──────────────────────────────────────────────────────────
  {
    id: "search_people",
    what: "Search LinkedIn for people matching a query, title, company or location.",
    when: "Building a list of prospects. Always the first step — never message someone you have not looked at.",
    kind: "read",
    risk: "low",
    touch: null,
    args: { query: "free text", title: "job title filter", company: "company name", location: "city or region", limit: "max results" },
    caution: "Heavy search volume is itself a flagged pattern. Prefer a narrow query over paging through hundreds.",
  },
  {
    id: "company_people",
    what: "List the people who work at a company, from its LinkedIn People tab.",
    when: "The account has run out of people-searches this month, or the target IS a company — everyone at an agency, a fund, a target account. It does not spend the search quota.",
    kind: "read",
    risk: "low",
    touch: null,
    args: {
      company: "company vanity name or slug (e.g. 'stripe')",
      company_id: "numeric organization id, if known — skips the slug lookup",
      limit: "max results, up to 49",
      start: "paging offset",
    },
    caution: "Still LinkedIn traffic under the account's name. Page it like a human reading a staff list, not a scraper.",
  },
  {
    id: "get_profile",
    what: "Fetch a person's profile: headline, current role, history, skills, shared connections.",
    when: "Before any outreach. A message that references something real is the whole difference in reply rate.",
    kind: "read",
    risk: "low",
    touch: null,
    args: { profile_id: "public identifier or urn" },
  },
  {
    id: "get_company",
    what: "Fetch a company page: size, industry, recent posts, headcount trend.",
    when: "Qualifying an account, or finding a hook for a first message.",
    kind: "read",
    risk: "low",
    touch: null,
    args: { company: "slug or urn" },
  },

  // ── warming up ──────────────────────────────────────────────────────────────
  {
    id: "view_profile",
    what: "Visit a profile so it appears in their 'who viewed you'.",
    when: "A day or two before inviting. It is the cheapest possible warm-up and it measurably lifts acceptance.",
    kind: "write",
    risk: "low",
    touch: "profile_view",
    args: { profile_id: "public identifier or urn" },
    caution: "Only visible if the account's own viewing settings are public. Silent otherwise, and then it is wasted.",
  },
  {
    id: "follow_person",
    what: "Follow someone without connecting.",
    when: "They post publicly and you want the content without spending an invitation.",
    kind: "write",
    risk: "low",
    touch: "follow",
    args: { profile_id: "public identifier or urn" },
  },
  {
    id: "react_to_post",
    what: "React to someone's post (like, celebrate, support, insightful).",
    when: "Warming a prospect before an invitation, or maintaining a relationship without asking for anything.",
    kind: "write",
    risk: "medium",
    touch: "follow",
    args: { post_urn: "the post", reaction: "like | celebrate | support | insightful | funny | love" },
    caution: "Appears in their notifications with the founder's name. Reacting to something they posted a year ago is a bot tell.",
  },
  {
    id: "comment_on_post",
    what: "Leave a comment on a post.",
    when: "The highest-value warm-up there is, and the most dangerous to automate — a generic comment is worse than silence.",
    kind: "write",
    risk: "high",
    touch: "follow",
    args: { post_urn: "the post", text: "the comment" },
    caution: "Public and permanent under the founder's name. Never send one that could have been written without reading the post.",
  },
  {
    id: "endorse_skill",
    what: "Endorse a skill on someone's profile.",
    when: "Re-warming a dormant first-degree connection. Costs them nothing and often prompts a reply.",
    kind: "write",
    risk: "medium",
    touch: "follow",
    args: { profile_id: "public identifier or urn", skill: "the skill name as it appears on their profile" },
    caution: "First-degree connections only. Endorsing a skill you have no basis to judge is transparent, so prefer ones they are already endorsed for.",
  },

  // ── connecting ──────────────────────────────────────────────────────────────
  {
    id: "send_invite",
    what: "Send a connection request, optionally with a note.",
    when: "After a warm-up touch. This is the scarcest action LinkedIn gives you — roughly 100 a week, and acceptance rate is scored.",
    kind: "write",
    risk: "high",
    touch: "invite",
    args: { profile_id: "public identifier or urn", note: "up to 300 characters, optional" },
    caution:
      "The single most restriction-prone action. A low acceptance rate throttles the account automatically, and a " +
      "note that reads as a template performs worse than no note at all.",
  },
  {
    id: "withdraw_invite",
    what: "Withdraw a pending invitation.",
    when: "After ~3 weeks with no answer. Pending invitations count against the weekly limit until withdrawn, so this recovers budget.",
    kind: "write",
    risk: "low",
    touch: null,
    args: { invitation_id: "the pending invitation" },
    caution: "LinkedIn blocks re-inviting the same person for ~3 weeks after a withdrawal.",
  },
  {
    id: "accept_invite",
    what: "Accept an incoming connection request.",
    when: "Inbound interest. Usually the warmest lead the account has.",
    kind: "write",
    risk: "medium",
    touch: null,
    args: { invitation_id: "the incoming invitation" },
  },

  // ── conversation ────────────────────────────────────────────────────────────
  {
    id: "send_message",
    what: "Send a direct message to an existing connection.",
    when: "The main channel once connected. Free, and limited by pattern rather than a hard count.",
    kind: "write",
    risk: "high",
    touch: "message",
    args: { thread: "conversation urn, or profile_id to start one", text: "the message" },
    caution: "Reaches a real person under the founder's name. Always through the approval gate.",
  },
  {
    id: "send_inmail",
    what: "Message someone you are NOT connected to, spending an InMail credit.",
    when: "A prospect worth a scarce credit, where an invitation was declined or is inappropriate.",
    kind: "write",
    risk: "high",
    touch: "inmail",
    args: { profile_id: "recipient", subject: "subject line", text: "the message" },
    caution: "Credits are monthly and small (5–50 by plan). Refunded if they reply, which makes relevance literally profitable.",
  },
  {
    id: "reply_to_comment",
    what: "Reply to a comment on the founder's own post.",
    when: "Someone engaged with the founder's content — the warmest inbound signal on the platform.",
    kind: "write",
    risk: "medium",
    touch: null,
    args: { comment_urn: "the comment", text: "the reply" },
  },

  // ── publishing ──────────────────────────────────────────────────────────────
  {
    id: "create_post",
    what: "Publish a post from the founder's profile.",
    when: "Content that earns inbound, rather than outbound that spends allowance.",
    kind: "write",
    risk: "high",
    touch: null,
    args: { text: "post body", visibility: "anyone | connections" },
    caution: "Public and permanent under the founder's name. This is their professional reputation, not a channel.",
  },
];

/**
 * Inbound events worth waking the harness for.
 *
 * The distinction that matters: some of these are a REPLY to something we did, and some are a
 * signal from someone we have never touched. The second kind is the more valuable — a stranger
 * viewing a profile is buying intent nobody paid for.
 */
export interface TriggerType {
  id: string;
  what: string;
  /** Why a business should care, in outreach terms. */
  why: string;
  /** True when this is inbound interest rather than a response to our own action. */
  inbound: boolean;
}

export const LINKEDIN_TRIGGERS: TriggerType[] = [
  {
    id: "message_received",
    what: "Someone sent a direct message.",
    why: "A live conversation. Response time is the single biggest factor in whether it converts.",
    inbound: true,
  },
  {
    id: "invite_accepted",
    what: "A connection request was accepted.",
    why: "The moment to follow up. A first message within a day of acceptance dramatically outperforms one sent a week later.",
    inbound: false,
  },
  {
    id: "invite_received",
    what: "Someone requested a connection.",
    why: "Inbound interest, and free — it costs no invitation allowance to accept.",
    inbound: true,
  },
  {
    id: "profile_viewed",
    what: "Someone viewed the founder's profile.",
    why: "Buying intent nobody paid for. Especially strong if they are not a connection.",
    inbound: true,
  },
  {
    id: "post_commented",
    what: "Someone commented on the founder's post.",
    why: "Public engagement. Replying quickly compounds reach and starts a conversation with an audience watching.",
    inbound: true,
  },
  {
    id: "post_reacted",
    what: "Someone reacted to a post.",
    why: "A weak but free signal. Useful for ranking who to approach next; not worth a message on its own.",
    inbound: true,
  },
  {
    id: "mentioned",
    what: "The founder was mentioned in a post or comment.",
    why: "Someone is talking about them publicly. Ignoring it is the mistake.",
    inbound: true,
  },
  {
    id: "job_change",
    what: "A connection started a new role.",
    why: "The highest-intent trigger in B2B. A new decision-maker with a budget and something to prove, and a congratulations message is welcome rather than intrusive.",
    inbound: true,
  },
];

/**
 * Triggers that have a poll or a writer behind them TODAY.
 *
 * LinkedIn Voyager has no webhook API for DMs, comments, or reactions. Inbound is poll: the
 * sequencer tick reads the inbox (~15 min) and the recent-connections list (~1 h). Everything
 * else in `LINKEDIN_TRIGGERS` is declared so the agent prompt and the GTM UI can name the gap
 * rather than invent a listener that does not exist. Pinning the wired set here is what stops
 * a caption from being mistaken for a loop.
 */
export const WIRED_LINKEDIN_TRIGGERS = ["message_received", "invite_accepted"] as const;

/** Lookup for the action proxy and the pacing engine. */
export const capability = (id: string): Capability | undefined => LINKEDIN_ACTIONS.find((c) => c.id === id);

/**
 * Risk for the approval gate.
 *
 * Unknown capabilities are HIGH, not low. A capability someone adds tomorrow without touching this
 * table should arrive at the gate, not slip past it.
 */
export const riskFor = (id: string): Risk => capability(id)?.risk ?? "high";

/** What this action spends. Unknown spends an invitation — the scarcest budget, so a miss is safe. */
export const touchFor = (id: string): TouchKind | null =>
  capability(id) ? capability(id)!.touch : "invite";

/**
 * The conscience the sequence builder reads — live verbs, not the catalogue.
 *
 * Dumping every declared capability taught the agent to plan `follow_person` and `send_inmail`
 * on a runtime that cannot execute them. This lists what `propose_campaign` will accept, what
 * the finder may read, and what stays out of a sequence. Unwired and public verbs are named as
 * gaps, not as tools.
 */
export function describeForAgent(): string {
  const byId = new Map(LINKEDIN_ACTIONS.map((c) => [c.id, c]));
  const line = (id: string) => {
    const c = byId.get(id);
    if (!c) {
      if (id === "send_email") {
        return "- **send_email** (write, high risk) — Email after LinkedIn silence, if a mailbox is connected. Parks when there is no copy or no address.";
      }
      return `- **${id}**`;
    }
    const cost = c.touch ? ` · spends ${c.touch}` : " · free";
    const bits = [`- **${c.id}** (${c.kind}, ${c.risk} risk${cost}) — ${c.what}`];
    if (c.when) bits.push(`    when: ${c.when}`);
    if (c.caution) bits.push(`    careful: ${c.caution}`);
    return bits.join("\n");
  };

  const wiredTriggers = new Set<string>(WIRED_LINKEDIN_TRIGGERS);
  const liveTriggers = LINKEDIN_TRIGGERS.filter((t) => wiredTriggers.has(t.id));
  const gapTriggers = LINKEDIN_TRIGGERS.filter((t) => !wiredTriggers.has(t.id));

  return [
    "## LinkedIn — what this runtime can actually do",
    "",
    "Everything below runs through the action proxy and the approval gate. Reads are free;",
    "writes spend from a weekly budget that shrinks if people stop accepting. Look someone up",
    "before you contact them — a message that references something real is the difference in",
    "reply rate.",
    "",
    "### When you build a sequence",
    "",
    "These are the only `action` values `propose_campaign` will accept. Cadence is `wait_days`",
    "on a step, never `action: \"wait\"`.",
    "",
    ...SEQUENCE_LIVE.map(line),
    "",
    "### When you find people",
    "",
    "Reads — ungated, not sequence steps:",
    "",
    ...READ_LIVE.map(line),
    "",
    "Recovery (not a campaign step):",
    "",
    ...RECOVERY_LIVE.map(line),
    "",
    "### Keep these out of a campaign",
    "",
    `Warm-up engagement — built but OFF by default and never in a sequence, so do not plan around them: ${WARMUP_GATED.join(", ")}.`,
    `Declared, no executor — do not plan around them: ${DECLARED_UNWIRED.join(", ")}.`,
    `Public under the founder's name — banned: ${PUBLIC_BANNED.join(", ")}.`,
    "",
    "### Events you may be woken by",
    "",
    ...liveTriggers.map((t) => `- **${t.id}** — ${t.what} ${t.why}`),
    "",
    "Not polled. Do not invent a listener:",
    "",
    ...gapTriggers.map((t) => `- **${t.id}** — ${t.what}`),
  ].join("\n");
}
