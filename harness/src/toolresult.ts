// Bounding what an action gives BACK to the agent.
//
// THE TWO FAILURES THIS SITS BETWEEN, both of which we have shipped.
//
// Failure one — the empty result. The action proxy's answer to the sandbox was, for a long time,
// effectively `{ok: true, detail: "ok"}`: `executeAction` returned Composio's `data` but several
// executors did not populate it at all, and the ones that did handed back whatever the provider
// said with no promise that anything useful was in it. So an agent would create an invoice, be told
// "ok", and then have to invent the invoice id for the follow-up message — or, more often, write
// "I have created the invoice" and end the run with no id recorded anywhere. The action succeeded
// and the RUN failed, which is the expensive kind of failure: a human has to go and look up what
// the agent just did.
//
// Failure two — the flood. The obvious fix is to return the provider's response verbatim. That is
// fine for `create_invoice` and catastrophic for `search`. A HubSpot contact search or a Sheets
// range read answers with thousands of rows; `c.json({data: result.data})` pastes every one of them
// through the proxy, into a `curl` result, into the agent's next model call. One such call can
// exceed the entire token budget of a `decide` run, and it does so at the worst moment — after the
// side effect has already happened, so aborting costs the work.
//
// So: results come back STRUCTURED and BOUNDED. Arrays are headed and counted, strings are clipped,
// depth is capped, and — the part that makes the difference in practice — identifiers survive the
// clipping, because the id is the one field the next step actually needs.
//
// This is deliberately NOT `redactPreview` from actions.ts, though the two look alike. That one is
// about what a HUMAN may safely be shown on an approval card and is subtractive on secret-looking
// key names. This one is about what fits in a model's context window and is subtractive on VOLUME.
// A single function trying to be both was rejected: their limits move for unrelated reasons, and
// tying them means a decision about approval-card readability silently changes how much of a CRM
// query an agent gets to see.

/** Result envelope handed to the sandbox. `truncated` is load-bearing: see `note`. */
export interface BoundedResult {
  ok: boolean;
  detail?: string;
  code?: string;
  data?: unknown;
  /** True when anything at all was clipped, dropped or summarised out of `data`. */
  truncated?: boolean;
  /**
   * Prose for the agent, present only when `truncated`.
   *
   * A machine flag is not enough. An agent that receives 20 of 4,312 rows and is told nothing will
   * confidently report "there are 20 overdue invoices". The note is what turns a truncation into
   * a fact the agent can act on ("narrow the query"), rather than a silent lie.
   */
  note?: string;
}

export interface BoundLimits {
  /** Total serialized size of `data` we are willing to hand back. */
  bytes: number;
  /** Elements kept from any array. */
  items: number;
  /** Characters kept from any single string value. */
  chars: number;
  /** Object nesting kept. */
  depth: number;
  /** Keys kept from any single object. */
  keys: number;
}

/**
 * Defaults sized against the run that motivated them.
 *
 * 8 KB is roughly 2,000 tokens — one result may cost about what a knowledge file costs, and no
 * more. Twenty items is enough to answer "which invoices are overdue" for a real small business
 * and small enough that a 10,000-row CRM query cannot be pasted into a model context. Both are
 * overridable per call site because a read (`/v1/internal/reads`, already capped at 256 KB of
 * transport) can afford more than a write's confirmation.
 */
export const DEFAULT_BOUNDS: BoundLimits = { bytes: 8 * 1024, items: 20, chars: 2000, depth: 6, keys: 40 };

/**
 * Keys worth keeping when everything else is being thrown away.
 *
 * When an object has to be dropped for size, dropping it WHOLE loses the identifier — and the
 * identifier is the entire reason the agent made the call. `{"id": "INV-204"}` is a useful result;
 * `"[dropped]"` is not, even though both are small. Matched loosely because every provider spells
 * it differently: Xero says `InvoiceID`, Stripe says `id`, Gmail says `messageId`, HubSpot says
 * `hs_object_id`.
 */
const ID_KEY = /^(id|.*_id|.*id|uid|uuid|key|slug|name|url|link|status|state|number|reference|ref)$/i;

interface Ctx {
  lim: BoundLimits;
  truncated: boolean;
  notes: Set<string>;
}

function clipValue(v: unknown, depth: number, ctx: Ctx): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    if (v.length <= ctx.lim.chars) return v;
    ctx.truncated = true;
    ctx.notes.add("long text values were clipped");
    return `${v.slice(0, ctx.lim.chars)}… [${v.length} chars total]`;
  }
  if (typeof v !== "object") return v;

  if (depth >= ctx.lim.depth) {
    ctx.truncated = true;
    ctx.notes.add("deeply nested structures were collapsed");
    return Array.isArray(v) ? `[${v.length} items, too deeply nested to show]` : "[nested object]";
  }

  if (Array.isArray(v)) {
    const head = v.slice(0, ctx.lim.items).map((x) => clipValue(x, depth + 1, ctx));
    if (v.length > ctx.lim.items) {
      ctx.truncated = true;
      ctx.notes.add(`only the first ${ctx.lim.items} of ${v.length} results are shown`);
      // The count goes in the DATA, not just the note: an agent reading a JSON body is far more
      // likely to notice a sibling field than a sentence somewhere else in the envelope.
      return { items: head, shown: head.length, total: v.length, truncated: true };
    }
    return head;
  }

  const entries = Object.entries(v as Record<string, unknown>);
  // Identifier-ish keys sort to the front so that if the key cap bites, what survives is what the
  // next step needs. See ID_KEY.
  entries.sort((a, b) => Number(ID_KEY.test(b[0])) - Number(ID_KEY.test(a[0])));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, val] of entries) {
    if (n >= ctx.lim.keys) {
      ctx.truncated = true;
      ctx.notes.add(`objects with more than ${ctx.lim.keys} fields were trimmed`);
      break;
    }
    out[k] = clipValue(val, depth + 1, ctx);
    n++;
  }
  return out;
}

/**
 * Second pass: enforce a hard BYTE ceiling.
 *
 * The per-shape caps above are not sufficient on their own — twenty items of forty keys each is
 * still enormous, and the shapes that blow the budget are exactly the ones nobody anticipated.
 * So after shaping, we measure; if it is still too big we shrink the item cap and reshape, and if
 * even one item does not fit we keep the identifiers and say so. Measuring the real serialization
 * is the only honest check: an estimate is a number that is right until the day it matters.
 */
export function boundData(
  data: unknown,
  limits: Partial<BoundLimits> = {},
): { data: unknown; truncated: boolean; note?: string } {
  const base: BoundLimits = { ...DEFAULT_BOUNDS, ...limits };
  if (data === undefined || data === null) return { data, truncated: false };

  for (const items of [base.items, Math.max(3, Math.floor(base.items / 4)), 1]) {
    const ctx: Ctx = { lim: { ...base, items }, truncated: items !== base.items, notes: new Set() };
    if (items !== base.items) ctx.notes.add(`the result was too large, so only ${items} item(s) are shown`);
    const shaped = clipValue(data, 0, ctx);
    let size = 0;
    try {
      size = JSON.stringify(shaped)?.length ?? 0;
    } catch {
      // Circular or non-serialisable. Nothing downstream can carry it either — the proxy is about
      // to JSON-encode this — so say that plainly rather than throw inside an action response.
      return { data: "[result could not be serialised]", truncated: true, note: "the provider returned a value that is not JSON" };
    }
    if (size <= base.bytes) {
      return {
        data: shaped,
        truncated: ctx.truncated,
        note: ctx.truncated ? Array.from(ctx.notes).join("; ") : undefined,
      };
    }
  }

  // Still too big with one item. Keep whatever identifiers we can find and be explicit that the
  // body is gone: an agent that knows it got only ids can go and fetch one, an agent that got a
  // silently mangled object cannot.
  const ctx: Ctx = { lim: { ...base, items: 1, chars: 120, depth: 2, keys: 8 }, truncated: true, notes: new Set() };
  const minimal = clipValue(data, 0, ctx);
  return {
    data: minimal,
    truncated: true,
    note:
      `the provider's response was larger than this run can read (${base.bytes} bytes). Only ` +
      `identifying fields are shown — narrow the request (filter, date range, or a smaller page) ` +
      `and call again if you need the detail.`,
  };
}

/** Bound a whole action/read result in one call. The shape the sandbox actually receives. */
export function boundResult(
  r: { ok: boolean; detail?: string; code?: string; data?: unknown },
  limits: Partial<BoundLimits> = {},
): BoundedResult {
  const b = boundData(r.data, limits);
  return {
    ok: r.ok,
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
    ...(r.code !== undefined ? { code: r.code } : {}),
    ...(b.data !== undefined ? { data: b.data } : {}),
    ...(b.truncated ? { truncated: true, note: b.note } : {}),
  };
}
