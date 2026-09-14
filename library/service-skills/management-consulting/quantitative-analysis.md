---
name: quantitative-analysis
description: Run the analytical core of an engagement — data cleaning, sizing, modeling, benchmarking, and driver analysis — that produces defensible, decision-grade numbers.
---

# Quantitative Analysis

You do the number work that backs the recommendation. Consulting analysis must be decision-grade: right enough to bet on, transparent enough to defend, and focused on what actually moves the answer. Precision beyond what changes the decision is waste.

## Step 1: Plan the analysis to the hypothesis
Start from the workplan's hypotheses. For each, define the specific analysis that would confirm or refute it and the "so what" threshold (how big must the effect be to matter). Don't analyze data just because you have it — analyze to test a hypothesis that changes a decision.

## Step 2: Get and clean the data
- Inventory sources: client financials/ERP exports, CRM, ops data, surveys, third-party benchmarks, expert interviews.
- **Clean rigorously**: check for duplicates, missing values, unit inconsistencies, outliers, date-range mismatches, and definitional drift (does "revenue" mean the same thing across systems?). Dirty data silently poisons every downstream number.
- **Sanity-check totals** against a known anchor (audited financials, a headline KPI). If your bottom-up total doesn't tie to the top-line, find out why before proceeding.
- Document every assumption and transformation. Someone must be able to trace any number back to source.

## Step 3: The core analytical techniques
- **Market sizing (TAM/SAM/SOM)**: build both top-down (market reports scaled down) and bottom-up (units × price, or customers × spend) and triangulate. When they diverge, the reconciliation is where insight lives.
- **Driver analysis**: decompose an outcome into its drivers (revenue = volume × price × mix; churn by cohort/segment) and quantify each driver's contribution to the change. This localizes the problem.
- **Benchmarking**: compare the client to peers/best-in-class on the right unit-normalized metrics (per FTE, per unit, % of revenue). Explain gaps causally, don't just report them.
- **Financial modeling**: build a clean model (revenue, cost, cash) with explicit, labeled assumptions in one place, scenarios (base/upside/downside), and sensitivity analysis on the 2-3 assumptions that swing the answer most.
- **Cohort / segmentation analysis**: averages lie; segment by customer, product, geography, channel to find where value and problems concentrate (often heavily Pareto-distributed).

## Step 4: Model hygiene (non-negotiable)
- One assumptions block, clearly labeled, no hardcoded numbers buried in formulas.
- Inputs, calculations, and outputs visually separated; consistent units; no circular references.
- Every output traceable to inputs; a colleague can follow the logic without you.
- Order-of-magnitude gut check on every key output — does 3% churn/month imply a plausible annual number? Back-of-envelope sanity checks catch most catastrophic errors.

## Step 5: Extract the "so what"
Data is not insight. For every analysis, write the one-sentence implication: not "enterprise churn is 18%" but "enterprise churn (18% vs 6% for SMB) is destroying $4M/yr and is the single largest lever — a 5-point improvement recovers half the margin gap." Tie every number back to the decision.

## Quality bar
- **Acceptable**: clean data, correct sizing/model/benchmark, documented assumptions, defensible numbers.
- **Great**: triangulated estimates that reconcile, sensitivity analysis that shows which assumptions actually matter, segmentation that finds where value concentrates, sanity checks that would catch a 10x error, and every number carrying an explicit "so what" tied to the recommendation. Right level of precision — no false 4-decimal confidence on a rough estimate.

## Failure modes
- Analyzing without a hypothesis — producing charts nobody needs.
- Skipping data cleaning; building elegant models on garbage.
- No sanity check — a spreadsheet error becomes a headline recommendation.
- Hardcoded assumptions buried in formulas that no one can find or challenge.
- False precision that implies confidence the data doesn't support.
- Reporting data without extracting the "so what."
- Averages that hide the segments where the real story lives.
