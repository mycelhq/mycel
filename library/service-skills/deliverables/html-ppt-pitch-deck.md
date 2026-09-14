---
name: html-ppt-pitch-deck
description: "OpenDesign's demo-day pitch: hook, traction, moat, and the raise — built to make a partner sit up by page three. Built as a decision-grade fundraising pitch deck for accelerator partners, angels."
source: https://github.com/nexu-io/open-design/blob/349748e/design-templates/html-ppt-pitch-deck/SKILL.md
license: Apache-2.0
attribution: nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)
---

<!-- HARVESTED, NOT WRITTEN HERE. 1 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

# HTML PPT · Pitch Deck

A focused entry point into the `html-ppt` master skill that lands the user directly on the **`pitch-deck`** full-deck template.

## When this card is picked

The Examples gallery wires "Use this prompt" to the example_prompt above. When you accept that prompt, this card is the right pick if the user wants exactly the visual identity of `pitch-deck` (see the upstream full-decks catalog for screenshots and rationale).

## How to author the deck

1. **Read the master skill first.** All authoring rules live in
   `design-templates/html-ppt/SKILL.md` — content/audience checklist,
   token rules, layout reuse, presenter mode, the keyboard runtime, and the
   "never put presenter-only text on the slide" rule.
2. **Start from the matching template folder:**
   `design-templates/html-ppt/templates/full-decks/pitch-deck/` — copy `index.html` and
   `style.css` into the project, keep the `.tpl-pitch-deck` body class.
3. **Bring the shared runtime with the template.** The upstream
   `index.html` links the shared CSS/JS via `../../../assets/...` because it
   sits three folders deep inside `design-templates/html-ppt/templates/full-decks/`.
   Once you copy `index.html` into the project, those parent-relative URLs
   no longer resolve and `base.css`, `animations.css`, and `runtime.js`
   will 404 — meaning the deck never activates and slide navigation is
   dead. Pick one of these two recipes per project:
   - **Recipe A — copy + rewrite (preferred):** copy
     `design-templates/html-ppt/assets/fonts.css`, `design-templates/html-ppt/assets/base.css`,
     `design-templates/html-ppt/assets/animations/animations.css`, and
     `design-templates/html-ppt/assets/runtime.js` into a project-local
     `assets/` (with `assets/animations/animations.css`), then rewrite the
     four `<link>`/`<script>` tags in `index.html` from
     `../../../assets/...` to the matching project-local paths
     (`assets/fonts.css`, `assets/base.css`,
     `assets/animations/animations.css`, `assets/runtime.js`).
   - **Recipe B — inline:** read the same four files and replace each
     `<link rel="stylesheet" href="../../../assets/...">` with a
     `<style>...</style>` containing the file's contents, and the
     `<script src="../../../assets/runtime.js">` with a
     `<script>...</script>` containing `runtime.js`. Yields a single
     self-contained `index.html`.
   Either way, do not ship the upstream `../../../assets/...` URLs
   verbatim into a project artifact — they only work in-tree.
4. **Pick a theme.** Default tokens look fine; if the user wants a different
   feel, swap in any of the 36 themes from `design-templates/html-ppt/assets/themes/*.css`
   via `<link id="theme-link">` and let `T` cycle.
5. **Replace demo content, not classes.** The `.tpl-pitch-deck` scoped CSS only
   recognises the structural classes shipped in the template — keep them.
6. **Speaker notes go inside `<aside class="notes">` or `<div class="notes">`** — never as visible text on the slide.

## Attribution

Visual system, layouts, themes and the runtime keyboard model come from
the upstream MIT-licensed [`lewislulu/html-ppt-skill`](https://github.com/lewislulu/html-ppt-skill). The
LICENSE file ships at `design-templates/html-ppt/LICENSE`; please keep it in place when
redistributing.

---

*Upstream also pointed at design-templates/html-ppt/SKILL.md, design-templates/html-ppt/references/full-decks.md. Not carried here: it is a catalogue of third-party tools rather than procedure, and this skill has to hold up without it.*
