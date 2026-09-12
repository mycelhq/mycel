// THE LICENCE GATE — tested against the real licence texts, because a regex over legal prose is
// exactly the kind of code that looks right and is wrong.
//
// The case that motivated every line here is in `the Anthropic case` below: a public repository we
// were already pointing our own service-shaper at.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDISTRIBUTABLE,
  isFetchableSkillUrl,
  licenseUrlsFor,
  readLicense,
  siblingLicenseUrls,
} from "../src/skill-sourcing";

const MIT = `MIT License

Copyright (c) 2025 Corey Haines

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell`;

// Verbatim from skills/xlsx/LICENSE.txt. This is the text the gate exists for.
const ANTHROPIC = `© 2025 Anthropic, PBC. All rights reserved.

LICENSE: Use of these materials (including all code, prompts, assets, files,
and other components of this Skill) is governed by your agreement with
Anthropic regarding use of Anthropic's services.

ADDITIONAL RESTRICTIONS: Notwithstanding anything in the Agreement to the
contrary, users may not:

- Extract these materials from the Services or retain copies of these
  materials outside the Services
- Reproduce or copy these materials, except for temporary copies created
  automatically during authorized use of the Services
- Create derivative works based on these materials`;

test("MIT passes, and says which licence it read", () => {
  const v = readLicense(MIT);
  assert.equal(v.redistributable, true);
  assert.equal(v.spdx, "MIT");
  assert.match(v.why, /MIT/);
});

test("the Anthropic case — a public repository that may not be copied", () => {
  // The whole reason this module exists. It has to fail on the ADDITIONAL RESTRICTIONS block even
  // though the file above it reads like an ordinary licence grant.
  const v = readLicense(ANTHROPIC, "NOASSERTION");
  assert.equal(v.redistributable, false, "this must never be importable");
  assert.match(v.why, /public is not the same as open/i);
});

test("a refusal beats a grant in the same file", () => {
  // A repository can carry MIT for its code and a proprietary notice over its content. Reading only
  // the first paragraph would take the content.
  const both = `${MIT}\n\n---\n\nThe skills in this directory are Proprietary. All rights reserved.`;
  assert.equal(readLicense(both).redistributable, false);
});

test("no licence file is a refusal, not an unknown", () => {
  // The single most important line: silence is also the most common answer, and copyright's default
  // for silence is all-rights-reserved. An importer that read silence as permission would take
  // almost everything it ever looked at.
  for (const empty of [undefined, null, "", "   "]) {
    const v = readLicense(empty as string | undefined);
    assert.equal(v.redistributable, false, JSON.stringify(empty));
    assert.match(v.why, /all-rights-reserved by default/);
  }
});

test("a licence we cannot identify is refused even when the label looks fine", () => {
  // GitHub's detector says MIT for plenty of files that are not MIT. The text is the agreement.
  const v = readLicense("You may use this however you like, I guess. — Dave", "MIT");
  assert.equal(v.redistributable, false);
  assert.match(v.why, /does not match any licence on the redistributable list/);
  assert.match(v.why, /labelled "MIT"/);
});

test("copyleft is refused by this pipeline, and the refusal says it is about the pipeline", () => {
  const gpl = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
Everyone is permitted to copy and distribute verbatim copies of this license document`;
  const v = readLicense(gpl);
  assert.equal(v.redistributable, false);
  assert.ok(!REDISTRIBUTABLE.has("GPL-3.0"));
});

test("Apache, ISC, BSD, CC0 and CC-BY all pass", () => {
  const texts: Array<[string, string]> = [
    ["Apache-2.0", "Apache License, Version 2.0, January 2004"],
    ["ISC", "Permission to use, copy, modify, and/or distribute this software for any purpose"],
    ["BSD-2-Clause", "Redistribution and use in source and binary forms, with or without modification"],
    ["CC0-1.0", "CC0 1.0 Universal"],
    ["Unlicense", "This is free and unencumbered software released into the public domain"],
    ["CC-BY-4.0", "Creative Commons Attribution 4.0 International Public License"],
  ];
  for (const [spdx, text] of texts) {
    const v = readLicense(text);
    assert.equal(v.redistributable, true, `${spdx}: ${v.why}`);
    assert.equal(v.spdx, spdx);
  }
});

test("only a raw file, over https, from a host we named", () => {
  assert.equal(isFetchableSkillUrl("https://raw.githubusercontent.com/a/b/main/SKILL.md").ok, true);
  // The one a model will produce, because it is the URL a human would paste from a browser.
  const rendered = isFetchableSkillUrl("https://github.com/a/b/blob/main/SKILL.md");
  assert.equal(rendered.ok, false);
  assert.match((rendered as { why: string }).why, /raw file, never a rendered page/);
  assert.equal(isFetchableSkillUrl("http://raw.githubusercontent.com/a/b/main/SKILL.md").ok, false);
  assert.equal(isFetchableSkillUrl("https://evil.example/SKILL.md").ok, false);
  assert.equal(isFetchableSkillUrl("not a url").ok, false);
});

test("the licence is derived from the skill's own URL, never accepted alongside it", () => {
  // A caller supplying both could hand us one repository's skill and another's licence. When the
  // caller is a model trying to satisfy a schema, that is not hypothetical.
  const url = new URL("https://raw.githubusercontent.com/acme/shelf/main/skills/x/SKILL.md");
  const roots = licenseUrlsFor(url);
  assert.ok(roots.every((u) => u.startsWith("https://raw.githubusercontent.com/acme/shelf/main/")));
  assert.ok(roots.some((u) => u.endsWith("/LICENSE")));
});

test("a licence beside the skill outranks the one at the root", () => {
  // Exactly how anthropics/skills is arranged: a permissive-looking root, a strict LICENSE.txt in
  // each skill's own directory. Nearest statement wins, which is how a person would read it.
  const url = new URL("https://raw.githubusercontent.com/anthropics/skills/main/skills/xlsx/SKILL.md");
  const siblings = siblingLicenseUrls(url);
  assert.ok(siblings.length > 0);
  assert.ok(
    siblings[0]!.includes("/skills/xlsx/LICENSE"),
    `nearest first, got ${siblings[0]}`,
  );
  const deepest = siblings.findIndex((u) => u.includes("/skills/xlsx/"));
  const shallower = siblings.findIndex((u) => u.includes("/skills/LICENSE"));
  assert.ok(deepest < shallower, "deeper directories must be consulted before shallower ones");
});
