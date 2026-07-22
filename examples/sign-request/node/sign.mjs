// Sign DePix agent requests (Node, zero deps) and prove the result matches the
// committed vectors. Implements the scheme from signing/agent-auth.md end to
// end: rebuild the canonical string from the request fields, sign it with the
// TEST-ONLY key, and assert both the canonical string and the signature match
// the vector exactly (Ed25519 is deterministic, so this is an exact-match test).
//
//   node sign.mjs
//
// Exit code 0 = every vector reproduced; 1 = a mismatch.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(here, "..", "..", "..", "signing", "vectors", "agent-auth.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s ?? "", "utf8").digest("hex");
}

// Body normalization (signing/agent-auth.md §4): null/undefined/{} -> "".
function canonicalBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return "";
  return JSON.stringify(body);
}

// The 7-line canonical string (signing/agent-auth.md §3).
function buildCanonicalString({ scheme, audience, method, path, timestamp, nonce, body }) {
  return [scheme, audience, method.toUpperCase(), path, timestamp, nonce, sha256Hex(canonicalBody(body))].join("\n");
}

// Reconstruct the Ed25519 private key from the raw 32-byte seed.
function privateKeyFromSeedHex(seedHex) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, "hex")]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

const privateKey = privateKeyFromSeedHex(doc.test_key.seed_hex);

let failures = 0;
for (const v of doc.vectors) {
  const canonical = buildCanonicalString({
    scheme: doc.scheme,
    audience: v.audience ?? doc.audience,
    method: v.method,
    path: v.path,
    timestamp: v.timestamp,
    nonce: v.nonce,
    body: v.body,
  });
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("hex");

  const canonicalOk = canonical === v.canonical_string;
  const sigOk = signature === v.signature_hex;
  const ok = canonicalOk && sigOk;
  console.log(`${ok ? "OK  " : "FAIL"}  ${v.name}`);
  if (!canonicalOk) console.log("      canonical string mismatch");
  if (!sigOk) console.log("      signature mismatch");
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`\n${failures} vector(s) did not reproduce`);
  process.exit(1);
}
console.log(`\nAll ${doc.vectors.length} agent-auth vectors reproduced (canonical + signature).`);
