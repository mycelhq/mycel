// `only_if` — the small expression language a sequence step is gated on.
//
// WHY A PARSER AND NOT A FLAG. The real conditions are compound: "message them only if they
// accepted AND have not replied", "skip the follow-up if they opted out OR the account is flagged".
// Encoding those as booleans on the step means a new field for every combination somebody thinks of
// six weeks from now, and steps that silently do the wrong thing when two flags disagree. Encoding
// them as a string the model writes means an agent can author a condition — which is exactly what
// must NOT happen, so this grammar has no function calls, no property access, no comparison against
// literals, and no way to name anything except a fact the harness computed itself.
//
// The whole language is: identifiers, NOT, AND, OR, parentheses. It is pure, total (a malformed
// expression is a thrown ConditionError, never a silent `true`), and unit-tested — because a
// precedence bug here does not crash, it just sends a message to someone who already replied.
//
//   only_if: "connected AND !replied"
//   only_if: "connected AND !(replied OR opted_out)"

export class ConditionError extends Error {}

type Node =
  | { t: "fact"; name: string }
  | { t: "not"; a: Node }
  | { t: "and"; a: Node; b: Node }
  | { t: "or"; a: Node; b: Node };

type Token = { t: "ident"; v: string } | { t: "op"; v: "and" | "or" | "not" | "(" | ")" };

/**
 * Word operators and symbol operators both, because both get written by hand and refusing one is a
 * papercut with no upside. `!` binds tighter than either word form, as everywhere else.
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "!") {
      out.push({ t: "op", v: "not" });
      i++;
      continue;
    }
    if (c === "&" && src[i + 1] === "&") {
      out.push({ t: "op", v: "and" });
      i += 2;
      continue;
    }
    if (c === "|" && src[i + 1] === "|") {
      out.push({ t: "op", v: "or" });
      i += 2;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (!word) throw new ConditionError(`unexpected character "${c}" at ${i} in condition`);
    i += word[0].length;
    const lower = word[0].toLowerCase();
    if (lower === "and" || lower === "or" || lower === "not") out.push({ t: "op", v: lower });
    else out.push({ t: "ident", v: word[0] });
  }
  return out;
}

/**
 * Recursive descent, one function per precedence level. OR is the loosest, then AND, then NOT —
 * so `a OR b AND c` is `a OR (b AND c)`, which is what everyone reading it expects and what a
 * naive left-to-right evaluator gets wrong.
 */
export function parseCondition(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const eat = (v: string): boolean => {
    const t = peek();
    if (t && t.t === "op" && t.v === v) {
      pos++;
      return true;
    }
    return false;
  };

  const parseOr = (): Node => {
    let left = parseAnd();
    while (eat("or")) left = { t: "or", a: left, b: parseAnd() };
    return left;
  };
  const parseAnd = (): Node => {
    let left = parseNot();
    while (eat("and")) left = { t: "and", a: left, b: parseNot() };
    return left;
  };
  const parseNot = (): Node => {
    if (eat("not")) return { t: "not", a: parseNot() }; // right-associative: !!a is legal
    return parsePrimary();
  };
  const parsePrimary = (): Node => {
    const t = peek();
    if (!t) throw new ConditionError("condition ended early — expected a fact");
    if (t.t === "ident") {
      pos++;
      return { t: "fact", name: t.v };
    }
    if (t.v === "(") {
      pos++;
      const inner = parseOr();
      if (!eat(")")) throw new ConditionError("unbalanced parenthesis in condition");
      return inner;
    }
    throw new ConditionError(`unexpected "${t.v}" in condition`);
  };

  const tree = parseOr();
  if (pos !== tokens.length) throw new ConditionError(`trailing input in condition after position ${pos}`);
  return tree;
}

/** Every fact name an expression reads. Used to reject a step naming a fact nothing computes. */
export function factsUsed(src: string): string[] {
  const seen = new Set<string>();
  const walk = (n: Node): void => {
    if (n.t === "fact") seen.add(n.name);
    else if (n.t === "not") walk(n.a);
    else {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(parseCondition(src));
  return [...seen];
}

/**
 * Evaluate against the facts the harness computed.
 *
 * A fact nobody supplied is FALSE, never true: `connected AND !replied` on a case whose acceptance
 * we failed to learn must decline to send, not send anyway. Fail closed, like everything else that
 * decides whether a stranger's phone buzzes with the founder's name on it.
 */
export function evaluateCondition(src: string | undefined, facts: Record<string, boolean>): boolean {
  if (!src || !src.trim()) return true; // no condition is not a failed condition
  return run(parseCondition(src), facts);
}

function run(n: Node, facts: Record<string, boolean>): boolean {
  switch (n.t) {
    case "fact":
      return facts[n.name] === true;
    case "not":
      return !run(n.a, facts);
    case "and":
      return run(n.a, facts) && run(n.b, facts);
    case "or":
      return run(n.a, facts) || run(n.b, facts);
  }
}
