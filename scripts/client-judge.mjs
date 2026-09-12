#!/usr/bin/env node
// A CLIENT WHO SEES ONLY WHAT A CLIENT SEES, AND SAYS WHETHER THEY WOULD PAY AGAIN.
//
// ═══ WHY THIS EXISTS ═══
//
// Every quality mechanism in this system judges the work from the INSIDE. `output_schema` checks
// that the fields are present, `ship_requires` that they carry something, `ship_checks` that the
// numbers agree, the exemplars set a bar for depth. All of them are the firm marking its own
// homework, and all of them passed a September close that a client scored 3 out of 10 and said they
// would not pay for again.
//
// The gap they cannot see is the one that matters: not whether the deliverable is well-formed, but
// whether it is the thing the client was buying.
//
// ═══ THE ONE RULE ═══
//
// The judge sees the CLIENT'S VIEW and nothing else — `client_summary` and the headline facts. Not
// the anomalies array, not the internal questions, not the task input, not the transactions. Those
// are the founder's view. A judge given the founder's view marks the firm's reasoning and reports
// that the work is thorough; a judge given the client's view notices there is no profit and loss
// account. The second one is the customer.
//
// ═══ HOW TO READ THE SCORE ═══
//
// It is one model's opinion of one artifact and it is not a benchmark. What it is good for is the
// SPECIFIC complaints — "you say reconciled and show no reconciliation", "that is output VAT, not
// net VAT payable" — each of which is checkable, and several of which turned out to be real gaps in
// our output contract rather than in the writing.
//
//   node scripts/client-judge.mjs <artifact.json> [--persona "..."]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/client-judge.mjs <deliverable.json> [--persona '...']");
  process.exit(1);
}
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error("OPENAI_API_KEY is not set. This calls a model to play the client.");
  process.exit(1);
}
const personaArg = process.argv.indexOf("--persona");
const persona =
  personaArg > 0
    ? process.argv[personaArg + 1]
    : "the owner of a small business who pays this firm a monthly retainer";

const parsed = JSON.parse(readFileSync(file, "utf8"));
/**
 * The client's view, built by REMOVING rather than by selecting.
 *
 * A allowlist would quietly hide a field somebody adds tomorrow, and the failure would look like the
 * client not minding. These four are the founder's working — everything else is what was sent.
 */
const FOUNDER_ONLY = ["anomalies", "questions", "needs", "reasoning"];

/**
 * ═══ JUDGE THE DOCUMENT THAT SHIPS, NOT THE OBJECT THAT PRODUCED IT ═══
 *
 * This was pointed at the run's `result.txt` — the raw output object, minus the founder-only fields.
 * That is not what a client receives. What they receive is the deliverable version's body, which
 * `weekBody` builds: the summary, the recommendations, and the open questions each with what we
 * advise and why.
 *
 * The gap made the judge report a defect that had already been fixed. It read a summary saying
 * "answer the five treatment questions", could not see the five questions — they live under
 * `questions`, which this file strips as the founder's working — and concluded "they say to answer
 * five treatment questions but do not actually ask the five questions". They did. All five were in
 * the delivered body, each with a recommendation and a reason.
 *
 * So a `{covering_note, artifacts}` file is judged as-is: no stripping, because a body assembled for
 * a client has nothing in it that was not meant for them. Pointing this at a raw run output still
 * works and still strips — a wedge with no deliverable wrapper is a real case — but then it is
 * grading the draft, and the line it prints says which.
 */
const isDelivery = typeof parsed.covering_note === "string";
const clientView = isDelivery
  ? parsed
  : Object.fromEntries(Object.entries(parsed).filter(([k]) => !FOUNDER_ONLY.includes(k)));
console.log(`\n  judging: ${isDelivery ? "the delivered document" : "the run's raw output (no delivery wrapper)"}`);

/**
 * ATTACH THE FILES, because a client receives files and not paths.
 *
 * The first version of this passed `artifacts` through as declared — `{kind, name, path}` — and the
 * client's sharpest complaint was "the claimed files are only named by paths; the actual ledger has
 * not been supplied to me". They were right, and about the SIMULATION rather than the product: the
 * run had written the ledger, the judge was shown a filename.
 *
 * A judge shown a path grades the promise. A judge shown the bytes grades the work.
 */
const dir = dirname(file);
for (const a of clientView.artifacts ?? []) {
  if (a?.kind !== "file" || !a.path) continue;
  const candidate = join(dir, a.path);
  a.contents = existsSync(candidate)
    ? readFileSync(candidate, "utf8").slice(0, 8000)
    : "[not supplied to the client — the file was named but never attached]";
}

/**
 * ═══ GIVE THE CLIENT A CALCULATOR, BECAUSE A REAL ONE HAS EXCEL ═══
 *
 * The judge read a sixteen-row ledger, dropped a £32.00 line while adding it up, and reported that
 * the firm's "supposedly exact reconciliation fails against their own ledger" by exactly that £32.
 * Seven of its complaints and four of its open questions were built on that number. The deliverable
 * was right; every figure in it checked out.
 *
 * A judge that fabricates an arithmetic error is worse than no judge: it sends a day into chasing a
 * bug that is not there, and its score stops meaning anything. And the fabrication is not the
 * model being careless — adding sixteen signed integers in your head is a thing people get wrong
 * too, which is exactly why a real client does not do it in their head. They open the file.
 *
 * So the numeric columns are summed here, exactly, and handed over with the file. This is not
 * contaminating the judgement: it is the spreadsheet every actual client has. What the judge does
 * with the totals — whether they match what the covering note claims — is still entirely its call,
 * and that is the question worth asking.
 */
function columnSums(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return "";
  const split = (line) => {
    const out = [];
    let cur = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  /**
   * DATA ROWS ONLY, and this is not a nicety.
   *
   * A close appended its reconciliation arithmetic as two prose lines at the bottom of the ledger.
   * Counting every line made the footer report 19 rows for a 16-row file, and the judge — correctly,
   * given what it was shown — called that "an unexplained contradiction [that] makes me question the
   * reliability of the export". A tool that manufactures the defect it then reports is the failure
   * this footer was added to end, reappearing one level down. A line that does not have the header's
   * columns is not a row of this table.
   */
  const parsedRows = lines.slice(1).map(split);
  const rows = parsedRows.filter((r) => r.length === header.length);
  /**
   * A FILE THAT DOES NOT PARSE GETS SAID SO, NOT SUMMED ANYWAY.
   *
   * Dropping the mismatched rows silently is the failure this footer exists to prevent, one level
   * down. A ledger shipped with `Studio rent, July` unquoted: sixteen transactions, twelve of which
   * had the header's field count. The footer confidently reported "12 rows, total £36,237.23" and the
   * client — reasonably — treated that as the firm's own figure and could not reconcile it to
   * anything. It was mine, computed from a quarter of the file.
   *
   * The malformed rows are the finding. Say that instead of a number.
   */
  if (rows.length !== parsedRows.length) {
    return (
      `\n\nThis file does not parse as CSV: ${parsedRows.length - rows.length} of ` +
      `${parsedRows.length} rows do not have the header's ${header.length} columns, so no totals ` +
      `can be computed from it.`
    );
  }
  const sums = [];
  for (let i = 0; i < header.length; i++) {
    const vals = rows.map((r) => (r[i] ?? "").trim()).filter((v) => v !== "");
    if (!vals.length || !vals.every((v) => /^-?\d+(\.\d+)?$/.test(v))) continue;
    const nums = vals.map(Number);
    const total = nums.reduce((a, b) => a + b, 0);
    const pos = nums.filter((n) => n > 0).reduce((a, b) => a + b, 0);
    const neg = nums.filter((n) => n < 0).reduce((a, b) => a + b, 0);
    sums.push(`  ${header[i]}: ${rows.length} rows, total ${total}, positives ${pos}, negatives ${neg}`);
  }
  return sums.length ? `\n\nColumn totals, computed exactly from this file:\n${sums.join("\n")}` : "";
}
for (const a of clientView.artifacts ?? []) {
  if (typeof a?.contents === "string" && /\.csv$/i.test(a.path ?? "")) {
    a.contents += columnSums(a.contents);
  }
}

const prompt = `You are ${persona}. The firm you pay has just sent you the work below. You have not
seen their working, their spreadsheets, or spoken to them.

You are not a specialist in their trade. You want to know: is this right, do I owe anything, and is
there anything I need to do?

Judge it as a paying client. Be demanding — you are paying for this and you could hire someone else.

If you claim a figure is wrong, show the addition: list the numbers you added and the total you got.
A complaint about arithmetic that does not show its own working is one you must drop, because you
would not send it to the firm either. Where a file below carries computed column totals, those are
exact — use them rather than adding the rows yourself.

WHAT THEY SENT:
${JSON.stringify(clientView, null, 2)}

Answer as strict JSON only:
{"satisfied":true|false,"score":1-10,"would_pay_again":true|false,
 "what_worked":["..."],"what_annoyed_me":["..."],"questions_i_still_have":["..."],
 "verdict":"one sentence, how you'd describe this to a friend"}`;

const res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    // Deliberately a STRONGER model than the one that wrote the work. A judge no sharper than the
    // author cannot see what the author missed.
    model: process.env.MYCEL_JUDGE_MODEL ?? "gpt-5.6-terra",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  }),
});
if (!res.ok) {
  console.error(`judge call failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const out = JSON.parse((await res.json()).choices[0].message.content);

const bar = 8;
console.log(`\n  score ${out.score}/10   would pay again: ${out.would_pay_again}\n`);
console.log(`  "${out.verdict}"\n`);
for (const [label, items] of [
  ["worked", out.what_worked],
  ["annoyed them", out.what_annoyed_me],
  ["still unanswered", out.questions_i_still_have],
]) {
  console.log(`  ${label}:`);
  for (const i of items ?? []) console.log(`    - ${i}`);
  console.log();
}
// The bar is high on purpose. A client who scores the work 7 and pays anyway is a client who leaves
// in month four, and the number that predicts that is not "did it ship".
if (out.score < bar) {
  console.log(`  ▪ below the bar (${bar}) — this is not work somebody renews on\n`);
  process.exit(1);
}
console.log(`  ▪ at or above the bar (${bar})\n`);
