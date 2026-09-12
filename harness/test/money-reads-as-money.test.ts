/**
 * MONEY, WHERE A FOUNDER READS IT.
 *
 * Home's ranked list showed a row whose right-hand column said "$6,900.00" and whose subtitle,
 * on the same line, said "6900 USD outstanding". Same number, twice, in two formats. The subtitle
 * came from `${amount_due / 10 ** exponent} ${currency}` — a bare quotient and a currency code.
 *
 * The second formatter was worse and quieter: a three-currency symbol table with `minor / 100`
 * hardcoded, which is simply wrong for any currency whose minor unit is not a hundredth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moneyText } from "../src/moves.ts";

test("minor units become the amount a person would write", () => {
  assert.equal(moneyText(690000, "USD"), "$6,900.00");
  assert.equal(moneyText(125, "USD"), "$1.25");
  assert.equal(moneyText(0, "USD"), "$0.00");
});

test("the currency is the invoice's own, not the reader's", () => {
  // A euro invoice must not acquire a dollar sign on its way to the screen.
  assert.match(moneyText(690000, "EUR"), /6,900\.00/);
  assert.ok(!moneyText(690000, "EUR").includes("$"), "a EUR amount rendered with a dollar sign");
  assert.match(moneyText(690000, "GBP"), /£6,900\.00/);
});

test("a zero-decimal currency is not divided by a hundred", () => {
  // The bug in the formatter this replaced: ¥12,000 read as ¥120.
  const yen = moneyText(12000, "JPY");
  assert.match(yen, /12,000/, `JPY was scaled as if it had cents: ${yen}`);
  assert.doesNotMatch(yen, /120(\.|$)/);
});

test("an unknown currency degrades to something readable, not to a quotient", () => {
  const out = moneyText(690000, "ZZZ");
  assert.match(out, /ZZZ/);
  assert.doesNotMatch(out, /^6900 /, "fell back to the bare number this test exists to remove");
});

test("money is formatted without dividing", () => {
  // `contract.ts`: "Never a float, anywhere, for one reason that is not negotiable." Display is a
  // weaker case than arithmetic, but a divide-by-a-power-of-ten in a money path is the thing the
  // next person copies. The first version of `moneyText` did exactly that.
  const src = readFileSync(new URL("../src/moves.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function moneyText"), src.indexOf("export function moneyPoints"));
  assert.doesNotMatch(fn, /\/ *10 \*\*|\/ *100\b|Intl\.NumberFormat/, "moneyText divides again");
  assert.match(fn, /padStart\(e \+ 1, "0"\)/, "the digit-string approach is gone");
});

test("negatives keep the sign outside the symbol", () => {
  assert.equal(moneyText(-50000, "USD"), "-$500.00");
});

test("nothing left in moves.ts divides money by hand", () => {
  const src = readFileSync(new URL("../src/moves.ts", import.meta.url), "utf8");
  const body = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const hand = [...body.matchAll(/\$\{[^}]*\/ 10 \*\* [^}]*\}\s*\$\{[^}]*currency[^}]*\}/g)].map((m) => m[0]);
  assert.deepEqual(hand, [], `money formatted by hand again:\n  ${hand.join("\n  ")}`);
});
