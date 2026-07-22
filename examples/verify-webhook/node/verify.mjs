// Verify DePix webhook signatures (Node, zero deps) against the committed test
// vectors. Mirrors what a real receiver does per signing/webhook-signature.md:
//   v1 == hex(HMAC_SHA256(secret, `${t}.${rawBody}`)), constant-time compared.
//
//   node verify.mjs
//
// Exit code 0 = all vectors verified; 1 = a mismatch (or a forced-tamper that
// wrongly passed).

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(here, "..", "..", "..", "signing", "vectors", "webhook.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));
const secret = doc.test_secret.value;

/** Parse "t=...,v1=..." into {t, v1}. */
function parseHeader(header) {
  const out = {};
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Verify one delivery exactly as a receiver should. */
function verify(secret, header, rawBody) {
  const { t, v1 } = parseHeader(header);
  // A real receiver also rejects a stale `t` here (e.g. |now - t| > 300s); the
  // vectors use fixed timestamps, so we only check the HMAC.
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let failures = 0;
for (const v of doc.vectors) {
  const ok = verify(secret, v.header, v.payload);
  console.log(`${ok ? "OK  " : "FAIL"}  ${v.name}`);
  if (!ok) failures++;
}

// Negative control: a tampered body must NOT verify.
const tamperOk = verify(secret, doc.vectors[0].header, doc.vectors[0].payload + " ");
console.log(`${tamperOk ? "FAIL" : "OK  "}  negative control (tampered body is rejected)`);
if (tamperOk) failures++;

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${doc.vectors.length} webhook vectors verified.`);
