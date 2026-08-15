---
name: chase-a-contractor
description: Work out who is actually holding up a missing timesheet, and write the nudge to that person in the desk's own voice.
---

# Chase the person who is actually holding it up

Ground yourself in `./knowledge/timesheet-week.md` (how the week runs) and in whatever the desk has
answered under `intake/` — especially `intake/timesheet-week.md`, which names the real deadline and
the real approver, and `intake/chase-voice.md`, which is a chase they actually sent.

The goal is a timesheet, not compliance. These people are contractors, not employees: they can walk
to another agency on Monday and the good ones are asked to weekly.

## Steps

1. **Call `week_status` first.** Never work out who is late or by how many days yourself. It returns
   `state` for each missing assignment, and that field decides everything below.
2. **Read `state` before you write a word.**
   - `not_submitted` — the contractor has not sent it. Chase the contractor.
   - `submitted_not_approved` — they sent it and the client's manager has not signed it off. **Do
     not chase the contractor.** Chase the client approver, and if the desk's intake answers name
     that person, use their name. Nothing annoys a contractor faster than being nagged for
     something they did on Sunday night.
3. **Pick the tone from how late it is and how often you have already asked** — `chases_sent` comes
   back from `week_status` too:
   - `nudge` — first ask, or under two days late. One line, no apparatus.
   - `firm` — second ask, or past the point where the invoice slips a week. Say what it costs them:
     a timesheet that misses the run is paid in the next run, not this one.
   - `escalate` — the desk's own cap has been reached (two automatic chases), or it is a client
     approver who has now been asked twice. Set `recipient` to `desk_head` and stop. A third
     automated message is not persistence, it is noise, and the desk head can pick up the phone.
4. **Write it short.** Name the week ending date, the client, and the one thing you want. No
   pleasantry stack, no "I hope this finds you well". If the desk pasted a real chase at intake,
   match that voice — it is theirs and it works.
5. **Never state a consequence the desk has not told you about.** Withheld pay, contract terms and
   penalty clauses are all real things on real desks and none of them are yours to invent. If you
   need to know and do not, say so as a knowledge gap rather than guessing.
6. **Put the result** in the task's output schema: `recipient`, `tone`, `subject`, `message`, and
   `reasoning` — which is where you say why this person and this tone, so the desk head can disagree
   with the judgement rather than only with the prose.

## Sending it (gated, except the first two)

You never hold a mailbox credential. Send through the action proxy, taking the connection id from
the **Available connections** list in AGENTS.md — never guess a name, and never assume Gmail:

```bash
curl -s "$MYCEL_ACTIONS_URL/send_email" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<the mailbox id from Available connections>","to":"<them>","subject":"Timesheet — week ending 2026-08-08","body":"..."}'
```

Name the action `email:chase_timesheet` when the proxy asks what you are doing. That is the one
envelope on this desk that auto-approves, and it is capped at two per assignment and sixty a day.
Anything you name differently goes to a human, which is the correct outcome for anything that is not
a plain timesheet nudge. An invoice is never sent from here.
