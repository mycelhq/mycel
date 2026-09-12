# Built: saved filters — Ledgerline

*(Reference document. Ledgerline is invented; every path, number and finding below is made up.
Nothing in it is true of anybody.)*

---

## Client summary

Saved filters are live on staging. A user can save the current filter set, name it, pin up to five to
the sidebar, and share one with their team. It is behind the `saved_filters` flag, off in production
until you have looked at it.

One thing changed from what we agreed, and it changed for a reason worth knowing: sharing a filter
with a teammate can leak the existence of records they cannot see. I built the share anyway and
scoped it — details below — but you should decide whether that is the behaviour you want before this
goes on.

---

## What was built

| Change | Where |
| --- | --- |
| Save the current filter set with a name | `app/filters/save-filter.tsx` |
| Pin up to five to the sidebar | `app/nav/pinned-filters.tsx` |
| Share a filter with a team member | `app/filters/share.ts` |
| Filter storage and scoping | `lib/saved-filters.ts` |
| Migration: `saved_filters`, `saved_filter_pins` | `migrations/0042_saved_filters.sql` |

**Tests:** 24 added, all passing. The interesting ones are in `lib/saved-filters.test.ts` — the four
covering the sharing scope described below.

**Try it:** staging, sign in as any account, the "Save this view" control appears once you change a
filter. `?flag=saved_filters` to force it on.

---

## The decision I made, and why you may want to reverse it

A shared filter is a set of *criteria*, not a set of *records*. But criteria can be revealing: a
filter named "Q4 layoff planning — cost centre 4400" tells the recipient that cost centre exists,
that it is being looked at, and what it is being looked at for — regardless of whether they can open
a single record it returns.

**What I did:** the share stores the criteria and evaluates them against the *recipient's* own
permissions, so they never see a record they could not already reach. The filter's NAME and its
criteria are visible to them.

**What I did not do:** hide or rewrite the name. That felt like the product lying about what it is.

**The residual risk, stated plainly:** a user can leak the shape of something sensitive through a
filter name. The alternatives are to forbid sharing outside a permission boundary (safe, and removes
most of the feature's value at Ledgerline's size) or to warn on share (annoying, and people click
through warnings). I picked the one that works and I am telling you the cost.

Reversing it is about half a day if you would rather have the boundary.

---

## What I did not build

- **Filters shared with a whole team at once.** Not in scope, and it makes the question above much
  larger — one recipient is a decision, forty is a policy.
- **Filter folders.** You mentioned it as a maybe. Five pins covers what the mockups showed and the
  data model does not preclude folders later.
- **Migration rollback for `saved_filter_pins`.** The up migration is safe and additive; the down
  drops user data. I would rather you decide the rollback policy than have me invent one.

---

## What needs you

Look at the sharing behaviour on staging and tell me if the residual risk above is acceptable. If it
is, the flag can go on for everyone — nothing else is blocking. If it is not, say so and I will put
the permission boundary in this week before anyone has saved anything worth migrating.
