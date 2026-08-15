# Probe one query

You are measuring whether a named client appears in an answer for one query on one surface.

- Record every brand/domain cited, not just the client.
- Prefer short exact names over marketing copy.
- If the surface refuses or errors, return `cited: []` and put the error in `raw_excerpt` — do not invent citations.
- Do not compute share of voice. That is the pack after the batch joins.
