---
name: design-system-and-components
description: Build a token-driven, accessible, reusable component system (design tokens, primitives, composite components) so a client site stays visually consistent and maintainable as it grows.
---

# Design System & Component Build

You are turning an approved visual direction into a coded system a team can extend without drift. The goal is that the tenth page looks like the first with no extra effort, and a color change is one edit, not fifty.

## Tokens first — the single source of truth

Never hard-code a hex, pixel, or font name in a component. Define tokens as CSS custom properties (or the framework's token layer) in three tiers:

1. **Primitive tokens** — raw values: `--blue-500: #3b6ef5`, `--space-4: 1rem`, `--font-sans`. No semantics.
2. **Semantic tokens** — intent-mapped: `--color-bg`, `--color-text`, `--color-accent`, `--color-border`, `--color-danger`. Components consume *only* these.
3. **Component tokens** — optional, for one-off overrides: `--button-bg: var(--color-accent)`.

This indirection is what makes theming and dark mode a single-file change. Dark mode = remap semantic tokens under `[data-theme="dark"]`, components untouched. Build a **type scale** (a modular ratio, e.g. 1.25) and a **spacing scale** (a 4px or 8px base — never arbitrary values like `13px`). Reject any value not on the scale; that's how "close enough" spacing becomes visual chaos.

## Component hierarchy

Build bottom-up. **Primitives**: Button, Input, Text/Heading, Icon, Link, Badge, Box/Stack layout primitives. **Composites**: Card, FormField (label+input+error), Nav, Modal, Accordion, Tabs. **Sections**: Hero, FeatureGrid, Testimonial, CTA, Footer — page-level blocks assembled from composites. Each component has: a single responsibility, a documented prop API, sensible defaults, and variants via a controlled prop (`variant="primary|secondary|ghost"`, `size="sm|md|lg"`) — not via ad-hoc className soup. Use a variant utility (CVA, or equivalent) so the allowed combinations are explicit and typed.

## Accessibility is not optional — build it in

- Every interactive element is a real semantic element: `<button>` for actions, `<a href>` for navigation. Never `<div onClick>`.
- Full keyboard operability: visible focus rings (never `outline: none` without a replacement), logical tab order, Escape closes overlays, focus trap in modals, focus returned to trigger on close.
- ARIA only where semantics fall short: `aria-expanded` on disclosure triggers, `aria-current` on active nav, `role="dialog"` + `aria-modal` + labelled title on modals. Prefer native elements over ARIA every time.
- Color contrast ≥ 4.5:1 for body text, 3:1 for large text and UI boundaries — verify the token palette against WCAG AA before building, not after.
- All imagery has alt text; decorative images get `alt=""`. Form inputs have associated `<label>`s, errors linked via `aria-describedby`.

## State completeness

Every component ships all its states or it's unfinished: default, hover, focus-visible, active, disabled, loading, error, and empty. For data components add the empty state and the error state explicitly — a table with no "no results" state is a bug. Interactive feedback under 100ms; transitions 150–250ms with an ease-out curve; respect `prefers-reduced-motion` by disabling non-essential motion.

## Responsive strategy

Mobile-first: base styles are the small-screen layout, `min-width` media/container queries add complexity upward. Prefer intrinsic layout (Flexbox/Grid, `clamp()` for fluid type, `minmax`/`auto-fit` grids) over a cascade of breakpoints. Test at 320, 768, 1024, 1440. Touch targets ≥ 44×44px. No horizontal scroll at any width.

## Documentation and consistency enforcement

Ship a living reference — a Storybook or a `/styleguide` route rendering every component in every variant and state. This is where design and dev align, and where regressions surface. Add lint rules or a token-lint step that fails the build on raw hex/px values in component files.

## Quality bar

Acceptable: components render, look right on desktop, roughly reusable. **Great**: zero hard-coded values (all tokens), every component keyboard-operable and AA-contrast-passing, all states present, dark mode via token remap only, one styleguide page proving it, and a new page assemblable purely from existing components. Failure modes to reject: `<div>` buttons, `outline:none` with no focus replacement, one-off `margin-top: 37px`, copy-pasted card markup that drifts, and "we'll add the disabled state later." Consistency is the product — a system that lets the team be sloppy has failed regardless of how the demo looks.
