/**
 * First-party product analytics for super-admins.
 *
 * PostHog is a feed of events the product chose to emit. This is the ledger: how many people
 * signed up, who is paying, whether the service-business loop is closing across every tenant.
 * The console page joins the two; this module never talks to PostHog, so a missing key still
 * leaves an operator with the numbers that live here.
 *
 * Cross-tenant on purpose. Every other list in the kernel is scoped by project; this one is the
 * exception, and the route that calls it is the exception's gate (member session + allowlist,
 * or the control token). A product API key alone must not reach it.
 */
import type { Task, TaskStatus } from "./contract";
import { getBillingStore } from "./billing";
import { getDeliverableStore } from "./deliverables";
import { getDomainStore } from "./domain";
import { getIdentityStore, type Org, type PlanStatus,
  hasPaidPlan,
} from "./identity";
import { asSurveyLog, SURVEY_PROMPTS } from "./surveys";
import { isSuperAdminEmail } from "./superadmin";

const DAY_MS = 86_400_000;
const DIGEST_GAP_MS = 60 * 60 * 60 * 1000; // 60h — Mon/Wed/Fri without doubling a retry

export interface CountRow {
  key: string;
  n: number;
}

export interface DayCount {
  day: string;
  n: number;
}

export interface ProductTenant {
  org_id: string;
  name: string;
  created_at: string;
  plan: string;
  plan_status: PlanStatus;
  members: number;
  projects: number;
  owner_email?: string;
  /** Heuristic only — never delete from this flag alone. */
  likely_test?: boolean;
  test_reason?: string;
  test_blocked?: string;
}

export interface SurveyRollup {
  id: string;
  feature: string;
  n: number;
  avg_score: number | null;
}

export interface SurveyRecent {
  at: string;
  feature: string;
  score?: number;
  skip?: boolean;
  comment?: string;
  org_id: string;
}

export interface ProductSnapshot {
  generated_at: string;
  members: {
    total: number;
    verified: number;
    signed_up_7d: number;
    signed_up_30d: number;
    by_day: DayCount[];
  };
  orgs: {
    total: number;
    paying: number;
    trialing: number;
    past_due: number;
    cancelled: number;
    none: number;
    by_plan: CountRow[];
    by_status: CountRow[];
  };
  loop: {
    clients: number;
    cases_open: number;
    cases_by_stage: CountRow[];
    deliverables_by_status: CountRow[];
    invoices_by_status: CountRow[];
    waits_open: number;
  };
  surveys: {
    prompts: SurveyRollup[];
    recent: SurveyRecent[];
    responded: number;
    skipped: number;
  };
  tenants: ProductTenant[];
}

export interface AgencyDigest {
  org_id: string;
  org_name: string;
  to: string[];
  period_label: string;
  clients: { total: number; new: number };
  pipeline: { open: number; replied: number; booked: number };
  deliverables: { in_review: number; with_client: number; accepted: number; changes: number };
  invoices: { draft: number; sent: number; overdue: number; paid: number };
  waits_open: number;
  /**
   * WHAT MYCEL DID in the period — as opposed to every other field here, which is what STATE the
   * founder's book is in. See `buildAgencyDigest` for why the distinction is the whole point.
   */
  work: {
    /** Runs that SUCCEEDED. A failed or held run is not a thing we did for someone. */
    ran: number;
    /** The biggest few kinds, so the line reads as work rather than as a number. */
    by_kind: { kind: string; count: number }[];
    /** Minor units, and only from invoices we actually chased — see the attribution note. */
    collected_minor: number;
    currency: string;
    deliverables_accepted: number;
  };
  /** The track record. A week is a week; "since you started" is why leaving costs something. */
  lifetime: { ran: number; collected_minor: number };
  /** ISO date when the plan renews, only when that's soon enough to mention. */
  renews_at?: string;
}

function bump(map: Map<string, number>, key: string, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}

function rows(map: Map<string, number>): CountRow[] {
  return [...map.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

function dayKeys(days: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}


/**
 * Test identities, not customers.
 *
 * Matches known QA addressing. Does NOT match a real founder's plus-tag unless the tag is
 * test/qa/fake/demo. Paying and super-admin addresses are reported as blocked, never as safe
 * to wipe.
 */
export function classifyTestEmail(email: string | undefined): { test: boolean; reason?: string } {
  const e = (email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return { test: false };
  if (e === "owner@test.co") return { test: true, reason: "owner@test.co" };
  const at = e.lastIndexOf("@");
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === "example.test" || domain === "example.com" || domain === "example.org" || domain === "test.co" || domain === "test.com") {
    return { test: true, reason: domain };
  }
  if (domain.endsWith(".test")) return { test: true, reason: ".test TLD" };
  if (domain.endsWith(".example") || domain === "example" || domain.endsWith(".invalid") || domain.endsWith(".local")) {
    return { test: true, reason: "reserved TLD" };
  }
  if (domain === "mailinator.com" || domain === "yopmail.com" || domain === "guerrillamail.com") {
    return { test: true, reason: "disposable mailbox" };
  }
  if (domain === "mycelqa.dev" || domain === "mycel-walk.dev" || domain === "mycel.local") {
    return { test: true, reason: "product QA domain" };
  }
  if (/\+(test|qa|fake|demo)([._-]|$)/i.test(local) || /[._-](test|qa)$/i.test(local)) {
    return { test: true, reason: "plus/qa local-part" };
  }
  if (local === "test" || local === "qa" || local.startsWith("test+") || local.startsWith("qa+")) {
    return { test: true, reason: "qa local-part" };
  }
  return { test: false };
}

export function testIdentityBlocked(org: Pick<Org, "plan_status" | "billing_ref">, email: string): string | undefined {
  if (isSuperAdminEmail(email)) return "super-admin";
  const st = org.plan_status ?? "none";
  if (st === "active" || st === "past_due") return "paying";
  if (st === "trialing" && org.billing_ref) return "trial with billing";
  return undefined;
}

/** Mon / Wed / Fri UTC. Daily cron hits this; only those weekdays actually send. */
export function isDigestWeekday(now = new Date()): boolean {
  const d = now.getUTCDay();
  return d === 1 || d === 3 || d === 5;
}

export function digestDue(org: Org, now = Date.now()): boolean {
  if (!isDigestWeekday(new Date(now))) return false;
  /**
   * ONLY AN ORG THAT HAS ACTUALLY PAID GETS MAIL FROM US.
   *
   * This asked `status !== cancelled && status !== none`, which every seeded and self-hosted row
   * answers `active` to without anyone being billed. On 7 September that sent a weekly digest to
   * `founder@mycel.local` — a TLD that cannot resolve, so a guaranteed hard bounce — plus two demo
   * tenants and one real person at a real company who never asked for it.
   *
   * The bounces and delays land on the sending domain that every customer's mail shares, so a
   * fake row in our own database degrades delivery for the people who are paying. See `hasPaidPlan`
   * for why `billing_ref` is the test rather than the status.
   *
   * A row that has not paid keeps its account and its data. It just does not get to send.
   */
  if (!hasPaidPlan(org)) return false;
  if (!org.last_digest_at) return true;
  const last = Date.parse(org.last_digest_at);
  if (!Number.isFinite(last)) return true;
  return now - last >= DIGEST_GAP_MS;
}

export async function buildProductSnapshot(now = new Date()): Promise<ProductSnapshot> {
  const identity = getIdentityStore();
  const domain = getDomainStore();
  const billing = getBillingStore();
  const deliverables = getDeliverableStore();

  const orgs = identity.listOrgs();
  const members = identity.listAllMembers();
  const projects = identity.listAllProjects();
  const nowMs = now.getTime();
  const day30 = dayKeys(30, now);
  const byDay = new Map(day30.map((d) => [d, 0]));

  let verified = 0;
  let signed7 = 0;
  let signed30 = 0;
  for (const m of members) {
    if (m.email_verified_at) verified += 1;
    const t = Date.parse(m.created_at);
    if (Number.isFinite(t)) {
      if (nowMs - t <= 7 * DAY_MS) signed7 += 1;
      if (nowMs - t <= 30 * DAY_MS) signed30 += 1;
      const day = m.created_at.slice(0, 10);
      if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
  }

  const byPlan = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let paying = 0;
  let trialing = 0;
  let pastDue = 0;
  let cancelled = 0;
  let none = 0;
  const membersByOrg = new Map<string, number>();
  for (const m of members) bump(membersByOrg, m.org_id);
  const ownerByOrg = new Map<string, string>();
  for (const m of members) {
    if (m.role === "owner" && !ownerByOrg.has(m.org_id)) ownerByOrg.set(m.org_id, m.email);
  }

  for (const o of orgs) {
    bump(byPlan, o.plan ?? "self_hosted");
    const st = o.plan_status ?? "none";
    bump(byStatus, st);
    if (st === "active") paying += 1;
    else if (st === "trialing") {
      trialing += 1;
      paying += 1;
    } else if (st === "past_due") pastDue += 1;
    else if (st === "cancelled") cancelled += 1;
    else none += 1;
  }

  const clients = await domain.listClients();
  const stageCounts = new Map<string, number>();
  const delivCounts = new Map<string, number>();
  const invCounts = new Map<string, number>();
  let casesOpen = 0;
  let waitsOpen = 0;

  for (const p of projects) {
    const cases = await domain.listCases({ project_id: p.id });
    for (const k of cases) {
      if (k.status === "open") casesOpen += 1;
      bump(stageCounts, k.stage || "unknown");
    }
    const waits = await domain.listWaits({ project_id: p.id, status: "waiting", limit: 500 });
    waitsOpen += waits.length;
    const ds = await deliverables.listDeliverables({ project_id: p.id, limit: 500 });
    for (const d of ds) bump(delivCounts, d.status);
    const inv = await billing.listInvoices({ project_id: p.id, limit: 500 });
    for (const i of inv) bump(invCounts, i.status);
  }

  const surveyN = new Map<string, { n: number; sum: number; scored: number }>();
  for (const p of SURVEY_PROMPTS) surveyN.set(p.id, { n: 0, sum: 0, scored: 0 });
  const recent: SurveyRecent[] = [];
  let responded = 0;
  let skipped = 0;
  for (const m of members) {
    const log = asSurveyLog(m.prefs?.surveys);
    for (const [id, a] of Object.entries(log.answers)) {
      const slot = surveyN.get(id) ?? { n: 0, sum: 0, scored: 0 };
      slot.n += 1;
      if (typeof a.score === "number") {
        slot.sum += a.score;
        slot.scored += 1;
        responded += 1;
      }
      if (a.skip) skipped += 1;
      surveyN.set(id, slot);
      const prompt = SURVEY_PROMPTS.find((p) => p.id === id);
      recent.push({
        at: a.at,
        feature: prompt?.feature ?? id,
        score: a.score,
        skip: a.skip,
        comment: a.comment,
        org_id: m.org_id,
      });
    }
  }
  recent.sort((a, b) => b.at.localeCompare(a.at));

  const tenants: ProductTenant[] = orgs
    .map((o) => {
      const owner = ownerByOrg.get(o.id);
      const classified = classifyTestEmail(owner);
      const blocked = owner ? testIdentityBlocked(o, owner) : undefined;
      return {
        org_id: o.id,
        name: o.name,
        created_at: o.created_at,
        plan: o.plan ?? "self_hosted",
        plan_status: (o.plan_status ?? "none") as PlanStatus,
        members: membersByOrg.get(o.id) ?? 0,
        projects: identity.listProjects(o.id).length,
        owner_email: owner,
        likely_test: classified.test,
        test_reason: classified.reason,
        test_blocked: classified.test ? blocked : undefined,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    generated_at: now.toISOString(),
    members: {
      total: members.length,
      verified,
      signed_up_7d: signed7,
      signed_up_30d: signed30,
      by_day: day30.map((day) => ({ day, n: byDay.get(day) ?? 0 })),
    },
    orgs: {
      total: orgs.length,
      paying,
      trialing,
      past_due: pastDue,
      cancelled,
      none,
      by_plan: rows(byPlan),
      by_status: rows(byStatus),
    },
    loop: {
      clients: clients.length,
      cases_open: casesOpen,
      cases_by_stage: rows(stageCounts),
      deliverables_by_status: rows(delivCounts),
      invoices_by_status: rows(invCounts),
      waits_open: waitsOpen,
    },
    surveys: {
      prompts: SURVEY_PROMPTS.map((p) => {
        const s = surveyN.get(p.id)!;
        return {
          id: p.id,
          feature: p.feature,
          n: s.n,
          avg_score: s.scored ? Math.round((s.sum / s.scored) * 10) / 10 : null,
        };
      }),
      recent: recent.slice(0, 80),
      responded,
      skipped,
    },
    tenants: tenants.slice(0, 200),
  };
}

export /**
 * `tasks` is injected rather than reached for: the task store is created in index.ts and handed to
 * the server, and this module has never had a handle on it. Optional so every existing caller and
 * test keeps working — a digest with no task reader reports zero work, which is honest, rather than
 * refusing to send.
 */
async function buildAgencyDigest(
  org: Org,
  now = new Date(),
  tasks?: TaskReader,
): Promise<AgencyDigest | undefined> {
  const identity = getIdentityStore();
  const domain = getDomainStore();
  const billing = getBillingStore();
  const deliverables = getDeliverableStore();
  const projects = identity.listProjects(org.id);
  if (!projects.length) return undefined;
  const owners = identity
    .listMembers(org.id)
    .filter((m) => m.role === "owner" || m.role === "admin")
    .map((m) => m.email);
  if (!owners.length) return undefined;

  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  let clientsTotal = 0;
  let clientsNew = 0;
  let pipelineOpen = 0;
  let replied = 0;
  let booked = 0;
  let inReview = 0;
  let withClient = 0;
  let accepted = 0;
  let changes = 0;
  let draft = 0;
  let sent = 0;
  let overdue = 0;
  let paid = 0;
  let waitsOpen = 0;

  /**
   * ═══ WHAT MYCEL DID, WHICH THIS DIGEST NEVER SAID ═══
   *
   * Every other counter in this function is a STATE: how many things sit in status X right now. A
   * founder reading "3 overdue · 5 waiting · 2 paid" learns the state of their own book, which they
   * already knew. Nothing in the mail said the product had done anything.
   *
   * That is a retention problem, not a copy problem. The recurring artifact whose whole job is to
   * prove the value recurred was reporting the customer's business back to them. The thing that
   * makes an agent product worth keeping is the opposite sentence: here is the work I did while you
   * were away, and here is what it has come to.
   *
   * So: work done in the window, and the lifetime total underneath it. The lifetime line is the one
   * that makes leaving expensive — a week is a week, but "since you started" is a track record.
   */
  let ranWindow = 0;
  let ranLifetime = 0;
  const byKind = new Map<string, number>();
  let collectedWindow = 0;
  let collectedLifetime = 0;
  let currency = "";
  let acceptedWindow = 0;

  const allClients = await domain.listClients();
  /**
   * Read ONCE, outside the loop, and bucket by project.
   *
   * `listTasks` is cross-tenant and this ran per project — an org with eight projects paid for
   * eight full scans of the same rows to produce eight disjoint subsets of them. The state counters
   * above are per-project reads because their stores take a project filter; this one does not, so
   * the loop is the wrong place for it.
   *
   * `succeeded` only — a failed or held run is not a thing we did FOR someone, and counting it
   * would make this a measure of activity rather than of value. Held work is real and the founder
   * sees it on the approvals queue; it does not belong in a sentence that says what got done.
   */
  const doneByProject = new Map<string, Task[]>();
  if (tasks) {
    for (const t of await tasks({ status: "succeeded", limit: 5000 })) {
      const key = t.project_id ?? "";
      const list = doneByProject.get(key);
      if (list) list.push(t);
      else doneByProject.set(key, [t]);
    }
  }
  for (const p of projects) {
    const mineDone = doneByProject.get(p.id) ?? [];
    ranLifetime += mineDone.length;
    for (const t of mineDone) {
      if (t.updated_at >= since) {
        ranWindow += 1;
        byKind.set(t.task_type, (byKind.get(t.task_type) ?? 0) + 1);
      }
    }
    const mine = allClients.filter((c) => c.project_id === p.id);
    clientsTotal += mine.length;
    clientsNew += mine.filter((c) => c.created_at >= since).length;
    const cases = await domain.listCases({ project_id: p.id, status: "open" });
    pipelineOpen += cases.length;
    replied += cases.filter((k) => k.stage === "replied").length;
    booked += cases.filter((k) => k.stage === "booked" || k.stage === "won").length;
    const ds = await deliverables.listDeliverables({ project_id: p.id, limit: 500 });
    acceptedWindow += ds.filter((d) => d.accepted_at && d.accepted_at >= since).length;
    inReview += ds.filter((d) => d.status === "in_review").length;
    withClient += ds.filter((d) => d.status === "with_client").length;
    accepted += ds.filter((d) => d.status === "accepted").length;
    changes += ds.filter((d) => d.status === "changes_requested").length;
    const inv = await billing.listInvoices({ project_id: p.id, limit: 500 });
    draft += inv.filter((i) => i.status === "draft").length;
    sent += inv.filter((i) => i.status === "sent").length;
    overdue += inv.filter((i) => i.status === "overdue").length;
    paid += inv.filter((i) => i.status === "paid").length;
    /**
     * MONEY WE CAN HONESTLY CLAIM.
     *
     * Only an invoice we actually CHASED (`last_chased_at` set) counts. A founder who rang the
     * client themselves and got paid did that; folding it into "Mycel collected" would be the
     * product taking credit for someone else's phone call, and a number a founder can catch us
     * inflating once is a number they never trust again.
     *
     * This is the same rule the capability gate applies to deliverables, pointed at our own
     * marketing: do not describe a step we did not take as done.
     */
    for (const i of inv) {
      if (!i.last_chased_at || !i.paid_at) continue;
      const amount = Math.trunc(i.amount_paid ?? 0);
      if (amount <= 0) continue;
      collectedLifetime += amount;
      if (i.paid_at >= since) collectedWindow += amount;
      // First currency seen wins. A digest mixing GBP and EUR into one integer would be worse than
      // one that reports the majority currency, and a per-currency breakdown in a summary line is
      // more precision than the sentence can carry.
      if (!currency) currency = i.currency;
    }
    waitsOpen += (await domain.listWaits({ project_id: p.id, status: "waiting", limit: 200 })).length;
  }

  return {
    org_id: org.id,
    org_name: org.name,
    to: owners,
    period_label: "this week",
    clients: { total: clientsTotal, new: clientsNew },
    pipeline: { open: pipelineOpen, replied, booked },
    deliverables: { in_review: inReview, with_client: withClient, accepted, changes },
    invoices: { draft, sent, overdue, paid },
    waits_open: waitsOpen,
    work: {
      ran: ranWindow,
      by_kind: [...byKind.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
        .slice(0, 4),
      collected_minor: collectedWindow,
      // WHAT THIS BUSINESS BILLS IN when no invoice has been raised yet, rather than a constant. A
      // digest that opens "£0 collected" to an agency in Denver is wrong about the only thing on
      // that line it could have known without any invoices at all.
      currency: currency || identity.brandKit(projects[0]?.id ?? "")?.currency || "USD",
      deliverables_accepted: acceptedWindow,
    },
    lifetime: { ran: ranLifetime, collected_minor: collectedLifetime },
    ...(org.plan_renews_at && Date.parse(org.plan_renews_at) - now.getTime() <= 7 * DAY_MS
      && Date.parse(org.plan_renews_at) >= now.getTime()
      ? { renews_at: org.plan_renews_at }
      : {}),
  };
}

/** Just enough of the task store to count finished work, so this module does not import all of it. */
export type TaskReader = (filter: { status?: TaskStatus; limit?: number }) => Promise<Task[]>;

export async function listDueDigests(now = new Date(), tasks?: TaskReader): Promise<AgencyDigest[]> {
  const identity = getIdentityStore();
  const out: AgencyDigest[] = [];
  for (const org of identity.listOrgs()) {
    if (!digestDue(org, now.getTime())) continue;
    const d = await buildAgencyDigest(org, now, tasks);
    if (d) out.push(d);
  }
  return out;
}

