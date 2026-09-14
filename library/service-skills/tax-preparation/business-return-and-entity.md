---
name: business-return-and-entity
description: Prepare SMB business returns (Schedule C, 1065, 1120-S, 1120) with correct entity treatment, basis, reasonable comp, and clean book-to-tax reconciliation.
---

# Business Return & Entity Taxation

You are preparing a business return. The entity type dictates the form, who pays the tax, and the traps. Start by confirming the entity's federal tax classification (it is not always what the client thinks — an LLC can be a disregarded entity, partnership, or S-corp by election).

## Entity → form map

- **Sole proprietor / single-member LLC (disregarded):** Schedule C on the owner's 1040. Net profit hits self-employment tax.
- **Partnership / multi-member LLC:** Form 1065, issues K-1s to partners. Pass-through; partners pay tax.
- **S-corporation (incl. LLC with S-election):** Form 1120-S, issues K-1s. Pass-through; **reasonable compensation** rule applies to owner-employees.
- **C-corporation:** Form 1120. Entity pays tax at 21%; dividends taxed again at shareholder level (double taxation).

## Book-to-tax reconciliation (the core mechanic)

Start from the client's books (ideally a clean trial balance from a completed close). Then reconcile book income to taxable income for **Schedule M-1** (or M-3 for larger entities): add back non-deductible items (50% of meals, penalties, political contributions, federal tax, life insurance premiums where the entity is beneficiary), and adjust for book-tax timing differences (depreciation being the big one). **Schedule L** is the balance sheet; **Schedule M-2** tracks the accumulated adjustments account (S-corp) or retained earnings. These must tie — a Schedule L that doesn't match the books signals the books weren't closed properly.

## Depreciation and fixed assets

Maintain the depreciation schedule (MACRS lives by asset class). Decide per asset: **Section 179 expensing** (immediate, limited by the annual cap and business-income limitation) vs. **bonus depreciation** (phasing down from 100%) vs. regular MACRS. Elect strategically — 179/bonus accelerate deductions but can strand losses or waste them in a low-income year; sometimes regular depreciation is the better multi-year answer. Track **listed property** (vehicles) with the luxury-auto caps and business-use percentage. Recapture on disposition (Form 4797).

## S-corp specifics (highest-risk area)

- **Reasonable compensation:** owner-employees must take a reasonable W-2 salary before distributions. The IRS attacks zero-salary/all-distribution structures. Benchmark salary to role, industry, hours, and what the business could pay a non-owner. Document the basis.
- **Basis and distributions:** track stock and debt basis (Form 7203). Distributions in excess of basis are taxable gain; losses are limited to basis. This is routinely missed and creates deferred landmines.
- **AAA** vs. retained earnings for S-corps with C-corp history.

## Partnership specifics

- **K-1 allocations** per the operating agreement; special allocations must have substantial economic effect.
- **Guaranteed payments** to partners (deductible to partnership, SE income to partner).
- **Partner basis and at-risk** limits; **capital account** reporting on the tax basis.
- **Self-employment tax** on general partners' distributive share.

## Pass-through owner coordination

For 1065/1120-S, the return's job is to produce correct K-1s that flow to owners' 1040s. Coordinate the **QBI deduction** (Form 8995-A) — the entity reports QBI, W-2 wages, and UBIA on the K-1 so the owner can compute the 20% deduction with the wage/threshold limits. Check for a **PTET (pass-through entity tax) election** — many states let the entity pay state tax as a SALT-cap workaround, deductible federally. This is frequently overlooked and worth real money.

## Deadlines and elections

- 1065 and 1120-S: 15th day of 3rd month (March 15 for calendar year). 1120 and Schedule C (via 1040): April 15. Extensions (7004 / 4868) extend filing, not payment.
- S-election (Form 2553) timing; accounting-method and inventory (Section 471 / 263A) considerations for larger entities.
- Issue required **1099-NECs** to contractors (>$600) — a checkbox on the return asks; non-compliance is penalized.

## Quality bar

**Great:** entity classification confirmed, books closed and tying to Schedule L, M-1 reconciliation complete and explainable, depreciation optimized across years, reasonable comp documented, basis tracked (7203/capital accounts), QBI and PTET captured, K-1s reconcile to the entity return, all 1099 obligations met. **Failing:** all-distribution S-corp with no salary, Schedule L that doesn't tie to the books, ignoring basis limits, or missing a PTET election that would have saved the owners thousands.
