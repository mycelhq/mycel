// Versioned deterministic packs the agent may CALL by name — never author.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// Authored services (business-shaper draft_service) cannot ship `workflows/*.mjs` because that is
// executable founder code with no provenance story for model-written files. But without named
// mechanics, share-of-voice, bill lines, and fee math fall back to prose — and a client billed on a
// rounded number never trusts the report again.
//
// Packs are the middle path from vision.md: pinned digests, declared schemas, loaded from disk (or
// later a signed object store). An authored manifest may *reference* `packs: ["share_of_voice@1"]`;
// it may not invent the function body.
//
// Trust model matches workflows.ts: the agent selects WHICH pack and WHAT JSON args; the pack owns
// exactness. Side effects still go through connections + approvals.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateOutput } from "./validate";
import { wedgesDir } from "./wedge";

export interface PackSpec {
  /** Logical name, e.g. `share_of_voice`. */
  name: string;
  /** Integer major version pinned in manifests as `name@version`. */
  version: number;
  /** Content digest (sha256 hex) of the entry file — what "pinned" means. */
  digest: string;
  description?: string;
  input_schema?: unknown;
  output_schema?: unknown;
  /** Absolute path to the .mjs entry. */
  entry: string;
}

export interface PackResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  ms?: number;
  digest?: string;
}

const TIMEOUT_MS = Number(process.env.MYCEL_PACK_TIMEOUT_MS ?? 5_000);
const cache = new Map<string, (args: Record<string, unknown>) => unknown>();
let catalogMemo: PackSpec[] | null = null;

/** `share_of_voice@1` → { name, version }. Bare name means version 1. */
export function parsePackRef(ref: string): { name: string; version: number } | undefined {
  const m = /^([a-z][a-z0-9_-]{0,63})(?:@([1-9][0-9]{0,3}))?$/i.exec(ref.trim());
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), version: m[2] ? Number(m[2]) : 1 };
}

function packsRoot(): string {
  return process.env.MYCEL_PACKS_DIR?.trim() || join(wedgesDir(), "..", "packs");
}

/**
 * Discover installed packs. Layout:
 *
 *   packs/<name>/<version>/pack.json + run.mjs
 *
 * pack.json: { "name", "version", "digest", "description?", "input_schema?", "output_schema?" }
 * digest must match sha256 of run.mjs bytes (hex). A mismatch is a boot/load refusal — never run.
 */
export function listPacks(): PackSpec[] {
  if (catalogMemo) return catalogMemo;
  const root = packsRoot();
  const out: PackSpec[] = [];
  if (!existsSync(root)) {
    catalogMemo = out;
    return out;
  }
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const nameDir = join(root, name.name);
    for (const ver of readdirSync(nameDir, { withFileTypes: true })) {
      if (!ver.isDirectory()) continue;
      const dir = join(nameDir, ver.name);
      const metaPath = join(dir, "pack.json");
      const entry = join(dir, "run.mjs");
      if (!existsSync(metaPath) || !existsSync(entry)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PackSpec & { digest?: string };
        const version = Number(meta.version ?? ver.name);
        if (!Number.isFinite(version) || version < 1) continue;
        const digest = String(meta.digest ?? "").trim();
        if (!/^[a-f0-9]{64}$/i.test(digest)) continue;
        out.push({
          name: String(meta.name ?? name.name).toLowerCase(),
          version,
          digest: digest.toLowerCase(),
          description: meta.description,
          input_schema: meta.input_schema,
          output_schema: meta.output_schema,
          entry,
        });
      } catch {
        // Skip broken pack dirs rather than refusing the whole catalog.
      }
    }
  }
  catalogMemo = out;
  return out;
}

export function _resetPackCatalog(): void {
  catalogMemo = null;
  cache.clear();
}

export function resolvePack(ref: string): PackSpec | undefined {
  const parsed = parsePackRef(ref);
  if (!parsed) return undefined;
  return listPacks().find((p) => p.name === parsed.name && p.version === parsed.version);
}

export async function runPack(ref: string, args: Record<string, unknown>): Promise<PackResult> {
  const spec = resolvePack(ref);
  if (!spec) return { ok: false, error: `unknown pack "${ref}"` };

  // Digest check every run — a swapped file must not execute under a pinned name.
  const { createHash } = await import("node:crypto");
  const bytes = readFileSync(spec.entry);
  const live = createHash("sha256").update(bytes).digest("hex");
  if (live !== spec.digest) {
    return {
      ok: false,
      error: `pack "${ref}" digest mismatch — installed ${spec.digest.slice(0, 12)}…, file is ${live.slice(0, 12)}…; refusing to run`,
      digest: live,
    };
  }

  if (spec.input_schema) {
    const v = validateOutput(JSON.stringify(args ?? {}), spec.input_schema);
    if (!v.ok) return { ok: false, error: `invalid args: ${v.errors.join("; ")}` };
  }

  const cacheKey = `${spec.name}@${spec.version}:${spec.digest}`;
  let fn = cache.get(cacheKey);
  if (!fn) {
    try {
      const mod = (await import(pathToFileURL(spec.entry).href)) as Record<string, unknown>;
      const candidate = (mod.default ?? mod.run) as unknown;
      if (typeof candidate !== "function") {
        return { ok: false, error: `pack ${ref} must export a default function (or run)` };
      }
      fn = candidate as (a: Record<string, unknown>) => unknown;
      cache.set(cacheKey, fn);
    } catch (e) {
      return { ok: false, error: `failed to load pack: ${String((e as Error)?.message ?? e)}` };
    }
  }

  const started = Date.now();
  try {
    const data = await Promise.race([
      Promise.resolve(fn(args ?? {})),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error(`pack timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
    if (spec.output_schema) {
      const v = validateOutput(JSON.stringify(data ?? null), spec.output_schema);
      if (!v.ok) return { ok: false, error: `pack output invalid: ${v.errors.join("; ")}`, ms: Date.now() - started };
    }
    return { ok: true, data, ms: Date.now() - started, digest: spec.digest };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), ms: Date.now() - started };
  }
}
