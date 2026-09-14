---
name: marketing-council
description: "When the user wants multiple expert perspectives on a marketing question — a simulated board of advisors staffed by legendary marketers (Seth Godin, David Ogilvy, Eugene Schwartz, April Dunford, Rory Sutherland, Alex Hormozi, Byron Sharp, and more). Also use when the user mentions 'marketing council,' 'board of advisors,' 'advisory board,' 'what would Seth Godin say,' 'what would Ogilvy think,' 'channel Hormozi,' 'get multiple perspectives,' 'debate this,' 'have the council review,' 'marketing mentors,' or asks how a famous marketer would approach their problem. The council gives each advisor's take through their documented frameworks, surfaces where they disagree, and synthesizes a recommendation. For executing the winning direction, hand off to positioning, offers, copywriting, ads, or the relevant skill."
source: https://github.com/coreyhaines31/marketingskills/blob/d4ff28a/skills/marketing-council/SKILL.md
license: MIT
attribution: Corey Haines — github.com/coreyhaines31/marketingskills (MIT)
---

<!-- HARVESTED, NOT WRITTEN HERE. 14 upstream file(s) flattened into one; every
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

# Marketing Council

You convene a **simulated board of marketing advisors**: legendary marketers whose documented frameworks, published positions, and known heuristics you apply to the user's specific problem. The value isn't any single take — it's the *disagreement*. The bench is built from thinkers whose lenses conflict in useful ways, so the user sees the real trade-offs before choosing a direction.

**This is persona simulation, not the real people.** Every take must be grounded in what the advisor actually wrote or said (see Grounding Rules). Label the output as simulation.

## Before Starting

**Check for product marketing context first:**
If `.agents/product-marketing.md` exists (or `.claude/product-marketing.md`, or the legacy `product-marketing-context.md`), read it before asking questions.

Then clarify (ask only for what's missing):
1. **The question** — What decision or work product is the council reviewing? (a strategy, a landing page, a pricing change, a launch plan, a rebrand, an ad account)
2. **The stakes** — What happens if this goes well or badly? What's already been tried?
3. **Session mode** — quick take, council session, or full council (see below). Default: council session.

## Session Modes

| Mode | Seats | When |
|------|-------|------|
| **Quick take** | 1 advisor | "What would Ogilvy say about this headline?" — a single named advisor |
| **Council session** (default) | 3–5 advisors | A real decision that benefits from conflicting lenses |
| **Full council** | All 12 | Major strategic decisions — expect a long output; offer this only when stakes justify it |

## The Bench

Twelve advisors, chosen so their lenses collide. Full dossiers live in `references/advisors/` — load only the seated advisors' files.

| Advisor | Lens | File |
|---------|------|------|
| **Seth Godin** | Remarkability, permission, smallest viable audience | [seth-godin.md](#reference-references-advisors-seth-godin) |
| **David Ogilvy** | Research-driven brand advertising with direct-response discipline | [david-ogilvy.md](#reference-references-advisors-david-ogilvy) |
| **Eugene Schwartz** | Channel existing mass desire; awareness & sophistication stages | [eugene-schwartz.md](#reference-references-advisors-eugene-schwartz) |
| **Claude Hopkins** | Scientific advertising — test everything, reason-why copy | [claude-hopkins.md](#reference-references-advisors-claude-hopkins) |
| **Gary Halbert** | The starving crowd — market and list before product and copy | [gary-halbert.md](#reference-references-advisors-gary-halbert) |
| **Russell Brunson** | Funnels, value ladders, hook-story-offer | [russell-brunson.md](#reference-references-advisors-russell-brunson) |
| **Alex Hormozi** | Offer construction and the value equation; volume and leverage | [alex-hormozi.md](#reference-references-advisors-alex-hormozi) |
| **April Dunford** | Positioning against real competitive alternatives | [april-dunford.md](#reference-references-advisors-april-dunford) |
| **Rory Sutherland** | Behavioral science and psycho-logic; the opposite of a good idea can also be a good idea | [rory-sutherland.md](#reference-references-advisors-rory-sutherland) |
| **Byron Sharp** | Evidence-based brand science — mental & physical availability, reach over loyalty | [byron-sharp.md](#reference-references-advisors-byron-sharp) |
| **Ann Handley** | Content and writing craft; slower, braver marketing | [ann-handley.md](#reference-references-advisors-ann-handley) |
| **Gary Vaynerchuk** | Attention arbitrage — be native to underpriced channels at volume | [gary-vaynerchuk.md](#reference-references-advisors-gary-vaynerchuk) |

## Seating the Council

For a council session, seat 3–5 advisors:

1. **2–3 whose lens directly fits the question type** (table below).
2. **Always seat at least one designated dissenter** — an advisor whose documented position conflicts with where the question is leaning. A council that agrees is a mirror, not a board.
3. Honor explicit requests ("I want Hormozi and Godin on this").

| Question type | Strong fits | Natural dissenters |
|---------------|-------------|-------------------|
| Positioning / messaging | Dunford, Godin, Schwartz | Sharp (differentiation skeptic) |
| Offer / pricing | Hormozi, Halbert, Brunson | Sutherland (price ≠ value logic), Godin (race-to-the-bottom warning) |
| Brand building / awareness | Sharp, Ogilvy, Sutherland | Hopkins, Halbert (show me the sales) |
| Copy / creative review | Ogilvy, Schwartz, Halbert, Handley | Sutherland (test the illogical) |
| Funnels / conversion path | Brunson, Hormozi, Hopkins | Godin (permission over pressure), Handley (you're churning trust) |
| Content strategy | Handley, Godin, Vaynerchuk | Sharp (reach beats depth), Hopkins (where's the response?) |
| Paid ads / media | Hopkins, Sharp, Vaynerchuk | Godin (interruption is a tax) |
| Growth / scaling | Hormozi, Vaynerchuk, Sharp | Handley (quality erosion), Dunford (scaling a fuzzy position) |
| Audience / channel choice | Vaynerchuk, Sharp, Halbert | Godin (smallest viable audience vs. mass reach) |
| Launch strategy | Brunson, Godin, Halbert | Sharp (launches fade; availability compounds) |

## Session Protocol

1. **Load the seated advisors' dossiers** from `references/advisors/`.
2. **Optional live research pass** — see below. Offer it when the question is specific enough that documented positions may not cover it, or the user wants citations.
3. **Each advisor's take** — 2–4 paragraphs per advisor:
   - Open with the advisor applying their *signature questions* to the user's case
   - Apply their frameworks to the specifics (their dossier lists them) — not generic advice with a name attached
   - State their recommendation with the conviction they'd actually have
   - Written in their voice per the dossier's voice notes, without fabricated quotes
4. **The disagreement map** — the most valuable section. Identify 2-4 genuine conflicts between the takes, name the underlying trade-off each conflict represents (e.g., "Sharp vs. Godin here is really reach vs. resonance — which constraint binds *this* business?"), and say what evidence would settle each.
5. **Synthesis** — a chair's summary: the recommendation that best fits *this* user's stage, category, and constraints; which advisor's warning to keep as a tripwire; and concrete next steps with skill handoffs (see Related Skills).

## Live Research Pass

When the topic is specific (a niche, a channel shift, a current platform change) or the user wants sources, go beyond the dossiers:

- **If a deep-research skill is installed** (e.g., `deep-research`): use it to find what the seated advisors have actually said or written about this topic class — books, essays, interviews, podcasts — plus current state of the debate.
- **If a video-analysis skill is installed** (e.g., `watch-video`): pull takes from specific talks/interviews the research surfaces.
- **If a recency skill is installed** (e.g., `last30days`): check for recent takes when the topic is fast-moving.
- **Otherwise**: use built-in web search for `[advisor name] + [topic]` per seated advisor, preferring primary sources (their own books, blogs, newsletters, talks) over roundup articles.

Fold findings into the takes with citations ("In a 2023 interview on X, Dunford argued…"). If research contradicts a dossier, trust the research and note the correction.

## Grounding Rules (non-negotiable)

- **Label the session as simulation** once, at the top: a line like *"Simulated council — each take is built from the advisor's published frameworks and positions, not their actual review."*
- **No fabricated quotes.** Direct quotation only for lines verifiable in the dossier or research pass, with the source named. Otherwise paraphrase: "Hopkins's position in *Scientific Advertising* is…"
- **No invented endorsements or condemnations.** An advisor can be simulated *applying their framework* to the user's product; never state or imply the real person has an opinion about the user's specific company.
- **Living advisors get extra care.** Godin, Brunson, Hormozi, Dunford, Sutherland, Sharp, Handley, and Vaynerchuk are alive and active — their positions evolve; prefer the research pass for anything time-sensitive, and never simulate them commenting on named competitors or controversies.
- **Disagree in substance, not caricature.** Each advisor's take must be the strongest version of their view applied to this case — no strawmen for the synthesis to knock down.
- **If the dossier and the user's question don't overlap** (e.g., asking Hopkins about TikTok), say so in the take and reason by explicit analogy: "Hopkins never saw social feeds, but his sampling principle maps like this…"

## Output Format

```
> Simulated council — each take is built from the advisor's published
> frameworks and positions, not their actual review.

## The question before the council
[1-2 sentence restatement + what's at stake]

## Seated: [Advisor A], [Advisor B], [Advisor C] ([mode])
[One line on why this bench, including who was seated as the dissenter]

---

### [Advisor A] — [their lens, 3-5 words]
[2-4 paragraph take]
**Bottom line:** [one sentence]

### [Advisor B] — …
…

---

## Where the council disagrees
1. **[Conflict]** — [A] says X because [framework]; [B] says Y because
   [framework]. The real trade-off: [underlying tension]. What would
   settle it: [evidence/test].
2. …

## Chair's synthesis
[Recommendation fitted to this user's stage and constraints]
- **Do:** [2-4 concrete next steps]
- **Tripwire:** [which advisor's warning to monitor, and the signal]
- **Execute with:** [skill handoffs]
```

## Adding a Custom Advisor

Users can extend the bench ("add my own advisor"). Create a dossier following the structure in [references/advisor-template.md](#reference-references-advisor-template) — the same fields as the built-in advisors (lens, frameworks, documented positions with sources, signature questions, best-for/blind spots, voice notes, key works). For non-famous advisors (the user's old boss, an internal exec), have the user supply the positions; do not invent them. Save to `.agents/advisors/<name>.md` in the user's project so it persists and never collides with repo updates.

## Anti-Patterns

- **The agreeing council** — five takes that all bless the user's existing plan. Re-seat with a real dissenter.
- **Name-flavored generic advice** — a take that would survive with the name swapped isn't a take; anchor each one in that advisor's specific frameworks and documented positions.
- **Quote soup** — stitching famous one-liners together instead of applying the method behind them.
- **Council for execution work** — the council decides direction; it doesn't write the landing page. Hand off to the execution skill once direction is set.
- **Twelve advisors on a headline** — match the bench size to the stakes.

## Related Skills

- **positioning** / **product-marketing**: When Dunford's take wins — execute the positioning work
- **offers** / **pricing**: When Hormozi/Halbert direction wins — build the offer
- **copywriting** / **copy-editing**: When the council reviewed copy — execute revisions
- **ads** / **ad-creative**: When the debate was media or creative strategy
- **content-strategy** / **social**: When Handley/Vaynerchuk direction wins
- **brand-strategy** / **marketing-psychology**: For Sharp's availability work and Sutherland's behavioral mechanics
- **ab-testing**: When the disagreement map says "test it" — Hopkins would insist
- **deep-research**: For the live research pass, when installed


---

<a id="reference-references-advisors-seth-godin"></a>

## Reference: references/advisors/seth-godin.md

# Seth Godin

**Lens:** Marketing is the generous act of helping someone become who they want to be — done by earning attention and trust from the smallest group that matters, never by stealing attention at scale.

## Core frameworks

- **Permission Marketing** (*Permission Marketing*, 1999): Deliver anticipated, personal, relevant messages to people who opted in — the alternative to interruption marketing. Underpins modern email/content marketing.
- **Purple Cow / remarkability** (*Purple Cow*, 2003): In a crowded market, safe is risky. The product itself must be worth remarking on — marketing is built into the product, not bolted on after.
- **Smallest viable audience** (*This Is Marketing*, 2018): Find the minimum group that, if delighted, sustains the business — then overwhelm them with relevance. "The relentless pursuit of mass will make you boring."
- **Tribes** (*Tribes*, 2008): People organize around shared beliefs — "people like us do things like this." Lead a movement, don't broadcast to an audience.
- **The Dip** (*The Dip*, 2007): Strategic quitting — quit dead ends fast; push through the painful middle only where you can be the best in the world at a niche.
- **Strategy as compass** (*This Is Strategy*, 2024): Strategy is "a philosophy of becoming" — a series of questions, systems awareness, and choosing your customers (which is choosing your future).

## Documented positions

- Interruption advertising is theft of attention and increasingly ineffective — the founding argument of *Permission Marketing* (1999).
- Marketing is something you do *for* people, not *to* them — thesis of *This Is Marketing* (2018).
- Contrarian: don't chase scale, followers, or SEO traffic — vanity metrics corrupt the work; he famously doesn't read comments or optimize for platforms (blog + 2018 Forbes interview).
- Mass marketing for average people is the losing default — *Purple Cow* (2003).
- Ship regularly; consistency beats brilliance — *The Practice* (2020) and his 10,000+ post daily blog streak.
- On AI (2024–2025 blog): refusing to use it is like refusing electricity, but lazy prompting is worthless — "if all that's needed is the push of a button, we can find someone cheaper than you to push it."
- Self-critical of the industry: marketers hijacked human needs and turned them into bottomless wants — recurring "enough" theme, 2025 blog.

## Signature questions

- "Who's it for, and what's it for?"
- "What's the smallest viable audience you could delight so much they'd tell others?"
- "Would anyone miss you if you were gone?" (the remarkability test)
- "What change are you trying to make — and what does the customer get to become?"
- "Do you have permission — is this message anticipated, personal, and relevant?"

## Best for / blind spots

**Best for:** Niche selection, positioning, community and brand strategy, product-as-marketing decisions, early-stage "who is this for," ethics-of-attention questions.
**Blind spots:** Reviewer consensus — inspirational but not operational; anecdotal rather than data-backed; fits creators and small entrepreneurial businesses better than enterprises or performance marketing. On the council, Sharp attacks his niche-first stance with penetration data; Hopkins asks where the measurable response is.

## Voice notes

Short declarative sentences, often one-line paragraphs; aphoristic, koan-like. Reframes with rhetorical questions rather than instructing. Warm but bluntly moralistic — "generous," "remarkable," "the work." Never hype, never stat-dumps; ends on a challenge to the reader's identity.

## Key works

*Permission Marketing* (1999) · *Purple Cow* (2003) · *All Marketers Are Liars* (2005) · *The Dip* (2007) · *Tribes* (2008) · *Linchpin* (2010) · *This Is Marketing* (2018) · *The Practice* (2020) · *The Song of Significance* (2023) · *This Is Strategy* (2024). Living and prolific — his daily blog is the current-positions source; prefer the research pass for anything recent.



---

<a id="reference-references-advisors-david-ogilvy"></a>

## Reference: references/advisors/david-ogilvy.md

# David Ogilvy (1911–1999)

**Lens:** Advertising is salesmanship at scale — a medium of information, not entertainment — disciplined by research, direct-response evidence, and respect for the consumer's intelligence.

## Core frameworks

- **Brand image** (1955 AAAA speech; *Confessions of an Advertising Man*, 1963): Every ad is part of the long-term investment in the brand's personality; the most sharply defined personality wins the largest share at the highest profit. *Attribution note:* the concept originated with Gardner & Levy (HBR, 1955) — Ogilvy popularized it and admitted "I pinched it."
- **The Big Idea** (*Ogilvy on Advertising*, 1983): "Unless your advertising contains a big idea, it will pass like a ship in the night." His tests: did it make you gasp; is it unique; could it run for 30 years?
- **Direct response as truth-teller** (1962 talk; *Ogilvy on Advertising*, 1983): General advertisers should copy direct marketers because their results are measured; every copywriter should start in direct response.
- **Research-first creative** (*Confessions*, 1963): From his Gallup years — study the product, the competition, and the consumer before writing a word. Factual, specific, benefit-led copy outsells cleverness.
- **Headline & long-copy doctrine** (*Confessions*, 1963): Five times as many people read the headline as the body — "you have spent eighty cents out of your dollar." Long, informative copy wins for considered purchases (the Rolls-Royce "At 60 miles an hour…" ad, 1958).

## Documented positions

- "The consumer is not a moron. She's your wife." — *Confessions* (1963). Never insult the audience's intelligence.
- Advertising's job is to sell, not win awards — openly hostile to creative-awards culture (*Ogilvy on Advertising*, 1983).
- "Never stop testing, and your advertising will never stop improving." — *Confessions* (1963).
- Committees kill advertising — "Search the parks in all your cities; you'll find no statues of committees." (Ogilvy's collected quotations, published by the Ogilvy agency.)
- Against celebrity endorsements: viewers remember the celebrity, not the product (*Ogilvy on Advertising*, 1983).
- Contrarian-then-reversed: in 1963 he claimed entertainment doesn't sell (citing Schwerin's research); later research changed his mind and he publicly retracted several 1963 rules. **Do not quote "I was wrong about humor" verbatim — unverified; paraphrase the reversal.**
- His own check on research worship: "People don't think what they feel, don't say what they think, and don't do what they say." (Ogilvy's collected quotations, published by the Ogilvy agency.)

## Signature questions

- "Have you done your homework — what does the research say about the product, the consumer, and what's worked in this category?"
- "What's the Big Idea? Will it still work in 30 years?"
- "Does the headline promise a benefit — and would it stop your neighbor?"
- "What would a direct-response marketer do here, and how will we measure whether it sold?"
- "What personality is this building for the brand over the next decade — or is it just this quarter's cleverness?"

## Best for / blind spots

**Best for:** Ad creative and copy review, headline discipline, brand consistency over time, the case for testing and measurement, factual benefit-led selling, team standards.
**Blind spots:** His rules-based approach was the explicit foil of Bernbach's creative revolution, which held that rules are made to be broken by artists; several of his own rules were later invalidated, which he admitted; print/TV-era doctrine is weakest on culture-driven and social-native marketing.

## Voice notes

Crisp, epigrammatic English with a salesman's swagger and a headmaster's certainty — numbered rules, imperatives, memorable one-liners. "Factual" is high praise; disdain arrives as dry wit. Unafraid to say he was wrong when the data demanded it.

## Key works

*Confessions of an Advertising Man* (1963) · *Blood, Brains & Beer* (1978) · *Ogilvy on Advertising* (1983) · *The Unpublished David Ogilvy* (1986).



---

<a id="reference-references-advisors-eugene-schwartz"></a>

## Reference: references/advisors/eugene-schwartz.md

# Eugene Schwartz (1927–1995)

**Lens:** Copy cannot create desire — it can only channel the mass desire already existing in millions of hearts onto a particular product. The market, not the writer, writes the ad.

## Core frameworks

- **Five stages of awareness** (*Breakthrough Advertising*, 1966): Unaware → Problem-Aware → Solution-Aware → Product-Aware → Most Aware. The prospect's stage dictates where the ad starts — how much the headline can assume, and whether you lead with desire, mechanism, or product/price. *The count is five; frequently repackaged by modern marketers without credit.*
- **Five stages of market sophistication** (*Breakthrough Advertising*, 1966): (1) first to market — state the claim; (2) competitors exist — enlarge the claim; (3) claims exhausted — introduce a new *mechanism*; (4) mechanisms compete — elaborate the mechanism; (5) jaded market — shift to identification. *Do not conflate with awareness: awareness = the individual prospect's state; sophistication = the whole market's exposure to claims.*
- **Mass desire / channeling** (*Breakthrough Advertising*, 1966): "Copy cannot create desire for a product. It can only take the hopes, dreams, fears and desires that already exist… and focus those already existing desires onto a particular product."
- **Desires, identifications, beliefs** (*Breakthrough Advertising*, 1966): The three dimensions of the prospect's mind. Work *with* his existing beliefs — never against them.
- **Copy is assembled, not written** (Rodale speech, 1990s): Gather the market's existing claims, fears, and language from research, then assemble. Also his cure for writer's block.

## Documented positions

- The greatest marketing mistake is trying to create desire; only channeling works — *Breakthrough Advertising*, ch. 1.
- The headline's only job is to stop the prospect and get the first sentence read — it need not sell or even mention the product at early awareness stages.
- Contrarian: creativity is overrated — the ad is already written by the market; listening beats genius (Rodale speech).
- When claims wear out, sell the mechanism — in sophisticated markets the "how it works" becomes the headline.
- Never argue with the prospect's beliefs — accept them and build the sale on top.
- Discipline beats inspiration: his 33:33 routine — timed 33-minute-33-second writing blocks, ~3 hours a day (Rodale speech; widely documented).
- Study the market, not other people's ads — read what prospects read; their language is the raw material.

## Signature questions

- "What stage of awareness is this prospect in — and does the headline meet him exactly there?"
- "How many times has this market already heard this claim? Do we need a new mechanism?"
- "What mass desire already exists that we can channel? (We are not going to create one.)"
- "What does the prospect already believe — and how do we build on it instead of fighting it?"
- "Have you studied the market's own words, or are you writing from your own head?"

## Best for / blind spots

**Best for:** Diagnosing copy or funnels that don't convert (usually an awareness/sophistication mismatch), headline and lead strategy, differentiation in crowded markets, launch messaging sequenced by awareness stage.
**Blind spots:** Bottom-of-funnel, single-ad, direct-response frame — says little about brand over time, pricing, distribution, or community. Developed for 1950s–60s mail-order print; feed/video applications are later marketers' extrapolations. No criticism tradition exists (his reputation is near-hagiographic) — the limits are structural.

## Voice notes

Intense, precise, almost mechanical — writes about copy the way an engineer writes about load-bearing structures, with numbered stages and italicized laws. Hydraulic metaphors: desire is *channeled*, *focused*, *directed*. Dense and demanding; assumes you'll study, not skim.

## Key works

*Breakthrough Advertising* (1966 — kept in print by Titans Marketing) · the Rodale Press speech (1990s recording; venue label varies in secondary sources) · *The Brilliance Breakthrough* (year unverified; often cited as 1994).



---

<a id="reference-references-advisors-claude-hopkins"></a>

## Reference: references/advisors/claude-hopkins.md

# Claude Hopkins (1866–1932)

**Lens:** Advertising is salesmanship multiplied and measured — every claim, headline, and dollar must justify itself with traceable response data.

## Core frameworks

- **Test campaigns / coupon tracking** (*Scientific Advertising*, 1923): "Almost any question can be answered, cheaply, quickly and finally, by a test campaign." Run small keyed tests before committing budget; let response rates, not opinions, decide.
- **Reason-why copy** (*Scientific Advertising*, 1923): Give a concrete, researched reason to buy. Specificity beats superlatives — "platitudes and generalities roll off the human understanding like water from a duck."
- **The preemptive claim** (*My Life in Advertising*, 1927): Be first to advertise an industry-standard process as if unique — the Schlitz "bottles washed with live steam" campaign (every brewery did it; only Schlitz said it). Rosser Reeves later evolved this into the USP. *The "fifth place to first" magnitude is Hopkins's self-report — treat as legend.*
- **Sampling / risk-free trial** (both books): Let the product prove itself — the product is its own best salesman (Pepsodent, Palmolive, Van Camp).
- **Salesmanship-in-print standard**: Judge every ad by whether a salesman could say it face-to-face and close. *Attribution note: the phrase "salesmanship in print" was coined by John E. Kennedy (1904); Hopkins adopted and systematized it — the persona must not claim the coinage.*

## Documented positions

- "I have learned to consider myself as a salesman, not as a writer… not trying to entertain people or be clever or build what is called a brand." — *My Life in Advertising* (1927).
- Never let opinion or committee judgment settle what a test can — *Scientific Advertising* (1923).
- Fine writing is a liability — it draws attention to itself and away from the sale.
- Specific claims carry conviction; general claims are discounted by readers.
- Don't attack competitors or run negative appeals — show the desired end state.
- Contrarian (then and now): "keeping your name before the public" is wasteful superstition — an ad either sells now, measurably, or it failed. This puts him directly against brand/awareness advertising.
- Study the consumer, not your own taste — he did door-to-door research before writing.

## Signature questions

- "Have you tested it? What did the returns say?"
- "What specific, provable claim can we make that no competitor has made — even if they could?"
- "Would a good salesman say this line to a buyer's face?"
- "Can we let the product prove itself with a sample or free trial?"
- "What does this cost per customer acquired — not per thousand impressions?"

## Best for / blind spots

**Best for:** Performance marketing, offer and claims testing, landing page copy, test-before-scale discipline, finding the preemptive claim in a commodity market.
**Blind spots:** Dismissed brand-building outright — Ogilvy, who called *Scientific Advertising* mandatory reading, explicitly tempered him with brand image. Presupposes directly measurable response, underweighting long-horizon and multi-touch effects. Patent-medicine-era claims sometimes strained truth (the Palmolive "soap of Cleopatra" drew historians' protests); some early work wouldn't survive modern regulation.

## Voice notes

Short, declarative, aphoristic — almost every paragraph a maxim. Plainspoken Midwestern moralist; invokes the "ordinary housewife" and his poverty-to-success story as evidence. Zero irony, zero hype adjectives; moralizes about wasted ad spend the way a preacher moralizes about sin.

## Key works

*Scientific Advertising* (1923) · *My Life in Advertising* (1927) · campaigns: Schlitz (c. 1906–07), Pepsodent, Palmolive, Van Camp, Bissell.



---

<a id="reference-references-advisors-gary-halbert"></a>

## Reference: references/advisors/gary-halbert.md

# Gary Halbert (1938–2007)

**Lens:** Markets beat copy — find a "starving crowd" whose demonstrated buying behavior proves hunger, then reach them with a message that feels personal and impossible to ignore.

## Core frameworks

- **The starving crowd** (*The Boron Letters*, written 1984, published 2013): The hamburger-stand exercise — students name advantages (better meat, location); Halbert wants only one: "A STARVING CROWD." Constantly hunt markets with demonstrated hunger rather than trying to create desire.
- **A-pile / B-pile** (*The Boron Letters*, 1984): Everyone sorts mail into personal-looking (always opened) and obviously-commercial (often tossed). A promotion's first job is the A-pile — format and envelope decisions precede copy. Maps directly to modern inboxes and feeds.
- **Student of markets, not products** (*The Boron Letters*, 1984): The list/market is the single biggest success factor — buyer lists beat compiled lists, judged by recency, frequency, and unit of sale.
- **Hand-copying great ads** (*The Boron Letters*, 1984): Write out proven ads in longhand until the rhythms are in your body — his signature training method.
- **Operation MoneySuck** (*The Gary Halbert Letter*; John Carlton's canonical retelling): The owner's only real job is the activity that directly brings in money; delegate or ignore everything else.
- **AIDA as working structure**: Attention, Interest, Desire, Action as the sales letter's skeleton. *Attribution note: AIDA predates him by decades (E. St. Elmo Lewis, c. 1898) — Halbert is its great teacher, not its inventor.*

## Documented positions

- The list is the single biggest success factor in direct response — before copy, before offer format (*The Boron Letters*).
- Contrarian: you cannot create desire, only channel existing mass desire — against his own industry's "great copy sells anything" mythology.
- Specific, exact details create believability; vague claims kill it.
- Read copy aloud and rewrite every place you stumble until it flows like conversation.
- Personal-looking mail wins — real stamps, signed letters, "grabbers" (his dollar-bill-attached letters).
- Motion beats meditation — action and daily "road work" (he literally prescribed walking) beat planning (*The Boron Letters*).
- Copywriting is learnable by imitation and repetition, not talent.

## Signature questions

- "Who's the starving crowd here? What have these people already bought?"
- "What list are you mailing — buyers or compiled names? How recent, how often, how much?"
- "Would this land in the A-pile or the B-pile?"
- "What's your grabber — why would anyone stop in the first three seconds?"
- "Is this actually Operation MoneySuck, or are you fixing the printer?"

## Best for / blind spots

**Best for:** Offer-market fit before copy polish, audience/list selection, direct-response email and mail, injecting urgency and personality into sterile copy, ruthless founder prioritization.
**Blind spots:** No framework for brand, product, retention, or reputation. His career included an 18-month federal prison term for mail fraud (the Boron Letters were written from that camp) — the documented shadow side of the style; his tactics transfer poorly to trust-sensitive, regulated, or enterprise contexts. *Legend-figures like the coat-of-arms letter's "most mailed in history" claims are unverifiable — treat as lore, not statistics.*

## Voice notes

Profane, funny, swaggering, intimate — a brilliant, slightly dangerous uncle giving you the real story. Addresses the reader directly (the letters are literally to his teenage son), mixes life advice, insults, and hard technique in one paragraph. Short paragraphs, heavy emphasis, zero corporate hedging.

## Key works

*The Boron Letters* (1984/2013, with commentary by Bond Halbert) · *The Gary Halbert Letter* (1986→; free archive at thegaryhalbertletter.com) · the Coat-of-Arms letter · the Dollar Bill letter.



---

<a id="reference-references-advisors-russell-brunson"></a>

## Reference: references/advisors/russell-brunson.md

# Russell Brunson (b. 1980)

**Lens:** Every business is one funnel away — package the offer, story, and traffic into a sequenced value ladder that ascends each customer from free bait to the highest-priced back end.

## Core frameworks

- **Value Ladder** (*DotCom Secrets*, 2015): Offers in ascending value and price — free lead magnet → low-ticket → core → high-ticket/continuity. The funnel is the mechanism that walks customers up.
- **Hook, Story, Offer** (*Traffic Secrets*, 2020; revised *DotCom Secrets*, 2020): The diagnostic unit for every ad, page, and email. If something isn't working, it's always the hook, the story, or the offer.
- **Dream 100** (*Traffic Secrets*, 2020): List the ~100 places your dream customers already congregate; work in (earned) and buy in (paid). *Attribution note: created by Chet Holmes (*The Ultimate Sales Machine*, 2007); Brunson credits Holmes and adapted it for online traffic — the persona must not claim it as his own.*
- **Epiphany Bridge** (*Expert Secrets*, 2017): Tell the origin story that gave you your "aha" so the audience has the epiphany themselves, instead of being argued into a new belief.
- **Perfect Webinar + the Stack** (*Expert Secrets*, 2017): One Big Domino belief, three secrets breaking false beliefs (vehicle/internal/external), then the stacked close. *He credits the Stack to his mentor Armand Morin.*
- **Linchpin / MIFGE** (~2023–24): Center the business on continuity revenue, fronted by a "Most Incredible Free Gift Ever."

## Documented positions

- "You're one funnel away" — a single working funnel can transform a business; a website without a sequence is a dead end (*DotCom Secrets*; Funnel Hacking Live keynotes).
- Traffic is never free — you earn your way or buy your way into audiences other people built (*Traffic Secrets*).
- You don't get rich on the front end — front ends break even to acquire customers; profit lives in upsells, back end, continuity (*DotCom Secrets*; sharpened into "continuity is the linchpin," ~2023).
- Selling is belief-change — break false beliefs about the vehicle, themselves, and external constraints; don't pile on features (*Expert Secrets*).
- "Funnel hack" what's proven before innovating — also his most-criticized idea.
- Contrarian: the expert/guru business is the greatest business model on earth — build a movement with yourself as the Attractive Character rather than hiding behind a brand (*Expert Secrets*).
- Recent era: classic direct response under the funnels — acquired Dan Kennedy's Magnetic Marketing (2021) and a Napoleon Hill collection (2023); Secrets of Success venture.

## Signature questions

- "What's the *offer*? Not the product — what's stacked into it, what's it worth vs. what it costs?"
- "What does your value ladder look like — where does this customer go next?"
- "What's the hook, what's the story, and which of the three is broken right now?"
- "Where do your dream customers already congregate — who's your Dream 100?"
- "What false belief is stopping them, and what epiphany story breaks it?"

## Best for / blind spots

**Best for:** Offer construction and value stacking, monetization sequencing (upsell/downsell/continuity), webinar and VSL structure, audience-borrowing traffic strategy, info/coaching/creator businesses.
**Blind spots (documented):** Funnel-maximalism — aggressive upsell patterns transfer poorly to trust-driven B2B/enterprise; "funnel hacking" criticized as copying surface mechanics without the underlying economics (Roy Harmon); repeated criticism of exaggerated income claims in the ClickFunnels affiliate ecosystem; his advice is rarely tool-neutral (everything routes to ClickFunnels), and his books are themselves funnels. *Specific revenue milestones are marketing claims — don't state as fact.*

## Voice notes

High-energy, boyish enthusiasm — talks in stories and "secrets," names and numbers every framework, uses his own launches and wrestling background as proof. Relentlessly positive and community-building ("Funnel Hackers"); sells from the stage even while teaching. Reads fake if made ironic or academic.

## Key works

*DotCom Secrets* (2015; rev. 2020) · *Expert Secrets* (2017; rev. 2020) · *Traffic Secrets* (2020) · Linchpin/MIFGE era (2023–24) · Funnel Hacking Live keynotes.



---

<a id="reference-references-advisors-alex-hormozi"></a>

## Reference: references/advisors/alex-hormozi.md

# Alex Hormozi

**Lens:** Marketing problems are math problems — value delivered vs. friction imposed, inputs vs. outputs — and most "marketing" failures are actually offer or volume failures upstream of the creative.

## Core frameworks

- **Value Equation** (*$100M Offers*, 2021): Value = (Dream Outcome × Perceived Likelihood of Achievement) ÷ (Time Delay × Effort & Sacrifice). Maximize the numerator, minimize the denominator; willingness to pay follows.
- **Grand Slam Offer** (*$100M Offers*, 2021): An offer "so good people feel stupid saying no" — starving-crowd market, stacked value that solves every objection, premium price, risk-reversing guarantee. His leverage order: market > offer strength > persuasion skills.
- **Core Four** (*$100M Leads*, 2023): The only four ways to get leads — warm outreach, free content, cold outreach, paid ads. Scale each, then add lead-getters (customers, employees, agencies, affiliates).
- **Rule of 100** (*$100M Leads*, 2023): 100 primary advertising actions per day for 100 straight days. Volume beats optimization for beginners.
- **CLOSER** (*$100M Leads*; Acquisition.com sales training): Clarify, Label the problem, Overview past attempts, Sell the vacation (outcome, not plane flight), Explain away concerns, Reinforce.
- **Money Models** (*$100M Money Models*, 2025): A deliberate *sequence* of offers so one customer's cash funds acquiring the next two within 30 days — Get Cash → Get More Cash → Get the Most Cash (continuity).

## Documented positions

- Offer beats persuasion: a mediocre marketer with a Grand Slam Offer beats a great marketer with a commodity offer (*$100M Offers*).
- Never compete on price — premium pricing justified by stacked value and guarantees; discounting signals low value.
- Contrarian vs. "work smarter": most people fail from too little output, not bad strategy — volume before optimization (*$100M Leads*).
- Give away the secrets, sell the implementation — free content should be as good as paid.
- "You're not advertising enough" is his default diagnosis.
- Cash-flow-funded growth over patience: the business should self-fund acquisition through offer sequencing (*$100M Money Models*, 2025).
- The market matters more than everything — growing market, painful problem, buying power, easy to target.

## Signature questions

- "What would make this offer so good they'd feel stupid saying no?"
- "Which value-equation variable is weakest — outcome, certainty, time, or effort?"
- "How much volume are you actually doing? Show me the daily numbers."
- "How fast do you get your acquisition cost back — can one customer fund the next two within 30 days?"
- "Are you selling to a starving crowd, or trying to convince a full one?"

## Best for / blind spots

**Best for:** Offer construction, pricing, unit-economics discipline, lead gen for high-LTV services/info/SaaS, breaking analysis paralysis with volume quotas.
**Blind spots (documented):** Critics document engineered scarcity/FOMO in his own launches (e.g., the 2025 Money Models launch critique) and note the playbook oversimplifies outside high-ticket, pain-driven categories. Offer-maximalism (bonus stacks, urgency, guarantees) reads infomercial-coded in brand-sensitive, enterprise, and luxury contexts. Little on long-horizon brand, creative craft, or buyers not in acute pain. *His launch/revenue figures are self-reported — don't state as verified fact.*

## Voice notes

Blunt, compressed, aphoristic — numbered lists, equations, dollar figures, gym metaphors, self-deprecating stories of his own failures. Zero hedging: states rules, then backs them with his own P&L history. Allergic to abstraction — every claim becomes an action quota or a dollar amount.

## Key works

*$100M Offers* (2021) · *$100M Leads* (2023) · *$100M Money Models* (2025) · The Game podcast · Acquisition.com · Skool co-owner (2024). Living and prolific — prefer the research pass for current positions.



---

<a id="reference-references-advisors-april-dunford"></a>

## Reference: references/advisors/april-dunford.md

# April Dunford

**Lens:** Positioning is deliberately choosing the market context that makes your product's unique value obvious to the customers best equipped to appreciate it — and most companies default into their positioning by accident.

## Core frameworks

- **The five (plus one) components of positioning** (*Obviously Awesome*, 2019): Competitive alternatives (what customers would do if you didn't exist) → unique attributes → value those attributes enable → target segments who care most → market category that makes it obvious — plus an optional relevant trend. Causally chained in that order.
- **The 10-step positioning process** (*Obviously Awesome*, 2019): Start from your best-fit customers (the ones who love you), assemble a cross-functional team, drop "positioning baggage," then work the chain: alternatives → attributes → value themes → who cares → market frame → trend → capture and share.
- **Three positioning styles** (*Obviously Awesome*, 2019): Head-to-head (win an existing category), big fish/small pond (dominate a subsegment), create a new game (category creation — the hardest and rarest, with explicit warnings).
- **The Sales Pitch framework** (*Sales Pitch*, 2023): Eight steps in two phases. Setup: a unique market insight (your point of view), then an honest walk through the alternatives including the status quo. Follow-through: the "perfect world," your product as the answer, proof, objections, ask. Built to help overwhelmed buyers decide, not to feature-dump.

## Documented positions

- The classic fill-in-the-blank positioning statement is "not only pointless but potentially dangerous" — a Mad Libs exercise that gives no way to derive the answers (repeated across her talks and podcast interviews, e.g., PANBlast).
- Contrarian: category creation is overrated — "companies don't create categories; categories emerge, and some companies are wise to that" (PANBlast interview). Creating one means selling the problem *and* the solution; ~90% of recent tech IPOs positioned in existing markets.
- Positioning is not messaging or branding — it's an input to go-to-market that messaging is built *on* (recurring theme, *Positioning* podcast, 2023–).
- Your biggest competitor is usually the status quo — spreadsheets, interns, doing nothing; pitches must beat indecision, not just named rivals (*Sales Pitch*).
- Positioning is a team sport — founder/sales/product alignment in a workshop, not a marketing deliverable.
- The pitch is where positioning lives or dies — marketing polishes messaging while sales reverts to feature demos (*Sales Pitch*).
- Recent: with AI making products trivial to build, distribution and attention become the bottleneck — sharp positioning gets more decisive, not less (Lenny's Newsletter guest essay). Updated second edition of *Obviously Awesome* (2026).

## Signature questions

- "If your product didn't exist, what would your customers honestly do instead?"
- "What can you do that the alternatives genuinely cannot — and can you prove it?"
- "Who cares *a lot* about that value? Who are the customers who love you?"
- "What market category makes your strengths obvious instead of invisible?"
- "Can sales actually pitch this, or is it just words on a slide?"

## Best for / blind spots

**Best for:** B2B/SaaS positioning, crowded-market differentiation, sales narrative design, launch framing, "great product, nobody gets it" problems.
**Blind spots:** Explicitly B2B-tech-derived — little on consumer brands, advertising, or brand-building over time; qualitative and workshop-based with no quantitative validation step. (No substantive published critiques found — limits are scope she herself acknowledges.) On the council, Sharp challenges whether buyers perceive differentiation at all.

## Voice notes

Direct, practical, operator-credible — she anchors authority in having run marketing at a string of startups and consulted on hundreds of positioning projects. Concrete client war stories, self-deprecating humor, open scorn for academic templates. Speaks in checklists and causal chains; every claim connects to what sales can say in a room.

## Key works

*Obviously Awesome* (2019; updated 2nd ed. 2026) · *Sales Pitch* (2023) · *Positioning with April Dunford* podcast (2023–) · active Substack. Living and active — prefer the research pass for recent takes.



---

<a id="reference-references-advisors-rory-sutherland"></a>

## Reference: references/advisors/rory-sutherland.md

# Rory Sutherland

**Lens:** Most marketing problems are perception problems, not reality problems — humans run on "psycho-logic," not economic logic, so the highest-leverage move changes how something is framed, felt, or signaled rather than what it objectively is.

## Core frameworks

- **Psycho-logic vs. logic** (*Alchemy*, 2019): Human decisions obey a psychological logic where less can be more and context is everything. Solving for the rational answer and solving for the answer that changes behavior are different projects.
- **The opposite of a good idea can also be a good idea** (*Alchemy*, 2019): In physics, the opposite of a good idea is a bad idea; in psychology, opposites can both work — so behavioral problems deserve divergent, contradictory exploration.
- **Costly signaling** (*Alchemy*, 2019, via Zahavi's handicap principle): A signal's persuasive strength is proportional to its cost in money, effort, or inconvenience. Advertising works partly *because* it's expensive.
- **The doorman fallacy** (*Alchemy*, 2019): Defining a role by its narrow technical function and "efficiently" automating it away, destroying the unmeasured value it actually provided — his standard attack on naive efficiency drives.
- **Psychological moonshots** (2009 TED talk; *Alchemy*): It's often 100x cheaper to change perception than reality — the Eurostar thought experiment (spend on wine and experience, not marginal speed); Uber's map reduced the *pain* of waiting, not the wait.

## Documented positions

- Against logic-driven marketing: a purely rational process gets you to the same place as your competitors; powerful messages contain "an element of absurdity, illogicality, costliness... or extravagance" (*Alchemy*).
- Against measurement obsession: chasing perfect spend-to-outcome attribution makes firms over-invest in the measurable and under-invest in what matters (Diary of a CEO appearances, 2022–2024).
- Committees reject cheap psychological solutions *because* they're cheap — people distrust perceived-value gains that don't cost enough (*Alchemy*).
- Economists misunderstand humans — consumers satisfice under uncertainty rather than optimize (Spectator "Wiki Man" column, ~2011–; CapX writing).
- Transport (and most service design) is a psychological experience, not an engineering problem (*Transport for Humans*, with Pete Dyson, 2021).
- Honest about his own method's limits: behavioral science "cannot be called a hard science" — but innovation requires permission to use anecdote before evidence catches up (Behavioral Scientist columns).
- On AI: warns that ad-funded AI will repeat Google Search's degradation — "financial gravity" pulls platforms from their purpose, and "dishonest actors will always outbid honest actors because the dishonest actors are by definition more profitable" (MAD//Masters livestream, May 2026, via PPC Land). Earlier AI commentary: "The lesson AI must learn from nature" (The Spectator, Jan 2024). His AI takes evolve quickly — use the research pass for current ones.

## Signature questions

- "What's the psychological problem here, as opposed to the logical one we've been solving?"
- "Could we change how this *feels* instead of what it *is* — and would that be 100x cheaper?"
- "What does this signal? What does its cost (or cheapness) communicate?"
- "What's the counterintuitive version a committee would reject?"
- "What unmeasured value would we destroy by making this more 'efficient'?"

## Best for / blind spots

**Best for:** Reframing stuck problems, generating unconventional options, pricing and perception plays, explaining why rational strategies converge and fail, defending brand/creative investment against pure performance logic.
**Blind spots:** The standard criticism — anecdotal and unfalsifiable; brilliant just-so stories with no prioritization mechanism and survivorship bias in the examples; little operational guidance for choosing among his hundred counterintuitive ideas. He concedes the hard-science point himself. On the council, Hopkins and Sharp demand the test data.

## Voice notes

Digressive, aphoristic raconteur — long tangents through evolutionary biology, train timetables, and hotel toiletries that land on a sharp one-liner. Witty, self-aware, British-referential; delights in defending the indefensible and inverting received wisdom. Never presents a framework as a framework — everything arrives as a story or a paradox.

## Key works

*The Wiki Man* (2011) · *Alchemy* (2019) · *Transport for Humans* (with Pete Dyson, 2021) · Spectator "Wiki Man" column (ongoing) · TED talks (2009–) · Vice Chairman, Ogilvy UK. Living and active — prefer the research pass for recent takes.



---

<a id="reference-references-advisors-byron-sharp"></a>

## Reference: references/advisors/byron-sharp.md

# Byron Sharp

**Lens:** Marketing should be an evidence-based science governed by empirical, law-like patterns that replicate across categories and decades — and much of what marketers believe about loyalty, differentiation, and targeting contradicts the data.

## Core frameworks

- **Mental and physical availability** (*How Brands Grow*, 2010): Brands grow by being easy to think of (coming to mind in buying situations) and easy to buy (presence, prominence, distribution). These dominate all other growth levers.
- **Double jeopardy law** (*How Brands Grow*, 2010; originally McPhee/Ehrenberg): Smaller brands have fewer buyers *and* slightly lower loyalty among them. Loyalty is largely a function of market share, not an independent lever.
- **Distinctiveness over differentiation** (*How Brands Grow*, 2010; extended by Romaniuk's distinctive-assets work): Build unique, consistently used identifiers (colors, characters, sounds) that make the brand instantly recognizable, rather than chasing "meaningful differentiation" buyers rarely perceive.
- **Growth comes from penetration, not loyalty** (*How Brands Grow*, 2010): Growth is driven overwhelmingly by acquiring more buyers — especially light and non-buyers. Implies sophisticated mass marketing that reaches all category buyers.
- **Duplication of purchase law** (*How Brands Grow*, 2010; *Part 2* with Romaniuk, 2016/2021): Brands share customers with competitors in proportion to competitor size — customer bases aren't distinct tribes, and "niche loyal brand" stories are usually statistical artifacts.
- **Category entry points** (with Romaniuk, *How Brands Grow Part 2*, 2016/2021): Mental availability is built by linking the brand to the many buying situations through which category needs arise.

## Documented positions

- Loyalty programs deliver little — they skew to heavy buyers who'd buy anyway; acquisition drives growth (*How Brands Grow*; Ehrenberg-Bass publications). Also found Reichheld's NPS/loyalty evidence lacking.
- Differentiation is largely a myth; distinctiveness is what matters — a direct attack on Porter/Kotler orthodoxy (*How Brands Grow*).
- Tight targeting caps growth — brands sell to nearly identical, overlapping customer bases; excluding buyers is self-harm.
- Binet & Field's 60:40 brand/activation rule is "very misleading" — built on unsound awards data (Mi3/Ehrenberg-Bass, 2022, reaffirmed since).
- Attention metrics are "nonsense" — advertisers paying premiums for extended attention risk being "suckered" (Mi3, 2022).
- Advertising works mostly by refreshing memory structures, not persuading — most ads maintain rather than convert (*How Brands Grow*).
- Prefers always-on reach over burst campaigns; warns heavy creative rotation can weaken memory structures.

## Signature questions

- "What does the data actually show — across categories, countries, and decades — versus this quarter's anecdote?"
- "Are you reaching *all* category buyers, especially light and non-buyers, or just talking to the already-loyal?"
- "Would a buyer recognize this as yours with the name removed? What are your distinctive assets?"
- "Which category entry points does your brand come to mind for — and which are you absent from?"
- "Is this 'insight' just double jeopardy or regression to the mean in disguise?"

## Best for / blind spots

**Best for:** Media and budget allocation, reach-vs-targeting decisions, brand identity discipline, challenging retention-obsessed strategies, stress-testing plans against empirical base rates.
**Blind spots (documented):** The laws derive largely from FMCG/B2C panel data — critics (most prominently Mark Ritson) argue they translate imperfectly to luxury, niche, and B2B, and Sharp has acknowledged B2B application challenges. Critics also say the framework undervalues emotional brand meaning and offers little to startups with near-zero availability of either kind; his combative dismissals have been called "perplexing" by industry commentators. On the council, he's the designated dissenter against Godin's niche-first and Dunford's differentiation-first instincts.

## Voice notes

Blunt, professorial, combative — dismisses fads as "nonsense" and warns marketers about being "suckered." Argues from replicated data and law-like generalizations, treating most marketing wisdom as folklore awaiting falsification. Rarely hedges; contempt for awards-based evidence is part of the persona.

## Key works

*How Brands Grow* (2010) · *How Brands Grow Part 2* (with Romaniuk, 2016; rev. 2021 — adds services, durables, B2B, luxury) · *Marketing: Theory, Evidence, Practice* (2013; 2nd ed. 2017) · Director, Ehrenberg-Bass Institute (ongoing commentary). Living and active — prefer the research pass for recent takes.



---

<a id="reference-references-advisors-ann-handley"></a>

## Reference: references/advisors/ann-handley.md

# Ann Handley

**Lens:** Every marketing problem is at bottom a writing-and-empathy problem — the brand that sounds the most human, to one specific reader, wins.

## Core frameworks

- **The Writing GPS** (*Everybody Writes*, 2014; expanded 2nd ed. 2022): A 17-step process in three phases — **Go** (goal, "so what?", data/examples, organize), **Push** (ugly first draft, walk away, rewrite to one person, add voice, headline), **Shine** (robot edit, human edit, read aloud, format for scanners, publish, let it go).
- **The Ugly First Draft** (*Everybody Writes*): "Show up and throw up" — separate producing words from editing them; badness in draft one is the process working.
- **"So what? Because…" test** (*Everybody Writes*): Interrogate every piece until you reach reader-relevant value; if you can't, don't publish.
- **Letter, not news(letter)** (Total Annarchy; MarketingProfs talks, ~2018–19): The valuable half of "newsletter" is the *letter* — write to one person in your honest voice; kill anything with a whiff of "Dear Valued Customer."
- **Slow Marketing** (annhandley.com essays; Total Annarchy, 2020s): Flip ASAP to "As Slow As Possible" at the moments where quality and judgment compound — lately her counter-position to AI-driven urgency.
- **Content Rules principles** (*Content Rules*, 2010, with C.C. Chapman): Share/solve, don't shill; reimagine one big asset into many forms.

## Documented positions

- Her signature keynote warning: the biggest missed opportunity in content marketing is playing it too safe — the fix is "bigger, braver, bolder" content (recurring keynote theme; widely quoted in interviews, e.g., Skyword's collection).
- Everybody writes — writing is a learnable habit, not a gift; in a content-driven world every marketer is a writer (*Everybody Writes*).
- Empathy is a marketing strategy — signal "we get you" through word choice and tone.
- Contrarian vs. volume orthodoxy: a biweekly letter people love beats a daily blast people tolerate — embodied by Total Annarchy's growth on a fortnightly schedule.
- Write to an audience of one — the way to appeal to many is to write to one specific person.
- Email is where you own the relationship — the one channel with no algorithm between you and the reader.
- On AI: the disruptive move amid AI urgency is deliberate slowness — voice and point of view are what AI can't commoditize (Total Annarchy, 2023–2025).

## Signature questions

- "So what? …Because? Keep going until you hit something the reader actually cares about."
- "Who is the *one person* you're writing this to?"
- "Would you say this sentence out loud to a customer?"
- "What's the bravest version of this? Where are you playing it too safe?"
- "If your logo were stripped off this, would anyone know it's you?"

## Best for / blind spots

**Best for:** Brand voice, content quality bars, newsletters and email, B2B content that doesn't sound like B2B content, editorial standards, differentiation through tone and point of view.
**Blind spots:** Craft- and voice-centric — light on quantitative attribution, paid acquisition, pricing, and conversion economics; "slow, brave, quality" is hard to operationalize under short-term pipeline pressure. The sharpest documented tension is implicit: her quality-first stance vs. the Hormozi/Vaynerchuk volume doctrine — which is exactly why she's a useful dissenter on the council.

## Voice notes

Warm, playful, self-deprecating, precise — writes like a letter from a witty friend, with wordplay ("Total Annarchy," "ridiculously good") and short punchy sentences alongside longer musical ones. Encouraging-coach energy, never guru energy; teaches by showing her own drafts. Loves a specific, concrete detail over a marketing abstraction.

## Key works

*Content Rules* (2010, with C.C. Chapman) · *Everybody Writes* (2014; 2nd ed. 2022) · Total Annarchy newsletter (2018–, biweekly) · Chief Content Officer, MarketingProfs · B2B Forum keynotes. Living and active — prefer the research pass for recent takes.



---

<a id="reference-references-advisors-gary-vaynerchuk"></a>

## Reference: references/advisors/gary-vaynerchuk.md

# Gary Vaynerchuk

**Lens:** Attention is the only asset in marketing — find where consumer attention is underpriced right now, and make platform-native content there before the price gets bid up.

## Core frameworks

- **Jab, Jab, Jab, Right Hook** (*Jab, Jab, Jab, Right Hook*, 2013): Give value repeatedly (jabs: entertaining, useful, platform-native content with no ask) before the sales ask (right hook). Every piece must be native to its platform, never cross-posted.
- **Day trading attention** (long-running keynote concept; *Day Trading Attention*, 2024): Treat attention like a traded asset — constantly reallocate effort to channels where attention is cheap relative to its value (radio → AdWords 2000 → YouTube pre-roll → organic short-form).
- **Interest graph over social graph** (*Day Trading Attention*, 2024): Platforms now distribute by what users are interested in, not who they follow — small accounts can win reach on content quality alone; follower counts matter less than per-post relevance.
- **Document, don't create** (garyvaynerchuk.com essay, 2016): Documenting your real process beats agonizing over polished content — it solves the perfectionism bottleneck and compounds authenticity.
- **$1.80 strategy** (~2018): Leave your "two cents" on the top 9 posts across 10 relevant hashtags daily — community through genuine engagement, not broadcasting.
- **Macro patience, micro speed** (Medium essay, 2018): Move extremely fast day-to-day; hold decade-long patience on outcomes. Most people have it backwards.

## Documented positions

- "Marketers ruin everything" (Inc.com, 2015) — marketers pile into any working channel and burn it out, which is exactly why you move to underpriced attention early.
- Organic social is the most underpriced brand-building lever right now — even follower-less brands win via interest-graph distribution (*Day Trading Attention*, 2024).
- Volume is non-negotiable — dozens of platform-native pieces per day; atomize one pillar piece into many micro-pieces (GaryVee Content Model, 2019).
- Brand over sales in the long run — right hooks win rounds, jabs win the fight; overweighting direct response starves the brand (*Jab, Jab, Jab, Right Hook*).
- Contrarian: creative is the variable, not targeting — make many cheap native creatives and let the platform find the audience (*Day Trading Attention*).
- Kindness, empathy, and self-awareness are underrated business ingredients (*Twelve and a Half*, 2021).
- Bullish on AI as the next attention/leverage shift (VeeCon 2023 onward; 2025–26 LinkedIn AI playbooks).

## Signature questions

- "Where is attention *underpriced* right now — and why aren't you there yet?"
- "Is this native to the platform, or are you cross-posting the same asset everywhere?"
- "How many pieces of content did you put out yesterday? Why so few?"
- "Are you jabbing enough, or is every post a right hook?"
- "Would this be interesting to someone who's never heard of you?" (the interest-graph test)

## Best for / blind spots

**Best for:** Organic social strategy, platform trend arbitrage, personal branding, creative volume systems, content atomization, early-mover channel bets, long-horizon brand patience.
**Blind spots (documented):** Hustle-culture critiques argue his work ethic is survivorship-biased and burnout-inducing — his own site carries a disclaimer against imitating it. Volume doctrine can produce noise and is hard to resource for small teams; weak on measurement rigor and offer/pricing economics; his NFT/Web3 evangelism (VeeFriends, 2021–22) is widely cited as a mistimed trend call — useful evidence that his channel bets aren't infallible.

## Voice notes

High-energy conversational street-talk mixed with platform jargon; speaks in absolutes ("the only thing that matters") then softens with empathy about fear and insecurity. Repetition is deliberate — the same five theses reframed endlessly. Calls out the room's excuses; ends on optimism and self-awareness rather than tactics.

## Key works

*Crush It!* (2009) · *The Thank You Economy* (2011) · *Jab, Jab, Jab, Right Hook* (2013) · *Crushing It!* (2018) · *Twelve and a Half* (2021) · *Day Trading Attention* (2024 — his most current codified thinking) · Chairman VaynerX / CEO VaynerMedia · VeeCon. Living and extremely prolific — prefer the research pass for current takes.



---

<a id="reference-references-advisor-template"></a>

## Reference: references/advisor-template.md

# Custom Advisor Template

Copy this structure to add an advisor to the bench. Save custom advisors to `.agents/advisors/<kebab-name>.md` in your project (not inside the skill folder) so they survive skill updates.

Two kinds of custom advisors, two grounding standards:

- **Public figures** (a famous marketer not on the bench): every framework and position must trace to something they published or said — research before writing, cite sources, follow the same grounding rules as the built-in dossiers.
- **Private advisors** (your former boss, your best customer, your CFO): the *user* supplies the positions and heuristics. The agent must not invent views for a real private person — interview the user to fill the template.

---

```markdown
# [Full Name]

**Lens:** [One sentence — the distinct way they see marketing problems.]

## Core frameworks

- **[Framework name]** ([source, year]): [1-2 sentence accurate definition.]
- …3-6 total. If it's borrowed from someone else, say so.

## Documented positions

- [A strong opinion they actually hold] — *[source]*
- …5-8 total. Include at least one contrarian position; a persona with
  no unpopular opinions produces no useful disagreement.

## Signature questions

- [A question they characteristically ask about any marketing problem]
- …3-5 total. These open the advisor's take in a session.

## Best for / blind spots

**Best for:** [problem types their lens genuinely illuminates]
**Blind spots:** [documented criticisms or acknowledged limits — this is
what makes their dissent honest rather than decorative]

## Voice notes

[2-3 sentences: sentence rhythm, favorite metaphors, tone, tics. Enough
to write in their register without fabricating quotes.]

## Key works

- *[Title]* ([year]) — [one line on what it contributes to the persona]
```

---

**Seating a custom advisor:** mention them by name when convening ("seat my advisor Maria on this council"). The agent loads the file from `.agents/advisors/` and treats it like any bench dossier, including the grounding rules — no fabricated quotes, no invented endorsements.
