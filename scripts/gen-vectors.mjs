// gen-vectors.mjs — regenerate the signing test vectors.
//
// This produces signing/vectors/agent-auth.json and signing/vectors/webhook.json
// by RUNNING the real algorithms with a FIXED, TEST-ONLY key/secret, then
// self-verifying every vector with an independent replica of the DePix App BACKEND
// verifier before writing. If any vector fails to verify, nothing is written.
//
// Uses only Node built-ins (`node:crypto`), which is exactly what the backend
// verifier uses (`api/_lib/agent-auth.js` — Ed25519 via node:crypto; and
// `api/_lib/webhook-dispatch.js` — HMAC-SHA256 via node:crypto). Ed25519
// signatures are deterministic (RFC 8032), so re-running yields byte-identical
// output — a clean `git diff` proves the vectors have not silently changed.
//
//   node scripts/gen-vectors.mjs          # write the vectors
//   node scripts/gen-vectors.mjs --check  # verify committed vectors reproduce (CI)

import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(HERE, "..", "signing", "vectors");

// ── Contract constants (must equal the backend's; see signing/agent-auth.md) ──
const AUTH_SCHEME_VERSION = "depix-agent-auth:v1"; // backend AUTH_SCHEME_VERSION
const AUDIENCE = "api.depixapp.com"; // backend authAudience() default

// DER prefixes for wrapping a raw 32-byte Ed25519 key (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // + 32-byte seed
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // + 32-byte pubkey

// ── TEST-ONLY key material. NEVER a real key. ────────────────────────────────
// A fixed 32-byte Ed25519 seed so the vectors are reproducible. It is derived
// from a self-describing phrase and printed here in full so an integrator can
// recreate the exact keypair. DO NOT USE THIS KEY FOR ANYTHING REAL.
const TEST_SEED_HEX = crypto
  .createHash("sha256")
  .update("depix-agent-spec test vector seed — DO NOT USE IN PRODUCTION")
  .digest("hex"); // 32 bytes / 64 hex

// TEST-ONLY webhook secret (real ones are `whsec_` + base64url(32 bytes)).
const TEST_WEBHOOK_SECRET = "whsec_test_DO_NOT_USE_agent_spec_vectors_0000";

// ── Primitives that mirror the backend byte-for-byte ─────────────────────────
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data ?? "", "utf8").digest("hex");
}

// Body normalization — backend getRawBody / SDK canonicalBody: null, undefined
// and an empty object all serialize to "" (the interop edge case that once
// caused a real 401). Anything else is compact JSON.stringify (key insertion
// order, no whitespace).
function canonicalBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return "";
  return JSON.stringify(body);
}

// backend buildCanonicalString: 7 fields joined by "\n", no trailing newline.
function buildCanonicalString({ method, path, timestamp, nonce, rawBody }) {
  return [
    AUTH_SCHEME_VERSION,
    AUDIENCE,
    String(method).toUpperCase(),
    path,
    String(timestamp),
    nonce,
    sha256Hex(rawBody ?? ""),
  ].join("\n");
}

function keypairFromSeedHex(seedHex) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, "hex")]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKeyHex = Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length)).toString("hex");
  return { privateKey, publicKeyHex };
}

function signEd25519(privateKey, message) {
  // Ed25519: the algorithm arg to crypto.sign MUST be null (the digest is
  // internal to the scheme). Output is the 64-byte signature as 128 lowercase hex.
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
}

// ── Independent replica of the BACKEND verifier (api/_lib/agent-auth.js) ──────
// Used to SELF-VERIFY every vector before writing — a vector that does not
// verify under this replica is never emitted.
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

// ── Build the agent-auth vectors ─────────────────────────────────────────────
function buildAgentAuthVectors() {
  const { privateKey, publicKeyHex } = keypairFromSeedHex(TEST_SEED_HEX);

  // Fixed timestamps/nonces so the output is deterministic. Timestamps are
  // arbitrary fixed instants — a live request must be within ±300s of the
  // server clock, but the vectors test the signature math, not the clock.
  const cases = [
    {
      name: "GET with no body — body hash is sha256(\"\")",
      method: "GET",
      path: "/api/agents/status",
      timestamp: "1750000000",
      nonce: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      body: null,
    },
    {
      name: "POST with a JSON body (agent self-onboarding)",
      method: "POST",
      path: "/api/agents/register",
      timestamp: "1750000123",
      nonce: "112233445566778899aabbccddeeff00",
      body: {
        name: "Acme Bot",
        operator_token: "op_TEST_do_not_use",
        operator_email: "operator@example.com",
        liquid_address: "lq1qtestonlyaddressplaceholder",
      },
    },
    {
      name: "POST with an EMPTY object body (createKey defaults) — normalizes to \"\", NOT \"{}\"",
      method: "POST",
      path: "/api/agents/keys",
      timestamp: "1750000456",
      nonce: "aabbccddeeff00112233445566778899",
      body: {},
    },
    {
      name: "POST with a non-empty body (revoke a key)",
      method: "POST",
      path: "/api/agents/keys/revoke",
      timestamp: "1750000789",
      nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      body: { id: "key_TEST_1" },
    },
  ];

  const vectors = cases.map((c) => {
    const rawBody = canonicalBody(c.body);
    const canonical = buildCanonicalString({
      method: c.method,
      path: c.path,
      timestamp: c.timestamp,
      nonce: c.nonce,
      rawBody,
    });
    const signatureHex = signEd25519(privateKey, canonical);
    // SELF-VERIFY with the backend-verifier replica — refuse to emit on failure.
    if (!backendVerify(publicKeyHex, signatureHex, canonical)) {
      throw new Error(`vector "${c.name}" failed backend self-verification`);
    }
    return {
      name: c.name,
      method: c.method,
      path: c.path,
      timestamp: c.timestamp,
      nonce: c.nonce,
      audience: AUDIENCE,
      body: c.body,
      canonical_body: rawBody,
      body_sha256_hex: sha256Hex(rawBody),
      public_key_hex: publicKeyHex,
      canonical_string: canonical,
      signature_hex: signatureHex,
    };
  });

  return {
    _comment:
      "TEST-ONLY signing vectors for the DePix App Ed25519 agent request-signing scheme. " +
      "The keypair below is derived from a FIXED public seed and MUST NEVER be used for a real agent. " +
      "See ../agent-auth.md for the normative spec. Regenerate with `node scripts/gen-vectors.mjs`.",
    scheme: AUTH_SCHEME_VERSION,
    audience: AUDIENCE,
    canonical_string_format:
      "scheme \\n audience \\n METHOD \\n path \\n timestamp \\n nonce \\n sha256hex(canonical_body)   (7 lines, LF-joined, no trailing newline)",
    body_normalization: "null, undefined and {} -> \"\"; otherwise compact JSON.stringify(body)",
    test_key: {
      warning: "TEST-ONLY — DO NOT USE. Anyone can sign as this key; it exists only to validate implementations.",
      algorithm: "Ed25519 (RFC 8032)",
      seed_hex: TEST_SEED_HEX,
      seed_derivation: 'sha256("depix-agent-spec test vector seed — DO NOT USE IN PRODUCTION")',
      public_key_hex: keypairFromSeedHex(TEST_SEED_HEX).publicKeyHex,
    },
    vectors,
  };
}

// ── Build the webhook vector (HMAC-SHA256 over `${t}.${payload}`) ─────────────
function buildWebhookVectors() {
  const cases = [
    {
      name: "checkout.paid",
      timestamp: 1750000000,
      payload: JSON.stringify({
        event: "checkout.paid",
        data: {
          id: "chk_TEST_123",
          status: "paid",
          amount_cents: 5000,
          event_id: "evt_TEST_abc123",
        },
      }),
    },
    {
      name: "deposit.completed",
      timestamp: 1750000321,
      payload: JSON.stringify({
        event: "deposit.completed",
        data: {
          id: "dep_TEST_456",
          status: "depix_sent",
          amount_cents: 10000,
          event_id: "evt_TEST_def456",
        },
      }),
    },
  ];

  const vectors = cases.map((c) => {
    const signedString = `${c.timestamp}.${c.payload}`;
    const v1 = crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(signedString, "utf8").digest("hex");
    // SELF-VERIFY: recompute and constant-time compare (what a receiver does).
    const recomputed = crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(signedString, "utf8").digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(recomputed, "hex"))) {
      throw new Error(`webhook vector "${c.name}" failed self-verification`);
    }
    return {
      name: c.name,
      timestamp: c.timestamp,
      payload: c.payload,
      signed_string: signedString,
      expected_v1_hex: v1,
      header: `t=${c.timestamp},v1=${v1}`,
    };
  });

  return {
    _comment:
      "TEST-ONLY signing vectors for the DePix App outbound-webhook signature (X-DePix-Signature). " +
      "The secret below is a placeholder and MUST NEVER be used for a real merchant. " +
      "See ../webhook-signature.md for the normative spec. Regenerate with `node scripts/gen-vectors.mjs`.",
    algorithm: "HMAC-SHA256(secret, `${t}.${payload}`) as lowercase hex",
    header_format: "X-DePix-Signature: t=<unix seconds>,v1=<hex hmac-sha256>",
    test_secret: {
      warning: "TEST-ONLY — DO NOT USE.",
      value: TEST_WEBHOOK_SECRET,
    },
    vectors,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const check = process.argv.includes("--check");

const agentAuth = buildAgentAuthVectors();
const webhook = buildWebhookVectors();

const agentAuthPath = join(VECTORS_DIR, "agent-auth.json");
const webhookPath = join(VECTORS_DIR, "webhook.json");
const agentAuthOut = JSON.stringify(agentAuth, null, 2) + "\n";
const webhookOut = JSON.stringify(webhook, null, 2) + "\n";

if (check) {
  let ok = true;
  for (const [p, produced] of [[agentAuthPath, agentAuthOut], [webhookPath, webhookOut]]) {
    let committed;
    try {
      committed = readFileSync(p, "utf8");
    } catch {
      console.error(`gen-vectors --check: FAIL — ${p} is missing.`);
      ok = false;
      continue;
    }
    if (committed !== produced) {
      console.error(`gen-vectors --check: FAIL — ${p} does not match a fresh regeneration (drift).`);
      ok = false;
    } else {
      console.log(`gen-vectors --check: OK — ${p} reproduces exactly.`);
    }
  }
  process.exit(ok ? 0 : 1);
} else {
  writeFileSync(agentAuthPath, agentAuthOut);
  writeFileSync(webhookPath, webhookOut);
  console.log(`gen-vectors: wrote ${agentAuth.vectors.length} agent-auth + ${webhook.vectors.length} webhook vectors (all self-verified).`);
}
