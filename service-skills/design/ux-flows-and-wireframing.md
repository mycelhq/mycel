---
name: ux-flows-and-wireframing
description: Turn a product or site goal into user flows, information hierarchy, and wireframes — structure and interaction before visual design — so the thing is usable before it's decorated.
---

# UX Flows & Wireframing

You are designing how something *works* before how it *looks*. Structure decisions made here are expensive to change later, so resolve them in low fidelity where iteration is cheap. Grayscale boxes force the client (and you) to argue about content, hierarchy, and flow instead of color.

## Ground in goals and users

Start by extracting the real objectives: the **business goal** (what conversion/outcome the client needs), the **user goals** (the jobs people come to accomplish), and where those align or conflict. Identify the primary user(s) and their context — device, urgency, expertise, mindset. If you have no research, run lightweight discovery: competitor teardown, and if possible 3–5 user interviews or a review of support tickets/analytics for where people actually struggle. Design for the primary task first; secondary tasks must not crowd it out.

## Map flows before screens

Draw the **user flows** as diagrams: entry point → each decision/step → success state, including the unhappy paths (errors, empty states, drop-off recovery). For each key task, count the steps and ruthlessly remove any that don't earn their place — every extra field or click leaks conversion. Map the critical journeys end to end (e.g. discover → evaluate → sign up → activate). Flow diagrams expose missing states and dead ends before you've drawn a single screen — that's their entire value. Name every state a screen can be in: loading, empty, error, partial, ideal, and overloaded (lots of data).

## Information hierarchy per screen

For each screen, decide before laying anything out: what is the **one** primary action, what's the supporting information, and what's optional/hidden. Apply visual-hierarchy logic even in wireframes — size, position, and grouping signal importance. Use real or realistic content, never "lorem ipsum" for critical labels and headlines; fake content hides real problems (a nav label that's too long, a headline that doesn't fit). Establish a layout grid and consistent regions (nav, content, actions) so the system feels coherent across screens.

## Wireframe at the right fidelity

Start **low-fidelity** (boxes, lines, labels — paper or Figma grayscale) for structure and flow; iterate fast and cheap here. Move to **mid-fidelity** once structure is agreed: real hierarchy, real content, spacing, and component placement, still grayscale to keep focus off aesthetics. Design the **key states and breakpoints** — at minimum mobile and desktop for every important screen, plus the empty/error/loading states, not just the happy path. Annotate interactions: what happens on tap, where this goes, what validates, what's conditional. An un-annotated wireframe is ambiguous and will be built wrong.

## Prototype and test

For anything non-trivial, wire the screens into a clickable prototype (Figma) so the flow can be *experienced*, not just imagined. Run usability checks — even 5 users surfaces the majority of problems. Give tasks ("book an appointment"), watch where they hesitate or fail, and note it. Don't lead them or explain the UI — if you have to explain it, it's not done. Common issues you'll catch: unclear primary action, ambiguous labels, hidden critical functions, too many steps, and no feedback after actions.

## Interaction and usability principles to enforce

- Respect established conventions (nav placement, icon meanings, form patterns) — novelty in interaction costs usability; be novel in brand, conventional in mechanics.
- Provide feedback for every action (loading, success, error). Never leave the user unsure whether something happened.
- Make errors preventable and recoverable — inline validation, undo, confirmation on destructive actions.
- Reduce cognitive load: progressive disclosure, sensible defaults, group related fields, minimize required input.
- Design the empty and error states deliberately — they're where users are most fragile, and they're the states most often forgotten.
- Accessibility from the wire: logical reading/tab order, labelled controls, touch targets ≥ 44px, not relying on color alone.

## Handoff

Deliver: flow diagrams, annotated wireframes for all key screens and states across breakpoints, and a clickable prototype. Annotations must make interaction behavior unambiguous for whoever builds it and whoever designs the visuals on top.

## Quality bar

Acceptable: screens exist and roughly cover the task. **Great**: flows mapped with unhappy paths, every screen has a clear single primary action, all states (empty/loading/error) designed, real content stress-tested the layout, key journeys prototyped and usability-checked with real people, and annotations that leave zero ambiguity for build. Failure modes to reject: jumping to visual design before structure, lorem-ipsum hiding layout problems, only the happy path designed, mystery-meat navigation, no feedback states, and "it's obvious how it works" (it never is — test it).
