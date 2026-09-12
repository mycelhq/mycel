---
name: events
description: "When the user wants to plan, run, sponsor, speak at, or get pipeline from events — webinars, conferences, trade shows, meetups, dinners, workshops, virtual summits, or user conferences. Also use when the user mentions 'event marketing,' 'field marketing,' 'run a webinar,' 'webinar funnel,' 'show-up rate,' 'should we sponsor,' 'sponsor a conference,' 'trade show booth,' 'booth strategy,' 'event ROI,' 'badge scans,' 'event follow-up,' 'speaking slot,' 'CFP,' 'conference talk,' 'host a dinner,' 'user conference,' or 'virtual summit.' Covers all four roles: hosting, sponsoring/exhibiting, speaking, and attending. For product launch moments, see launch. For the partnership side of joint webinars, see co-marketing. For ongoing community programs, see community-marketing. For podcast appearances, see public-relations. For the email sequences themselves, see emails."
source: https://github.com/coreyhaines31/marketingskills/blob/d4ff28a/skills/events/SKILL.md
license: MIT
attribution: Corey Haines — github.com/coreyhaines31/marketingskills (MIT)
---

<!-- HARVESTED, NOT WRITTEN HERE. 5 upstream file(s) flattened into one; every
     relative link rewritten to a section anchor. Edit upstream or edit the harvester —
     a change made here is silently reverted by the next `npm run skills:harvest`. -->

> **Read this first — you are not in a conversation.**
> This procedure was written for someone sitting beside a marketer who could be asked questions.
> You are running unattended on behalf of an agency, for their client. Nobody will answer you.
> Wherever it says to ask, gather or confirm something: take the answer from the intake record and
> the client's own site instead. Anything you still cannot establish becomes a **stated assumption
> in the deliverable**, written where the reader will see it — never a question, and never a
> blocker. A held run helps nobody; a deliverable that says what it assumed can be corrected in a
> sentence.

# Event Marketing

You are an expert in event-driven marketing — using webinars, conferences, dinners, and talks to create pipeline, authority, and compounding content. Your job is to make events produce measurable business outcomes, not just attendance.

## Before Starting

**Check for product marketing context first:**
If `.agents/product-marketing.md` exists (or `.claude/product-marketing.md`, or the legacy `product-marketing-context.md` filename, in older setups), read it before asking questions. Use that context and only ask for information not already covered or specific to this task.

Then establish, in one batch:

1. **Which role?** Hosting your own event, sponsoring/exhibiting at someone else's, speaking, or attending?
2. **What outcome?** Pipeline/meetings, authority/brand, community, or content production? (Pick a primary — events that try to do everything measure nothing.)
3. **Who must be in the room?** The ICP segment, and roughly how many of them exist at this event.
4. **Budget and team** — money, and who can actually work the event.

## Pick Your Role

| You are… | Core motion | Depth |
|---|---|---|
| **Hosting** | Own the audience end to end — webinar, workshop, dinner, meetup, summit, user conference | This file + [webinar-funnel.md](#reference-references-webinar-funnel) for the flagship format |
| **Sponsoring / exhibiting** | Buy access to someone else's audience — evaluate, negotiate, work the floor, follow up | [sponsorship-roi.md](#reference-references-sponsorship-roi) |
| **Speaking** | Trade expertise for stage time — get booked, design the talk, compound the recording | [speaking.md](#reference-references-speaking) |
| **Attending** | No booth, no stage — engineer meetings anyway | Section below |

Mixed roles are normal (sponsor + speak, attend + host a dinner). Plan each role's motion separately; they share the follow-up system.

## Which Events to Invest In (Portfolio First)

Before roles and tactics: events are the most expensive, riskiest, hardest-to-measure channel — the leverage is in **selection**, not execution. Never write off "events" from one bad conference; each event is its own ecosystem (judging all events on one conference is like judging all paid media on a single Google Ads test). Full framework, the three event types, and cost benchmarks in [event-portfolio-strategy.md](#reference-references-event-portfolio-strategy).

- **Is in-person even necessary?** It earns its cost mainly for high-trust, high-ACV motions: enterprise/multi-stakeholder deals, regulated buyers (health/finance/gov), heavy customization, conservative industries, and 6+ month cycles. If your ICP isn't there, spend on digital first.
- **The 80/20 of selection.** A handful of events generate most event pipeline. Find them, double down (speaking slots, side events, more people, better placement), and cut the tail.
- **Bigger isn't better.** Mega-conferences mean more noise, higher cost, and audience dilution (students, press, vendors, tourists). Niche/regional events (50–200 attendees) often deliver more qualified leads per dollar.
- **Three types, three risk profiles:** **Owned** (max control/max risk — roadshows, summits, user conferences), **Trade shows** (someone else's arena — 120 days of prep beats the 4 days on the floor), **Community** (compound interest — small regular gatherings that spawn more, measured by the "Saturday Test").

## The Universal Arc: 20% Event, 80% Before-and-After

The event itself is the smallest part of event marketing. Every format follows the same arc, and most failures are arc failures, not event failures:

**Before (where pipeline is actually made)**
- Build the target list: who's attending that matches your ICP? (Attendee lists, speaker lists, "who's going" posts, past-year attendees.)
- **Book meetings before you arrive.** A meeting booked two weeks out is worth ten hopeful hallway collisions. Outreach angle: specific, low-friction, time-boxed ("15 min at the coffee bar Tuesday").
- Announce your presence where your audience already is (email list, social, communities) with a reason to find you — not "we'll be at booth 402" but what they get.

**During**
- Optimize for *qualified conversations*, not raw contacts. One real conversation with an ICP buyer beats fifty badge scans.
- Capture context, not just contact: after each conversation, record what they said, what they care about, and the agreed next step. The follow-up writes itself from this; without it, follow-up is generic and dies.
- Create content while there (see Content Arc below) — the event is a recording studio you already paid for.

**After (where pipeline is won or lost)**
- **The 24–48 hour window.** Follow up while the conversation is still warm, referencing what was actually discussed. Every day of delay roughly halves response rates (directional, not a law — but the decay is real and fast).
- Tier the follow-up: hot conversations get a personal note + concrete next step; warm get a relevant asset tied to their stated problem; scans-with-no-conversation get one light touch or nothing — don't burn your domain on people who don't remember you.
- Route to systems: CRM with event source tagging (→ **revops**), nurture for the not-nows (→ **emails**).

## Hosting: Choose the Format for the Job

| Format | Best for | Effort | Notes |
|---|---|---|---|
| **Webinar** | Lead gen + education at scale | Low-mid | The flagship repeatable format — full funnel in [webinar-funnel.md](#reference-references-webinar-funnel) |
| **Workshop** | Product-qualified leads, activation | Mid | Hands-on beats presentation for conversion; smaller and deeper than a webinar |
| **Dinner / small gathering** | Exec relationships, ABM accounts | Mid | 8–14 seats, no pitch, curated guest mix — the highest meetings-per-dollar format in B2B |
| **Meetup series** | Local community, recurring presence | Mid | Consistency beats production value; hand hosting duties to community members over time (→ **community-marketing**) |
| **Virtual summit** | List building via partner audiences | High | Multi-speaker = built-in distribution; every speaker promotes (→ **co-marketing** for the partner mechanics) |
| **User conference** | Retention, expansion, category authority | Very high | Don't attempt before you have a community that would attend without being begged |

Two hosting rules that outrank format choice:

- **The topic is the targeting.** "State of [category] 2026" attracts your ICP; "All about [your product]" attracts existing customers only. Pick topics your buyer would attend even if they'd never buy.
- **Recurring beats one-off.** A monthly webinar or quarterly dinner compounds — audiences, promotion muscle, and content libraries build. A single big event evaporates.

## Attending (No Booth, No Stage)

The zero-budget motion, and often the best ROI in the building:

1. **Target list first** — 15–30 named people you want to meet, built from the attendee/speaker list and social chatter.
2. **Pre-book** — outreach 1–3 weeks ahead; the ask is 15 minutes, anchored to a specific time and place.
3. **The side-event play** — host a dinner or breakfast adjacent to the conference for 8–12 target accounts. You get host status without sponsor pricing; often out-generates a booth at a tenth of the cost (see [sponsorship-roi.md](#reference-references-sponsorship-roi)).
4. **Work sessions strategically** — go where your targets are speaking, ask a real question, follow up on it.
5. Same 24–48h follow-up discipline as every other role.

## The Content Arc: Every Event Is a Content Engine

Events produce your highest-proof content — capture it deliberately:

- **Record everything you're allowed to record.** Talks, webinars, panels. The recording is the durable asset; the live audience is just its first viewer.
- **Transcripts compound in AI answers.** Published recordings and show notes get crawled and cited by AI assistants — the same logic as podcast guesting (→ **public-relations** podcast prep) and the YouTube text layer (→ **ai-seo**). Say the quotable lines cleanly: your company name next to your category, numbers out loud.
- Slice the recording: clips (→ **video**), a recap post per session (→ **content-strategy**), pull-quotes for social (→ **social**), proof points for sales (→ **sales-enablement**).
- Photograph/collect social proof: testimonials captured at the event are the most natural you'll ever get.

## Measurement: Pipeline, Not Applause

| Metric tier | Examples | Verdict |
|---|---|---|
| **Vanity** | Registrations, badge scans, foot traffic, impressions | Track, never optimize for, never report as success |
| **Real** | Qualified conversations, meetings booked, opportunities created, pipeline influenced | The actual scoreboard |
| **Decisive** | Cost per qualified meeting, cost per opportunity, closed-won influenced | What decides whether you do it again |

- Compare cost-per-qualified-meeting against your other channels (ads, outbound) — that's the go/no-go math, worked through in [sponsorship-roi.md](#reference-references-sponsorship-roi).
- Events are multi-touch by nature: use source tagging + self-reported attribution ("heard us at X") and influence windows, and never claim last-click credit for a deal the event merely touched (→ **attribution**).
- Judge a recurring event program on a 2–3 event trend, not one instance — the first run of anything underperforms its steady state.

## Common Mistakes

- **Sponsoring for "brand awareness" with no conversation target.** If nobody owns a meetings number, the booth is décor.
- **The follow-up gap.** Leads captured, then first touch two weeks later from a generic sequence. The event was fine; the follow-up killed it.
- **Optimizing show-up rate after picking a topic nobody wants.** Reminder cadence can't save weak demand — fix topic and promise first.
- **One-off thinking.** Budget for the third instance before running the first.
- **Doing the event, skipping the recording.** Full production effort, zero durable assets.
- **Counting badge scans as leads.** A scan is a person who walked slowly. Qualify before it enters the pipeline.
- **Writing off "events" after one bad conference.** Each event is its own ecosystem — judge them individually, not as a single channel.
- **Chasing the biggest conferences.** Size correlates with noise and audience dilution, not ROI — niche and regional events often win on cost-per-qualified-meeting.

## Related Skills

- **launch** — the event is a launch moment (announcement, Product Hunt, go-live)
- **co-marketing** — joint webinars and partner summits: partnership mechanics live there, event execution here
- **community-marketing** — ongoing community programs; events can seed or serve one
- **public-relations** — podcast guesting and press at events
- **lead-magnets** — gated replays and event content as magnets
- **emails** / **sms** — the reminder and follow-up sequences themselves
- **cold-email** — pre-event meeting-booking outreach
- **revops** — routing, scoring, and source-tagging event leads
- **attribution** — measuring multi-touch event influence honestly


---

<a id="reference-references-webinar-funnel"></a>

## Reference: references/webinar-funnel.md

# The Webinar Funnel — Registration → Show-Up → Live-to-Close → Nurture

The webinar is the flagship hosted format because it's the whole event arc in miniature, repeatable monthly, and every stage is measurable. Work the four stages in order — each stage's conversion rate is a separate lever with separate fixes.

**The funnel at a glance** (typical B2B ranges — directional benchmarks, not targets; your own trend line is the real baseline):

| Stage | Metric | Typical range |
|---|---|---|
| Registration page | Visitor → registrant | 30–50% (warm traffic), 10–25% (cold) |
| Show-up | Registrant → attendee | 35–45% live; lower for cold/ads traffic |
| Hold | Attendee stays past minute 40 | 50–70% |
| Convert | Attendee → next step (trial, demo, offer) | 5–15% of attendees for a soft CTA; 1–5% direct purchase |

## Stage 0: Topic & Offer (decided before anything else)

The topic does the targeting and most of the selling:

- **Pick a problem-aware topic, not a product topic.** "How [ICP] does X without Y" out-registers "Intro to [Product]" — the audience you want shows up for their problem, not your roadmap.
- **Name the transformation in the title**: specific outcome + specific audience + (optionally) a number or timeframe. Test titles the way you'd test ad headlines — the title *is* the ad.
- **Decide the offer before writing the content.** What's the next step for an attendee who loved it — trial, demo, audit, purchase? The entire live structure builds toward that one step. A webinar with no decided offer becomes a lecture with an awkward ending.
- One topic, one promise, one offer. Stack more and every rate drops.

## Stage 1: Registration

**The registration page** is a landing page (→ **copywriting** for craft); webinar-specific rules:

- Headline = the promise from the title; subhead = who it's for and what they'll walk away able to do
- 3–5 "you'll learn" bullets written as outcomes, not agenda items
- Speaker credibility in one tight block (why should they listen to *you* on this)
- Date/time with timezone handling; "can't make it? register anyway for the replay" — replay-registrants are real leads
- Short form: name + email (+ one qualifying field max if sales needs it)

**The promo plan** — start 2 weeks out, not 6 (urgency compresses better than it stretches):

- **Email list** — 3 sends: announcement, value-add reminder (share a preview insight), last-call day-of (→ **emails**)
- **Social** — founder/host personal posts outperform brand posts; share the *why this topic now* angle (→ **social**)
- **Partners** — a co-hosted webinar doubles reach for free; partnership mechanics → **co-marketing**, but note: co-hosted registrant lists need explicit consent handling for both parties
- **Paid** — only after the topic is proven organically; retargeting warm traffic to a reg page works, cold-to-webinar ads are an expensive way to buy no-shows (→ **ads**)
- **Speakers' own audiences** — for panels/summits, every speaker promotes; make it effortless (pre-written posts, custom links)

## Stage 2: Show-Up (the hardest metric)

Registrants are cheap; attendance is the funnel's leakiest joint. The show-up system:

- **Calendar add at registration** — the single highest-leverage fix. A registrant with a calendar entry is a different species from one with a confirmation email.
- **Reminder cadence**: confirmation (immediately, with calendar links) → value reminder T-1 day (tease a specific insight, not "don't forget!") → T-1 hour → **T-5 minutes with the join link** (this last one moves attendance more than the rest combined). SMS reminders where consented lift show-up meaningfully (→ **sms**).
- **Close the gap between registration and event.** Show-up decays with distance: someone who registered 6 weeks out has forgotten you existed. If promoting long-range, add a mid-window touchpoint (a related asset, a poll shaping the content).
- **Pre-engagement**: ask a question at registration ("what's your biggest challenge with X?") — you get content input, segmentation data, and a micro-commitment that lifts attendance.
- Time slot: mid-week, late morning or early afternoon in your audience's dominant timezone; avoid Mondays/Fridays. Test against your own data.

## Stage 3: Live-to-Close (sell without being salesy)

The arc that converts without feeling like a pitch:

1. **Open (0–5 min)** — restate the promise, preview the payoff, tell them the offer is coming ("at the end I'll show how we do this — first, the practice you can use regardless"). Naming the pitch upfront *removes* the salesy feeling; the ambush is what people hate.
2. **Content (5–35 min)** — teach the real thing. The #1 conversion lever is genuine value: an attendee who learned something trusts the product behind it. Structure as 3 teachable points, each with a proof (story, number, live example). Use attendee questions/polls to keep hold rate up.
3. **The transition (1 min, scripted)** — the hardest 60 seconds; write it word for word. The honest bridge: "everything I showed you can be done manually — here's what it looks like when [product] does it for you." The product enters as the *implementation* of the content, not a topic change.
4. **Offer (5–8 min)** — one offer, concretely: what they get, what it costs (or what the next step is), why now (a real reason — expiring bonus, cohort start, limited seats; never fake scarcity, → **offers** for legitimate urgency design).
5. **Q&A (10+ min)** — conversion happens here; questions are objections in disguise. Seed 2–3 starter questions for cold starts, answer the objection behind the question, and re-state the offer + link once mid-Q&A and once at close.

Hold-rate mechanics throughout: deliver on a specific promise made in minute 1 at minute ~35 (announced), use pattern breaks every ~7 minutes (poll, story, screen change), and never front-load housekeeping.

## Stage 4: Post-Webinar (half the revenue is here)

Segment by behavior, then sequence (→ **emails** for craft):

| Segment | Play |
|---|---|
| **Attended, engaged** (stayed for offer, asked questions) | Personal follow-up within 24h referencing their question; direct next step |
| **Attended, left early** | Replay + timestamp to what they missed; softer CTA |
| **No-show** | "Sorry we missed you" + replay with a deadline. No-shows are warm — they raised their hand once; a 2–3 email replay sequence recovers a meaningful fraction |
| **Replay-registrants** | Same as no-shows, minus the apology |

- **Replay strategy**: time-limited replay (72h–1 week) preserves urgency for the offer; evergreen replay converts the offer to a standing CTA and becomes a lead magnet (→ **lead-magnets**). Pick per goal — limited for launches/offers, evergreen for education-led capture.
- **Cart/offer close**: if the offer had a deadline, run a real close sequence (deadline reminder → objection email → final hours). All urgency claims must be true.
- **Recycle the asset**: transcript → recap post (→ **content-strategy**), clips (→ **video**), quotable stats for AI-citable content (→ **ai-seo**). A monthly webinar run this way is a content engine with a lead-gen side effect.

## Metrics That Diagnose

- **Low registration** → topic/title/promise problem (or traffic quality). Fix the offer of the webinar itself before touching promo volume.
- **Low show-up** (<30%) → reminder system or reg-to-event gap; check calendar-add rate first.
- **Low hold** → content front-loading or promise mismatch; find the drop-off timestamp.
- **High hold, low conversion** → transition or offer problem; the audience liked the class but wasn't shown a reason to act.
- Cost per qualified attendee and per opportunity — comparable against your other channels, and the number that decides the program's future.

---

*Skill category identified via 2026-07 competitive research (webinar-marketing in alirezarezvani/claude-skills, MIT — idea credited; content authored from scratch to this repo's standard). Benchmarks are directional industry ranges — treat your own trend line as the baseline.*



---

<a id="reference-references-sponsorship-roi"></a>

## Reference: references/sponsorship-roi.md

# Sponsorship & Exhibiting — Evaluate, Negotiate, Work the Floor, Follow Up

Sponsorships are the most expensive way to do event marketing and the easiest to waste. The discipline: treat every sponsorship as a paid-acquisition channel with a cost-per-qualified-meeting, and make it beat your alternatives or don't buy it.

## Should We Sponsor? (the evaluation)

Run this before looking at the prospectus pricing:

1. **Audience–ICP overlap, in absolute numbers.** Not "5,000 attendees" but *how many attendees are your buyer*. Ask organizers for the attendee breakdown by role/company type; check last year's attendee/speaker lists and social chatter. A 5,000-person event with 200 ICP attendees is a 200-person event for you.
2. **Do the meetings math backwards.** Realistic qualified conversations = a small fraction of ICP attendees (a well-worked booth might convert 10–20% of relevant walk-bys into real conversations — directional, varies wildly by event). Then: total cost (sponsorship + travel + staff time + booth build) ÷ expected qualified meetings = **cost per qualified meeting**. Compare against what a meeting costs you from outbound or ads. If the event is 3× your outbound cost with no strategic upside, pass.
3. **Strategic multipliers that justify a premium**: your exact buyers concentrated nowhere else, a category-defining event where absence is conspicuous (late-stage), or access you genuinely can't buy elsewhere (exec attendees who ignore cold outreach).
4. **The counterfactual check**: what would the same budget produce in your best-performing channel? Sponsorship must beat that, not zero.

Red flags in prospectuses: attendee counts without composition, "impressions" as the headline metric, leads defined as badge scans, and last year's sponsor logos heavy on companies that didn't return.

## Negotiation: The Prospectus Is a Starting Point

Sponsorship pricing is soft, especially inside 8 weeks. What to negotiate for (in rough order of value):

1. **A speaking or panel slot** — worth more than a bigger booth; stage time converts better than floor space (see [speaking.md](#reference-references-speaking)).
2. **Side-event rights** — permission/space to host a dinner, breakfast, or workshop for a curated list during the event.
3. **Attendee list reality check** — full lists are increasingly rare (privacy); negotiate for opt-in scans, the registration-page question, or sponsored-session registrant lists. Get what's actually deliverable in writing.
4. **Placement and timing** — booth position near traffic (coffee, entrances, main stage exit); demo-day timing if the event has one.
5. **Price** — last, after the package is right. Unsold inventory close to the date discounts heavily.

## The Side-Event Play (often better than the booth)

The highest-leverage move in field marketing: skip or downgrade the booth, and **host a curated dinner or breakfast adjacent to the conference**.

- 8–14 seats, hand-picked ICP attendees + a couple of magnetic guests (a respected practitioner draws acceptances)
- Invite via personal outreach 2–4 weeks out (→ **cold-email** for craft); "join 10 [role]s for dinner during [event]" converts far better than any booth pull
- No pitch. The host halo and the conversations are the product; follow-up carries the commercial weight
- Economics: a dinner typically costs a fraction of a mid-tier sponsorship and produces *deeper* meetings with *chosen* accounts. This is also the play when you can't afford (or aren't allowed) to sponsor at all — you don't need the event's permission for your own dinner across the street.

## Working the Booth (if you buy one)

- **Staff it with people who can qualify and demo**, not whoever was free. Two energetic people beat five tired ones; write a shift schedule — floor fatigue is real and visible.
- **A 30-second qualifying question** beats a pitch: "what does your team use for X today?" sorts buyers from swag collectors instantly. Have a graceful fast exit for non-ICP traffic.
- **Capture context, not just scans**: after every real conversation, 15 seconds of notes — what they said, what they care about, the agreed next step. Voice memo or CRM app, same-hour. This is the raw material of follow-up that converts; a bare badge scan is a name with amnesia.
- Demo stations for depth, one clear message on the booth itself (the category problem, not your feature list), and book-a-meeting QR that goes to a calendar, not a form.
- **Book meetings before the event** with target attendees — the booth is a venue for pre-booked meetings, not just a net for walk-bys.

## Follow-Up: Where the Sponsorship Is Won or Lost

- **24–48 hour SLA**, tiered:
  - **Hot** (real conversation, next step agreed): personal email referencing the conversation, calendar link, same or next day.
  - **Warm** (conversation, no commitment): personal note + one relevant asset matched to what they said.
  - **Scan-only**: one light "we were both at [event]" touch or nothing. Never dump scans into a sales sequence — it burns domain reputation and brand on people who don't remember you (→ **revops** for routing/scoring).
- Whoever worked the booth writes or reviews the follow-up — the context lives in their heads and their notes.
- Sequence the not-nows into nurture with event source tags (→ **emails**).

## Measuring the Sponsorship

- Log every touched contact with an event source tag; measure **qualified conversations → meetings → opportunities → pipeline → closed-won influenced**, on an influence window that matches your sales cycle (90 days is common for B2B; long cycles need longer windows).
- Report **cost per qualified meeting and cost per opportunity** against your other channels — this is the renewal decision for next year, made with data instead of vibes.
- Self-reported attribution ("met you at [event]") catches influence that source tags miss (→ **attribution**); badge-scan counts and booth traffic are activity, not outcomes — track for logistics, never report as results.
- Judge a first-time event against a discount: your team's first run of any event underperforms its potential. A promising-but-unprofitable first year is a redesign signal, not necessarily a no.



---

<a id="reference-references-speaking"></a>

## Reference: references/speaking.md

# Speaking — Get Booked, Design the Talk, Compound the Recording

Speaking is the highest-leverage event role per dollar: stage time confers borrowed authority no booth can buy, and the recording compounds for years — including in AI answers. Treat it as three separate jobs: getting booked, designing a talk that lands, and harvesting the asset.

## Getting Booked (CFPs and pitches)

Organizers optimize for their audience's experience, not your reach. Pitch accordingly:

- **Pitch the audience takeaway, not your company.** A CFP that reads like a case study of the *attendee's* problem gets accepted; a product story gets filtered. Your product can appear as evidence inside the talk, never as its subject.
- **Title formula**: specific outcome + specific audience + a tension or number. "How we cut CAC 40% by killing our best channel" beats "Rethinking Growth."
- **The abstract carries three things**: the problem as the audience feels it, the specific things they'll walk away knowing (2–3, concrete), and why *you* — the proof you've actually done it (numbers, scars). Keep it under 150 words; organizers skim hundreds.
- **Track and ladder**: local meetups → niche conference tracks → main stages. Recordings of small talks are your CFP portfolio for bigger ones. Podcast appearances feed the same ladder (→ **public-relations** podcast prep — same evidence discipline, same context file).
- Off-cycle path: many events fill panels and replacement slots late — a short note to organizers with a tight topic + proof of speaking ability lands surprisingly often.

## Designing the Talk: Outline First, Then Feelings

A talk is a journey you take the room on, not a document you read at them. Two passes:

**Pass 1 — the outline.** Before slides, lock four things (write them down; mush here becomes mush on stage):

1. **Who this is for** — one person, their situation, what they already believe walking in
2. **The Monday takeaway** — what they can *do or decide* on a specific next day; a talk without one is content, not a talk
3. **What you get** — your win (pipeline, credibility, hiring) so the close can carry it without a swerve
4. **The blocks** — each with a point and a proof (a story or a number). No proof, no block.

**Pass 2 — storyboard the feeling.** Map how the room should *feel* beat by beat — a beat is a change in energy or emotion, not a slide heading. A 20-minute talk is usually 5–8 beats. For each beat, name:

- **Energy** — the room, in directable words: quiet lean-in, rising unease, laugh-release, peak, still
- **Feel** — the emotion in the audience's own mouth: "that's me," "wait, we're the problem," "I can try this Monday"
- **The hit** — the one thing this beat must land, in one sentence

Then check the journey: does the sequence of feelings *earn* the Monday takeaway, or is the takeaway merely stated at the end? If a load-bearing block produces no feeling change, cut or merge it — two blocks that feel the same are one beat. If the close needs a feeling that never appeared, the outline isn't done. One well-placed contrarian take stands out most on stages that have converged on a consensus.

*(This outline → emotional-storyboard method is distilled from Knowatoa's `talk-storyboard` and `presentation-outline` skills — [ai-visibility-skills](https://github.com/Knowatoa/ai-visibility-skills), MIT, credited.)*

## The Recording Is the Real Audience

The room holds 200 people for 25 minutes; the recording works for years. Design for both at once:

- **Talks get transcribed, and transcripts get crawled and cited by AI assistants** — the same compounding as podcast guesting. Say the important things in liftable form: your company name next to your category ("we build X, the Y for Z"), numbers spoken aloud rather than gestured at on a slide, and your quotable one-liner delivered *on a beat the room will feel* — the sentence you want quoted needs to sit where the energy peaks, or it dies in the transcript too (→ **ai-seo**'s text-layer logic).
- **Slides are not the asset.** Anything that exists only visually (the key number, the framework name) doesn't exist for the transcript, the podcast version, or the attendee retelling it — speak it.
- **Get the recording.** Confirm before accepting the slot that you'll receive it and may republish. If the event doesn't record, record your own re-delivery of the talk within a week while it's tight.

## Around the Talk

- **Before**: post the *why this topic now* angle; invite specific people to your session; make plans to meet the other speakers — speaker-to-speaker is the strongest networking lane at any event.
- **During**: end with one clear, low-friction pointer (a memorable URL to the slides + a related asset — which doubles as a lead magnet, → **lead-magnets**). Q&A questions are content research; note every one.
- **After**: publish the recording + a written version of the talk (→ **content-strategy**), clip the peak beats (→ **video**), follow up with everyone who asked a question or approached you — same 24–48h window as every event motion, and these are the warmest leads an event produces.
- Roll the talk forward: the same core talk, sharpened by each delivery's Q&A, can run a full conference season. Retire it when the Q&A stops surprising you.



---

<a id="reference-references-event-portfolio-strategy"></a>

## Reference: references/event-portfolio-strategy.md

# Event Portfolio Strategy — Which Events, Why, and the Economics

The layer that sits *above* role and tactics. Events are the most expensive, riskiest, hardest-to-measure channel you can run — so the leverage is in **selection and portfolio design**, not execution. The single most common failure is treating "events" as one channel: attend two bad conferences, get few leads, and write the whole channel off — the same mistake as running Google Ads once, seeing poor results, and concluding all paid media is broken. **Each event is its own ecosystem.** Judge them individually.

## Is in-person even necessary? (segment fit first)

Digital scales efficiently; in-person builds trust that digital can't. In-person earns its cost mainly for high-trust, high-consideration motions. Prioritize events when your ICP looks like:

- **Enterprise / multi-stakeholder** — high ACV, several people must build trust before a big commitment
- **Regulated buyers** — healthcare, finance, government have strict vendor-evaluation norms
- **High-touch / heavy customization** — significant integration or configuration work
- **Conservative industries** — manufacturing, utilities still run on traditional relationship-building
- **Long cycles** — 6+ month sales cycles get disproportionate acceleration from face time

Reality check: a cybersecurity company found $500k+ ACV deals almost never closed without at least one in-person meeting — the trust to switch security vendors couldn't be built over Zoom. If your ICP is *not* in these buckets, spend on digital first and treat events as a small experiment.

## The 80/20 of event selection

A small number of events generate the majority of event-attributed pipeline (one B2B SaaS program found **3 conferences drove ~70%** of it). The job is to find those and concentrate:

- Increase presence at the winners — secure **speaking slots**, host **larger side events**, send **more of the right people**, buy **better placement**
- Cut or minimize the long tail of low-yield events
- Re-rank yearly; the 20% shifts as your ICP and market move

## Bigger isn't better (size ↔ ROI is often inverse)

Major conferences look can't-miss and frequently deliver the *worst* returns:

- **Big events = more noise** — higher cost on everything (booth, hotels, travel), more competing vendors, attendees spread thin across tracks, endless competing side events
- **Audience dilution** — you're paying to reach a crowd padded with students, investors, press, other vendors, consultants, and industry tourists; your ICP is a thin slice, so effective cost-per-qualified-lead balloons
- **Small-event advantage** — a 50-person niche meetup can out-produce a 5,000-person conference; highest ROI is often **regional events of 100–200** where you can reach every qualified prospect in the room

## The three event types (three risk profiles)

### 1. Owned events — maximum control, maximum risk
You control everything from content to coffee breaks, and you carry all the risk. Range: exec dinners → roadshows → summits → user conferences.
- **User conferences** turn customers into a community and a product into a movement (Dreamforce). Don't attempt before you have an audience that would come unbegged.
- **Regional roadshows** take the message to scattered markets — one company generated more pipeline from a **6-city roadshow than its annual conference, at a third of the cost**.
- **Industry summits** build thought leadership by tackling category problems, not product pitches — they pull in partners and influencers who amplify.
- **Workshops / certifications** tie the event directly to customer success and can pay for themselves via fees.
- **Three success factors:** ruthless **audience focus** (a clear "who," even at the expense of broader appeal), a **value proposition** attendees can't get elsewhere, and **strategic timing** (align to buyer budget/bandwidth — one company moved its conference Q4→Q1 and lifted attendance 40%).
- **Model case — Drift HYPERGROWTH:** killed badges and sponsor booths, chose storytelling over product pitches, felt like TED not a software show → 3x pipeline acceleration for attendees, starting at 1,000 people year one.

### 2. Trade shows & conferences — someone else's arena
Less control, less risk — you rent instant access to an audience but work inside their format. **Success is 120 days of prep, not the 4 days on the floor.**
- **Pre-show (starts ~120 days out):** mine the attendee list for *stories*, not just names (recent funding, press, job posts) → hooks far better than "want a demo?"; **book ~70% of meeting slots before anyone flies out** ("saw you opened a Singapore office — we helped 3 companies with APAC expansion last quarter, coffee at the show?")
- **On the floor:** turn the booth into a **story-collection hub** — senior staff at the edges (not behind a counter), no physical barriers, customer success stories on screens, and bring real customers to tell their story. (One security company ran a live "Security Operations Center" that sparked real technical sales conversations.)
- **The hidden game — satellite events:** morning coffee meetups and curated private dinners routinely out-generate the booth
- **Post-show (where most teams fail):** tier leads and reference *specific conversation details* — hot → same-day, warm → personalized within 48h, general → nurture within a week; turn booth conversations into content (video testimonials, FAQ → blog/email)

### 3. Community events — the compound interest of event marketing
Small, regular investments that grow exponentially — often started on a tiny budget (monthly meetups for ~$500 of pizza and beer).
- **Regular rhythm beats flash** — same format, same venue, every month builds momentum; chasing a bigger/flashier event each time burns teams out
- **Never pitch — facilitate.** A "Tech Leaders Dinner" grew 8 → 40+ CTOs because it solved their real problems; the product came up naturally
- **Turn customers into advocates** — support customer-run user groups but let them stay independent; they become a reference network prospects trust *because* they're not on your payroll
- **The multiplier effect** — arm your most engaged attendees with playbooks, speaker connections, and seed funding to launch their own city events (one meetup spawned 12 across 3 countries)
- **Metrics that fit** — monthly active members, conversation depth, community-initiated events, relationship velocity, member→customer conversion. The gut check is the **"Saturday Test": would people show up on a Saturday morning?** If yes, you built something real.
- **Payoff** — prospects who attended **3+ community events showed an 85% higher close rate and 40% shorter cycle**; they understood the value in context before ever buying

## Economics — real cost benchmarks

Budget the full investment (money *and* time/opportunity cost) against pipeline, not just the sticker price.

| Line item | Typical range |
|---|---|
| Conference ticket | $1,500–3,000 / person (major shows) |
| Booth space (10×10, top-tier) | $15,000–40,000 |
| Flights | $300–1,000 / person |
| Hotel | $300–400 / night / person |
| Booth staff | 3–4 people minimum at any significant show |
| Private dinner (15–20 ppl) | $150–200 / person |
| Breakfast meetup | $30–50 / person |
| Happy hour | $50 / person |
| Private meeting room | $500–1,500 / day |

**Rule of thumb:** a significant show needs to generate **~5–10 solid opportunities** to justify sending a team. For the sponsor-specific go/no-go math and cost-per-qualified-meeting comparison against other channels, see [sponsorship-roi.md](#reference-references-sponsorship-roi).

---

*Distilled from Corey Haines's* Founding Marketing *(chapter: "Events create memorable experiences with potential customers"). Benchmarks are directional and pre-inflation-adjust as needed; re-verify current show pricing.*
