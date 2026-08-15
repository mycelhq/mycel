---
name: contract-review
description: Review a counterparty's contract for an SMB client — spot the risky terms, redline them, and produce a plain-English risk memo ranked by severity, flagged for licensed review.
---

# Contract Review & Redlining

You are reviewing an inbound contract someone wants your client to sign. Your job is to find where the client is exposed, propose specific redlines, and explain the risk in plain English. You are not counsel; end every deliverable with "For licensed attorney review before signing. Not legal advice."

## Step 1: Orient before reading line-by-line
Identify in the first pass: Which side is your client? What is the deal (buy/sell/partner/employ)? What's the dollar exposure and duration? Who drafted it (whoever drafted it favored themselves — read defensively). A $5k one-month deal and a $500k three-year deal deserve very different scrutiny; calibrate depth to stakes.

## Step 2: Hunt the high-leverage clauses first
Review in risk order, not document order. The clauses that actually move money and risk:
1. **Limitation of liability** — Is there a cap? At what multiple? Is it mutual? What's carved out? A missing or uncapped liability clause on your client's side is a top-severity finding.
2. **Indemnification** — What must your client defend/pay for? Is it broad ("any claims arising from") or scoped? Is it one-sided? Does it survive termination?
3. **IP ownership & license** — Who owns what's created? Is there an unintended assignment of your client's background IP or tools?
4. **Payment terms** — Net terms, late fees, right to suspend/withhold, setoff, most-favored-pricing traps.
5. **Termination** — Can the counterparty exit for convenience while your client is locked in? Notice period? What happens to prepaid amounts and in-flight work?
6. **Auto-renewal** — Evergreen renewal + long notice window = trap. Flag every time.
7. **Non-compete / exclusivity / non-solicit** — Scope, geography, duration; reasonableness (many are unenforceable but chilling).
8. **Confidentiality** — Duration, definition breadth, residuals clause, return/destruction.
9. **Warranties & disclaimers** — What is your client promising? "AS IS" received from a vendor?
10. **Governing law / venue / dispute resolution** — Inconvenient forum, mandatory arbitration, jury/class waivers, fee-shifting ("loser pays").
11. **Assignment & change of control** — Can the counterparty assign the contract to a competitor?
12. **Data/privacy & security** — DPA, breach notification timelines, GDPR/CCPA obligations if PII flows.

## Step 3: Classify every finding by severity
- **RED (do not sign as-is)**: uncapped liability, broad one-sided indemnity, IP assignment of client's core assets, unbounded term with no exit, personal guarantee the client didn't intend.
- **YELLOW (negotiate)**: unfavorable but survivable — asymmetric caps, short cure periods, auto-renewal, inconvenient venue.
- **GREEN (acceptable / market-standard)**: note it so the client knows it was reviewed, not missed.

## Step 4: Redline with specific replacement language
Don't just say "this is bad." For each RED/YELLOW, provide (a) the offending text quoted, (b) why it's a problem in one plain sentence, (c) proposed substitute language, and (d) a fallback if the counterparty resists. Example: "Liability is uncapped. Propose: 'Each party's aggregate liability shall not exceed the fees paid in the 12 months preceding the claim, except for [confidentiality, IP indemnity, gross negligence].' Fallback: 2x fees."

## Step 5: Deliver the risk memo
Structure: one-paragraph executive summary ("recommend signing after 3 changes" / "do not sign without renegotiating liability and IP") → ranked findings table (clause, severity, issue, proposed fix) → the redlined document. Lead with the decision, not the details.

## Quality bar
- **Acceptable**: every clause in Step 2 addressed, severities assigned, redlines provided.
- **Great**: additionally catches cross-clause interactions (a broad indemnity + no liability cap = unlimited exposure), notices what's *missing* (no DPA where PII flows, no order of precedence between MSA and SOW), and tells the client the two things to negotiate hard vs the five to concede for goodwill.

## Failure modes
- Reviewing in document order and running out of attention before the liability clause at the back.
- Flagging market-standard terms as problems (erodes credibility).
- Missing absent clauses — the most dangerous risks are often what the contract *doesn't* say.
- Redlining tone: keep it collaborative, not adversarial, unless the client wants to walk.
- Never approve for signature as counsel; route to a licensed attorney.
