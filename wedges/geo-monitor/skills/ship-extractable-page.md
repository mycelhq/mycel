---
name: ship-extractable-page
description: Author a complete commercial page from one GEO recommendation — the page a client would put on their domain, written so an assistant can extract the answer. This is the work the retainer is for.
task_types: [ship_page]
---

# Ship an extractable page

A share-of-voice number is a diagnosis. This run is the product: **one complete page** live at a URL
the client can open on their phone this week, written so an answer engine can lift the first two
sentences and cite them — and so a founder would actually send the URL to the client.

You are not writing a blog post. You are not writing a strategy deck. You are not writing two
paragraphs on a cream background. That is a stub. A stub is not a delivery.

Best GEO agencies (source repair, not dashboards) ship **owned pages that look like the rest of the
site**: answer-first opening, extractable tables, FAQ whose answers are on the page, Organization /
LocalBusiness / FAQPage JSON-LD, nav and footer, named entity, current date. Copy that. Do not
invent a survey, a street address, a phone number, or a price they did not give you.

## Before a single sentence

The **vertical is the client, not a different service.** Jewelry vs flowers is this client's facts,
not a fork of this skill.

Read the recommendation (`what`, `why`, `genre`, `effort`) and the client name. Read the brand kit
(`GET $MYCEL_PROJECT_URL/brand-kit` when you have it) for colour, type, and voice. Read any client
answers in `./inputs/`.

If a checkable fact the page needs — a price, a turnaround, a service area, a named constraint —
is not in the input, the knowledge, or what the client already sent, **stop**. Set `status` to
`needs_facts`, put the ask in `needs` in *their* words, and leave `html` absent. Inventing a number
is the claim that destroys the retainer the first time a customer checks it.

If you have the brand kit, the page must be unmistakably *theirs* (accent, type, voice). A calm
system-font article with the name swapped in is a template. If you do not have colour or type, still
build **site chrome** (header, nav, footer) in a restrained stack — do not invent a luxury jewelry
look for a florist, or the reverse.

If `effort` is `large`, refuse the same way. Original data, Wikipedia, and digital PR are not a page
you draft from a weekly report.

## The page that gets selected *and* accepted

Retrieval picks passages. Clients accept sites. You need both.

1. **The first two sentences answer the question.** No preamble, no brand story, no "in today's
   landscape". The question is the H1. The answer starts in the first paragraph. This is the
   *opening*, not the entire page.
2. **Then the commercial page.** Price or cutoff table. Honest comparison when the query is a
   comparison. The process (visit, order, turnaround) as steps. FAQ whose answers are visible in
   the body. Nav and footer with the business name and place. Enough copy that swapping the client
   name would make sentences false.
3. **Self-contained sections.** Each heading plus the block under it survives being quoted alone.
   No "as we mentioned above".
4. **Specific and checkable.** Numbers, dates, named constraints, prices, hours, service areas they
   already have. "Fast turnaround" is unquotable. "Most jobs completed within three working days"
   is a citation. Do not invent a street, a phone, or a SKU breakdown they did not give you — use
   the range they gave, and say what is confirmed at the visit.
5. **Attributable.** The business name is visible. A date ("Updated August 2026") is on the page.
   If you do not know the author, omit an author — do not invent one.
6. **JSON-LD.** `FAQPage` only for questions whose answers are visible in the body. Plus
   `Organization` or the right LocalBusiness subtype (`JewelryStore`, `Florist`, `Dentist`, …)
   with name and `areaServed`. Never mark up text that is not on the page.

Would you send this URL to their customer tonight, on their domain, as /the-page-you-named? If not,
it is not done. Two paragraphs on an empty sheet fail that test even if the first two sentences are
perfect.

## Genre

Match the recommendation's `genre`. Do not upgrade a structural_edit into a 2,000-word explainer —
but a structural_edit still ships as a **complete page** they can paste over the old one, not a
diff.

| Genre | Shape |
|---|---|
| `direct_answer` | Question as H1. Answer in two sentences. Then the table of what the number covers, process, FAQ JSON-LD. |
| `comparison` | Honest table. Name where the competitor wins. A puff piece that never concedes is cited less. |
| `explainer` | The page you would send someone who asked in person. Still lead with the answer. Still chrome, table, FAQ. |
| `local_answer` | Place in the H1 and the first sentence. Service area is a fact, not a keyword. Cutoff / hours as a table. |
| `structural_edit` | Rewrite of an existing page's opening and headings, delivered as a complete replacement page. |

Never write `original_data`. That genre is a survey they have not run.

Do not bill for `llms.txt`. Entity consistency (same names, Organization schema, third-party
corroboration they already have) is where that hour belongs — and it is a recommendation in the
weekly report, not this page unless the recommendation named it.

## HTML contract

`html` is a **complete document**: `<!doctype html>`, `<html>`, `<head>`, `<body>`.

- One `<h1>`. Title tag and H1 phrased as the question a person would type.
- Meta description: 140–160 characters, the answer plus why it is theirs.
- `<header>` with the business name and place, `<nav>` to on-page sections, `<footer>` with the
  same entity. In-page anchors (`#faq`), not invented extra URLs.
- At least three `<h2>`/`<h3>` sections after the lead.
- A `<table>` or `<dl>` an extractor can lift.
- No `<script>` except JSON-LD. No external stylesheets. Inline CSS only, using the brand kit when
  you have one. No stock gradients, no hero poetry, no "we believe", no Unsplash.
- Images only if you can describe a real one they already have.

`slug` is lowercase, hyphenated, no leading slash. `page_title` is the H1.

The kernel will **refuse to host** a page that is a stub (too short, no chrome, no table, no
JSON-LD). You will have "succeeded" and delivered nothing. Do the page.

## Voice

The client's voice, not ours. Short sentences. Cut "in order to", "leverage", "unlock", "elevate",
"seamless", "cutting-edge", "best-in-class". If a sentence could appear on any competitor's site,
rewrite it until it could not.

## What the client reads

`client_summary` is the note on the deliverable. One paragraph: what this page is, the query it
answers, and that they should open the live URL (we host it — do not invent the address). Mention
where it should eventually live on *their* domain (a new path, or replacing which existing page)
as the follow-on, not as the demo. Do not paste the HTML into the summary. Do not mention the run.

## The test

1. Would an assistant, asked the H1 as a question, quote the first two sentences and cite this URL?
2. Would a founder send this URL to the client without apologising for how thin it looks?

Both. If either is no, the page is not done.

## Worked example — the opening rewrite, before and after

The Small in most reports is exactly this edit. Illustrative facts; **match the move, never the
content.** The recommendation said: "rewrite the opening of /services/emergency so the first two
sentences state the $95 call-out and the response time."

Before — the opening that loses:

> **Emergency Plumbing You Can Trust**
> For over fifteen years, Hartwell & Sons has proudly served the families and businesses of the
> North West with a commitment to quality, honesty and craftsmanship. Our founder James Hartwell
> believes every customer deserves… *(the price appears in paragraph four)*

After — the opening that gets lifted:

> **Emergency plumber call-out: $95, day or night**
> An emergency call-out costs $95 including the first hour on site, and we reach most of
> Manchester within 90 minutes, 24/7. No extra charge for nights or weekends — the $95 is the
> whole call-out fee, and parts are quoted before we fit them.
>
> *(then the rest of the page: what counts as an emergency, the areas covered as a table, the
> FAQ whose answers are on the page — the trust story moves lower, it does not vanish)*

Why the after wins: the heading is the question's own words with the answer in it; the first two
sentences are self-contained and checkable (a price, a radius, a time — three citations in two
sentences); the constraint a customer fears ("is $95 really the whole fee?") is answered before it
is asked. Nothing was deleted — the fifteen years and the founder move below the answer, because
an assistant quotes the top of the page and a human scrolls. The before is not bad writing; it is
good writing in the wrong order.
