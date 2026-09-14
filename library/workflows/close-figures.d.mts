// Types for the close's deterministic arithmetic.
//
// The workflows are plain `.mjs` on purpose — they are FOUNDER CODE, edited by people who will not
// run a build, and a compile step between a founder and their own reconciliation rule is a step that
// ends with the rule not being edited. Three of the sixty-five errors in the test-typecheck baseline
// are exactly this import, untyped.
//
// A declaration file is the version of typing that costs the author nothing: the `.mjs` stays plain
// JavaScript and the callers get the shape. Worth doing here specifically because this return value
// IS the close's output contract — `net_minor`, `difference_minor` and `formatted.*` are quoted
// straight into the deliverable, so a caller reading one of them by the wrong name should not have
// to find out at run time in front of a client.

export interface CloseFiguresArgs {
  transactions: Array<{
    date?: string;
    /** Integer minor units. Negative is money out. */
    amount_minor: number | string;
    description?: string;
    counterparty?: string;
    /** The model's judgement, carried through untouched. This function never guesses one. */
    category?: string;
    /** Still an open question for the client. */
    held?: boolean;
    /** Kept OUT of the operating result meanwhile — a probable-personal payment gets both. */
    excluded?: boolean;
    note?: string;
  }>;
  opening_balance_minor?: number | string;
  /** From the statement. Omitted means the difference cannot be checked, and `reconciled` is false. */
  closing_balance_minor?: number | string | null;
  sales_tax_rate_pct?: number;
  currency?: string;
  period?: string;
  client?: string;
}

export interface CloseFigures {
  currency: string;
  counts: { transactions: number; receipts: number; payments: number };
  opening_balance_minor: number;
  receipts_minor: number;
  /** Negative. */
  payments_minor: number;
  net_movement_minor: number;
  computed_closing_minor: number;
  statement_closing_minor: number | undefined;
  /** `undefined` when no statement figure was supplied — never 0, which would read as agreement. */
  difference_minor: number | undefined;
  reconciled: boolean;
  by_category: Array<{ category: string; amount_minor: number; count: number }>;
  gross_sales_minor: number;
  output_tax_minor: number;
  net_sales_minor: number;
  sales_tax_rate_pct: number;
  held: { amount_minor: number; item_count: number };
  excluded: { amount_minor: number; item_count: number };
  revenue_minor: number;
  expenses_minor: number;
  net_minor: number;
  /** Every figure already written the way a client reads it. Quoted, never converted. */
  formatted: Record<string, string | string[]>;
  /** `ledger.csv` and `bank-reconciliation.md`, rendered. Written to ./output/ byte for byte. */
  files: Record<string, string>;
  /**
   * The spreadsheet, as a SPEC rather than a file: sheets, headings, typed cells, all plain data.
   * The workflow route renders it with `render/xlsx.ts` and attaches it, so the agent never writes
   * a byte of it and cannot retype a figure into it.
   *
   * Declared here because it was not, and a return value the compiler cannot see is a return value
   * nothing can be checked against — which is how `amount_minor` reached a client's header row.
   */
  workbook: {
    filename: string;
    currency?: string;
    sheets: { name: string; header: string[]; rows: unknown[][]; note?: string }[];
  };
}

export default function closeFigures(args: CloseFiguresArgs): CloseFigures;
