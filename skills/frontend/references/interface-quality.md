# Interface quality

Everything here is achievable with Tailwind and the six CSS variables already defined in
`app/globals.css`. If you find yourself wanting a component library, an icon pack or a fourth colour,
the answer is almost always that the hierarchy is wrong and you're trying to fix it with decoration.

---

## The palette is one accent and neutrals. That is not a suggestion.

```css
--background  --foreground  --muted  --border  --surface   /* neutral, light + dark */
--color-accent                                             /* the founder's, from --business-accent */
```

`--color-accent` is **the founder's brand colour, resolved per request**. You do not choose it, you
do not add a second one, and you do not hardcode a hex that happens to look nice — see
`customer-facing.md`. Everything else on the page is neutral.

The accent's job is to mark the one thing that matters in a given view: the primary button, the
active case stage, the customer's own message, the upload progress bar. Look at
`app/portal/page.tsx` — the accent appears exactly once, on `c.stage`. That restraint is what makes
the stage readable at a glance. If the accent is on six things, it marks nothing.

**Semantic colour is the one exception**, and it is earned: an error message may be red
(`text-red-600`, as `reply.tsx` uses for its `role="alert"`). Success does not need green — "Sent —
`filename` is with us." in muted text is calmer and reads better.

### Anti-slop, explicitly

These are the tells that an interface was generated rather than designed. None of them appear in
this app and none should:

- **No gradients as decoration.** No `bg-gradient-to-r from-purple-500 to-pink-500`, no gradient
  text, no glow. A gradient may exist when it encodes something (a progress fill, a fade to indicate
  more content). Otherwise it is noise, and on a page a customer reads once a month it reads as
  unserious.
- **No emoji as iconography.** 📊 is not a chart icon, ✅ is not a status, 🚀 is not anything. Emoji
  render differently on every platform, mean different things in different cultures, and are read
  aloud by screen readers ("rocket"). If you need a mark, use a text label, a coloured dot with a
  label next to it, or an inline SVG you wrote. In body copy, a `✓` or `→` as *punctuation* is fine
  — `app/portal/[thread]/page.tsx` uses `← Back` — that's a glyph, not an icon.
- **No five accent colours.** One. If you are colour-coding categories, use neutrals with different
  weights, or labels.
- **No purple-to-blue on a dark card with a glow.** You know the one.
- **No decorative illustrations or stock photography.** Typography, whitespace and layout are the
  tools. An empty state does not need a cartoon.
- **No `shadow-2xl` on everything.** This app uses `border` + `--surface` for elevation. One flat
  border reads as more considered than a drop shadow, and it works in dark mode without tuning.
- **No animation that doesn't inform.** The upload bar's `transition-[width] duration-150` earns its
  place — it says bytes are moving. A card that fades and slides in on scroll does not.

---

## Hierarchy: three levels, and mean them

A page should be legible at a squint. Three type levels are enough for anything in this app:

```tsx
<h1 className="mt-6 text-2xl font-medium tracking-tight">Hello, {name}</h1>   {/* the page */}
<h2 className="text-sm font-medium">Conversations</h2>                        {/* a section */}
<p className="text-sm" style={{ color: "var(--muted)" }}>…</p>                {/* everything else */}
```

Two things to notice, because they're what makes it look designed rather than defaulted:

- **The section heading is smaller than the body it introduces is wide.** `text-sm font-medium`, not
  `text-xl font-bold`. Weight and colour separate levels more quietly than size does, and quiet is
  correct for a page whose content is the point.
- **`tracking-tight` on headings only.** Never letterspace lowercase body text.

Use `--muted` for anything secondary — timestamps, hints, counts. The contrast between
`--foreground` and `--muted` is doing most of the hierarchy work on every screen in this app.

**Never rely on colour alone.** A stage marked only by an accent-coloured dot is invisible to 8% of
men and to anyone on a monochrome display. Label it.

---

## Spacing: one scale, used the same way every time

The app's rhythm, which you should match:

| gap | Tailwind | used for |
|---|---|---|
| within a row | `gap-3` | label ↔ value ↔ timestamp |
| inside a card row | `px-4 py-3` | a list item |
| heading → its content | `mt-2` / `mt-3` | title to subtitle, heading to card |
| between sections | `mt-10` | one section to the next |
| page frame | `px-6 py-12`, `max-w-2xl` | `Shell` |

`max-w-2xl` is not arbitrary — it puts body text at roughly 65–75 characters per line, which is the
readable measure. Don't widen it because the screen is wide. A 1,400px line of text is unreadable no
matter how much room you have.

The rule that matters more than the specific numbers: **pick a step and reuse it.** `mt-10` between
every section. Not `mt-8` here and `mt-12` there because one looked cramped. Inconsistent spacing is
the single most reliable signal of generated UI, and it is entirely avoidable.

---

## Empty states offer an action, or at minimum an expectation

An empty state is a page a real customer will see on their first visit. "No data" is a dead end and
an insult.

```tsx
// ✅ what the portal actually does — says what will happen and what they can do
<Card className="mt-3 px-4 py-8 text-center">
  <p className="text-sm">Nothing here yet</p>
  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
    When we message you it&apos;ll appear here, and you can reply.
  </p>
</Card>
```

```tsx
// ❌ a dead end
{threads.length === 0 && <p className="text-gray-400">No conversations found.</p>}
```

The test: **can the reader do something, or at least know when this will change?** If neither, the
empty state is wrong. Best is a button ("Start a conversation"). Next best is an expectation ("When
we message you it'll appear here"). Never a count of zero.

Note also that the portal *hides* the "In progress" section entirely when there are no cases, rather
than showing an empty one. A section that is empty is worse than a section that isn't there —
unless its absence would be confusing, in which case show it with a real empty state.

---

## Loading and error states are written at the same time as the success state

Not after. If you write the happy path first and intend to come back, you will ship a spinner that
never resolves and an error that says "Something went wrong."

**Loading.** Prefer disabling and relabelling the control that caused it over a spinner somewhere
else on the page — the feedback belongs where the click happened:

```tsx
<button type="submit" disabled={busy} className="… disabled:opacity-50">
  {busy ? "Sending…" : file ? "Send file" : "Send"}
</button>
```

For anything that takes more than a second and has measurable progress, show the progress. `fetch`
reports no upload progress at all, which is why `reply.tsx` uses `XMLHttpRequest` for file uploads:
on a phone sending a 15MB scan, a button that just sits there gets pressed again, and the business
receives the document twice. That is a UI bug that costs the founder real time.

**Errors.** Two rules.

*First, every failure gets a sentence a human can act on.* The kernel's own message is preferred when
it has one (it knows the configured limit); otherwise map the status:

```
409 → "We've noted your message, but this conversation isn't connected to anything that
       can take a file right now. Someone here will pick it up."
413 → "That file is too large to send. The limit is 25 MB."
400 → "We couldn't read that file. Try a different one."
401 → "Your link has expired. Ask us for a fresh one."
  * → "Something went wrong sending that. Try again."
```

Notice the 409: it is the one failure that isn't the customer's fault, so it says so. That distinction
is the difference between an error message and an apology.

*Second, errors are announced.* `<p role="alert">` so a screen reader reads the message when it
appears. An error that only exists visually doesn't exist for everyone.

**Degrade, don't break.** `app/portal/page.tsx` does
`api<Thread[]>("threads").catch(() => [] as Thread[])` — one failing section renders as empty rather
than taking the page down. And `businessFor` falls back to neutral branding on a slow kernel with a
2-second timeout, because a customer's browser hanging is worse than an unbranded page.

---

## Forms that work for everyone

- **Every input has a label.** A `placeholder` is not a label: it disappears when the field has
  content, fails contrast requirements at most implementations, and is not reliably announced. If the
  design has no room for a visible label, use `className="sr-only"` — never nothing. (`reply.tsx`'s
  textarea is the borderline case the app allows: a single-field form whose surrounding context is
  unambiguous. One field, in a thread, under a heading. Don't generalise from it.)
- **Use real elements.** `<button type="button">` for the file trigger, with the `<input type="file">`
  visually hidden via `sr-only` — *not* `display: none`, which removes it from the accessibility tree
  and from keyboard focus.
- **`required` reflects reality.** The reply textarea is `required={!file}`: a file is a message in
  its own right, so words stop being mandatory once one is attached. Validation that lies about what
  the server accepts is worse than none.
- **Catch what the browser already knows.** An empty file, a wrong extension, a too-long field — the
  browser knows before the round trip. Say so immediately.
- **Disable during submit, and say why.** `disabled={busy}` on *every* control in the form, not just
  the submit button, or the customer changes the attachment mid-upload.
- **Focus is visible.** Don't remove the focus ring. `outline-none` on an input, as the reply textarea
  does, is only acceptable when you have replaced it — if you write `outline-none`, add
  `focus:border-[var(--color-accent)]` or a `focus-visible:ring`.
- **Touch targets are at least 44px.** `px-4 py-2 text-sm` clears it. `text-xs` with `p-1` does not,
  and this app is opened on phones.

---

## The bar

Squint at the screen. You should see a calm, mostly-neutral page with one small moment of colour, a
clear first line, and obvious grouping. Tab through it: every control is reachable and the focus is
visible. Turn the network off: something honest appears. Open it with no data: it tells you what
happens next.

If any of those fail, the fix is structural, not decorative. Do not reach for a gradient.
