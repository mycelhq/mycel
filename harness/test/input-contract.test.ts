// WHAT THE RUN WAS HANDED, said in words rather than left as anonymous JSON.
//
// A weekly_report was created with eight queries, each carrying a `present` and `cited` from probes
// that had already run. The run ignored them, fanned out into eleven probe_mention children, most
// failed, and it joined on "batch joined with no successful children" having written nothing.
//
// The agent HAD the measurements and could not tell they were measurements. buildAgentsMd rendered
// one line — `Input: {…raw JSON…}` — so a field called `cited` arrived with no more standing than a
// field called `note`, and a model whose skill tells it to measure went and measured.
//
// Twenty-three task types declared an `input_schema` and NOTHING READ IT: validateOutput ran on pack
// and workflow arguments, never on a task's own input, and no prompt ever mentioned it.
import test from "node:test";
import assert from "node:assert/strict";
import { describeInputContract, inputFaults } from "../src/input-contract";

const SCHEMA = {
  type: "object",
  required: ["client"],
  properties: {
    client: { type: "string", description: "The brand this report is about." },
    cited: { type: "boolean", description: "Did the answer link a page." },
    surface: { type: "string", enum: ["chatgpt", "perplexity"] },
  },
};

test("an undeclared contract is no opinion, not an empty one", () => {
  // 37 task types declare nothing. A change that started rejecting their inputs on a guess would
  // break every one at once — a missing contract is a gap in the manifest, not a licence to invent.
  assert.deepEqual(inputFaults({ anything: 1 }, undefined), []);
  assert.deepEqual(inputFaults({}, null), []);
  assert.deepEqual(describeInputContract(undefined), []);
});

test("a missing required field is caught where the caller is still listening", () => {
  // The alternative is what production did: provision a sandbox, run, and report "the accounting
  // period is missing" after twenty minutes — telling the founder through a failed job what the
  // route already knew.
  const faults = inputFaults({ cited: true }, SCHEMA);
  assert.ok(faults.length);
  assert.match(faults.join(" "), /client/);
});

test("a satisfied contract is silent", () => {
  assert.deepEqual(inputFaults({ client: "Brightline Dental", cited: true }, SCHEMA), []);
});

test("the contract is described as GIVEN, which is the half that fixes the report", () => {
  const lines = describeInputContract(SCHEMA).join("\n");
  assert.match(lines, /What you have been given/);
  // The instruction that stops a run re-gathering what it holds.
  assert.match(lines, /Do not go and measure, fetch or look up something you\s+were handed/);
  assert.match(lines, /ground truth/);
});

test("required and optional read differently, because they ARE different instructions", () => {
  const lines = describeInputContract(SCHEMA).join("\n");
  // "you were given this" and "you may have been given this" are where a model decides whether to
  // go and find out for itself.
  assert.match(lines, /`client`.*REQUIRED/);
  assert.ok(!/`cited`.*REQUIRED/.test(lines), "an optional field must not be announced as required");
});

test("descriptions and enums travel, because they are what the field MEANS", () => {
  const lines = describeInputContract(SCHEMA).join("\n");
  assert.match(lines, /Did the answer link a page/);
  assert.match(lines, /one of: chatgpt, perplexity/);
});

test("a schema with no properties describes nothing rather than an empty heading", () => {
  // A "What you have been given" heading with nothing under it tells the agent a contract exists
  // and then shows it none — worse than silence.
  assert.deepEqual(describeInputContract({ type: "object" }), []);
  assert.deepEqual(describeInputContract({ type: "object", properties: {} }), []);
});

test("a blank cell in an export is not a contract violation", () => {
  // The close that stopped the loop. Sixteen transactions posted, refused at the door:
  //
  //   $.transactions[11].counterparty: expected string, got null
  //
  // That row is a card payment with no merchant name on it — the most ordinary row in any bank
  // statement, and exactly the one a close exists to flag. Refusing it teaches the caller to strip
  // nulls or, worse, to write "unknown", which then becomes a category and lands in the P&L.
  //
  // Optional and null means not known, which is what absent already means. Required is untouched.
  const schema = {
    type: "object",
    required: ["period"],
    properties: {
      period: { type: "string" },
      transactions: {
        type: "array",
        items: {
          type: "object",
          required: ["amount_minor"],
          properties: {
            amount_minor: { type: "integer" },
            counterparty: { type: "string" },
            category: { type: "string" },
          },
        },
      },
    },
  };

  assert.deepEqual(
    inputFaults({ period: "2026-08", transactions: [{ amount_minor: -34000, counterparty: null, category: null }] }, schema),
    [],
  );

  // A required field is still required, null or not.
  assert.equal(inputFaults({ period: null }, schema).length > 0, true);
  assert.equal(inputFaults({ period: "2026-08", transactions: [{ amount_minor: null }] }, schema).length > 0, true);

  // And a wrong TYPE is still wrong — this loosens null, nothing else.
  assert.equal(
    inputFaults({ period: "2026-08", transactions: [{ amount_minor: -1, counterparty: 42 }] }, schema).length > 0,
    true,
  );
});
