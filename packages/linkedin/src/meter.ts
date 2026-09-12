// Bytes on the wire, per LinkedIn account. Measured, not assumed.
//
// LinkedIn egress is bought per gigabyte through a residential proxy, and the bill is dominated by
// the SYNC path, not the send path. At 5,000 accounts the difference between a naive inbox poll and
// a cheap one is roughly $3,855/month versus $343/month — an order of magnitude, decided entirely by
// how many bytes a sync costs. A cost that large should not be an estimate in a design document, so
// every Voyager call records what it actually transferred and this is where the number lives.
//
// In-memory and per-process on purpose: it is an operational gauge, not an accounting ledger. It
// answers "is the sync path behaving the way we designed it" in seconds, and a restart losing it is
// the correct trade for zero write amplification on the hot path.

export interface OpUsage {
  requests: number;
  /** Compressed length on the wire (content-length), which is what the proxy actually bills. */
  wire_bytes: number;
  /** Decoded JSON length — the gzip ratio is wire/decoded, and worth seeing. */
  decoded_bytes: number;
  /** Request bodies (sends). Small, but they are the only bytes the send path spends. */
  up_bytes: number;
  /** Responses served entirely from a cursor delta with nothing changed. */
  empty_deltas: number;
}

export interface AccountUsage extends OpUsage {
  connection_id: string;
  since: string;
  last_at?: string;
  by_op: Record<string, OpUsage>;
  /** Straight-line extrapolation of wire bytes to 30 days. The number the bill is made of. */
  projected_monthly_wire_bytes: number;
  /** wire/decoded, so a regression in compression is visible rather than inferred. */
  compression_ratio?: number;
}

function blank(): OpUsage {
  return { requests: 0, wire_bytes: 0, decoded_bytes: 0, up_bytes: 0, empty_deltas: 0 };
}

interface Row extends OpUsage {
  since: number;
  last_at?: number;
  by_op: Map<string, OpUsage>;
}

const rows = new Map<string, Row>();

function rowFor(connectionId: string): Row {
  let r = rows.get(connectionId);
  if (!r) {
    r = { ...blank(), since: Date.now(), by_op: new Map() };
    rows.set(connectionId, r);
  }
  return r;
}

/** Record one Voyager round-trip. `op` is a coarse label ("sync", "send", "self") — never a URL
 *  with a conversation id in it, because this map is read by humans and dumped into diagnostics. */
export function recordTransfer(
  connectionId: string,
  op: string,
  t: { wire?: number; decoded?: number; up?: number; emptyDelta?: boolean },
): void {
  if (!connectionId) return;
  const r = rowFor(connectionId);
  const o = r.by_op.get(op) ?? blank();
  const wire = Math.max(0, t.wire ?? 0);
  const decoded = Math.max(0, t.decoded ?? 0);
  const up = Math.max(0, t.up ?? 0);
  for (const target of [r, o]) {
    target.requests += 1;
    target.wire_bytes += wire;
    target.decoded_bytes += decoded;
    target.up_bytes += up;
    if (t.emptyDelta) target.empty_deltas += 1;
  }
  r.by_op.set(op, o);
  r.last_at = Date.now();
}

const DAY = 86_400_000;

function shape(id: string, r: Row): AccountUsage {
  const elapsed = Math.max(Date.now() - r.since, 60_000); // don't extrapolate from a millisecond
  return {
    connection_id: id,
    since: new Date(r.since).toISOString(),
    last_at: r.last_at ? new Date(r.last_at).toISOString() : undefined,
    requests: r.requests,
    wire_bytes: r.wire_bytes,
    decoded_bytes: r.decoded_bytes,
    up_bytes: r.up_bytes,
    empty_deltas: r.empty_deltas,
    by_op: Object.fromEntries(r.by_op),
    projected_monthly_wire_bytes: Math.round((r.wire_bytes / elapsed) * 30 * DAY),
    compression_ratio: r.decoded_bytes > 0 ? Number((r.wire_bytes / r.decoded_bytes).toFixed(3)) : undefined,
  };
}

export function usageFor(connectionId: string): AccountUsage | undefined {
  const r = rows.get(connectionId);
  return r ? shape(connectionId, r) : undefined;
}

export function allUsage(): AccountUsage[] {
  return [...rows.entries()].map(([id, r]) => shape(id, r));
}

export function forgetUsage(connectionId: string): void {
  rows.delete(connectionId);
}

/** Test hook. */
export function _resetUsage(): void {
  rows.clear();
}
