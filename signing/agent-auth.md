# DePix App agent request signing (`depix-agent-auth:v1`)

Normative specification of the Ed25519 request-signing scheme an agent uses to
authenticate to the DePix App API. This is the authoritative, standalone description
of the canonical string an integrator must reproduce byte-for-byte. Test vectors
that exercise every rule below live in
[`vectors/agent-auth.json`](./vectors/agent-auth.json); runnable signers are in
[`../examples/sign-request/`](../examples/sign-request/).

> Scope: this scheme authenticates the agent **account lifecycle** — self-
> onboarding (`POST /api/agents/register`) and the agent-key management routes
> (`/api/agents/keys`, `/api/agents/status`, …). It proves control of the
> agent's identity keypair. It is **independent** of the API-key (`sk_live_` /
> `sk_test_`) auth used on the payment surface, and of the Liquid wallet seed
> that signs transactions. Three separate secrets, three separate jobs.

The words MUST, MUST NOT, SHOULD and MAY are used per RFC 2119.

---

## 1. Overview

Every signed request carries four `X-Agent-*` headers. The server verifies an
Ed25519 signature over a deterministic **canonical string** built from the
request. There is no server-side challenge or session — verification is
stateless (plus a short-lived nonce cache for replay defense), which is what
makes it serverless-friendly.

| Header | Value |
|---|---|
| `X-Agent-Public-Key` | The agent's Ed25519 public key, 32 raw bytes as **64 lowercase hex** chars. |
| `X-Agent-Timestamp` | Unix time in **seconds** (integer, as a decimal string). |
| `X-Agent-Nonce` | A unique, single-use token for this request (see §5). |
| `X-Agent-Signature` | Ed25519 signature over the canonical string (§3), 64 raw bytes as **128 lowercase hex** chars. |

The request body (if any) is sent unchanged on the wire; the signature commits
to it via a hash (§4).

---

## 2. The keypair

- Algorithm: **Ed25519** (RFC 8032). The public key is the 32-byte raw key.
- `X-Agent-Public-Key` is that raw key as 64 lowercase hex chars. It is also the
  agent's stable identity: `POST /api/agents/register` stores it, and every
  later request is matched to the account by this key.
- The private key never leaves the agent. The server only ever holds the public
  key.

**Verifier key encoding.** The server wraps the raw 32-byte public key in the
standard SPKI DER header for Ed25519 (RFC 8410) before verifying:

```
SPKI = 302a300506032b6570032100 || <32-byte raw public key>
```

Most languages accept the raw key directly (Go `ed25519.PublicKey`, Python
`Ed25519PublicKey.from_public_bytes`, `@noble/curves`); the SPKI detail matters
only if your crypto library needs DER-wrapped keys (e.g. Node's `crypto.verify`).

---

## 3. The canonical string

The signed message is exactly **seven lines joined by a single LF (`\n`)**, with
**no trailing newline**:

```
depix-agent-auth:v1        ← 1. scheme version (fixed literal)
api.depixapp.com           ← 2. audience (fixed literal, see §6)
POST                       ← 3. HTTP method, UPPERCASE
/api/agents/keys           ← 4. request path, no query string
1750000456                 ← 5. timestamp — the EXACT X-Agent-Timestamp string
aabbccdd...99              ← 6. nonce — the EXACT X-Agent-Nonce string
e3b0c442...b855            ← 7. sha256hex(canonical_body)  (see §4)
```

Concretely, `canonical = fields.join("\n")` where `fields` is:

1. `depix-agent-auth:v1` — the literal scheme version.
2. `api.depixapp.com` — the literal audience (§6).
3. The HTTP method, upper-cased (`GET`, `POST`, …).
4. The request **path only** — no scheme, host, or query string. Use the path
   exactly as it appears in the URL (e.g. `/api/agents/status`).
5. The timestamp. This MUST be **the exact same string** you put in
   `X-Agent-Timestamp`. Sign the string, don't re-derive it — a signer that
   sends `"1750000456"` but signs over `1750000456` with different formatting
   will fail.
6. The nonce. Again, **the exact same string** you put in `X-Agent-Nonce`.
7. The lowercase hex SHA-256 of the canonical body bytes (§4).

Rules:

- The join separator is a single `\n` (0x0A). Do **not** use `\r\n`.
- There is **no** trailing newline after line 7.
- The public key and the signature themselves are **not** part of the canonical
  string (the public key selects the verifying key; the signature is the
  output).

---

## 4. Body hash and the empty-body rule

Line 7 is `sha256hex(canonical_body)`, where `canonical_body` is a **normalized**
serialization of the request body — **not necessarily the literal wire bytes**.

The normalization (this is the subtle part, and the source of a real
interoperability bug — see the box below):

| Body | `canonical_body` |
|---|---|
| No body / `null` / `undefined` | `""` (empty string) |
| An **empty object** `{}` | `""` (empty string) — **not** `"{}"` |
| Any other JSON value | Compact `JSON.stringify(body)` — no whitespace, keys in **insertion order** |

So both a bodyless `GET` and a `POST` whose body is `{}` sign over
`sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

> ### Why `{}` → `""` (the interop bug)
> The DePix App API runs on a serverless runtime that **parses the JSON body before
> the handler sees it**, then the verifier re-serializes the parsed object to
> rebuild the canonical string. An empty object round-trips through the parser
> and comes back as "no meaningful body", which the server treats as `""`. A
> naive client that signs over the literal string `"{}"` will therefore get a
> **401** on any empty-body POST (e.g. minting a key with all defaults). Your
> serializer MUST map `{}` (and `null`/`undefined`) to `""`.
>
> For non-empty bodies, send **exactly the bytes you signed**. The server
> reproduces `JSON.stringify(parsed)` and both sides are deterministic only if
> you used compact JSON with keys in insertion order and no added whitespace. If
> your language does not guarantee key order on re-serialization, the safest
> approach is: build the JSON string once, sign over it, and send that same
> string as the body.

Vectors: the `GET with no body` and the `EMPTY object body` vectors both pin
`body_sha256_hex = e3b0…b855`; the `register` and `revoke` vectors pin non-empty
compact serializations.

---

## 5. Timestamp window and nonce (replay defense)

**Timestamp.** `X-Agent-Timestamp` is unix **seconds**. The server rejects the
request if `abs(server_now − timestamp) > 300` (a ±5-minute window). On rejection
it returns `agent_signature_expired` and includes the server's clock as
`details.server_time`, so a client with a skewed clock can re-sync and retry.

**Nonce.** `X-Agent-Nonce` MUST be unique per request. The server atomically
records the `(public_key, nonce)` pair on first use and keeps it for **660
seconds** (`2 × window + 60s` margin), rejecting any repeat within that window
with `agent_replay_detected`. Consequences:

- Generate a **fresh** nonce for every request. A 16-byte random value as hex is
  the recommended shape (128 bits — collision-free in practice).
- A signed request is **single-shot**. Never resend the same four headers; to
  retry, **re-sign** with a fresh nonce (and a current timestamp).
- The nonce guard is **fail-closed**: if the server's nonce store is
  unavailable, the request is rejected with `503 service_unavailable`
  (`details.retry_after`), never allowed through. Retry after the delay.

---

## 6. Audience

Line 2 is the fixed literal `api.depixapp.com`. It is **not** the request `Host`
header — it is a constant baked into both the signer and the verifier. This
binds a signature to the production API: a signature minted for a different
environment (whose verifier uses a different audience literal) will not verify in
production, so a proxy cannot forge or replay across environments. Unless you are
explicitly integrating against a non-production DePix App deployment that documents a
different audience, use `api.depixapp.com`.

---

## 7. Server verification order

The server checks, in order, failing closed at the first failure (and never
revealing *which* field failed beyond the typed error):

1. **Header presence & format** — public key is 64 hex, signature is 128 hex,
   nonce present, timestamp is a finite number. Else `401 agent_invalid_signature`.
2. **Timestamp window** — §5. Else `401 agent_signature_expired`
   (`details.server_time`).
3. **Nonce anti-replay** — §5. Reused → `401 agent_replay_detected`; store down →
   `503 service_unavailable`.
4. **Signature** — Ed25519 verify of `X-Agent-Signature` over the canonical
   string (§3). Else `401 agent_invalid_signature`.
5. **Account checks** (only on routes that require an already-registered agent;
   `register` itself skips this): the public key must be a known agent
   (`401 agent_unknown_key`), the account must not be blocked
   (`403 account_blocked`), and for money-touching agent routes the merchant must
   be active (`403 account_suspended`).

`register` is the one route where step 5 is skipped — the key is proving
ownership of itself, not that it is already an agent.

---

## 8. Error codes

| HTTP | code | Meaning / fix |
|---|---|---|
| 401 | `agent_invalid_signature` | Malformed headers or the signature didn't verify. Re-check the canonical string (a wrong body hash or a `\r\n` join is the usual cause). |
| 401 | `agent_signature_expired` | Outside the ±300s window. Re-sign using `details.server_time`. |
| 401 | `agent_replay_detected` | This `(key, nonce)` was already used. Re-sign with a fresh nonce. |
| 401 | `agent_unknown_key` | The public key is not a registered agent. Register first. |
| 403 | `account_blocked` / `account_suspended` | Account state, not a signing problem. |
| 503 | `service_unavailable` | Nonce store unavailable (fail-closed). Retry after `details.retry_after`. |

---

## 9. Implementation checklist

1. Hold an Ed25519 keypair; expose the public key as 64 lowercase hex.
2. For each request, pick `timestamp = floor(now_ms / 1000)` and a fresh random
   `nonce`.
3. Compute `canonical_body` per §4 (remember `{}` → `""`).
4. Build the 7-line canonical string per §3 (LF-joined, no trailing newline).
5. Sign the UTF-8 bytes of that string with Ed25519 → 128 lowercase hex.
6. Send `X-Agent-Public-Key`, `X-Agent-Timestamp`, `X-Agent-Nonce`,
   `X-Agent-Signature`, and — for non-empty bodies — the **exact** bytes you
   hashed as the request body.
7. Validate your implementation against [`vectors/agent-auth.json`](./vectors/agent-auth.json):
   for each vector, rebuilding the canonical string from the fields must equal
   `canonical_string`, and signing it with the test key must reproduce
   `signature_hex` (Ed25519 is deterministic, so this is an exact-match test).

---

## 10. Source of truth

This document is derived from the production implementation:

- Verifier: `depix-backend` `api/_lib/agent-auth.js` — `buildCanonicalString`,
  `getRawBody`, `verifyAgentSignature`, `authenticateAgentRequest`.
- Signer: `depix-mcp` `src/wallet-engine/agent/keypair.ts` —
  `buildCanonicalString`, `canonicalBody`, `signAgentRequest`.
- Parity harness (reproduces the server verifier): `depix-mcp`
  `test/wallet-engine/agent-server-parity.test.ts`.

If this document and the running API ever disagree, the API wins — open an issue
and the discrepancy will be reconciled here.
