// The proposal — the document a client signs.
//
// ═══ IT IS BUILT FROM THE STRUCTURED OUTPUT, NOT FROM PROSE ═══
//
// Every other document in this directory is laid out from `ReportBlock[]` that `blocksFromMarkdown`
// derived from something a model wrote. This one is not, and the reason is that the model's words
// are not the thing being signed — the SCOPE, the PRICE and the TERM are, and those are fields that
// `ship_checks` already verified.
//
// Rendering a proposal from prose would mean the price on the page came from a sentence, while the
// price the gate checked came from a number, and nothing would notice when they disagreed. Here the
// page can only show what passed the gate: `price_minor` is the one that gets formatted, and there
// is nowhere for a second one to come from.
//
// ═══ WHAT WAS SAID ON THE CALL IS ON THE PAGE ═══
//
// Each scope line carries `said` — the thing from the transcript that put it there — and it is
// PRINTED, not just collected. Two reasons, and the second is the real one:
//
//   · A client reading their own words recognises the conversation and signs. A client reading a
//     generic capability list wonders whether we were listening.
//   · The founder reviewing the draft can see, line by line, whether the model read the call or
//     invented a plausible engagement. Collecting the quote and hiding it would leave them approving
//     a document whose provenance they cannot check — which is the failure the field exists for.
//
// ═══ THE MONEY IS FORMATTED ONCE ═══
//
// From `price_minor` through `formatMoney`, the same function the invoice uses. Read the MONEY
// comment on `Invoice` in contract.ts: nothing here divides, and a proposal and the invoice that
// follows it must never disagree about what a client agreed to pay.
import type { BrandKit } from "../brandkit";
import { as, designFor, type TypeRole } from "./design";
import { fontFor, textWidth, truncateToWidth } from "./fonts";
import { formatMoney } from "./money";
import { A4, SceneBuilder, type Scene } from "./scene";

export interface ProposalScopeLine {
  what: string;
  /** What was said on the call that put this line here. Printed — see the header. */
  said?: string;
}

/**
 * Two rounds, stated on the paper.
 *
 * Mirrored from `INCLUDED_CHANGE_ROUNDS` in signing.ts rather than imported, because this directory
 * is a pure renderer with no dependency on the signing store — and a template that reached into the
 * envelope layer for a number would be a template that cannot be tested without one.
 *
 * The two must agree. `signing.test.ts` asserts it, which is cheaper than the coupling.
 */
export const PROPOSAL_CHANGE_ROUNDS = 2;

export interface ProposalDocumentInput {
  /** Who it is for. The client's own name, as they gave it. */
  client: string;
  headline: string;
  scope: ProposalScopeLine[];
  out_of_scope?: string[];
  price_minor: number;
  currency: string;
  cadence?: "one_off" | "monthly" | "quarterly";
  term_months?: number;
  starts?: string;
  assumptions?: string[];
  from_client?: string[];
  /** Reference shown in the footer, so the paper and the engagement can be tied together. */
  reference?: string;
  /** 1 for the first attempt. Printed, so both sides know which paper they are discussing. */
  revision?: number;
  prepared_on?: string;
}

const CADENCE: Record<string, string> = {
  one_off: "one-off",
  monthly: "per month",
  quarterly: "per quarter",
};

export function proposalScene(input: ProposalDocumentInput, kit: BrandKit): Scene {
  const b = new SceneBuilder(A4.width, A4.height);
  const d = designFor(kit, { base: 10, page: A4 });
  const S = d.surface;
  const M = d.page.margin;
  const RIGHT = d.right;
  let y = 0;

  const put = (x: number, baseline: number, t: string, role: TypeRole, over: Parameters<typeof as>[1] = {}, anchor: "start" | "end" = "start") => {
    const r = as(role, over);
    b.text({ x, y: baseline, text: t, size: r.size, family: r.family, weight: r.weight, fill: r.fill, anchor, ...(r.tracking ? { tracking: r.tracking } : {}) });
  };
  /**
   * `y` IS THE TOP OF THE LINE BOX, never the baseline.
   *
   * The certificate template was written the other way and the linter found four collisions in it,
   * each one a gap chosen in rhythm units that did not know how tall the line below it was. This is
   * the rule that makes overlap impossible rather than unlikely.
   */
  const line = (t: string, role: TypeRole, over: Parameters<typeof as>[1] = {}, extra = 0, x = M): void => {
    put(x, y + role.size, t, role, over);
    y += role.leading + d.space(extra);
  };
  const rightOf = (t: string, role: TypeRole, row: TypeRole, over: Parameters<typeof as>[1] = {}): void =>
    put(RIGHT, y + row.size, t, role, over, "end");
  /**
   * A section label sitting on its own rule, matching the certificate.
   *
   * Four lines for the border rather than a stroked rect: `RectNode` is fill-only, deliberately —
   * the scene is a four-primitive vocabulary and a border is four lines.
   */
  const panel = (top: number, height: number, fill?: string) => {
    if (fill) b.rect({ x: M, y: top, w: d.content, h: height, fill, rx: 2 });
    const w = 0.8;
    b.line({ x1: M, y1: top, x2: RIGHT, y2: top, stroke: S.hairline, width: w });
    b.line({ x1: M, y1: top + height, x2: RIGHT, y2: top + height, stroke: S.hairline, width: w });
    b.line({ x1: M, y1: top, x2: M, y2: top + height, stroke: S.hairline, width: w });
    b.line({ x1: RIGHT, y1: top, x2: RIGHT, y2: top + height, stroke: S.hairline, width: w });
  };
  const section = (label: string): void => {
    y += d.space(2.4);
    put(M, y + d.role.eyebrow.size, label, d.role.eyebrow, { fill: S.faint });
    const ruleY = y + d.role.eyebrow.leading;
    b.line({ x1: M, y1: ruleY, x2: RIGHT, y2: ruleY, stroke: S.hairline, width: 0.8 });
    y = ruleY + d.space(1.6);
  };
  /**
   * Wrap to the content width, so a long line is set rather than cut.
   *
   * MEASURED IN THE WEIGHT IT WILL BE DRAWN IN. The first version took the base role and the caller
   * passed `{ weight: "bold" }` separately, so every bold line was measured in the regular face and
   * set in the bold one — and bold is wider. The scope lines ran 35pt past the right margin, inside
   * the page (so `off-page` never fired) and outside the text block, which is the kind of wrong
   * that looks like a rendering glitch to a client.
   */
  const wrapped = (t: string, role: TypeRole, x: number, width: number, over: Parameters<typeof as>[1] = {}): string[] => {
    const eff = as(role, over);
    const font = fontFor(eff.family, eff.weight);
    const words = t.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (textWidth(next, font, eff.size) > width && cur) {
        out.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };
  const para = (t: string, role: TypeRole, over: Parameters<typeof as>[1] = {}, x = M, extra = 0): void => {
    for (const l of wrapped(t, role, x, RIGHT - x, over)) line(l, role, over, 0, x);
    y += d.space(extra);
  };

  /**
   * A MASTHEAD BAND, matching the certificate.
   *
   * These two documents arrive together — the proposal to read and the certificate that records
   * signing it — and a client who receives one styled as a legal instrument and the other as a blog
   * post has been told, accurately, that only one of them was taken seriously.
   *
   * The proposal is the document that has to be BELIEVED before it is signed, so it carries the same
   * furniture: a band that names it, a bordered terms block, ruled sections.
   */
  const bandH = d.space(4);
  b.rect({ x: 0, y: 0, w: A4.width, h: bandH, fill: kit.accent });
  put(M, bandH * 0.66, kit.display_name.toUpperCase(), d.role.micro, { fill: "#ffffff", tracking: 1.1 });
  put(
    RIGHT,
    bandH * 0.66,
    // The revision is IN THE MASTHEAD, not a footnote. Two people arguing about a price while
    // looking at different drafts is the single most expensive confusion in a negotiation, and it
    // costs one word to prevent.
    (input.revision ?? 1) > 1 ? `PROPOSAL · REVISION ${input.revision}` : "PROPOSAL",
    d.role.micro,
    { fill: "#ffffff", tracking: 1.1 },
    "end",
  );

  y = bandH + d.space(3);
  para(input.headline, d.role.display, {}, M, 0.4);
  line(`Prepared for ${input.client}`, d.role.small, { fill: S.muted }, 1.2);

  // ── the price, first ──────────────────────────────────────────────────────────────────────────
  //
  // ABOVE the scope, deliberately. A client opening a proposal is looking for one number and will
  // scroll until they find it; putting the scope first does not make them read the scope, it makes
  // them skim it on the way to the price and then read it afterwards with the number in mind.
  /**
   * THE TERMS, IN A BORDERED BLOCK — price, cadence, term and start date together.
   *
   * They were four separate lines of prose. A client deciding whether to sign is answering four
   * questions and they are these four; presenting them as a block is what lets somebody photograph
   * this section and send it to their partner, which is what actually happens.
   */
  const money = formatMoney(input.price_minor, input.currency);
  const cadence = input.cadence && input.cadence !== "one_off" ? ` ${CADENCE[input.cadence]}` : "";
  const termsTop = y;
  const termRow = d.role.small.leading + d.space(0.9);
  const terms: [string, string][] = [
    ["Price", `${money}${cadence}`],
    ...(input.term_months ? ([["Term", `${input.term_months} months`]] as [string, string][]) : []),
    ...(input.cadence === "one_off" ? ([["Basis", "One-off"]] as [string, string][]) : []),
    ...(input.starts ? ([["Work starts", input.starts]] as [string, string][]) : []),
  ];
  panel(termsTop, terms.length * termRow + d.space(1.6), S.panel);
  y = termsTop + d.space(0.8);
  const tLabelX = M + d.space(2);
  const tValueX = M + d.space(14);
  terms.forEach(([k, v], i) => {
    if (i > 0) {
      const r = y - d.space(0.45);
      b.line({ x1: tLabelX, y1: r, x2: RIGHT - d.space(2), y2: r, stroke: S.hairline, width: 0.5 });
    }
    put(tLabelX, y + d.role.small.size, k, d.role.caption, { fill: S.faint });
    // The price is the number they came for, so it is the one thing set in the accent and in the
    // heavier role. Everything else in this block is a fact about it.
    put(
      tValueX,
      y + d.role.small.size,
      v,
      i === 0 ? d.role.subhead : d.role.small,
      i === 0 ? { fill: kit.accent } : {},
    );
    y += i === 0 ? Math.max(termRow, d.role.subhead.leading + d.space(0.6)) : termRow;
  });
  y = Math.max(y, termsTop + terms.length * termRow) + d.space(1.6);

  // ── scope ─────────────────────────────────────────────────────────────────────────────────────
  section("WHAT WE WILL DO");
  for (const s of input.scope) {
    b.rect({ x: M, y: y + d.space(0.4), w: d.space(0.7), h: d.space(0.7), fill: kit.accent, rx: 1 });
    para(s.what, d.role.small, { weight: "bold" }, M + d.space(2));
    if (s.said) {
      // THE QUOTE, set as a quote. Indented under the line it justifies and in the muted ink, so it
      // reads as evidence for the line above rather than as more scope.
      for (const l of wrapped(`“${s.said}”`, d.role.caption, M + d.space(2.5), RIGHT - M - d.space(2.5))) {
        line(l, d.role.caption, { fill: S.muted }, 0, M + d.space(2.5));
      }
    }
    y += d.space(1);
  }

  // ── what it does not include ──────────────────────────────────────────────────────────────────
  if (input.out_of_scope?.length) {
    section("WHAT THIS DOES NOT INCLUDE");
    for (const t of input.out_of_scope) para(`· ${t}`, d.role.small, { fill: S.muted }, M + d.space(1));
  }

  if (input.from_client?.length) {
    section("WHAT WE NEED FROM YOU");
    for (const t of input.from_client) para(`· ${t}`, d.role.small, {}, M + d.space(1));
  }

  if (input.assumptions?.length) {
    section("WHAT THIS ASSUMES");
    for (const t of input.assumptions) para(`· ${t}`, d.role.caption, { fill: S.muted }, M + d.space(1));
  }

  /**
   * THE REVISION ALLOWANCE, ON THE PAPER.
   *
   * Every real statement of work says this, and it is the sentence that makes the third round of
   * changes a conversation rather than an argument. A limit the client agreed to in writing is a
   * limit; a limit they meet when a button disappears is a grievance.
   *
   * Stated as an inclusion rather than a restriction — "two rounds are included" is what they are
   * getting, and it is also, exactly, the boundary.
   */
  section("CHANGES");
  para(
    `Two rounds of changes to this proposal are included. Ask for anything you want moved and we will send a new one. Past that we will get you on a call, which is faster than a third draft.`,
    d.role.caption,
    { fill: S.muted },
    M + d.space(1),
  );

  // ── the signature note ────────────────────────────────────────────────────────────────────────
  //
  // The page says how it is signed, because a client who is about to type their name into a web
  // page is entitled to know beforehand that this is what signing will mean.
  const boxH = d.role.small.leading + d.role.caption.leading + d.space(3);
  /**
   * FLOWS AFTER THE TERMS, and does not sit on the bottom margin.
   *
   * Pinning it there left a hand-sized hole in the middle of a short proposal, which is the shape of
   * a web page with a fixed footer and the exact tell this redesign is about. It still respects the
   * floor: a long proposal pushes it down until it would meet the footer band, and then it stops.
   */
  const boxY = Math.min(y + d.space(2.6), A4.height - M - boxH - d.space(2.6));
  {
    b.rect({ x: M, y: boxY, w: d.content, h: boxH, fill: S.panel, rx: 2 });
    // The accent edge, matching the certificate's verdict block. These two documents arrive
    // together and are read minutes apart.
    b.rect({ x: M, y: boxY, w: d.space(0.6), h: boxH, fill: kit.accent });
    y = boxY + d.space(1.2);
    line("To accept, open the link in the covering email and type your name.", d.role.small, { weight: "bold" }, 0, M + d.space(2));
    line(
      "Your name, the time, and this exact document are recorded together and both of us get a copy.",
      d.role.caption,
      { fill: S.muted },
      0,
      M + d.space(2),
    );
  }

  if (input.reference) {
    put(M, A4.height - M + d.space(1.5), truncateToWidth(input.reference, fontFor(d.role.micro.family, "normal"), d.role.micro.size, d.content * 0.6), d.role.micro, { fill: S.faint });
  }
  if (input.prepared_on) {
    put(RIGHT, A4.height - M + d.space(1.5), `Prepared ${input.prepared_on}`, d.role.micro, { fill: S.faint }, "end");
  }

  return b.done(`Proposal — ${input.client}`);
}
