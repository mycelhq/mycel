---
name: content-strategy
description: "When the user wants to plan a content strategy, decide what content to create, or figure out what topics to cover. Also use when the user mentions \"content strategy,\" \"what should I write about,\" \"content ideas,\" \"blog strategy,\" \"topic clusters,\" \"content planning,\" \"editorial calendar,\" \"content marketing,\" \"content roadmap,\" \"what content should I create,\" \"blog topics,\" \"content pillars,\" or \"I don't know what to write.\" Use this whenever someone needs help deciding what content to produce, not just writing it. For writing individual pieces, see copywriting. For SEO-specific audits, see seo-audit. For social media content specifically, see social."
source: https://github.com/coreyhaines31/marketingskills/blob/d4ff28a/skills/content-strategy/SKILL.md
license: MIT
attribution: Corey Haines — github.com/coreyhaines31/marketingskills (MIT)
---

<!-- HARVESTED, NOT WRITTEN HERE. 3 upstream file(s) flattened into one; every
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

# Content Strategy

You are a content strategist. Your goal is to help plan content that drives traffic, builds authority, and generates leads by being either searchable, shareable, or both.

## Before Planning

**Check for product marketing context first:**
If `.agents/product-marketing.md` exists (or `.claude/product-marketing.md`, or the legacy `product-marketing-context.md` filename, in older setups), read it before asking questions. Use that context and only ask for information not already covered or specific to this task.

Gather this context (ask if not provided):

### 1. Business Context
- What does the company do?
- Who is the ideal customer?
- What's the primary goal for content? (traffic, leads, brand awareness, thought leadership)
- What problems does your product solve?

### 2. Customer Research
- What questions do customers ask before buying?
- What objections come up in sales calls?
- What topics appear repeatedly in support tickets?
- What language do customers use to describe their problems?

### 3. Current State
- Do you have existing content? What's working?
- What resources do you have? (writers, budget, time)
- What content formats can you produce? (written, video, audio)

### 4. Competitive Landscape
- Who are your main competitors?
- What content gaps exist in your market?

---

## Treat Content Like a Product

Every piece is its own launch. Content isn't overhead—it's **brand surface area**: each published piece is a new entry point where a stranger can discover you, and hundreds of pieces compound into hundreds of doorways working 24/7. Plan, ship, and promote each piece with the same intent you'd bring to a product release. A post that's written and forgotten has almost no surface area; a post that's distributed (see **Create Once, Distribute Twice** below) multiplies it.

This section covers the searchable/shareable lens, then the execution and prioritization layer: which pieces to make (scoring), how the calendar splits, and per-format discipline.

## Searchable vs Shareable

Every piece of content must be searchable, shareable, or both. Prioritize in that order—search traffic is the foundation.

**Searchable content** captures existing demand. Optimized for people actively looking for answers.

**Shareable content** creates demand. Spreads ideas and gets people talking.

### When Writing Searchable Content

- Target a specific keyword or question
- Match search intent exactly—answer what the searcher wants
- Use clear titles that match search queries
- Structure with headings that mirror search patterns
- Place keywords in title, headings, first paragraph, URL
- Provide comprehensive coverage (don't leave questions unanswered)
- Include data, examples, and links to authoritative sources
- Optimize for AI/LLM discovery: clear positioning, structured content, brand consistency across the web

### When Writing Shareable Content

- Lead with a novel insight, original data, or counterintuitive take
- Challenge conventional wisdom with well-reasoned arguments
- Tell stories that make people feel something
- Create content people want to share to look smart or help others
- Connect to current trends or emerging problems
- Share vulnerable, honest experiences others can learn from

---

## Content Types

### Searchable Content Types

**Use-Case Content**
Formula: [persona] + [use-case]. Targets long-tail keywords.
- "Project management for designers"
- "Task tracking for developers"
- "Client collaboration for freelancers"

**Hub and Spoke**
Hub = comprehensive overview. Spokes = related subtopics.
```
/topic (hub)
├── /topic/subtopic-1 (spoke)
├── /topic/subtopic-2 (spoke)
└── /topic/subtopic-3 (spoke)
```
Create hub first, then build spokes. Interlink strategically.

**Note:** Most content works fine under `/blog`. Only use dedicated hub/spoke URL structures for major topics with layered depth (e.g., Atlassian's `/agile` guide). For typical blog posts, `/blog/post-title` is sufficient.

**Template Libraries**
High-intent keywords + product adoption.
- Target searches like "marketing plan template"
- Provide immediate standalone value
- Show how product enhances the template

### Shareable Content Types

**Thought Leadership**
- Articulate concepts everyone feels but hasn't named
- Challenge conventional wisdom with evidence
- Share vulnerable, honest experiences

**Data-Driven Content**
- Product data analysis (anonymized insights)
- Public data analysis (uncover patterns)
- Original research (run experiments, share results)

**Expert Roundups**
15-30 experts answering one specific question. Built-in distribution.

**Case Studies**
Structure: Challenge → Solution → Results → Key learnings

**Meta Content**
Behind-the-scenes transparency. "How We Got Our First $5k MRR," "Why We Chose Debt Over VC."

### Link-Earning Formats

When the goal of a piece is backlinks specifically, format choice matters more than production effort. Foundation Inc.'s B2B Backlink Intelligence Report (March 2026 — a single vendor study of B2B SaaS sites, so treat as directional) measured each format's share of backlinks relative to its share of pages:

| Format | Backlinks vs. page share |
|---|---|
| Statistics / data roundups | **4.25x** |
| Glossary / definition pages | 1.47x |
| Interactive tools / calculators (see **free-tools**) | 1.38x |
| How-to / tutorials | 1.36x |
| Original research / reports | 0.80x |
| Ultimate guides | 0.77x |
| Thought leadership | 0.74x |
| Templates / frameworks | 0.68x |

The counterintuitive read: **curating statistics earns ~5x the links of producing original research.** Writers link to whatever makes citation easiest — a maintained stat-roundup page is citation infrastructure, while original research often gets cited *via* the roundups that aggregate it. Implications: (1) publish a stats page for your category and keep it fresh — it's cheap and compounds, and citable one-line stats are also what LLMs lift, making it an AI-visibility play (see **ai-seo**); (2) when you do run original research, pair it with your own stat-roundup page that presents the findings as citable one-liners, so you capture the links your data generates. The formats at the bottom aren't dead — guides, templates, and thought leadership earn their keep on rankings, conversions, and brand. Judge each piece by the job it's for, and don't expect links from formats that don't earn them.

For programmatic content at scale, see **programmatic-seo** skill.

---

## Content Pillars and Topic Clusters

Content pillars are the 3-5 core topics your brand will own. Each pillar spawns a cluster of related content.

Most of the time, all content can live under `/blog` with good internal linking between related posts. Dedicated pillar pages with custom URL structures (like `/guides/topic`) are only needed when you're building comprehensive resources with multiple layers of depth.

### How to Identify Pillars

1. **Product-led**: What problems does your product solve?
2. **Audience-led**: What does your ICP need to learn?
3. **Search-led**: What topics have volume in your space?
4. **Competitor-led**: What are competitors ranking for?

### Pillar Structure

```
Pillar Topic (Hub)
├── Subtopic Cluster 1
│   ├── Article A
│   ├── Article B
│   └── Article C
├── Subtopic Cluster 2
│   ├── Article D
│   ├── Article E
│   └── Article F
└── Subtopic Cluster 3
    ├── Article G
    ├── Article H
    └── Article I
```

### Pillar Criteria

Good pillars should:
- Align with your product/service
- Match what your audience cares about
- Have search volume and/or social interest
- Be broad enough for many subtopics

---

## Keyword Research by Buyer Stage

Map topics to the buyer's journey using proven keyword modifiers:

### Awareness Stage
Modifiers: "what is," "how to," "guide to," "introduction to"

Example: If customers ask about project management basics:
- "What is Agile Project Management"
- "Guide to Sprint Planning"
- "How to Run a Standup Meeting"

### Consideration Stage
Modifiers: "best," "top," "vs," "alternatives," "comparison"

Example: If customers evaluate multiple tools:
- "Best Project Management Tools for Remote Teams"
- "Asana vs Trello vs Monday"
- "Basecamp Alternatives"

### Decision Stage
Modifiers: "pricing," "reviews," "demo," "trial," "buy"

Example: If pricing comes up in sales calls:
- "Project Management Tool Pricing Comparison"
- "How to Choose the Right Plan"
- "[Product] Reviews"

### Implementation Stage
Modifiers: "templates," "examples," "tutorial," "how to use," "setup"

Example: If support tickets show implementation struggles:
- "Project Template Library"
- "Step-by-Step Setup Tutorial"
- "How to Use [Feature]"

---

## Content Ideation Sources

### 1. Keyword Data

If user provides keyword exports (Ahrefs, SEMrush, GSC), analyze for:
- Topic clusters (group related keywords)
- Buyer stage (awareness/consideration/decision/implementation)
- Search intent (informational, commercial, transactional)
- Quick wins (low competition + decent volume + high relevance)
- Content gaps (keywords competitors rank for that you don't)

Output as prioritized table:
| Keyword | Volume | Difficulty | Buyer Stage | Content Type | Priority |

### 2. Call Transcripts

If user provides sales or customer call transcripts, extract:
- Questions asked → FAQ content or blog posts
- Pain points → problems in their own words
- Objections → content to address proactively
- Language patterns → exact phrases to use (voice of customer)
- Competitor mentions → what they compared you to

Output content ideas with supporting quotes.

### 3. Survey Responses

If user provides survey data, mine for:
- Open-ended responses (topics and language)
- Common themes (30%+ mention = high priority)
- Resource requests (what they wish existed)
- Content preferences (formats they want)

### 4. Forum Research

Use web search to find content ideas:

**Reddit:** `site:reddit.com [topic]`
- Top posts in relevant subreddits
- Questions and frustrations in comments
- Upvoted answers (validates what resonates)

**Quora:** `site:quora.com [topic]`
- Most-followed questions
- Highly upvoted answers

**Other:** Indie Hackers, Hacker News, Product Hunt, industry Slack/Discord

Extract: FAQs, misconceptions, debates, problems being solved, terminology used.

### 5. Competitor Analysis

Use web search to analyze competitor content:

**Find their content:** `site:competitor.com/blog`

**Analyze:**
- Top-performing posts (comments, shares)
- Topics covered repeatedly
- Gaps they haven't covered
- Case studies (customer problems, use cases, results)
- Content structure (pillars, categories, formats)

**Identify opportunities:**
- Topics you can cover better
- Angles they're missing
- Outdated content to improve on

### 6. Sales and Support Input

Extract from customer-facing teams:
- Common objections
- Repeated questions
- Support ticket patterns
- Success stories
- Feature requests and underlying problems

---

## Prioritizing Content Ideas

Score each idea on four factors:

### 1. Customer Impact (40%)
- How frequently did this topic come up in research?
- What percentage of customers face this challenge?
- How emotionally charged was this pain point?
- What's the potential LTV of customers with this need?

### 2. Content-Market Fit (30%)
- Does this align with problems your product solves?
- Can you offer unique insights from customer research?
- Do you have customer stories to support this?
- Will this naturally lead to product interest?

### 3. Search Potential (20%)
- What's the monthly search volume?
- How competitive is this topic?
- Are there related long-tail opportunities?
- Is search interest growing or declining?

### 4. Resource Requirements (10%)
- Do you have expertise to create authoritative content?
- What additional research is needed?
- What assets (graphics, data, examples) will you need?

### Scoring Template

| Idea | Customer Impact (40%) | Content-Market Fit (30%) | Search Potential (20%) | Resources (10%) | Total |
|------|----------------------|-------------------------|----------------------|-----------------|-------|
| Topic A | 8 | 9 | 7 | 6 | 8.0 |
| Topic B | 6 | 7 | 9 | 8 | 7.1 |

Score 1-10 per factor, multiply by the weight, sum for the total. Rank the list; make the top-scoring pieces first.

---

## Calendar Split: 60/30/10

Balance the editorial calendar so search compounds while shareable pieces keep you visible:

- **60% searchable** — the foundation. Demand you can capture predictably (use-case content, hub/spoke, how-tos).
- **30% shareable** — thought leadership, original data, opinion. Creates demand and earns links/mentions.
- **10% experimental** — new formats, channels, or bets. Cheap insurance against a stale mix.

This is a starting ratio, not a rule. A brand-new blog may over-index on searchable to build a base; an established brand chasing category leadership may push shareable higher.

---

## Per-Format Execution Discipline

Treating content like a product means each format has a production standard, not just a topic:

- **Blog post** — write **10 title options** before drafting (the title does most of the work; pick the strongest). Plan **~5 editing passes** (structure, clarity, evidence, line edit, headline/SEO). For the writing itself, see **copywriting**.
- **Long-form guide** — the flagship of a pillar. Comprehensive enough to be *the* resource; structured with a table of contents and internal links to spokes. Build the hub before the spokes.
- **Video** — script the hook first; front-load the payoff. Repurpose into short-form clips at creation time (see **social**).
- **Podcast** — one interview yields a transcript, quote graphics, short clips, and a written recap. Design the episode knowing it will be atomized.
- **Email** — one idea per send; the subject line is the title—write several and pick. For sequences and lifecycle, see **emails**.

---

## Create Once, Distribute Twice

Creating content is half the job—distribution is the other half, and most teams skip it. The philosophy: **one exceptional piece, reformatted and repurposed across every channel, not a fresh piece per platform.** Pouring effort into a single flagship and then distributing it everywhere beats spreading thin effort across many mediocre platform-native posts.

Build **distribution hooks into the piece at creation time**, not after: write subheads that stand alone as social posts, structure sections to be lifted out modularly, and pull quotes/stats you already know you'll graphic-ify. A well-designed guide is a distribution kit in disguise.

**The ORB Framework as a funnel** — route attention from borrowed → rented → owned, which maps to discovery → engagement → conversion:

- **Borrowed** (other people's audiences: podcasts, guest posts, partnerships) — discovery / breakthrough reach.
- **Rented** (social platforms, ad networks) — engagement, but you don't own the audience or the algorithm.
- **Owned** (email list, blog, community) — conversion and the only durable asset. Everything upstream should funnel here.

ORB mechanics live in the **launch** skill (channel-type playbook) and content atomization/repurposing lives in **social**; the value here is consolidating the *distribute* half of content strategy so it has a home.

**Failure modes to avoid:**
- **Spray-and-pray** — posting everywhere with no flagship and no repurposing plan. Effort scatters, nothing compounds.
- **Platform dependency** — building on rented land. Facebook organic reach fell from ~20% to under 2%; any rented channel can throttle you overnight.
- **The ownership paradox** — teams spend ~90% of effort on channels they don't control (rented/borrowed) and neglect the owned assets that actually convert and can't be taken away.

For the full distribution spine—the Content Distribution Flywheel, platform half-lives, and the atomization checklist—see the reference below.

---

## Output Format

When creating a content strategy, provide:

### 1. Content Pillars
- 3-5 pillars with rationale
- Subtopic clusters for each pillar
- How pillars connect to product

### 2. Priority Topics
For each recommended piece:
- Topic/title
- Searchable, shareable, or both
- Content type (use-case, hub/spoke, thought leadership, etc.)
- Target keyword and buyer stage
- Why this topic (customer research backing)

### 3. Topic Cluster Map
Visual or structured representation of how content interconnects.

---

## Task-Specific Questions

1. What patterns emerge from your last 10 customer conversations?
2. What questions keep coming up in sales calls?
3. Where are competitors' content efforts falling short?
4. What unique insights from customer research aren't being shared elsewhere?
5. Which existing content drives the most conversions, and why?

---

## References

- **[Content Distribution Spine](#reference-references-content-distribution)**: Create Once Distribute Twice, ORB as a funnel, the ownership paradox, platform half-lives, the Content Distribution Flywheel, and the per-flagship atomization checklist
- **[Headless CMS Guide](#reference-references-headless-cms)**: CMS selection, content modeling for marketing, editorial workflows, platform comparison (Sanity, Contentful, Strapi)

---

## Related Skills

- **copywriting**: For writing individual content pieces
- **seo-audit**: For technical SEO and on-page optimization
- **ai-seo**: For optimizing content for AI search engines and getting cited by LLMs
- **programmatic-seo**: For scaled content generation
- **site-architecture**: For page hierarchy, navigation design, and URL structure
- **emails**: For email-based content
- **social**: For social media content, content atomization, and repurposing execution
- **launch**: For the ORB channel-type playbook and launch-day distribution


---

<a id="reference-references-content-distribution"></a>

## Reference: references/content-distribution.md

# Content Distribution Spine

The "distribute" half of content strategy. Creating a great piece is table stakes; the leverage is in getting it seen. This reference expands the **Create Once, Distribute Twice** section of the skill.

Cross-links: ORB channel-type playbook lives in **launch**; atomization/repurposing workflows (podcast → clips, blog → thread) live in **social**. This file consolidates the strategy that ties them together—don't re-derive ORB from scratch here.

## Create Once, Distribute Twice

One exceptional piece, reformatted across channels—not a fresh piece per platform. The math is simple: a flagship piece plus ten repurposed cuts reaches far more people than eleven mediocre native posts, at a fraction of the effort.

The discipline is **designing the piece to be distributed**:
- Write subheads that read as standalone social posts.
- Structure sections modularly so they can be lifted out and stand alone.
- Pre-identify the pull quotes, stats, and frames you'll turn into graphics or short clips.
- Know the atomized outputs before you write, so the source piece contains them.

Treat the flagship as the master; every channel gets a cut derived from it.

## The ORB Framework as a Funnel

Own, Rent, Borrow—read as a discovery → engagement → conversion funnel:

| Layer | Channels | Funnel role | You control |
|---|---|---|---|
| **Borrowed** | Podcasts, guest posts, partnerships, PR, other people's audiences | Discovery / breakthrough | Nothing—it's a loan |
| **Rented** | Social platforms, ad networks, marketplaces | Engagement / reach | The content, not the audience or algorithm |
| **Owned** | Email list, blog, community, app | Conversion / retention | Everything—the durable asset |

The strategic move: use borrowed and rented reach to funnel strangers into owned channels where you can convert and retain them. Borrowed and rented are rented land; owned is the only asset you keep.

## The Ownership Paradox

Most teams invert the priority: they spend ~90% of effort on borrowed and rented channels they don't control, and neglect the owned assets that actually convert. The paradox is that the channels getting the least attention (email, blog, community) are the ones that compound and can't be revoked. Rebalance toward owned as the destination for all upstream effort.

## Failure Modes

- **Spray-and-pray** — publishing across every platform with no flagship and no repurposing system. Effort scatters; nothing compounds; each post starts from zero.
- **Platform dependency** — building your audience on rented land. Facebook organic reach collapsed from ~20% to under 2% as the platform monetized. Any rented channel can throttle, deprioritize, or de-platform you with no recourse. The lesson isn't "avoid rented"—it's "never let rented be the endpoint."

## Platform Half-Lives

Content decays at wildly different rates by channel. Match the piece to the channel's shelf life:

| Channel | Rough half-life | Implication |
|---|---|---|
| Twitter/X post | Minutes–hours | Post often; repost; thread for reach |
| Instagram / Facebook | ~a day | Frequent cadence; stories are ephemeral by design |
| LinkedIn post | ~a day, longer for strong performers | Fewer, higher-effort posts |
| TikTok / Reels / Shorts | Days–weeks (algorithmic resurfacing) | Evergreen hooks can re-surface long after posting |
| YouTube video | Months–years | Search-driven; compounds like a blog post |
| Blog post / SEO | Years | The long tail; the compounding asset |
| Email | Sent once, but archived / repurposable | One-shot attention; harvest into other formats |

Short half-life channels reward frequency and repetition; long half-life channels reward depth and evergreen framing. Owned, long-half-life formats (blog, YouTube, email archive) are where distribution effort compounds.

## The Content Distribution Flywheel

Distribution isn't a linear checklist—it's a loop that feeds itself:

1. **Create** one exceptional flagship piece (guide, video, podcast, original research), with distribution hooks built in.
2. **Atomize** it into channel-native cuts—clips, threads, carousels, quote graphics, email, subhead-posts.
3. **Distribute** across owned → rented → borrowed, routing everything back to owned.
4. **Engage** with the responses; capture the questions, objections, and reactions.
5. **Feed back** — the engagement surfaces the next flagship topic (what resonated, what got asked), and top-performing atoms signal what to make more of.

Each turn of the loop lowers the cost of the next piece (you learn what lands) and grows the owned audience that amplifies it. The flywheel is why consistent distributors pull away from one-off publishers over time.

## Atomization Checklist (per flagship)

For each major piece, produce (see **social** for the platform-native execution):
- [ ] 3–5 standalone social posts from the subheads/key points
- [ ] 1 thread (Twitter/X) or carousel (LinkedIn/Instagram) of the core argument
- [ ] 2–4 short-form video clips (if source is video/podcast)
- [ ] 1–2 quote or stat graphics
- [ ] 1 email to the owned list linking the flagship
- [ ] Repost/reshare schedule across the piece's half-life (don't post once and move on)

## Related

- **launch** — ORB channel-type playbook and launch-day distribution
- **social** — atomization/repurposing workflows and platform-native execution
- **emails** — the owned channel that converts distributed attention
- **ai-seo** — making owned content citable by LLMs (another distribution surface)



---

<a id="reference-references-headless-cms"></a>

## Reference: references/headless-cms.md

# Headless CMS Guide

Reference for choosing, modeling, and implementing a headless CMS for marketing content.

## When to Use This Reference

Use this when selecting a CMS for a new project, designing content models for marketing sites, setting up editorial workflows, or connecting CMS content to programmatic pages.

---

## Headless vs Traditional CMS

A headless CMS separates content management from presentation. Content is stored in a structured backend and delivered via API to any frontend.

### When Headless Makes Sense

- Multiple frontends consume the same content (web, mobile, email)
- Developers want full control over the frontend stack
- Content needs to be reused across channels
- You're building with a modern framework (Next.js, Remix, Astro)
- Marketing needs structured, reusable content blocks

### When Traditional Works Better

- Small team with no dedicated developers
- Simple blog or brochure site
- WYSIWYG editing is a hard requirement
- Budget is tight and WordPress/Webflow does the job

### Decision Checklist

| Factor | Headless | Traditional |
|--------|----------|-------------|
| Multi-channel delivery | Yes | Limited |
| Developer control | Full | Constrained |
| Non-technical editing | Requires setup | Built-in |
| Time to launch | Longer | Faster |
| Content reuse | Native | Manual |
| Hosting flexibility | Any frontend | Platform-dependent |

---

## Content Modeling for Marketing

### Core Principles

1. **Think in types, not pages.** A "Landing Page" is a content type with fields — not an HTML file. This lets you reuse components across pages.
2. **Separate content from presentation.** Store the headline text, not the styled headline. Presentation belongs in the frontend.
3. **Design for reuse.** If testimonials appear on 5 pages, create a Testimonial type and reference it — don't duplicate.
4. **Keep models flat.** Deeply nested structures are hard to query and maintain. Prefer references over nesting.

### Common Marketing Content Types

| Type | Key Fields | Notes |
|------|-----------|-------|
| **Landing Page** | title, slug, hero, sections[], seo | Modular sections for flexibility |
| **Blog Post** | title, slug, body, author, category, tags, publishedAt, seo | Rich text or Portable Text body |
| **Case Study** | title, customer, challenge, solution, results, metrics[], logo | Link to related products/features |
| **Testimonial** | quote, author, role, company, avatar, rating | Reference from landing pages |
| **FAQ** | question, answer, category | Group by category for programmatic pages |
| **Author** | name, bio, avatar, social links | Reference from blog posts |
| **CTA Block** | heading, body, buttonText, buttonUrl, variant | Reusable across pages |

### SEO Fields Checklist

Every page-level content type needs:

- `metaTitle` — 50-60 characters
- `metaDescription` — 150-160 characters
- `ogImage` — 1200x630px social preview
- `slug` — URL path segment
- `canonicalUrl` — optional override
- `noIndex` — boolean for excluding from search
- `structuredData` — optional JSON-LD override

---

## Editorial Workflows

### Draft → Review → Publish Cycle

1. **Draft** — Author creates or edits content
2. **Review** — Editor reviews for accuracy, brand voice, SEO
3. **Approve** — Stakeholder signs off
4. **Schedule** — Set publish date/time
5. **Publish** — Content goes live via API

### Preview APIs

All major headless CMS platforms support draft previews:

- **Sanity**: Real-time preview with `useLiveQuery` or Presentation tool
- **Contentful**: Preview API (`preview.contentful.com`) with separate access token
- **Strapi**: Draft & Publish system with `status=draft` query parameter (v5; replaces v4's `publicationState`)

Set up a preview route in your frontend (e.g., `/api/preview`) that authenticates and renders draft content.

### Roles and Permissions

| Role | Can Create | Can Edit | Can Publish | Can Delete |
|------|:----------:|:--------:|:-----------:|:----------:|
| Author | Yes | Own | No | Own drafts |
| Editor | Yes | All | Yes | Drafts |
| Admin | Yes | All | Yes | All |

Exact permission models vary by platform. Sanity uses role-based access. Contentful has space-level roles. Strapi has granular RBAC.

---

## Platform Comparison

| Feature | Sanity | Contentful | Strapi |
|---------|--------|------------|--------|
| Hosting | Cloud (managed) | Cloud (managed) | Self-hosted or Cloud |
| Query Language | GROQ | REST / GraphQL | REST / GraphQL |
| Free Tier | Generous | Limited | Open source (free) |
| Real-time Collab | Yes (built-in) | Limited | No |
| Best For | Developer flexibility | Enterprise multi-locale | Budget / self-hosted |
| Content Modeling | Schema-as-code | Web UI | Web UI or code |
| Media Handling | Built-in DAM | Built-in | Plugin-based |

### Sanity

**Strengths**: GROQ query language is powerful and flexible. Schema defined in code (version-controlled). Real-time collaborative editing. Portable Text for rich content. Generous free tier.

**Considerations**: Steeper learning curve for non-developers. Studio customization requires React knowledge. Vendor lock-in on GROQ queries.

**Marketing fit**: Best when developers and marketers collaborate closely. Strong for content-heavy sites with complex models.

### Contentful

**Strengths**: Mature enterprise platform. Excellent multi-locale support. Strong ecosystem of integrations. Composable content with Studio. Well-documented APIs.

**Considerations**: Pricing scales with content types and locales. Two separate APIs (Delivery and Management). Rate limits can be tight on lower plans.

**Marketing fit**: Best for enterprises with multi-market content needs. Good when you need established vendor reliability.

### Strapi

**Strengths**: Open source, self-hosted option. Full control over data. No per-seat pricing. Customizable admin panel. Plugin ecosystem. REST by default, GraphQL via plugin.

**Considerations**: Self-hosting means you handle infrastructure. Smaller ecosystem than Sanity/Contentful. V5 migration can be significant from V4.

**Marketing fit**: Best for teams with DevOps capability who want full control and no vendor lock-in. Good for budget-conscious projects.

### Others Worth Knowing

- **Hygraph** — GraphQL-native, strong for federation and multi-source content
- **Keystatic** — Git-based, good for developer-content hybrid workflows
- **Payload** — TypeScript-first, self-hosted, code-configured like Sanity
- **Builder.io** — Visual editor with headless backend, good for non-technical marketers
- **Prismic** — Slice-based content modeling, strong Next.js integration

---

## Integration with Marketing Skills

### Programmatic SEO

Use CMS as the data source for programmatic pages. Store structured data (FAQs, comparisons, city pages) as content types and generate pages from queries. See **programmatic-seo** skill.

### Copywriting

CMS content models enforce consistent structure. Define fields that match your copy frameworks (headline, subheadline, social proof, CTA). See **copywriting** skill.

### Site Architecture

URL structure, navigation hierarchy, and internal linking all depend on how content is organized in the CMS. Plan your content model and site architecture together. See **site-architecture** skill.

### Email Sequences

Pull CMS content into email templates for consistent messaging across web and email. Case studies, testimonials, and blog posts can feed email nurture sequences. See **emails** skill.

---

## Implementation Checklist

- [ ] Define content types based on page types and reusable blocks
- [ ] Add SEO fields to every page-level content type
- [ ] Set up preview/draft mode in your frontend
- [ ] Configure roles and permissions for your team
- [ ] Create sample content for each type before building frontend
- [ ] Set up webhook notifications for content changes (rebuild triggers)
- [ ] Document content guidelines for editors (field descriptions, character limits)
- [ ] Test content delivery performance (CDN, caching, ISR)
- [ ] Plan migration strategy if moving from existing CMS

---

## Relevant Integration Guides

- Sanity — GROQ queries, mutations, CLI
- Contentful — Delivery/Management APIs, publishing
- Strapi — REST CRUD, filters, document API


---

*Upstream also pointed at tools/integrations/contentful.md, tools/integrations/sanity.md, tools/integrations/strapi.md. Not carried here: it is a catalogue of third-party tools rather than procedure, and this skill has to hold up without it.*
