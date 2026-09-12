// THE DOOR EVERY OUTSIDE SKILL COMES THROUGH — and the licence it has to show at it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A KERNEL MODULE AND NOT A LINE IN THE HARVEST SCRIPT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `scripts/skill-harvest.mjs` sources skills from a manifest a human wrote, and a human reading a
// LICENSE file is a perfectly good gate. That does not scale past the trades we thought of. The shelf
// covers 21 domains; the businesses that will sign up do not stop at 21, and nobody here can write
// the craft of veterinary practice management or HVAC service contracting from imagination — which
// is the whole argument of `FITTING-A-TRADE.md`: the interview is the work.
//
// So the agent has to be able to go and find it. `business-shaper`'s `draft_service` already composes
// from the local shelf; the missing half is what happens when the shelf has nothing for that trade
// and the agent goes looking on the open web.
//
// The moment an AGENT chooses what to import, the licence check stops being paperwork. A human
// pasting a URL has read the page. A model has read a search result. Anything it brings back lands in
// the cross-tenant library, is mounted into runs for paying agencies, and reaches their clients — so
// this module is the one place that decides, and both paths go through it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE RULE, WHICH IS NARROWER THAN "IT IS ON GITHUB"
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Public is not open. `anthropics/skills` is the case that proves it and the reason this file exists:
// a public repository, 170k stars, and every SKILL.md in it declares `license: Proprietary` over a
// LICENSE.txt forbidding by name the retention of copies outside Anthropic's services, their
// reproduction, and derivative works. It was on our shaper's fetch list. An agent told to "find good
// skills for this trade" will find it first, for exactly the reasons we did.
//
// A repository with NO licence is not permissive-by-default — it is all-rights-reserved by default,
// which is the opposite. So silence is a refusal here, and that is the single most important line in
// this file, because silence is also the most common answer.
import { GITHUB_RAW_HOSTS } from "./skill-hosts";

/**
 * Licences under which we may redistribute someone else's prose inside a product we charge for.
 *
 * Permissive only, and deliberately WITHOUT the copyleft family. Not a judgement about those
 * licences — a judgement about this pipeline. A skill is flattened, given a preamble, mounted beside
 * others and served to third parties; whether that constitutes conveying a modified work under
 * GPL/AGPL is a question with a real answer that a lawyer should give, and until one has, an
 * automated importer must not be the thing that decides it. CC-BY-SA is out for the same reason.
 *
 * `CC-BY-4.0` IS here: attribution-only, which every harvested file already carries in frontmatter.
 */
export const REDISTRIBUTABLE = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "Unlicense",
  "CC-BY-4.0",
]);

/**
 * Phrases that identify a licence from its own text, for when the metadata does not say.
 *
 * Text first, metadata second — the opposite of the obvious order, and on purpose. GitHub's licence
 * detector reports `NOASSERTION` for anything it cannot match confidently and will happily label a
 * repository from a LICENSE file the author never meant to cover the content. The text is the
 * agreement; everything else is a guess about it.
 */
const LICENSE_TEXT: ReadonlyArray<{ spdx: string; proof: RegExp }> = [
  { spdx: "MIT", proof: /Permission is hereby granted, free of charge/i },
  { spdx: "Apache-2.0", proof: /Apache License,?\s+Version 2\.0/i },
  { spdx: "ISC", proof: /Permission to use, copy, modify,? and\/or distribute this software/i },
  { spdx: "BSD-3-Clause", proof: /Neither the name of .{0,80} nor the names of its\s+contributors/i },
  { spdx: "BSD-2-Clause", proof: /Redistribution and use in source and binary forms/i },
  { spdx: "CC0-1.0", proof: /CC0 1\.0 Universal/i },
  { spdx: "Unlicense", proof: /This is free and unencumbered software released into the public domain/i },
  { spdx: "CC-BY-4.0", proof: /Creative Commons Attribution 4\.0 International/i },
];

/**
 * Text that means "you may not", however permissive the file it sits in looks.
 *
 * Checked BEFORE any grant is recognised, because these appear in files that also contain permissive
 * boilerplate — a repository can carry an MIT LICENSE for its code and a proprietary notice over its
 * content, and reading only the first would take the content. Anthropic's own wording is here
 * verbatim, since it is the case we actually hit.
 */
const FORBIDS = [
  /All rights reserved/i,
  /may not[\s\S]{0,200}?(?:reproduce|retain copies|derivative works)/i,
  /\bProprietary\b/i,
  /ADDITIONAL RESTRICTIONS/i,
  /for (?:personal|internal|evaluation) use only/i,
  /commercial use (?:is )?(?:prohibited|not permitted)/i,
];

export interface LicenseVerdict {
  /** Whether this may be redistributed inside the product. Nothing imports without it. */
  redistributable: boolean;
  /** The SPDX id we believe applies, when we believe one does. */
  spdx?: string;
  /** A sentence for a human. Always set, including on success — a silent yes teaches nobody. */
  why: string;
}

/**
 * Read a licence out of its own text.
 *
 * Empty or missing text is a REFUSAL, not an unknown. A repository with no LICENSE grants no rights:
 * "all rights reserved" is the default that copyright supplies when an author says nothing, and an
 * importer that treats silence as permission would take almost everything it ever looked at.
 */
export function readLicense(text: string | null | undefined, declaredSpdx?: string): LicenseVerdict {
  const t = String(text ?? "").trim();
  if (!t) {
    return {
      redistributable: false,
      why:
        "there is no licence file — which is not the same as no restrictions. Work with nothing said " +
        "about it is all-rights-reserved by default, and cannot be redistributed inside the product.",
    };
  }

  // The refusal patterns run FIRST and win outright. See the note on FORBIDS.
  for (const p of FORBIDS) {
    const m = t.match(p);
    if (m) {
      return {
        redistributable: false,
        why: `the licence says "${m[0].slice(0, 80).trim()}" — public is not the same as open, and this may not be copied into the library.`,
      };
    }
  }

  const hit = LICENSE_TEXT.find((l) => l.proof.test(t));
  if (!hit) {
    return {
      redistributable: false,
      spdx: declaredSpdx,
      why:
        `the licence text does not match any licence on the redistributable list` +
        `${declaredSpdx ? ` (it is labelled "${declaredSpdx}")` : ""}. A licence nobody here has read ` +
        `is a licence nobody here can rely on.`,
    };
  }
  if (!REDISTRIBUTABLE.has(hit.spdx)) {
    return {
      redistributable: false,
      spdx: hit.spdx,
      why: `${hit.spdx} is not on the redistributable list — see the note on copyleft in skill-sourcing.ts.`,
    };
  }
  return {
    redistributable: true,
    spdx: hit.spdx,
    why: `${hit.spdx}, read from the licence text itself. Attribution travels with the file.`,
  };
}

/** Where a raw SKILL.md may be fetched from. One list, shared with the import route. */
export function isFetchableSkillUrl(raw: string): { ok: true; url: URL } | { ok: false; why: string } {
  let url: URL;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    return { ok: false, why: "that is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, why: "skills are fetched over https only" };
  if (!GITHUB_RAW_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      why: `skills may only be fetched from: ${[...GITHUB_RAW_HOSTS].join(", ")} — the raw file, never a rendered page`,
    };
  }
  return { ok: true, url };
}

/**
 * The licence URL that goes with a raw skill URL, so the gate can be applied without being told.
 *
 * `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path…>` → the same owner/repo/ref, with each
 * candidate licence filename. Derived rather than accepted as a parameter ON PURPOSE: a caller that
 * supplies both could hand us one repository's skill and another repository's licence, and when the
 * caller is a model looking to satisfy a schema, that is not a hypothetical.
 */
export function licenseUrlsFor(rawSkillUrl: URL): string[] {
  const parts = rawSkillUrl.pathname.split("/").filter(Boolean);
  if (rawSkillUrl.hostname !== "raw.githubusercontent.com" || parts.length < 3) return [];
  const [owner, repo, ref] = parts;
  return ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "LICENSE.rst"].map(
    (f) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${f}`,
  );
}

/**
 * The licence file sitting BESIDE the skill, which is not always the one at the repository root.
 *
 * `anthropics/skills` puts a LICENSE.txt in each skill's own directory, and it is stricter than
 * anything at the top. Walking up from the file means the nearest statement wins, which is how a
 * reader would do it.
 */
export function siblingLicenseUrls(rawSkillUrl: URL): string[] {
  const parts = rawSkillUrl.pathname.split("/").filter(Boolean);
  if (rawSkillUrl.hostname !== "raw.githubusercontent.com" || parts.length < 4) return [];
  const [owner, repo, ref, ...rest] = parts;
  const dirs = rest.slice(0, -1);
  const out: string[] = [];
  for (let i = dirs.length; i > 0; i--) {
    const prefix = dirs.slice(0, i).join("/");
    for (const f of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      out.push(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${prefix}/${f}`);
    }
  }
  return out;
}
