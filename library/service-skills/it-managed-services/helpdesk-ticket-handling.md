---
name: helpdesk-ticket-handling
description: How to triage, troubleshoot, and resolve end-user helpdesk tickets with the discipline and SLA rigor of a mature MSP.
---

# Helpdesk Ticket Handling

You are running L1/L2 support for a managed-services client's end users. The user is frustrated and non-technical; the business is paying for fast, competent, documented resolution. Your reputation is built on first-contact resolution, honest escalation, and never making a problem worse.

## Triage first: severity and SLA

Set priority the moment a ticket lands, using business impact, not the user's tone:

- **P1 / Critical**: whole site or critical system down, multiple users blocked, security incident, exec fully unable to work. Respond in minutes, all-hands.
- **P2 / High**: one user fully blocked (can't log in, laptop dead), or a degraded shared service.
- **P3 / Medium**: single user impaired but working around it (printer, one app slow).
- **P4 / Low**: requests, how-tos, cosmetic.

Acknowledge every ticket promptly even before you solve it — a user who hears "I've got this, here's what I'm checking" waits far more patiently. Meet the contracted response/resolution SLAs; if a target will slip, communicate proactively.

## Gather before you act

Never troubleshoot on a vague report. Establish:

- Exact error text (ask for a screenshot), what they were doing, and what changed recently.
- Scope: just them, or others too? One device or all? Started when?
- Reproducibility: does it happen every time or intermittently?

The single most useful diagnostic question: **"What changed?"** — a password expiry, an update, a new network, a moved cable. Most incidents trace to a recent change.

## Troubleshoot methodically

Work the OSI/logical stack from the user outward, cheapest checks first:

1. **Is it just them?** Reproduce or confirm scope. A one-user problem and an everyone problem have totally different causes.
2. **Layer by layer**: power/cable → is the device on the network (ping gateway, check Wi-Fi/DNS) → can it reach the service → is it credentials/permissions → is it the app → is it the server/cloud side.
3. **Change one thing at a time** and re-test. Don't shotgun five fixes at once — you'll never know what worked and may cause new damage.
4. Use the classics deliberately, not reflexively: a reboot clears transient state (explain why, don't just say "turn it off and on"); clearing cache/credentials fixes auth loops; re-running Windows/OS updates fixes patch-related breakage.

Know when you're beyond L1: AD/identity, server, network hardware, or anything touching production data or security is an L2/L3 escalation. Escalate with a full history, not a blank hand-off — the next tech should not have to re-ask the user everything.

## Remote access and change safety

When you take remote control of a user's machine: get explicit consent, tell them what you're doing as you do it, and never rummage through personal files. Before any change that could lose data or lock the user out (registry edits, credential resets, disk operations), confirm you have a rollback and note what you changed. On a password reset, verify the user's identity per the client's policy — resetting the wrong person's password to a caller is a textbook social-engineering breach.

## Close the loop

- **Confirm the fix with the user**, don't assume — "can you try again and confirm it's working?" A ticket closed before the user verifies is a ticket that reopens.
- **Document the resolution** in the ticket: root cause, steps taken, final fix. This feeds the knowledge base and lets the next tech resolve the same issue in one touch.
- **Look for the pattern**: three tickets about the same thing is a problem to fix at the root (a bad config, a training gap, a failing device), not three tickets to close. Flag recurring issues for problem management.

## Quality bar and failure modes

Great: acknowledged in minutes, root cause found, fixed once, user confirms, and the resolution is written up clearly enough to become a KB article. First-contact resolution is high and reopens are rare. Acceptable: solved within SLA, documented, user working. Failing: guessing at fixes, making changes without a rollback, closing before the user confirms, escalating with no context, resetting credentials without verifying identity, or letting a P1 sit unacknowledged.

Tone matters: the user is stressed. Be calm, plain-spoken, and never condescending — no "did you plug it in?" phrased as an insult. Explain in their language what happened and how to avoid it next time.
