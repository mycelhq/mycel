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
import { loadConfig } from "./config";

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

// Minimal environment for the agent process. Critically, we do NOT spread process.env — the
// harness holds provider keys, the DB URL, the Daytona key, Langfuse keys, etc., and a
// prompt-injected or misbehaving agent must not be able to `printenv` them out. Everything the
// run legitimately needs (provider creds in native mode, gate token, proxy nonce) is injected
// per-command by the runtime, not inherited here. NOTE: LocalSandbox shares the host kernel and
// is a DEV backend, not a security boundary — use docker/daytona for real isolation.
function minimalSandboxEnv(home: string): NodeJS.ProcessEnv {
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

// Daytona-backed sandbox. The SDK is imported dynamically so the harness core has no hard
// dependency on it — install `@daytonaio/sdk` to use. The SDK call surface below mirrors
// the Daytona SDK; confirm the exact TS method names against your working
// client when you wire real credentials.
export class DaytonaSandbox implements Sandbox {
  id = "";
  // Untyped: the concrete SDK shape lives at the integration boundary, not in our core.
  private sb: any;

  static async acquire(
    opts: { image?: string; envVars?: Record<string, string> } = {},
  ): Promise<DaytonaSandbox> {
    const self = new DaytonaSandbox();
    const pkg = "@daytonaio/sdk";
    const mod: any = await import(pkg);
    const client = new mod.Daytona({ apiKey: process.env.DAYTONA_API_KEY });
    // : CreateSandboxFromImageParams({ image, envVars, autoStopInterval: 60 })
    self.sb = await client.create({
      image: opts.image ?? process.env.MYCEL_SANDBOX_IMAGE,
      envVars: opts.envVars ?? {},
      autoStopInterval: 60,
    });
    self.id = self.sb.id;
    return self;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sb.fs.uploadFile(Buffer.from(content), path);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const b = await this.sb.fs.downloadFile(path);
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
      return DaytonaSandbox.acquire({ image: cfg.sandboxImage });
    case "docker":
      return DockerSandbox.acquire(cfg.sandboxImage, cfg.opencodePort);
    case "local":
    default:
      return new LocalSandbox();
  }
}
