---
name: backup-and-disaster-recovery
description: How to design, run, and prove a backup and disaster-recovery program that actually restores when the client's data is on the line.
---

# Backup and Disaster Recovery

You protect the client's data and their ability to keep operating after a failure — ransomware, hardware death, accidental deletion, a flooded office. The brutal truth of this discipline: **a backup you haven't restored is a hope, not a backup.** Most backup failures are discovered only during a real disaster, which is the worst possible time. Your job is to make sure that never happens.

## Design to the business, not to the disk

Start from two numbers, agreed with the client per system:

- **RPO (Recovery Point Objective)** — how much data can we afford to lose? This sets backup frequency. A transactional database might need continuous/hourly; a file share might tolerate daily.
- **RTO (Recovery Time Objective)** — how fast must it be back? This sets the recovery method and infrastructure. A four-hour RTO for a core system means you need fast local restore or standby, not a week-long cloud pull.

Classify systems by criticality and set RPO/RTO per tier. Don't gold-plate a print server or under-protect the ERP.

## Follow 3-2-1-1-0

The modern standard: **3** copies of data, on **2** different media, **1** offsite, **1** offline/immutable (air-gapped or WORM), and **0** errors on verification. The immutable copy is what defeats ransomware — attackers now hunt and encrypt online backups first, so a copy they cannot alter or delete is the difference between recovery and paying a ransom. Enable immutability/object-lock on cloud backup storage and keep credentials for it separate from the production domain.

## Cover the whole estate

Inventory what must be backed up: servers and databases (application-consistent, not just crash-consistent — quiesce the DB), file shares, endpoints with local data, SaaS data (Microsoft 365 / Google Workspace are **not** backed up for you by the vendor beyond short retention — this is a common and costly misconception), and configuration (network device configs, VM definitions, IaC). Set retention to match legal/compliance needs and the client's tolerance, with a sensible grandfather scheme (dailies for weeks, weeklies for months, monthlies for years).

## Monitor every job

- Check backup job status **daily**. A silently failing nightly job for three weeks is how "we have backups" becomes "we had backups." Alert on failures and act on them same-day.
- Watch capacity trends so you don't run out of target space mid-job.
- Confirm the offsite/immutable copy is actually replicating, not just the local one.

## Test restores — this is the whole point

Schedule and perform real restore tests on a cadence (at least quarterly for critical systems, and after any major change):

- **File-level restore**: pull a sample file, confirm it opens and is intact.
- **Full system / bare-metal / VM restore** into an isolated sandbox: boot it, verify the application and data, and **time it against the RTO.** If the restore takes twelve hours and the RTO is four, the plan has failed on paper before any disaster — fix it now.
- **DR drill**: at least annually, simulate loss of the primary site and walk the full runbook. Note every gap (missing credentials, undocumented dependency, a system nobody was backing up).

Document each test with what was restored, integrity result, and time taken. These records are also what auditors and cyber-insurers now demand.

## Write the runbook

Maintain a DR runbook that a competent engineer who isn't you could execute at 3am: recovery order (identity/DNS first, then dependencies, then apps), where backups live and how to access them, credentials location (in a break-glass store, not only on the domain that might be down), contacts, and the decision tree for declaring a disaster. Keep a copy offline — a runbook stored only on the encrypted server is useless during ransomware.

## Quality bar and failure modes

Great: 3-2-1-1-0 in place with immutable offsite copies, daily job monitoring with same-day failure response, quarterly restore tests that meet RTO, an annual DR drill, and a runbook anyone senior could run. When ransomware hits, the client restores from an untouched immutable copy and pays nothing. Acceptable: reliable backups covering all critical systems, monitored, with periodic restore checks. Failing: never testing restores, no offsite/immutable copy, unmonitored failing jobs, assuming SaaS is backed up, backups reachable (and encryptable) from the same domain as production, or an RTO that the actual restore time can't meet.
