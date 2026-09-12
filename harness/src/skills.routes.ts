// The skill routes — what this business's agents know how to do, and how well it has gone.
//
// ═══ WHY THESE BELONG TOGETHER ═══
//
// Every route here reads the skill arsenal: what is installed, what candidates have been found for
// a trade nobody has served yet, and the scales that record whether a skill's work was accepted.
// That last part is the whole reason the arsenal is not a static folder — a skill earns its place
// from founder verdicts, client verdicts and payment, and these routes are how that record is read.
//
// Two dependencies and nothing else, which is why this was the right next cut. A slice that needs
// twenty injected collaborators is not a module; it is the same code in a different file with a
// worse interface. `/v1/composio` was attempted first and abandoned for exactly that reason —
// twenty-two unresolved names, several of them caches shared with unrelated routes.
import type { Hono } from "hono";
import type { Context } from "hono";
import type { DomainStore } from "./domain";
// Every one of these is an export from a module that already exists — which is what made this the
// right cut. The routes were the only thing keeping the skill subsystem's surface inside server.ts.
import { candidates } from "./skill-candidates";
import { addLibrarySkill, listLibrarySkills, parseSkillDoc, removeLibrarySkill } from "./skill-library";
import { type SkillScale, skillScales } from "./skill-scales";
import { isFetchableSkillUrl, licenseUrlsFor, readLicense, siblingLicenseUrls } from "./skill-sourcing";

export interface SkillRoutesDeps {
  domain: DomainStore;
  /** The projects this caller may READ — a closure over the request scope, built in createServer. */
  accessible: (c: Context) => Set<string>;
}

export function mountSkillRoutes(app: Hono, deps: SkillRoutesDeps): void {
  const { domain, accessible } = deps;

app.get("/v1/skills/scales", async (c) => {
  if (c.req.query("scope") === "global") {
    return c.json({ scope: "global", scales: await skillScales(domain) });
  }
  const merged = new Map<string, SkillScale>();
  for (const pid of accessible(c)) {
    for (const s of await skillScales(domain, { project_id: pid })) {
      const k = `${s.wedge}::${s.skill}`;
      const m =
        merged.get(k) ??
        {
          wedge: s.wedge,
          skill: s.skill,
          accepted: 0,
          revised: 0,
          total: 0,
          acceptance_rate: 0,
          released: 0,
          edited: 0,
          sent_back: 0,
          founder_total: 0,
          paid: 0,
          first_pass_rate: 0,
          mounted: 0,
          read: 0,
          attention_rate: 0,
        };
      m.accepted += s.accepted;
      m.revised += s.revised;
      m.total += s.total;
      m.released += s.released;
      m.edited += s.edited;
      m.sent_back += s.sent_back;
      m.founder_total += s.founder_total;
      m.paid += s.paid;
      // Attention merges by summing the raw counts, never by averaging the rates: a project with
      // three runs and one with three hundred do not get an equal say in whether a skill is opened.
      m.mounted += s.mounted;
      m.read += s.read;
      merged.set(k, m);
    }
  }
  const scales = [...merged.values()];
  for (const s of scales) {
    s.acceptance_rate = s.total ? s.accepted / s.total : 0;
    s.first_pass_rate = s.founder_total ? s.released / s.founder_total : 0;
    s.attention_rate = s.mounted ? s.read / s.mounted : 0;
  }
  scales.sort(
    (a, b) =>
      b.total + b.founder_total - (a.total + a.founder_total) ||
      b.paid - a.paid ||
      b.acceptance_rate - a.acceptance_rate ||
      b.first_pass_rate - a.first_pass_rate,
  );
  return c.json({ scope: "mine", scales });
});

/**
 * WHICH SKILLS ARE ASKING TO BE REWRITTEN — the scale read as a work list rather than a scoreboard.
 *
 * `/v1/skills/scales` answers "how is everything doing". Nobody acts on that: it is a table sorted
 * by evidence, and the thing a founder or an operator actually needs is the two or three
 * procedures where a rewrite would win back real work.
 *
 * The list carries the DIAGNOSIS, not just a rank, and that distinction is the point of it. A skill
 * the agent reads and follows while the founder rewrites the result needs a new body. A skill
 * nobody opens needs a new description — its body cannot be why anything failed, because it was
 * never consulted. Rewriting the body of a skill nobody reads is the most expensive no-op in the
 * system: a reflection run, a trial, weeks of split traffic, and no possible change in outcome.
 *
 * `?scope=global` reads the cross-tenant scoreboard, which is what decides whether a weak procedure
 * is weak everywhere or weak here.
 */
app.get("/v1/skills/candidates", async (c) => {
  const limit = Math.min(50, Math.max(0, Number(c.req.query("limit") ?? 10) || 10));
  if (c.req.query("scope") === "global") {
    return c.json({ scope: "global", candidates: candidates(await skillScales(domain), limit) });
  }
  const merged = new Map<string, SkillScale>();
  for (const pid of accessible(c)) {
    for (const s of await skillScales(domain, { project_id: pid })) {
      const k = `${s.wedge}::${s.skill}`;
      const m = merged.get(k);
      if (!m) {
        merged.set(k, { ...s });
        continue;
      }
      // Raw counts again, never averaged rates — a project with three runs and one with three
      // hundred do not get an equal say in whether a procedure is working.
      m.accepted += s.accepted;
      m.revised += s.revised;
      m.total += s.total;
      m.released += s.released;
      m.edited += s.edited;
      m.sent_back += s.sent_back;
      m.founder_total += s.founder_total;
      m.paid += s.paid;
      m.mounted += s.mounted;
      m.read += s.read;
    }
  }
  const scales = [...merged.values()];
  for (const s of scales) {
    s.acceptance_rate = s.total ? s.accepted / s.total : 0;
    s.first_pass_rate = s.founder_total ? s.released / s.founder_total : 0;
    s.attention_rate = s.mounted ? s.read / s.mounted : 0;
  }
  return c.json({ scope: "mine", candidates: candidates(scales, limit) });
});

app.get("/v1/skills/library", async (c) => {
  const domainTag = c.req.query("domain");
  const skills = await listLibrarySkills(domain, domainTag ? { domains: [domainTag] } : {});
  return c.json({ skills });
});

app.post("/v1/skills/library", async (c) => {
  if (c.get("scope")?.kind !== "key") return c.json({ error: "the shared library is operator-managed" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const content = typeof b.content === "string" ? b.content : "";
  const domains = Array.isArray(b.domains) ? b.domains.filter((d): d is string => typeof d === "string") : [];
  const parsed = parseSkillDoc(content, {
    domains,
    source: typeof b.source_url === "string" ? "imported" : "authored",
    source_url: typeof b.source_url === "string" ? b.source_url : undefined,
  });
  if (!parsed) return c.json({ error: "a skill needs a name (frontmatter `name:` or a `# Heading`) and a body" }, 400);
  if (!parsed.domains.length) return c.json({ error: "tag the skill with at least one domain, or no wedge can find it" }, 400);
  return c.json({ skill: await addLibrarySkill(domain, parsed) });
});

app.delete("/v1/skills/library/:name", async (c) => {
  if (c.get("scope")?.kind !== "key") return c.json({ error: "the shared library is operator-managed" }, 403);
  await removeLibrarySkill(domain, c.req.param("name"));
  return c.json({ ok: true });
});

app.post("/v1/skills/library/import", async (c) => {
  if (c.get("scope")?.kind !== "key") return c.json({ error: "the shared library is operator-managed" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = typeof b.url === "string" ? b.url : "";
  const domains = Array.isArray(b.domains) ? b.domains.filter((d): d is string => typeof d === "string") : [];
  const where = isFetchableSkillUrl(url);
  if (!where.ok) return c.json({ error: where.why }, 400);
  const parsedUrl = where.url;

  /**
   * THE LICENCE, BEFORE THE SKILL.
   *
   * This route fetched and stored prose without ever asking whether we were allowed to. It is
   * operator-gated, which answers "who may import" and says nothing about "what may be imported" —
   * and the thing an operator is most likely to paste is the best skill they found, which is very
   * often the one nobody may copy. `anthropics/skills` is public, superb, and forbids exactly this.
   *
   * The licence URLs are DERIVED from the skill's own URL rather than accepted as a parameter, so
   * there is no way to present one repository's skill under another's licence. Nearest first: a
   * LICENSE.txt beside the skill outranks the repository root, because that is how a person reads
   * it and because it is precisely how the proprietary case is arranged.
   */
  let licence = readLicense(null);
  for (const candidate of [...siblingLicenseUrls(parsedUrl), ...licenseUrlsFor(parsedUrl)]) {
    const lr = await fetch(candidate).catch(() => null);
    if (!lr || !lr.ok) continue;
    licence = readLicense((await lr.text().catch(() => "")).slice(0, 100_000));
    break; // The nearest licence that EXISTS is the one that governs — including when it refuses.
  }
  if (!licence.redistributable) {
    return c.json(
      {
        error: `that skill cannot be imported: ${licence.why}`,
        license: licence.spdx,
      },
      403,
    );
  }

  const res = await fetch(parsedUrl.toString()).catch(() => null);
  if (!res || !res.ok) return c.json({ error: "could not fetch that skill" }, 502);
  const content = (await res.text().catch(() => "")).slice(0, 200_000);

  /**
   * A per-file declaration overrides the repository. `xlsx/SKILL.md` says `license: Proprietary` in
   * its own frontmatter — a file that names its own terms has named them, whatever sits above it.
   */
  const declared = content.match(/^\s*license\s*:\s*(.+)$/m)?.[1]?.trim();
  if (declared && !readLicense(declared).redistributable) {
    return c.json(
      { error: `that skill declares its own licence — "${declared.slice(0, 60)}" — and it is not one we may redistribute` },
      403,
    );
  }

  const parsed = parseSkillDoc(content, { domains, source_url: parsedUrl.toString() });
  if (!parsed) return c.json({ error: "that document has no skill in it (needs a name and a body)" }, 400);
  if (!parsed.domains.length) return c.json({ error: "tag the import with at least one domain" }, 400);
  return c.json({ skill: await addLibrarySkill(domain, parsed) });
});
}
