import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { PLAN_LIMITS } from "../src/identity";
import {
  extractCallNote,
  extractCallAnalysis,
  formatTranscript,
  meetingsStatus,
  platformOfUrl,
  setJoinSpawn,
  setTranscribeFn,
  utterancesFromTranscribe,
} from "../src/meetings";
import { overlayPlaybooks, playbookApplies, playbookKnowledgeName, playbookNameFromTitle } from "../src/playbooks";

test("joiner is Fargate URL-join for Meet, Zoom and Teams, not a closed language pair", () => {
  const s = meetingsStatus();
  assert.equal(s.joiner.id, "fargate");
  assert.equal(s.joiner.languages, "auto");
  assert.equal(s.joiner.can_join, false, "unset ECS is not a fake ready");
  assert.deepEqual(
    s.providers.map((p) => p.id).sort(),
    ["google_meet", "teams", "zoom"],
  );
  assert.equal(platformOfUrl("https://meet.google.com/abc-defg-hij"), "google_meet");
  assert.equal(platformOfUrl("https://us06web.zoom.us/j/123"), "zoom");
  assert.equal(platformOfUrl("https://teams.microsoft.com/l/meetup-join/x"), "teams");
  assert.equal(platformOfUrl("https://teams.live.com/meet/x"), "teams");
  assert.equal(platformOfUrl("https://evil.example/meet.google.com"), undefined);
  assert.equal(platformOfUrl("https://127.0.0.1/aaa-bbbb-ccc"), undefined);
  assert.equal(platformOfUrl("https://169.254.169.254/latest"), undefined);
  assert.equal(platformOfUrl("https://user:pass@meet.google.com/aaa-bbbb-ccc"), undefined);
  assert.equal(platformOfUrl("https://meet.google.com.evil.com/aaa-bbbb-ccc"), undefined);
  assert.equal(platformOfUrl("https://teams.microsoft.com.evil.com/l/meetup-join/x"), undefined);
  assert.equal(platformOfUrl("http://meet.google.com/aaa-bbbb-ccc"), undefined);
  assert.equal(platformOfUrl("https://meet.google.com./aaa-bbbb-ccc"), "google_meet");
  assert.equal(platformOfUrl("https://2130706433/aaa-bbbb-ccc"), undefined);
  assert.equal(platformOfUrl("https://0x7f000001/aaa-bbbb-ccc"), undefined);
});

test("guest joiner uses role names and Teams tids, not only CSS class churn", () => {
  // Reads the meeting-bot sibling, which the published open-source kernel does not ship — skip there
  // rather than fail the standalone-build verify. Same convention as endpoints-smoke/scopedkeys.
  const joinPath = join(dirname(fileURLToPath(import.meta.url)), "../../../meeting-bot/join.mjs");
  if (!existsSync(joinPath)) return; // published kernel tree
  const src = readFileSync(joinPath, "utf8");
  assert.match(src, /getByRole/, "CSS selectors alone rot on Meet/Zoom/Teams");
  assert.match(src, /prejoin-join-button/);
  assert.match(src, /joinOnWeb/);
  assert.match(src, /Ask to join/);
  assert.match(src, /Jump in/);
  assert.match(src, /Continue in this browser/);
  assert.match(src, /failed: true/);
  assert.match(src, /MEETING_URL is not a Meet/);
});

test("Transcribe IdentifyLanguage JSON becomes utterances without assuming English", () => {
  const u = utterancesFromTranscribe({
    results: { transcripts: [{ transcript: "هل يمكننا البدء؟ Can we start?" }] },
  });
  assert.equal(u.length, 1);
  assert.match(u[0]!.text, /Can we start/);
  const note = extractCallNote([
    { speaker: "Ada", text: "Can you send the proposal?" },
    { speaker: "Us", text: "I'll send it tomorrow — that's the next step." },
  ]);
  assert.ok(note.asked.some((q) => /proposal/.test(q)));
  assert.ok(note.next.some((n) => /send it tomorrow/.test(n)));
  const analysis = extractCallAnalysis([
    { speaker: "Ada", text: "That's too expensive — we already work with someone." },
    { speaker: "Ada", text: "Can you cover onboarding?" },
    { speaker: "Us", text: "Yes we handle onboarding. Happy to send a one-pager." },
  ]);
  assert.ok(analysis.objections.some((o) => /expensive|already work/.test(o)));
  assert.ok(analysis.nailed.some((n) => /handle onboarding|Happy to send/.test(n)));
  assert.match(analysis.prep, /asked|covered|Objection/i);
});

test("join accepts Meet, Zoom and Teams URLs when wired; refuses a non-meeting URL", async () => {
  let spawned = 0;
  let captured = "";
  const urls: string[] = [];
  setJoinSpawn(async (args) => {
    spawned += 1;
    captured = args.token;
    urls.push(args.meetingUrl);
    return { ok: true, task_arn: "arn:mock" };
  });
  setTranscribeFn(async () => [
    { speaker: "Ada", text: "What does onboarding look like?" },
    { speaker: "Us", text: "Next step is a one-pager. I'll send it Friday." },
  ]);
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const kase = await domain.createCase({
    project_id: project,
    wedge: "gtm-operator",
    title: "Ada",
    stage: "booked",
    status: "open",
    data: { name: "Ada" },
  });

  const bad = await api(app, "meetings/join", {
    method: "POST",
    body: JSON.stringify({ case_id: kase.id, meeting_url: "https://example.com/not-a-meeting", consent: true }),
  });
  assert.equal(bad.status, 400);

  for (const meeting_url of [
    "https://meet.google.com/aaa-bbbb-ccc",
    "https://us06web.zoom.us/j/123456789",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
  ]) {
    const sent = await api(app, "meetings/join", {
      method: "POST",
      body: JSON.stringify({ case_id: kase.id, meeting_url, consent: true }),
    });
    assert.equal(sent.status, 200, `${meeting_url}: ${sent.text}`);
  }
  assert.equal(spawned, 3);
  assert.ok(urls.some((u) => /zoom\.us/.test(u)));
  assert.ok(urls.some((u) => /teams\.microsoft/.test(u)));
  const joinId = (
    await api(app, "meetings/join", {
      method: "POST",
      body: JSON.stringify({ case_id: kase.id, meeting_url: "https://meet.google.com/aaa-bbbb-ccc", consent: true }),
    })
  ).json.join_id as string;

  const forged = await app.request("/v1/meetings/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ join_id: joinId, token: "nope", case_id: kase.id }),
  });
  assert.equal(forged.status, 401);

  const done = await app.request("/v1/meetings/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ join_id: joinId, token: captured, case_id: kase.id }),
  });
  const doneText = await done.text();
  assert.equal(done.status, 200, doneText);
  const json = JSON.parse(doneText) as { ok: boolean; case_id?: string };
  assert.equal(json.ok, true);
  assert.equal(json.case_id, kase.id);

  const after = await domain.getCase(kase.id);
  assert.match(String(after?.data.call_notes ?? ""), /onboarding/);
  assert.equal(after?.data.meeting_consent, true);
  const files = await domain.listKnowledge("gtm-operator", project);
  assert.ok(files.some((f) => f.content.includes("What they asked")));
  assert.ok(files.some((f) => f.content.includes("What does onboarding look like?")));
  setJoinSpawn(undefined);
  setTranscribeFn(undefined);
});

test("complete join with a non-UUID case_id is 400, not 500", async () => {
  const { app } = await makeFreshApp();
  const r = await app.request("/v1/meetings/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ join_id: randomUUID(), token: "x", case_id: "prod-probe" }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error?: string };
  assert.match(String(body.error ?? ""), /unknown join/);
});

test("join refuses without consent to a transcript", async () => {
  setJoinSpawn(async () => ({ ok: true, task_arn: "arn:mock" }));
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const kase = await domain.createCase({
    project_id: project,
    wedge: "gtm-operator",
    title: "Ada",
    stage: "booked",
    status: "open",
    data: { name: "Ada" },
  });
  const r = await api(app, "meetings/join", {
    method: "POST",
    body: JSON.stringify({ case_id: kase.id, meeting_url: "https://meet.google.com/aaa-bbbb-ccc" }),
  });
  assert.equal(r.status, 400);
  assert.match(String(r.json.error ?? r.text), /transcript/i);
  setJoinSpawn(undefined);
});

test("join refuses when the plan's join ceiling is hit", async () => {
  setJoinSpawn(async () => ({ ok: true, task_arn: "arn:mock" }));
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const kase = await domain.createCase({
    project_id: project,
    wedge: "gtm-operator",
    title: "Ada",
    stage: "booked",
    status: "open",
    data: { name: "Ada" },
  });

  const original = PLAN_LIMITS.self_hosted.meeting_joins_per_month;
  PLAN_LIMITS.self_hosted.meeting_joins_per_month = 0;
  try {
    const r = await api(app, "meetings/join", {
      method: "POST",
      body: JSON.stringify({ case_id: kase.id, meeting_url: "https://meet.google.com/aaa-bbbb-ccc", consent: true }),
    });
    assert.equal(r.status, 402);
    assert.equal(r.json.code, "meeting_limit");
  } finally {
    PLAN_LIMITS.self_hosted.meeting_joins_per_month = original;
    setJoinSpawn(undefined);
  }
});

test("complete with failed:true stores the reason and does not invent a transcript", async () => {
  let captured = "";
  setJoinSpawn(async (args) => {
    captured = args.token;
    return { ok: true, task_arn: "arn:mock" };
  });
  const { app } = await makeFreshApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const kase = await domain.createCase({
    project_id: project,
    wedge: "gtm-operator",
    title: "Ada",
    stage: "booked",
    status: "open",
    data: { name: "Ada" },
  });
  const sent = await api(app, "meetings/join", {
    method: "POST",
    body: JSON.stringify({ case_id: kase.id, meeting_url: "https://meet.google.com/aaa-bbbb-ccc", consent: true }),
  });
  assert.equal(sent.status, 200, sent.text);
  const done = await app.request("/v1/meetings/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      join_id: sent.json.join_id,
      token: captured,
      case_id: kase.id,
      failed: true,
      reason: "still in the lobby — the host did not let Mycel notes in",
    }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  const after = await domain.getCase(kase.id);
  assert.match(String(after?.data.meeting_join_error ?? ""), /lobby/);
  assert.equal(after?.data.transcript_id, undefined);
  setJoinSpawn(undefined);
});

test("GET /v1/meetings is the catalogue, not seven Connect buttons", async () => {
  const { app } = await makeFreshApp();
  const r = await api(app, "meetings");
  assert.equal(r.status, 200);
  assert.equal(r.json.joiner.id, "fargate");
  assert.ok(Array.isArray(r.json.providers));
  assert.equal(r.json.later, undefined);
  assert.equal(r.json.recorder, undefined);
});

test("overlayPlaybooks: a task_types list keeps the playbook off other jobs", () => {
  const disk = [{ name: "draft_reply.md", content: "shipped reply" }];
  const live = [
    {
      name: playbookKnowledgeName("draft_reply.md"),
      content: "how we actually answer",
      updated_at: "2026-08-01T00:00:00.000Z",
      metadata: { enabled: true, task_types: ["draft_reply"] },
    },
  ];
  const onReply = overlayPlaybooks(disk, live, "draft_reply");
  assert.equal(onReply[0]!.content, "how we actually answer");
  const onOpen = overlayPlaybooks(disk, live, "find_prospects");
  assert.equal(onOpen[0]!.content, "shipped reply");
  assert.equal(playbookApplies({ task_types: ["draft_reply"] }, "find_prospects"), false);
  assert.equal(playbookNameFromTitle("How we open"), "how-we-open.md");
});
