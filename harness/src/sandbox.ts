// Where OpenCode runs. Two implementations behind one interface, so the runtime never
// knows which it's talking to:
//   LocalSandbox   — this machine (dev; needs the `opencode` binary + a provider key)
//   DaytonaSandbox — an isolated Daytona microVM (prod; needs DAYTONA_API_KEY)
// Modeled on a create / reuse / preview-link / exec / destroy Daytona lifecycle.
import { execFile, type ChildProcess } from "node:child_process";
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
import { ensureSnapshot, snapshotName } from "./sandbox.snapshot";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

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
    const child = execFile("bash", ["-lc", command], {
      cwd: this.home,
      env: minimalSandboxEnv(this.home),
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

  async destroy(): Promise<void> {
    for (const p of this.procs) {
      try {
        p.kill();
      } catch {
        /* noop */
      }
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
// Matches WORKDIR in sandbox.snapshot.ts. Both must move together.
const HOME = "/root";
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
    opts: { image?: string; envVars?: Record<string, string> } = {},
  ): Promise<DaytonaSandbox> {
    const self = new DaytonaSandbox();
    const mod: any = await import(DAYTONA_PKG);
    const client = new mod.Daytona({ apiKey: process.env.DAYTONA_API_KEY });
    const base = { envVars: opts.envVars ?? {}, autoStopInterval: 60 };
    self.sb = opts.image
      ? await client.create({ ...base, image: opts.image })
      : await client.create({ ...base, snapshot: await ensureSnapshot() });
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
    await this.sb.fs.uploadFile(Buffer.from(content), this.abs(path));
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const b = await this.sb.fs.downloadFile(this.abs(path));
      return typeof b?.toString === "function" ? b.toString("utf8") : String(b);
    } catch {
      return null;
    }
  }

  async spawn(command: string): Promise<void> {
    await this.sb.process.executeCommand(`${command} &`);
  }

  async exec(command: string): Promise<ExecResult> {
    const r = await this.sb.process.executeCommand(command);
    return { stdout: r.result ?? r.stdout ?? "", stderr: r.stderr ?? "", code: r.exitCode ?? 0 };
  }

  async previewUrl(port: number): Promise<{ url: string; token?: string }> {
    const p = await this.sb.getPreviewLink(port);
    return { url: p.url, token: p.token };
  }

  async destroy(): Promise<void> {
    try {
      await this.sb.delete();
    } catch {
      /* noop */
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
  private constructor(
    private image: string,
    private innerPort: number,
  ) {}

  static async acquire(image: string, innerPort: number): Promise<DockerSandbox> {
    const self = new DockerSandbox(image, innerPort);
    const run = await dockerExec([
      "run",
      "-d",
      "-p",
      `127.0.0.1::${innerPort}`,
      image,
      "sleep",
      "infinity",
    ]);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
    self.id = run.stdout.trim();
    const portq = await dockerExec(["port", self.id, String(innerPort)]);
    self.hostPort = Number(portq.stdout.trim().split(":").pop());
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

  async previewUrl(_port: number): Promise<{ url: string; token?: string }> {
    return { url: `http://127.0.0.1:${this.hostPort}` };
  }

  async destroy(): Promise<void> {
    await dockerExec(["rm", "-f", this.id]);
  }
}

// Config-driven backend selection. Add a backend by implementing Sandbox and adding a case.
export async function createSandbox(): Promise<Sandbox> {
  const cfg = loadConfig();
  switch (cfg.sandboxBackend) {
    case "daytona":
      // Note `sandboxImageOverride`, not `sandboxImage`: undefined unless MYCEL_SANDBOX_IMAGE was
      // actually set, so the default path is the snapshot rather than a docker-only image name.
      return DaytonaSandbox.acquire({ image: cfg.sandboxImageOverride });
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
  return null;
}
