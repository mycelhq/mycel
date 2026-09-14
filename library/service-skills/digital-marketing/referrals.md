---
name: referrals
description: "When the user wants to create, optimize, or analyze a referral program, affiliate program, or word-of-mouth strategy. Also use when the user mentions 'referral,' 'affiliate,' 'ambassador,' 'word of mouth,' 'viral loop,' 'refer a friend,' 'partner program,' 'referral incentive,' 'how to get referrals,' 'customers referring customers,' or 'affiliate payout.' Use this whenever someone wants existing users or partners to bring in new customers. For launch-specific virality, see launch."
source: https://github.com/coreyhaines31/marketingskills/blob/d4ff28a/skills/referrals/SKILL.md
license: MIT
attribution: Corey Haines — github.com/coreyhaines31/marketingskills (MIT)
---

<!-- HARVESTED, NOT WRITTEN HERE. 4 upstream file(s) flattened into one; every
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

# Referral & Affiliate Programs

You are an expert in viral growth and referral marketing. Your goal is to help design and optimize programs that turn customers into growth engines.

## Before Starting

**Check for product marketing context first:**
If `.agents/product-marketing.md` exists (or `.claude/product-marketing.md`, or the legacy `product-marketing-context.md` filename, in older setups), read it before asking questions. Use that context and only ask for information not already covered or specific to this task.

Gather this context (ask if not provided):

### 1. Program Type
- Customer referral program, affiliate program, or both?
- B2B or B2C?
- What's the average customer LTV?
- What's your current CAC from other channels?

### 2. Current State
- Existing referral/affiliate program?
- Current referral rate (% who refer)?
- What incentives have you tried?

### 3. Product Fit
- Is your product shareable?
- Does it have network effects?
- Do customers naturally talk about it?

### 4. Resources
- Tools/platforms you use or consider?
- Budget for referral incentives?

---

## Should You Engineer Virality First?

Before building a reward-driven program, check whether virality can be **built into the product** — often cheaper and more durable than paid referrals. But **don't force virality where it doesn't naturally fit.**

Place the product on the **Viral Potential Spectrum**:
- **Natural** (build for it): collaboration tools, communication tools, user-facing outputs — every use exposes the product to non-users.
- **Limited** (don't force it): backend, competitive-advantage, internal-only, and infrastructure products. Invest in referral programs, content, and partnerships instead.

If the product is on the natural end, consider **product-embedded viral mechanisms** (Powered By badges, exposure loops, social sharing, embeds, watermarks) before or alongside a reward program.

**For the spectrum diagnostic, the 7 viral mechanisms, value-presentation and timing best practices, and affiliate power-law mechanics**: See [references/viral-mechanisms.md](#reference-references-viral-mechanisms)

---

## Referral vs. Affiliate

### Customer Referral Programs

**Best for:**
- Existing customers recommending to their network
- Products with natural word-of-mouth
- Lower-ticket or self-serve products

**Characteristics:**
- Referrer is an existing customer
- One-time or limited rewards
- Higher trust, lower volume

### Affiliate Programs

**Best for:**
- Reaching audiences you don't have access to
- Content creators, influencers, bloggers
- Higher-ticket products that justify commissions

**Characteristics:**
- Affiliates may not be customers
- Ongoing commission relationship
- Higher volume, variable trust

---

## Referral Program Design

### The Referral Loop

```
Trigger Moment → Share Action → Convert Referred → Reward → (Loop)
```

### Step 1: Identify Trigger Moments

**High-intent moments:**
- Right after first "aha" moment
- After achieving a milestone
- After exceptional support
- After renewing or upgrading

### Step 2: Design Share Mechanism

**Ranked by effectiveness:**
1. In-product sharing (highest conversion)
2. Personalized link
3. Email invitation
4. Social sharing
5. Referral code (works offline)

### Step 3: Choose Incentive Structure

**Single-sided rewards** (referrer only): Simpler, works for high-value products

**Double-sided rewards** (both parties): Higher conversion, win-win framing

**Tiered rewards**: Gamifies referral process, increases engagement

**Present the reward with the bigger-*feeling* number** — "lead with the larger number" (say "$10 off," not "40% off," on a low-priced product). Reward at the **aha moment or milestone**, not signup. Reduce friction: one-click share, pre-written messages.

**For examples and incentive sizing**: See [references/program-examples.md](#reference-references-program-examples)

**For product-embedded virality, value-presentation rules, and affiliate power-law mechanics**: See [references/viral-mechanisms.md](#reference-references-viral-mechanisms)

---

## Program Optimization

### Improving Referral Rate

**If few customers are referring:**
- Ask at better moments
- Simplify sharing process
- Test different incentive types
- Make referral prominent in product

**If referrals aren't converting:**
- Improve landing experience for referred users
- Strengthen incentive for new users
- Ensure referrer's endorsement is visible

### A/B Tests to Run

**Incentive tests:** Amount, type, single vs. double-sided, timing

**Messaging tests:** Program description, CTA copy, landing page copy

**Placement tests:** Where and when the referral prompt appears

### Common Problems & Fixes

| Problem | Fix |
|---------|-----|
| Low awareness | Add prominent in-app prompts |
| Low share rate | Simplify to one click |
| Low conversion | Optimize referred user experience |
| Fraud/abuse | Add verification, limits |
| One-time referrers | Add tiered/gamified rewards |

---

## Measuring Success

### Key Metrics

**Program health:**
- Active referrers (referred someone in last 30 days)
- Referral conversion rate
- Rewards earned/paid

**Business impact:**
- % of new customers from referrals
- CAC via referral vs. other channels
- LTV of referred customers
- Referral program ROI

### Typical Findings

- Referred customers have 16-25% higher LTV
- Referred customers have 18-37% lower churn
- Referred customers refer others at 2-3x rate

---

## Launch Checklist

### Before Launch
- [ ] Define program goals and success metrics
- [ ] Design incentive structure
- [ ] Build or configure referral tool
- [ ] Create referral landing page
- [ ] Set up tracking and attribution
- [ ] Define fraud prevention rules
- [ ] Create terms and conditions
- [ ] Test complete referral flow

### Launch
- [ ] Announce to existing customers
- [ ] Add in-app referral prompts
- [ ] Update website with program details
- [ ] Brief support team

### Post-Launch (First 30 Days)
- [ ] Review conversion funnel
- [ ] Identify top referrers
- [ ] Gather feedback
- [ ] Fix friction points
- [ ] Send reminder emails to non-referrers

---

## Email Sequences

### Referral Program Launch

```
Subject: You can now earn [reward] for sharing [Product]

We just launched our referral program!

Share [Product] with friends and earn [reward] for each signup.
They get [their reward] too.

[Unique referral link]

1. Share your link
2. Friend signs up
3. You both get [reward]
```

### Referral Nurture Sequence

- Day 7: Remind about referral program
- Day 30: "Know anyone who'd benefit?"
- Day 60: Success story + referral prompt
- After milestone: "You achieved [X]—know others who'd want this?"

---

## Affiliate Programs

**For detailed affiliate program design, commission structures, recruitment, and tools**: See [references/affiliate-programs.md](#reference-references-affiliate-programs)

**For affiliate power-law mechanics (buyout clauses ~12× monthly commission, the 20/80 super-promoter rule, launch-affiliate tactics)**: See [references/viral-mechanisms.md](#reference-references-viral-mechanisms)

---

## Task-Specific Questions

1. What type of program (referral, affiliate, or both)?
2. What's your customer LTV and current CAC?
3. Existing program or starting from scratch?
4. What tools/platforms are you considering?
5. What's your budget for rewards/commissions?
6. Is your product naturally shareable?

---

## Tool Integrations

For implementation, see the tools registry. Key tools for referral programs:

| Tool | Best For | Guide |
|------|----------|-------|
| **Rewardful** | Stripe-native affiliate programs | rewardful.md |
| **Tolt** | SaaS affiliate programs | tolt.md |
| **Mention Me** | Enterprise referral programs | mention-me.md |
| **Dub.co** | Link tracking and attribution | dub-co.md |
| **Stripe** | Payment processing (for commission tracking) | stripe.md |
| **Introw** | Channel partner programs with tiers, deal registration, QBRs | introw.md |
| **PartnerStack** | Enterprise partner and affiliate programs | partnerstack.md |

---

## Related Skills

- **launch**: For launching referral program effectively
- **emails**: For referral nurture campaigns
- **marketing-psychology**: For understanding referral motivation
- **analytics**: For tracking referral attribution


---

<a id="reference-references-viral-mechanisms"></a>

## Reference: references/viral-mechanisms.md

# Viral Mechanisms

Virality can be **engineered through product design**, not just bought with reward programs. But don't force it — decide *whether* virality fits your product before building anything.

## Contents
- Viral Potential Spectrum (the diagnostic)
- The 7 Viral Mechanisms
- Referral Best Practices (presentation, timing, friction)
- Affiliate Mechanics (buyout clauses, the 20/80 power law, launch tactics)

---

## Viral Potential Spectrum

Before engineering virality, place your product on the spectrum. **Don't force virality where it doesn't naturally fit.**

**Natural viral potential (build for it):**
- **Collaboration tools** — value grows when you invite others (docs, whiteboards, project management)
- **Communication tools** — you can't use them alone (email, scheduling, messaging)
- **User-facing outputs** — every use produces something others see (design, video, forms, links)

**Limited viral potential (don't force it):**
- **Backend / infrastructure** — invisible to end users
- **Competitive-advantage tools** — users *hide* that they use them (their edge)
- **Internal-only tools** — never leave the org
- **Infrastructure** — plumbing no one talks about

If you're on the limited end, invest in referral programs, content, and partnerships instead of embedding viral loops that won't fire.

---

## The 7 Viral Mechanisms

Most are **non-incentive** — the loop is built into the product, not paid for.

### 1. "Powered By" Badges
A small attributed badge on user-facing output ("Powered by [Product]"). Every page/form/widget a customer ships becomes an ad. Often free-tier only (paid tier removes it).

### 2. Exposure Loops
The product's normal use exposes it to non-users.
- **Calendly / SavvyCal** — every meeting invite you send shows the tool to the recipient, who often becomes a user.
- **Superhuman email signatures** ("Sent via Superhuman") — works as a **status signal**, not just attribution. The signature signaled early-adopter status, so recipients *wanted* it. Exposure loops are strongest when using the product confers status.

### 3. Social Sharing
Make output natively shareable with a branded hook.
- **#MadeWithGlide** — a hashtag turns every user creation into discoverable social proof.
- One-tap "share to X/LinkedIn" on any milestone, result, or artifact.

### 4. Embed Options
Let users embed their content elsewhere; the embed carries your brand and a link back.
- **Notion, Figma, Loom** — embedded docs, designs, and videos spread the product to every viewer on every host site.

### 5. Watermarks / Mandatory Badges
Like "Powered By" but harder to remove — baked into the output itself.
- **OpusClips** watermark on generated clips.
- **"Made in Webflow"** badge on free-plan sites.
Free tier carries the mark; paid tier removes it. The free users become the distribution.

### 6. Referral Programs
Explicit incentives for referring. Covered in detail in [program-examples.md](#reference-references-program-examples) and below. The one *incentive-driven* mechanism on this list — use it when the product itself doesn't naturally spread.

### 7. Product-Driven Word-of-Mouth
The purest form: the product is so good, novel, or useful that people tell others unprompted. Not a mechanism you bolt on — it's earned through the product experience. Engineering the other six makes this easier to trigger.

---

## Referral Best Practices

Detail beyond the core referral loop (trigger → share → convert → reward).

### Value Presentation: Lead With the Larger Number
Frame the reward with whichever number *looks* bigger.
- On a $25 product, say **"$10 off"** — not "40% off."
- On a $500 product, say **"20% off"** — not "$100 off" if the percentage frames better... but usually the absolute dollar figure wins for smaller prices.
- Rule of thumb: **under ~$100, lead with the dollar amount; over ~$100, test the percentage.** Always pick the bigger-*feeling* number.

### Reward Timing: Fire at the Aha / Milestone
Trigger the referral ask (and reward) at the moment the user has just felt the product's value — the **aha moment** or a **milestone** (first success, upgrade, streak). Motivation to share peaks right after value is experienced, not at signup.

### Double-Sided Rewards
Both referrer and referred get value. Higher conversion than single-sided, and gives the referrer a generous, non-selfish reason to share ("here's $10 for you too").

### Friction Reduction
Every extra step kills share rate.
- **One-click sharing** — pre-generated link, no form.
- **Pre-written messages** — draft the email/DM/post copy so the user just hits send.
- In-product placement at the trigger moment, not buried in settings.

---

## Affiliate Mechanics

Detail deferred from the partnerships side — for building an affiliate motion into a referral/partner strategy.

### Buyout Clauses (~12× Monthly Commission)
For high-performing affiliates on **recurring** commissions, include a **buyout clause**: the right to buy out the affiliate's future commission stream for a lump sum, commonly around **12× the monthly commission**. Protects margin on a customer the affiliate referred once but earns on forever, and gives the affiliate an attractive cash-out.

### The 20/80 Affiliate Power Law
Roughly **20% of affiliates drive ~80% of results**. Don't spread effort evenly across a long tail of dormant sign-ups. **Identify super-promoters and invest in them** — higher tiers, custom assets, co-marketing, direct relationship, early access. Recruiting 1,000 passive affiliates is worth less than activating 10 great ones.

### Launch-Affiliate Tactic (Cometly / Demio)
Time affiliate promotion around a **launch or a hard deadline** to concentrate volume. Cometly drove **$251K on a single launch day** by mobilizing affiliates simultaneously; Demio ran launch-window affiliate pushes. The mechanic: give affiliates a shared date, shared assets, and a reason for their audience to act *now* (bonus, cohort, closing offer) so promotion stacks instead of trickling.



---

<a id="reference-references-program-examples"></a>

## Reference: references/program-examples.md

# Referral Program Examples

Real-world examples of successful referral programs.

## Contents
- Dropbox (Classic)
- Uber/Lyft
- Morning Brew
- Notion
- Incentive Types Comparison
- Incentive Sizing Framework
- Viral Coefficient & Metrics (Key Metrics, Calculating Referral Program ROI)

## Dropbox (Classic)

**Program:** Give 500MB storage, get 500MB storage

**Why it worked:**
- Reward directly tied to product value
- Low friction (just an email)
- Both parties benefit equally
- Gamified with progress tracking

---

## Uber/Lyft

**Program:** Give $10 ride credit, get $10 when they ride

**Why it worked:**
- Immediate, clear value
- Double-sided incentive
- Easy to share (code/link)
- Triggered at natural moments

---

## Morning Brew

**Program:** Tiered rewards for subscriber referrals
- 3 referrals: Newsletter stickers
- 5 referrals: T-shirt
- 10 referrals: Mug
- 25 referrals: Hoodie

**Why it worked:**
- Gamification drives ongoing engagement
- Physical rewards are shareable (more referrals)
- Low cost relative to subscriber value
- Built status/identity

---

## Notion

**Program:** $10 credit per referral (education)

**Why it worked:**
- Targeted high-sharing audience (students)
- Product naturally spreads in teams
- Credit keeps users engaged

---

## Incentive Types Comparison

| Type | Pros | Cons | Best For |
|------|------|------|----------|
| Cash/credit | Universally valued | Feels transactional | Marketplaces, fintech |
| Product credit | Drives usage | Only valuable if they'll use it | SaaS, subscriptions |
| Free months | Clear value | May attract freebie-seekers | Subscription products |
| Feature unlock | Low cost to you | Only works for gated features | Freemium products |
| Swag/gifts | Memorable, shareable | Logistics complexity | Brand-focused companies |
| Charity donation | Feel-good | Lower personal motivation | Mission-driven brands |

---

## Incentive Sizing Framework

**Calculate your maximum incentive:**
```
Max Referral Reward = (Customer LTV × Gross Margin) - Target CAC
```

**Example:**
- LTV: $1,200
- Gross margin: 70%
- Target CAC: $200
- Max reward: ($1,200 × 0.70) - $200 = $640

**Typical referral rewards:**
- B2C: $10-50 or 10-25% of first purchase
- B2B SaaS: $50-500 or 1-3 months free
- Enterprise: Higher, often custom

---

## Viral Coefficient & Metrics

### Key Metrics

**Viral coefficient (K-factor):**
```
K = Invitations × Conversion Rate

K > 1 = Viral growth (each user brings more than 1 new user)
K < 1 = Amplified growth (referrals supplement other acquisition)
```

**Example:**
- Average customer sends 3 invitations
- 15% of invitations convert
- K = 3 × 0.15 = 0.45

**Referral rate:**
```
Referral Rate = (Customers who refer) / (Total customers)
```

Benchmarks:
- Good: 10-25% of customers refer
- Great: 25-50%
- Exceptional: 50%+

**Referrals per referrer:**

Benchmarks:
- Average: 1-2 referrals per referrer
- Good: 2-5
- Exceptional: 5+

### Calculating Referral Program ROI

```
Referral Program ROI = (Revenue from referred customers - Program costs) / Program costs

Program costs = Rewards paid + Tool costs + Management time
```

**Track separately:**
- Cost per referred customer (CAC via referral)
- LTV of referred customers (often higher than average)
- Payback period for referral rewards



---

<a id="reference-references-affiliate-programs"></a>

## Reference: references/affiliate-programs.md

# Affiliate Program Design

Detailed guidance for building and managing affiliate programs.

## Contents
- Commission Structures
- Cookie Duration
- Affiliate Recruitment
- Affiliate Enablement
- Tools & Platforms (Referral Program Tools, Affiliate Program Tools, Choosing a Tool)
- Fraud Prevention (Common Referral Fraud, Prevention Measures)

## Commission Structures

**Percentage of sale:**
- Standard: 10-30% of first sale or first year
- Works for: E-commerce, SaaS with clear pricing
- Example: "Earn 25% of every sale you refer"

**Flat fee per action:**
- Standard: $5-500 depending on value
- Works for: Lead gen, trials, freemium
- Example: "$50 for every qualified demo"

**Recurring commission:**
- Standard: 10-25% of recurring revenue
- Works for: Subscription products
- Example: "20% of subscription for 12 months"

**Tiered commission:**
- Works for: Motivating high performers
- Example: "20% for 1-10 sales, 25% for 11-25, 30% for 26+"

---

## Cookie Duration

How long after click does affiliate get credit?

| Duration | Use Case |
|----------|----------|
| 24 hours | High-volume, low-consideration purchases |
| 7-14 days | Standard e-commerce |
| 30 days | Standard SaaS/B2B |
| 60-90 days | Long sales cycles, enterprise |
| Lifetime | Premium affiliate relationships |

---

## Affiliate Recruitment

### Where to find affiliates:
- Existing customers who create content
- Industry bloggers and reviewers
- YouTubers in your niche
- Newsletter writers
- Complementary tool companies
- Consultants and agencies

### Outreach template:
```
Subject: Partnership opportunity — [Your Product]

Hi [Name],

I've been following your content on [topic] — particularly [specific piece] — and think there could be a great fit for a partnership.

[Your Product] helps [audience] [achieve outcome], and I think your audience would find it valuable.

We offer [commission structure] for partners, plus [additional benefits: early access, co-marketing, etc.].

Would you be open to learning more?

[Your name]
```

---

## Affiliate Enablement

Provide affiliates with:
- [ ] Unique tracking links/codes
- [ ] Product overview and key benefits
- [ ] Target audience description
- [ ] Comparison to competitors
- [ ] Creative assets (logos, banners, images)
- [ ] Sample copy and talking points
- [ ] Case studies and testimonials
- [ ] Demo access or free account
- [ ] FAQ and objection handling
- [ ] Payment terms and schedule

---

## Tools & Platforms

### Referral Program Tools

**Full-featured platforms:**
- ReferralCandy — E-commerce focused
- Ambassador — Enterprise referral programs
- Friendbuy — E-commerce and subscription
- GrowSurf — SaaS and tech companies
- Mention Me — AI-powered referral marketing
- Viral Loops — Template-based campaigns

**Built-in options:**
- Stripe (basic referral tracking)
- HubSpot (CRM-integrated)
- Segment (tracking and analytics)

### Affiliate Program Tools

**Affiliate networks:**
- ShareASale — Large merchant network
- Impact — Enterprise partnerships
- PartnerStack — SaaS focused
- Tapfiliate — Simple SaaS affiliate tracking
- FirstPromoter — SaaS affiliate management

**Partner Relationship Management (PRM):**
- Introw — Full PRM with deal registration, commissions, tiers, QBRs, and partner engagement tracking (integration guide)

**Self-hosted:**
- Rewardful — Stripe-integrated affiliates
- Refersion — E-commerce affiliates

### Choosing a Tool

Consider:
- Integration with your payment system
- Fraud detection capabilities
- Payout management
- Reporting and analytics
- Customization options
- Price vs. program scale

---

## Fraud Prevention

### Common Referral Fraud
- Self-referrals (creating fake accounts)
- Referral rings (groups referring each other)
- Coupon sites posting referral codes
- Fake email addresses
- VPN/device spoofing

### Prevention Measures

**Technical:**
- Email verification required
- Device fingerprinting
- IP address monitoring
- Delayed reward payout (after activation)
- Minimum activity threshold

**Policy:**
- Clear terms of service
- Maximum referrals per period
- Reward clawback for refunds/chargebacks
- Manual review for suspicious patterns

**Structural:**
- Require referred user to take meaningful action
- Cap lifetime rewards
- Pay rewards in product credit (less attractive to fraudsters)


---

*Upstream also pointed at tools/REGISTRY.md, tools/integrations/dub-co.md, tools/integrations/introw.md, tools/integrations/mention-me.md, tools/integrations/partnerstack.md, tools/integrations/rewardful.md, tools/integrations/stripe.md, tools/integrations/tolt.md. Not carried here: it is a catalogue of third-party tools rather than procedure, and this skill has to hold up without it.*
