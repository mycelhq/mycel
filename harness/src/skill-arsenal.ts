// THE ARSENAL THE SHAPER COMPOSES FROM — library skills, trade bundles, allowlisted skill sources.
//
// Kortix's marketplace is job-shaped runbooks (dunning-escalation, month-end-close), not vertical
// HTML. The meta-agent searches that shelf and copies; it does not invent a taxonomy from two
// sentences. We already seed `kernel/service-skills/<domain>/*.md` into the library. This module is
// the missing wire: `draft_service` is handed the index, the matching bodies, and the bundles, so
// write-a-service can compose instead of hallucinate.
//
// Trust line, same as skill-library.ts: prose only. Bundles name domains and skill files. They are
// not forks of jewelry vs florist. A fetched SKILL.md still cannot raise permission or send.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describeResearch, researchQuality } from "./research-quality";
import { join } from "node:path";
import { ALL_CAPABILITIES, CAPABILITIES } from "./capabilities";
import { parseSkillDoc, skillsSeedDir, type LibrarySkill } from "./skill-library";
import { loadWedge, wedgesDir } from "./wedge";

/** A use-case pack: several library skills that together run a desk. Not a vertical. */
export interface TradeBundle {
  id: string;
  title: string;
  /** When the founder's words point here. */
  when: string;
  domains: string[];
}

/**
 * Bundles are desks (GEO, books, web, GTM), not clients (jeweler, florist). The shaper picks one
 * when the work matches, then copies the skills in those domains rather than inventing a fork.
 */
export const TRADE_BUNDLES: readonly TradeBundle[] = [
  {
    id: "geo",
    title: "AI search / GEO",
    when: "They sell being found in ChatGPT, Perplexity, or Google AI answers — measurement, pages, citations.",
    domains: ["digital-marketing", "copywriting", "design", "deliverables"],
  },
  {
    id: "books",
    title: "Books and close",
    when: "They keep books, reconcile, close a month, or chase invoices.",
    domains: ["bookkeeping", "tax-preparation", "financial-advisory", "deliverables"],
  },
  {
    id: "web",
    title: "Sites and productised web",
    when: "They ship websites, landing pages, or design systems.",
    domains: ["web-development", "design", "copywriting", "deliverables"],
  },
  {
    id: "gtm",
    title: "Find and win work",
    when: "They fill a pipeline: research, outreach, proposals, follow-up.",
    domains: ["gtm", "copywriting", "public-relations", "deliverables"],
  },
  {
    id: "legal",
    title: "Contracts and filings",
    when: "They review or draft contracts, formation, or compliance memos.",
    domains: ["legal-services"],
  },
  {
    id: "ops",
    title: "Admin and ops",
    when: "They run inbox, calendar, recruiting, IT, or a VA desk.",
    domains: ["virtual-assistant", "recruiting", "it-managed-services"],
  },
];

/**
 * Shelves the shaper may webfetch a SKILL.md from — and the ONLY reason this list is short.
 *
 * ═══ A SKILL WE COPY IS A SKILL WE REDISTRIBUTE ═══
 *
 * Everything imported here lands in the cross-tenant library, is mounted into runs for paying
 * agencies, and reaches their clients. That is redistribution and derivative use, whatever the
 * import door calls it. So the licence is a hard gate on this list, checked by a human before an
 * entry is added, and named on the entry so the next person does not have to go and find out.
 *
 * `anthropics/skills` USED TO BE ON THIS LIST AND HAD TO COME OFF. Its skills are excellent and its
 * repository is public, which is exactly the trap: public is not open. Every SKILL.md there carries
 * `license: Proprietary`, and the LICENSE.txt beside it forbids, by name, retaining copies outside
 * Anthropic's services, reproducing them, and creating derivative works. Pointing our own shaper at
 * it was an instruction to do all three. Left written down rather than quietly deleted, because the
 * next person to go looking for good skills will find that repo first, for the same good reasons.
 *
 * The bar for adding a shelf: an OSI-permissive licence file in the repository, read rather than
 * assumed from a badge, and prose that survives the two hazards `skill-harvest.mjs` documents.
 */
export const SKILL_SEARCH_SOURCES: readonly {
  name: string;
  url: string;
  /** SPDX id, from the repository's own LICENSE file. */
  license: string;
  note: string;
}[] = [
  {
    name: "Marketing skills (Corey Haines)",
    url: "https://raw.githubusercontent.com/coreyhaines31/marketingskills",
    license: "MIT",
    note: "Fifty marketing runbooks — AI SEO, CRO, cold email, positioning. Fetch the raw SKILL.md, never the HTML page and never a bundled script.",
  },
];

export interface ArsenalEntry {
  name: string;
  domain: string;
  description: string;
}

export interface PickedSkill {
  name: string;
  domain: string;
  description: string;
  /** Full markdown. Cap the count, not the craft — the shaper copies this rather than inventing. */
  body: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Installed sellable wedges, as the shaper's catalogue. Internal machinery stays off this list. */
export function sellableCatalogue(): Array<{
  wedge: string;
  title: string;
  jobs: Array<{ task_type: string; description: string }>;
}> {
  let slugs: string[] = [];
  try {
    slugs = readdirSync(wedgesDir()).filter((d) => existsSync(join(wedgesDir(), d, "wedge.json")));
  } catch {
    return [];
  }
  const out: Array<{
    wedge: string;
    title: string;
    jobs: Array<{ task_type: string; description: string }>;
  }> = [];
  for (const slug of slugs) {
    const w = loadWedge(slug);
    if (!w || w.manifest.internal === true) continue;
    out.push({
      wedge: slug,
      title: w.manifest.title ?? slug,
      jobs: Object.entries(w.manifest.task_types ?? {}).map(([name, t]) => ({
        task_type: name,
        description: t.description ?? "",
      })),
    });
  }
  return out;
}

function walkSeed(): LibrarySkill[] {
  const dir = skillsSeedDir();
  if (!existsSync(dir)) return [];
  const out: LibrarySkill[] = [];
  for (const domainName of readdirSync(dir)) {
    const domainDir = join(dir, domainName);
    try {
      if (!statSync(domainDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith(".md")) continue;
      let content = "";
      try {
        content = readFileSync(join(domainDir, file), "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillDoc(content, { domains: [domainName], source: "authored" });
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** Compact menu: every curated skill, no bodies. The shaper picks, then reads `picked`. */
export function listArsenalIndex(): ArsenalEntry[] {
  return walkSeed().map((s) => ({
    name: s.name,
    domain: s.domains[0] ?? "",
    description: s.description,
  }));
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "they",
  "their",
  "have",
  "run",
  "running",
  "business",
  "client",
  "clients",
  "service",
  "services",
  "work",
  "i",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "we",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Rank library skills against the founder's sentence. Returns full bodies of the best few so the
 * authoring run can copy a runbook instead of a Wikipedia paragraph.
 */
export function pickArsenalBodies(description: string, limit = 4): PickedSkill[] {
  const wanted = new Set(tokens(description));
  if (!wanted.size) return [];

  /**
   * WHAT A SKILL IS CALLED IS WORTH MORE THAN WHAT IT MENTIONS.
   *
   * The first scorer counted raw token hits across name, domains, description and the first 800
   * characters of the body, all weighted the same. That ranks by VOCABULARY SIZE: a 24k-word CRO
   * runbook mentions "page", "design" and "landing" in passing and beats `saas-landing`, whose
   * entire subject is the thing asked for. A brief asking for a landing page for a law firm came
   * back with conversion-rate optimisation and Core Web Vitals — both real craft, neither of them
   * how to make the page look good.
   *
   * So the title and the one-line description, which are the skill's claim about ITSELF, score
   * three times what a passing mention in the body does. Distinct matched words are counted, not
   * occurrences, for the same reason: a body repeating "design" forty times knows no more about
   * design than a body saying it twice.
   */
  const skills = walkSeed();
  const scored = skills.map((s) => {
    const claim = new Set(tokens(`${s.name} ${s.domains.join(" ")} ${s.description}`));
    const body = new Set(tokens(s.body.slice(0, 800)));
    let n = 0;
    for (const w of wanted) {
      if (claim.has(w)) n += 3;
      else if (body.has(w)) n += 1;
    }
    return { s, n };
  });
  scored.sort((a, b) => b.n - a.n);
  const min = wanted.size >= 4 ? 3 : 1;

  /**
   * One skill filed under two desks is ONE skill. `skills:harvest` writes the same file into every
   * domain that reaches it — `cro` is under both `digital-marketing` and `web-development` — which
   * is right for discovery and wrong here: mounting it twice spends a quarter of the run's craft
   * budget on a duplicate the model has already read.
   */
  const seen = new Set<string>();
  const out: PickedSkill[] = [];
  for (const { s, n } of scored) {
    if (n < min) break;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ name: s.name, domain: s.domains[0] ?? "", description: s.description, body: s.body });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The desks the picked skills actually belong to — not the whole TRADE_BUNDLES table.
 *
 * Stuffing every bundle into the prompt was a second taxonomy sitting next to the library. The
 * shaper then had to ignore five of them. Empty is honest: this brief hit no shelf, compose from
 * the index or go looking.
 */
export function matchingBundles(picked: readonly PickedSkill[]): TradeBundle[] {
  const domains = new Set(picked.map((s) => s.domain).filter(Boolean));
  if (!domains.size) return [];
  return TRADE_BUNDLES.filter((b) => b.domains.some((d) => domains.has(d)));
}

/**
 * Matching library runbooks, as files the drafting run mounts. Compile sees them; the model copies
 * them. They do not go in the task JSON.
 */
/** `s.name` already ends in `.md` — `parseSkillDoc` normalises it. Appending another made every
  * mounted file `cro.md.md`, which is not a name anything else in the run refers to. */
const arsenalPath = (s: PickedSkill) => `arsenal/${s.domain}/${s.name}`;

export function arsenalSkillsFor(description: string): Array<{ name: string; content: string }> {
  return pickArsenalBodies(description).map((s) => ({
    name: arsenalPath(s),
    content: s.body,
  }));
}

/**
 * ═══ THE SHELF THE RUNS THAT MAKE THINGS COULD NOT REACH ═══
 *
 * `arsenalSkillsFor` was mounted on ONE task type — `draft_service`, which writes the definition of
 * a service and never produces a single thing a client opens. So the whole library was readable at
 * the moment a service was invented and invisible at every moment one was DELIVERED. A run building
 * a site or writing a report saw only what its wedge happened to name, and no wedge names how to
 * lay out a deck. That is why the deliverables look the same whatever the trade: not a bad model, a
 * shelf it could not see.
 *
 * A deliver/build run has no founder sentence to match on, so the brief IS the task: its wedge, its
 * type, and the strings its input carries. Values only — keys are field names (`client_id`,
 * `content_type`) and matching on those ranks by our schema rather than by the work.
 *
 * BUDGET. A delivering run gets the SAME four runbooks a drafting run gets, mounted whole. The
 * first cut of this mounted two and truncated each at 14k characters, on the reasoning that a
 * deliver run is already carrying its wedge's craft and the client's context. That reasoning was
 * wrong in the way that matters: the part of a design skill that makes the output good is not the
 * opening paragraph. It is the type scale, the spacing rule, the fixed-height chart container, the
 * list of things that make a deck look generated. Truncating at 14k keeps the philosophy and drops
 * the specifics — which produces a run that can DESCRIBE good design and cannot execute it, the
 * exact failure the shelf was harvested to fix. Mount them whole or do not mount them.
 */
const DELIVER_ARSENAL_LIMIT = 4;

function briefStrings(v: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof v === "string") return v.length > 1 && v.length < 4000 ? [v] : [];
  if (Array.isArray(v)) return v.flatMap((x) => briefStrings(x, depth + 1));
  if (isRecord(v)) return Object.values(v).flatMap((x) => briefStrings(x, depth + 1));
  return [];
}

export function arsenalSkillsForBrief(task: {
  wedge?: string;
  task_type?: string;
  input?: unknown;
}): Array<{ name: string; content: string }> {
  const brief = [task.wedge ?? "", task.task_type ?? "", ...briefStrings(task.input)].join(" ");
  const picked = pickArsenalBodies(brief, DELIVER_ARSENAL_LIMIT);

  /**
   * ═══ ONE SLOT IS RESERVED FOR HOW IT LOOKS ═══
   *
   * Relevance ranking alone never picks design, and the reason is structural rather than a tuning
   * problem. A brief says what the work is ABOUT — "quarterly SEO report", "pitch deck for a client
   * proposal" — and the skills that match those words are the ones about the subject: SEO runbooks,
   * sales enablement. The craft of making the artefact look like a firm made it shares almost no
   * vocabulary with the subject it presents. So the better the topical match, the more completely
   * design is crowded out, and a shelf with 23 design skills on it produces the same undesigned
   * markdown it produced with four.
   *
   * Hence a floor: if the top matches contain nothing from `design` or `deliverables`, the best
   * craft skill for this brief is ADDED. Ranked against the brief like everything else, so a deck
   * brief gets deck craft and a report brief gets report craft — the SLOT is reserved, not a fixed
   * default skill.
   *
   * Added rather than substituted, which the first cut got wrong. Displacing the weakest topical
   * match sounds free and is not: on "landing page for a law firm" the pick it evicted was
   * `saas-landing` — craft, filed under `web-development` because that is the desk that sells it.
   * A domain allowlist cannot see that, so substitution traded a good skill for a worse one to
   * satisfy a rule about labels. The floor is worth at most one extra runbook, never a good one.
   */
  const CRAFT = new Set(["design", "deliverables"]);
  if (!picked.some((s) => CRAFT.has(s.domain))) {
    const craft = pickArsenalBodies(brief, 40).find(
      (s) => CRAFT.has(s.domain) && !picked.some((p) => p.name === s.name),
    );
    if (craft) picked.push(craft);
  }

  return picked.map((s) => ({ name: arsenalPath(s), content: s.body }));
}

/**
 * ═══ THE REST OF THE SHELF, ON DISK ═══
 *
 * `arsenalSkillsForBrief` mounts four whole skills, and the limit above explains why four and why
 * whole: truncating craft leaves a run that can DESCRIBE good design and cannot execute it. Both
 * halves of that are right. What it leaves unsaid is what happens to the fifth-best match, which is
 * that it does not exist as far as the run is concerned — on a shelf of 221 skills, a brief that
 * needs five is simply served four.
 *
 * open-design solved the same problem the other way round, and their note is the better idea:
 *
 *   "It does not automatically inline every references/*.md file. Instead, the skill-root preamble
 *    tells the agent where the staged skill lives and identifies side files referenced by the body
 *    so the agent can read them when needed."
 *
 * Body in the prompt, the rest ON DISK, and a line saying where. The agent pulls what the work
 * turns out to need instead of us guessing in advance and paying for the guess either way.
 *
 * This is that, applied to the shelf rather than to one skill's references. The four best are
 * mounted whole and unchanged. The next `STAGED_LIMIT` are written into the sandbox and listed in
 * an index, so the run can open `craft/<domain>/<name>.md` when the brief turns out to need it.
 *
 * ── WHY AN INDEX RATHER THAN JUST FILES ──
 *
 * A directory the agent has not been told about is a directory it will not read. The index is the
 * cheap part — one line per skill, the name and its own one-line claim — and it is what converts
 * a staged file from "present" into "reachable". It costs a few hundred tokens for access to
 * material that would otherwise cost tens of thousands to mount.
 *
 * ── AND WHY IT IS CAPPED AT ALL ──
 *
 * Staging is cheap but not free: every file is a `sandbox.writeFile` round trip before the agent
 * starts, and a run that stages 200 of them pays a visible delay for material it will not open.
 * Twenty is well past what any single brief has drawn on and still fast to write.
 */
const STAGED_LIMIT = 20;

export function stagedArsenalForBrief(task: {
  wedge?: string;
  task_type?: string;
  input?: unknown;
}): { files: Array<{ path: string; content: string }>; index: string; staged: number; shelf: number } {
  const brief = [task.wedge ?? "", task.task_type ?? "", ...briefStrings(task.input)].join(" ");
  const all = pickArsenalBodies(brief, DELIVER_ARSENAL_LIMIT + STAGED_LIMIT);
  // The first `DELIVER_ARSENAL_LIMIT` are already mounted whole by `arsenalSkillsForBrief`. Writing
  // them again would put the same text in the prompt AND on disk, which is the double payment this
  // exists to stop.
  const rest = all.slice(DELIVER_ARSENAL_LIMIT);
  const shelf = walkSeed().length;
  if (rest.length === 0) return { files: [], index: "", staged: 0, shelf };

  const files = rest.map((s) => ({ path: `craft/${s.domain}/${s.name}.md`, content: s.body }));
  /**
   * SAY HOW COMPLETE THIS VIEW IS.
   *
   * openwork's tool catalog renders either "COMPLETE list" or "PARTIAL — 12 of 40 shown", per
   * namespace as well as overall, and changes its workflow instructions to match. The reason is the
   * one this repo keeps rediscovering: a menu that does not say what is missing gets read as the
   * whole world. A run told "here are the next-best matches" reasonably concludes it has seen the
   * shelf, when it has seen 24 of 221.
   */
  const index = [
    "# Craft you can open, but have not been given",
    "",
    `Your context holds the ${DELIVER_ARSENAL_LIMIT} closest matches for this brief. Below are the ` +
      `next ${rest.length}, staged as files in this sandbox. The full shelf is ${shelf} procedures, ` +
      `so this page is a PARTIAL view: ${DELIVER_ARSENAL_LIMIT + rest.length} of ${shelf} are ` +
      `reachable from this run, and the rest are not here at all.`,
    "",
    "These are NOT in your context — each is a file, and you read one only if the work turns out to",
    "need it. Opening a file you do not need costs the run nothing; writing an artefact without",
    "craft you had available costs it everything.",
    "",
    ...rest.map((s) => `- \`craft/${s.domain}/${s.name}.md\` — ${(s.description || s.name).slice(0, 140)}`),
    "",
    "Reach for these when the brief asks for something the mounted four do not cover. If none of",
    "them fits either, say so in your final message rather than improvising the craft — a procedure",
    "nobody wrote is a gap worth reporting, not a gap worth filling silently.",
  ].join("\n");
  return { files, index, staged: rest.length, shelf };
}

function authorableCapabilities(): Array<{ capability: string; title: string; question: string }> {
  return ALL_CAPABILITIES.map((c) => ({
    capability: c,
    title: CAPABILITIES[c].title,
    question: CAPABILITIES[c].question,
  }));
}

/**
 * Fill the gaps `draft_service` historically shipped without: catalogue, capabilities, and the
 * arsenal. Idempotent — values the cloud already sent are kept. Called at prompt time so a stored
 * task that only has `description` still composes from the shelf.
 */
export function withDraftServiceArsenal(input: unknown, research?: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(input) ? { ...input } : {};
  /**
   * WHAT THE RESEARCH FOUND, when a `research_service` run produced any.
   *
   * `draft_shape` and `draft_service` both run on the `decide` shape, which has no network at all,
   * so until this the meta-agent wrote somebody's business entirely from the model's priors and the
   * one line they typed. `research_service` is the `operate`-shape job that leaves the building; this
   * is where what it found arrives.
   *
   * ── ONLY WHEN IT ACTUALLY REACHED SOMETHING ──
   *
   * A run that came back `reached: false` produced no findings, and passing its empty shape through
   * would tell the author there was nothing out there — which is a different and much stronger claim
   * than "we could not look". Absent means the service is written the way it was written before this
   * job existed, which is a known and worse outcome rather than a wrong one.
   */
  if (isRecord(research) && research.reached === true) {
    next.research = research;
    /**
     * ═══ AND HOW GOOD WAS IT? ═══
     *
     * `reached: true` was the only thing anything downstream ever knew about a research run.
     * research-quality.ts was written to fix exactly that and then went unwired: `researchQuality`
     * and `describeResearch` were reachable from their own tests and from nowhere else, so a run
     * that read three trade-body method statements and a run that read four agency landing pages
     * arrived here indistinguishable, and both were handed to the author as simply "the research".
     *
     * That is the worst place in the product for that gap. The file's own header makes the case: a
     * judge playing the founder scores a written service 3 or below when it is general business
     * admin in the trade's vocabulary and 8 or above when it names the trade's real artefacts,
     * deadlines and counterparties — and those facts are not in the model's priors, they are on the
     * open web. So the research step decides the ceiling of everything authored after it.
     *
     * ATTACHED, NOT ENFORCED. Nothing is filtered and nothing is failed. Marketing copy about a
     * trade is not worthless — it is often the only place a price range is written down — it just
     * must not be read with the authority of a regulator's page. Dropping findings by source would
     * throw away the only evidence a thin trade has; labelling them lets the author discount them,
     * which is what a practitioner does with the same material.
     *
     * `describeResearch` names publishers rather than the score on purpose: "three from standards
     * or trade bodies" is what makes a reader believe the research happened, and "depth 0.74" is
     * not — and the author is a reader.
     */
    const q = researchQuality(research);
    next.research_quality = {
      summary: describeResearch(q),
      depth: q.depth,
      sourced: q.sourced,
      distinct_hosts: q.distinctHosts,
      counts: q.counts,
      /**
       * The fields that cited nothing, so the author is told which claims to hedge rather than
       * left to guess. An unsourced finding is not a lie — it is a claim with no evidence behind
       * it, and the grounding floor's whole argument is that those two must not look the same.
       */
      unsourced: q.unsourced,
    };
  }
  if (!Array.isArray(next.capabilities) || next.capabilities.length === 0) {
    next.capabilities = authorableCapabilities();
  }
  if (!Array.isArray(next.catalogue) || next.catalogue.length === 0) {
    next.catalogue = sellableCatalogue();
  }
  next.arsenal = listArsenalIndex();
  const described = typeof next.description === "string" ? next.description : "";
  const picked = pickArsenalBodies(described);
  // Names only. Bodies are mounted as skills on the run (see `arsenalSkillsFor`) — stuffing four
  // full runbooks into the task JSON was 20k tokens of "please copy this", which the shaper could
  // still invent past, and which made the first drafting completion slow for no quality.
  next.picked = picked.map(({ name, domain, description }) => ({ name, domain, description }));
  next.bundles = matchingBundles(picked);
  next.skill_sources = SKILL_SEARCH_SOURCES;
  return next;
}

/** A job skill needs a human ceiling — Kortix's Always/Never. `Never` as a heading or a list rule. */
export function skillHasNever(content: string): boolean {
  const t = String(content ?? "");
  if (/^#{1,3}\s+Never\b/im.test(t)) return true;
  if (/^[-*]\s+\*?\*?Never\b/im.test(t)) return true;
  if (/\*\*Never\b/i.test(t)) return true;
  return false;
}

/** The task type that goes and looks. Named here because both sides of the seam read it back. */
export const RESEARCH_SERVICE_TASK_TYPE = "research_service";

/**
 * ═══ THE RESEARCH STEP WAS BUILT, DOCUMENTED, TESTED — AND NOBODY EVER ASKED FOR IT ═══
 *
 * `research_service` has a manifest entry, an `operate` harness with a browser and 900 seconds, a
 * `research-a-service` skill, a strict output schema naming deliverables / steps / price range /
 * what the client expects / what goes wrong, and a rule that everything it reports cites where it
 * was found. Three separate modules read its output. `withDraftServiceArsenal` folds it into the
 * drafting prompt. A test asserts its spec.
 *
 * No code path in the product created one. Not the console, not a schedule, not another run. So
 * every service the meta-agent has ever written was written by a model with no network, from one
 * paragraph a founder typed — while the job that would have gone and read the trade sat one call
 * away, fully built.
 *
 * This is the call. It fires when the research finishes, not when the founder presses the button,
 * because `draft_service` reads the findings off the record store at PROMPT time and a draft
 * started in parallel would read an empty one.
 *
 * ── IT RUNS EVEN WHEN THE RESEARCH FOUND NOTHING ──
 *
 * `keepServiceResearch` stores only a run that reached something, and the draft has always coped
 * with an absent record — that is the state it has been in since it was written. A blocked look is
 * a reason to write the service from priors, exactly as before; it is not a reason to leave the
 * founder with no service at all. So the follow-on is unconditional on what was found, and
 * conditional only on the research run having finished.
 */
export const DRAFT_SERVICE_TASK_TYPE = "draft_service";

export interface ArsenalDeps {
  listTasks(a: { limit: number }): Promise<Array<{ project_id?: string; task_type: string; status: string }>>;
  spawnTask(a: {
    project_id: string;
    wedge: string;
    task_type: string;
    source: "schedule";
    input: Record<string, unknown>;
  }): Promise<string>;
}

/** Registered once in server.ts, beside `setShipDeps` — the same seam, for the same reason. */
let deps: ArsenalDeps | null = null;
export function setArsenalDeps(d: ArsenalDeps | null): void {
  deps = d;
}

export async function spawnDraftAfterResearch(args: {
  task: { project_id?: string; wedge: string; task_type: string; input?: unknown };
}): Promise<string | undefined> {
  const { task } = args;
  if (!deps) return undefined;
  if (task.task_type !== RESEARCH_SERVICE_TASK_TYPE || !task.project_id) return undefined;

  /**
   * ═══ LEARNING ABOUT A TRADE IS NOT THE SAME ACT AS REPLACING IT ═══
   *
   * Research used to run in exactly one situation — a founder whose trade nothing covers pressing
   * "write me one" — so "the research finished" and "write the service" were the same event and
   * chaining them was right. Production has ONE research record for that reason, which means the
   * product almost never found out what a business actually delivers.
   *
   * It now also runs for a COVERED trade, purely to learn the shape of the offering: bookkeeping is
   * installed and works, and we still do not know that this particular firm also does VAT returns
   * and payroll. That run must not write anything. Without this flag it would queue a second service
   * against a business already served by a tested one — offering a founder a choice between our
   * code and something written for them ninety seconds ago, which is a worse product dressed as
   * more of one.
   *
   * Checked on the INPUT rather than inferred from the shape's fit. Fit is a judgement that can be
   * re-derived differently later; this is a statement about what the run was started FOR, made by
   * whoever started it, and it cannot drift.
   */
  if ((task.input as { learn_only?: unknown } | undefined)?.learn_only === true) return undefined;

  /**
   * One draft per project, not one per research run.
   *
   * A founder who re-describes their business gets a second research run, and without this check a
   * second draft would be queued while the first is still in flight — two services written for one
   * business, and the review card (which shows the newest draft) flickering between them. Anything
   * already drafted or drafting wins; the founder rejects it and asks again if they want another.
   */
  const mine = (await deps.listTasks({ limit: 200 }).catch(() => []))
    .filter((t) => t.project_id === task.project_id && t.task_type === DRAFT_SERVICE_TASK_TYPE);
  if (mine.some((t) => t.status === "queued" || t.status === "running" || t.status === "succeeded")) return undefined;

  // The founder's own words, carried across from the research run so the draft is written to the
  // same brief the research was. Losing them here would make the second run the weaker of the two.
  const input = (task.input ?? {}) as Record<string, unknown>;
  return deps.spawnTask({
    project_id: task.project_id,
    wedge: task.wedge,
    task_type: DRAFT_SERVICE_TASK_TYPE,
    source: "schedule",
    input: { ...input, because: "research_service" },
  });
}


export const DRAFT_SHAPE_TASK_TYPE = "draft_shape";

/**
 * GO AND FIND OUT WHAT THIS TRADE ACTUALLY DELIVERS — even when we already cover it.
 *
 * ═══ THE NUMBER THAT MADE THIS NECESSARY ═══
 *
 * Production holds exactly ONE `service_research` record. Not because the job is unreliable — the
 * one that ran took 1.4 minutes and cost 1.3 cents — but because it was reachable from a single
 * button, on a home-page panel, shown only to founders whose trade nothing installed covers. Every
 * other business signed up, was matched to a service, and the product never once asked what else
 * they sell.
 *
 * That is the whole of "we need a way to learn what they offer". A covered trade is a statement
 * about ONE job we can do, not about the firm: bookkeeping is installed and works, and it tells us
 * nothing about whether this firm also does VAT returns, payroll and year-end accounts. The
 * research is the only thing in the product that goes and looks.
 *
 * ═══ WHY THE COST IS NOT THE ARGUMENT AGAINST IT ═══
 *
 * 1.3 cents per signup, once, against a plan measured in hundreds of dollars a month. The failure
 * mode worth guarding is not spend, it is the run that hangs — production has one of those too, at
 * 38.9 minutes and no output. It is fire-and-forget and fails soft for exactly that reason: nothing
 * in onboarding waits on it, and a founder whose research never lands sees the flow they saw before
 * this existed.
 *
 * `learn_only` is what stops it writing a service nobody asked for. See `spawnDraftAfterResearch`.
 */
export async function spawnLearningResearch(args: {
  task: { id?: string; project_id?: string; wedge: string; task_type: string; input?: unknown };
  /** The trade, in the founder's words, from the shape. Without it there is nothing to look up. */
  sells: string;
}): Promise<string | undefined> {
  const { task, sells } = args;
  if (!deps || !task.project_id || task.task_type !== DRAFT_SHAPE_TASK_TYPE) return undefined;
  if (!sells.trim()) return undefined;

  /**
   * ONE PER PROJECT, ever. Re-describing a business is a common thing to do in the first ten
   * minutes, and each re-description ends in another `draft_shape`; without this that is a browser
   * run per attempt. The check covers every status including failed on purpose — a research run
   * that hung for thirty-nine minutes must not be retried automatically by a founder pressing the
   * same button again, which is how one bad run becomes six.
   */
  const already = (await deps.listTasks({ limit: 200 }).catch(() => []))
    .some((t) => t.project_id === task.project_id && t.task_type === RESEARCH_SERVICE_TASK_TYPE);
  if (already) return undefined;

  const input = (task.input ?? {}) as Record<string, unknown>;
  return deps.spawnTask({
    project_id: task.project_id,
    wedge: task.wedge,
    task_type: RESEARCH_SERVICE_TASK_TYPE,
    source: "schedule",
    input: { ...input, sells, learn_only: true, because: DRAFT_SHAPE_TASK_TYPE },
  });
}

/** Where a finished market read is kept, so the draft can find it. */
export const RESEARCH_COLLECTION = "service_research";

/** A week. Older than this and the market read belongs to a different shaping session. */
const RESEARCH_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecordStoreish {
  upsertRecord(r: {
    project_id: string;
    wedge: string;
    collection: string;
    key: string;
    data: Record<string, unknown>;
    observed_at?: string;
  }): Promise<unknown>;
  queryRecords(q: { project_id: string; wedge: string; collection: string }): Promise<unknown[]>;
}

/**
 * Keep what the research found, so the draft that runs afterwards can read it.
 *
 * ON THE RECORD STORE rather than on the task, because the two jobs are separate runs that may be
 * minutes or hours apart and `runtime.ts` has no task store in scope at prompt time. One key per
 * project: this wedge runs once per business, and a second read replaces the first rather than
 * accumulating a pile the draft would have to choose between.
 *
 * Only a run that REACHED something is kept. Storing a `reached: false` would tell the next reader
 * there was nothing out there — a much stronger claim than "we could not look".
 */
export async function keepServiceResearch(
  domain: RecordStoreish,
  args: { project_id: string; output: unknown; at?: string },
): Promise<void> {
  if (!args.project_id || !isRecord(args.output) || args.output.reached !== true) return;
  const at = args.at ?? new Date().toISOString();
  await domain.upsertRecord({
    project_id: args.project_id,
    wedge: "kernel",
    collection: RESEARCH_COLLECTION,
    key: "latest",
    data: { ...args.output, at },
    observed_at: at,
  });
}

/**
 * The most recent market read for this project, if it is still fresh.
 *
 * A week, because this wedge runs once per business — anything older belongs to a shaping session
 * that was abandoned, and the founder has since typed something else.
 *
 * Fails soft to undefined. A service drafted without the research is the service this product wrote
 * before the research existed; a draft that fails because a lookup did is strictly worse.
 */
export async function latestServiceResearch(
  domain: RecordStoreish,
  projectId: string | undefined,
  now: number = Date.now(),
): Promise<unknown> {
  if (!projectId) return undefined;
  try {
    const rows = await domain.queryRecords({ project_id: projectId, wedge: "kernel", collection: RESEARCH_COLLECTION });
    const data = (rows ?? []).map((r) => (r as { data?: Record<string, unknown> }).data).find(isRecord);
    if (!data) return undefined;
    const at = Date.parse(String(data.at ?? ""));
    if (Number.isFinite(at) && now - at > RESEARCH_FRESH_MS) return undefined;
    return data;
  } catch {
    return undefined;
  }
}
