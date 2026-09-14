---
name: onboarding
description: "When the user wants to optimize post-signup onboarding, user activation, first-run experience, or time-to-value. Also use when the user mentions \"onboarding flow,\" \"activation rate,\" \"user activation,\" \"first-run experience,\" \"empty states,\" \"onboarding checklist,\" \"aha moment,\" \"new user experience,\" \"users aren't activating,\" \"nobody completes setup,\" \"low activation rate,\" \"users sign up but don't use the product,\" \"time to value,\" or \"first session experience.\" Use this whenever users are signing up but not sticking around. For signup/registration optimization, see signup. For ongoing email sequences, see emails."
source: https://github.com/coreyhaines31/marketingskills/blob/d4ff28a/skills/onboarding/SKILL.md
license: MIT
attribution: Corey Haines — github.com/coreyhaines31/marketingskills (MIT)
---

<!-- HARVESTED, NOT WRITTEN HERE. 4 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

# Onboarding CRO

You are an expert in user onboarding and activation. Your goal is to help users reach their "aha moment" as quickly as possible and establish habits that lead to long-term retention.

## Initial Assessment

**Check for product marketing context first:**
If `.agents/product-marketing.md` exists (or `.claude/product-marketing.md`, or the legacy `product-marketing-context.md` filename, in older setups), read it before asking questions. Use that context and only ask for information not already covered or specific to this task.

Before providing recommendations, understand:

1. **Product Context** - What type of product? B2B or B2C? Core value proposition?
2. **Activation Definition** - What's the "aha moment"? What action indicates a user "gets it"?
3. **Current State** - What happens after signup? Where do users drop off?

---

## Core Principles

### 1. Time-to-Value Is Everything
Remove every step between signup and experiencing core value. Design the **Minimum Path to Value (MPTV)** — the least number of steps to experience enough value to make a confident decision (see [references/minimum-path-to-value.md](#reference-references-minimum-path-to-value)).

### 2. One Goal Per Session
Focus first session on one successful outcome. Save advanced features for later.

### 3. Do, Don't Show
Interactive > Tutorial. Doing the thing > Learning about the thing.

### 4. Progress Creates Motivation
Show advancement. Celebrate completions. Make the path visible. (See onboarding psychology below for the mechanisms.)

---

## Onboarding Psychology

The principles that make progress mechanics, checklists, and prompts actually work:

- **Endowed Progress Effect** — people finish faster when progress is already started for them. A checklist that opens at "20% done" (a step pre-completed on their behalf) drives roughly **+40% completion** vs. starting at 0%. Give users a head start, don't make them start from nothing.
- **Peak-End Rule** — users remember an experience by its most intense moment (the *peak*) and its *end*, not the average. Engineer a clear high point (a win, a wow, a celebration) and end each session on a positive note.
- **Goldilocks Rule** — motivation peaks when a task is neither too easy nor too hard, but *just right* on the edge of ability. Tune early steps so they're achievable but not trivial.
- **BJ Fogg Behavior Model** — a behavior happens only when **Motivation × Ability × Prompt** converge at the same moment. If a step isn't happening, one of the three is missing: raise motivation, make it easier (Ability), or add a better-timed Prompt.
- **Mario Kart boosters & blockers** (Ramli John) — treat onboarding like a race track. Add **boosters** (accelerants: pre-filled data, templates, quick wins, celebrations) and remove **blockers** (friction: required fields, dead ends, confusing empty states). Speed users toward value and clear obstacles from the lane.

## Onboarding Toolkit (10 Components)

The components you assemble an onboarding experience from. Use the fewest that reach value:

| Component | Purpose |
|-----------|---------|
| Welcome forms | Capture role/goal to personalize the path (keep short — Hick's Law) |
| Initial screens | First-run screens that orient and point to one clear action |
| Drip emails | Multi-touch nurture — **one concept per email**, don't overload |
| Skippable tutorials | Optional guidance users can bypass — never trap them |
| Videos | Show complex workflows visually |
| Docs / help center | Self-serve reference for when users get stuck |
| Onboarding calls | Human touch for complex or high-value accounts |
| Data inputs | Getting the user's real data in so value feels "real" |
| Checklists | Ordered, value-first steps with visible progress (see below) |
| Empty states | Guided first-action opportunities, not dead ends (see below) |

---

## Defining Activation

**Judge activation by lead→customer conversion + 90-day retention, not lead volume.** More signups mean nothing if they don't convert and stick.

Choose an **activation model** (freemium, free trial, paid trial, money-back, consultation) before designing the flow — the model shapes the whole onboarding path. See [references/activation-models.md](#reference-references-activation-models) for the 5 models, the credit-card tradeoff, Model-Market Fit, and the Evernote-vs-Notion parable.

### Find Your Aha Moment

The action that correlates most strongly with retention:
- What do retained users do that churned users don't?
- What's the earliest indicator of future engagement?

**Examples by product type:**
- Project management: Create first project + add team member
- Analytics: Install tracking + see first report
- Design tool: Create first design + export/share
- Marketplace: Complete first transaction

### Activation Metrics
- % of signups who reach activation
- Time to activation
- Steps to activation
- Activation by cohort/source

---

## Onboarding Flow Design

### Immediate Post-Signup (First 30 Seconds)

| Approach | Best For | Risk |
|----------|----------|------|
| Product-first | Simple products, B2C, mobile | Blank slate overwhelm |
| Guided setup | Products needing personalization | Adds friction before value |
| Value-first | Products with demo data | May not feel "real" |

**Whatever you choose:**
- Clear single next action
- No dead ends
- Progress indication if multi-step

### Onboarding Checklist Pattern

**When to use:**
- Multiple setup steps required
- Product has several features to discover
- Self-serve B2B products

**Best practices:**
- 3-7 items (not overwhelming)
- Order by value (most impactful first)
- Start with quick wins
- Progress bar/completion %
- Celebration on completion
- Dismiss option (don't trap users)

### Empty States

Empty states are onboarding opportunities, not dead ends.

**Good empty state:**
- Explains what this area is for
- Shows what it looks like with data
- Clear primary action to add first item
- Optional: Pre-populate with example data

### Tooltips and Guided Tours

**When to use:** Complex UI, features that aren't self-evident, power features users might miss

**Best practices:**
- Max 3-5 steps per tour
- Dismissable at any time
- Don't repeat for returning users

---

## Multi-Channel Onboarding

### Email + In-App Coordination

**Trigger-based emails:**
- Welcome email (immediate)
- Incomplete onboarding (24h, 72h)
- Activation achieved (celebration + next step)
- Feature discovery (days 3, 7, 14)

**Email should:**
- Reinforce in-app actions, not duplicate them
- Drive back to product with specific CTA
- Be personalized based on actions taken

---

## Handling Stalled Users

### Detection
Define "stalled" criteria (X days inactive, incomplete setup)

### Re-engagement Tactics

1. **Email sequence** - Reminder of value, address blockers, offer help
2. **In-app recovery** - Welcome back, pick up where left off
3. **Human touch** - For high-value accounts, personal outreach

---

## Measurement

### Key Metrics

| Metric | Description |
|--------|-------------|
| Activation rate | % reaching activation event |
| Time to activation | How long to first value |
| Onboarding completion | % completing setup |
| Day 1/7/30 retention | Return rate by timeframe |

### Funnel Analysis

Track drop-off at each step:
```
Signup → Step 1 → Step 2 → Activation → Retention
100%      80%       60%       40%         25%
```

Identify biggest drops and focus there.

---

## Output Format

### Onboarding Audit
For each issue: Finding → Impact → Recommendation → Priority

### Onboarding Flow Design
- Activation goal
- Step-by-step flow
- Checklist items (if applicable)
- Empty state copy
- Email sequence triggers
- Metrics plan

---

## Common Patterns by Product Type

| Product Type | Key Steps |
|--------------|-----------|
| B2B SaaS | Setup wizard → First value action → Team invite → Deep setup |
| Marketplace | Complete profile → Browse → First transaction → Repeat loop |
| Mobile App | Permissions → Quick win → Push setup → Habit loop |
| Content Platform | Follow/customize → Consume → Create → Engage |

---

## Experiment Ideas

When recommending experiments, consider tests for:
- Flow simplification (step count, ordering)
- Progress and motivation mechanics
- Personalization by role or goal
- Support and help availability

**For comprehensive experiment ideas**: See [references/experiments.md](#reference-references-experiments)

---

## References

- **[references/minimum-path-to-value.md](#reference-references-minimum-path-to-value)** — MPTV, Hick's Law, the inventory→remove→reconstruct process, abandonment benchmarks (40–60% after one session; 75–80% within day one), and patterns (Stripe, Calendly, Notion).
- **[references/activation-models.md](#reference-references-activation-models)** — the 5 activation models, credit-card tradeoff, Model-Market Fit, Evernote vs. Notion.
- **[references/experiments.md](#reference-references-experiments)** — comprehensive A/B test and experiment ideas.

---

## Task-Specific Questions

1. What action most correlates with retention?
2. What happens immediately after signup?
3. Where do users currently drop off?
4. What's your activation rate target?
5. Do you have cohort analysis on successful vs. churned users?

---

## Related Skills

- **signup**: For optimizing the signup before onboarding
- **emails**: For onboarding email series
- **paywalls**: For converting to paid during/after onboarding
- **ab-testing**: For testing onboarding changes


---

<a id="reference-references-minimum-path-to-value"></a>

## Reference: references/minimum-path-to-value.md

# Minimum Path to Value (MPTV)

**Minimum Path to Value (MPTV)** — the least number of steps to experience *enough* value to make a confident decision.

Not the fastest path to *any* value, and not the full feature tour. It's the shortest route to a moment that's convincing enough for the user to decide "yes, this is for me." Everything else waits.

## Why fewer steps win: Hick's Law

**Hick's Law** — the time and effort to make a decision grows with the number and complexity of choices. Every step, field, and option in onboarding is another decision. More decisions = more hesitation, more drop-off.

MPTV is the deliberate application of Hick's Law to onboarding: strip the path down to the fewest decisions required to reach value.

## The abandonment reality

You have far less time and patience than you think:

- **40–60% of users who sign up for a free trial abandon after a single session** — and never return.
- **75–80% of trial abandonment happens within the first day.**

The decision to stick or bail is made almost immediately. If value isn't reached in the first session, most users are already gone. MPTV exists because the window is that small.

## The process: inventory → remove → reconstruct

Build (or fix) your MPTV in three passes:

1. **Take inventory.** List *every* step between signup and value — every screen, form field, click, confirmation, permission prompt, and empty state. Be exhaustive and honest. Most teams underestimate their own step count by half.

2. **Remove the nonessential.** For each step ask: does the user *have* to do this to reach value right now? If not, cut it, defer it, pre-fill it, or make it skippable. Default to removal. Configuration, profile completeness, advanced settings, and "nice to know" education are almost never essential to first value.

3. **Reconstruct / iterate.** Rebuild the path with only what survived, in value-first order. Then measure and iterate — the first reconstruction is a hypothesis, not a finish line. Watch where users still stall and cut again.

## Benchmark patterns

Products with famously short paths to value:

| Product | MPTV pattern |
|---------|--------------|
| **Stripe** | Get a working payment integration in **~7 lines of code / ~60% activation** — value (a real charge) before any account polish. |
| **Calendly** | **3-step** setup to a shareable, working booking link. Value is a link you can send immediately. |
| **Notion** | **Progressive disclosure** — starts nearly empty, reveals features only as the user needs them. The path to first value (a written page) is trivial; depth unfolds later. |

The pattern across all three: reach a real, usable outcome fast, and hide complexity until it's asked for.

## Applying it

- Define the value moment first (the aha moment — see SKILL.md). MPTV is the path *to* that moment.
- Count your current steps before optimizing. You can't remove what you haven't inventoried.
- Treat every retained step as guilty until proven essential.
- Measure step-completion and time-to-value after each reconstruction; the abandonment stats mean your margin for error is one session.



---

<a id="reference-references-activation-models"></a>

## Reference: references/activation-models.md

# Activation Models

The activation model is *how* you let a user experience value before they pay. It shapes signup volume, conversion, and the entire onboarding path. Pick the model before you design the flow.

## The 5 activation models

### 1. Freemium
A free tier that never expires, with paid tiers for more capacity or features.

- Best when: the free tier delivers real value *and* naturally hits limits that motivate upgrading.
- Risk: give away too much and users never need to pay (see Evernote below).

### 2. Free trial
Full (or near-full) access for a fixed window: **3, 7, 14, or 30 days**.

- Shorter trials create urgency and force faster time-to-value; longer trials suit complex products with longer setup.
- **Credit-card requirement is the key lever**: requiring a card up front **cuts signups by 50–70%**, but the users who do sign up **convert 2–3× better**. Fewer, higher-intent leads vs. more, lower-intent leads — choose based on your funnel goals.

### 3. Paid trial
A low-cost paid entry, typically **$7–10 for 7 days**.

- Filters out tire-kickers while lowering the barrier vs. full price.
- Signals seriousness on both sides and pre-collects payment details.

### 4. Money-back guarantee
Charge full price up front, with a no-questions refund window.

- Removes purchase risk without giving anything away for free.
- Works when the product delivers value quickly enough to beat the refund window.

### 5. Consultation / white-glove
A human conversation (demo, call, or hands-on setup) gates access — the **Superhuman** model.

- Best for high-touch, high-price, or complex products where a human ensures the user reaches value.
- Doesn't scale cheaply, but converts and retains well when done right.

## Model-Market Fit

**Model-Market Fit (Brian Balfour): "your market dictates your model."**

You don't get to freely choose your activation model — your market chooses it for you. Price point, buyer sophistication, sales complexity, time-to-value, and competitor norms all constrain what will work. A self-serve $20/mo tool and a $50k enterprise platform cannot use the same model. Match the model to the market before optimizing the onboarding inside it.

## The Evernote vs. Notion parable

Two lessons on how much to give away:

- **Evernote — gave away too much free.** The free tier was generous enough that most users never needed to upgrade. Free was a destination, not a doorway. Growth without matching monetization.
- **Notion — hook, then limit.** Let users experience real value, then hit meaningful limits (blocks, members, features) that create a natural, well-timed reason to pay.

The principle: **the free experience should hook, not satisfy.** Give enough value to prove the product and build the habit — but structure the limits so that continued value requires upgrading.

## Choosing

1. Start from your market (Model-Market Fit), not your preference.
2. Decide the card-vs-no-card tradeoff explicitly: volume of leads vs. quality of leads.
3. Design the free/trial experience to hook and then limit — never to fully satisfy.
4. Whatever the model, the onboarding inside it still needs the shortest possible path to value (see [minimum-path-to-value.md](#reference-references-minimum-path-to-value)).



---

<a id="reference-references-experiments"></a>

## Reference: references/experiments.md

# Onboarding Experiment Ideas

Comprehensive list of A/B tests and experiments for user onboarding and activation.

## Contents
- Flow Simplification Experiments (reduce friction, step sequencing, progress & motivation)
- Guided Experience Experiments (product tours, CTA optimization, UI guidance)
- Personalization Experiments (user segmentation, dynamic content)
- Quick Wins & Engagement Experiments (time-to-value, motivation mechanics, support & help)
- Email & Multi-Channel Experiments (onboarding emails, email content, feedback loops)
- Re-engagement Experiments (stalled user recovery, return experience)
- Technical & UX Experiments (performance, mobile onboarding, accessibility)
- Metrics to Track

## Flow Simplification Experiments

### Reduce Friction

| Test | Hypothesis |
|------|------------|
| Email verification timing | During vs. after onboarding |
| Empty states vs. dummy data | Pre-populated examples |
| Pre-filled templates | Accelerate setup with templates |
| OAuth options | Faster account linking |
| Required step count | Fewer required steps |
| Optional vs. required fields | Minimize requirements |
| Skip options | Allow bypassing non-critical steps |

### Step Sequencing

| Test | Hypothesis |
|------|------------|
| Step ordering | Test different sequences |
| Value-first ordering | Highest-value features first |
| Friction placement | Move hard steps later |
| Required vs. optional balance | Ratio of required steps |
| Single vs. branching paths | One path vs. personalized |
| Quick start vs. full setup | Minimal path to value |

### Progress & Motivation

| Test | Hypothesis |
|------|------------|
| Progress bars | Show completion percentage |
| Checklist length | 3-5 items vs. 5-7 items |
| Gamification | Badges, rewards, achievements |
| Completion messaging | "X% complete" visibility |
| Starting point | Begin at 20% vs. 0% |
| Celebration moments | Acknowledge completions |

---

## Guided Experience Experiments

### Product Tours

| Test | Hypothesis |
|------|------------|
| Interactive tours | Tools like Navattic, Storylane |
| Tooltip vs. modal guidance | Subtle vs. attention-grabbing |
| Video tutorials | For complex workflows |
| Self-paced vs. guided | User control vs. structured |
| Tour length | Shorter vs. comprehensive |
| Tour triggering | Automatic vs. user-initiated |

### CTA Optimization

| Test | Hypothesis |
|------|------------|
| CTA text variations | Action-oriented copy testing |
| CTA placement | Position within screens |
| In-app tooltips | Feature discovery prompts |
| Sticky CTAs | Persist during onboarding |
| CTA contrast | Visual prominence |
| Secondary CTAs | "Learn more" vs. primary only |

### UI Guidance

| Test | Hypothesis |
|------|------------|
| Hotspot highlights | Draw attention to key features |
| Coachmarks | Contextual tips |
| Feature announcements | New feature discovery |
| Contextual help | Help where users need it |
| Search vs. guided | Self-service vs. directed |

---

## Personalization Experiments

### User Segmentation

| Test | Hypothesis |
|------|------------|
| Role-based onboarding | Different paths by role |
| Goal-based paths | Customize by stated goal |
| Role-specific dashboards | Relevant default views |
| Use-case question | Personalize based on answer |
| Industry-specific paths | Vertical customization |
| Experience-based | Beginner vs. expert paths |

### Dynamic Content

| Test | Hypothesis |
|------|------------|
| Personalized welcome | Name, company, role |
| Industry examples | Relevant use cases |
| Dynamic recommendations | Based on user answers |
| Template suggestions | Pre-filled for segment |
| Feature highlighting | Relevant to stated goals |
| Benchmark data | Industry-specific metrics |

---

## Quick Wins & Engagement Experiments

### Time-to-Value

| Test | Hypothesis |
|------|------------|
| First quick win | "Complete your first X" |
| Success messages | After key actions |
| Progress celebrations | Milestone moments |
| Next step suggestions | After each completion |
| Value demonstration | Show what they achieved |
| Outcome preview | What success looks like |

### Motivation Mechanics

| Test | Hypothesis |
|------|------------|
| Achievement badges | Gamification elements |
| Streaks | Consecutive day engagement |
| Leaderboards | Social comparison (if appropriate) |
| Rewards | Incentives for completion |
| Unlock mechanics | Features revealed progressively |

### Support & Help

| Test | Hypothesis |
|------|------------|
| Free onboarding calls | For complex products |
| Contextual help | Throughout onboarding |
| Chat support | Availability during onboarding |
| Proactive outreach | For stuck users |
| Self-service resources | Help docs, videos |
| Community access | Peer support early |

---

## Email & Multi-Channel Experiments

### Onboarding Emails

| Test | Hypothesis |
|------|------------|
| Founder welcome email | Personal vs. generic |
| Behavior-based triggers | Action/inaction based |
| Email timing | Immediate vs. delayed |
| Email frequency | More vs. fewer touches |
| Quick tips format | Short actionable content |
| Video in email | More engaging format |

### Email Content

| Test | Hypothesis |
|------|------------|
| Subject lines | Open rate optimization |
| Personalization depth | Name vs. behavior-based |
| CTA prominence | Single clear action |
| Social proof inclusion | Testimonials in email |
| Urgency messaging | Trial reminders |
| Plain text vs. designed | Format testing |

### Feedback Loops

| Test | Hypothesis |
|------|------------|
| NPS during onboarding | When to ask |
| Blocking question | "What's stopping you?" |
| NPS follow-up | Actions based on score |
| In-app feedback | Thumbs up/down on features |
| Survey timing | When to request feedback |
| Feedback incentives | Reward for completing |

---

## Re-engagement Experiments

### Stalled User Recovery

| Test | Hypothesis |
|------|------------|
| Re-engagement email timing | When to send |
| Personal outreach | Human vs. automated |
| Simplified path | Reduced steps for returners |
| Incentive offers | Discount or extended trial |
| Problem identification | Ask what's blocking |
| Demo offer | Live walkthrough |

### Return Experience

| Test | Hypothesis |
|------|------------|
| Welcome back message | Acknowledge return |
| Progress resume | Pick up where left off |
| Changed state | What happened while away |
| Re-onboarding | Fresh start option |
| Urgency messaging | Trial time remaining |

---

## Technical & UX Experiments

### Performance

| Test | Hypothesis |
|------|------------|
| Load time optimization | Faster = higher completion |
| Progressive loading | Perceived performance |
| Offline capability | Mobile experience |
| Error handling | Graceful failure recovery |

### Mobile Onboarding

| Test | Hypothesis |
|------|------------|
| Touch targets | Size and spacing |
| Swipe navigation | Mobile-native patterns |
| Screen count | Fewer screens needed |
| Input optimization | Mobile-friendly forms |
| Permission timing | When to ask |

### Accessibility

| Test | Hypothesis |
|------|------------|
| Screen reader support | Accessibility impact |
| Keyboard navigation | Non-mouse users |
| Color contrast | Visibility |
| Font sizing | Readability |

---

## Metrics to Track

For all experiments, measure:

| Metric | Description |
|--------|-------------|
| Activation rate | % reaching activation event |
| Time to activation | Hours/days to first value |
| Step completion rate | % completing each step |
| Drop-off points | Where users abandon |
| Return rate | Users who come back |
| Day 1/7/30 retention | Engagement over time |
| Feature adoption | Which features get used |
| Support requests | Volume during onboarding |
