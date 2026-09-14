// "Draft for me" — one model call that writes a short, human LinkedIn first message, grounded in
// the founder's own business (what they sell, who they sell to) and the campaign's target audience.
//
// Mirrors `generateCreative` in paid-ads.ts exactly: a strong system prompt, strict short output,
// the org's LiteLLM virtual key (budgeted, allowlisted, attributable), and `undefined` on ANY
// failure so the caller degrades to the founder writing their own line. `complete` is injectable so
// tests drive the composer without a network.
//
// This is NOT a send-time step. It writes ONE default opener the founder edits — the same job the
// composer's "First message, for everyone" box does by hand — never a per-recipient improvisation.
import { BREAKUP_BRIEF, lint } from "@mycel/gtm-math";
import { chatComplete } from "../litellm";
import { getDomainStore } from "../domain";
import { listLibrarySkills } from "../skill-library";

/** The library domain GTM outreach draws its procedure from. */
const GTM_DOMAIN = "gtm";

/**
 * The GTM skill library as one block of guidance for the opener. This is the "GTM reads the harness"
 * seam: instead of a hardcoded prompt, the message is written the way the curated (and, over time,
 * self-refining) outreach skills say to. Frontmatter is stripped — the model wants the procedure, not
 * the menu line — and the whole thing is capped and fails soft to empty, because a drafted opener is
 * a convenience the founder edits, never a step that may fail for want of a skill. Cheap: one call
 * per campaign, not per send.
 */
async function gtmGuidance(): Promise<string> {
  const skills = await listLibrarySkills(getDomainStore(), { domains: [GTM_DOMAIN] }).catch(() => []);
  if (!skills.length) return "";
  return skills
    .map((s) => s.body.replace(/^---\s*[\s\S]*?\n---\s*/m, "").trim())
    .join("\n\n---\n\n")
    .slice(0, 6000);
}

/** The connection-note / first-DM ceiling. LinkedIn's own invite note caps near here, and a longer
 * first message reads as a pitch rather than a person. */
export const MAX_FIRST_MESSAGE = 300;

const clip = (t: string, n: number): string => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/** Strip a code fence and surrounding quotes a model sometimes wraps a single line in. */
function unwrap(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

const SYSTEM = [
  "You write the FIRST message a founder sends a stranger on LinkedIn — a connection note or opening DM.",
  "It must sound like a real person typed it, grounded in what THIS founder actually sells and the world of the person receiving it.",
  "Hard rules, all mandatory:",
  `- At most ${MAX_FIRST_MESSAGE} characters. Shorter is better. One or two sentences.`,
  "- No links, no URLs, no phone numbers, no email addresses.",
  '- No "quick call?", no "hop on a call", no "book a time", no calendar ask. This is a first hello, not a pitch.',
  "- No salesy openers (\"I help X do Y\"), no flattery, no buzzwords, no emojis, no hashtags.",
  "- Reference the founder's actual offer and the recipient's world in plain words.",
  "- You MAY use the literal token {first_name} once where their name would go. Never invent a name.",
  "Return ONLY the message text — no quotes, no preamble, no explanation, no code fences.",
].join("\n");

/**
 * Draft one first message. Returns the trimmed, capped string, or `undefined` when there is no org,
 * the proxy is unreachable, or the model returned nothing usable — every one of which the caller
 * must answer by letting the founder write their own line.
 */
export async function draftFirstMessage(args: {
  orgId?: string;
  /** The campaign's "who to find" query — the target ICP, in the founder's own words. */
  audience?: string;
  /** What the business sells, from its shape (or a founder-provided offer override). */
  sells?: string;
  /** Who the business sells to, from its shape. */
  sells_to?: string;
  /** The business / practice name, from its shape. */
  name?: string;
  /**
   * Write the LAST message instead of the first: it says we are going to stop, and asks for a no.
   *
   * A different message, not a softer one. Everything else in a cadence asks for a yes and treats a
   * no as failure; this names the no as the easy answer and means it. The brief is shared with
   * growth/ through @mycel/gtm-math so both sides send the same shape of ending.
   */
  breakup?: boolean;
  complete?: typeof chatComplete;
}): Promise<string | undefined> {
  if (!args.orgId) return undefined;   // no org → no budgeted key → no call
  const complete = args.complete ?? chatComplete;

  const sells = args.sells?.trim();
  const audience = args.audience?.trim();
  // Nothing to ground on at all ⇒ do not guess. A first message with no offer and no audience is a
  // blank template, which is the exact thing this feature exists to avoid.
  if (!sells && !audience) return undefined;

  const lines: string[] = [];
  if (args.name?.trim()) lines.push(`The founder's business is called: ${args.name.trim()}`);
  if (sells) lines.push(`What they sell: ${sells}`);
  if (args.sells_to?.trim()) lines.push(`Who they normally sell to: ${args.sells_to.trim()}`);
  if (audience) lines.push(`Who this campaign is reaching out to: ${audience}`);
  lines.push("", `Write the first LinkedIn message now, at most ${MAX_FIRST_MESSAGE} characters.`);

  // The opener is written the way the GTM skill library says to — the curated (and self-refining)
  // outreach procedure, not just a fixed prompt. Absent library ⇒ the base rules still stand.
  const guidance = await gtmGuidance();
  // LAST, so it is the closest instruction to the generation and overrides the opener rules above
  // it — every one of which is written for a message that wants a yes.
  const closing = args.breakup ? `\n\n${BREAKUP_BRIEF.join("\n")}` : "";
  const system = guidance
    ? `${SYSTEM}\n\nFollow this outreach playbook — it is how the best messages here are written:\n\n${guidance}${closing}`
    : `${SYSTEM}${closing}`;

  const raw = await complete({
    orgId: args.orgId,
    tier: "standard",
    system,
    user: lines.join("\n"),
    maxTokens: 160,
  });
  if (!raw) return undefined;

  const message = clip(unwrap(raw), MAX_FIRST_MESSAGE);
  if (!message) return undefined;

  /**
   * ═══ THE GATE THE CUSTOMER'S MESSAGES NEVER HAD ═══
   *
   * `growth/` has refused drafts on these rules since August and in one week rejected 263 against
   * 200 sent — em dashes, banned phrases, two asks in one note, a link that is not ours, the
   * message that opens by talking about us. This path drafts the same kind of cold message for a
   * paying customer and had no check at all, so everything the GTM skill library knows was advice
   * nothing could enforce.
   *
   * Shared rather than copied: `@mycel/gtm-math` now owns the rules, and growth re-exports from the
   * same file. Two copies would drift, and this session has already found a claim query disagreeing
   * with its own TypeScript twin and a signal detector sharing no vocabulary with its scorer.
   *
   * REFUSING IS THE RIGHT OUTCOME. A caller that gets `undefined` here already handles it — that is
   * the same answer it gets when there is nothing to ground on — and an unsent message costs a
   * touch, while a bad one costs the prospect. The violations are logged so the refusal is legible
   * rather than a mysterious blank.
   */
  const violations = lint(message);
  if (violations.length > 0) {
    console.warn(
      `[gtm] first message refused by the copy gate: ${violations.map((v) => `${v.rule} (${v.detail})`).join("; ")}`,
    );
    return undefined;
  }
  return message;
}

/** One prospect, as much of their world as the search/enrichment left on the row. */
export interface ProspectWorld {
  profile_id: string;
  name?: string;
  headline?: string;
  title?: string;
  company?: string;
  location?: string;
  /**
   * ═══ THE REASON THIS PERSON, TODAY — WHICH THE COPY COULD NOT SEE ═══
   *
   * The whole GTM machine exists to answer "who is worth a message today". `read_signals` scores it,
   * `POST /v1/gtm/campaigns/:id/enrol` accepts a `signal` per prospect and stores it on the case, and
   * the function that writes the message was never given it. So the strongest true sentence available
   * — "you announced a second depot in Avonmouth, opening in March" — sat one field away from the
   * prompt and the model wrote around it.
   *
   * The cost of that is not subtle. A tester playing a real COO rejected three consecutive openers
   * for the same reason in their own words: the message referenced a second site generically and got
   * the detail wrong. A message grounded in a role and a company is a merge field with better
   * grammar; a message grounded in a THING THAT HAPPENED is the one that gets answered, and this
   * file's own header sets that as the bar ("a note that could not have been written about anyone
   * else").
   *
   * Optional, because plenty of prospects have no signal and a note without one is still worth
   * sending. The prompt below asks the model to lead with it when it is there and never to invent one
   * when it is not.
   */
  signal?: string;
}

/** What a per-person draft came back as: the copy, keyed to the prospect it was written about. */
export interface ProspectDraftCopy {
  profile_id: string;
  /** The first DM / connection note. Absent when the model gave nothing usable for this person. */
  message?: string;
}

/**
 * Draft a DISTINCT first message for each prospect — the `draft_campaign_copy` job, run at propose
 * time, as a function rather than agent prose.
 *
 * This is the difference the whole GTM composer exists to make. `draftFirstMessage` writes ONE
 * opener the founder pastes onto everyone; this writes "a note that could not have been written about
 * anyone else", grounded in each person's own headline, role, company and city on top of what the
 * founder sells and the goal they typed. The founder's typed line becomes GUIDANCE — the intent of
 * the campaign — not the literal words sent to all.
 *
 * ONE model call per prospect, sequential and fail-soft: a person the model returns nothing for comes
 * back with `message: undefined`, and the composer leaves that row for the founder to write by hand
 * (the same park-not-improvise rule the sequencer keeps). No org, or nothing to ground on at all ⇒
 * an empty list, and the founder writes their own — a personalisation nicety never blocks.
 */
export async function draftPerProspect(args: {
  orgId?: string;
  prospects: ProspectWorld[];
  /** The founder's typed line — the campaign's intent, used as guidance, never sent verbatim. */
  goal?: string;
  sells?: string;
  sells_to?: string;
  name?: string;
  complete?: typeof chatComplete;
}): Promise<ProspectDraftCopy[]> {
  if (!args.orgId || !args.prospects.length) return [];
  const complete = args.complete ?? chatComplete;

  const sells = args.sells?.trim();
  const goal = args.goal?.trim();
  // Nothing about the founder's side to ground on ⇒ do not guess. A per-person line still needs to
  // say something true about what this founder does; the person's world alone is not an offer.
  if (!sells && !goal) return [];

  // The GTM library guidance is read ONCE for the whole batch, not per prospect — same procedure,
  // many recipients. Cheap: one read, then one short model call each.
  const guidance = await gtmGuidance();
  const system =
    (guidance
      ? `${SYSTEM}\n\nFollow this outreach playbook — it is how the best messages here are written:\n\n${guidance}`
      : SYSTEM) +
    "\n\nWrite for the SPECIFIC person described. Reference something real about their role, company " +
    "or headline so the note could not have been sent to anyone else. Do not use {first_name} when " +
    "you have been given their actual name — write it." +
    // Named as the strongest fact rather than left as one bullet among four, because a model handed
    // five true things about a stranger will average them into a paragraph about nobody. The recent
    // event is the only one that answers "why are you writing to me now", which is the question the
    // recipient is actually asking.
    "\n\nIf you are given something that recently HAPPENED at their company, that is the strongest " +
    "thing you have — open on it, in their terms, and get every detail of it right. Repeat only what " +
    "you were told: do not add a place, a date, a number or a consequence that is not in front of " +
    "you. A specific fact stated wrongly is worse than no fact at all, because the recipient knows " +
    "their own business and you have just proved you do not.";

  const base: string[] = [];
  if (args.name?.trim()) base.push(`The founder's business is called: ${args.name.trim()}`);
  if (sells) base.push(`What they sell: ${sells}`);
  if (args.sells_to?.trim()) base.push(`Who they normally sell to: ${args.sells_to.trim()}`);
  if (goal) base.push(`The founder's intent for this campaign (guidance, not words to copy): ${goal}`);

  const out: ProspectDraftCopy[] = [];
  for (const p of args.prospects) {
    const who: string[] = [];
    if (p.name?.trim()) who.push(`Their name: ${p.name.trim()}`);
    const role = p.title?.trim() || p.headline?.trim();
    if (role) who.push(`Their role / headline: ${role}`);
    if (p.company?.trim()) who.push(`Their company: ${p.company.trim()}`);
    if (p.location?.trim()) who.push(`Where they are: ${p.location.trim()}`);
    if (p.signal?.trim()) who.push(`What recently happened there — the reason you are writing now: ${p.signal.trim()}`);

    const user = [
      ...base,
      "",
      "The person you are writing to:",
      ...(who.length ? who : ["(only a profile id is known — keep it warm and specific to what you sell)"]),
      "",
      `Write the first LinkedIn message to THIS person now, at most ${MAX_FIRST_MESSAGE} characters.`,
    ].join("\n");

    let message: string | undefined;
    try {
      const raw = await complete({ orgId: args.orgId, tier: "standard", system, user, maxTokens: 160 });
      if (raw) message = clip(unwrap(raw), MAX_FIRST_MESSAGE) || undefined;
    } catch (e) {
      console.error(`[mycel] per-prospect draft failed for ${p.profile_id}:`, (e as Error)?.message ?? e);
    }
    out.push({ profile_id: p.profile_id, message });
  }
  return out;
}
