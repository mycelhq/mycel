// Paid ads on Pipeline — draft creative, then place only on an explicit founder click.
//
// Workflow copied from public AI-ads kits (brief → 2–3 angles → headline / primary / CTA →
// founder picks → place), not from a SaaS UI. Copy is drafted from the offer the way
// `draft_campaign_copy` writes sequence lines: once, from the brief, never at send time.
//
// The agent must not reach these functions. `write_ads` stays brokered and gated. Spend happens
// only from POST /v1/ads/:id/place with confirm:true and the daily budget on the body.

import { randomUUID } from "node:crypto";
import type { Connection } from "./contract";
import type { DomainStore } from "./domain";
import { composioConfig, composioUserId, connConfig, executeTool, type ExecuteResult } from "./composio";
import { gtmWedge, hasGtmWedge } from "./gtm/stages";
import { wedgeForRole } from "./roles";
import { chatComplete } from "./litellm";

export const PAID_ADS_COLLECTION = "paid_ad";
export const AD_TOOLKITS = ["metaads", "googleads", "linkedinads"] as const;
export type AdToolkit = (typeof AD_TOOLKITS)[number];

export const AD_OBJECTIVES = ["leads", "traffic", "awareness"] as const;
export type AdObjective = (typeof AD_OBJECTIVES)[number];

export const AD_CTAS = ["Learn more", "Book a call", "Get started"] as const;
export type AdCta = (typeof AD_CTAS)[number];

export const AD_STATUSES = ["draft", "live", "paused", "error"] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

export interface AdAngle {
  id: string;
  label: string;
  headline: string;
  primary: string;
  cta: AdCta;
}

export interface AdBrief {
  name?: string;
  sells: string;
  sells_to: string;
}

export interface PaidAd {
  id: string;
  project_id: string;
  connection_id?: string;
  toolkit?: AdToolkit;
  name: string;
  objective: AdObjective;
  geo: string;
  daily_budget_major: number;
  currency: string;
  brief: AdBrief;
  angles: AdAngle[];
  chosen_angle_id: string;
  headline: string;
  primary: string;
  cta: AdCta;
  status: AdStatus;
  error?: string;
  provider_campaign_id?: string;
  created_at: string;
  updated_at: string;
  placed_at?: string;
  paused_at?: string;
}

export interface AdsAccount {
  id: string;
  toolkit: AdToolkit;
  label: string;
  connected: boolean;
}

const TOOLKIT_LABEL: Record<AdToolkit, string> = {
  metaads: "Meta Ads",
  googleads: "Google Ads",
  linkedinads: "LinkedIn Ads",
};

const CREATE_SLUG: Record<AdToolkit, string> = {
  metaads: "METAADS_CREATE_CAMPAIGN",
  googleads: "GOOGLEADS_CREATE_CAMPAIGN",
  linkedinads: "LINKEDINADS_CREATE_CAMPAIGN",
};

const PAUSE_SLUG: Record<AdToolkit, string> = {
  metaads: "METAADS_UPDATE_CAMPAIGN",
  googleads: "GOOGLEADS_UPDATE_CAMPAIGN",
  linkedinads: "LINKEDINADS_UPDATE_CAMPAIGN",
};

export function adsWedge(): string {
  return hasGtmWedge() ? gtmWedge() : (wedgeForRole("outreach") ?? "desk");
}

const clip = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/**
 * Three angles from the offer — problem, outcome, direct. Same job as `draft_campaign_copy`:
 * words the founder will run under their name, written once from the brief, not invented at spend.
 */
export function draftCreative(brief: AdBrief): AdAngle[] {
  const offer = clip(brief.sells || "the work", 80);
  const who = clip(brief.sells_to || "the people you sell to", 60);
  const name = clip(brief.name || "this practice", 40);
  return [
    {
      id: "problem",
      label: "Problem",
      headline: clip(`${who} still doing this by hand?`, 40),
      primary: clip(
        `If ${who} are still chasing ${offer} themselves, ${name} takes that off the desk.`,
        125,
      ),
      cta: "Learn more",
    },
    {
      id: "outcome",
      label: "Outcome",
      headline: clip(`${offer} — without the chase`, 40),
      primary: clip(
        `${name} runs ${offer} for ${who}. You stay in the conversation. The busywork does not.`,
        125,
      ),
      cta: "Book a call",
    },
    {
      id: "direct",
      label: "Direct",
      headline: clip(`${name} for ${who}`, 40),
      primary: clip(`We do ${offer} for ${who}. One place for the work, the wait, and the invoice.`, 125),
      cta: "Get started",
    },
  ];
}

/**
 * Real LLM-drafted creative — the state-of-the-art path. Org-keyed, budget-metered, tier-clamped.
 *
 * Returns `undefined` on any failure (no org, proxy down, malformed output, half-empty creative) so
 * the caller falls back to `draftCreative`, the deterministic mad-lib. `complete` is injectable so
 * tests drive the composer without a network, mirroring `ask.ts`.
 */
const CREATIVE_ANGLES = [
  { id: "problem", label: "Problem", cta: "Learn more" as AdCta },
  { id: "outcome", label: "Outcome", cta: "Book a call" as AdCta },
  { id: "direct", label: "Direct", cta: "Get started" as AdCta },
] as const;

const CREATIVE_SYSTEM = [
  "You are an expert direct-response paid-social copywriter.",
  "Write for the specific offer and audience given. No filler, no clichés, correct grammar, benefit-led.",
  "Return STRICT JSON only — no prose, no explanation, no code fences.",
  'The JSON is an array of EXACTLY 3 objects, each: {"id":"problem"|"outcome"|"direct","label":string,"headline":string,"primary":string,"cta":string}.',
  "Constraints:",
  "- headline: at most 40 characters.",
  "- primary: at most 125 characters.",
  "- Three distinct angles: one problem/pain angle (id \"problem\"), one outcome/benefit angle (id \"outcome\"), one direct/CTA angle (id \"direct\").",
  `- cta: EXACTLY one of these three strings, verbatim: ${AD_CTAS.map((c) => `"${c}"`).join(", ")}.`,
].join("\n");

export async function generateCreative(args: {
  brief: AdBrief;
  objective?: string;
  geo?: string;
  orgId?: string;
  complete?: typeof chatComplete;
}): Promise<AdAngle[] | undefined> {
  if (!args.orgId) return undefined;
  const complete = args.complete ?? chatComplete;

  const lines = [
    `What they sell: ${args.brief.sells}`,
    `Who they sell to: ${args.brief.sells_to}`,
  ];
  if (args.brief.name) lines.push(`Practice name: ${args.brief.name}`);
  if (args.objective) lines.push(`Campaign objective: ${args.objective}`);
  if (args.geo) lines.push(`Geography: ${args.geo}`);
  lines.push("", "Write 3 ad angles as strict JSON per the rules.");
  const user = lines.join("\n");

  const raw = await complete({
    orgId: args.orgId,
    tier: "standard",
    system: CREATIVE_SYSTEM,
    user,
    maxTokens: 700,
  });
  if (!raw) return undefined;

  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length < 3) return undefined;

  const byId = new Map<string, Record<string, unknown>>();
  for (const item of parsed) {
    const row = asRecord(item);
    const id = row && str(row.id);
    if (row && id) byId.set(id, row);
  }
  if (!CREATIVE_ANGLES.every((a) => byId.has(a.id))) return undefined;

  const angles: AdAngle[] = [];
  for (const spec of CREATIVE_ANGLES) {
    const row = byId.get(spec.id)!;
    const headline = clip(String(row.headline ?? ""), 40);
    const primary = clip(String(row.primary ?? ""), 125);
    if (!headline || !primary) return undefined;
    angles.push({
      id: spec.id,
      label: str(row.label) ?? spec.label,
      headline,
      primary,
      cta: AD_CTAS.includes(String(row.cta ?? "").trim() as AdCta)
        ? (String(row.cta).trim() as AdCta)
        : spec.cta,
    });
  }
  return angles;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function readPaidAd(data: unknown, projectId: string): PaidAd | undefined {
  const d = asRecord(data);
  if (!d) return undefined;
  const id = str(d.id);
  const sells = str(asRecord(d.brief)?.sells) ?? str(d.sells);
  const sellsTo = str(asRecord(d.brief)?.sells_to) ?? str(d.sells_to);
  if (!id || !sells || !sellsTo) return undefined;
  const objective = AD_OBJECTIVES.includes(d.objective as AdObjective) ? (d.objective as AdObjective) : "leads";
  const status = AD_STATUSES.includes(d.status as AdStatus) ? (d.status as AdStatus) : "draft";
  const cta = AD_CTAS.includes(d.cta as AdCta) ? (d.cta as AdCta) : "Learn more";
  const toolkit = AD_TOOLKITS.includes(d.toolkit as AdToolkit) ? (d.toolkit as AdToolkit) : undefined;
  const angles = Array.isArray(d.angles)
    ? d.angles.flatMap((a): AdAngle[] => {
        const row = asRecord(a);
        if (!row) return [];
        const aid = str(row.id);
        const headline = str(row.headline);
        const primary = str(row.primary);
        if (!aid || !headline || !primary) return [];
        return [
          {
            id: aid,
            label: str(row.label) ?? aid,
            headline,
            primary,
            cta: AD_CTAS.includes(row.cta as AdCta) ? (row.cta as AdCta) : "Learn more",
          },
        ];
      })
    : [];
  const brief: AdBrief = {
    name: str(asRecord(d.brief)?.name) ?? str(d.name),
    sells,
    sells_to: sellsTo,
  };
  if (!angles.length) {
    angles.push(...draftCreative(brief));
  }
  const chosen = str(d.chosen_angle_id) ?? angles[0]!.id;
  const picked = angles.find((a) => a.id === chosen) ?? angles[0]!;
  return {
    id,
    project_id: projectId,
    connection_id: str(d.connection_id),
    toolkit,
    name: str(d.name) ?? `${brief.name ?? "Ad"} — ${objective}`,
    objective,
    geo: str(d.geo) ?? "",
    daily_budget_major: Math.max(0, num(d.daily_budget_major) ?? 0),
    currency: str(d.currency) ?? "USD",
    brief,
    angles,
    chosen_angle_id: picked.id,
    headline: str(d.headline) ?? picked.headline,
    primary: str(d.primary) ?? picked.primary,
    cta: (AD_CTAS.includes(d.cta as AdCta) ? (d.cta as AdCta) : picked.cta) ?? cta,
    status,
    error: str(d.error),
    provider_campaign_id: str(d.provider_campaign_id),
    created_at: str(d.created_at) ?? new Date().toISOString(),
    updated_at: str(d.updated_at) ?? new Date().toISOString(),
    placed_at: str(d.placed_at),
    paused_at: str(d.paused_at),
  };
}

export function adsAccounts(conns: readonly Connection[], projectId: string): AdsAccount[] {
  const out: AdsAccount[] = [];
  for (const c of conns) {
    if (c.kind !== "composio" || (c.project_id && c.project_id !== projectId)) continue;
    const toolkit = connConfig(c).toolkit.toLowerCase() as AdToolkit;
    if (!AD_TOOLKITS.includes(toolkit)) continue;
    out.push({
      id: c.id,
      toolkit,
      label: c.name || TOOLKIT_LABEL[toolkit],
      connected: !!connConfig(c).connected_account_id,
    });
  }
  return out;
}

export async function listPaidAds(domain: DomainStore, projectId: string): Promise<PaidAd[]> {
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: adsWedge(),
    collection: PAID_ADS_COLLECTION,
    limit: 50,
  });
  return rows
    .map((r) => readPaidAd(r.data, projectId))
    .filter((a): a is PaidAd => !!a)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function savePaidAd(domain: DomainStore, ad: PaidAd): Promise<PaidAd> {
  const now = new Date().toISOString();
  const next = { ...ad, updated_at: now };
  await domain.upsertRecord({
    project_id: ad.project_id,
    wedge: adsWedge(),
    collection: PAID_ADS_COLLECTION,
    key: `paid_ad:${ad.id}`,
    data: { ...next, paid_ad_id: ad.id } as unknown as Record<string, unknown>,
  });
  return next;
}

export async function getPaidAd(domain: DomainStore, projectId: string, id: string): Promise<PaidAd | undefined> {
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: adsWedge(),
    collection: PAID_ADS_COLLECTION,
    where: { paid_ad_id: id },
    limit: 1,
  });
  const found = rows[0] ? readPaidAd(rows[0].data, projectId) : undefined;
  if (found) return found;
  return (await listPaidAds(domain, projectId)).find((a) => a.id === id);
}

export function parseBrief(raw: unknown): AdBrief | undefined {
  const d = asRecord(raw) ?? {};
  const sells = str(d.sells);
  const sells_to = str(d.sells_to);
  if (!sells || !sells_to) return undefined;
  return { name: str(d.name), sells, sells_to };
}

export async function createDraft(args: {
  domain: DomainStore;
  projectId: string;
  brief: AdBrief;
  objective?: string;
  geo?: string;
  daily_budget_major?: number;
  currency?: string;
  connection_id?: string;
  toolkit?: string;
  name?: string;
  orgId?: string;
}): Promise<PaidAd> {
  const angles =
    (await generateCreative({ brief: args.brief, objective: args.objective, geo: args.geo, orgId: args.orgId })) ??
    draftCreative(args.brief);
  const picked = angles[0]!;
  const objective = AD_OBJECTIVES.includes(args.objective as AdObjective)
    ? (args.objective as AdObjective)
    : "leads";
  const toolkit = AD_TOOLKITS.includes(args.toolkit as AdToolkit) ? (args.toolkit as AdToolkit) : undefined;
  const budget = Math.max(0, Number(args.daily_budget_major) || 0);
  const ad: PaidAd = {
    id: randomUUID(),
    project_id: args.projectId,
    connection_id: args.connection_id?.trim() || undefined,
    toolkit,
    name: args.name?.trim() || `${args.brief.name ?? "Ad"} — ${objective}`,
    objective,
    geo: args.geo?.trim() || "",
    daily_budget_major: budget,
    currency: args.currency?.trim() || "USD",
    brief: args.brief,
    angles,
    chosen_angle_id: picked.id,
    headline: picked.headline,
    primary: picked.primary,
    cta: picked.cta,
    status: "draft",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return savePaidAd(args.domain, ad);
}

export async function updateDraft(args: {
  domain: DomainStore;
  ad: PaidAd;
  patch: Partial<{
    connection_id: string;
    toolkit: string;
    name: string;
    objective: string;
    geo: string;
    daily_budget_major: number;
    currency: string;
    chosen_angle_id: string;
    headline: string;
    primary: string;
    cta: string;
  }>;
}): Promise<PaidAd> {
  const p = args.patch;
  let next: PaidAd = { ...args.ad };
  if (p.connection_id !== undefined) next.connection_id = p.connection_id.trim() || undefined;
  if (p.toolkit !== undefined) {
    next.toolkit = AD_TOOLKITS.includes(p.toolkit as AdToolkit) ? (p.toolkit as AdToolkit) : next.toolkit;
  }
  if (p.name !== undefined) next.name = p.name.trim() || next.name;
  if (p.objective !== undefined && AD_OBJECTIVES.includes(p.objective as AdObjective)) {
    next.objective = p.objective as AdObjective;
  }
  if (p.geo !== undefined) next.geo = p.geo.trim();
  if (p.daily_budget_major !== undefined) next.daily_budget_major = Math.max(0, Number(p.daily_budget_major) || 0);
  if (p.currency !== undefined) next.currency = p.currency.trim() || next.currency;
  if (p.chosen_angle_id) {
    const angle = next.angles.find((a) => a.id === p.chosen_angle_id);
    if (angle) {
      next.chosen_angle_id = angle.id;
      next.headline = angle.headline;
      next.primary = angle.primary;
      next.cta = angle.cta;
    }
  }
  if (p.headline !== undefined) next.headline = clip(p.headline, 40);
  if (p.primary !== undefined) next.primary = clip(p.primary, 125);
  if (p.cta !== undefined && AD_CTAS.includes(p.cta as AdCta)) next.cta = p.cta as AdCta;
  if (next.status === "error") {
    next = { ...next, status: "draft", error: undefined };
  }
  return savePaidAd(args.domain, next);
}

export type AdsExecute = (args: {
  slug: string;
  userId: string;
  connectedAccountId?: string;
  arguments?: Record<string, unknown>;
}) => Promise<ExecuteResult>;

let adsExecuteOverride: AdsExecute | undefined;

/** Tests replace Composio. Production never calls this. */
export function setAdsExecute(fn: AdsExecute | undefined): void {
  adsExecuteOverride = fn;
}

async function runAdsTool(args: {
  conn: Connection;
  slug: string;
  arguments: Record<string, unknown>;
}): Promise<ExecuteResult> {
  const cc = connConfig(args.conn);
  if (adsExecuteOverride) {
    return adsExecuteOverride({
      slug: args.slug,
      userId: composioUserId(args.conn),
      connectedAccountId: cc.connected_account_id,
      arguments: args.arguments,
    });
  }
  const cfg = composioConfig();
  if (!cfg) return { successful: false, error: "Composio is not configured on this install." };
  if (!cc.connected_account_id) {
    return { successful: false, error: `${cc.toolkit || "this ads account"} is connected in name only — finish authorising it under Apps.` };
  }
  return executeTool(cfg, {
    slug: args.slug,
    userId: composioUserId(args.conn),
    connectedAccountId: cc.connected_account_id,
    arguments: args.arguments,
  });
}

function providerId(data: unknown): string | undefined {
  const d = asRecord(data) ?? {};
  return (
    str(d.id) ??
    str(d.campaign_id) ??
    str(d.campaignId) ??
    str(asRecord(d.campaign)?.id) ??
    str(asRecord(d.response)?.id)
  );
}

export async function placeAd(args: {
  domain: DomainStore;
  ad: PaidAd;
  conn: Connection;
  confirm: boolean;
}): Promise<{ ok: true; ad: PaidAd } | { ok: false; error: string; status: 400 | 409 | 502; ad: PaidAd }> {
  if (!args.confirm) {
    return { ok: false, error: "Place this ad only after you have seen the daily budget.", status: 400, ad: args.ad };
  }
  if (args.ad.daily_budget_major <= 0) {
    return { ok: false, error: "Set a daily budget before placing this ad.", status: 400, ad: args.ad };
  }
  if (!args.ad.headline.trim() || !args.ad.primary.trim()) {
    return { ok: false, error: "The ad needs a headline and primary text before it can be placed.", status: 400, ad: args.ad };
  }
  if (args.ad.status === "live") {
    return { ok: false, error: "This ad is already live. Pause it first if you want to change it.", status: 409, ad: args.ad };
  }
  const toolkit = (connConfig(args.conn).toolkit.toLowerCase() || args.ad.toolkit) as AdToolkit;
  if (!AD_TOOLKITS.includes(toolkit)) {
    return { ok: false, error: "That connection is not a Meta, Google, or LinkedIn ads account.", status: 400, ad: args.ad };
  }
  if (!connConfig(args.conn).connected_account_id && !adsExecuteOverride) {
    const failed = await savePaidAd(args.domain, {
      ...args.ad,
      connection_id: args.conn.id,
      toolkit,
      status: "error",
      error: `${TOOLKIT_LABEL[toolkit]} is not authorised yet. Connect it under Apps. Nothing was charged.`,
    });
    return { ok: false, error: failed.error!, status: 400, ad: failed };
  }

  const created = await runAdsTool({
    conn: args.conn,
    slug: CREATE_SLUG[toolkit],
    arguments: {
      name: args.ad.name,
      objective: args.ad.objective,
      daily_budget: args.ad.daily_budget_major,
      daily_budget_major: args.ad.daily_budget_major,
      currency: args.ad.currency,
      geo: args.ad.geo,
      country: args.ad.geo,
      headline: args.ad.headline,
      primary_text: args.ad.primary,
      body: args.ad.primary,
      cta: args.ad.cta,
      status: "ACTIVE",
    },
  });
  if (!created.successful) {
    const reason =
      created.error?.trim() ||
      `${TOOLKIT_LABEL[toolkit]} could not create the campaign. The ads account may need a billing method the founder adds in Ads Manager — Mycel will not attach a card.`;
    const failed = await savePaidAd(args.domain, {
      ...args.ad,
      connection_id: args.conn.id,
      toolkit,
      status: "error",
      error: reason,
    });
    return { ok: false, error: reason, status: 502, ad: failed };
  }
  const now = new Date().toISOString();
  const live = await savePaidAd(args.domain, {
    ...args.ad,
    connection_id: args.conn.id,
    toolkit,
    status: "live",
    error: undefined,
    provider_campaign_id: providerId(created.data) ?? args.ad.provider_campaign_id,
    placed_at: now,
    paused_at: undefined,
  });
  return { ok: true, ad: live };
}

export async function pauseAd(args: {
  domain: DomainStore;
  ad: PaidAd;
  conn: Connection;
}): Promise<{ ok: true; ad: PaidAd } | { ok: false; error: string; status: 400 | 409 | 502; ad: PaidAd }> {
  if (args.ad.status !== "live") {
    return { ok: false, error: "Only a live ad can be paused from here.", status: 409, ad: args.ad };
  }
  const toolkit = (args.ad.toolkit ?? connConfig(args.conn).toolkit.toLowerCase()) as AdToolkit;
  if (!AD_TOOLKITS.includes(toolkit)) {
    return { ok: false, error: "That connection is not an ads account.", status: 400, ad: args.ad };
  }
  const paused = await runAdsTool({
    conn: args.conn,
    slug: PAUSE_SLUG[toolkit],
    arguments: {
      campaign_id: args.ad.provider_campaign_id,
      id: args.ad.provider_campaign_id,
      status: "PAUSED",
    },
  });
  if (!paused.successful) {
    const reason = paused.error?.trim() || `${TOOLKIT_LABEL[toolkit]} could not pause the campaign.`;
    const failed = await savePaidAd(args.domain, { ...args.ad, status: "error", error: reason });
    return { ok: false, error: reason, status: 502, ad: failed };
  }
  const now = new Date().toISOString();
  const next = await savePaidAd(args.domain, {
    ...args.ad,
    status: "paused",
    error: undefined,
    paused_at: now,
  });
  return { ok: true, ad: next };
}
