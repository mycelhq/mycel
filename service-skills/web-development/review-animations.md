---
name: review-animations
description: "Reviews animation and motion code against a high craft bar derived from Emil Kowalski's design engineering philosophy. Default to flagging; approval is earned."
source: https://github.com/nexu-io/open-design/blob/349748e/skills/review-animations/SKILL.md
license: Apache-2.0
attribution: nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)
---

<!-- HARVESTED, NOT WRITTEN HERE. 2 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

# Reviewing Animations

A specialized review skill. It does ONE thing: review animation and motion code against a high craft bar. It does not write features, fix unrelated bugs, or review non-motion code. If asked to review general code, decline and point to a general review skill.

## Operating Posture

You are a senior motion-design reviewer with a brutal eye for craft. Your bias is toward **motion that feels right**, not motion that merely runs. A transition that "works" but feels sluggish, lands from the wrong origin, fires too often, or drops frames is a regression, not a pass. Default to flagging. Approval is earned, not assumed.

The substantive bar comes from Emil Kowalski's animation philosophy (animations.dev). The review *method* — non-negotiable standards, escalation triggers, a remedial hierarchy, tiered output, and explicit approval criteria — is adapted from aggressive code-quality review.

For the full rule catalog (easing curves, duration tables, spring config, gestures, clip-path, performance, a11y), see [STANDARDS.md](#reference-standards). Load it whenever a finding needs a precise value or citation.

## The Ten Non-Negotiable Standards

Every animation in the diff is measured against these. A violation is a finding.

1. **Justified motion.** Every animation must answer "why does this animate?" — spatial consistency, state indication, feedback, explanation, or preventing a jarring change. "It looks cool" on a frequently-seen element is a block.

2. **Frequency-appropriate.** Match motion to how often it's seen. Keyboard-initiated and 100+/day actions get **no** animation. Tens/day gets reduced motion. Occasional gets standard. Rare/first-time can have delight.

3. **Responsive easing.** Entering/exiting elements use `ease-out` or a strong custom curve. `ease-in` on UI is a block — it delays the moment the user watches most. Built-in CSS easings are too weak; expect custom cubic-beziers.

4. **Sub-300ms UI.** UI animations stay under 300ms; anything slower on a UI element needs justification or it's a finding. Per-element budgets live in [STANDARDS.md](#reference-standards).

5. **Origin & physical correctness.** Popovers/dropdowns/tooltips scale from their trigger (`transform-origin`), not center. Never animate from `scale(0)` — start from `scale(0.9–0.97)` + opacity (Modals are exempt — they stay centered.)

6. **Interruptibility.** Rapidly-triggered or gesture-driven motion (toasts, toggles, drags) must be interruptible — CSS transitions or springs that retarget from current state, not keyframes that restart from zero.

7. **GPU-only properties.** Animate `transform` and `opacity` only. Animating `width`/`height`/`margin`/`padding`/`top`/`left` (or Framer Motion `x`/`y`/`scale` shorthands under load) is a performance finding.

8. **Accessibility.** `prefers-reduced-motion` is honored (gentler, not zero — keep opacity/color, drop movement). Hover animations are gated behind `@media (hover: hover) and (pointer: fine)`.

9. **Asymmetric enter/exit.** Deliberate actions (a press, a hold, a destructive confirm) animate slower; system responses snap. Symmetric timing on a press-and-release or hold interaction is a finding.

10. **Cohesion.** Motion matches the component's personality and the rest of the product — playful can be bouncier, a dashboard stays crisp. Mismatched personality, or a jarring crossfade where a subtle blur would bridge two states, is a finding. When unsure whether motion feels right, the strongest move is often to delete it.

## Aggressive Escalation Triggers

Flag these on sight, hard:

- `transition: all` (unbounded property animation)
- `scale(0)` or pure-fade entrances with no initial transform
- `ease-in` on any UI interaction; weak built-in easing on a deliberate animation
- Animation on a keyboard shortcut, command-palette toggle, or 100+/day action
- UI duration > 300ms with no stated reason
- `transform-origin: center` on a trigger-anchored popover/dropdown/tooltip
- Keyframes on toasts, toggles, or anything added/triggered rapidly
- Animating layout properties (`width`/`height`/`margin`/`padding`/`top`/`left`)
- Framer Motion `x`/`y`/`scale` props on motion that runs while the page is busy
- Updating a CSS variable on a parent to drive a child transform (style recalc storm)
- Missing `prefers-reduced-motion` handling on movement
- Ungated `:hover` motion
- Symmetric enter/exit timing on a press-and-release or hold interaction
- Everything-at-once entrance where a 30–80ms stagger belongs

## Remedial Preference Hierarchy

When proposing fixes, prefer earlier moves over later ones:

1. **Delete the animation** (high-frequency / no purpose / keyboard-triggered).
2. **Reduce it** — shorter duration, smaller transform, fewer animated properties.
3. **Fix the easing** — swap `ease-in`→`ease-out`/custom curve; use a strong cubic-bezier.
4. **Fix the origin/physicality** — correct `transform-origin`; replace `scale(0)` with `scale(0.95)`+opacity.
5. **Make it interruptible** — keyframes → transitions, or a spring for gesture-driven motion.
6. **Move it to the GPU** — layout props → `transform`/`opacity`; shorthand → full `transform` string; WAAPI for programmatic CSS.
7. **Asymmetric timing** — slow the deliberate phase, snap the response.
8. **Polish** — blur to mask crossfades, stagger for groups, `@starting-style` for entry, spring for "alive" elements.
9. **Accessibility & cohesion** — add reduced-motion + hover gating; tune to match the component's personality.

## Required Output Format

Two parts, in this order.

### Part 1 — Findings table (REQUIRED)

A single markdown table. One row per issue. Never a "Before:/After:" list.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Specify exact properties; `all` animates unintended properties off-GPU |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing appears from nothing — `scale(0)` looks like it came from nowhere |
| `ease-in` on dropdown | `ease-out` + custom curve | `ease-in` delays the moment the user watches most; feels sluggish |
| `transform-origin: center` on popover | `var(--radix-popover-content-transform-origin)` | Popovers scale from their trigger, not center (modals are exempt) |

### Part 2 — Verdict (REQUIRED)

Group remaining commentary by impact tier, highest first. Omit empty tiers.

1. **Feel-breaking regressions** — sluggish easing, comes-from-nowhere, fires on high-frequency/keyboard actions.
2. **Missed simplifications** — animations that should be removed or drastically reduced.
3. **Performance** — non-GPU properties, dropped-frame risks, recalc storms.
4. **Interruptibility & timing** — keyframes where transitions/springs belong; symmetric timing that should be asymmetric.
5. **Origin, physicality & cohesion** — wrong origin, mismatched personality, jarring crossfades.
6. **Accessibility** — reduced-motion and pointer/hover gating.

Close with an explicit decision:

- **Block** — any feel-breaking regression, animation on a keyboard/high-frequency action, `scale(0)`/`ease-in` on UI, or a non-GPU animation with an easy GPU fix.
- **Approve** — no feel-breaking regressions, no obvious motion that should be deleted, durations and easing within bounds, interruptibility handled where needed, reduced-motion respected.

Be specific and cite `file:line`. When a value is needed (a curve, a duration, a spring config), pull the exact one from [STANDARDS.md](#reference-standards) rather than approximating.

## Guidelines

- Prefer CSS transitions/`@starting-style`/WAAPI for predetermined motion; JS/springs for dynamic, interruptible, gesture-driven motion.
- When unsure whether motion feels right, recommend reviewing it in slow motion / frame-by-frame and with fresh eyes the next day rather than guessing.


---

<a id="reference-standards"></a>

## Reference: STANDARDS.md

# Animation Standards Reference

The precise values, curves, and rules behind the review. Cite these in findings instead of approximating. Distilled from Emil Kowalski's design engineering philosophy ([animations.dev](https://animations.dev/)).

## Should it animate? (frequency table)

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command palette toggle) | No animation. Ever. |
| Tens of times/day (hover effects, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, feedback, celebrations) | Can add delight |

**Never animate keyboard-initiated actions** — they repeat hundreds of times daily; animation makes them feel slow and disconnected. (Raycast has no open/close animation — correct for something used hundreds of times a day.)

Valid purposes for motion: spatial consistency, state indication, explanation, feedback, preventing jarring change. "It looks cool" on a frequently-seen element is not valid.

## Easing

Decision order:
- Entering or exiting → **`ease-out`** (starts fast, feels responsive)
- Moving / morphing on screen → **`ease-in-out`**
- Hover / color change → **`ease`**
- Constant motion (marquee, progress) → **`linear`**
- Default → **`ease-out`**

**Never `ease-in` on UI.** It starts slow, delaying the exact moment the user is watching. `ease-out` at 200ms *feels* faster than `ease-in` at 200ms.

Built-in CSS easings are too weak. Use strong custom curves:

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out for UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer curve (Ionic) */
```

Find curves at [easing.dev](https://easing.dev/) or [easings.co](https://easings.co/) — don't hand-roll from scratch.

## Duration

| Element | Duration |
| --- | --- |
| Button press feedback | 100–160ms |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms |
| Modals, drawers | 200–500ms |
| Marketing / explanatory | Can be longer |

**Rule: UI animations stay under 300ms.** A 180ms dropdown feels more responsive than a 400ms one. Faster spinners make load feel faster (same actual time). Instant tooltips after the first (skip delay + animation) make a toolbar feel faster.

## Physicality

- **Never `scale(0)`.** Start from `scale(0.9–0.97)` + `opacity: 0`. Nothing in the real world appears from nothing.
- **Origin-aware popovers.** Scale from the trigger, not center:
  ```css
  .popover { transform-origin: var(--radix-popover-content-transform-origin); } /* Radix */
  .popover { transform-origin: var(--transform-origin); }                       /* Base UI */
  ```
  **Modals are exempt** — they appear centered in the viewport, keep `transform-origin: center`.
- **Button press feedback.** `transform: scale(0.97)` on `:active`, `transition: transform 160ms ease-out`. Subtle (0.95–0.98). Applies to any pressable element.

## Springs

Feel natural because they simulate physics; no fixed duration — they settle on parameters. Use for: drag with momentum, "alive" elements (Dynamic Island), interruptible gestures, decorative mouse-tracking.

```js
// Apple-style (easier to reason about) — recommended
{ type: "spring", duration: 0.5, bounce: 0.2 }

// Traditional physics (more control)
{ type: "spring", mass: 1, stiffness: 100, damping: 10 }
```

Keep bounce subtle (0.1–0.3); avoid bounce in most UI — reserve for drag-to-dismiss and playful interactions. Springs maintain velocity when interrupted (keyframes restart from zero), so they're ideal for gestures users may reverse mid-motion.

Mouse interactions: interpolate with `useSpring` rather than tying value directly to mouse position (direct = artificial, no momentum). Only do this when the motion is decorative.

## Interruptibility

CSS **transitions** can be interrupted and retargeted mid-animation; **keyframes** restart from zero. For anything triggered rapidly (toasts being added, toggles), transitions are smoother.

```css
/* Interruptible — good for dynamic UI */
.toast { transition: transform 400ms ease; }

/* Not interruptible — avoid for dynamic UI */
@keyframes slideIn { from { transform: translateY(100%); } to { transform: translateY(0); } }
```

Use `@starting-style` for entry without JS:

```css
.toast {
  opacity: 1; transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;
  @starting-style { opacity: 0; transform: translateY(100%); }
}
```

Legacy fallback: `useEffect(() => setMounted(true), [])` + `data-mounted` attribute.

## Asymmetric timing

Slow where the user is deciding, fast where the system responds.

```css
.overlay { transition: clip-path 200ms ease-out; }            /* release: fast */
.button:active .overlay { transition: clip-path 2s linear; }  /* press: slow, deliberate */
```

## Performance

- **Only animate `transform` and `opacity`** — they skip layout/paint and run on the GPU. `padding`/`margin`/`height`/`width`/`top`/`left` trigger all three rendering steps.
- **Don't drive child transforms via a CSS variable on the parent** — it recalcs styles for all children. Set `transform` directly on the element.
  ```js
  element.style.setProperty('--swipe-amount', `${d}px`); // bad: recalc on all children
  element.style.transform = `translateY(${d}px)`;        // good: only this element
  ```
- **Framer Motion shorthands are NOT hardware-accelerated.** `x`/`y`/`scale` run on the main thread via rAF and drop frames under load. Use the full transform string:
  ```jsx
  <motion.div animate={{ x: 100 }} />                          // drops frames under load
  <motion.div animate={{ transform: "translateX(100px)" }} />  // hardware accelerated
  ```
- **CSS animations beat JS under load** — they run off the main thread; rAF-based animations stutter while the browser loads/scripts/paints. Use CSS for predetermined motion, JS for dynamic/interruptible.
- **WAAPI** gives JS control with CSS performance (hardware-accelerated, interruptible, no library):
  ```js
  element.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }],
    { duration: 1000, fill: 'forwards', easing: 'cubic-bezier(0.77, 0, 0.175, 1)' });
  ```

## Transforms & clip-path

- **`translate` percentages** are relative to the element's own size — `translateY(100%)` moves by the element's height regardless of dimensions (how Sonner/Vaul position toasts/drawers). Prefer over hardcoded px.
- **`scale()` scales children too** (font, icons, content) — a feature for press feedback.
- **3D**: `rotateX/Y` + `transform-style: preserve-3d` for depth/orbit/flip without JS.
- **`clip-path: inset(t r b l)`** is a powerful animation tool: each value eats in from that side. Uses: reveal-on-scroll (`inset(0 0 100% 0)` → `inset(0 0 0 0)`), hold-to-delete overlay, seamless tab color transitions (duplicate + clip the active copy), comparison sliders.

## Gestures & drag

- **Momentum dismissal**: don't require crossing a distance threshold — compute velocity (`Math.abs(distance)/elapsedMs`); dismiss if `> ~0.11`. A flick should be enough.
- **Damping at boundaries**: dragging past a natural edge moves less the further you go (real things slow before stopping).
- **Pointer capture** once dragging starts, so it continues when the pointer leaves bounds.
- **Multi-touch protection**: ignore extra touch points after the drag begins (`if (isDragging) return`) — prevents jumps.
- **Friction over hard stops** — allow over-drag with rising resistance rather than an invisible wall.

## Masking imperfect crossfades

When a crossfade shows two overlapping states despite tuning easing/duration, add subtle `filter: blur(2px)` during the transition to blend them into one perceived transformation. Keep blur < 20px (heavy blur is expensive, especially Safari).

## Stagger

Stagger group entrances; 30–80ms between items. Longer delays feel slow. Stagger is decorative — never block interaction while it plays.

```css
.item { opacity: 0; transform: translateY(8px); animation: fadeIn 300ms ease-out forwards; }
.item:nth-child(2) { animation-delay: 50ms; }
.item:nth-child(3) { animation-delay: 100ms; }
@keyframes fadeIn { to { opacity: 1; transform: translateY(0); } }
```

## Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; } /* keep opacity/color, drop transform-based motion */
}
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.05); } /* gate hover motion — touch fires false hovers on tap */
}
```

```jsx
const reduce = useReducedMotion();
const closedX = reduce ? 0 : '-100%';
```

Reduced motion means fewer and gentler animations, not zero — keep transitions that aid comprehension, remove movement/position changes.

## Debugging (recommend in reviews when feel is uncertain)

- **Slow motion**: bump duration 2–5× or use DevTools animation inspector. Check colors crossfade cleanly, easing doesn't stop abruptly, `transform-origin` is right, coordinated properties stay in sync.
- **Frame-by-frame**: Chrome DevTools Animations panel reveals timing drift between coordinated properties.
- **Real devices** for gestures (drawers, swipe) — connect a phone, hit the dev server by IP, use Safari remote devtools.
- **Fresh eyes next day** — imperfections invisible during development surface later.

## Cohesion

Match motion to the component's personality: playful can be bouncier; a professional dashboard should be crisp and fast. Sonner feels right partly because easing, duration, design, and even the name are in harmony — slightly slower, `ease` rather than `ease-out`, to feel elegant. Opacity + height in entering/exiting lists is trial and error; there's no formula — adjust until it feels right.
