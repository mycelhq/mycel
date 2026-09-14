// Where OpenCode runs. Two implementations behind one interface, so the runtime never
// knows which it's talking to:
//   LocalSandbox   — this machine (dev; needs the `opencode` binary + a provider key)
//   DaytonaSandbox — an isolated Daytona microVM (prod; needs DAYTONA_API_KEY)
// Modeled on a create / reuse / preview-link / exec / destroy Daytona lifecycle.
import { execFile, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, reachableFromOtherHosts } from "./config";
import { ensureSnapshot, snapshotName, SNAPSHOT_PREFIX } from "./sandbox.snapshot";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The port the long-lived interactive-preview dev server binds INSIDE the sandbox. DELIBERATELY NOT
 * 3000 — the verify step boots its own throwaway `next dev` on 3000, curls it once and kills it, and
 * a preview server squatting on 3000 would make verify pass against the wrong process (a false
 * green). Lives here rather than in runtime.ts because `DockerSandbox` must publish it at `acquire`
 * time — docker cannot map a port after the container exists.
 *
 * THE SPLIT IS NOT ENOUGH ON ITS OWN, and believing it was cost the preview entirely. Next 16 locks
 * the dev server to its DIRECTORY, not its port, and both servers run in ~/app — so verify's
 * throwaway, orphaned by a kill aimed at npm's wrapper instead of its child, refused every preview
 * boot with "Another next dev server is already running" while this comment said we were safe. The
 * port number still matters for the false-green argument above; the lock is cleared in
 * `startPreview`, and verify now kills its own process tree.
 */
export const PREVIEW_PORT = 4321;

export interface Sandbox {
  id: string;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  /** Start a long-running process (e.g. `opencode serve`); returns immediately. */
  spawn(command: string): Promise<void>;
  /** Run a short command to completion. */
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  /** Base URL the harness uses to reach a port inside the sandbox. */
  previewUrl(port: number): Promise<{ url: string; token?: string }>;
  destroy(): Promise<void>;
}

/**
 * Names that must NEVER appear in a sandbox process environment.
 *
 * Asserted by `sandbox-env.test.ts` via `printenv` inside a LocalSandbox. The list is the
 * production blast radius, not a complete inventory of every secret the kernel might hold — if a
 * new credential is added to the harness process, add it here so the next `printenv` audit fails
 * closed rather than silently inheriting it.
 */
export const SANDBOX_FORBIDDEN_ENV = [
  "SUPABASE_DB_URL",
  "MYCEL_DATABASE_URL",
  "DATABASE_URL",
  "LITELLM_MASTER_KEY",
  "MYCEL_LITELLM_MASTER_KEY",
  "STRIPE_SECRET_KEY",
  "MYCEL_SECRET_KEY",
  "MYCEL_API_KEY",
  "DAYTONA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "RESEND_API_KEY",
  // The image providers. No sandbox has needed one since generation moved behind
  // `/v1/internal/image`, and the day one reappears here is the day a run can spend outside the
  // per-org budget — so the audit should fail rather than the leak be discovered on a bill.
  "MYCEL_IMAGE_OPENAI_KEY",
  "FAL_KEY",
  "MYCEL_FAL_KEY",
  "HIGGSFIELD_API_KEY",
] as const;

// Minimal environment for the agent process. Critically, we do NOT spread process.env — the
// harness holds provider keys, the DB URL, the Daytona key, Langfuse keys, etc., and a
// prompt-injected or misbehaving agent must not be able to `printenv` them out. Everything the
// run legitimately needs (provider creds in native mode, gate token, proxy nonce) is injected
// per-command by the runtime, not inherited here. NOTE: LocalSandbox shares the host kernel and
// is a DEV backend, not a security boundary — use docker/daytona for real isolation.
export function minimalSandboxEnv(home: string): NodeJS.ProcessEnv {
  const pass = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "TZ"] as const;
  const env: NodeJS.ProcessEnv = { HOME: home };
  for (const k of pass) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly home: string;
  private procs: ChildProcess[] = [];

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), "mycel-sbx-"));
    this.id = `local-${this.home.split("/").pop()}`;
  }

  /** Map ~/ and absolute-looking config paths into the sandbox home. */
  private abs(p: string): string {
    const clean = p.replace(/^~\/?/, "").replace(/^\//, "");
    return join(this.home, clean);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.abs(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  async readFile(path: string): Promise<string | null> {
    const full = this.abs(path);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  }

  async spawn(command: string): Promise<void> {
    // HOME points at the sandbox so opencode reads the config we wrote.
    //
    // `detached: true` puts the command in its OWN PROCESS GROUP, and that is a bug fix, not a
    // nicety: this launches `bash -lc "opencode serve …"`, and `destroy()`'s `p.kill()` used to
    // signal only the bash wrapper — the opencode grandchild survived it, orphaned, still bound to
    // the fixed OPENCODE_PORT. The next task's serve then died on the occupied port with an opaque
    // `ServeError`, which is exactly what took out two of three briefs in the first local real-key
    // eval run (they failed "opencode failed to start" while the port squatter from brief one ran
    // on). Prod never sees this — every Daytona/Docker sandbox has its own network — so it is the
    // LocalSandbox's own bug to fix: group-kill in destroy() ends the whole tree.
    const child = spawnProcess("bash", ["-lc", command], {
      cwd: this.home,
      env: minimalSandboxEnv(this.home),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.procs.push(child);
  }

  exec(command: string, timeoutMs = 60000): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        "bash",
        ["-lc", command],
        {
          cwd: this.home,
          env: minimalSandboxEnv(this.home),
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
        },
      );
    });
  }

  async previewUrl(port: number): Promise<{ url: string; token?: string }> {
    return { url: `http://127.0.0.1:${port}` };
  }

  /**
   * ═══ SIGTERM WITH NO FOLLOW-UP IS A LEAK, AND ONE ORPHAN POISONS EVERY LATER RUN ═══
   *
   * This sent SIGTERM to the process group and returned. A process that ignores SIGTERM, or is slow
   * to handle it, simply keeps running — and `opencode serve` is one of them.
   *
   * The consequence is worse than a stray process. Observed repeatedly on 31 August: after one
   * orphaned `opencode` was left behind, EVERY subsequent run died at bootstrap — eight events, the
   * last being `step.started: agent`, and an "opencode ended before completing" whose attached log
   * stops at "loading opencode.jsonc" with no error at all. `pkill opencode` and the very next run
   * succeeded, every time, which is how the cause was pinned rather than guessed.
   *
   * So the first orphan of a session silently converts the whole backend into a machine that cannot
   * run anything, and reports it as an unexplained agent failure. That is the most expensive shape
   * of bug this repo keeps finding: a real fault presenting as a mystery.
   *
   * TERM, a grace period, then KILL. The grace matters — opencode flushes its session on the way
   * out and SIGKILL alone would lose that — but it has to have an end, and 1.5s is longer than any
   * clean shutdown observed here.
   *
   * `destroy()` is not awaited by every caller, so the escalation is scheduled with `unref`'d timers
   * rather than awaited: it must not hold the process open, and it must still fire.
   */
  async destroy(): Promise<void> {
    const GRACE_MS = 1_500;
    for (const p of this.procs) {
      const pid = p.pid;
      try {
        // Negative pid = the whole process group (see spawn) — bash AND the opencode it started.
        if (pid) process.kill(-pid, "SIGTERM");
        else p.kill();
      } catch {
        try {
          p.kill();
        } catch {
          /* noop */
        }
      }
      if (!pid) continue;
      const t = setTimeout(() => {
        try {
          // `kill(-pid, 0)` throws ESRCH when the group is gone, which is the only reliable way to
          // ask. If it does not throw, something in the group outlived its grace and gets SIGKILL.
          process.kill(-pid, 0);
          process.kill(-pid, "SIGKILL");
          console.warn(`[mycel] sandbox process group ${pid} ignored SIGTERM — killed`);
        } catch {
          /* already gone, which is the normal path */
        }
      }, GRACE_MS);
      t.unref();
    }
    /**
     * `MYCEL_KEEP_SANDBOX=1` leaves it on disk.
     *
     * A local run that dies inside opencode takes its whole working directory with it on the way
     * out — the config it was given, the prompt it was handed, the skills that were mounted — and
     * those are exactly the files you need to see. Diagnosing "opencode ended before completing"
     * meant guessing at contents that had already been deleted.
     *
     * Off by default and deliberately not tied to NODE_ENV: 503 of these accumulated in /tmp during
     * one night of eval runs before anybody looked, so the leak is the normal failure mode and
     * keeping them has to be something somebody asks for on purpose.
     */
    if (process.env.MYCEL_KEEP_SANDBOX === "1") {
      console.warn(`[mycel] kept sandbox for inspection: ${this.home}`);
      return;
    }
    try {
      rmSync(this.home, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
}

/**
 * Daytona-backed sandbox.
 *
 * The import stays dynamic so the harness core has no hard dependency — a self-hosted install using
 * a different backend should not be made to carry 164 packages it never calls.
 *
 * The package is `@daytona/sdk`. It was `@daytonaio/sdk`, which is deprecated and now redirects;
 * that older name was what this file asked for, it was never in package.json, and it was never
 * installed anywhere — so the Daytona path had never once executed. In production, with
 * MYCEL_SANDBOX=daytona, that meant the kernel booted, passed its health check, accepted work, and
 * failed every task in under five seconds with `Cannot find package`. Found by running one real task
 * against production rather than by reading the code.
 *
 * The call surface below has now been checked against the installed SDK — `create`, `fs.uploadFile`,
 * `fs.downloadFile`, `process.executeCommand`, `getPreviewLink` and `delete` all exist as used. The
 * comment that previously stood here asked the reader to confirm those names against a working
 * client, which was an honest warning that nobody had.
 */
const DAYTONA_PKG = "@daytona/sdk";

/**
 * Exported so `sandbox-lifecycle.test.ts` can assert the invariant against `maxRuntimeCeilingS`
 * rather than grep this file for a number. The reasoning is at the `acquire` call site.
 */
export const SANDBOX_LIFECYCLE = {
  autoStopInterval: 60,
  /** Deleted by Daytona the moment it stops, whatever happened to the process that made it. */
  autoDeleteInterval: 0,
  /** Unconditional wall-clock destroy — reaches the archived state that auto-delete cannot. */
  ttlMinutes: 300,
} as const;

/**
 * ═══ THE IDLE WINDOW IS WHAT AN ORPHAN COSTS ═══
 *
 * `autoStopInterval` was a flat 60 for every run, and the reasoning was sound for the run it was
 * written about: `mycel-build` blocks for minutes at a time without touching the toolbox API, which
 * is indistinguishable from inactivity from Daytona's side, so a short window would end real work.
 *
 * The bill says what the flat hour costs. Fourteen days of production: 396 runs orphaned by a
 * kernel restart and 510 killed by a 504, each holding a 10 GiB box until the idle timer fired.
 * 870 and 511 sandbox-hours respectively — together 94% of every sandbox-hour we paid for, on runs
 * that were already dead. Disk is 80% of the Daytona invoice.
 *
 * So the window is derived from the run's own budget instead of being one number for everything. A
 * run cannot legitimately be idle for longer than the entire time it is allowed to take: if
 * `max_runtime_s` has elapsed with no activity, the kernel would have killed it anyway. That is a
 * bound the work itself proves, not a guess about how quiet a build gets.
 *
 * Floored at 15 minutes so a short run still tolerates a genuinely quiet stretch, and capped at the
 * old 60 so nothing that works today gets a shorter window than it had. `mycel-build` runs on a
 * 3600s budget and keeps its full hour.
 *
 * This is NOT the safety net. `autoDeleteInterval: 0` and `ttlMinutes: 300` are, and neither
 * changes. This only decides how long a dead box is billed before the net catches it.
 */
export const IDLE_FLOOR_MINUTES = 15;

export function idleMinutesFor(maxRuntimeS: number | undefined): number {
  if (!Number.isFinite(maxRuntimeS) || (maxRuntimeS ?? 0) <= 0) return SANDBOX_LIFECYCLE.autoStopInterval;
  const fromBudget = Math.ceil((maxRuntimeS as number) / 60);
  return Math.min(SANDBOX_LIFECYCLE.autoStopInterval, Math.max(IDLE_FLOOR_MINUTES, fromBudget));
}
// Matches WORKDIR in sandbox.snapshot.ts. Both must move together.
/**
 * Where a run lives. Exported because `buildAgentsMd` has to TELL the agent this — a model that does
 * not know its root searches from `/`, which on this image does not come back. See the glob note in
 * runtime.ts.
 */
export const SANDBOX_HOME = "/root";
const HOME = SANDBOX_HOME;
/**
 * ═══ A TIMEOUT ARGUMENT THE IMPLEMENTATION DROPPED ═══
 *
 * `Sandbox.exec` declares `exec(command: string, timeoutMs?: number)`. `DaytonaSandbox.exec`
 * implemented `async exec(command: string)`. TypeScript permits an implementation with fewer
 * parameters than its interface, so this compiled — and every one of the ten call sites passing a
 * timeout (`workspace.ts` alone passes 300_000 for a build, 60_000, 30_000) silently discarded it.
 * `spawn` and `previewUrl` had no bound at all.
 *
 * It cost an hour a run. `books-keeper/monthly_close` died eight times in one day at EXACTLY 60
 * minutes with a Daytona 504 and $0 spent — the whole `max_runtime_s: 3600` budget consumed inside
 * `start_opencode`, model never reached. The stall watchdog could not help: it lives inside
 * `for await (const ev of stream)` and at that point there is no stream.
 *
 * THE SERVER-SIDE TIMEOUT ALONE IS NOT ENOUGH, which is why there are two here. Daytona's
 * `executeCommand` takes a timeout in SECONDS and applies it inside the sandbox — useless when the
 * HTTP call itself hangs, which is exactly what a 504 after sixty minutes means. `withDeadline`
 * bounds OUR side. It cannot cancel the request in flight; it returns control to the run, which is
 * the whole point — fail in seconds with a reason instead of burning the budget in silence.
 */
export const DAYTONA_DEADLINES: Record<
  "exec" | "spawn" | "previewUrl" | "writeFile" | "readFile" | "destroy" | "acquire",
  number
> = {
  /** A short command. Callers with real work to do (a build, a tarball) pass their own, larger. */
  exec: 300_000,
  /** Fire-and-forget: `cmd &` returns as soon as the shell forks. A minute is already generous. */
  spawn: 60_000,
  /** A metadata lookup against the control plane. */
  previewUrl: 30_000,
  /**
   * File transfer. These were the miss in the first pass: the commit claimed "every Daytona call"
   * and bounded three of seven. `runtime.ts` uploads sixteen files inside `start_opencode` — the
   * exact step whose hang started all of this — so leaving `writeFile` unbounded left the door open
   * on the very phase being fixed.
   */
  writeFile: 120_000,
  readFile: 120_000,
  /** Teardown. Unbounded, this holds a worker slot open on a sandbox that is already finished. */
  destroy: 60_000,
  /** Provisioning. Daytona's own create is slow; generous, and still not "forever". */
  acquire: 300_000,
};

/**
 * Bound a promise. Rejects with a message naming the call, because "the run failed" is the failure
 * this exists to prevent.
 *
 * The timer is cleared on every path. A naive `Promise.race` leaves one live handle per call, which
 * at a sandbox every five minutes is a slow leak and in a test runner is a hang.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`daytona ${label} timed out after ${ms}ms — the call never returned`)),
      ms,
    );
  });
  return Promise.race([p, bound]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export class DaytonaSandbox implements Sandbox {
  id = "";
  // Untyped: the concrete SDK shape lives at the integration boundary, not in our core.
  private sb: any;

  /**
   * Create a sandbox, from our snapshot by default.
   *
   * `client.create` is overloaded in the SDK: `CreateSandboxFromSnapshotParams` ({ snapshot }) and
   * `CreateSandboxFromImageParams` ({ image }). We take the snapshot branch unless someone has
   * explicitly named an image, because the image branch makes Daytona build a snapshot from that
   * image on the spot — per sandbox, on the task's clock — whereas a named snapshot is already
   * built and pre-pulled onto the runners. `ensureSnapshot` is memoised and normally resolves
   * instantly, having been warmed by `sandboxPreflight` at boot.
   */
  static async acquire(
    opts: { image?: string; envVars?: Record<string, string>; idleMinutes?: number } = {},
  ): Promise<DaytonaSandbox> {
    const self = new DaytonaSandbox();
    const mod: any = await import(DAYTONA_PKG);
    const client = new mod.Daytona({ apiKey: process.env.DAYTONA_API_KEY });
    /**
     * ═══ A SANDBOX NOBODY DELETES IS A SANDBOX THAT LIVES FOREVER ═══
     *
     * `destroy()` below calls `sb.delete()`, and the orchestrator calls `destroy()`. That is the
     * happy path, and it is the ONLY path that ever deleted anything — so cleanup depended on this
     * process surviving the run.
     *
     * It frequently does not. A deploy replaces the container mid-run, the stall watchdog kills a
     * silent agent, Daytona 504s on the call we were awaiting. Every one of those orphans a sandbox
     * that `destroy()` never reaches.
     *
     * Daytona's default for `autoDeleteInterval` is DISABLED. Its default `autoArchiveInterval` is
     * seven days. So an orphan was archived and then kept, and an archived sandbox still counts
     * against the organisation's disk quota. At 10 GiB each and one sandbox every five minutes
     * around the clock, that is a leak with a deadline.
     *
     * It had already landed. Production was holding 100+ sandboxes claiming over 1,000 GiB against
     * a 300 GiB quota, and the resulting `Total disk limit exceeded` failed the creation of new
     * sandboxes — which orphaned more of them. In the 24 hours before this was found, 361 of 470
     * tasks failed. The three top causes were all this cascade wearing different hats: the quota
     * error itself, the 504s from a control plane under retry pressure, and snapshot builds that
     * could not allocate.
     *
     * So the lifecycle no longer depends on us:
     *
     *   · `autoDeleteInterval: 0` — deleted by Daytona the moment it stops, whatever happened to
     *     the process that made it. This is the fix; the rest is belt and braces.
     *   · `ttlMinutes: 300` — an unconditional wall-clock destroy that applies "even if it is
     *     stopped, paused, or archived", which is the one state auto-delete cannot reach. Five
     *     hours is deliberately far above `maxRuntimeCeilingS` (three hours, config.ts): the kernel
     *     kills the longest legal run two hours before this can fire, so it can only ever catch
     *     something already abandoned. It must never be the thing that ends real work.
     *
     * `autoStopInterval` stays at 60. Lowering it looks like it would shrink the orphan window, and
     * it would also end a legitimately long, quiet run — a `mycel-build` blocks for minutes at a
     * time without touching the toolbox API, which is indistinguishable from inactivity from
     * Daytona's side. The stall watchdog is what judges silence; it knows the difference.
     */
    const base = {
      envVars: opts.envVars ?? {},
      ...SANDBOX_LIFECYCLE,
      // Overrides the constant deliberately and only downward — see `idleMinutesFor`.
      ...(opts.idleMinutes ? { autoStopInterval: opts.idleMinutes } : {}),
    };
    self.sb = await withDeadline(
      opts.image
        ? client.create({ ...base, image: opts.image })
        : ensureSnapshot().then((snapshot: string) => client.create({ ...base, snapshot })),
      DAYTONA_DEADLINES.acquire,
      "acquire",
    );
    self.id = self.sb.id;
    return self;
  }

  /**
   * Absolute path inside the microVM.
   *
   * The runtime addresses files the way a shell would — `~/.config/opencode/opencode.json`,
   * `AGENTS.md`, `knowledge/x.md`. LocalSandbox expands `~` into its temp home and DockerSandbox
   * maps it to /root; this class did neither and handed the string straight to `fs.uploadFile`, so
   * the config landed under a directory literally named `~`.
   *
   * OpenCode therefore never read it, the `mycel` provider it declares did not exist, and every run
   * died with `ProviderModelNotFoundError: providerID "mycel", suggestions: []` — an error that
   * reads like a wrong model name and is really a file in the wrong place. Relative paths get the
   * home directory too, because that is where `opencode serve` runs.
   */
  private abs(p: string): string {
    if (p.startsWith("/")) return p;
    return `${HOME}/${p.replace(/^~\/?/, "")}`;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await withDeadline(
      this.sb.fs.uploadFile(Buffer.from(content), this.abs(path)),
      DAYTONA_DEADLINES.writeFile,
      "writeFile",
    );
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const b = await withDeadline<{ toString(enc: string): string } | string>(
        this.sb.fs.downloadFile(this.abs(path)),
        DAYTONA_DEADLINES.readFile,
        "readFile",
      );
      return typeof b?.toString === "function" ? b.toString("utf8") : String(b);
    } catch {
      return null;
    }
  }

  async spawn(command: string): Promise<void> {
    /**
     * ═══ THE GROUP IS REDIRECTED, NOT JUST THE LAST COMMAND ═══
     *
     * This sent `${command} &` and it hung — every time, for the whole of `max_runtime_s`, on every
     * agent run this product has ever attempted in production. It is the cause of the sixty-minute
     * `start_opencode` timeouts, and it is one pair of brackets.
     *
     * The command handed in is an AND-list:
     *
     *     set -a && . envFile && set +a && rm -f envFile && opencode serve … > /tmp/opencode.log 2>&1
     *
     * `&` binds looser than `&&`, so bash backgrounds the WHOLE list as a subshell — and the
     * redirection binds only to `opencode serve`. The subshell's own stdout and stderr are still the
     * exec session's, and the subshell does not exit until opencode does. Daytona's
     * `executeCommand` waits for EOF on those streams, so it waits for a server designed never to
     * stop.
     *
     * opencode was never the problem. Measured against a live sandbox: the server starts and answers
     * 200 on its port in every variant — including the broken one. Only the API call hangs.
     *
     * Wrapping the whole list in `( … )` and redirecting THAT closes the session's streams
     * immediately. Verified on a real sandbox: the current form times out at 20s, the wrapped form
     * returns in 0.1s, and both leave a healthy server listening.
     *
     * The caller's own `> /tmp/opencode.log 2>&1` still applies to opencode and is still where a
     * failed boot is read from; the outer redirect only detaches the group.
     */
    await withDeadline(
      this.sb.process.executeCommand(`( ${command} ) > /dev/null 2>&1 &`),
      DAYTONA_DEADLINES.spawn,
      "spawn",
    );
  }

  async exec(command: string, timeoutMs = DAYTONA_DEADLINES.exec): Promise<ExecResult> {
    // Both bounds. The SDK's is in SECONDS and kills the command inside the sandbox; ours returns
    // control to the run when the HTTP call itself hangs. Only the second one saves the budget.
    // Typed at the boundary: `this.sb` is deliberately `any` (the SDK shape lives at the
    // integration edge), so without this the generic infers `unknown` and the reads below fail.
    const r = await withDeadline<{ result?: string; stdout?: string; stderr?: string; exitCode?: number }>(
      this.sb.process.executeCommand(command, undefined, undefined, Math.ceil(timeoutMs / 1000)),
      timeoutMs,
      "exec",
    );
    return { stdout: r.result ?? r.stdout ?? "", stderr: r.stderr ?? "", code: r.exitCode ?? 0 };
  }

  async previewUrl(port: number): Promise<{ url: string; token?: string }> {
    const p = await withDeadline<{ url: string; token?: string }>(
      this.sb.getPreviewLink(port),
      DAYTONA_DEADLINES.previewUrl,
      "previewUrl",
    );
    return { url: p.url, token: p.token };
  }

  async destroy(): Promise<void> {
    try {
      await withDeadline(this.sb.delete(), DAYTONA_DEADLINES.destroy, "destroy");
    } catch {
      /* noop — and now it gives up rather than holding the worker on a finished sandbox. */
    }
  }
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function dockerExec(args: string[], input?: string, timeoutMs = 60000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "docker",
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// Local Docker container running the Mycel sandbox image (which bakes the `opencode` binary).
// The "local Docker thing": isolation without a Daytona account. Same image ships to Daytona.
export class DockerSandbox implements Sandbox {
  id = "";
  private hostPort = 0;
  /** inner port → published host port. The opencode port and the preview port both live here. */
  private portMap = new Map<number, number>();
  private constructor(
    private image: string,
    private innerPort: number,
  ) {}

  static async acquire(image: string, innerPort: number): Promise<DockerSandbox> {
    const self = new DockerSandbox(image, innerPort);
    // Publish BOTH the opencode control port and the preview dev-server port. Docker cannot map a
    // port after the container exists, and the live preview (see runtime.ts `startPreview`) needs
    // the host to reach PREVIEW_PORT inside the container — without this line the docker backend
    // could never serve a live preview at all.
    const run = await dockerExec([
      "run",
      "-d",
      "-p",
      `127.0.0.1::${innerPort}`,
      "-p",
      `127.0.0.1::${PREVIEW_PORT}`,
      image,
      "sleep",
      "infinity",
    ]);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
    self.id = run.stdout.trim();
    for (const p of [innerPort, PREVIEW_PORT]) {
      const portq = await dockerExec(["port", self.id, String(p)]);
      const host = Number(portq.stdout.trim().split("\n")[0]?.split(":").pop());
      if (Number.isFinite(host) && host > 0) self.portMap.set(p, host);
    }
    self.hostPort = self.portMap.get(innerPort) ?? 0;
    return self;
  }

  private containerPath(path: string): string {
    return "/" + path.replace(/^~\/?/, "root/").replace(/^\//, "");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.containerPath(path);
    await dockerExec(["exec", this.id, "mkdir", "-p", target.replace(/\/[^/]*$/, "")]);
    await dockerExec(
      ["exec", "-i", this.id, "bash", "-lc", `cat > ${shellQuote(target)}`],
      content,
    );
  }

  async readFile(path: string): Promise<string | null> {
    const r = await dockerExec(["exec", this.id, "cat", this.containerPath(path)]);
    return r.code === 0 ? r.stdout : null;
  }

  async spawn(command: string): Promise<void> {
    await dockerExec(["exec", "-d", this.id, "bash", "-lc", command]);
  }

  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return dockerExec(["exec", this.id, "bash", "-lc", command], undefined, timeoutMs);
  }

  async previewUrl(port: number): Promise<{ url: string; token?: string }> {
    // Honour the asked-for port when it was published at acquire time (opencode, preview); fall
    // back to the primary mapping for anything else, which preserves the old behaviour for callers
    // that never cared which port they got.
    return { url: `http://127.0.0.1:${this.portMap.get(port) ?? this.hostPort}` };
  }

  async destroy(): Promise<void> {
    await dockerExec(["rm", "-f", this.id]);
  }
}

// Config-driven backend selection. Add a backend by implementing Sandbox and adding a case.
export async function createSandbox(opts: { maxRuntimeS?: number } = {}): Promise<Sandbox> {
  const cfg = loadConfig();
  switch (cfg.sandboxBackend) {
    case "daytona":
      // Note `sandboxImageOverride`, not `sandboxImage`: undefined unless MYCEL_SANDBOX_IMAGE was
      // actually set, so the default path is the snapshot rather than a docker-only image name.
      return DaytonaSandbox.acquire({
        image: cfg.sandboxImageOverride,
        idleMinutes: idleMinutesFor(opts.maxRuntimeS),
      });
    case "docker":
      return DockerSandbox.acquire(cfg.sandboxImage, cfg.opencodePort);
    case "local":
    default:
      return new LocalSandbox();
  }
}

/**
 * Can the configured sandbox backend actually be used?
 *
 * Called at boot so a missing backend is a startup failure rather than a per-task one. The
 * difference is not cosmetic. When `@daytona/sdk` was absent the kernel started cleanly, reported
 * healthy to its load balancer, accepted tasks, and failed every one of them at the moment of
 * sandbox creation — so the fleet looked green while the product could not do any work at all. A
 * dependency that is only exercised on the request path is a dependency you find out about from a
 * customer.
 *
 * Returns null when fine, or a human-readable reason. The caller decides how loud to be; `daytona`
 * without the SDK is fatal, because the alternative is accepting work we know will fail.
 */
/**
 * Can the sandbox call BACK?
 *
 * The same lesson as the missing SDK, one layer out. A Daytona microVM is a different machine on a
 * different network; `MYCEL_PUBLIC_URL` is the only thing that tells the runtime what address to
 * bake into `MYCEL_GATE_URL`, `MYCEL_ACTIONS_URL`, `MYCEL_READS_URL`, `MYCEL_CASE_URL`,
 * `MYCEL_WORKFLOWS_URL`, `MYCEL_PACKS_URL`, `MYCEL_BATCHES_URL`, `MYCEL_GAPS_URL`, `MYCEL_RECORDS_URL` and — in proxy mode — the model
 * base URL. Left at its default, every one of those is `http://127.0.0.1:4000`, which inside the
 * microVM is the microVM. Nothing listens there.
 *
 * The failure that produces is the worst kind available: the kernel boots, answers /health, passes
 * its load-balancer check, accepts tasks, and each task dies at its first callback — the agent
 * cannot ask for approval, cannot send anything, and in proxy mode cannot even reach a model. The
 * fleet is green and the product does no work. Exactly the shape of the missing-SDK bug, and it
 * survived for the same reason: nothing on the boot path had an opinion about it.
 *
 * Split out from the async preflight below and kept synchronous on purpose, so `index.ts` can run
 * it BEFORE binding the port. The SDK/snapshot checks can take minutes on a cold snapshot build and
 * must not hold the listener closed; this one is a string comparison.
 *
 * Not fatal for `local` or `docker`: on a laptop the loopback default is the correct answer, and
 * the docker backend publishes the sandbox port onto the host's loopback anyway.
 */
export function sandboxReachability(backend: string, publicUrl: string): string | null {
  if (backend !== "daytona") return null;
  if (reachableFromOtherHosts(publicUrl)) return null;
  const shown = (publicUrl ?? "").trim() || "<unset>";
  return (
    `sandbox backend "daytona" is selected but MYCEL_PUBLIC_URL is ${shown} — an address that ` +
    `means "this machine". A Daytona sandbox is not this machine, so every callback the runtime ` +
    `injects (gate, actions, reads, case, workflows, packs, batches, gaps, records, and the model proxy) would ` +
    `resolve inside the sandbox itself. Set MYCEL_PUBLIC_URL to a hostname the sandbox can reach ` +
    `(in the AWS stack: https://sandbox.<domain>, see infra/sandbox.tf).`
  );
}

export async function sandboxPreflight(backend: string): Promise<string | null> {
  if (backend !== "daytona") return null;
  // First, because it is free and because a harness the sandbox cannot call back is just as
  // unusable as a harness with no SDK — and far less obvious from the outside.
  const unreachable = sandboxReachability(backend, loadConfig().publicUrl);
  if (unreachable) return unreachable;
  try {
    await import(DAYTONA_PKG);
  } catch (e) {
    return `sandbox backend "daytona" is selected but ${DAYTONA_PKG} is not installed (${(e as Error).message})`;
  }
  if (!process.env.DAYTONA_API_KEY) {
    return `sandbox backend "daytona" is selected but DAYTONA_API_KEY is not set`;
  }

  // An explicit image is the founder's problem, not ours — we cannot check a registry we may have no
  // credentials for, and someone who set MYCEL_SANDBOX_IMAGE has said they know what is there.
  if (loadConfig().sandboxImageOverride) return null;

  // Build (or find) the snapshot HERE, at boot, not on the first task.
  //
  // This is the same lesson as the missing SDK one directory up: an image that does not exist is a
  // per-task failure that leaves the fleet looking green. It is also slow — a first build is
  // minutes — and paying that once during a deploy is right, while paying it inside a customer's
  // task is not. Memoised, so the first task finds it already resolved.
  try {
    await ensureSnapshot();
  } catch (e) {
    return (
      `sandbox backend "daytona" is selected but its snapshot ${snapshotName()} could not be ` +
      `built or found (${(e as Error).message})`
    );
  }

  // Sweep orphaned sandboxes. Not awaited: a slow provider must not hold up boot.
  void reapStoppedSandboxes().catch(() => {});
  return null;
}

/**
 * Archive every sandbox that is merely STOPPED, at boot.
 *
 * ── WHY A SWEEP AND NOT A `finally` ───────────────────────────────────────────────────────────
 *
 * `DaytonaSandbox.destroy()` already deletes the sandbox, and the orchestrator already calls it.
 * That is enough for every run that ENDS. It is worth nothing for a run that is KILLED, and this
 * kernel is killed routinely: every deploy replaces the task, and each replacement interrupts
 * whatever was mid-flight — fifteen runs died that way in a single day, each one saying "the sandbox
 * it was working in went with it". No `finally` block, no signal handler and no amount of care in
 * the run path survives a SIGKILL, so cleanup cannot live only inside the process that leaks.
 *
 * What those orphans do is not obvious until it stops production dead. An abandoned sandbox
 * auto-stops on its idle timer and then sits at 10GiB forever. Twenty-eight of them reached exactly
 * the 300GiB organisation cap, and the next build failed with `Total disk limit exceeded` — an error
 * that names a quota and says nothing about the eight deploys that caused it.
 *
 * ── ARCHIVE, NOT DELETE ───────────────────────────────────────────────────────────────────────
 *
 * Archiving frees the disk quota and is reversible; the provider's own error message recommends it.
 * Deleting an orphan would be irreversible cleanup performed automatically at boot on state we did
 * not fully identify, which is the wrong default for a sweep nobody is watching.
 *
 * ── WHY `stopped` IS SAFE TO TOUCH AND `started` IS NOT ───────────────────────────────────────
 *
 * A live run holds a STARTED sandbox — those are never touched here, which is what makes it safe to
 * run this while other builds are in flight. `stopped` means the idle timer already fired, so
 * nothing has been talking to it for at least the auto-stop interval. A run that is merely slow is
 * still `started`.
 */
/**
 * ═══ WHY THIS IS EXPORTED, AND RUNS ON A CLOCK RATHER THAN ONLY AT BOOT ═══
 *
 * It used to run once, from `sandboxPreflight`, and the log line below said "at boot" because that
 * was the truth. The comment under it gave the game away: "a number that climbs every deploy is the
 * signal that something in the run path has started leaking, and it is invisible until the quota is
 * hit." Between deploys — which can be a week — nothing swept, so a leak had a week to run.
 *
 * `kortix-ai/suna` document what that costs in `projects/disk-quota-guard.ts`. Their org rode its
 * 40000GiB sandbox-disk quota to the edge because stopped boxes only left disk on the provider's own
 * auto-archive timer, and then "EVERY session create/resume org-wide failed with
 * `DaytonaValidationError: Total disk limit exceeded`" until a human spent twenty minutes archiving
 * the 1300 oldest by hand.
 *
 * The whole failure is that nobody was sweeping in between. Same clock as the snapshot recheck in
 * index.ts, and for the same reason: the expensive part of an outage like this is not the repair, it
 * is the hours before anyone knows.
 */
/**
 * ═══ DELETE ONE SANDBOX WE KNOW WE ORPHANED ═══
 *
 * `reapStoppedSandboxes` is the SWEEP: it runs on a clock, cannot tell our dead boxes from another
 * project's except by snapshot prefix, and will only touch `stopped` — because a `started` box may
 * be a slow run and deleting it would kill real work.
 *
 * This is the opposite case and it is why the sweep cannot cover it. `recovery.ts` knows, by name,
 * that a specific task was interrupted by our own restart. That box is `started`, nothing is driving
 * it, and no sweep will touch it until its idle timer fires and Daytona's auto-delete catches it —
 * which is where 870 of the fortnight's sandbox-hours went.
 *
 * Named, not swept. We delete exactly the id we wrote down when we created it, and only for a task
 * we have already marked failed.
 *
 * Returns whether the box is gone. A 404 counts: the thing we wanted not to exist does not exist,
 * and reporting that as a failure would make the log lie about a leak that is not there.
 */
export async function deleteSandboxById(id: string): Promise<boolean> {
  const key = process.env.DAYTONA_API_KEY;
  if (!key || !id) return false;
  const api = process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api";
  const res = await fetch(`${api}/sandbox/${encodeURIComponent(id)}?force=true`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${key}` },
  }).catch(() => null);
  return res?.ok === true || res?.status === 404;
}

export async function reapStoppedSandboxes(): Promise<void> {
  const key = process.env.DAYTONA_API_KEY;
  if (!key) return;
  const api = process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api";
  const headers = { authorization: `Bearer ${key}` };

  /**
   * ═══ IT ARCHIVED, WHICH IS NOT WHAT IT WAS FOR ═══
   *
   * This function existed to stop `Total disk limit exceeded`, ran on a clock to catch leaks
   * between deploys, and cited the suna outage above. It then POSTed `/archive`.
   *
   * Archiving is a state change, not a deletion. So the sweep ran, logged a healthy number, and
   * left every byte where it was — which is exactly what the account looked like when this was
   * found: 508 archived, 17 started, and ZERO stopped. Perfect operation of the wrong verb. The
   * count it prints, the one described as "the signal that something in the run path has started
   * leaking", was counting its own output.
   *
   * Whether an archived sandbox bills against the quota is not something this code can see from
   * outside, and it does not need to: a sandbox nothing will ever attach to again should not exist
   * in any state. Nothing reattaches — no sandbox id is persisted against a task, and `acquire()`
   * always creates fresh — so deleting is strictly better than archiving, for both.
   *
   * `started` is still never touched. A live run holds a started sandbox, and a run that is merely
   * slow is still started. That is what makes this safe to run against a working fleet.
   *
   * With `autoDeleteInterval: 0` on every new sandbox this is now a BACKSTOP rather than the
   * mechanism — Daytona deletes on stop without being asked. It stays because the sandboxes that
   * predate that setting have to go somewhere, and because a second line of defence against this
   * particular failure has already earned its place once.
   */
  const list = async (): Promise<{ id?: string; state?: string; snapshot?: string }[]> => {
    const out: { id?: string; state?: string; snapshot?: string }[] = [];
    let cursor: string | undefined;
    // Paginated, and it was not read that way. The first page is 100 rows; the account held 532.
    for (let page = 0; page < 25; page++) {
      const url = cursor ? `${api}/sandbox?cursor=${encodeURIComponent(cursor)}` : `${api}/sandbox`;
      const res = await fetch(url, { headers }).catch(() => null);
      if (!res?.ok) break;
      const body = (await res.json().catch(() => null)) as
        | { items?: unknown[]; nextCursor?: string }
        | unknown[]
        | null;
      if (!body) break;
      const items = (Array.isArray(body) ? body : (body.items ?? [])) as typeof out;
      out.push(...items);
      cursor = Array.isArray(body) ? undefined : body.nextCursor;
      if (!cursor) break;
    }
    return out;
  };

  const all = await list();
  /**
   * Ours only, by snapshot prefix. The organisation is shared with other projects, and an archived
   * sandbox belonging to one of those is equally dead but is not this process's to delete.
   */
  const dead = all.filter(
    (s) =>
      s.id &&
      (s.state === "stopped" || s.state === "archived" || s.state === "error") &&
      (s.snapshot ?? "").startsWith(SNAPSHOT_PREFIX),
  );
  if (dead.length === 0) return;

  let deleted = 0;
  for (const s of dead) {
    const r = await fetch(`${api}/sandbox/${s.id}?force=true`, { method: "DELETE", headers }).catch(
      () => null,
    );
    if (r?.ok) deleted++;
  }
  // Logged rather than silent: a number that keeps climbing sweep after sweep is the signal that
  // something in the run path has started leaking, and it is invisible until the quota is hit.
  console.log(`[sandbox] deleted ${deleted}/${dead.length} dead sandbox(es)`);
}
