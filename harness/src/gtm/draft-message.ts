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
  complete?: typeof chatComplete;
}): Promise<string | undefined> {
  if (!args.orgId) return undefined;
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
  const system = guidance
    ? `${SYSTEM}\n\nFollow this outreach playbook — it is how the best messages here are written:\n\n${guidance}`
    : SYSTEM;

  const raw = await complete({
    orgId: args.orgId,
    tier: "standard",
    system,
    user: lines.join("\n"),
    maxTokens: 160,
  });
  if (!raw) return undefined;

  const message = clip(unwrap(raw), MAX_FIRST_MESSAGE);
  return message || undefined;
}
