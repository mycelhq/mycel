# How this service measures

Share of voice is **computed**, never estimated.

1. Open a batch of `probe_mention` children — one per (query × surface).
2. When the batch joins, call the pack:

```bash
curl -s "$MYCEL_PACKS_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"pack":"share_of_voice@1","args":{"client":"<name>","results":[...]}}'
```

3. Upsert a series sample on Records with `observed_at` set to the probe instant so week-over-week charts are honest.

If the pack is unavailable, say so and stop. Do not invent a percentage in prose.
