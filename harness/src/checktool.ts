// ═══ THE GATE THE RUN COULD NOT SEE UNTIL IT HAD ALREADY FAILED ═══
//
// A deliverable is refused at submit by two checks it never gets to run itself. `slopFault` reads
// every HTML file through `lintArtifact` and blocks on the seven tells that make a document look
// machine-made. And since the template pass, each deliver job declares the sections its artefact
// has. Both are knowable the moment the file is written; both are only reported after the run has
// declared itself finished, which costs a whole round trip and the context that would have made
// the fix cheap.
//
// a comparable runtime's `presentations` skill does the opposite and it is the thing worth taking from it: alongside
// `create_slide` and `export_pdf` it ships `validate_slide`, a Playwright check the agent runs on
// its own output before it says done. The agent is not trusted to eyeball its work; it is handed
// the same instrument the reviewer will use.
//
// ═══ ONE DEFINITION, NOT A COPY IN THE SANDBOX ═══
//
// The obvious build is a self-contained linter written into the box: no network, instant, works on
// every run. It is also exactly the failure `deliverables.routes.ts` documents at length — "this
// repo has been bitten three times by two gates disagreeing about one message", each time costing a
// day of sending, and the condition that causes it is the two gates having separate definitions.
//
// A copy of the rules in the sandbox is a second definition by construction. It drifts the first
// time a rule is added kernel-side, and it drifts SILENTLY: the agent's own check goes green and
// the submit refuses anyway, which is worse than no tool at all because it teaches the agent its
// instrument lies.
//
// So this posts back to the kernel and the kernel runs `lintArtifact` — the same function, the same
// call, one definition. The cost is a round trip inside our own VPC.
//
// ═══ AND THE EXPECTED SECTIONS ARE READ SERVER-SIDE, NOT SENT ═══
//
// The script sends the HTML and nothing else. The kernel resolves this run's task from the proxy
// grant, reads the declared shape off the manifest, and checks the headings against it. The
// alternative — the agent telling the endpoint which sections to expect, from the file it was
// handed — is a check the subject supplies the answer key for.

/** Where the tool lands. Same directory as `mycel-build`, `mycel-insight` and `mycel-image`. */
export const CHECK_TOOL_PATH = "/usr/local/bin/mycel-check";

/**
 * The script, parameterised with the run's own proxy endpoint and nonce.
 *
 * Reuses the LLM grant rather than minting a second credential, for the reason `INSIGHT_TOOL_PATH`
 * gives about sharing the build grant: this is a READ of the run's own output against rules that
 * are already public to it in `craft/anti-ai-slop.md` and the mounted shape. It starts nothing,
 * writes nothing, and reaches no other project. The worst an agent can do with it is call it twice.
 */
export function checkToolScript(baseUrl: string, nonce: string): string {
  return [
    "#!/usr/bin/env bash",
    "# mycel-check — read your own deliverable the way the reviewer will, before you submit it.",
    "# Written by the kernel (checktool.ts). Do not edit; it is overwritten every run.",
    "set -o pipefail",
    'FILE="$1"',
    'if [ -z "$FILE" ]; then echo "usage: mycel-check <file.html>" >&2; exit 2; fi',
    'if [ ! -f "$FILE" ]; then echo "mycel-check: no such file: $FILE" >&2; exit 2; fi',
    // The file is the payload. JSON-encoded by node so any quoting inside the HTML survives.
    `BODY=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({name:process.argv[1].split("/").pop(),html:fs.readFileSync(process.argv[1],"utf8")}))' "$FILE")`,
    `OUT=$(printf '%s' "$BODY" | curl -sS -X POST ${JSON.stringify(`${baseUrl.replace(/\/+$/, "")}/check`)} \\`,
    `  -H ${JSON.stringify(`authorization: Bearer ${nonce}`)} -H "content-type: application/json" --data-binary @-)`,
    'if [ -z "$OUT" ]; then echo "mycel-check: no answer from the kernel. Do not treat that as a pass." >&2; exit 3; fi',
    // Rendered here rather than server-side so the exit code and the text come from one place: a
    // non-zero exit is what makes this usable in `&&` chains, and an agent that only reads stdout
    // still sees every finding.
    `printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{`,
    `  let r; try { r = JSON.parse(s) } catch { process.stdout.write(s+"\\n"); process.exit(3) }`,
    `  if (r.error) { console.error("mycel-check: "+r.error); process.exit(3) }`,
    `  const f = r.findings || [];`,
    `  if (!f.length) { console.log("mycel-check: clean — "+(r.checked||"the file")+" passes the rules the reviewer applies."); process.exit(0) }`,
    `  console.log(f.length+" finding(s) in "+(r.checked||"the file")+". Each of these is refused at submit:");`,
    `  for (const x of f) console.log("  · ["+x.id+"] "+x.message+"\\n      fix: "+x.fix);`,
    `  process.exit(1)`,
    `})'`,
  ].join("\n");
}

/**
 * What the agent is told, for AGENTS.md.
 *
 * Leads with the fact that these are the SAME rules the submit applies, because the failure mode of
 * a self-check tool is an agent that treats it as advisory — runs it, reads the findings, decides
 * they are stylistic, and submits into a refusal it was just shown.
 */
export function checkToolDoc(hasShape: boolean): string[] {
  return [
    "",
    "## Read your own work before you submit it — `mycel-check`",
    "",
    "Run `mycel-check ./output/<file>.html` on every HTML file you write. It applies **the exact " +
      "rules that refuse a deliverable at submit** — not a style opinion, and not a second, softer " +
      "check. A finding here is a rejection you have not received yet.",
    "",
    "It reports two kinds:",
    "",
    "- The tells that make a document read as machine-made — the list in `craft/anti-ai-slop.md`.",
    ...(hasShape
      ? [
          "- Sections the shape for this job names and your file does not have. The expected list is " +
            "read from this job's own declaration server-side, not from anything you send.",
        ]
      : []),
    "",
    "Exit code 0 is clean, 1 is findings, and anything else means the check did not run. " +
      "**A check that did not run is not a pass** — say so in your final message rather than " +
      "submitting as though it passed.",
  ];
}
