// The client's LLM brain: what they think when they open the portal and look at what arrived.
//
// ═══ WHERE THIS PLUGS IN, AND WHY THAT SEAM WAS ALREADY THERE ═══
//
// `client-mind.ts` takes a `Judgement` rather than computing one, on the argument that "does this
// version address the objection?" needs reading comprehension while "how much patience is left" is
// arithmetic. This file is the reading comprehension. Nothing in `client-mind` changes.
//
// That split is what keeps the simulation falsifiable. If the model decided both what it thought
// AND what that meant, every run would produce a plausible story and no run would produce a signal
// — the failure mode of every agent-based simulation that reads well and proves nothing.
//
// ═══ WHY IT LOOKS AT PIXELS AND NOT JUST TEXT ═══
//
// A client does not receive a `client_summary` string. They receive an email, click a link, and
// look at a page — and the things that lose a customer live in the gap between those two:
//
//   - a PDF that renders as a wall of grey with the number they wanted on page three
//   - an "Accept" button next to work that plainly is not done
//   - three open questions stacked above the deliverable, so the first impression is homework
//   - a portal that looks like a dashboard for us rather than an answer for them
//
// None of that is in the text. All of it is in the screenshot. So the brain is given the rendered
// page and the artifact, and asked what a person would think — which is the only question the
// business is actually being graded on.
//
// ═══ THE PROMPT IS THE PRODUCT HERE ═══
//
// A synthetic client that is easy to please proves nothing, and one that is impossible to please
// proves nothing either. The prompt below is tuned for a specific persona: a small-business owner
// who is busy, not hostile, does not know or care how any of it works, and has ONE thing that would
// make them unhappy. Asking for one complaint rather than a list is deliberate — a real client says
// "the VAT figure is wrong", not a nine-point review, and a list gives the business nothing to fix
// first.

import type { Memory, Judgement, Received } from "./client-mind";
import { openObjection } from "./client-mind";

/** What the client can actually perceive this round. */
export interface Seen {
  /** The deliverable's client-facing text, if any. */
  body: string;
  /** Files they were handed, by name. */
  files: string[];
  /** PNG bytes of the portal as they see it, if the runner could take one. */
  portalShot?: Buffer;
  /** PNG bytes of the artifact preview, if it renders. */
  artifactShot?: Buffer;
  /** Open questions stacked in front of them right now — first impression, before the work. */
  openAsks: string[];
}

/** The model call, injected so this file is testable and provider-agnostic. */
export interface Vision {
  (args: { system: string; user: string; images: Buffer[] }): Promise<string>;
}

/**
 * What kind of business this client runs, and what they care about.
 *
 * Personas are not decoration: the product's thesis is that a wedge adapts to a business, so the
 * interesting failures are where the SAME deliverable reads fine to an agency and useless to a
 * dentist. One persona cannot surface those.
 */
export interface Persona {
  trade: string;
  /** How they talk. Fed to the model so the complaint sounds like them, not like a QA report. */
  voice: string;
  /** The one thing that would make them unhappy about this kind of work. */
  caresAbout: string;
}

export const PERSONAS: Persona[] = [
  {
    trade: "a two-person dental practice",
    voice: "brisk, not technical, writes in short sentences, slightly suspicious of being overcharged",
    caresAbout: "whether the numbers are right and whether anything needs them to act this week",
  },
  {
    trade: "a six-person marketing agency",
    voice: "confident, uses industry shorthand, will forward this to their own client on Friday",
    caresAbout: "whether they can hand this to their client without editing it first",
  },
  {
    trade: "a solo plumber with a van and a phone",
    voice: "blunt, one line at a time, reads on a phone between jobs",
    caresAbout: "whether it is obvious in ten seconds what this means and what it costs",
  },
];

const SYSTEM = `You are a real small-business owner looking at work a service provider has just sent you.

You are NOT a QA tester. You do not review software. You do not know or care how any of it was
made — words like harness, run, endpoint, schema or agent mean nothing to you and would themselves
be a reason to be confused.

You are busy. You are looking at this for about ninety seconds, on whatever device is nearest.

Judge ONE thing above all: is this what I am paying for?

If you are unhappy, name exactly ONE thing — the thing you would actually put in a reply. Real
clients do not write nine-point reviews; they write "the VAT figure is for the wrong quarter" and
press send. Pick the thing that matters most, in your own voice.

Be fair. Work that is plain but correct and complete is GOOD work — do not mark it down for being
unglamorous. Mark it down for being wrong, incomplete, confusing, or for asking you to do the job
you outsourced.

Answer as strict JSON and nothing else:
{"meetsStandard": boolean, "addressesObjection": boolean | null, "complaint": string | null}

"addressesObjection" is null unless you are told you raised something last time. If you were, it is
the single most important question: did they fix the thing I said? Answer that on what you can see,
not on whether the new version looks nicer. A prettier version that ignores you is worse than a
plain one that listens.`;

/** The situation, written the way the client would experience it. */
export function briefing(persona: Persona, memory: Memory, got: Received, seen: Seen): string {
  const open = openObjection(memory);
  const lines: string[] = [];

  lines.push(`You run ${persona.trade}. You are ${persona.voice}.`);
  lines.push(`What you care about most: ${persona.caresAbout}.`);
  lines.push("");

  if (memory.seen.length === 0) {
    lines.push("This is the FIRST thing they have sent you since you hired them.");
  } else {
    lines.push(`This is version ${got.version}. You have seen ${memory.seen.length} version(s) before.`);
  }

  if (open) {
    // Stated as bluntly as possible, because this is the question the whole simulation exists for
    // and a model given it in passing will answer it in passing.
    lines.push("");
    lines.push(`LAST TIME YOU TOLD THEM: "${open.text}"`);
    lines.push(`That was on version ${open.version}. THE MAIN QUESTION NOW IS WHETHER THEY FIXED IT.`);
    if (open.ignoredCount > 0) {
      lines.push(`You have already had to say it ${open.ignoredCount + 1} time(s). You are losing confidence.`);
    }
  }

  const days = Math.floor(got.waitedHours / 24);
  if (days >= 1) lines.push("", `You waited ${days} day(s) for this.`);

  if (seen.openAsks.length) {
    // The first impression is often homework, not work, and no text-only judgement can see that.
    lines.push("");
    lines.push(`Before you can even see the work, they are asking you for ${seen.openAsks.length} thing(s):`);
    for (const a of seen.openAsks.slice(0, 5)) lines.push(`  - ${a}`);
  }

  lines.push("");
  lines.push(seen.files.length ? `Files attached: ${seen.files.join(", ")}` : "NO FILES ARE ATTACHED.");
  lines.push("");
  lines.push("What they wrote:");
  lines.push(seen.body.trim() || "(they sent nothing you can read)");

  if (seen.portalShot || seen.artifactShot) {
    lines.push("");
    lines.push(
      `Attached image(s): ${[seen.portalShot && "the page as it looks to you", seen.artifactShot && "the document itself"]
        .filter(Boolean)
        .join(", ")}. Judge what you SEE, not what it claims.`,
    );
  }

  return lines.join("\n");
}

/**
 * Parse the model's answer into a `Judgement`, refusing to guess.
 *
 * ═══ WHY AN UNPARSEABLE ANSWER IS `meetsStandard: false` ═══
 *
 * The tempting default is to treat a broken response as approval and move on, so a flaky model does
 * not fail the run. That makes the simulation lie in the flattering direction — the one this whole
 * session has been removing — and worse, it makes it lie SILENTLY at exactly the moments the model
 * was confused, which are the interesting ones. A judgement we could not read is not a pass.
 */
export function parseJudgement(raw: string): Judgement {
  const text = String(raw ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { meetsStandard: false, complaint: "the client could not make sense of what arrived" };
  }
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const meets = o.meetsStandard === true;
    const addresses = typeof o.addressesObjection === "boolean" ? o.addressesObjection : undefined;
    const complaint = typeof o.complaint === "string" && o.complaint.trim() ? o.complaint.trim() : undefined;
    // A dissatisfied client who names nothing is not usable feedback, and letting it through would
    // produce objections the business cannot act on — which then look like the business ignoring
    // them on the next round. Fabricating the complaint here would be worse; naming the gap is honest.
    if (!meets && !complaint) {
      return { meetsStandard: false, addressesObjection: addresses, complaint: "this is not what we agreed" };
    }
    return { meetsStandard: meets, addressesObjection: addresses, complaint };
  } catch {
    return { meetsStandard: false, complaint: "the client could not make sense of what arrived" };
  }
}

/** Look at what arrived and decide what you think of it. */
export async function judge(args: {
  persona: Persona;
  memory: Memory;
  got: Received;
  seen: Seen;
  vision: Vision;
}): Promise<Judgement> {
  const images = [args.seen.portalShot, args.seen.artifactShot].filter((b): b is Buffer => !!b);
  const raw = await args
    .vision({ system: SYSTEM, user: briefing(args.persona, args.memory, args.got, args.seen), images })
    .catch((e) => `MODEL ERROR: ${e?.message ?? e}`);
  return parseJudgement(raw);
}
