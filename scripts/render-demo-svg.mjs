// Draw the README's hero from a real `npm run demo`, so the picture cannot drift from the product.
//
// ═══ WHY THIS EXISTS ═══
//
// The README's hero was a GIF of the hosted console, filmed against a seed that no longer exists —
// "Ridgeline Books", "Harborline Ceramics", founder@ridgeline.example — none of which `demo:seed`
// has produced since it was renamed. It also showed a UI that IS NOT IN THIS REPOSITORY. For a
// project whose entire claim is that its claims are checkable, the first image on the page was
// neither current nor available.
//
// A headless kernel's honest hero is its terminal. This runs the demo, captures what it prints, and
// renders exactly those bytes. Regenerate with:
//
//     node scripts/render-demo-svg.mjs
//
// ═══ AN IMAGE, NOT A RECORDING ═══
//
// A cast or a GIF would need a player, a recorder, and a binary blob nobody can diff. An SVG of the
// final frame is text: it renders on GitHub, it is greppable, and a reviewer can see in the diff
// that the numbers changed. `harness/test/hero-is-current.test.ts` fails if it stops matching what
// the demo prints.
//
// ═══ THE COLOURS ARE THE TERMINAL'S, NOT A THEME ═══
//
// `demo.ts` emits ANSI and this maps those codes; it does not re-decide what is bold or dim. If the
// renderer there changes, this follows automatically, which is the point of capturing rather than
// reimplementing.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../design/brand/demo.svg", import.meta.url));

/** Where the payoff starts. Everything before it is the boot banner, which has its own place. */
const FROM = "RANKED NEXT MOVES";
/** Stop before the footer's URLs — the image is the ranking, the README says the rest in text. */
const UNTIL = "That order came from the seeded state";

/**
 * How much of the ranking the image shows.
 *
 * All five detailed moves is 46 lines and a 996px-tall image, which on a README is a wall you
 * scroll past rather than a picture you read. Two moves and their arithmetic is the argument; the
 * rest is what you get by running it.
 */
const MAX_LINES = 24;

const FG = "#c9d1d9";
const BG = "#0d1117";
const GREEN = "#3fb950";
const DIM = "#6e7681";
const CHAR_W = 8.4;
const LINE_H = 20;
const PAD = 24;

/** Run the demo with colour forced, and return its output up to the payoff. */
async function capture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "harness/scripts/demo.ts"], {
      cwd: ROOT,
      env: { ...process.env, MYCEL_FORCE_COLOR: "1", PORT: process.env.PORT ?? "4000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const done = (fn, v) => {
      child.kill("SIGTERM");
      fn(v);
    };
    child.stdout.on("data", (d) => {
      out += d.toString();
      // The demo holds the foreground on purpose, so stop as soon as the part we draw has arrived.
      if (out.includes(UNTIL)) done(resolve, out);
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) =>
      out.includes(UNTIL) ? resolve(out) : done(reject, new Error(`demo exited ${code} before printing the ranking\n${err}${out}`)),
    );
    setTimeout(() => done(reject, new Error(`the demo did not print "${UNTIL}" within 90s`)), 90_000);
  });
}

/** ANSI → runs of {text, fill, bold}. Only the codes demo.ts emits; anything else is dropped. */
function parse(line) {
  const runs = [];
  let fill = FG;
  let bold = false;
  let i = 0;
  for (const m of line.matchAll(/\[(\d+)m/g)) {
    if (m.index > i) runs.push({ text: line.slice(i, m.index), fill, bold });
    const code = m[1];
    if (code === "0") {
      fill = FG;
      bold = false;
    } else if (code === "1") bold = true;
    else if (code === "2") fill = DIM;
    else if (code === "32") fill = GREEN;
    i = m.index + m[0].length;
  }
  if (i < line.length) runs.push({ text: line.slice(i), fill, bold });
  return runs.filter((r) => r.text.length > 0);
}

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(lines) {
  const width = Math.max(...lines.map((l) => l.replace(/\[\d+m/g, "").length));
  const w = Math.ceil(width * CHAR_W + PAD * 2);
  const h = lines.length * LINE_H + PAD * 2 + 28;

  const body = lines
    .map((line, row) => {
      let col = 0;
      const spans = parse(line)
        .map((r) => {
          const x = PAD + col * CHAR_W;
          col += r.text.length;
          const weight = r.bold ? ' font-weight="600"' : "";
          return `<tspan x="${x.toFixed(1)}" fill="${r.fill}"${weight}>${escape(r.text)}</tspan>`;
        })
        .join("");
      // `xml:space="preserve"` or SVG collapses runs of spaces — which silently destroys BOTH the
      // indentation under each move and the column padding that lines the money up. The first
      // render looked like left-aligned prose and the alignment the terminal spent effort on was
      // gone.
      return spans ? `<text xml:space="preserve" y="${PAD + 28 + row * LINE_H}">${spans}</text>` : "";
    })
    .filter(Boolean)
    .join("\n  ");

  // Three dots and a title bar: it reads as a terminal at thumbnail size, which is where most
  // people see it.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13">
  <rect width="${w}" height="${h}" rx="10" fill="${BG}"/>
  <circle cx="20" cy="18" r="5" fill="#ff5f56"/><circle cx="38" cy="18" r="5" fill="#ffbd2e"/><circle cx="56" cy="18" r="5" fill="#27c93f"/>
  <text x="${w / 2}" y="22" fill="${DIM}" font-size="11" text-anchor="middle">npm run demo</text>
  ${body}
</svg>
`;
}

const out = await capture();
const start = out.indexOf(FROM);
if (start === -1) throw new Error(`the demo never printed "${FROM}"`);
// Back up to the rule above the heading so the frame starts on a border rather than mid-block.
const lines = out.slice(0, out.indexOf(UNTIL)).slice(out.lastIndexOf("\n", start - 2) + 1).split("\n");
while (lines.length && !lines.at(-1).trim()) lines.pop();
if (lines.length > MAX_LINES) {
  lines.length = MAX_LINES;
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines.push("", "  \u001b[2m  …and 7 more, with their reasoning, in GET /v1/moves\u001b[0m");
}

writeFileSync(OUT, render(lines));
console.log(`wrote ${OUT} — ${lines.length} lines`);
