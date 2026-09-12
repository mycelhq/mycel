// The gates a service needs, read off the shape of what it promises to return.
//
// ═══ WHY THIS HAS TO EXIST ═══
//
// books-keeper's `monthly_close` carries eleven `ship_checks`. Every one of them was written after a
// paying client read a deliverable and objected: a total that disagreed with its own lines, a profit
// that was not revenue minus costs, £34,000.00 printed for 34000 minor units, "four review items"
// beside a ledger showing five, a figure stated as due beside a sentence saying it could not be
// established. Thirty-two runs of hardening, on ONE service.
//
// And a founder describing their business at onboarding gets a service generated on the fly, with
// `ship_checks: none` and `ship_requires: none`. Not weaker gates — no gates. The authoring contract
// does not even ask for them. So the first client of every service Mycel invents receives work held
// to nothing, and the thirty-two runs bought a single wedge.
//
// Hand-writing them per service does not scale past the services we personally wrote, which is the
// opposite of the product.
//
// ═══ WHY IT IS INFERENCE AND NOT A MODEL ═══
//
// The obvious move is to ask the authoring model for its own checks. That fails the way asking a
// model to grade itself always fails: the checks would be as optimistic as the schema, and a check
// nobody can predict is a check nobody can trust. Worse, `ship_checks` is a CLOSED vocabulary parsed
// by `readShipChecks` — a model inventing `kind: "looks_right"` produces a check silently dropped at
// load, which is a gate that reports as present and does nothing.
//
// The shapes are legible without a model. A list of objects with a numeric field, beside a total
// with a matching name, is `sums_to` — that is not a judgement, it is a join. Revenue and expenses
// and net is `nets_to`. A prose field beside minor-unit figures is `minor_units`. The names carry
// the meaning because schema authors, including the model, name things conventionally.
//
// ═══ THE BAR FOR ADDING A RULE HERE ═══
//
// A wrong check holds correct work, a founder waits, and the second time it happens somebody deletes
// the check — so every rule below is conservative by construction and silent when unsure. It is
// better to infer four checks that are certainly right than eleven that are mostly right. Anything
// needing a judgement call is not inferred; it is left for a human to declare.
//
// Proof rather than assertion: `infer-checks.test.ts` runs this against books-keeper's own output
// schema and requires it to rediscover the checks a human wrote across thirty-two client-judged runs.

import { readShipChecks, type ShipCheck } from "./ship-checks";

interface Prop {
  type?: string;
  properties?: Record<string, Prop>;
  items?: Prop;
  description?: string;
  enum?: unknown[];
}

const props = (schema: unknown): Record<string, Prop> =>
  (schema && typeof schema === "object" ? ((schema as { properties?: Record<string, Prop> }).properties ?? {}) : {});

/**
 * Every field in the schema, by dotted path.
 *
 * ═══ DEPTH IS WHERE THE FIRST VERSION FAILED ═══
 *
 * Walking only the top level found eight of books-keeper's twelve hand-written checks. All four
 * misses were the same thing: `profit_and_loss.by_category[].amount_minor` summing to
 * `profit_and_loss.expenses_minor`, and `questions[].amount_minor` summing to
 * `profit_and_loss.held_pending_decision.amount_minor` — two levels down. A real output schema nests,
 * and the most consequential arithmetic in the close was inside an object.
 *
 * Arrays contribute their ITEM shape under `<path>[]`, so a list nested in an object is joinable to
 * a total nested in another. Bounded at four levels: deeper than that is not a deliverable schema.
 */
function walk(
  schema: unknown,
  path = "",
  depth = 0,
  out: { path: string; name: string; p: Prop }[] = [],
): { path: string; name: string; p: Prop }[] {
  if (depth > 4) return out;
  for (const [name, p] of Object.entries(props(schema))) {
    const here = path ? `${path}.${name}` : name;
    out.push({ path: here, name, p });
    if (p?.type === "object") walk(p, here, depth + 1, out);
    else if (p?.type === "array" && p.items) walk(p.items, `${here}[]`, depth + 1, out);
  }
  return out;
}

/** `profit_and_loss.by_category[]` → `profit_and_loss.by_category`. */
const listOf = (itemPath: string): string => itemPath.replace(/\[\]$/, "");

const isNum = (p: Prop | undefined): boolean => p?.type === "integer" || p?.type === "number";

/** Comparable form of a field name: `net_due_minor` and `netDue` collapse to the same token. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `amount_minor` → `amount`. The unit suffix is noise when matching a total to its lines. */
const stem = (s: string): string => norm(s).replace(/(minor|cents|pence|amount|total|sum|value)$/g, "");

/**
 * ASKS, not work. A field in this family is something the run wants FROM the client, and it must
 * never be mistaken for the deliverable — `ship_requires: ["needs"]` would hold every finished job
 * that had nothing to ask, which is the best possible outcome being treated as a failure.
 */
const ASK_FIELDS = new Set(["needs", "questions", "blocked_on", "missing", "required_from_client", "asks", "anomalies"]);

/** Prose meant for a person. The narrower the list, the fewer false `min_words` holds on a JSON blob. */
const isProse = (name: string, p: Prop | undefined): boolean =>
  p?.type === "string" && !p.enum && /(summary|note|body|message|covering|narrative|report)/.test(norm(name));

export interface InferredChecks {
  ship_requires: string[];
  ship_checks: ShipCheck[];
  /** One line per inference, so a founder reviewing a generated service can see why each gate is there. */
  why: string[];
}

/**
 * Read an output schema and return the gates its own shape implies.
 *
 * `clientFacing` false (an internal tick, a classification) returns nothing: the prose rules and the
 * ship bar are about work somebody PAYS for, and applying them to a routing decision is how a gate
 * earns a reputation for getting in the way.
 */
export function inferChecks(outputSchema: unknown, opts: { clientFacing?: boolean } = {}): InferredChecks {
  const out: InferredChecks = { ship_requires: [], ship_checks: [], why: [] };
  if (opts.clientFacing === false) return out;
  const top = props(outputSchema);
  const names = Object.keys(top);
  if (!names.length) return out;

  const add = (check: ShipCheck, why: string): void => {
    out.ship_checks.push(check);
    out.why.push(why);
  };

  const all = walk(outputSchema);
  const nums = all.filter((f) => isNum(f.p));
  const anyMinor = nums.some((f) => /(minor|cents|pence)$/.test(norm(f.name)));
  /** Numeric fields NOT inside an array — a total lives beside its lines, never among them. */
  const scalars = nums.filter((f) => !f.path.includes("[]"));

  for (const { path, name, p } of all) {
    if (path.includes("[]")) continue; // Item fields are handled by the joins below.

    // ── PROSE: a client reads it, so it must say something, stop somewhere, carry no placeholder
    if (isProse(name, p)) {
      add({ kind: "min_words", field: path, n: 25 }, `\`${path}\` is prose a client reads, so it cannot be a sentence fragment`);
      add({ kind: "max_words", field: path, n: 400 }, `\`${path}\` is a covering note, not the work — a wall of text is the work not being attached`);
      add(
        { kind: "forbids", field: path, vocabulary: "placeholder" },
        `\`${path}\` must not ship "TODO" or "[insert]" — a placeholder in a client's document is unfinished, not draft`,
      );
      if (anyMinor) {
        add(
          { kind: "minor_units", field: path },
          `\`${path}\` is prose beside minor-unit figures: a hundredfold error in a document about money reads as deliberate`,
        );
      }
      if (!ASK_FIELDS.has(norm(name))) out.ship_requires.push(path);
      continue;
    }

    if (p?.type === "array") {
      const item = props(p.items);
      /**
       * REQUIRED only when it is the WORK. An array can legitimately be empty — nothing owed, nothing
       * anomalous — and `missingSubstance` holds an empty one, so requiring every list turns the best
       * possible outcome into a failure. The exception is the files: a deliverable with no artifact is
       * not a deliverable, which is the complaint this whole product was rebuilt around.
       */
      if (/^(artifacts|files|deliverables|attachments)$/.test(norm(name))) out.ship_requires.push(path);
      for (const key of ["name", "what", "title", "about", "label", "question"]) {
        if (item[key]?.type === "string") {
          add({ kind: "each_has", items: path, field: key }, `every \`${path}\` entry needs \`${key}\`, or the client cannot tell them apart`);
          break;
        }
      }
      if (ASK_FIELDS.has(norm(name)) && item.recommendation?.type === "string") {
        add(
          { kind: "each_has", items: path, field: "recommendation" },
          `every \`${path}\` entry carries a recommendation — a retainer buys decisions made, not a list of ambiguities`,
        );
      }
      continue;
    }

    // A structured section IS the work: a close with no reconciliation object did not reconcile.
    if (p?.type === "object" && !ASK_FIELDS.has(norm(name)) && !path.includes(".")) out.ship_requires.push(path);
  }

  /**
   * ── TOTALS AGAINST THEIR LINES, ONLY WHEN THE PAIRING IS UNAMBIGUOUS ─────────────────────────
   *
   * `lines[].charge_minor` beside `total_minor` is the highest-stakes arithmetic the product does —
   * a client pays from that number — so it is the check most worth inferring and the one most
   * dangerous to infer wrong. A `sums_to` pointed at the wrong total holds every correct invoice.
   *
   * books-keeper's schema is the argument for restraint: FIVE lists carry `amount_minor` —
   * `questions`, `questions[].evidence`, `reconciliation.outstanding_items`,
   * `profit_and_loss.by_category`, `owed` — and `profit_and_loss` alone holds three totalish scalars.
   * Nothing in the names says which sums to which. Guessing there is a coin flip on somebody's books.
   *
   * So both sides must be unique IN THE SAME OBJECT: one list, one numeric field on its items, one
   * scalar that reads as a total. `{lines[].charge_minor, total_minor}` — the shape a generated
   * service almost always has — infers cleanly. A schema as tangled as the close infers nothing and
   * stays hand-declared, which is the right division: the generator exists to give a NEW service the
   * gates it would otherwise have none of, not to overrule a human where the schema is ambiguous.
   */
  const container = (path: string): string => (path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "");
  for (const list of all.filter((f) => f.p?.type === "array" && !f.path.includes("[]"))) {
    const itemNums = nums.filter((f) => container(f.path) === `${list.path}[]`);
    if (itemNums.length !== 1) continue; // Two numeric columns: which one is the total of?
    const siblings = scalars.filter((f) => container(f.path) === container(list.path));
    const totals = siblings.filter((f) => {
      const n = norm(f.name);
      return /^(total|sum|subtotal|grand)/.test(n) || /(total|sum)$/.test(n);
    });
    if (totals.length !== 1) continue; // No total, or several — say nothing rather than pick.
    add(
      { kind: "sums_to", items: list.path, each: itemNums[0]!.name, total: totals[0]!.path },
      `\`${totals[0]!.path}\` must equal the sum of \`${list.path}[].${itemNums[0]!.name}\` — a client pays from that number`,
    );
  }

  /**
   * ── THE PAIRING THE AUTHOR ALREADY WROTE DOWN ────────────────────────────────────────────────
   *
   * Everything above infers from NAMES, and names run out exactly where books-keeper's schema is:
   * five lists carry `amount_minor`, `profit_and_loss` holds three totalish scalars, and no rule
   * over identifiers can say which sums to which. That restraint is right and it left three
   * hand-written checks unrecovered.
   *
   * But two of those three are not actually ambiguous, because the author STATED the relationship:
   *
   *   held_pending_decision.amount_minor — "The SIGNED sum of every question's `amount_minor`"
   *   held_pending_decision.item_count   — "Must equal the number of open questions"
   *
   * That is evidence, not a guess. It is also the register schema authors write in without being
   * asked — a total gets described in terms of what it totals, because there is no other way to say
   * what it is — which means the rule generalises to a schema the model writes on Tuesday.
   *
   * ═══ AND IT STILL REFUSES WHEN THE SENTENCE IS NOT SPECIFIC ═══
   *
   * The named list has to RESOLVE to an array that actually exists at the top level of this schema.
   * A description mentioning "questions" when there is no `questions` array infers nothing. And the
   * item field has to be named in the sentence or be the only numeric field on the row — the same
   * two-columns test the name-based rule applies, for the same reason.
   *
   * The third hand-written check — `by_category[].amount_minor` summing to `expenses_minor` — is
   * still not inferred, and correctly: both fields have NO description at all. Nothing in that
   * schema states the relationship, so nothing here may claim it.
   */
  const arrays = all.filter((f) => f.p?.type === "array" && !f.path.includes("[]"));
  /** `question's`, `questions`, `Questions` → the array whose name matches once singularised. */
  const arrayNamed = (word: string) => {
    const want = norm(word).replace(/s$/, "");
    const hits = arrays.filter((a) => norm(a.name).replace(/s$/, "") === want);
    return hits.length === 1 ? hits[0]! : undefined;
  };
  for (const field of nums) {
    const said = field.p?.description ?? "";
    if (!said) continue;

    // "sum of every question's `amount_minor`" / "total of the lines" / "sum of all charges"
    /**
     * GREEDY, and the first version was not. `([A-Za-z_][\\w]*?)` with every trailing group optional
     * matches ONE CHARACTER: it captured "q" from "sum of every question's", resolved nothing, and
     * the whole rule sat inert looking exactly like a rule that had decided to stay silent.
     */
    const sum = /\b(?:sum|total)\s+of\s+(?:every|each|all|the)?\s*[`'"]?(\w+)[`"]?(?:['’]s|s['’])?\s*(?:[`'"](\w+)[`'"])?/i.exec(said);
    if (sum) {
      const list = arrayNamed(sum[1]!);
      if (list && list.path !== container(field.path)) {
        const itemNums = nums.filter((f) => container(f.path) === `${list.path}[]`);
        const named = sum[2] ? itemNums.find((f) => norm(f.name) === norm(sum[2]!)) : undefined;
        const each = named ?? (itemNums.length === 1 ? itemNums[0] : undefined);
        if (each) {
          add(
            { kind: "sums_to", items: list.path, each: each.name, total: field.path },
            `the schema says \`${field.path}\` is the sum of \`${list.path}[].${each.name}\`, so it has to be`,
          );
        }
      }
    }

    // "Must equal the number of open questions" / "how many questions" / "count of the lines"
    const count = /\b(?:number|count)\s+of\s+(?:open|the|all|every)?\s*[`'"]?(\w+)['`"]?/i.exec(said);
    if (count) {
      const list = arrayNamed(count[1]!);
      // A count field, not a money field that happens to mention counting.
      if (list && /(count|number|items|total)$/.test(norm(field.name)) && !/(minor|cents|pence|amount)$/.test(norm(field.name))) {
        add(
          { kind: "counts", items: list.path, field: field.path },
          `the schema says \`${field.path}\` is how many \`${list.path}\` there are — a client who counts five and reads four stops trusting both numbers`,
        );
      }
    }
  }

  // ── REVENUE − EXPENSES = NET, in whichever object holds all three ────────────────────────────
  const containers = new Set(scalars.map((f) => (f.path.includes(".") ? f.path.slice(0, f.path.lastIndexOf(".")) : "")));
  for (const container of containers) {
    const scope = scalars.filter((f) => (f.path.includes(".") ? f.path.slice(0, f.path.lastIndexOf(".")) : "") === container);
    const pick = (re: RegExp) => scope.find((f) => re.test(norm(f.name)));
    const rev = pick(/^(revenue|income|sales|gross|subtotal)/);
    const exp = pick(/^(expenses|costs|spend|outgoings|deductions|discount)/);
    const net = pick(/^(net|profit|result|balance|due|payable)/);
    if (rev && exp && net) {
      add(
        { kind: "nets_to", minuend: rev.path, subtrahend: exp.path, total: net.path },
        `\`${net.path}\` must equal \`${rev.path}\` minus \`${exp.path}\` — two bottom lines means the client picks neither and asks`,
      );
    }
  }

  // ── A FLAG CLAIMING AGREEMENT, BESIDE THE DIFFERENCE THAT WOULD DISPROVE IT ───────────────────
  for (const flag of all.filter((f) => f.p?.type === "boolean" && !f.path.includes("[]") && /(reconcil|balanc|match|agree|clear)/.test(norm(f.name)))) {
    const diff = scalars.find((f) => /(difference|variance|discrepancy|gap|delta)/.test(norm(f.name)));
    if (diff) {
      add(
        { kind: "agrees", flag: flag.path, zero_when_true: diff.path },
        `\`${flag.path}\` and \`${diff.path}\` must agree — telling a client the books balance while holding a hole is the worst thing this can do`,
      );
    }
  }

  // ── A STATED COUNT, BESIDE THE LIST IT COUNTS ────────────────────────────────────────────────
  for (const list of all.filter((f) => f.p?.type === "array" && !f.path.includes("[]"))) {
    const singular = norm(list.name).replace(/s$/, "");
    /**
     * NAMED FOR ITS OWN LIST, or not inferred.
     *
     * The first version accepted a generic `item_count`, and it bound to every list in the schema —
     * nine identical `counts` checks off one field. A count that could be counting any of nine things
     * is a check nobody can predict, and an unpredictable check is one somebody deletes the second
     * time it holds good work.
     *
     * So the counter has to say which list it counts: `question_count`, `candidates_reviewed`,
     * `transactions_reviewed`. books-keeper's own `held_pending_decision.item_count` counts
     * `questions`, and that link is semantic rather than lexical — it stays hand-declared, which is
     * the right outcome. Conservative is the bar: four checks that are certainly right beat eleven
     * that are mostly right.
     */
    const counter = scalars.find((f) => {
      const n = norm(f.name);
      if (!/(count|number|reviewed|total)$/.test(n) && !/^(count|num)/.test(n)) return false;
      return singular.length >= 4 && (n.includes(singular) || n.includes(norm(list.name)));
    });
    if (counter) {
      add(
        { kind: "counts", items: list.path, field: counter.path },
        `\`${counter.path}\` must equal the length of \`${list.path}\` — a client counts the list, and two numbers that disagree cost you every other number`,
      );
    }
  }

  /**
   * ── A FIGURE BESIDE A FLAG SAYING IT CANNOT BE KNOWN ─────────────────────────────────────────
   *
   * The complaint that comes first, every time, and the only one that can cost a client money:
   * "they show £1,640.00 as net due and say the net VAT due is not established — those positions
   * cannot both be used to tell me what I owe." A boolean whose name says UNQUANTIFIED, beside a
   * figure in the same object, is that pair.
   */
  for (const flag of all.filter((f) => f.p?.type === "boolean" && !f.path.includes("[]"))) {
    /**
     * "CANNOT BE KNOWN", not "is approximate". `estimated` and `provisional` were in this list and
     * they are a different claim: a provisional profit is a real figure that may move, and
     * `profit_and_loss.provisional` is TRUE on almost every close. Requiring `net_minor` absent
     * whenever it is true would have held every close this product produces — a check that fires on
     * the normal case, which is the fastest way to get a check deleted.
     */
    if (!/(unquantified|unknown|notestablished|unestablished|undetermined)/.test(norm(flag.name))) continue;
    const container = flag.path.includes(".") ? flag.path.slice(0, flag.path.lastIndexOf(".")) : "";
    const figure = scalars.find((f) => {
      const c = f.path.includes(".") ? f.path.slice(0, f.path.lastIndexOf(".")) : "";
      return c === container && /^(net|due|payable|owed|total|balance)/.test(norm(f.name));
    });
    if (figure) {
      add(
        { kind: "not_when", field: figure.path, unknown_when: flag.path },
        `\`${figure.path}\` must be absent when \`${flag.path}\` is true — you cannot tell a client a figure and also tell them it cannot be established`,
      );
    }
  }

  out.ship_requires = [...new Set(out.ship_requires)];
  // A safety net under every rule above: two identical checks are one check and a wasted line in the
  // contract the agent reads, and the same fault reported twice reads as two problems.
  const seen = new Set<string>();
  const keptWhy: string[] = [];
  out.ship_checks = out.ship_checks.filter((c, i) => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    keptWhy.push(out.why[i]!);
    return true;
  });
  out.why = keptWhy;
  return out;
}

/** A numeric field whose name says "total of <stem>", at the top level or one object deep. */
function findTotal(top: Record<string, Prop>, want: string, exclude: string): string | undefined {
  const matches = (k: string): boolean => {
    const n = norm(k);
    if (!/^(total|sum|gross|net|amount|expenses|charge)/.test(n) && !/(total|sum)$/.test(n)) return false;
    // `total_minor` for `charge_minor`: the bare word counts, and so does one carrying the stem.
    return want === "" || n.includes(want) || /^(total|sum)/.test(n);
  };
  for (const k of Object.keys(top)) {
    if (k === exclude) continue;
    if (isNum(top[k]) && matches(k)) return k;
  }
  for (const parent of Object.keys(top).filter((k) => top[k]?.type === "object")) {
    const inner = props(top[parent]);
    for (const k of Object.keys(inner)) {
      if (isNum(inner[k]) && matches(k)) return `${parent}.${k}`;
    }
  }
  return undefined;
}

/** A numeric field that reads as "how many <list>", at the top level or one object deep. */
function findCount(top: Record<string, Prop>, listName: string): string | undefined {
  const singular = listName.replace(/s$/, "");
  const ok = (k: string): boolean => {
    const n = norm(k);
    if (!/(count|_n|number|reviewed|total)$/.test(n) && !/^(count|num)/.test(n)) return false;
    return n.includes(singular) || n.includes(listName) || /^(item|entry|line)/.test(n);
  };
  for (const k of Object.keys(top)) if (isNum(top[k]) && ok(k)) return k;
  for (const parent of Object.keys(top).filter((k) => top[k]?.type === "object")) {
    const inner = props(top[parent]);
    for (const k of Object.keys(inner)) if (isNum(inner[k]) && ok(k)) return `${parent}.${k}`;
  }
  return undefined;
}

// ── And the picture, read off the same schema ────────────────────────────────────────────────────
//
// ═══ WHY A GENERATED SERVICE NEEDS THIS AND NOT JUST GATES ═══
//
// Everything above is about the work being RIGHT. This is about it being read.
//
// A close pack shipped as a wall of correct figures and every client who read one asked the same
// question in different words: where is my money going. The answer was in the numbers and took four
// minutes to assemble, so most of them never did. books-keeper carries a hand-written `chart`
// declaration because somebody sat down after those complaints and wrote one — and a service Mycel
// invents at onboarding gets none, so its first client receives the wall.
//
// Same argument as `inferChecks`, one step further: the thirty-two runs of hardening should buy
// every service, not one.
//
// ═══ WHY IT IS INFERENCE, AND WHY IT IS EVEN MORE CONSERVATIVE THAN THE CHECKS ═══
//
// The shape is legible without a model: a list of objects carrying one label and one number is a bar
// chart, and nothing else in a business schema looks like that. What is NOT legible is which of two
// numeric columns a reader wants to see, so two candidates means no chart.
//
// A wrong chart is worse than a wrong check. A held deliverable is a delay somebody investigates; a
// chart of the wrong column is a confident picture of a false thing, on page one, in front of the
// client. So the bar here is: exactly one array qualifies, and it qualifies unambiguously.

import type { ChartSpec } from "./render/report";

/**
 * Names that read as "what this row is". Ordered — `category` beats `name` when a schema has both,
 * because the more specific word is the one the author chose deliberately.
 */
const LABEL_NAMES = ["category", "label", "name", "title", "client", "source", "surface", "who", "item", "key", "type"];

/** An array whose name says it is already a breakdown. These are the ones worth a picture. */
const BREAKDOWN = /^(by|top|per)[_-]|^(breakdown|categories|competitors|sources|segments|ranked|shares|split)$/;

/** Where the run states its money. A schema with none gets a chart of plain numbers, which is honest. */
const CURRENCY_FIELDS = ["currency", "currency_code", "iso_currency"];

/**
 * The chart a schema implies, or nothing.
 *
 * `undefined` is the common and correct answer. A schema with no breakdown in it does not want a
 * bar chart, and a report without a picture is a report — `chartBlock` already treats an absent
 * spec as "no chart and no complaint".
 */
export function inferChart(outputSchema: unknown, opts: { clientFacing?: boolean } = {}): ChartSpec | undefined {
  if (opts.clientFacing === false) return undefined;
  const all = walk(outputSchema);

  const candidates: { spec: ChartSpec; ranked: boolean }[] = [];
  for (const field of all) {
    if (field.p?.type !== "array" || field.p.items?.type !== "object") continue;
    const item = props(field.p.items);
    const entries = Object.entries(item);
    const numerics = entries.filter(([, p]) => isNum(p));
    // EXACTLY ONE NUMBER. Two columns and the picture is a guess about which one the reader wants —
    // hours or charge, mentions or citations — and a guess is what this function refuses to make.
    if (numerics.length !== 1) continue;
    const strings = entries.filter(([, p]) => p?.type === "string" && !p.enum);
    if (!strings.length) continue;
    const label =
      LABEL_NAMES.map((want) => strings.find(([n]) => norm(n) === want)?.[0]).find(Boolean) ??
      (strings.length === 1 ? strings[0]![0] : undefined);
    if (!label) continue; // several strings and none of them says which is the row's name

    const series = listOf(field.path);
    // A list nested under an array item cannot be addressed by `chartBlock`'s dotted path.
    if (series.includes("[]")) continue;
    const value = numerics[0]![0];
    const currency = all.find((f) => f.p?.type === "string" && CURRENCY_FIELDS.includes(norm(f.name)) && !f.path.includes("[]"));
    candidates.push({
      spec: {
        series,
        label,
        value,
        title: titleFor(field.name, field.p.description),
        ...(currency ? { currency_at: currency.path } : {}),
        limit: 10,
      },
      ranked: BREAKDOWN.test(norm(field.name).replace(/([a-z])(?=[A-Z])/g, "$1_")) || BREAKDOWN.test(field.name.toLowerCase()),
    });
  }

  /**
   * ═══ THE ARRAY MUST SAY IT IS A BREAKDOWN. NO FALLBACK. ═══
   *
   * The first version took the only qualifying array when there was exactly one, and the sweep over
   * the shipped wedges showed immediately why that is wrong. `read_signals` got a bar chart of
   * `stale` by `age_days` and `review_pipeline` got one of `dormant` by `days_quiet` — pictures of
   * the EXCEPTION LIST, sorted by how old the exceptions are, which is not a question anybody asked.
   *
   * A chart is a breakdown of a whole. `by_category`, `top_competitors`, `per_surface` — a schema
   * author names a distribution when they have one, and a list called `stale` is a list of problems.
   * Being the only candidate is not evidence of being a good chart, and a confident picture of a
   * false thing on page one in front of the client is the failure this whole function is guarding
   * against.
   *
   * Two breakdowns is a tie, and a tie is silence. The author declares one if the picture matters,
   * and a declared chart always wins over anything inferred here.
   */
  const named = candidates.filter((c) => c.ranked);
  return named.length === 1 ? named[0]!.spec : undefined;
}

/**
 * A title a client reads, from a field name or the author's own description.
 *
 * The description first when it is short enough to be a title — an author who wrote "Spend by
 * category, largest first" has already said what the picture is better than `by_category` does.
 */
function titleFor(name: string, description?: string): string {
  const d = (description ?? "").trim().split(/(?<=[.!?])\s/)[0]?.replace(/\.$/, "") ?? "";
  if (d && d.length <= 48 && /\s/.test(d)) return d[0]!.toUpperCase() + d.slice(1);
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Breakdown";
}


/**
 * ═══ THE EFFECTIVE SHIP CONTRACT — declared ∪ inferred, for EVERY wedge ═══
 *
 * `inferChecks` was written because "hand-writing a bar per service does not scale past the services
 * we personally wrote, which is the opposite of the product" — and it was then wired into exactly
 * one path: `wedgeauthor`, the GENERATED wedge. The services we personally wrote were left holding
 * the hand-written bar, and mostly never got one. Measured on this repo: of 49 task types that emit
 * prose a client reads, 31 declared no `ship_checks` at all. Sixty-three per cent of the fulfillment
 * surface was graded against nothing.
 *
 * That is how `[amount]`, `[due date]` and `[payment link]` left `invoice-chaser` and scored below
 * bar on a real-key run. The gate that catches it existed, was tested, and did not run here.
 *
 * DECLARED WINS, per (kind, field). An author that named its own bar keeps it — this fills holes, it
 * never overrules a decision. Inference only adds a check where the manifest is silent about that
 * exact field.
 *
 * ONE FUNCTION, TWO CALLERS, and that is the point rather than tidiness: `runtime` shows the agent
 * the contract before it writes, and `orchestrator` grades against it after. If those two lists can
 * ever differ, the kernel is holding work against a rule the agent was never shown — which this
 * codebase already calls a trap, correctly.
 */
export function effectiveShipContract(
  /* A manifest task type, which is parsed JSON and therefore untrusted — every field is read
     defensively rather than declared, because a wedge on disk can hold anything. */
  spec: Record<string, unknown> | undefined | null,
): { ship_requires: string[]; ship_checks: ShipCheck[] } {
  const tt = (spec ?? {}) as Record<string, unknown>;
  const declaredRequires = Array.isArray(tt.ship_requires)
    ? (tt.ship_requires as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const declaredChecks = readShipChecks(tt.ship_checks);
  if (!tt.output_schema) return { ship_requires: declaredRequires, ship_checks: declaredChecks };

  const inferred = inferChecks(tt.output_schema, { clientFacing: tt.internal !== true });
  const taken = new Set(declaredChecks.map((c) => `${c.kind}::${"field" in c ? c.field : ""}`));
  const added = inferred.ship_checks.filter((c) => !taken.has(`${c.kind}::${"field" in c ? c.field : ""}`));

  return {
    ship_requires: declaredRequires.length ? declaredRequires : inferred.ship_requires,
    ship_checks: [...declaredChecks, ...added],
  };
}
