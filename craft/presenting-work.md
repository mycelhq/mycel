# What the work looks like when it arrives

`delivering-work.md` is about whether the work is right. This is about whether it looks like a firm
did it. Both decide whether a client renews, and only one of them is visible in the first four
seconds.

The failure this exists to stop is not ugliness. It is a correct, careful, expensive piece of
analysis arriving as a wall of unstyled markdown, which reads as a draft — as the notes someone
would work up into the actual deliverable later. A client who receives notes concludes they are
paying for notes.

## The house style is mounted; use it, do not invent one

Every run that produces something a client opens is given `brand/tokens.css` and, usually,
`brand/DESIGN.md`. These are the business's real colours and type, not a suggestion.

**Paste the `:root` block into ONE `<style>` in the document.** Do not link a stylesheet — the file
has to survive being emailed, downloaded and opened offline. Do not split it across files.

**Do not introduce a colour that is not in the tokens.** This is the rule that makes a set of
deliverables look like one firm made them. The report, the proposal and the invoice arriving in
three different blues is the specific thing that reads as amateur, and each one looked fine alone.

**`brand/DESIGN.md` says when the look is right and what it refuses.** Read it before deciding a
layout, not after.

## Self-contained HTML is the default for anything a person reads

A report, a summary, an audit, a proposal, a review, a plan, a one-pager, a deck. One `.html` file,
no build step, no external assets, no CDN fonts that vanish behind a corporate firewall or when the
client opens it on a plane.

**Markdown is a working note. It is not a deliverable.** Send `.md` only when the recipient asked
for it or will edit it.

**A data file stays a data file.** A ledger is still `.csv`, a dataset is still `.json`. Do not wrap
data in HTML to make it look finished — `delivering-work.md` §1 is the rule, and the format is part
of the work. Send both when a person and a spreadsheet are both going to open it.

**It will be printed or saved to PDF.** Set page margins, keep a table's header with its rows, and
do not let a chart land alone on the last page.

**Fonts: system stacks, not a webfont from a CDN.** The corporate firewall that blocks the font is
the same one the client is behind, and a document that falls back to Times on their screen is not
the document you designed. `brand/tokens.css` names the families; give each a real fallback stack.

## A grid a client will sort belongs in a spreadsheet, not in prose

If the reader is going to sort it, filter it, or forward it to somebody who will — a longlist, a
ranking table, a budget, a control matrix — ship a real `.xlsx` alongside the document.

**Use the `workbook` workflow when your trade declares one.** It takes tabs, a header row and rows,
and the kernel renders a genuine Excel file and attaches it to the delivery. You do not write the
file and you do not list it in `artifacts` — it is already there.

**It formats; it does not calculate.** Give it numbers you have already decided are correct. It will
never re-total a column, which is the point: a figure you never retype cannot be retyped wrong.

**A tab per schedule.** One sheet with blank rows between sections is a CSV wearing a suit.

**A CSV is still the right answer for a data feed** — something another system imports. The
distinction is who opens it: a person gets a workbook, a program gets the data file. Send both when
both are true. This is `delivering-work.md` §1, applied to the format.

## Charts

**Draw a chart as inline SVG unless it needs to be interactive.** A bar, line, area, donut or
scatter is arithmetic and `<path>` elements; it needs no library. An SVG chart renders with
scripting switched off, renders offline on a plane, renders inside the locked-down preview pane the
client opens it in, and prints to PDF at full resolution instead of as a blurry raster. A chart
library gives you none of that and costs a network fetch the reader may not be able to make.

This is the opposite of the advice in most chart runbooks, and the reason is that they are written
for web pages. A deliverable is a FILE. It gets emailed, downloaded, opened in a preview pane,
printed and attached to something else, and it has to survive all of that with its numbers visible.
A report whose figures vanish when a CDN is unreachable is a report that is sometimes blank.

**Use a chart library when the reader will interact** — hover for a value, toggle a series, filter a
live dashboard. Then it earns its dependency, and this next rule applies.

**A chart container MUST have an explicit height.** Wrap every `<canvas>` in a `<div>` with a fixed
pixel height — roughly 240–280px for a main chart, ~40px for a sparkline in a stat card. With
Chart.js `responsive: true, maintainAspectRatio: false` and no height on the parent, the canvas and
its container grow each other through a ResizeObserver loop until the page locks the browser. The
`height=` attribute on the canvas is an initial value, not a layout, and does not prevent this.

**Chart the claim, not the table.** Two charts that carry the argument beat six that inventory the
data. If a number is the point, a stat card is better than a chart.

**Label the axes and name the units.** An unlabelled axis is a decoration.

## Never ship a placeholder

**No lorem ipsum, no stock silhouettes, no "Company Name" in a header, no `[insert finding]`.** One
placeholder discredits every real number on the page, because the reader now has to wonder which
other parts were not filled in.

**Parse the actual data you were given.** Do not invent representative figures to make a chart look
plausible. If a figure is missing, `delivering-work.md` §2 applies: say so, in the document, where
the number would have been.

**No image you cannot account for.** A photograph nobody chose is worse than white space.

## Structure the reader can use

**Open with the answer.** The first screen carries the finding, the number, and what to do — not a
methodology section and not a table of contents. §5 of `delivering-work.md` is the same rule about
order; this is what it looks like on a page.

**One idea per section, and let the headings carry the argument.** A reader who reads only the
headings should get the case.

**Numbers are tabular and right-aligned**, with the same precision down a column. Money carries its
currency the first time and at every total.

**Say when it was produced and what period it covers.** A report without a date is unusable the
month after it arrives.
