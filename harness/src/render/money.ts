// Money, formatted, without ever leaving the integers.
//
// Read the MONEY comment on `Invoice` in contract.ts and the header of billing.ts first. The rule
// they establish is that an amount is a whole number of minor units and nothing divides by 100.
// A renderer is exactly where that rule dies quietly: `(amount / 100).toFixed(2)` looks harmless,
// is wrong for JPY and BHD, and for a large enough invoice prints a total that is a penny off the
// one the store holds and the payment link charges.
//
// So this file does not divide. It takes the decimal digits of the integer as a STRING and splits
// them at the exponent. There is no floating-point value anywhere between the stored amount and the
// glyphs on the page.
import { minorUnitExponent } from "../billing";

/** Symbols worth showing. Everything else prints its ISO code, which is unambiguous and never
 *  wrong — a wrong symbol on an invoice is a currency dispute. */
const SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  JPY: "¥",
  CNY: "¥",
  AUD: "$",
  CAD: "$",
  NZD: "$",
  CHF: "CHF ",
  INR: "₹",
};

/** Thousands separators, applied to a digit string. No arithmetic. */
function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * 125050 USD → "1,250.50". 1250 JPY → "1,250". -500 USD → "-5.00".
 *
 * `amountMinor` must already be an integer; a non-integer is a bug upstream and is truncated here
 * rather than rendered as "12.505" — but the truncation is the last line of defence, not the design.
 */
export function formatMinor(amountMinor: number, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const n = Math.trunc(amountMinor);
  const negative = n < 0;
  // String of the magnitude's digits, padded so there is always something left of the point.
  const digits = String(negative ? -n : n).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = exponent > 0 ? digits.slice(digits.length - exponent) : "";
  return `${negative ? "-" : ""}${group(whole)}${frac ? `.${frac}` : ""}`;
}

/** The same number with the currency in front of it, which is what a document shows. */
export function formatMoney(amountMinor: number, currency: string): string {
  const code = (currency || "").toUpperCase();
  const symbol = SYMBOLS[code];
  const body = formatMinor(amountMinor, code);
  if (symbol) return body.startsWith("-") ? `-${symbol}${body.slice(1)}` : `${symbol}${body}`;
  return `${code} ${body}`;
}

/** A quantity stored in thousandths — 1000 → "1", 2500 → "2.5". Same trick, no division. */
export function formatQuantityMilli(qtyMilli: number): string {
  const n = Math.trunc(qtyMilli);
  const negative = n < 0;
  const digits = String(negative ? -n : n).padStart(4, "0");
  const whole = digits.slice(0, digits.length - 3);
  const frac = digits.slice(digits.length - 3).replace(/0+$/, "");
  return `${negative ? "-" : ""}${group(whole)}${frac ? `.${frac}` : ""}`;
}

/** Basis points as a percentage: 2000 → "20%", 1750 → "17.5%". Still no division. */
export function formatBps(bps: number): string {
  const n = Math.trunc(bps);
  const negative = n < 0;
  const digits = String(negative ? -n : n).padStart(3, "0");
  const whole = digits.slice(0, digits.length - 2);
  const frac = digits.slice(digits.length - 2).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}%`;
}
