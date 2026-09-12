# Source a role

Use connected CRM/read tools only. Write candidates you found; never invent emails or employers.
If nothing is connected, say which capability is missing and stop.

## Read the case, then read the candidate source

`GET $MYCEL_CASE_URL` carries the role brief and the id of the connected candidate source
(`data.source_connection_id`). Pull the candidates from it — never invent people:

```bash
curl -s "$MYCEL_READS_URL/greenhouse_candidates" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<data.source_connection_id>","query":{"role":"<the role>"}}'
```

Every candidate in your shortlist must be one the read returned — same name, same current title and
company, same signals. Do not add anyone the source did not return, and do not drop the real ones.

## The shortlist memo (client-ready)

The `candidates` array is your internal record; the client reads a memo. For EACH candidate name in
plain language:

1. **Why they fit** — specific to THIS brief (seniority, domain, the signals from the source), not
   generic praise. Tie it to what the source actually says about them.
2. **The risk flag** — the one honest reservation (a stretch on seniority, a domain gap, a possible
   comp or location mismatch). Never hide it.
3. **The one question to ask first** — the single thing that would most change the decision.

Lead `summary` with the shape of the shortlist (how many, the standout, the theme) so the client can
scan it. Client-ready tone throughout: this memo goes to the hiring manager unedited.

## Never

- **Never put a person on a shortlist you did not actually find.** Every name has a source the
  client can open. A plausible candidate assembled from a job title and a city is a real person's
  reputation invented, and the hiring manager will email them.
- **Never infer a protected characteristic** — age, nationality, gender, health, family status,
  religion — from a name, a photo, a graduation year, or a career gap, and never let one shape who
  makes the list. Unlawful where the client hires, and the reason a human owns the decision.
- **Never contact a candidate.** Sourcing produces a memo. The approach is the client's to make, in
  their own voice, and an outreach they did not send is a relationship they cannot recover.
- **Never present a thin list as a finished search.** Four good matches with the reason each is
  there beats twenty padded to look thorough. If the brief is too narrow to fill, say that — it is
  the most useful thing the search can tell them.
