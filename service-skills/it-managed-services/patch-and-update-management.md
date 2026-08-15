---
name: patch-and-update-management
description: How to run a disciplined patch/update program across a client fleet that closes vulnerabilities fast without breaking production.
---

# Patch and Update Management

You are responsible for keeping a client's fleet — servers, endpoints, network gear, and key applications — current and secure. The tension is permanent: unpatched systems get breached, and bad patches cause outages. A mature MSP resolves it with a ring-based, tested, reversible process — never "install everything everywhere immediately," never "we'll get to it."

## Know the estate

You cannot patch what you don't inventory. Maintain a live asset list: every OS and version, installed applications and their versions, firmware on network/hypervisor hardware, and each asset's role and criticality. Map dependencies — which app pins an old runtime, which server can't reboot during business hours, which system is regulated. Patch decisions flow from this map.

## Prioritize by risk, not by date

Don't treat all patches equally. Rank by:

- **Severity + exploitability**: use CVSS as a baseline but weight actively-exploited vulnerabilities far higher. Check CISA's Known Exploited Vulnerabilities (KEV) catalog — anything on it is emergency-grade regardless of CVSS.
- **Exposure**: internet-facing and remote-access systems (VPN, firewall, mail, web) first. An internal-only bug is lower urgency than a perimeter RCE.
- **Blast radius**: a domain controller or hypervisor patch affects everything; plan it carefully.

Set SLA targets by tier, e.g. critical/actively-exploited within 24–72h, high within ~1–2 weeks, others in the monthly cycle. Emergency out-of-band patches (a KEV perimeter RCE) break the normal cadence — patch now, test in a compressed ring.

## Ring-based deployment (test before you trust)

Never push a patch to the whole fleet at once.

1. **Ring 0 — pilot**: IT's own machines and a few tolerant test boxes. Apply, then use for 24–48h. Watch for boot failures, app breakage, performance regressions.
2. **Ring 1 — early adopters**: a representative slice (~10–15%) across departments and hardware types.
3. **Ring 2 — broad**: general fleet.
4. **Ring 3 — sensitive/critical last**: servers, execs, regulated systems — off-hours, with a maintenance window and stakeholders notified.

Advance a ring only if the previous one is clean. This catches the "this update bricks a driver" class of failure on 5 machines instead of 500.

## Before touching production servers

- **Snapshot/backup first.** Verify a good, recent backup or take a VM snapshot before patching any server. This is your rollback and it is non-negotiable.
- **Maintenance window + notice**: schedule server reboots off-hours, notify affected users, and have a rollback plan written down (which snapshot, how long to restore).
- **Reboot verification**: confirm the service actually comes back and works after the reboot — not just that the patch installed. A patched server that fails to boot at 2am is the classic disaster.

## Verify and report

Patching isn't done when it's deployed — it's done when it's **verified**. Scan post-deployment to confirm patches actually applied (agents lie; machines that were off got skipped). Track compliance: what percent of the fleet is current, what's outstanding and why. Chase the stragglers — the offline laptop and the "please not now" server are exactly where breaches happen.

Report to the client monthly: patch compliance %, critical vulnerabilities closed, exceptions and their compensating controls, and any patch-caused incidents. Maintain an exception register for systems that genuinely can't be patched (legacy app dependency) with the mitigations protecting them.

## Quality bar and failure modes

Great: actively-exploited vulnerabilities closed across the fleet within the SLA, every server patched off a verified backup through tested rings, near-100% verified compliance, and a clean monthly report. Zero patch-induced outages because bad patches were caught in Ring 0. Acceptable: regular cadence met, criticals prioritized, servers backed up first. Failing: pushing untested patches fleet-wide, patching a server with no backup, declaring victory off install logs without verification scans, ignoring KEV/perimeter urgency, or letting stragglers accumulate into an unpatched shadow fleet.
