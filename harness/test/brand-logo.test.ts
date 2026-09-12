// The logo-as-image decision, asserted in isolation.
//
// `GET /v1/portal/logo` serves the tenant's mark as its own cacheable image so the 256KB of base64
// never rides the per-page brand read. The one decision that route makes — decode the stored base64
// to bytes with the audited mime, or 404 so the header falls back to the wordmark — is `decodeBrandLogo`,
// pulled out here precisely so "no logo set → nothing to serve" is a test rather than a hope.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeBrandLogo, type BrandLogo } from "../src/brandkit";

const PNG: BrandLogo = {
  mime: "image/png",
  // "mycel" as bytes — arbitrary, we only care that the exact bytes round-trip.
  data: Buffer.from("mycel").toString("base64"),
  width: 5,
  height: 1,
};

test("decodeBrandLogo: no logo set → undefined, so the caller 404s and falls back to the name", () => {
  assert.equal(decodeBrandLogo(undefined), undefined);
});

test("decodeBrandLogo: empty data is treated as no logo, never as an empty image", () => {
  assert.equal(decodeBrandLogo({ ...PNG, data: "" }), undefined);
});

test("decodeBrandLogo: decodes the stored base64 to the exact bytes with the audited content-type", () => {
  const img = decodeBrandLogo(PNG);
  assert.ok(img);
  assert.equal(img.contentType, "image/png");
  assert.equal(Buffer.from(img.bytes).toString(), "mycel");
});

test("decodeBrandLogo: jpeg mime is carried through verbatim", () => {
  const img = decodeBrandLogo({ ...PNG, mime: "image/jpeg" });
  assert.ok(img);
  assert.equal(img.contentType, "image/jpeg");
});
