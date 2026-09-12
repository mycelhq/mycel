/**
 * DID THE ARTEFACT ACTUALLY WEAR THE STYLE IT WAS GIVEN?
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE HALF OF THE HOUSE STYLE NOTHING CHECKED
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A delivering run is handed a design system's `tokens.css` — twenty-odd custom properties a
 * designer wrote — and told to paste the `:root` block into one `<style>`. Nothing then looked at
 * what came back. `lintArtifact` catches the seven tells that make a document read as machine-made
 * (a purple gradient, an indigo accent, emoji as icons), which is a floor and not a fidelity check:
 * an artefact can clear every one of those rules and still be a document that ignored the firm's
 * house style completely, in perfectly tasteful greys of its own choosing.
 *
 * That is opendesign's first critique dimension — REFERENCE FIDELITY, "does it honour a real system,
 * or is it generic" — and it is the one dimension our five-criterion review cannot see, because the
 * reviewer grades the readable TEXT and the style lives in the markup.
 *
 * It only became checkable when the pin did. Before `Deliverable.style` there was no answer to
 * "which system was this supposed to be in", so there was nothing to compare against. See
 * house-style.ts.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ONE FINDING BLOCKS, THE REST ADVISE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `tokens_ignored` is unambiguous: the run was handed a stylesheet and used none of it. Everything
 * else here is a judgement with a threshold, and a threshold that blocks is a threshold that will
 * one day cost a founder their Friday afternoon over a document that was fine. So the rest come
 * back as advice the agent is shown and can act on, on the same "halt the agent, never the human"
 * split `deliverable-review.ts` argues for its serious findings.
 *
 * PURE. HTML and a token block in, findings out. No network, no filesystem — the same property
 * `lintArtifact` has, and for the same reason.
 */

export interface FidelityFinding {
  code: "tokens_ignored" | "raw_hex" | "font_families" | "accent_overused" | "hierarchy";
  /** Only `tokens_ignored` blocks. See the header. */
  blocking: boolean;
  message: string;
  fix: string;
}

/** `--bg`, `--fg-2`, `--accent`. Names only — values are the system's business, not this check's. */
function declaredNames(tokensCss: string): Set<string> {
  const out = new Set<string>();
  for (const m of tokensCss.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]!);
  return out;
}

/** Everything inside `<style>`, comments stripped. Attribute styles are deliberately not included. */
function styleText(html: string): string {
  let css = "";
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += (m[1] ?? "") + "\n";
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Hex literals that are NOT inside a custom-property declaration.
 *
 * A hex on the right of `--surface: #fff` is the token being defined and is the correct place for
 * one. A hex in `background: #fff` is a value written past the token, which is what "the tokens were
 * not honoured" actually looks like in markup.
 */
function rawHexOutsideTokens(css: string): number {
  let n = 0;
  for (const decl of css.split(/[;{}]/)) {
    const t = decl.trim();
    if (!t || /^--[\w-]+\s*:/.test(t)) continue;
    n += [...t.matchAll(/#[0-9a-f]{3,8}\b/gi)].length;
  }
  return n;
}

export function styleFidelity(
  html: string,
  system: { id: string; tokens: string } | undefined,
): FidelityFinding[] {
  const out: FidelityFinding[] = [];
  const body = String(html ?? "");
  // No pin, or a system we no longer ship: nothing to be unfaithful TO. Silence is the honest
  // answer, and inventing a standard here would gate work against a look nobody chose.
  if (!system?.tokens?.trim() || !body.trim()) return out;

  const css = styleText(body);
  const declared = declaredNames(system.tokens);
  /**
   * USED, not merely declared. A run that pastes the `:root` block and then styles everything with
   * its own hexes has "the tokens" in the file and honoured none of them, which is the commonest
   * shape of this failure and the one a naive presence check would pass.
   */
  const used = [...declared].filter((name) => new RegExp(`var\\(\\s*${name}\\b`).test(css));

  /**
   * ═══ ONLY WHEN THE ARTEFACT ACTUALLY DRESSES ITSELF ═══
   *
   * The first version of this blocked `<h1>Hello client</h1>` — a fragment with no stylesheet at
   * all — and the existing suite caught it immediately. That is not a document that ignored the
   * house style; it is a document with no styling, which is a snippet, an email body, or a file that
   * inherits its look from wherever it is embedded. Refusing it would gate a whole class of
   * legitimate deliverables on a rule about a decision they never made.
   *
   * "Styled past the brand" needs BOTH halves: it chose colours or faces of its own, AND it used
   * none of the ones it was handed. Either alone is silence.
   */
  const dressesItself =
    /(^|[;{\s])(color|background|background-color|border-color|font-family)\s*:/i.test(css) ||
    /style\s*=\s*["'][^"']*(color|background|font)/i.test(body);

  if (declared.size > 0 && used.length === 0 && dressesItself) {
    out.push({
      code: "tokens_ignored",
      blocking: true,
      message:
        `None of the ${declared.size} design tokens for “${system.id}” are used anywhere in this ` +
        `artefact. The house style was mounted and the document was styled past it.`,
      fix:
        `Paste the \`:root\` block from the mounted \`tokens.css\` into one \`<style>\`, then style ` +
        `with \`var(--bg)\`, \`var(--fg)\`, \`var(--accent)\` and the rest instead of literal colours.`,
    });
  }

  /**
   * Twelve, matching the threshold `craft/anti-ai-slop.md` already states as a soft tell. Generous
   * on purpose: a chart needs a series palette, a table needs a zebra stripe, and a document with a
   * handful of one-off values is not a document that ignored its brand.
   */
  const raw = rawHexOutsideTokens(css);
  if (raw > 12) {
    out.push({
      code: "raw_hex",
      blocking: false,
      message: `${raw} literal colours are written past the tokens. Above about a dozen, the design system is decoration.`,
      fix: "Move the repeated ones into `:root` as tokens and reference them, or drop them for the system's own values.",
    });
  }

  /**
   * Two, from opendesign's craft dimension ("≤2 type families"). Counted as distinct FIRST families,
   * because `font-family: Inter, system-ui, sans-serif` is one choice with two fallbacks, and
   * counting the stack would fail every well-written declaration in existence.
   */
  const families = new Set<string>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = (m[1] ?? "").split(",")[0]?.trim().replace(/^["']|["']$/g, "").toLowerCase();
    // A family declared as a var is the system's own choice, which is the behaviour we want.
    if (first && !first.startsWith("var(") && !first.startsWith("inherit")) families.add(first);
  }
  if (families.size > 2) {
    out.push({
      code: "font_families",
      blocking: false,
      message: `${families.size} type families in one artefact (${[...families].slice(0, 4).join(", ")}). Two is the ceiling.`,
      fix: "Keep a display face and a text face. Anything else is a third voice on a page that has one.",
    });
  }

  /**
   * The accent is the one colour a reader notices, and the craft note in `anti-ai-slop.md` caps it
   * at two visible uses per screen. Counted in the RENDERED body rather than in CSS, because six
   * rules that each set the accent on one element is a different thing from six elements wearing it.
   */
  const rendered = body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  const accentUses = [...rendered.matchAll(/var\(\s*--accent\b/g)].length;
  if (accentUses > 6) {
    out.push({
      code: "accent_overused",
      blocking: false,
      message: `The accent appears ${accentUses} times in the body. Past a handful it stops being an accent.`,
      fix: "Keep it for the one thing the reader should look at first. Everything else uses `--fg` and `--muted`.",
    });
  }

  /**
   * ═══ THE SQUINT TEST, AS THE HALF OF IT A MACHINE CAN ACTUALLY RUN ═══
   *
   * opendesign's craft rule is "if you blur your eyes, is the hierarchy still clear". That is a
   * judgement about a rendered page, and our reviewer never sees one — it grades readable text, so
   * adding this as a sixth criterion would be asking a model to report on something it was not
   * shown, which is the failure `reviewability` exists to prevent.
   *
   * What IS checkable is the structure underneath the visual hierarchy. A document with four `h1`s
   * has no top line; one that jumps `h1` → `h3` has a level the reader is asked to infer. Neither
   * proves a page reads well, and both reliably mean it does not.
   *
   * ADVICE, NEVER A GATE. A one-section note legitimately has no `h1`, and an artefact assembled
   * from fragments legitimately has a ragged ladder. Refusing those would block correct work over a
   * proxy for a judgement nobody made.
   */
  const headings = [...rendered.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ level: Number(m[1]), text: m[2]!.replace(/<[^>]*>/g, " ").trim() }));
  if (headings.length >= 3) {
    const h1s = headings.filter((h) => h.level === 1).length;
    const skipped: string[] = [];
    for (let i = 1; i < headings.length; i++) {
      const jump = headings[i]!.level - headings[i - 1]!.level;
      // Going DOWN any number of levels is fine — a section ending returns to the top. Only jumping
      // down more than one level at a time asks the reader to infer a heading that is not there.
      if (jump > 1) skipped.push(`h${headings[i - 1]!.level} → h${headings[i]!.level}`);
    }
    if (h1s > 1 || skipped.length > 0) {
      const said = [
        h1s > 1 ? `${h1s} top-level headings` : null,
        skipped.length ? `a level skipped (${skipped.slice(0, 3).join(", ")})` : null,
      ].filter(Boolean);
      out.push({
        code: "hierarchy",
        blocking: false,
        message: `The heading ladder does not hold: ${said.join(", ")}. Blur your eyes and the shape of the page is gone.`,
        fix: "One `h1` — the answer the reader came for — then one level per step down. A skipped level is a section nobody wrote.",
      });
    }
  }

  return out;
}

/** The blocking half, as the sentence handed back to a run that must fix it before submitting. */
export function fidelityRefusal(findings: readonly FidelityFinding[]): string | undefined {
  const blocking = findings.filter((f) => f.blocking);
  if (!blocking.length) return undefined;
  return [
    ...blocking.map((f) => `${f.message}\n${f.fix}`),
    "Fix this in the file and submit again.",
  ].join("\n\n");
}
