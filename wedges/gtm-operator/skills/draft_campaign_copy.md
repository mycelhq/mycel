---
name: draft_campaign_copy
description: Write the full per-prospect outreach copy BEFORE proposing a campaign. The sequencer never invents words — if copy is missing at send time, the step parks.
task_types: [propose_campaign]
---

# Draft campaign copy (propose time only)

You write the words a stranger will read under the founder's name. That happens **once**, when the
campaign is proposed — never when the five-minute tick fires.

## What you produce

For each prospect, a `copy` object keyed by **capability id** (the step's `action`), not by stage
nickname:

| Key | When |
|---|---|
| `send_invite` | Optional. Only if the note could not have been written about anyone else. Bare invites often beat templates. |
| `send_message` | Required for every DM step. First DM and follow-up may share one template only when personalisation still holds; prefer distinct lines when the sequence has both `connected → dm1` and `dm1 → dm2`. |
| `send_email` | Required if the sequence has an email nudge after LinkedIn silence. Distinct from the DM copy. |

Example shape passed into `propose_campaign` / `POST /v1/gtm/campaigns`:

```json
{
  "profile_id": "dana-okafor",
  "name": "Dana Okafor",
  "copy": {
    "send_invite": "Dana — loved your note on month-end close at Northwind.",
    "send_message": "Thanks for connecting. Quick question on how you're handling X…"
  }
}
```

The harness stores this on each Case and puts the full list in the campaign artifact. Approving
the campaign is consent to **those exact words**.

## Rules that are not negotiable

1. **No placeholders left unfilled.** `Hi {{first_name}}` is what gets sent. Write the real name.
2. **No send-time drafting.** `advance_sequences` will park with
   `no approved copy for this step — nothing will be improvised` rather than invent a line. That
   parking is correct. Fix it by proposing again with copy, not by loosening the rule.
3. **Reference something real** when you looked at the profile (`get_profile`). Generic flattery is
   a bot tell and a lower reply rate.
4. **Match the approved sequence.** If the campaign has no invite note step, do not invent one just
   to fill a field.

## After drafting

Call `propose_campaign` (or the Cloud composer / `POST /v1/gtm/campaigns`) with the full prospect
list including `copy`. Do not enrol people from the graph without copy and expect DMs to go out —
graph enrolment deliberately carries none so missing words surface as a park, not a silent send.
