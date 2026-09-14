---
name: reference-design-contract
description: "Turn vague taste, screenshots, URLs, product notes, or \"make it feel like this\" references into a grounded DESIGN.md plus an implementation handoff. Use it before prototypes, decks, redesigns, or image remix work when the user needs a reusable visual direction rather than a one-off prompt."
source: https://github.com/nexu-io/open-design/blob/349748e/skills/reference-design-contract/SKILL.md
license: Apache-2.0
attribution: nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)
---

<!-- HARVESTED, NOT WRITTEN HERE. 1 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

# Reference Design Contract

Use this skill when the user has taste signals, references, or a rough "like
this" request and needs a reusable design contract before generation. The goal
is not to write a longer prompt. The goal is to make design decisions explicit
enough that a later prototype, deck, redesign, or image-remix run can execute
without guessing.

## What this skill produces

Create three files:

1. `DESIGN.md` — the reusable visual direction, following OpenDesign's
   standard nine-section design-system shape.
2. `design-contract.md` — the decision record: evidence used, keep/change
   boundaries, rationale, risks, and quality gate.
3. `implementation-handoff.md` — concise build instructions for the next
   artifact-producing skill or coding agent.

If a preview is useful, also create `example.html` as a small hand-built
contract preview. Do not make it the main deliverable.

## Workflow

1. **Lock the job.** Identify target artifact type, audience, brand/product
   context, references, and constraints. Ask at most two questions only when a
   missing answer would change the direction. Otherwise choose a sensible
   default and label it as inferred.
2. **Read evidence.** Use provided screenshots, URLs, existing `DESIGN.md`,
   brand docs, image artifacts, or user notes. If evidence is missing, say so
   and base the contract on the brief only; do not invent brand facts.
3. **Separate reference semantics.** For every reference, split it into:
   - `Keep`: qualities to preserve, such as density, composition, material,
     typography rhythm, color temperature, or motion attitude.
   - `Change`: subject matter, copy, brand marks, exact layout, protected
     assets, and anything the user wants adapted.
   - `Do not copy`: literal screenshots, logos, claims, pricing, proprietary
     UI, or exact prompt wording from examples.
4. **Freeze the direction.** Choose one coherent visual stance. Do not provide
   five unrelated moodboards. If there are genuinely competing directions,
   name them briefly, pick the recommended one, and continue.
5. **Write `DESIGN.md`.** Use these nine headings exactly:
   - `## 1. Visual Theme & Atmosphere`
   - `## 2. Color`
   - `## 3. Typography`
   - `## 4. Spacing & Grid`
   - `## 5. Layout & Composition`
   - `## 6. Components`
   - `## 7. Motion & Interaction`
   - `## 8. Voice & Brand`
   - `## 9. Anti-patterns`
6. **Write `design-contract.md`.** Include:
   - goal and target artifact
   - evidence table with confidence (`observed`, `provided`, `inferred`)
   - keep/change/do-not-copy table
   - final design stance in one paragraph
   - risks and explicit unknowns
   - quality gate checklist
7. **Write `implementation-handoff.md`.** Keep it short and operational:
   - files to read
   - token/palette/type/layout constraints
   - asset rules
   - responsive requirements
   - "first artifact should prove..." acceptance notes
8. **Validate.** Read `references/checklist.md` and satisfy every P0 gate
   before final handoff.

## Output rules

- Make every claim traceable to user input, observed reference evidence, or an
  explicitly labeled inference.
- Prefer concrete constraints over adjectives: "one warm accent, no purple or
  blue glow" beats "premium".
- Treat "do the same style" as "borrow controllable qualities", not "clone the
  original subject or prompt".
- If the user asks for immediate UI generation too, finish these contract files
  first, then hand off to the appropriate artifact skill in the next step.
