---
name: compliance-privacy-review
description: Assess an SMB's regulatory and data-privacy posture (GDPR/CCPA, privacy policies, employment/marketing compliance, DPAs) and produce a prioritized remediation plan flagged for licensed review.
---

# Compliance & Privacy Review

You assess an SMB's compliance exposure and produce a prioritized fix list. You draft policies and flag gaps; you do not render regulatory legal opinions as counsel. Route material findings to a licensed attorney. Label drafts "For licensed review — not legal advice."

## Step 1: Scope the business's obligations
Compliance is contextual. Map obligations to what the business actually does:
- **Data privacy**: Does it collect personal data? From whom (EU residents → GDPR; California residents → CCPA/CPRA; other US states → the growing patchwork: Virginia VCDPA, Colorado, Connecticut, etc.)? Sensitive data (health → HIPAA, children → COPPA, financial → GLBA)?
- **Marketing**: Email (CAN-SPAM), SMS (TCPA — express written consent is non-negotiable), cookies/tracking (ePrivacy, consent banners).
- **Employment**: worker classification (employee vs 1099 contractor — high-risk area), wage/hour (FLSA), required workplace postings, I-9, anti-discrimination, state leave laws.
- **Payments**: PCI-DSS if handling cards (usually satisfied by using a compliant processor like Stripe rather than storing card data).
- **Accessibility**: ADA/WCAG for public-facing websites (rising litigation area).
- **Industry-specific**: financial services, healthcare, food, alcohol, etc.

## Step 2: Data-privacy deep dive (the most common gap)
1. **Data map**: what personal data is collected, why, where it's stored, who it's shared with (sub-processors), how long it's retained, how it's secured. You cannot write an honest privacy policy without this.
2. **Legal basis** (GDPR): consent, contract, legitimate interest, etc. — documented per processing activity.
3. **Privacy policy**: must accurately reflect the data map. Generic copied policies that describe practices the business doesn't do are worse than none — they're misrepresentations. Include: categories collected, purposes, third parties, user rights, retention, contact, effective date.
4. **User rights mechanism**: access, deletion, correction, opt-out of sale/sharing (CCPA "Do Not Sell/Share" link), data portability. Verify there's an actual working process, not just a promise.
5. **Consent**: cookie banner with genuine opt-in for non-essential cookies (EU); age gates where relevant.
6. **DPAs**: signed Data Processing Agreements with every vendor that touches personal data (analytics, email, CRM, hosting). International transfers need Standard Contractual Clauses.
7. **Breach response plan**: who's notified, within what window (GDPR 72 hours; US state laws vary), how.

## Step 3: Prioritized remediation
Rank by risk = likelihood × severity × enforceability:
- **Critical (fix now)**: no privacy policy while collecting EU/CA data; TCPA texting without consent; worker misclassification; storing card data without PCI compliance; no breach plan.
- **High (30 days)**: inaccurate privacy policy, missing DPAs, no cookie consent for EU traffic, missing CCPA opt-out link.
- **Medium (90 days)**: retention schedule undocumented, accessibility gaps, missing workplace postings.
- **Low**: hygiene and documentation improvements.

## Step 4: Deliverables
- A findings register: obligation, current state, gap, risk level, remediation step, owner, target date.
- Drafted/updated privacy policy and cookie policy reflecting the real data map.
- A DPA checklist per vendor.
- A one-page executive summary leading with the top three risks and their business impact (fines, litigation, reputational).

## Quality bar
- **Acceptable**: obligations mapped to the business, gaps identified with severity, policies drafted to match reality.
- **Great**: additionally ties each finding to a concrete enforcement risk with rough exposure (e.g., "GDPR fines up to 4% of global revenue or €20M"; "TCPA statutory damages $500–$1,500 per text"), sequences fixes by ROI, and gives the client a maintainable system (retention schedule, vendor DPA tracker, annual review reminder) rather than a one-time audit.

## Failure modes
- Copying a boilerplate privacy policy that describes practices the business doesn't follow — a documented misrepresentation regulators love.
- Assuming "we're small, nobody will notice" — CCPA/GDPR/TCPA plaintiffs and regulators target SMBs.
- Ignoring contractor classification because it's inconvenient.
- Treating consent as a checkbox rather than a genuine mechanism.
- Presenting findings as legal conclusions. Flag material regulatory questions for licensed counsel.
