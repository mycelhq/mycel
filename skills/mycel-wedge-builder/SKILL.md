---
name: mycel-wedge-builder
description: Interview a founder about the service they run and author a Mycel wedge (wedge.json + skills + seed knowledge) that the kernel can fulfill. Use when someone wants to turn "here's how I do X for clients" into a working wedge.
---

# Build a Mycel wedge from a conversation

A **wedge** is how the kernel does one real service. The founder brings the domain; you turn it
into config the harness can run. Do NOT write application code — a wedge is `wedge.json` + Markdown
skills + Markdown knowledge. The engine (agent, sandbox, approvals, streaming) already exists.

## What you're producing

```
wedges/<slug>/
  wedge.json           # task types + output schema, tools, approvals, connections, model
  skills/*.md          # procedures: HOW the job is done well (your judgment, encoded)
  knowledge/*.md       # grounding: WHAT is true (policy, pricing, examples) — seeds only
```

The split matters: **skills are procedure (versioned, deliberate); knowledge is fact (grows at
runtime via the knowledge API + feedback).** Seed knowledge lightly here; it fills in from use.

## Interview the founder (don't skip this)

Ask, in plain language, and keep it short:

1. **The job.** "What does a client ask you for, and what do you hand back?" → a task type + the
   deliverable. One wedge can have a few task types; start with one.
2. **The trigger.** Inbound message on a channel (email/WhatsApp)? A button in an app? Both? →
   whether you wire a channel + `task_type`, or just `POST /v1/tasks`.
3. **The procedure.** "Walk me through how you do it well. What do you check first? What are the
   steps? What separates a great result from a mediocre one?" → the skill file. Capture their
   actual judgment — the checks, the order, the tone, the red lines.
4. **The grounding.** "What do you need to know to do this — pricing, policies, examples of your
   best work?" → seed `knowledge/`. Real examples of great output are the highest-value seed.
5. **The real-world actions.** "Does doing this send an email / charge a card / book a slot?" →
   `connections` + `approvals`. Anything that touches the outside world is `required: true` to
   start. The human approves every send until trust is earned.
6. **What good looks like.** "How will you judge the result?" → the `output_schema` and the skill's
   quality bar.

## Author the files

**wedge.json** — keep it honest to what they said:
```json
{
  "wedge": "<slug>",
  "title": "<human title>",
  "model": "anthropic/claude-opus-4-8",
  "task_types": {
    "<verb_noun>": {
      "description": "<the goal, one sentence>",
      "output_schema": { "type": "object", "properties": { }, "required": [] }
    }
  },
  "connections": ["<connection-name-the-founder-configured>"],
  "approvals": [{ "action": "send", "risk": "high", "required": true }],
  "skills": ["<skill-file-basename>"],
  "knowledge": ["<seed-file>"]
}
```

**skills/<name>.md** — a procedure with YAML frontmatter (`name`, `description`) then numbered
steps that encode the founder's judgment. Be specific: "read `./knowledge/` first", "check X
before Y", "match the tone in the examples", "write the deliverable to `./output/`", "to send, use
the action proxy (never handle credentials) — a human approves it." Ground, don't guess.

**knowledge/*.md** — the seed facts and 1–3 real examples of excellent output. Tell the founder
the rest fills in live: they can add documents any time via the knowledge API, and every time they
edit a draft before approving it, that correction becomes a new grounding example automatically.

## After authoring

1. Show the founder the tree and walk them through it in their words.
2. Tell them to deploy it (drop the folder where the kernel reads `wedges/`) and either wire a
   channel or `POST /v1/tasks` to run it.
3. Point them at `docs/WEDGES.md` for worked examples and at the knowledge API for growing it.

## The bar

The wedge should read like *this founder's* operation, not a generic template. The kernel gives
you a stellar engine for free; your only job is to encode judgment and grounding so the agent does
the work the way the founder would — and to gate every real action behind a human.
