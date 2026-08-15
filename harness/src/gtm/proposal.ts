// "Draft a proposal" — the closer asset after interest, not a cold attachment.
//
// When a stranger REPLIES, the sequence has stopped and the founder's next move is a personalised
// one-pager: grounded in what THIS founder sells and the little we honestly know about the person
// who answered (their name, their company, their headline). One model call turns those facts into a
// SHORT structured document — a title and three to five tight sections — which the caller hands
// straight to the branded report renderer (`render/report.ts`). The model fills the words; the
// template lays out every glyph, exactly the seam `draftFirstMessage` and `render/report.ts` already
// draw.
//
// It DRAFTS ONLY. Nothing here sends, stores or renders — the route does that and queues it for the
// founder to approve. `undefined` on any model failure, so the surface degrades to "no draft yet"
// rather than a red box over a nice-to-have. `complete` is injectable so tests drive it with no
// network.
import { chatComplete } from "../litellm";
import type { ReportBlock, ReportDocumentInput } from "../render/report";

/** A section's heading and its body are both kept short — a proposal read on a phone, not a report. */
export const MAX_TITLE = 90;
export const MAX_HEADING = 80;
export const MAX_BODY = 600;
/** Three to five sections. Fewer than two is not a document; more than five is a brochure. */
export const MAX_SECTIONS = 5;
export const MIN_SECTIONS = 2;

const clip = (t: unknown, n: number): string => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/** Strip a ```json fence a model sometimes wraps its object in. */
function unfence(raw: string): string {
  const t = raw.trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  return (m?.[1] ?? t).trim();
}

interface DraftedSection {
  heading?: unknown;
  body?: unknown;
}

const SYSTEM = [
  "You draft a SHORT, personalised one-page proposal a founder sends to someone who has just replied with interest on LinkedIn.",
  "This is the closer asset AFTER interest, not a cold pitch — it is honest, specific and brief.",
  "Ground every word in two things only: what THIS founder actually sells, and the little that is genuinely known about the recipient (their name, their company, their headline).",
  "Hard rules, all mandatory:",
  "- Invent NO facts about the recipient or their company beyond what you are given. No fake metrics, no assumed pain, no imagined team size, no made-up budget.",
  "- Three to five short sections. Each body is a few plain sentences, not a wall of text.",
  "- No links, no URLs, no phone numbers, no email addresses, no prices you were not told.",
  "- No buzzwords, no flattery, no emojis, no hashtags. Sound like a real person who runs this business.",
  "Return ONLY a JSON object, no prose and no code fence, of exactly this shape:",
  '{ "title": string, "sections": [ { "heading": string, "body": string } ] }',
  'Good sections cover, in the founder\'s own words: what you understand about their company, how you would help, what it looks like to work together, and the next step.',
].join("\n");

/**
 * Draft one proposal. Returns a `ReportDocumentInput` the report renderer lays out, or `undefined`
 * when there is no org, nothing to ground on, the proxy is unreachable, or the model returned
 * nothing usable — every one of which the caller answers by simply not offering a draft yet.
 *
 * The returned document is CLIPPED and BOUNDED here, not trusted from the model: at most five
 * sections, each heading and body capped, the title capped. A model that runs long produces a
 * proposal that still fits a page rather than one that overflows it.
 */
export async function draftProposal(args: {
  orgId?: string;
  /** What we honestly know about the person who replied. Nothing is invented past this. */
  prospect: { name?: string; company?: string; headline?: string };
  /** What the founder's business sells, from its shape. */
  sells?: string;
  /** Who the founder normally sells to, from its shape. */
  sells_to?: string;
  /** The founder's business / practice name, from its shape. */
  name?: string;
  complete?: typeof chatComplete;
}): Promise<ReportDocumentInput | undefined> {
  if (!args.orgId) return undefined;
  const complete = args.complete ?? chatComplete;

  const sells = args.sells?.trim();
  // A proposal with no offer at all is a blank template — the exact thing this exists to avoid.
  if (!sells) return undefined;

  const prospect = args.prospect ?? {};
  const pName = prospect.name?.trim();
  const pCompany = prospect.company?.trim();
  const pHeadline = prospect.headline?.trim();

  const lines: string[] = [];
  if (args.name?.trim()) lines.push(`The founder's business is called: ${args.name.trim()}`);
  lines.push(`What the founder sells: ${sells}`);
  if (args.sells_to?.trim()) lines.push(`Who they normally sell to: ${args.sells_to.trim()}`);
  lines.push("", "What is known about the person who replied — do not go beyond this:");
  lines.push(`- Name: ${pName || "(unknown)"}`);
  lines.push(`- Company: ${pCompany || "(unknown)"}`);
  lines.push(`- Headline / role: ${pHeadline || "(unknown)"}`);
  lines.push("", "Write the proposal JSON now. Keep it short and honest.");

  const raw = await complete({
    orgId: args.orgId,
    tier: "standard",
    system: SYSTEM,
    user: lines.join("\n"),
    maxTokens: 900,
  });
  if (!raw) return undefined;

  let parsed: { title?: unknown; sections?: unknown };
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    return undefined;
  }

  const rawSections = Array.isArray(parsed?.sections) ? (parsed.sections as DraftedSection[]) : [];
  const sections = rawSections
    .map((s) => ({ heading: clip(s?.heading, MAX_HEADING), body: clip(s?.body, MAX_BODY) }))
    .filter((s) => s.heading || s.body)
    .slice(0, MAX_SECTIONS);
  // Fewer than two usable sections is not a proposal — the model gave us nothing to lay out.
  if (sections.length < MIN_SECTIONS) return undefined;

  const title =
    clip(parsed?.title, MAX_TITLE) || (pCompany ? clip(`A proposal for ${pCompany}`, MAX_TITLE) : "Proposal");

  const blocks: ReportBlock[] = [];
  for (const s of sections) {
    if (s.heading) blocks.push({ kind: "heading", text: s.heading, level: 2 });
    if (s.body) blocks.push({ kind: "paragraph", text: s.body });
  }

  const subtitle = pName ? `Prepared for ${pName}${pCompany ? `, ${pCompany}` : ""}` : pCompany || undefined;

  return {
    title,
    subtitle,
    blocks,
    footer: args.name?.trim() ? `Prepared by ${args.name.trim()}` : undefined,
  };
}
