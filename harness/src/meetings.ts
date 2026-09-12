// Self-hosted join bot — Chromium on Fargate into Meet, Zoom or Teams; audio to Amazon Transcribe.
//
// Why this, and not Attendee / Recall:
//   Attendee (MIT) self-hosts and does not phone home to Recall, but default transcription is
//   Deepgram (another card) and Zoom needs a Zoom Marketplace Meeting SDK app. Too much stack,
//   and two invoices we cannot pay.
//   Recall cloud is a SaaS invoice. Forbidden.
//   Vexa wants a Whisper GPU. Extra cost, extra fleet.
//
// What ships: a guest Chromium joins a Meet, Zoom, or Teams URL, ffmpeg records audio only
// (no video), Amazon Transcribe IdentifyLanguage writes a transcript, the kernel files it on
// the prospect. Zoom Marketplace SDK and Azure Teams apps are not this path — the bot uses the
// provider's own browser join (zoom.us/j/ → web client, Teams "join as guest").
//
// IAM is this AWS account. No new SaaS keys.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Case } from "./contract";
import type { DomainStore } from "./domain";
import { gtmWedge, hasGtmWedge } from "./gtm/stages";
import { scopeMeta } from "./knowledge";
import { normalisedHost, parsePublicHttps } from "./public-url";

export const JOIN_NOTE = "bot added to the call";
/** Guest display name — the room must be able to see that this participant takes a transcript. */
export const BOT_DISPLAY_NAME = "Mycel notes (transcript)";

export type MeetingPlatform = "google_meet" | "zoom" | "teams";

export interface MeetingsStatus {
  joiner: {
    id: "fargate";
    name: string;
    /** ECS RunTask (or a test spawn) is wired — we can actually enter a call. */
    can_join: boolean;
    languages: "auto";
  };
  providers: Array<{ id: MeetingPlatform; name: string }>;
}

const PLATFORMS: Array<{ id: MeetingPlatform; name: string }> = [
  { id: "google_meet", name: "Google Meet" },
  { id: "zoom", name: "Zoom" },
  { id: "teams", name: "Microsoft Teams" },
];

function platformOfHost(host: string): MeetingPlatform | undefined {
  if (host === "meet.google.com") return "google_meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";
  if (
    host === "teams.microsoft.com" ||
    host === "teams.live.com" ||
    host.endsWith(".teams.microsoft.com") ||
    host.endsWith(".teams.live.com")
  ) {
    return "teams";
  }
  return undefined;
}

export function platformOfUrl(raw: string): MeetingPlatform | undefined {
  const u = parsePublicHttps(raw);
  if (!u) return undefined;
  return platformOfHost(normalisedHost(u.hostname));
}

export function isMeetingUrl(raw: string): boolean {
  return platformOfUrl(raw) !== undefined;
}

export function joinConfig(): {
  cluster?: string;
  task?: string;
  subnets: string[];
  securityGroup?: string;
  callbackUrl?: string;
  bucket?: string;
  region: string;
  botName: string;
} {
  const subnets = (process.env.MYCEL_MEETING_BOT_SUBNETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    cluster: process.env.MYCEL_MEETING_BOT_CLUSTER?.trim() || undefined,
    task: process.env.MYCEL_MEETING_BOT_TASK?.trim() || undefined,
    subnets,
    securityGroup: process.env.MYCEL_MEETING_BOT_SECURITY_GROUP?.trim() || undefined,
    callbackUrl: process.env.MYCEL_MEETING_CALLBACK_URL?.trim() || undefined,
    bucket: process.env.MYCEL_ARTIFACTS_BUCKET?.trim() || undefined,
    region: process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || "eu-west-2",
    botName: BOT_DISPLAY_NAME,
  };
}

export function joinerReady(): boolean {
  if (joinSpawnOverride) return true;
  const cfg = joinConfig();
  return !!(cfg.cluster && cfg.task && cfg.subnets.length && cfg.securityGroup && cfg.callbackUrl && cfg.bucket);
}

export function meetingsStatus(): MeetingsStatus {
  return {
    joiner: {
      id: "fargate",
      name: BOT_DISPLAY_NAME,
      can_join: joinerReady(),
      languages: "auto",
    },
    providers: PLATFORMS.map((p) => ({ id: p.id, name: p.name })),
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export interface TranscriptUtterance {
  speaker: string;
  text: string;
}

export function formatTranscript(utterances: readonly TranscriptUtterance[]): string {
  return utterances
    .map((u) => (u.speaker ? `**${u.speaker}:** ${u.text}` : u.text))
    .join("\n\n")
    .trim();
}

const clip = (t: string) => (t.length > 280 ? `${t.slice(0, 277)}…` : t);

const NEXT_RE = /\b(next step|follow[- ]?up|send (you|me|us)|i'?ll send|we'?ll send|action item|to[- ]do)\b/i;
const OBJECT_RE =
  /\b(too (much|expensive)|can'?t afford|budget|pricing|the cost|not sure|think about it|need to (think|check|ask|talk)|maybe later|not (right )?now|already (use|have|work with)|competitor|we'?ll pass|too soon)\b/i;
const NAILED_RE =
  /\b(we (can|do|offer|handle|cover)|that'?s (exactly|right|us)|yes we|absolutely|i can send|happy to)\b/i;

export interface CallAnalysis {
  asked: string[];
  next: string[];
  objections: string[];
  nailed: string[];
  missed: string[];
  /** One paragraph the founder reads before the next call — pulled from the lines, not invented. */
  prep: string;
}

/**
 * Deterministic "what they asked / next step / objections" — not a model paraphrase.
 *
 * Distillation elsewhere refuses to summarise a founder's words with a model; a transcript is
 * third-party speech, but inventing a summary we then file as knowledge is the same failure. Pull
 * questions, objections and next-step lines out of the bytes that were said.
 */
export function extractCallAnalysis(utterances: readonly TranscriptUtterance[]): CallAnalysis {
  const asked: string[] = [];
  const next: string[] = [];
  const objections: string[] = [];
  const nailed: string[] = [];
  const missed: string[] = [];
  for (let i = 0; i < utterances.length; i++) {
    const t = utterances[i]!.text.trim();
    if (!t) continue;
    if (t.includes("?") && asked.length < 8) {
      asked.push(clip(t));
      const follow = utterances
        .slice(i + 1, i + 3)
        .map((u) => u.text.trim())
        .find(Boolean);
      if (follow && NAILED_RE.test(follow) && nailed.length < 6) nailed.push(clip(follow));
      else if (!follow && missed.length < 6) missed.push(clip(t));
    } else if (OBJECT_RE.test(t) && objections.length < 6) objections.push(clip(t));
    else if (NEXT_RE.test(t) && next.length < 6) next.push(clip(t));
    else if (NAILED_RE.test(t) && nailed.length < 6) nailed.push(clip(t));
  }
  const bits: string[] = [];
  if (asked.length) bits.push(`Last time they asked: ${asked[0]}`);
  if (nailed.length) bits.push(`You covered: ${nailed[0]}`);
  if (missed.length) bits.push(`You didn't land: ${missed[0]}`);
  if (objections.length) bits.push(`Objection still open: ${objections[0]}`);
  if (next.length) bits.push(`They left with: ${next[0]}`);
  const prep = bits.length
    ? bits.join(" ")
    : "No questions or next steps were caught in the transcript — skim the notes before the next call.";
  return { asked, next, objections, nailed, missed, prep };
}

export function extractCallNote(utterances: readonly TranscriptUtterance[]): { asked: string[]; next: string[] } {
  const a = extractCallAnalysis(utterances);
  return { asked: a.asked, next: a.next };
}

function bullets(rows: string[], empty: string): string {
  return rows.length ? rows.map((q) => `- ${q}`).join("\n") : `- ${empty}`;
}

export function callNoteMarkdown(args: {
  name: string;
  platform?: MeetingPlatform;
  at: string;
  analysis: CallAnalysis;
  transcript: string;
}): string {
  const where = args.platform ? ` via ${args.platform.replace(/_/g, " ")}` : "";
  return [
    `# Call with ${args.name}`,
    "",
    `Recorded ${args.at.slice(0, 10)}${where}. Audio only — no video was stored.`,
    "",
    "## Prep for the next call",
    args.analysis.prep,
    "",
    "## What they asked",
    bullets(args.analysis.asked, "(none caught as a question)"),
    "",
    "## Objections",
    bullets(args.analysis.objections, "(none caught)"),
    "",
    "## What you covered",
    bullets(args.analysis.nailed, "(none caught)"),
    "",
    "## What you didn't land",
    bullets(args.analysis.missed, "(none caught)"),
    "",
    "## Next step",
    bullets(args.analysis.next, "(none stated)"),
    "",
    "## Transcript",
    "",
    args.transcript,
    "",
  ].join("\n");
}

export function utterancesFrom(raw: unknown): TranscriptUtterance[] {
  if (typeof raw === "string" && raw.trim()) {
    return [{ speaker: "Meeting", text: raw.trim() }];
  }
  if (!Array.isArray(raw)) return [];
  const out: TranscriptUtterance[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ speaker: "Meeting", text: item.trim() });
      continue;
    }
    const row = asRecord(item);
    if (!row) continue;
    const text =
      str(row.text) ??
      str(row.words) ??
      (Array.isArray(row.words)
        ? row.words
            .map((w) => (typeof w === "string" ? w : str(asRecord(w)?.text) ?? ""))
            .join(" ")
            .trim()
        : undefined);
    if (!text) continue;
    out.push({ speaker: str(row.speaker) ?? str(row.speaker_name) ?? "Speaker", text });
  }
  return out;
}

/** Amazon Transcribe job JSON → utterances. One blob if speaker labels were off. */
export function utterancesFromTranscribe(raw: unknown): TranscriptUtterance[] {
  const root = asRecord(raw) ?? {};
  const results = asRecord(root.results) ?? root;
  const transcripts = results.transcripts;
  if (Array.isArray(results.audio_segments) && results.audio_segments.length) {
    return utterancesFrom(
      results.audio_segments.map((seg) => {
        const s = asRecord(seg);
        return { speaker: str(s?.speaker_label) ?? "Speaker", text: str(s?.transcript) ?? "" };
      }),
    );
  }
  const blob =
    (Array.isArray(transcripts) ? str(asRecord(transcripts[0])?.transcript) : undefined) ??
    str(results.transcript);
  return blob ? [{ speaker: "Meeting", text: blob }] : [];
}

export interface JoinDelivery {
  case_id: string;
  project_id: string;
  join_id: string;
  meeting_url?: string;
  utterances: TranscriptUtterance[];
}

export type IngestOutcome =
  | { ok: true; case_id: string; knowledge_id: string; duplicate?: true }
  | { ok: true; ignored: string }
  | { ok: false; status: 404; error: string };

export async function ingestTranscript(args: {
  domain: DomainStore;
  delivery: JoinDelivery;
  utterances: TranscriptUtterance[];
  at?: string;
}): Promise<IngestOutcome> {
  const { domain, delivery } = args;
  const utterances = args.utterances.length ? args.utterances : delivery.utterances;
  if (!utterances.length) return { ok: true, ignored: "no_transcript" };

  const kase = await domain.getCase(delivery.case_id);
  if (!kase) return { ok: true, ignored: "unknown_case" };
  if (delivery.project_id && kase.project_id && delivery.project_id !== kase.project_id) {
    return { ok: false, status: 404, error: "delivery does not match this case's business" };
  }
  if (!kase.project_id) return { ok: true, ignored: "case_has_no_project" };

  const transcript = formatTranscript(utterances);
  const dedupeKey = delivery.join_id;
  const existingId = str(kase.data.transcript_id);
  if (existingId && existingId === dedupeKey) {
    return { ok: true, case_id: kase.id, knowledge_id: str(kase.data.transcript_knowledge_id) ?? "", duplicate: true };
  }

  const analysis = extractCallAnalysis(utterances);
  const name = str(kase.data.name) ?? kase.title;
  const platform = delivery.meeting_url ? platformOfUrl(delivery.meeting_url) : undefined;
  const at = args.at ?? new Date().toISOString();
  const noteLines = [
    analysis.asked.length ? `They asked:\n${analysis.asked.map((q) => `- ${q}`).join("\n")}` : undefined,
    analysis.objections.length ? `Objections:\n${analysis.objections.map((q) => `- ${q}`).join("\n")}` : undefined,
    analysis.next.length ? `Next:\n${analysis.next.map((n) => `- ${n}`).join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  const content = callNoteMarkdown({ name, platform, at, analysis, transcript });
  const profileId = str(kase.data.profile_id) ?? kase.id;
  const wedge = hasGtmWedge() ? gtmWedge() : kase.wedge;
  const knowledgeName = `call-${profileId}-${at.slice(0, 10)}.md`;

  const item = await domain.createKnowledge({
    project_id: kase.project_id,
    wedge,
    name: knowledgeName,
    content,
    kind: "example",
    source: "feedback",
    metadata: {
      ...scopeMeta(kase.client_id),
      prospect_case_id: kase.id,
      profile_id: profileId,
      meeting_join_id: delivery.join_id,
      transcript_id: dedupeKey,
      meeting_url: delivery.meeting_url,
      meeting: true,
    },
  });

  const brief = str(kase.data.call_brief);
  const nextBrief = [brief, "", "## After the last call", analysis.prep].filter(Boolean).join("\n").trim();

  await domain.updateCase(
    kase.id,
    {
      data: {
        ...kase.data,
        call_notes: noteLines || transcript.slice(0, 2000),
        call_brief: nextBrief,
        call_analysis: analysis,
        transcript_id: dedupeKey,
        transcript_knowledge_id: item.id,
        meeting_join_id: delivery.join_id,
        meeting_recorded_at: at,
      },
    },
    { at, kind: "note", note: "transcript from the call", actor: "system" },
  );

  return { ok: true, case_id: kase.id, knowledge_id: item.id };
}

export function hashJoinToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(hash: string, token: string): boolean {
  const a = Buffer.from(hash);
  const b = Buffer.from(hashJoinToken(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintJoinSecret(): { joinId: string; token: string; tokenHash: string } {
  const joinId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  return { joinId, token, tokenHash: hashJoinToken(token) };
}

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function countJoinsSince(
  domain: DomainStore,
  projectIds: Iterable<string>,
  sinceIso: string,
): Promise<number> {
  let n = 0;
  for (const pid of projectIds) {
    const cases = await domain.listCases({ project_id: pid });
    for (const k of cases) {
      n += k.history.filter((h) => h.note === JOIN_NOTE && h.at >= sinceIso).length;
    }
  }
  return n;
}

export interface JoinSpawnArgs {
  meetingUrl: string;
  caseId: string;
  projectId: string;
  joinId: string;
  token: string;
  audioKey: string;
  callbackUrl: string;
  bucket: string;
}

export type JoinSpawnResult = { ok: true; task_arn?: string } | { ok: false; error: string };
export type JoinSpawn = (args: JoinSpawnArgs) => Promise<JoinSpawnResult>;

let joinSpawnOverride: JoinSpawn | undefined;

/** Tests replace ECS. Production never calls this. */
export function setJoinSpawn(fn: JoinSpawn | undefined): void {
  joinSpawnOverride = fn;
}

async function ecsJoinSpawn(args: JoinSpawnArgs): Promise<JoinSpawnResult> {
  const cfg = joinConfig();
  if (!cfg.cluster || !cfg.task || !cfg.subnets.length || !cfg.securityGroup) {
    return { ok: false, error: "the join bot is not on this install yet (no ECS task)." };
  }
  try {
    const pkg = "@aws-sdk/client-ecs";
    const mod: {
      ECSClient: new (c: { region: string }) => {
        send(cmd: unknown): Promise<{ tasks?: Array<{ taskArn?: string }> }>;
      };
      RunTaskCommand: new (i: unknown) => unknown;
    } = await import(pkg);
    const ecs = new mod.ECSClient({ region: cfg.region });
    const res = await ecs.send(
      new mod.RunTaskCommand({
        cluster: cfg.cluster,
        taskDefinition: cfg.task,
        launchType: "FARGATE",
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: cfg.subnets,
            securityGroups: [cfg.securityGroup],
            assignPublicIp: "ENABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "meeting-bot",
              environment: [
                { name: "MEETING_URL", value: args.meetingUrl },
                { name: "JOIN_ID", value: args.joinId },
                { name: "JOIN_TOKEN", value: args.token },
                { name: "CASE_ID", value: args.caseId },
                { name: "PROJECT_ID", value: args.projectId },
                { name: "CALLBACK_URL", value: args.callbackUrl },
                { name: "AUDIO_S3_BUCKET", value: args.bucket },
                { name: "AUDIO_S3_KEY", value: args.audioKey },
                { name: "BOT_NAME", value: BOT_DISPLAY_NAME },
                { name: "MAX_MINUTES", value: String(Math.max(2, Number(process.env.MYCEL_MEETING_MAX_MINUTES ?? 90) || 90)) },
                { name: "AWS_REGION", value: cfg.region },
              ],
            },
          ],
        },
      }),
    );
    const arn = res.tasks?.[0]?.taskArn;
    if (!arn) return { ok: false, error: "AWS accepted the join but started no task." };
    return { ok: true, task_arn: arn };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "could not start the join bot";
    return { ok: false, error: msg };
  }
}

export async function spawnJoin(args: JoinSpawnArgs): Promise<JoinSpawnResult> {
  return (joinSpawnOverride ?? ecsJoinSpawn)(args);
}

export type TranscribeFn = (audioKey: string) => Promise<TranscriptUtterance[]>;

let transcribeOverride: TranscribeFn | undefined;

/** Tests replace Amazon Transcribe. Production never calls this. */
export function setTranscribeFn(fn: TranscribeFn | undefined): void {
  transcribeOverride = fn;
}

async function amazonTranscribe(audioKey: string): Promise<TranscriptUtterance[]> {
  const cfg = joinConfig();
  if (!cfg.bucket) return [];
  try {
  const pkg = "@aws-sdk/client-transcribe";
  const s3pkg = "@aws-sdk/client-s3";
  const tmod: {
    TranscribeClient: new (c: { region: string }) => { send(cmd: unknown): Promise<unknown> };
    StartTranscriptionJobCommand: new (i: unknown) => unknown;
    GetTranscriptionJobCommand: new (i: unknown) => unknown;
  } = await import(pkg);
  const s3mod: {
    S3Client: new (c: { region: string }) => { send(cmd: unknown): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }> };
    GetObjectCommand: new (i: unknown) => unknown;
  } = await import(s3pkg);
  const name = `mycel-${audioKey.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-180)}`;
  const mediaUri = `s3://${cfg.bucket}/${audioKey}`;
  const outKey = audioKey.replace(/\.[^.]+$/, "") + ".json";
  const transcribe = new tmod.TranscribeClient({ region: cfg.region });
  await transcribe.send(
    new tmod.StartTranscriptionJobCommand({
      TranscriptionJobName: name,
      Media: { MediaFileUri: mediaUri },
      MediaFormat: "wav",
      IdentifyLanguage: true,
      OutputBucketName: cfg.bucket,
      OutputKey: outKey,
    }),
  );
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const got = (await transcribe.send(
      new tmod.GetTranscriptionJobCommand({ TranscriptionJobName: name }),
    )) as { TranscriptionJob?: { TranscriptionJobStatus?: string } };
    const status = got.TranscriptionJob?.TranscriptionJobStatus;
    if (status === "COMPLETED") break;
    if (status === "FAILED") return [];
    await new Promise((r) => setTimeout(r, 4000));
  }
  const s3 = new s3mod.S3Client({ region: cfg.region });
  const obj = await s3.send(new s3mod.GetObjectCommand({ Bucket: cfg.bucket, Key: outKey }));
  const bytes = await obj.Body?.transformToByteArray();
  if (!bytes) return [];
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
  return utterancesFromTranscribe(json);
  } catch {
    return [];
  }
}

export async function transcribeAudio(audioKey: string): Promise<TranscriptUtterance[]> {
  return (transcribeOverride ?? amazonTranscribe)(audioKey);
}

export type JoinErrorStatus = 400 | 402 | 404 | 501 | 502;

export async function startJoin(args: {
  domain: DomainStore;
  kase: Case;
  projectId: string;
  meetingUrl: string;
  joinsUsed: number;
  joinsLimit: number | null;
  /** Founder acknowledged transcript-only recording before we enter the room. */
  consent: boolean;
}): Promise<{ ok: true; join_id: string } | { ok: false; error: string; status: JoinErrorStatus }> {
  if (!args.consent) {
    return {
      ok: false,
      error: "Confirm that Mycel notes will join as a visible participant and keep a transcript — not video — before adding it to the call.",
      status: 400,
    };
  }
  const platform = platformOfUrl(args.meetingUrl);
  if (!platform) {
    return { ok: false, error: "That is not a Meet, Zoom or Teams link.", status: 400 };
  }
  if (args.joinsLimit !== null && args.joinsUsed >= args.joinsLimit) {
    return {
      ok: false,
      error: `your plan includes ${args.joinsLimit} call joins a month, and ${args.joinsUsed} have run`,
      status: 402,
    };
  }
  const cfg = joinConfig();
  if (!joinSpawnOverride && (!cfg.callbackUrl || !cfg.bucket)) {
    return {
      ok: false,
      error: "the join bot is not on this install yet.",
      status: 501,
    };
  }
  if (!joinerReady()) {
    return {
      ok: false,
      error: "the join bot is not on this install yet.",
      status: 501,
    };
  }

  const secret = mintJoinSecret();
  const audioKey = `meetings/${secret.joinId}.wav`;
  const iso = new Date().toISOString();
  await args.domain.updateCase(
    args.kase.id,
    {
      data: {
        ...args.kase.data,
        meeting_url: args.meetingUrl.trim(),
        meeting_join_id: secret.joinId,
        meeting_join_token_hash: secret.tokenHash,
        meeting_audio_key: audioKey,
        meeting_joined_at: iso,
        meeting_consent_at: iso,
        meeting_consent: true,
        meeting_join_error: undefined,
        meeting_failed_at: undefined,
      },
    },
    { at: iso, kind: "note", note: JOIN_NOTE, actor: "system" },
  );

  const spawned = await spawnJoin({
    meetingUrl: args.meetingUrl.trim(),
    caseId: args.kase.id,
    projectId: args.projectId,
    joinId: secret.joinId,
    token: secret.token,
    audioKey,
    callbackUrl: cfg.callbackUrl ?? "http://127.0.0.1:4000",
    bucket: cfg.bucket ?? "test-artifacts",
  });
  if (!spawned.ok) {
    return { ok: false, error: spawned.error, status: 502 };
  }
  if (spawned.ok && spawned.task_arn) {
    const latest = await args.domain.getCase(args.kase.id);
    if (latest) {
      await args.domain.updateCase(latest.id, {
        data: { ...latest.data, meeting_task_arn: spawned.task_arn },
      });
    }
  }
  return { ok: true, join_id: secret.joinId };
}

async function loadJoinCase(args: {
  domain: DomainStore;
  joinId: string;
  token: string;
  caseId: string;
}): Promise<{ ok: true; kase: Case } | { ok: false; status: 401 | 400; error: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.caseId)) {
    return { ok: false, status: 400, error: "unknown join" };
  }
  const kase = await args.domain.getCase(args.caseId);
  if (!kase) return { ok: false, status: 400, error: "unknown join" };
  const storedId = str(kase.data.meeting_join_id);
  const storedHash = str(kase.data.meeting_join_token_hash);
  if (!storedId || storedId !== args.joinId || !storedHash || !tokensMatch(storedHash, args.token)) {
    return { ok: false, status: 401, error: "invalid join token" };
  }
  return { ok: true, kase };
}

export async function failJoin(args: {
  domain: DomainStore;
  joinId: string;
  token: string;
  caseId: string;
  reason: string;
}): Promise<{ ok: true; failed: true; reason: string } | { ok: false; status: 401 | 400; error: string }> {
  const loaded = await loadJoinCase(args);
  if (!loaded.ok) return loaded;
  const reason = args.reason.trim().slice(0, 280) || "never reached the room";
  const at = new Date().toISOString();
  await args.domain.updateCase(
    loaded.kase.id,
    {
      data: {
        ...loaded.kase.data,
        meeting_join_error: reason,
        meeting_failed_at: at,
      },
    },
    { at, kind: "note", note: `join failed: ${reason}`, actor: "system" },
  );
  return { ok: true, failed: true, reason };
}

export async function completeJoin(args: {
  domain: DomainStore;
  joinId: string;
  token: string;
  caseId: string;
  utterances?: TranscriptUtterance[];
  failed?: boolean;
  reason?: string;
}): Promise<IngestOutcome | { ok: true; failed: true; reason: string } | { ok: false; status: 401 | 400; error: string }> {
  if (args.failed) {
    return failJoin({
      domain: args.domain,
      joinId: args.joinId,
      token: args.token,
      caseId: args.caseId,
      reason: args.reason ?? "never reached the room",
    });
  }
  const loaded = await loadJoinCase(args);
  if (!loaded.ok) return loaded;
  const kase = loaded.kase;
  if (!kase.project_id) return { ok: true, ignored: "case_has_no_project" };

  let utterances = args.utterances ?? [];
  // The complete route is public. Never transcribe a caller-supplied S3 key — only the key this
  // join stored, and only the meetings/<joinId>.wav object the bot was told to write.
  const storedKey = str(kase.data.meeting_audio_key);
  const expectedKey = `meetings/${args.joinId}.wav`;
  const audioKey = storedKey === expectedKey ? storedKey : undefined;
  if (!utterances.length && audioKey) {
    utterances = await transcribeAudio(audioKey);
  }
  return ingestTranscript({
    domain: args.domain,
    delivery: {
      case_id: kase.id,
      project_id: kase.project_id,
      join_id: args.joinId,
      meeting_url: str(kase.data.meeting_url),
      utterances,
    },
    utterances,
  });
}
