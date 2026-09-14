---
name: weekly-update
description: "OpenDesign's weekly metrics standup: this week's numbers, the one anomaly, and the single decision it forces. Built as a decision-grade data & finance deck for ops & growth team."
source: https://github.com/nexu-io/open-design/blob/349748e/design-templates/weekly-update/SKILL.md
license: Apache-2.0
attribution: nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)
---

<!-- HARVESTED, NOT WRITTEN HERE. 1 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

# Weekly Update Deck Skill

Produce a single-file horizontal-swipe HTML deck for a weekly team update.

## Workflow

1. Read DESIGN.md.
2. Identify squad name, week range, and audience (squad-internal vs cross-functional).
3. Slides:
   1. Cover (squad + week + author + date)
   2. Headline (one sentence + one number that matters this week)
   3. What shipped (3–5 items, link-style affordance)
   4. In flight (3–5 items, owner avatars)
   5. Blocked (1–3 items + clear ask)
   6. Metrics that matter (1–2 inline charts)
   7. Asks for next week (named owners)
   8. Closing + thanks
4. Arrow keys or click navigation. Each slide is 100vw wide.

## Output contract

```
<artifact identifier="weekly-update-w42" type="text/html" title="Weekly Update — Growth · W42">
<!doctype html>...</artifact>
```
