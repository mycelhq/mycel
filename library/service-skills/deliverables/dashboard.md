---
name: dashboard
description: "Admin / analytics dashboard in a single HTML file. Fixed left sidebar, top bar with user/search, main grid of KPI cards and one or two charts. Use when the brief asks for a \"dashboard\", \"admin\", \"analytics\", or \"control panel\" screen."
source: https://github.com/nexu-io/open-design/blob/349748e/design-templates/dashboard/SKILL.md
license: Apache-2.0
attribution: nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)
---

<!-- HARVESTED, NOT WRITTEN HERE. 1 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

# Dashboard Skill

Produce a single-screen admin / analytics dashboard.

## Workflow

1. **Read the active DESIGN.md** (injected above). Colors, typography, spacing,
   component styling all come from it. Do not invent new tokens.
2. **Classify** what the dashboard monitors (sales, traffic, usage, incidents,
   ops, etc.) from the brief. Generate specific, plausible metric names and
   values — no "Metric A / Metric B" placeholders.
3. **Lay out** the required regions:
   - **Left sidebar** (220–260px): brand mark at top, 6–8 nav links with
     icons, active state uses the DS accent.
   - **Top bar**: page title on the left, search input + user avatar / status
     on the right.
   - **Main**:
     - Row 1: 3–4 KPI cards (label + big number + delta vs. prior period).
     - Row 2: one primary chart (full width or 2/3) — render as an inline SVG
       line / bar / area chart drawn from real-looking numbers.
     - Row 3: one secondary chart or table (recent events, top items, etc.).
4. **Write** one self-contained HTML document:
   - `<!doctype html>` through `</html>`, CSS in one inline `<style>` block.
   - CSS Grid for the overall layout; Flexbox inside cards.
   - Semantic HTML: `<aside>`, `<header>`, `<main>`, `<section>`.
   - Tag each logical region with `data-od-id="slug"` for comment mode.
5. **Charts**: inline SVG only, no JS libraries. A line chart is ~10 lines of
   `<polyline>` with a subtle area fill. A bar chart is N `<rect>`s with
   DS-accent fill. Label axes lightly (muted text, smaller scale).
6. **Self-check**:
   - Every color comes from DESIGN.md tokens.
   - Accent used at most twice (sidebar active + one chart highlight).
   - Sidebar + top bar are sticky; main scrolls independently.
   - Density matches the DS mood — airy DSes get more padding, dense DSes
     (trading, crypto) tighten rows.

## Output contract

Emit between `<artifact>` tags:

```
<artifact identifier="dashboard-slug" type="text/html" title="Dashboard Title">
<!doctype html>
<html>...</html>
</artifact>
```

One sentence before the artifact, nothing after.
