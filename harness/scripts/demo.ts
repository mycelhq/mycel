// ONE COMMAND, ONE TERMINAL, AND IT ENDS ON THE THING WORTH LOOKING AT.
//
// ═══ THE FUNNEL THIS REPLACES ═══
//
// Measured on a cold clone of the published tree. To see anything beyond a passing test suite, a
// newcomer had to: run `npm run demo` (which blocks, because it is a server), open a SECOND
// terminal, run `npm run demo:seed`, read a wall of text telling them to curl, do a login-token
// dance with `jq`, and read raw JSON. Four commands, two terminals, and the payoff is a blob.
//
// Every one of those steps is a place to stop. The two-terminal split is also a real trap rather
// than an inconvenience: the seed and the kernel have to agree on `MYCEL_OWNER_EMAIL` and
// `MYCEL_OWNER_PASSWORD`, and somebody who boots the kernel by hand in terminal one gets a
// generated owner and a seed that cannot log in. That happened while writing this.
//
// So: boot, wait, seed, and then PRINT THE RANKED MOVES. The server stays in the foreground
// afterwards, so the thing you just read about is still running and still pokeable.
//
// ═══ WHY THE MOVES AND NOT SOMETHING PRETTIER ═══
//
// It is the one output that is hard to fake and easy to judge. Nine pieces of work, ordered, each
// with the arithmetic that put it there — `money +27.8 · deadline +30 · staleness +20`. A reader
// can disagree with the weights, which is the point: it is a claim about their business, not a
// demo animation. There is no UI in this repo, so if this does not render it in the terminal,
// nothing does.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const KERNEL_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = process.env.PORT ?? "4000";
const BASE = `http://localhost:${PORT}`;

/**
 * The demo identity, in ONE place.
 *
 * `package.json` used to spell these out twice — once on `demo` and once on `demo:seed` — which is
 * exactly what makes the two-terminal flow fragile. One definition, passed to both children.
 */
const DEMO_ENV = {
  MYCEL_RUNTIME: "mock",
  MYCEL_API_KEY: "mycel_demo_key",
  MYCEL_OWNER_EMAIL: "founder@sightlineresearch.example",
  MYCEL_OWNER_PASSWORD: "demo-sightline",
  MYCEL_LOG_DIR: ".mycel/demo-logs",
};

const ESC = "\u001b[";
const paint = (code: string, s: string): string => (process.stdout.isTTY ? `${ESC}${code}m${s}${ESC}0m` : s);
const dim = (s: string): string => paint("2", s);
const bold = (s: string): string => paint("1", s);
const green = (s: string): string => paint("32", s);

function run(args: string[], env: Record<string, string>, quiet = false): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: KERNEL_ROOT,
    env: { ...process.env, ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

/** Up, or a sentence about why not. Never hangs: a demo that sits there is worse than one that fails. */
async function waitForKernel(deadlineMs = 60_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) throw new Error(`the kernel did not answer on ${BASE} within 60s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface Move {
  kind: string;
  entity: { label: string };
  why: string;
  score: number;
  score_terms: Array<{ term: string; points: number }>;
  signals: { money_at_stake?: number; currency?: string; minor_unit_exponent?: number };
  takeable: boolean;
  unavailable_reason?: string;
}

/** Minor units → what a person reads. Divided once, at the last step. See the MONEY comment on `Invoice`. */
export function money(s: Move["signals"]): string {
  if (s.money_at_stake === undefined) return "";
  const exp = s.minor_unit_exponent ?? 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: s.currency ?? "USD",
    minimumFractionDigits: exp,
  }).format(s.money_at_stake / 10 ** exp);
}

const WIDTH = 78;

/** Fit to `n`, with an ellipsis rather than a wrapped column. */
export const clip = (s: string, n: number): string => (s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`);

/**
 * Wrap to the terminal, indented.
 *
 * The reasoning under each move is a whole sentence and some of them are long — the first render of
 * this let `unavailable_reason` run to 240 characters, and a terminal wrapping it at column zero
 * destroyed the alignment of everything below.
 */
export function wrap(text: string, indent: string): string[] {
  const width = Math.max(40, Math.min(process.stdout.columns ?? WIDTH, 100)) - indent.length;
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out;
}

function render(moves: Move[], project: string): void {
  const rule = dim("─".repeat(WIDTH));
  console.log(`\n${rule}`);
  console.log(bold(`  RANKED NEXT MOVES  ${dim("·")}  ${project}`));
  console.log(dim(`  ${moves.length} things to do, in the order the kernel would do them.`));
  console.log(`${rule}\n`);

  // MEASURED, not guessed. Fixed pads were written against the invoice rows and overflowed on
  // "client cannot see it" and on a deliverable title, which pushed the money column out of line
  // on exactly the rows a reader is comparing.
  const verbs = moves.map((m) => m.kind.replace(/_/g, " "));
  const verbW = Math.min(Math.max(...verbs.map((v) => v.length)), 20);
  const labelW = Math.min(Math.max(...moves.map((m) => m.entity.label.length)), 30);

  /**
   * FIVE IN FULL, THE REST AS A LINE EACH.
   *
   * Nine moves at seven lines apiece is sixty-three lines, which scrolls its own heading off the
   * top of the terminal — so the thing a reader would screenshot is the part they never see. The
   * top five carry the argument; the tail exists to show the list does not stop at five.
   */
  const DETAILED = 5;
  let lastReason = "";
  const row = (m: Move, i: number): string =>
    `  ${bold(String(i + 1).padStart(2))}  ${green(m.score.toFixed(1).padStart(5))}  ` +
    `${clip(verbs[i]!, verbW)}  ${clip(m.entity.label, labelW)}  ${money(m.signals).padStart(11)}`;

  moves.slice(0, DETAILED).forEach((m, i) => {
    console.log(row(m, i));
    for (const l of wrap(m.why, "        ")) console.log(dim(l));
    if (m.score_terms.length) {
      console.log(dim(`        ${m.score_terms.map((t) => `${t.term} +${t.points}`).join(" · ")}`));
    }
    // The blocked reason is the most useful line here — it is WHY a takeable-looking move is not
    // takeable — and also the longest. Wrapped, and marked so it reads as a state, not a failure.
    // Said once. Three consecutive moves blocked for the identical reason is one fact, and
    // printing it three times makes the reader skim the line that matters most.
    if (!m.takeable && m.unavailable_reason && m.unavailable_reason !== lastReason) {
      for (const l of wrap(`⏸  ${m.unavailable_reason}`, "        ")) console.log(dim(l));
      lastReason = m.unavailable_reason;
    }
    console.log("");
  });

  const rest = moves.slice(DETAILED);
  for (const [j, m] of rest.entries()) console.log(row(m, DETAILED + j));
  if (rest.length) console.log(dim(`\n      …and their reasoning, in GET /v1/moves.`));

  console.log(rule);
  console.log(`  That order came from the seeded state, ${bold("not from a model")}. Every number is in`);
  console.log(`  the API — ${bold("score_terms")} is the arithmetic, so you can argue with the weights.\n`);
  console.log(dim(`  GET  ${BASE}/v1/moves     the same list, as JSON`));
  console.log(dim(`  POST ${BASE}/v1/tasks     take one: send its carrier {wedge, task_type, input}`));
  console.log(dim(`  docs/CONTRACT.md                     the whole surface\n`));
  console.log(`  The kernel is still running on ${bold(BASE)}. ${dim("Ctrl-C to stop.")}\n`);
}

async function main(): Promise<void> {
  const kernel = run(["harness/src/index.ts"], { ...DEMO_ENV, PORT });
  let stopping = false;
  const stop = (code = 0): never => {
    stopping = true;
    kernel.kill("SIGTERM");
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  kernel.on("exit", (code) => {
    // If the kernel dies on its own, say so rather than leaving this process waiting on a seed that
    // can never connect. The most common cause by far is port 4000 already being in use.
    if (!stopping) {
      console.error(`\n  The kernel exited (code ${code}). Is something already on port ${PORT}?`);
      console.error(`  Try: PORT=4001 npm run demo\n`);
      process.exit(code ?? 1);
    }
  });

  await waitForKernel();

  // The seed is chatty and its closing report duplicates, worse, what is about to be rendered.
  // Keep its errors; drop its success noise.
  const seed = run(["harness/scripts/seed-demo.ts"], { ...DEMO_ENV, MYCEL_URL: BASE }, true);
  let seedErr = "";
  seed.stderr?.on("data", (d: Buffer) => (seedErr += d.toString()));
  const seedCode: number = await new Promise((r) => seed.on("exit", (c) => r(c ?? 1)));
  if (seedCode !== 0) {
    console.error(`\n  The demo business could not be seeded.\n${seedErr}`);
    stop(1);
  }

  const login = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: DEMO_ENV.MYCEL_OWNER_EMAIL, password: DEMO_ENV.MYCEL_OWNER_PASSWORD }),
  });
  const session = (await login.json()) as { token?: string; projects?: Array<{ id: string; name: string }> };
  // NOT the first project: the owner also has a `default` one, and the seed writes into the named
  // business. Picking by position is how this would silently render an empty list.
  const project = session.projects?.find((p) => p.name !== "default") ?? session.projects?.[0];
  if (!session.token || !project) {
    console.error("\n  Seeded, but could not read it back — the login returned no project.");
    stop(1);
  }

  const res = await fetch(`${BASE}/v1/moves`, {
    headers: { authorization: `Bearer ${session.token!}`, "x-mycel-project": project!.id },
  });
  const { moves } = (await res.json()) as { moves?: Move[] };
  if (!moves?.length) {
    console.error("\n  Seeded, but /v1/moves returned nothing. That is a bug — please open an issue.");
    stop(1);
  }
  render(moves!, project!.name);

  // Hold the foreground, so the kernel this just described is still there to poke at.
  await new Promise(() => {});
}

/**
 * Only when RUN, never when imported.
 *
 * `harness/test/demo-command.test.ts` imports the formatting helpers above. Without this guard that
 * import would boot a kernel, seed it and hold the process open — the suite would hang rather than
 * fail, which is the worst way for a test to go wrong.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
