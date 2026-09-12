---
name: user-onboarding-and-offboarding
description: How to provision a new hire day-one-ready and fully deprovision a departing user so no access, data, or license is left dangling.
---

# User Onboarding and Offboarding

Joiner-Mover-Leaver (JML) is where IT most visibly succeeds or fails. A new hire who can't log in on day one signals an amateur shop; a former employee whose accounts stay live for months is a serious security and compliance breach. Both are prevented by the same thing: a complete, checklist-driven, role-based process — not ad hoc "set them up" requests.

## Onboarding: ready before day one

Trigger from HR with: full name, start date, role/title, department, manager, location (remote/office), and hardware needs. Provision **role-based** — define an access profile per role so a new salesperson automatically gets the standard sales toolset, rather than guessing or copying another user's permissions (permission-cloning silently propagates access creep and is a bad habit).

Checklist to complete before the start date:

- **Identity**: create the account in the directory (Entra ID/AD/Google), set a secure temporary password with forced change, and **enforce MFA enrollment** on first login. Assign to the correct groups/OUs for that role.
- **Email + collaboration**: mailbox, distribution lists, shared mailboxes, Teams/Slack, calendar. Set correct display name and photo policy.
- **Licenses + apps**: assign only the licenses the role needs (track cost — don't over-license). Install and configure line-of-business apps.
- **Access**: file shares, SaaS apps, VPN, and systems per the role profile — least privilege. No admin rights unless the role genuinely requires them.
- **Hardware**: image/enroll the device in MDM, encrypt the disk (BitLocker/FileVault), install endpoint protection, apply the standard baseline, and label/asset-tag it. Ship in time to arrive before day one for remote staff.
- **Documentation + welcome**: a getting-started note with login steps, MFA setup, helpdesk contact, and security-awareness basics.

Verify by test-logging or confirming with the manager that access works on day one. Record everything issued (device serials, licenses, group memberships) — this record is what makes offboarding clean.

## Offboarding: fast, complete, and reversible-for-data

The security priority is **speed of access revocation**; the business priority is **not losing the person's data**. Do both, in order, driven by an HR trigger with the exact effective date/time.

At (or just before) the effective time:

1. **Disable, don't delete** the account first — disabling instantly cuts access while preserving data and mailbox. Deleting immediately can destroy needed data and licenses tied to it.
2. **Kill active sessions and tokens**: revoke OAuth/refresh tokens, sign out of all sessions, and reset the password. Disabling alone doesn't always drop a live session or app token — revoke them explicitly. This is the step amateurs miss.
3. **Remove MFA devices and VPN/remote access.** A live authenticator or VPN cert is a backdoor.
4. **Reassign/preserve data**: convert the mailbox to shared or delegate it to the manager, transfer file ownership and cloud drives, and hand off any shared-account credentials the person held. Set an email forward/auto-reply per policy.
5. **Reclaim licenses** after data is preserved — this is real recurring savings and keeps the license count honest.
6. **Recover hardware**: collect or remote-wipe the device, and confirm it's wiped before reissue.
7. **Third-party and shadow access**: revoke SaaS apps not tied to SSO, building/badge access if in scope, and any admin accounts. The offboarding is only complete when *every* system in the person's issued-access record is closed.

For a **mover** (role change), it's the same rigor applied differentially: grant the new role's access and, critically, **remove the old role's access** — the most common failure is additive-only moves that accumulate into over-privileged accounts over a career.

## Quality bar and failure modes

Great: new hires log in and work on day one with exactly the access their role needs and nothing more; departures are fully locked out within minutes of the effective time, with data preserved, licenses reclaimed, and a checklist showing every system closed. Access reviews find zero orphaned accounts. Acceptable: timely provisioning and deprovisioning, MFA enforced, data handed off. Failing: day-one access broken, admin rights handed out by default, an ex-employee's account/token/VPN still live, permission-cloning that spreads access creep, mover role-changes that only add access, or licenses and hardware never reclaimed.
