#!/usr/bin/env node
// Run packages/linkedin/scripts/verify-profile.ts against the PRODUCTION LinkedIn session.
//
// Reads the vaulted session and the vaulted proxy url straight out of the prod `secrets` table,
// decrypts them in memory with MYCEL_SECRET_KEY, and hands them to the verify script as env vars.
// Nothing is written to disk, and no credential is printed — only fingerprints.
//
//   DBURL=… MYCEL_SECRET_KEY=… node kernel/harness/scripts/verify-profile-prod.mjs <connectionId> <publicId> [--all]
import { createDecipheriv, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

const [connectionId, publicId, ...rest] = process.argv.slice(2);
if (!connectionId || !publicId) {
  console.error("usage: verify-profile-prod.mjs <connectionId> <publicId> [--all] [--json]");
  process.exit(2);
}

const raw = process.env.MYCEL_SECRET_KEY ?? "";
const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
if (key.length !== 32) {
  console.error(`MYCEL_SECRET_KEY must be 32 bytes (got ${key.length})`);
  process.exit(2);
}
const kid = createHash("sha256").update(key).digest("hex").slice(0, 8);

function open_(row) {
  if (row.kid !== kid) throw new Error(`row sealed with key ${row.kid}, current key is ${kid}`);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
  d.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(row.ct, "base64")), d.final()]).toString("utf8");
}

const fp = (v) => (!v ? "(absent)" : v.length <= 8 ? `${v.length} chars` : `${v.length} chars, ends …${v.slice(-4)}`);

const pool = new pg.Pool({ connectionString: process.env.DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
const get = async (k) => {
  const r = await pool.query(`SELECT v, kid, iv, tag, ct FROM secrets WHERE key=$1`, [k]);
  return r.rows[0] ? open_(r.rows[0]) : undefined;
};
const sessionJson = await get(connectionId);
const proxyUrl = await get(`${connectionId}:proxy`);
await pool.end();

if (!sessionJson) throw new Error(`no vaulted session for ${connectionId}`);
if (!proxyUrl) throw new Error(`no vaulted proxy for ${connectionId} — refusing to egress directly`);
const session = JSON.parse(sessionJson);

const u = new URL(proxyUrl);
console.log(`session:  li_at ${fp(session.li_at)}, JSESSIONID ${fp(session.jsessionid)}`);
console.log(`self_urn: ${session.self_urn ?? "(absent)"}`);
console.log(`proxy:    ${u.protocol}//${u.username ? "***@" : ""}${u.host}  (user ${fp(u.username)}, pass ${fp(u.password)})`);
console.log(`target:   ${publicId}\n`);

const tsx = path.join(repo, "packages/linkedin/node_modules/.bin/tsx");
const script = path.join(repo, "packages/linkedin/scripts/verify-profile.ts");
const child = spawn(tsx, [script, publicId, ...rest], {
  stdio: "inherit",
  env: {
    ...process.env,
    MYCEL_SECRET_KEY: undefined,
    DBURL: undefined,
    MYCEL_LI_AT: session.li_at,
    MYCEL_JSESSIONID: session.jsessionid,
    MYCEL_LI_PROXY: proxyUrl,
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
