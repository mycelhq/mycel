// The certificate of completion — the page a dispute is actually argued over.
//
// A signature that cannot be shown to a third party is a row in a database. This is the artifact
// that makes it evidence: who signed, when, from where, what they typed, which bytes they were
// looking at, and whether the record has been touched since.
//
// ═══ IT LOOKED LIKE A PRINTED WEB PAGE, AND THAT COST IT ═══
//
// The first version was correct and read as a blog post: a flowing column of left-aligned text,
// hairline rules, everything at one weight. Every fact was on it. It did not look like an
// instrument, and the founder said so — "it feels like an HTML print page".
//
// That is not a cosmetic complaint about a document whose entire job is to be believed by a
// stranger. A general counsel skimming this decides in about four seconds whether it is a real
// record or a screenshot of a dashboard, and they decide on SHAPE before reading a word. Legal
// paper has a specific one, and each part of it earns its place:
//
//   · A MASTHEAD BAND, so the document names itself before it says anything.
//   · A BORDERED RECORD BLOCK — reference, status, file — because a record is IDENTIFIED before it
//     is described. This is the part a filing system reads.
//   · SIGNATURE PANELS, one bordered block per party, each self-contained. On paper a signature
//     block is a box; a signature that flows into the next paragraph is a web page.
//   · A RULED TABLE for the trail, with a header row. A log is columns, not sentences, and columns
//     are what let a reader find the row they care about without reading the others.
//   · A FOOTER BAND, so a sheet separated from its file is still identifiable.
//
// ═══ IT IS ITS OWN TEMPLATE RATHER THAN A REPORT WITH BLOCKS ═══
//
// `reportScenes` could lay this out — a fields block, a table, some paragraphs. That was the first
// attempt and it is wrong for one reason: a certificate has a FIXED structure that must not vary,
// and a report is a container for whatever the caller assembled. The day somebody renders one with
// the trail left out, the report template will happily lay out the result and it will look correct.
// Here, leaving out the trail means deleting a section of this file.
//
// ═══ TWO THINGS ARE SET APART AND THEY ARE THE ONLY TWO THAT MATTER ═══
//
// The document hash and each signer's hash. Everything else is a claim a person makes; those two
// are the claim the mathematics makes, and they are the pair a reader compares by eye. So the
// document hash gets its own bordered field, printed in full rather than truncated, and a mismatch
// is stated in words beside the signature rather than left for the reader to notice.
//
// ═══ A BROKEN CHAIN IS PRINTED, NOT SUPPRESSED ═══
//
// `certificate()` in signing.ts derives its verdict from `verifyChain`, and this template renders
// whatever it was handed. A certificate that renders a clean page over a tampered log is worse than
// no certificate: it is a document that asserts something false with our name on it.
import type { BrandKit } from "../brandkit";
import type { Certificate } from "../signing";
import { as, designFor, type TypeRole } from "./design";
import { fontFor, textWidth, truncateToWidth } from "./fonts";
import { wrapText } from "./report";
import { A4, SceneBuilder, tint, type Scene } from "./scene";

export interface CertificateDocumentInput {
  certificate: Certificate;
  /** Shown in the record block, so the page names the engagement and not just the file. */
  reference?: string;
}

/**
 * ISO → "30 August 2026, 16:42 UTC". A certificate is read by people, in a timezone they can name.
 *
 * `short` gives "30 Aug 2026, 16:42 UTC" for the trail table, where three columns share a line. The
 * month is the only thing abbreviated and the TIME is never dropped: a history whose timestamps are
 * truncated is a history, not evidence, and the first version of this page truncated exactly that.
 */
function stamp(iso: string | undefined, short = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const full = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][d.getUTCMonth()]!;
  const month = short ? full.slice(0, 3) : full;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const STATUS_WORDS: Record<string, string> = {
  executed: "Fully executed",
  partially_signed: "Awaiting a signature",
  sent: "Out for signature",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
  draft: "Not sent",
};

const DANGER = "#b91c1c";

export function certificateScene(input: CertificateDocumentInput, kit: BrandKit): Scene {
  const c = input.certificate;
  const b = new SceneBuilder(A4.width, A4.height);
  /**
   * EVERY SIZE COMES FROM A ROLE.
   *
   * The first version picked its own numbers and `taste.ts` refused it three times over — eight
   * distinct sizes on one page, 7.5 and 8 both present with nobody able to see the difference, and
   * twenty-six unbroken body lines. That it caught its own author on the page whose subject is
   * rigour is the argument for having built design.ts as a system rather than a house style.
   */
  const d = designFor(kit, { base: 9, page: A4 });
  const S = d.surface;
  const M = d.page.margin;
  const RIGHT = d.right;
  let y = 0;

  const put = (
    x: number,
    baseline: number,
    t: string,
    role: TypeRole,
    over: Parameters<typeof as>[1] = {},
    anchor: "start" | "end" = "start",
  ) => {
    const r = as(role, over);
    b.text({
      x,
      y: baseline,
      text: t,
      size: r.size,
      family: r.family,
      weight: r.weight,
      fill: r.fill,
      anchor,
      ...(r.tracking ? { tracking: r.tracking } : {}),
    });
  };

  /**
   * `y` IS THE TOP OF THE LINE BOX, never the baseline.
   *
   * Every collision the linter found on the first version was a gap chosen in rhythm units, which
   * does not know how tall the line below it is. This is the rule that makes overlap impossible
   * rather than unlikely.
   */
  const line = (t: string, role: TypeRole, over: Parameters<typeof as>[1] = {}, extra = 0, x = M): void => {
    put(x, y + role.size, t, role, over);
    y += role.leading + d.space(extra);
  };
  /** Set on the CURRENT row without advancing it — for the second and third columns. */
  const at = (
    x: number,
    t: string,
    role: TypeRole,
    row: TypeRole,
    over: Parameters<typeof as>[1] = {},
    anchor: "start" | "end" = "start",
  ) => put(x, y + row.size, t, role, over, anchor);

  const capFont = fontFor(d.role.caption.family, "normal");
  const widest = (xs: string[], font = capFont) =>
    xs.reduce((w, t) => Math.max(w, textWidth(t, font, d.role.caption.size)), 0);

  /**
   * A bordered block. What makes a record look filed rather than published.
   *
   * FOUR LINES, not a stroked rect: `RectNode` is fill-only, deliberately — the scene is a
   * four-primitive vocabulary, and adding a stroke to it would mean touching both emitters for the
   * sake of one template. A border is four lines, which the vocabulary already has.
   */
  const panel = (top: number, height: number, fill?: string) => {
    if (fill) b.rect({ x: M, y: top, w: d.content, h: height, fill, rx: 2 });
    const w = 0.8;
    b.line({ x1: M, y1: top, x2: RIGHT, y2: top, stroke: S.hairline, width: w });
    b.line({ x1: M, y1: top + height, x2: RIGHT, y2: top + height, stroke: S.hairline, width: w });
    b.line({ x1: M, y1: top, x2: M, y2: top + height, stroke: S.hairline, width: w });
    b.line({ x1: RIGHT, y1: top, x2: RIGHT, y2: top + height, stroke: S.hairline, width: w });
  };

  /** A section label sitting on its own rule — the eyebrow, given something to belong to. */
  const heading = (label: string): void => {
    y += d.space(2.4);
    put(M, y + d.role.eyebrow.size, label, d.role.eyebrow, { fill: S.faint });
    const ruleY = y + d.role.eyebrow.leading;
    b.line({ x1: M, y1: ruleY, x2: RIGHT, y2: ruleY, stroke: S.hairline, width: 0.8 });
    y = ruleY + d.space(1.6);
  };

  // ── masthead ────────────────────────────────────────────────────────────────────────────────
  //
  // A BAND, not a hairline. The first thing a reader's eye lands on should say what kind of object
  // this is before they read a word of it.
  const bandH = d.space(4.5);
  b.rect({ x: 0, y: 0, w: A4.width, h: bandH, fill: kit.accent });
  put(M, bandH * 0.66, kit.display_name.toUpperCase(), d.role.micro, { fill: "#ffffff", tracking: 1.1 });
  put(RIGHT, bandH * 0.66, "CERTIFICATE OF COMPLETION", d.role.micro, { fill: "#ffffff", tracking: 1.1 }, "end");

  y = bandH + d.space(3);
  for (const l of wrapText(c.title, d.role.display.family, "bold", d.role.display.size, d.content).slice(0, 2)) {
    line(l, d.role.display);
  }
  y += d.space(1.2);

  // ── the record block ────────────────────────────────────────────────────────────────────────
  const executed = c.status === "executed";
  const bad = c.status === "declined" || c.status === "voided";
  const rows: [string, string][] = [
    ["Reference", c.envelope_id],
    ["Status", STATUS_WORDS[c.status] ?? c.status],
    ["Document", c.document.filename],
    ["Size", `${(c.document.size_bytes / 1024).toFixed(1)} KB`],
  ];
  if (input.reference) rows.splice(1, 0, ["Engagement", input.reference]);

  const rowH = d.role.small.leading + d.space(0.9);
  const recordTop = y;
  panel(recordTop, rows.length * rowH + d.space(1.6), S.panel);
  y = recordTop + d.space(0.8);
  const labelX = M + d.space(2);
  const valueX = M + d.space(15);
  rows.forEach(([k, v], i) => {
    if (i > 0) {
      const r = y - d.space(0.45);
      b.line({ x1: labelX, y1: r, x2: RIGHT - d.space(2), y2: r, stroke: S.hairline, width: 0.5 });
    }
    at(labelX, k, d.role.caption, d.role.small, { fill: S.faint });
    const isStatus = k === "Status";
    at(
      valueX,
      truncateToWidth(v, fontFor(d.role.small.family, isStatus ? "bold" : "normal"), d.role.small.size, RIGHT - valueX - d.space(2)),
      d.role.small,
      d.role.small,
      isStatus ? { weight: "bold", fill: executed ? kit.accent : bad ? DANGER : S.ink } : {},
    );
    y += rowH;
  });
  y = recordTop + rows.length * rowH + d.space(1.6);

  // ── the fingerprint ─────────────────────────────────────────────────────────────────────────
  //
  // Its own field, because it is the only thing on the page a reader is expected to COMPARE rather
  // than read. In full, in two halves. A truncated hash is a hash nobody can check, which is the
  // only thing this line is for.
  heading("DOCUMENT FINGERPRINT · SHA-256");
  const hashTop = y;
  const hashH = d.role.small.leading * 2 + d.space(2);
  panel(hashTop, hashH);
  y = hashTop + d.space(1);
  line(c.document.sha256.slice(0, 32), d.role.small, {}, 0, M + d.space(2));
  line(c.document.sha256.slice(32), d.role.small, {}, 0, M + d.space(2));
  y = hashTop + hashH;

  // ── signatures ──────────────────────────────────────────────────────────────────────────────
  heading("SIGNATURES");
  for (const s2 of c.signers) {
    const signed = s2.status === "signed";
    const facts: [string, string][] = signed
      ? [
          ["Signed", stamp(s2.signed_at)],
          // Its own row: the whole point of consent under ESIGN §101(c) is that it is a separate act
          // at a separate moment, and a certificate that merges them is asserting less than it can.
          ["Consented", stamp(s2.consented_at)],
          ["Typed", s2.typed_name ?? "—"],
          ["From", s2.ip ?? "not recorded"],
        ]
      : [];
    const factRow = d.role.caption.leading + d.space(0.35);
    const markH = s2.drawn_png ? d.space(6.4) + d.space(1) + d.role.micro.leading : 0;
    const blockH =
      d.space(1.2) +
      d.role.subhead.leading +
      d.role.caption.leading +
      d.space(0.6) +
      facts.length * factRow +
      (signed ? d.role.caption.leading + d.space(0.8) : 0) +
      markH +
      d.space(1.2);

    const top = y;
    panel(top, blockH);
    y = top + d.space(1.2);

    at(M + d.space(2), s2.name, d.role.subhead, d.role.subhead);
    at(
      RIGHT - d.space(2),
      signed ? "SIGNED" : s2.status === "declined" ? "DECLINED" : "NOT YET SIGNED",
      d.role.micro,
      d.role.subhead,
      { fill: signed ? kit.accent : S.faint, tracking: 0.9 },
      "end",
    );
    y += d.role.subhead.leading;
    at(
      M + d.space(2),
      `${s2.email} · ${s2.role === "provider" ? "for the provider" : "for the client"}`,
      d.role.caption,
      d.role.caption,
      { fill: S.muted },
    );
    y += d.role.caption.leading + d.space(0.6);

    // MEASURED. "Consented" is the widest label here and a column guessed in rhythm units ran its
    // value straight through it — the same class of collision this file has already paid for twice.
    const factValueX = M + d.space(2) + widest(facts.map(([k]) => k)) + d.space(2);
    for (const [k, v] of facts) {
      at(M + d.space(2), k, d.role.caption, d.role.caption, { fill: S.faint });
      at(
        factValueX,
        truncateToWidth(v, capFont, d.role.caption.size, RIGHT - factValueX - d.space(2)),
        d.role.caption,
        d.role.caption,
      );
      y += factRow;
    }

    if (signed) {
      // SAID IN WORDS, not left as two hex strings to compare. A reader asked to diff those by eye
      // is a reader who will assume they match.
      at(
        M + d.space(2),
        s2.hash_matches
          ? `Signed the document above · ${(s2.document_sha256 ?? "").slice(0, 24)}`
          : `DOES NOT MATCH the executed document · ${(s2.document_sha256 ?? "").slice(0, 24)}`,
        d.role.caption,
        d.role.caption,
        { weight: "bold", fill: s2.hash_matches ? kit.accent : DANGER },
      );
      y += d.role.caption.leading + d.space(0.8);
    }

    /**
     * THE MARK, WHEN ONE WAS DRAWN.
     *
     * It adds nothing to the legal test — the typed name is the affirmative act. What it adds is
     * weight with a HUMAN audience, and it only does that if it is presented the way a signature is
     * presented on paper: sitting on a ruled line with a caption beneath. Floating in a column of
     * key-value pairs it reads as one more field.
     */
    if (s2.drawn_png) {
      const h = d.space(6.4);
      const w = Math.min(d.content * 0.4, h * 3.2);
      const x = M + d.space(2);
      b.image({ x, y, w, h, mime: "image/png", data: s2.drawn_png });
      b.line({ x1: x, y1: y + h + 1.5, x2: x + w, y2: y + h + 1.5, stroke: S.ink, width: 0.8 });
      y += h + d.space(1);
      at(x, `Drawn by hand · ${(s2.drawn_sha256 ?? "").slice(0, 20)}`, d.role.micro, d.role.micro, { fill: S.faint });
      y += d.role.micro.leading;
    }

    y = top + blockH + d.space(1.2);
  }

  // ── the trail ───────────────────────────────────────────────────────────────────────────────
  //
  // Columns MEASURED against the widest thing that goes in them, not chosen in rhythm units.
  // Guessing produced "30 August 2026, 16:…" and "Sent for signat…" — a history nobody can read.
  heading("AUDIT TRAIL");
  const WHAT_X = M + widest(c.events.map((e) => stamp(e.at, true))) + d.space(2.2);
  const WHO_X = WHAT_X + widest(c.events.map((e) => e.what), fontFor(d.role.caption.family, "bold")) + d.space(2.2);

  at(M, "WHEN", d.role.micro, d.role.micro, { fill: S.faint, tracking: 0.7 });
  at(WHAT_X, "EVENT", d.role.micro, d.role.micro, { fill: S.faint, tracking: 0.7 });
  at(WHO_X, "DETAIL", d.role.micro, d.role.micro, { fill: S.faint, tracking: 0.7 });
  y += d.role.micro.leading + d.space(0.5);
  b.line({ x1: M, y1: y, x2: RIGHT, y2: y, stroke: S.hairline, width: 0.8 });
  y += d.space(0.9);

  const rule = tint(S.hairline, 0.45);
  for (const e of c.events) {
    if (y > A4.height - d.space(22)) break; // the tail is on the chain; the page is not the record
    at(M, stamp(e.at, true), d.role.caption, d.role.caption, { fill: S.muted });
    at(WHAT_X, e.what, d.role.caption, d.role.caption, { weight: "bold" });
    at(
      WHO_X,
      truncateToWidth(`${e.who} — ${e.detail}`, capFont, d.role.caption.size, RIGHT - WHO_X),
      d.role.caption,
      d.role.caption,
      { fill: S.muted },
    );
    y += d.role.caption.leading + d.space(0.55);
    b.line({ x1: M, y1: y - d.space(0.2), x2: RIGHT, y2: y - d.space(0.2), stroke: rule, width: 0.4 });
  }

  // ── the verdict ─────────────────────────────────────────────────────────────────────────────
  //
  // The sentence the whole file exists to be able to print, given the weight of a filled block with
  // a rule down its edge rather than a line of text at the bottom of a column.
  const boxH = d.role.subhead.leading + d.role.caption.leading + d.space(3);
  /**
   * FLOWS AFTER THE TRAIL, and does not sit on the bottom margin.
   *
   * Pinning it there left a hand-sized hole in the middle of a short certificate — which is the
   * shape of a web page whose footer is `position: fixed`, and the exact tell this redesign is
   * about. Legal paper flows: blocks follow one another and the page ends where the content does.
   *
   * The floor is still respected. A certificate with twelve signers pushes this down until it would
   * collide with the footer band, and then it stops — the trail truncates above it, which is the
   * right thing to lose because the chain holds the tail anyway.
   */
  const boxY = Math.min(y + d.space(2.6), A4.height - M - boxH - d.space(2.6));
  b.rect({ x: M, y: boxY, w: d.content, h: boxH, fill: c.chain.ok ? S.accentWash : "#fef2f2", rx: 2 });
  b.rect({ x: M, y: boxY, w: d.space(0.6), h: boxH, fill: c.chain.ok ? kit.accent : DANGER });
  y = boxY + d.space(1.2);
  line(
    c.chain.ok ? "This record is intact." : "THIS RECORD HAS BEEN ALTERED.",
    d.role.subhead,
    { fill: c.chain.ok ? S.ink : DANGER },
    0,
    M + d.space(2.4),
  );
  line(
    c.chain.ok
      ? `Every entry is chained to the one before it, and all ${c.chain.checked} verify.`
      : `The chain breaks at entry ${c.chain.broken_at ?? "?"} of ${c.chain.checked}. Do not rely on this document.`,
    d.role.caption,
    { fill: c.chain.ok ? S.muted : DANGER },
    0,
    M + d.space(2.4),
  );

  // ── footer band ─────────────────────────────────────────────────────────────────────────────
  //
  // Ruled and on the page rather than floating under it, so a sheet separated from its file is
  // still identifiable.
  const footY = A4.height - M - d.space(0.4);
  b.line({ x1: M, y1: footY, x2: RIGHT, y2: footY, stroke: S.hairline, width: 0.8 });
  put(M, A4.height - M + d.space(1.6), `${c.envelope_id} · ${kit.display_name}`, d.role.micro, { fill: S.faint });
  put(RIGHT, A4.height - M + d.space(1.6), stamp(new Date().toISOString()), d.role.micro, { fill: S.faint }, "end");

  return b.done(`Certificate of completion — ${c.title}`);
}
