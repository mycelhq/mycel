// Meeting join routes. Chromium-on-Fargate enters Meet, Zoom or Teams; Amazon Transcribe takes the words.
//
// `/v1/meetings/complete` is public: the bot holds no founder session. The per-join token IS the
// credential. Exact match, never a prefix — `/v1/meetings/join` stays behind the founder key.
import type { Context, Hono } from "hono";
import type { DomainStore } from "./domain";
import { getIdentityStore, meetingJoinRefusal } from "./identity";
import { clientKey, rateLimited } from "./rate-limit";
import {
  completeJoin,
  countJoinsSince,
  isMeetingUrl,
  meetingsStatus,
  monthStartIso,
  startJoin,
} from "./meetings";

export function mountMeetings(
  app: Hono,
  deps: {
    domain: DomainStore;
    writeProjectId(c: Context): string | undefined;
    accessible(c: Context): Set<string>;
  },
): void {
  const { domain, writeProjectId, accessible } = deps;

  /**
   * What this install can actually join — Meet, Zoom and Teams via a guest URL, no Connect buttons.
   */
  app.get("/v1/meetings", (c) => c.json(meetingsStatus()));

  /**
   * Spawn the join bot into a Meet, Zoom or Teams URL. Counted against the plan.
   */
  app.post("/v1/meetings/join", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (rateLimited(`join:${projectId}`, 8)) return c.json({ error: "rate limited" }, 429);
    const b = (await c.req.json().catch(() => ({}))) as {
      case_id?: string;
      client_id?: string;
      meeting_url?: string;
      url?: string;
      consent?: unknown;
    };
    const caseId = typeof b.case_id === "string" ? b.case_id.trim() : "";
    const meetingUrl = (typeof b.meeting_url === "string" ? b.meeting_url : b.url ?? "").trim();
    const consent = b.consent === true;
    if (!caseId) return c.json({ error: "name the person this meeting is with" }, 400);
    if (!meetingUrl) return c.json({ error: "paste the Meet, Zoom or Teams link from the booking" }, 400);
    if (!isMeetingUrl(meetingUrl)) {
      return c.json({ error: "That is not a Meet, Zoom or Teams link." }, 400);
    }
    if (!consent) {
      return c.json(
        {
          error:
            "Confirm that Mycel notes will join as a visible participant and keep a transcript — not video — before adding it to the call.",
        },
        400,
      );
    }

    const kase = await domain.getCase(caseId);
    if (!kase || kase.project_id !== projectId) return c.json({ error: "not found" }, 404);
    if (b.client_id && kase.client_id && b.client_id !== kase.client_id) {
      return c.json({ error: "that person is not this client" }, 404);
    }

    const scope = c.get("scope");
    const identity = getIdentityStore();
    const limits = identity.limitsFor(scope.org_id);
    const used = await countJoinsSince(domain, accessible(c), monthStartIso());
    const joinsLimit = limits.meeting_joins_per_month ?? null;

    const sent = await startJoin({
      domain,
      kase,
      projectId,
      meetingUrl,
      joinsUsed: used,
      joinsLimit,
      consent,
    });
    if (!sent.ok) {
      if (sent.status === 402) {
        return c.json({ error: meetingJoinRefusal(joinsLimit, used), code: "meeting_limit" }, 402);
      }
      return c.json({ error: sent.error }, sent.status);
    }
    return c.json({ ok: true, join_id: sent.join_id });
  });

  app.post("/v1/meetings/complete", async (c) => {
    if (rateLimited(clientKey(c, "meet-complete"), 30)) return c.json({ error: "rate limited" }, 429);
    const b = (await c.req.json().catch(() => ({}))) as {
      join_id?: string;
      token?: string;
      case_id?: string;
      audio_s3_key?: string;
      utterances?: unknown;
      failed?: unknown;
      reason?: unknown;
    };
    const joinId = typeof b.join_id === "string" ? b.join_id.trim() : "";
    const token = typeof b.token === "string" ? b.token.trim() : "";
    const caseId = typeof b.case_id === "string" ? b.case_id.trim() : "";
    if (!joinId || !token || !caseId) return c.json({ error: "join_id, token and case_id are required" }, 400);

    const result = await completeJoin({
      domain,
      joinId,
      token,
      caseId,
      failed: b.failed === true,
      reason: typeof b.reason === "string" ? b.reason : undefined,
      // audio_s3_key on the body is ignored — completeJoin reads the key stored at spawn.
      utterances: Array.isArray(b.utterances)
        ? b.utterances.flatMap((u) => {
            if (typeof u === "string" && u.trim()) return [{ speaker: "Meeting", text: u.trim() }];
            if (u && typeof u === "object") {
              const row = u as { speaker?: unknown; text?: unknown };
              const text = typeof row.text === "string" ? row.text.trim() : "";
              if (!text) return [];
              return [{ speaker: typeof row.speaker === "string" && row.speaker.trim() ? row.speaker.trim() : "Speaker", text }];
            }
            return [];
          })
        : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
}
