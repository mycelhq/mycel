// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SPINE — the jobs every service business has, written once
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A wedge was doing two different jobs and only one of them varies by trade.
//
// THE TRADE is real: reconcile a month, screen a longlist, answer a security questionnaire. Those
// are genuinely different and a manifest is the right place for them.
//
// THE SPINE is not. Chase a client for the thing they owe. Handle their verdict on something we
// delivered. Check in when an engagement goes quiet. Every service business does all three,
// identically, and they were COPY-PASTED into six wedges each — eighteen declarations of three
// jobs, making up 37-50% of every trade manifest. Half of "recruiting-desk" was not recruiting.
//
// And they had already drifted. Six copies, two or three variants each: books-keeper carried its
// own version of all three, geo-monitor its own nudge. Nobody could say which was canonical, which
// is what copy-paste always costs and why it is worth removing before there are twenty trades
// instead of ten.
//
// ═══ WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ═══
//
// Merged in `loadWedge`, per task type, with the WEDGE'S OWN KEYS WINNING. So a trade inherits the
// spine by declaring nothing, and can still narrow one field where it genuinely differs —
// books-keeper's `capabilities: ["send_email"]` on a nudge is a real fact about that trade and
// survives untouched.
//
// It does NOT make the spine mandatory. A wedge that declares none of these still gets them, which
// is the point: the next trade somebody writes inherits chasing, verdicts and check-ins for free
// instead of copying three blocks and drifting from them.

import type { WedgeTaskType } from "./wedge";

/** The three jobs, from the five-wedge majority variant. */
export const SPINE_TASK_TYPES: Record<string, WedgeTaskType> = {
    "nudge_client_request": {
      "client_facing": false,
      "_comment_client_facing": "A reminder about something WE asked THEM for. The delivery is whatever the answer unblocks.",
      "_comment_input": "PER-REQUEST, and REQUIRED. The description already forbids inventing a new ask or asking for anything the input does not name — this is that sentence made enforceable at the door instead of hoped for at run time. A nudge with no request behind it is a message a client resents and cannot act on.",
      "input_schema": {
        "type": "object",
        "required": ["request_id"],
        "properties": {
          "request_id": { "type": "string", "description": "The ONE open client request being nudged. REQUIRED." },
          "nudges_sent": { "type": "integer", "description": "How many reminders have already gone about this. Drives the escalation in tone; absent means this is the first." },
          "max_nudges": { "type": "integer", "description": "The ceiling after which the step is `hold` rather than another reminder." }
        }
      },
      "description": "Remind this client about ONE thing we already asked them for and have not received. Escalate in tone with the number of reminders already sent (input: nudges_sent of max_nudges); never invent a new ask, and never ask for anything the input does not name.",
      "harness": {
        "shape": "decide",
        "max_runtime_s": 420,
        "max_cost_usd": 0.3,
        "strict_output": true,
        "needs_connections": true,
        "temperature": 0.1,
        "steps": 20
      },
      "_sends_comment": "THE KERNEL SENDS THIS. Measured: 51 asks raised, 0 answered — and all four nudge runs that ever SUCCEEDED produced a message, called send_email zero times, and reported success. The job was a message generator with no outbox. `sends: true` makes the kernel deliver `message` through the same action proxy, grant and approval gate the sandbox would have used. See deliver-message.ts.",
      "sends": true,
      "output_schema": {
        "type": "object",
        "properties": {
          "step": {
            "type": "string",
            "enum": [
              "reminder",
              "firm_reminder",
              "final_reminder",
              "hold"
            ]
          },
          "channel": {
            "type": "string",
            "enum": [
              "email",
              "none"
            ]
          },
          "subject": {
            "type": "string",
            "description": "The email subject line. Short, specific to the ONE thing outstanding, and written as a person would write it — not a restatement of the task. This is sent verbatim."
          },
          "message": {
            "type": "string",
            "description": "The body of the reminder, sent VERBATIM to the client. Write the email itself, not a description of it or a note to the founder about what you would send."
          },
          "reasoning": {
            "type": "string"
          }
        },
        "required": [
          "step",
          "channel",
          "subject",
          "message"
        ]
      },
      "ship_requires": [
        "message"
      ]
    },
    "check_in_case": {
      "client_facing": false,
      "_comment_client_facing": "Keeps an engagement warm. Nothing is handed over.",
      "description": "This engagement has gone quiet. Read where the work actually stands and write the client a short, honest update — where it is, what happens next, and anything you need from them. Never promise a date the engagement's own facts do not already support, and never introduce a new commitment: this is a status update, not a renegotiation.",
      "_comment": "Declared because `check_in_case` is a real next-move kind and a grey button on a ranked list is a reading list. The sibling kind `advance_case` is deliberately NOT declared here: advancing this engagement means doing the work in it, which already has its own task types, and a generic verb with a free-text schema would be an agent handed something nobody taught it. See checkin.ts.",
      "tier": "fast",
      "input_schema": {
        "type": "object",
        "required": [
          "case_id",
          "stage",
          "days_silent",
          "today"
        ],
        "properties": {
          "case_id": {
            "type": "string"
          },
          "client_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "stage": {
            "type": "string"
          },
          "due_at": {
            "type": "string"
          },
          "days_silent": {
            "type": "number",
            "description": "Whole days since anything happened on this engagement. The single biggest input to the right tone: five days is a quick update, thirty is an apology."
          },
          "last_activity_at": {
            "type": "string"
          },
          "recent_history": {
            "type": "array",
            "description": "The last few timeline entries, oldest first. The only account of what has happened — say nothing this does not support.",
            "items": {
              "type": "object",
              "properties": {
                "at": {
                  "type": "string"
                },
                "kind": {
                  "type": "string"
                },
                "from": {
                  "type": "string"
                },
                "to": {
                  "type": "string"
                },
                "note": {
                  "type": "string"
                }
              }
            }
          },
          "today": {
            "type": "string",
            "description": "ISO date. Passed in so the same check-in can be replayed."
          }
        }
      },
      "harness": {
        "shape": "decide",
        "max_runtime_s": 420,
        "max_cost_usd": 0.3,
        "strict_output": true,
        "needs_connections": true,
        "temperature": 0.2,
        "steps": 20
      },
      "output_schema": {
        "type": "object",
        "required": [
          "send",
          "status_summary",
          "reasoning"
        ],
        "properties": {
          "send": {
            "type": "boolean",
            "description": "False is a real and often correct answer: an engagement that is silent because it is deliberately parked, or one where the last entry is already an update we sent, does not need another message. A check-in that had nothing to say is worse than no check-in."
          },
          "subject": {
            "type": "string"
          },
          "message": {
            "type": "string",
            "description": "The client-facing words. Required whenever `send` is true."
          },
          "status_summary": {
            "type": "string",
            "description": "One or two sentences for the engagement's own timeline: where the work stands, in our words, whether or not anything is sent."
          },
          "blocked_on": {
            "type": "string",
            "enum": [
              "nobody",
              "client",
              "us"
            ],
            "description": "Who the next step belongs to, read from the facts. `client` is what makes the check-in an ask rather than a bulletin."
          },
          "reasoning": {
            "type": "string"
          }
        }
      },
      "ship_requires": [
        "status_summary",
        "reasoning"
      ]
    },
    "deliverable_verdict": {
      "client_facing": false,
      "_comment_client_facing": "Records what the client said about work already delivered.",
      "description": "Your client has come back on something we delivered. Read what they said and either write the next version or wrap the work up.",
      "_comment": "One task type for BOTH verdicts, because the wait that wakes it is armed at release time — before anyone knows which way the client will go. See DELIVERABLE_VERDICT_TASK_TYPE in deliverables.ts. Read the live answer from GET /v1/internal/deliverables/<id> rather than trusting the resume input; a client can accept and then immediately ask for one more thing.",
      "input_schema": {
        "type": "object",
        "required": [
          "deliverable_id"
        ],
        "properties": {
          "deliverable_id": {
            "type": "string"
          }
        }
      },
      "harness": {
        "shape": "decide",
        "max_runtime_s": 600,
        "max_cost_usd": 0.5,
        "strict_output": true,
        "temperature": 0.2,
        "steps": 30
      },
      "output_schema": {
        "type": "object",
        "required": [
          "verdict",
          "next_step",
          "note"
        ],
        "properties": {
          "client_summary": {
            "type": "string",
            "description": "The plain-language note the CLIENT reads on this new version, and the ONLY field the portal shows them. REQUIRED whenever this run produced a revision. Lead with what you changed IN RESPONSE TO WHAT THEY SAID, using their own words for the thing they objected to. Do not describe the whole deliverable again — they have already read it, and a full restatement makes them hunt for the one line they cared about. Never mention a run, a task, a schema or a case. If you could not make the change, say plainly what you need from them instead, and put the ask in `needs`."
          },
          "needs": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "What you still need from the CLIENT before this revision can be finished, in their own words, at most four. Each becomes a request in their portal with an upload box. Leave absent when the revision is complete."
          },
          "verdict": {
            "type": "string",
            "enum": [
              "accepted",
              "changes_requested"
            ],
            "description": "What the client actually did, read back from the deliverable. Not a guess."
          },
          "next_step": {
            "type": "string",
            "enum": [
              "submitted_new_version",
              "ready_to_invoice",
              "needs_a_human"
            ],
            "description": "`needs_a_human` is a real answer and the right one whenever the change they asked for is a scope change rather than a correction — that is a conversation about money, not a redraft."
          },
          "note": {
            "type": "string",
            "description": "One or two sentences for the engagement's timeline: what they asked for and what you did about it."
          }
        }
      },
      "ship_requires": [
        "next_step",
        "note"
      ]
    }
  } as unknown as Record<string, WedgeTaskType>;
