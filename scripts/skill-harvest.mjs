#!/usr/bin/env node
// HARVESTING THE SHELF — pulling trade procedure out of open source instead of writing it here.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `service-skills/` is 82 files across 21 trades and every one of them was written in this repo, by
// somebody who does not do that trade. That is the weakest link in `FITTING-A-TRADE.md`: the method
// says "the interview is the work", and an interview nobody conducted produces a plausible summary of
// a trade rather than its craft. Meanwhile practitioners have been publishing exactly that craft
// under MIT licences.
//
// So: harvest, do not author. This script is the door, and it is a script rather than a one-time
// paste so the provenance of every file on the shelf is reproducible — `npm run skills:harvest`
// re-derives them, and a diff shows what upstream changed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE LICENCE GATE, WHICH IS NOT A FORMALITY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A skill we harvest is mounted into runs for paying agencies and reaches their clients. That is
// redistribution and derivative use. So a shelf declares an SPDX id and this script READS the
// repository's LICENSE and refuses if the text does not match — the declaration is a claim to be
// checked, not a fact, because a manifest entry is exactly the sort of thing that gets copied from
// the shelf above it.
//
// `anthropics/skills` is the case that motivated the gate and it is worth naming. Its skills are the
// best on the internet and its repository is public — which is the trap, because public is not open.
// Every SKILL.md there says `license: Proprietary`, and the LICENSE.txt beside it forbids by name
// retaining copies outside Anthropic's services, reproducing them, and creating derivative works.
// It cannot be harvested, its prose cannot be paraphrased into ours, and it is not on the list.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE HAZARDS THAT MAKE A NAIVE IMPORT WORSE THAN NO IMPORT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A skill is prose an agent obeys. Prose that cannot be obeyed is not a neutral no-op — it burns a
// run's budget and ends in a hold nobody can explain. Each of these was measured on the real shelf
// before being handled, and the counts are in the header of each check.
//
//  1. IT TELLS THE AGENT TO RUN SOMETHING WE DID NOT BRING. `skill-library.ts` holds a prose-only
//     trust line: bundled `.py`/`.sh` are dropped on the floor, never fetched or made runnable. That
//     line is right and it is the reason `xlsx` could not be harvested even if it were licensed —
//     its craft IS `recalc.py`. A skill whose prose invokes an executable is REFUSED, not stripped,
//     because a skill with its spine removed still reads like an authority.
//
//  2. IT LINKS TO A SIBLING FILE. This is the one that would have been got wrong: on the real shelf,
//     286 relative links resolve, and they resolve to MARKDOWN — a skill there is a DIRECTORY of
//     prose, not a file. Importing SKILL.md alone yields 286 pointers to files that do not exist.
//     So the directory is FLATTENED: every referenced markdown file is appended as a section and the
//     link is rewritten to its anchor. Nothing is left pointing outward.
//
//     There is a second kind of link and the difference decides whether the shelf is worth having.
//     A link INTO THE SKILL'S OWN DIRECTORY is part of the skill — `cold-email` is six files and the
//     other five are its craft. A link ELSEWHERE IN THE REPOSITORY is context: ten of these skills
//     point at one 4,700-word catalogue of SaaS vendors, which is a shopping list, not procedure.
//     Inlining it ten times would drown each skill in it; refusing over it would have thrown away
//     `ai-seo` — our flagship GEO procedure — for a footnote. Both were tried. So it is neither:
//     the link becomes plain text, the skill carries a note naming what was left behind, and the
//     harvest reports the count. `FITTING-A-TRADE.md`'s rule cuts the same way here as it does for
//     ship checks — a gate that holds good work is a gate somebody deletes.
//
//  3. IT ASKS THE USER A QUESTION. Thirty of fifty open with "gather this context — ask if not
//     provided". These were written for a chat assistant sitting beside a marketer. Our runs are
//     unattended: there is nobody to answer, and an agent that waits produces nothing. The intake
//     record is the answer, and what the intake does not cover is a stated assumption, not a
//     blocker. Handled with a preamble rather than a refusal, because the questions themselves are
//     good — they are the practitioner's checklist, which is the thing we came for.
//
// Refusals are REPORTED BY NAME and never silently repaired. Same argument as `packages.ts`: quietly
// harvesting something adjacent to what was asked for is worse than harvesting nothing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SEED = join(ROOT, "service-skills");

/**
 * The shelves, and what we take from each.
 *
 * `domains` maps an upstream skill to OUR trade taxonomy — the tags a wedge's `domains` intersects.
 * It is hand-written per skill rather than derived from the upstream folder name, because their
 * taxonomy is topic-shaped ("popups", "paywalls") and ours is desk-shaped, and a skill filed under
 * the wrong desk is a skill that never gets mounted or gets mounted into the wrong job.
 *
 * NOT every skill upstream. Fifty is a shelf nobody curated; these are the ones that describe work an
 * agency is PAID FOR, which is the only test that matters here. Growth-team advice about our own
 * pricing page is not a service somebody buys.
 */
const SHELVES = [
  {
    id: "marketingskills",
    repo: "https://github.com/coreyhaines31/marketingskills",
    ref: "main",
    license: "MIT",
    /** A phrase that must appear verbatim in the repository's LICENSE. Checked, not trusted. */
    licenseProof: "Permission is hereby granted, free of charge",
    attribution: "Corey Haines — github.com/coreyhaines31/marketingskills (MIT)",
    skillsPath: "skills",
    take: {
      "ai-seo": ["digital-marketing"],
      "seo-audit": ["digital-marketing"],
      "programmatic-seo": ["digital-marketing"],
      "site-architecture": ["digital-marketing", "web-development"],
      schema: ["digital-marketing", "web-development"],
      "content-strategy": ["digital-marketing", "copywriting"],
      "copy-editing": ["copywriting"],
      copywriting: ["copywriting"],
      emails: ["copywriting", "digital-marketing"],
      ads: ["digital-marketing"],
      "ad-creative": ["digital-marketing", "design"],
      attribution: ["digital-marketing"],
      analytics: ["digital-marketing"],
      "ab-testing": ["digital-marketing"],
      cro: ["digital-marketing", "web-development"],
      "customer-research": ["digital-marketing", "management-consulting"],
      "competitor-profiling": ["digital-marketing", "management-consulting"],
      "cold-email": ["gtm"],
      prospecting: ["gtm"],
      "sales-enablement": ["gtm"],
      "marketing-plan": ["digital-marketing", "management-consulting"],
      launch: ["digital-marketing", "public-relations"],
      "public-relations": ["public-relations"],
      social: ["social-media-management"],
      video: ["video-production", "social-media-management"],
      "influencer-marketing": ["social-media-management"],
      "community-marketing": ["social-media-management"],
      "directory-submissions": ["digital-marketing"],
      offers: ["digital-marketing", "gtm"],
      pricing: ["gtm", "management-consulting"],
      onboarding: ["digital-marketing"],
      "churn-prevention": ["digital-marketing"],
      referrals: ["digital-marketing"],
      revops: ["gtm"],
      signup: ["digital-marketing"],
      paywalls: ["digital-marketing"],
      popups: ["digital-marketing"],
      sms: ["digital-marketing"],
      "free-tools": ["digital-marketing"],
      "product-marketing": ["digital-marketing", "gtm"],
      "marketing-ideas": ["digital-marketing"],
      "marketing-loops": ["digital-marketing"],
      "marketing-council": ["management-consulting"],
      "co-marketing": ["gtm", "public-relations"],
      competitors: ["gtm", "management-consulting"],
      events: ["public-relations", "event-planning"],
      aso: ["social-media-management"],
      image: ["design", "social-media-management"],
      "site-architecture": ["digital-marketing", "web-development"],
      "lead-magnets": ["digital-marketing", "copywriting"],
    },
  },
  {
    id: "open-design",
    repo: "https://github.com/nexu-io/open-design",
    ref: "main",
    license: "Apache-2.0",
    licenseProof: "Licensed under the Apache License",
    attribution: "nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)",
    skillsPath: "skills",
    // Only substantive skills. The repo also ships ~110 one-kilobyte CATALOGUE STUBS whose body is
    // "install the upstream bundle yourself" — importing one advertises craft the kernel does not
    // have, so the shaper picks a skill that then cannot do the work. If you widen this map, open
    // the SKILL.md first and check there are instructions in it.
    take: {
      "brandkit": ["design"],
      "brand-extract": ["design"],
      "design-brief": ["design"],
      "impeccable-design-polish": ["design"],
      "web-design-guidelines": ["design", "web-development"],
      "frontend-design": ["design", "web-development"],
      "redesign-skill": ["design", "web-development"],
      "reference-design-contract": ["design"],
      "minimalist-skill": ["design"],
      "brutalist-skill": ["design"],
      "taste-skill": ["design"],
      "soft-skill": ["design"],
      "data-report": ["deliverables"],
      "faq-page": ["deliverables", "web-development"],
      "release-notes-one-pager": ["deliverables"],
      "research-decision-room": ["deliverables", "management-consulting"],
      "article-magazine": ["deliverables", "copywriting"],
      "output-skill": ["deliverables"],
      "image-to-code-skill": ["web-development"],
      "web-clone": ["web-development"],
      "social-x-post-card": ["social-media-management"],
      "social-reddit-card": ["social-media-management"],
      "emilkowalski-motion": ["web-development"],
      "review-animations": ["web-development"],
      "deck-swiss-international": ["deliverables"],
      "deck-guizang-editorial": ["deliverables"],
      "deck-open-slide-canvas": ["deliverables"],
    },
  },
  {
    id: "open-design-templates",
    repo: "https://github.com/nexu-io/open-design",
    ref: "main",
    license: "Apache-2.0",
    licenseProof: "Licensed under the Apache License",
    attribution: "nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)",
    skillsPath: "design-templates",
    // The deliverable templates: decks, dashboards, landing pages, reports. This is what makes a
    // fulfilment run produce something a client will pay for rather than a wall of markdown.
    take: {
      "blog-post": ["copywriting"],
      "dashboard": ["deliverables"],
      "live-dashboard": ["deliverables"],
      "docs-page": ["deliverables", "web-development"],
      "email-marketing": ["digital-marketing", "copywriting"],
      "html-ppt": ["deliverables"],
      "html-ppt-pitch-deck": ["deliverables"],
      "html-ppt-weekly-report": ["deliverables"],
      "html-ppt-product-launch": ["deliverables"],
      "simple-deck": ["deliverables"],
      "kami-deck": ["deliverables"],
      "replit-deck": ["deliverables"],
      "pricing-page": ["web-development"],
      "saas-landing": ["web-development"],
      "waitlist-page": ["web-development"],
      "kami-landing": ["web-development"],
      "magazine-poster": ["social-media-management"],
      "image-poster": ["social-media-management"],
      "social-carousel": ["social-media-management"],
      "weekly-update": ["deliverables"],
      "last30days": ["deliverables"],
      "wireframe-annotated": ["design"],
      "wireframe-greybox": ["design"],
      "wireframe-mobile-flow": ["design"],
      "wireframe-sketch": ["design"],
      "web-prototype": ["web-development", "design"],
      "critique": ["design"],
      "x-research": ["gtm"],
      "ib-pitch-book": ["financial-advisory"],
      "dcf-valuation": ["financial-advisory"],
      "social-media-dashboard": ["social-media-management"],
      "mobile-app": ["design"],
    },
  },
  {
    id: "open-design-craft",
    repo: "https://github.com/nexu-io/open-design",
    ref: "main",
    license: "Apache-2.0",
    licenseProof: "Licensed under the Apache License",
    attribution: "nexu-io/open-design — github.com/nexu-io/open-design (Apache-2.0)",
    skillsPath: "craft",
    // Flat files, no frontmatter — see the `shelf.flat` branch in the loop below.
    flat: true,
    // The best-written design material in that repository, and it is not in `skills/` at all. These
    // are the rules a competent designer applies without being asked: type scale, colour, motion,
    // the states a component has to cover, what makes an interface read as machine-made.
    //
    // `anti-ai-slop` is NOT here. It is short, it is universal, and it applies to every deliverable
    // rather than to briefs that happen to mention design — so it lives in `craft/`, which is
    // mounted on every run that produces something a client receives.
    take: {
      typography: ["design"],
      "typography-hierarchy": ["design"],
      "typography-hierarchy-editorial": ["design", "deliverables"],
      color: ["design"],
      "laws-of-ux": ["design", "web-development"],
      "accessibility-baseline": ["design", "web-development"],
      "state-coverage": ["design", "web-development"],
      "animation-discipline": ["design", "web-development"],
      "form-validation": ["web-development"],
      "rtl-and-bidi": ["web-development"],
    },
  },
];

/** Hazard 1. Prose that invokes something we did not bring. See the header. */
const INVOKES_EXECUTABLE = /\b(?:python3?|node|bash|sh|ruby|\.\/)\s*[\w./-]*\.(?:py|sh|js|mjs|rb)\b/;

/** Hazard 3. The shape of prose written for somebody sitting next to a human. */
const INTERVIEWS_THE_USER =
  /^#{1,4}\s*Before Starting\b|\bask if not provided\b|\bgather this context\b|\bask the user\b/im;

/**
 * A markdown link to something beside the file, rather than out on the web. Anchors and absolute URLs
 * are left alone; everything else is a pointer into the directory we are flattening.
 */
const RELATIVE_LINK = /\[([^\]]+)\]\(\s*(?!https?:|mailto:|#)([^)\s]+?)\s*\)/g;

/** Bodies are mounted into a prompt. A skill that will not fit is a refusal, not a truncation. */
const MAX_WORDS = 12_000;

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The first real paragraph, as a one-line description. For a flat craft document the author has
 * already written the summary — it is the sentence under the title — it is just not labelled.
 */
function firstParagraph(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("<!--")) continue;
    return line.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").slice(0, 180);
  }
  return undefined;
}

/** Drop the document's own H1 — the mounted file already carries its name in frontmatter. */
function stripLeadingHeading(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#\s+.+\n+/, "").trim();
}

/** Frontmatter `name:` / `description:`, tolerating quotes and the folded-block form. */
function frontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const head = text.slice(3, end);
  /**
   * ═══ A BLOCK SCALAR IS NOT A VALUE, AND HALF THE SHELF SHIPPED WITH `|` AS ITS DESCRIPTION ═══
   *
   * YAML lets a field's value be a folded/literal block:
   *
   *     description: |
   *       Extract a brand from a live site and write a kit.
   *
   * The old one-line regex captured the `|` itself, so 55 of 121 harvested skills carried
   * `description: "|"`. That is not cosmetic: the description is what the arsenal INDEX shows the
   * shaper when it picks skills, and it is weighted three times a body mention when ranking. Half
   * the shelf was unrankable and unreadable at the moment of choosing, while looking fully
   * harvested on disk.
   *
   * So: if the value is a block indicator, gather the indented lines under it and join them.
   */
  const field = (key) => {
    const m = head.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, "m"));
    if (!m) return undefined;
    const inline = m[1].trim();
    if (!/^[|>][-+]?\d*$/.test(inline)) {
      return inline.replace(/^["']|["']$/g, "").replace(/\\"/g, '"').trim() || undefined;
    }
    const lines = head.slice(m.index + m[0].length).split("\n");
    const out = [];
    for (const line of lines) {
      if (!line.trim()) {
        if (out.length) out.push("");
        continue;
      }
      if (!/^[ \t]/.test(line)) break; // dedented — the block ended, this is the next key
      out.push(line.trim());
    }
    return out.join(" ").replace(/\s+/g, " ").trim() || undefined;
  };
  return { name: field("name"), description: field("description"), body: text.slice(end + 4).trim() };
}

/**
 * Fold a skill DIRECTORY into one body.
 *
 * Breadth-first from SKILL.md so a reference's own references come too, and every file appears once
 * however many times it is linked. A link to something outside the directory, or to a non-markdown
 * file, is a FAULT rather than a silent drop — it means the skill's craft lives somewhere we are not
 * bringing, and the operator should decide that, not this function.
 */
function flatten(dir, entry, repoRoot) {
  const faults = [];
  const left = new Set(); // in-repo prose we chose not to carry, named for the reader
  const seen = new Map(); // relative path -> anchor
  const sections = [];
  const queue = [[entry, null]];

  while (queue.length) {
    const [file, from] = queue.shift();
    const rel = relative(dir, file);
    if (seen.has(rel)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      faults.push(`${from ?? "SKILL.md"} links to ${rel}, which is not there`);
      continue;
    }
    const anchor = rel === "SKILL.md" ? null : `reference-${slug(rel.replace(/\.md$/, ""))}`;
    seen.set(rel, anchor);
    sections.push({ rel, anchor, text: rel === "SKILL.md" ? frontmatter(text).body ?? text : text });

    for (const m of text.matchAll(RELATIVE_LINK)) {
      const target = m[2].split("#")[0];
      if (!target || target.startsWith("/")) continue;
      const abs = resolve(dirname(file), target);
      // Only the skill's OWN directory is walked. Everything else is decided once, at rewrite time.
      if (!normalize(abs).startsWith(normalize(dir) + "/")) continue;
      if (!target.endsWith(".md")) {
        faults.push(`${rel} links to ${target}, which is not prose — it cannot come with us`);
        continue;
      }
      if (!existsSync(abs)) {
        faults.push(`${rel} links to ${target}, which does not exist even upstream`);
        continue;
      }
      queue.push([abs, rel]);
    }
  }

  // Rewrite every link after the walk, so a forward reference — a file linking to one collected
  // later — resolves too, and so the in-skill/in-repo/outside decision is made in exactly one place.
  const rewrite = (fromRel, label, target) => {
    const bare = target.split("#")[0];
    if (!bare) return `[${label}](${target})`;

    // A root-absolute link is a path on somebody's WEBSITE, not a file — `/features/analytics`. It
    // never resolved, upstream or here, and there is nothing to point it at.
    if (bare.startsWith("/")) {
      faults.push(`${fromRel} links to ${bare}, which is a website path and not a file`);
      return label;
    }
    const abs = resolve(dirname(join(dir, fromRel)), bare);
    const a = seen.get(relative(dir, abs));
    if (a) return `[${label}](#${a})`;

    // Outside the skill, still inside the repository, still prose: context we deliberately do not
    // carry. Named, not silently vanished — see hazard 2.
    if (normalize(abs).startsWith(normalize(repoRoot) + "/") && bare.endsWith(".md") && existsSync(abs)) {
      left.add(relative(repoRoot, abs));
      return label;
    }
    // Everything left is a genuine dangling pointer. Distinguish them, because "we chose not to
    // carry it" and "upstream is broken" call for completely different responses from whoever reads
    // this — one is a manifest edit here, the other is an issue over there.
    const why = !normalize(abs).startsWith(normalize(repoRoot) + "/")
      ? "which points outside the repository entirely"
      : !bare.endsWith(".md")
        ? "which is not prose — it cannot come with us"
        : "which does not exist even upstream";
    faults.push(`${fromRel} links to ${bare}, ${why}`);
    return label;
  };

  const rendered = sections.map((s) => {
    const text = s.text.replace(RELATIVE_LINK, (whole, label, target) => rewrite(s.rel, label, target));
    return s.anchor
      ? `\n\n---\n\n<a id="${s.anchor}"></a>\n\n## Reference: ${s.rel}\n\n${text}`
      : text;
  });

  // The note exists so an agent that notices a flattened link does not go hunting for the file, and
  // so a human auditing the shelf can see what upstream thought was worth pointing at.
  const note = left.size
    ? `\n\n---\n\n*Upstream also pointed at ${[...left].sort().join(", ")}. Not carried here: it is a` +
      ` catalogue of third-party tools rather than procedure, and this skill has to hold up without it.*`
    : "";

  return { body: (rendered.join("\n") + note).trim(), files: sections.length, left: [...left], faults };
}

/**
 * What a harvested skill has to be told before its first line.
 *
 * Not a disclaimer — a correction. These procedures assume a marketer who can be asked a question,
 * and the single most damaging thing an unattended agent can do with them is wait. The preamble says
 * where the answers actually are and what to do when they are not there, which is the difference
 * between a skill that produces a deliverable and one that produces a hold.
 */
const UNATTENDED = [
  "> **Read this first — you are not in a conversation.**",
  "> This procedure was written for someone sitting beside a marketer who could be asked questions.",
  "> You are running unattended on behalf of an agency, for their client. Nobody will answer you.",
  "> Wherever it says to ask, gather or confirm something: take the answer from the intake record and",
  "> the client's own site instead. Anything you still cannot establish becomes a **stated assumption",
  "> in the deliverable**, written where the reader will see it — never a question, and never a",
  "> blocker. A held run helps nobody; a deliverable that says what it assumed can be corrected in a",
  "> sentence.",
].join("\n");

function harvest(shelf, { dryRun }) {
  const tmp = mkdtempSync(join(tmpdir(), "mycel-skills-"));
  const kept = [];
  const refused = [];
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", shelf.ref, shelf.repo, tmp], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    // THE LICENCE GATE. Read the file; do not believe the manifest.
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]
      .map((f) => join(tmp, f))
      .find((f) => existsSync(f));
    if (!licenseFile) throw new Error(`${shelf.repo} has no LICENSE file — nothing here may be redistributed`);
    const licenseText = readFileSync(licenseFile, "utf8");
    if (!licenseText.includes(shelf.licenseProof)) {
      throw new Error(
        `${shelf.repo} declares ${shelf.license} but its LICENSE does not contain the expected text — read it before changing this line`,
      );
    }
    const commit = execFileSync("git", ["-C", tmp, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

    for (const [name, domains] of Object.entries(shelf.take)) {
      /**
       * TWO SHELF SHAPES.
       *
       * The usual one is a skill DIRECTORY — `<skillsPath>/<name>/SKILL.md` with frontmatter and,
       * often, `references/` beside it. `flat: true` is the other: a plain `<skillsPath>/<name>.md`
       * with no frontmatter at all, which is how good craft documentation is normally written and
       * how open-design's `craft/` is written. Refusing that shape would mean either leaving the
       * best-written design material in the repo unported, or hand-copying it and losing the licence
       * check, the commit pin and the "edit upstream" banner that make the rest of the shelf safe.
       *
       * A flat file has no description to put on a menu, so one is taken from its first paragraph.
       * That is the same job frontmatter does and the author already wrote it — it is simply not
       * labelled.
       */
      const flatFile = shelf.flat ? join(tmp, shelf.skillsPath, `${name}.md`) : null;
      const dir = flatFile ? join(tmp, shelf.skillsPath) : join(tmp, shelf.skillsPath, name);
      const entry = flatFile ?? join(dir, "SKILL.md");
      if (!existsSync(entry)) {
        refused.push({ name, why: "is no longer in the upstream repository" });
        continue;
      }
      const raw = readFileSync(entry, "utf8");
      const fm = shelf.flat ? { ...frontmatter(raw), description: frontmatter(raw).description ?? firstParagraph(raw) } : frontmatter(raw);
      if (!fm.description) {
        refused.push({ name, why: "has no frontmatter description — nothing could put it on a menu" });
        continue;
      }

      // Hazard 1, before flattening: the refusal is about the whole skill, not one section.
      const exe = raw.match(INVOKES_EXECUTABLE);
      if (exe) {
        refused.push({ name, why: `runs \`${exe[0]}\`, and we import prose only — its craft is in a script we do not bring` });
        continue;
      }

      // A flat file is its own body — there is no directory of references to fold in, and passing
      // its parent to `flatten` would try to walk every sibling craft doc into this one.
      const flat = shelf.flat
        ? { body: stripLeadingHeading(raw), faults: [], files: 1 }
        : flatten(dir, entry, tmp);
      if (flat.faults.length) {
        refused.push({ name, why: flat.faults[0] });
        continue;
      }
      if (words(flat.body) > MAX_WORDS) {
        refused.push({ name, why: `is ${words(flat.body)} words across ${flat.files} files — past the ${MAX_WORDS} a prompt can carry` });
        continue;
      }

      const needsPreamble = INTERVIEWS_THE_USER.test(flat.body);
      const body = needsPreamble ? `${UNATTENDED}\n\n${flat.body}` : flat.body;
      const url = shelf.flat
        ? `${shelf.repo}/blob/${commit}/${shelf.skillsPath}/${name}.md`
        : `${shelf.repo}/blob/${commit}/${shelf.skillsPath}/${name}/SKILL.md`;
      const file = [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(fm.description)}`,
        `source: ${url}`,
        `license: ${shelf.license}`,
        `attribution: ${shelf.attribution}`,
        "---",
        "",
        `<!-- HARVESTED, NOT WRITTEN HERE. ${flat.files} upstream file(s) flattened into one; every`,
        `     relative link rewritten to a section anchor. Edit upstream or edit the harvester —`,
        `     a change made here is silently reverted by the next \`npm run skills:harvest\`. -->`,
        "",
        body,
        "",
      ].join("\n");

      kept.push({ name, domains, file, files: flat.files, preamble: needsPreamble });
    }

    if (!dryRun) {
      for (const k of kept) {
        for (const domain of k.domains) {
          const dir = join(SEED, domain);
          mkdirSync(dir, { recursive: true });
          // Filed under every desk that reaches it. `seedLibraryFromDisk` upserts by name, so the
          // same skill in two domains is one library row that both desks find — which is the point.
          writeFileSync(join(dir, `${k.name}.md`), k.file);
        }
      }
    }
    return { kept, refused, commit };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const dryRun = process.argv.includes("--dry-run");
let failed = false;
for (const shelf of SHELVES) {
  process.stdout.write(`\n${shelf.repo} @ ${shelf.ref} (${shelf.license})\n`);
  let r;
  try {
    r = harvest(shelf, { dryRun });
  } catch (e) {
    process.stdout.write(`  ✗ ${e.message}\n`);
    failed = true;
    continue;
  }
  const withPreamble = r.kept.filter((k) => k.preamble).length;
  process.stdout.write(
    `  ${r.kept.length} harvested at ${r.commit} (${withPreamble} needed the unattended preamble)\n`,
  );
  for (const k of r.kept) {
    process.stdout.write(`    ${k.name} → ${k.domains.join(", ")}${k.files > 1 ? ` (${k.files} files)` : ""}\n`);
  }
  if (r.refused.length) {
    process.stdout.write(`\n  ${r.refused.length} refused, by name — none of these was quietly repaired:\n`);
    for (const x of r.refused) process.stdout.write(`    ${x.name} — ${x.why}\n`);
  }
}
process.stdout.write(dryRun ? "\n(dry run — nothing written)\n" : "\n");
process.exit(failed ? 1 : 0);
