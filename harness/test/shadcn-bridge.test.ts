// Why a harvested design system could not dress our own surfaces.
//
// Not neglect — two vocabularies with seven names in common. Our apps ask for `--background`,
// `--foreground`, `--card`, `--primary`; the 29 systems define `--bg`, `--fg`, `--surface`,
// `--accent`. Paste `editorial/tokens.css` into the console and almost nothing changes: every
// component asks for a name the system never defines, and the system's own values are read by
// nobody. This is the translation, and these are the ways it can be silently wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { designSystemIds, shadcnFromDesignSystem } from "../src/design-systems";

/** The roles a shadcn component will actually break without. */
const REQUIRED = [
  "background", "foreground", "card", "card-foreground", "primary", "primary-foreground",
  "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "border", "input", "ring",
];

const declared = (css: string) =>
  Object.fromEntries(
    [...css.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  ) as Record<string, string>;

test("every system maps every role a component needs", () => {
  for (const id of designSystemIds()) {
    const t = declared(shadcnFromDesignSystem(id));
    for (const role of REQUIRED) {
      assert.ok(t[role], `${id} produces no --${role} — components using it fall back to nothing`);
    }
  }
});

test("a colour role never receives a shadow", () => {
  // THE BUG THIS CAUGHT. open-design's `--focus-ring` is a whole box-shadow
  // (`0 0 0 4px rgba(...)`); shadcn's `--ring` is the colour a ring is drawn in. Handing it the
  // shadow yields `outline-color: 0 0 0 4px rgba(...)`, which the browser drops — a broken focus
  // outline on every input, from a mapping whose NAME looked exactly right.
  const colourish = /^(#|rgb|hsl|oklch|oklab|color-mix|var\(|transparent$|currentColor$)/i;
  for (const id of designSystemIds()) {
    const t = declared(shadcnFromDesignSystem(id));
    for (const role of REQUIRED) {
      assert.match(t[role]!, colourish, `${id}: --${role} is "${t[role]}", which is not a colour`);
    }
  }
});

test("the values are the system's own, never invented", () => {
  // The whole point: shadcn names BORROW open-design values. A colour appearing here that is not
  // in the source system means the bridge made one up, and an invented colour is how a set of
  // surfaces stops looking like one system.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "library", "design-systems", "systems", "editorial", "tokens.css"),
    "utf8",
  );
  const t = declared(shadcnFromDesignSystem("editorial"));
  for (const role of REQUIRED) {
    const v = t[role]!;
    if (!v.startsWith("#")) continue;
    assert.ok(src.includes(v), `--${role}: ${v} does not appear anywhere in editorial/tokens.css`);
  }
});

test("primary is what you click, not the colour of body text", () => {
  // shadcn's `primary` is the button. open-design's equivalent is `accent`. Mapping it to `--fg`
  // is technically a mapping and visibly wrong — every button the colour of paragraph text.
  const t = declared(shadcnFromDesignSystem("editorial"));
  assert.equal(t.primary, t.accent, "primary drifted away from the system's accent");
  assert.notEqual(t.primary, t.foreground, "every button is now the colour of body text");
});

test("an unknown system yields nothing, not a half-mapped block", () => {
  // A partial `:root` is worse than none: it restyles some surfaces and leaves the rest on the old
  // palette, which reads as a rendering bug rather than a missing theme.
  assert.equal(shadcnFromDesignSystem("does-not-exist"), "");
  assert.equal(shadcnFromDesignSystem(undefined), "");
});

// ── The dark half none of them ship ────────────────────────────────────────────────────────────
//
// Every one of the 29 is a single light `:root`. Two consequences: a surface with a dark mode gets
// the system's light palette against its own dark one (two palettes, through the theme switch),
// and every deliverable graded on `styled_both_themes` fails that criterion structurally.

const darkOf = (css: string) => {
  const at = css.indexOf(".dark {");
  return at < 0 ? {} : (Object.fromEntries(
    [...css.slice(at).matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  ) as Record<string, string>);
};

test("every system gets a dark block", () => {
  for (const id of designSystemIds()) {
    const d = darkOf(shadcnFromDesignSystem(id));
    assert.ok(d.background, `${id} has no dark background — half its surfaces stay light`);
    assert.ok(d.foreground, `${id} has no dark foreground`);
  }
});

test("the accent does not move between modes — it is the brand's, not the mode's", () => {
  // Re-deriving an accent for dark hands the business a second brand colour after hours.
  for (const id of designSystemIds()) {
    const css = shadcnFromDesignSystem(id);
    const l = declared(css.slice(0, css.indexOf(".dark {")));
    const d = darkOf(css);
    for (const identity of ["accent", "primary", "accent-foreground", "primary-foreground"]) {
      if (l[identity] && d[identity]) {
        assert.equal(d[identity], l[identity], `${id}: --${identity} changed in dark`);
      }
    }
  }
});

test("page and ink actually swap, and a panel lifts off the page", () => {
  for (const id of designSystemIds()) {
    const css = shadcnFromDesignSystem(id);
    const l = declared(css.slice(0, css.indexOf(".dark {")));
    const d = darkOf(css);
    assert.equal(d.background, l.foreground, `${id}: dark page is not the light ink`);
    assert.equal(d.foreground, l.background, `${id}: dark ink is not the light page`);
    // A card equal to the page is invisible — the most common way a derived dark theme goes flat.
    assert.notEqual(d.card, d.background, `${id}: a dark panel is the same colour as the page`);
  }
});

test("the derived block says it is derived", () => {
  // An agent with a better dark palette must know it may replace this, rather than treating it as
  // the system's own considered answer.
  const css = shadcnFromDesignSystem("professional");
  assert.match(css, /Dark, DERIVED/, "nothing marks the dark block as derived");
  assert.match(css, /do not delete it/i, "nothing warns that deleting it fails both-theme grading");
});
