# Run a GEO week

1. Read the case for the client's query list and surfaces.
2. Open a batch (do not keep working after this call):

```bash
curl -s "$MYCEL_BATCHES_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"join":"all","children":[{"task_type":"probe_mention","input":{"query":"…","surface":"…","client":"…"}}]}'
```

3. When you are resumed after join (or when producing the weekly report from aggregate outputs), call `share_of_voice@1` with every child's `{query, cited}` and the client name.
4. After join, put the pack's numbers into the final result unchanged. Your `summary` may explain; it may not contradict the pack.
