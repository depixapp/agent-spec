// verify-vectors.mjs — CI guard so the signing vectors can't silently rot.
//
// Self-contained (Node built-ins only, no sibling repos): it reproduces the
// DePix BACKEND verification logic and asserts that EVERY committed vector still
// verifies. If someone edits a vector by hand and breaks it, CI goes red here.
//
//   node scripts/verify-vectors.mjs
//
// What it checks, per agent-auth vector:
//   1. Rebuilds the canonical string from the fields and confirms it equals the
//      recorded `canonical_string` (documents-match-data).
//   2. sha256(canonical_body) equals the recorded body hash.
//   3. The Ed25519 signature verifies under the recorded public key using the
//      SAME construction as the backend (raw key wrapped in an SPKI header,
//      node:crypto.verify with algorithm=null).
//   4. A one-byte tamper (timestamp+1) is REJECTED (the check has teeth).
// Per webhook vector: HMAC-SHA256 over `${t}.${payload}` equals `expected_v1_hex`.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(HERE, "..", "signing", "vectors");

const AUTH_SCHEME_VERSION = "depix-agent-auth:v1";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data ?? "", "utf8").digest("hex");
}

function buildCanonicalString({ scheme, audience, method, path, timestamp, nonce, canonicalBody }) {
  return [scheme, audience, String(method).toUpperCase(), path, String(timestamp), nonce, sha256Hex(canonicalBody ?? "")].join("\n");
}

// Exactly the backend's verifyAgentSignature construction.
function backendVerify(publicKeyHex, signatureHex, message) {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]);
    const keyObject = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

let failures = 0;
const fail = (msg) => { failures++; console.error("  FAIL:", msg); };
const pass = (msg) => console.log("  ok:", msg);

// ── agent-auth ───────────────────────────────────────────────────────────────
const aa = JSON.parse(readFileSync(join(VECTORS_DIR, "agent-auth.json"), "utf8"));
console.log(`agent-auth.json — ${aa.vectors.length} vectors`);
for (const v of aa.vectors) {
  const canonical = buildCanonicalString({
    scheme: aa.scheme,
    audience: v.audience ?? aa.audience,
    method: v.method,
    path: v.path,
    timestamp: v.timestamp,
    nonce: v.nonce,
    canonicalBody: v.canonical_body,
  });
  if (canonical !== v.canonical_string) fail(`[${v.name}] rebuilt canonical_string differs from the recorded one`);
  else if (sha256Hex(v.canonical_body) !== v.body_sha256_hex) fail(`[${v.name}] body_sha256_hex mismatch`);
  else if (!backendVerify(v.public_key_hex, v.signature_hex, v.canonical_string)) fail(`[${v.name}] signature does NOT verify under the backend construction`);
  else {
    const tampered = canonical.replace(`\n${v.timestamp}\n`, `\n${Number(v.timestamp) + 1}\n`);
    if (backendVerify(v.public_key_hex, v.signature_hex, tampered)) fail(`[${v.name}] a tampered canonical still verifies (guard has no teeth)`);
    else pass(v.name);
  }
}

// ── webhook ──────────────────────────────────────────────────────────────────
const wh = JSON.parse(readFileSync(join(VECTORS_DIR, "webhook.json"), "utf8"));
console.log(`webhook.json — ${wh.vectors.length} vectors`);
for (const v of wh.vectors) {
  const mac = crypto.createHmac("sha256", wh.test_secret.value).update(`${v.timestamp}.${v.payload}`, "utf8").digest("hex");
  if (mac !== v.expected_v1_hex) fail(`[${v.name}] HMAC recompute != expected_v1_hex`);
  else if (v.header !== `t=${v.timestamp},v1=${v.expected_v1_hex}`) fail(`[${v.name}] header string malformed`);
  else pass(v.name);
}

if (failures > 0) {
  console.error(`\nverify-vectors: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nverify-vectors: all vectors verify.");
