---
name: portal-as-continuation
description: Make the deployed site's /portal sign-in / DeadLink entry a designed continuation of the branded marketing page — same brand, type and motif, a warm on-brand "how you get in" screen (magic-link only, no password) that reads like the same company as the front page instead of a generic auth wall. Use whenever you build or review a tenant's portal entry, sign-in, or dead-link screen, or the founder says the sign-in feels disconnected or boilerplate.
---

# The portal entry is a continuation of the front page, not an auth wall

A stranger reads the founder's bespoke marketing page, is convinced, presses **Client sign in**, and
lands on `/portal` with no session — so they meet `DeadLink` with `reason="no-link"`: a heading that
says "Sign in to your account" and a paragraph. Today that screen is boilerplate. It looks like a
different, cheaper company than the one they just met. This is the first thing a real client sees on
their way IN, and the second-most-visited state of the whole portal (an expired link is common). It
deserves to be designed to the same level as the front page.

Your job: make the portal entry read like the SAME company as the marketing page — same brand, type
and `signature_motif` — while staying calmer, because a client opens it to work, not to be sold to.

## What to elevate, and where it lives

- **`components/shell.tsx` → `DeadLink`** is the screen. It renders inside `Shell` (letterhead,
  `BrandMark`, footer) and draws whatever `deadLinkCopy` returns. This is the component you make
  bespoke.
- **`lib/deadlink.ts` → `deadLinkCopy`** is the pure copy/decision function, unit-tested by
  `test/deadlink.test.ts`. Three reasons — `"no-link"` (the front door: a first-time or returning
  visitor pressing "Client sign in"), `"expired"` (a dead link), `"signed-out"`. Each already has its
  own honest heading and body. **Keep the three-reason distinction and keep every branch offering a
  route back** (a `mailto` when there's a support address, an honest note when there isn't). The tests
  assert this — don't collapse the reasons and don't add a button with nothing behind it.

## The rules for this screen

- **Same brand, quieter register.** Same `--font-heading` wordmark, same `--business-accent`, same
  `signature_motif` as the marketing page — but stated once, small, not performed. Recognisably the
  same company; obviously a different room. Think the entryway of the building whose facade is the
  front page, not a second billboard. See `design-craft-typography.md` and `design-craft-color.md`.
- **Warm, present tense, no failure reported on the front door.** The `"no-link"` copy already does
  this ("sends you a link by email — there's no password to invent…"). Design AROUND that voice.
  Frame it as "how you get in", not "sign-in failed."
- **Magic-link only. There is NO password, and that is deliberate — keep it.** Never add a password
  field, a "create account" form, or a fake login box. The way in is: the business emails a link, you
  open it, you stay signed in on that device for a month. The screen should make that feel like a
  considered choice (calm, secure, nothing to remember), not a missing feature.
- **One action.** The `mailto` (or the honest note) is the whole recovery path — the client plane has
  no self-serve "send me a link" route. Design it as the single, obvious, on-brand action. Don't
  invent a second CTA.
- **Stay calmer than the marketing page.** No hero, no proof strip, no marketing voice. A client
  opening an expired link wants back in, not a pitch. Restraint here is the brand — the same restraint
  the in-app `/portal` keeps (see `build-the-ui.md`, the `/portal` rules).

## The hard rails still hold

Tokens only, no hardcoded hex, `--business-accent` for brand colour, both light and dark via tokens
(no `dark:`), no CDN fonts. And keep `deadlink.ts` pure and its tests green — the design lives in
`DeadLink`'s markup, the decision stays in `lib/`.

## Done when

A client who just read the front page and pressed "Client sign in" would say "yes, this is still
them" — the entry is unmistakably the same brand, warmer and calmer, explains how getting in works
without reporting a failure, offers exactly one on-brand way through, and passes `test/deadlink.test.ts`
in both themes.
