# DePix App webhook signature (`X-DePix-Signature`)

Normative specification of the signature on **outbound** webhooks DePix App delivers
to a merchant's callback URL. A receiver uses it to prove a delivery genuinely
came from DePix App and was not tampered with or replayed. Test vectors are in
[`vectors/webhook.json`](./vectors/webhook.json); runnable verifiers in
[`../examples/verify-webhook/`](../examples/verify-webhook/).

---

## 1. The header

Every webhook POST carries:

```
X-DePix-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

Two comma-separated `key=value` fields:

- `t` — the unix timestamp (**seconds**) at which DePix App signed the delivery.
- `v1` — the signature: **HMAC-SHA256**, lowercase hex.

Companion headers on the same request:

| Header | Meaning |
|---|---|
| `X-DePix-Event` | The event type, e.g. `checkout.paid`, `deposit.completed`. |
| `X-DePix-Event-Id` | Stable delivery id (`evt_…`), **identical across retries** of the same event — use it to deduplicate. Also present as `data.event_id` in the body. |
| `X-DePix-Delivery-Attempt` | 1-based attempt number (see §4). |
| `Content-Type` | `application/json`. |

---

## 2. What is signed

The HMAC is computed over the string:

```
"<t>.<raw request body>"
```

that is, the same `t` from the header, a literal `.` (0x2E), then the **exact
raw bytes of the request body** — before any parsing or re-serialization. The
key is the merchant's **webhook secret** (format `whsec_…`; issued when the
merchant/agent is created, rotatable).

```
v1 = hex( HMAC_SHA256( webhook_secret, t + "." + raw_body ) )
```

Because the signature covers the raw body, a verifier MUST compute the HMAC over
the bytes it received on the wire — do not parse-then-re-serialize the JSON
first, as that can change bytes (key order, whitespace, number formatting) and
break the signature.

---

## 3. Verification

1. Read `X-DePix-Signature`; split on `,` and parse the `t=` and `v1=` fields.
2. **Reject stale timestamps.** Compare `t` to your clock and reject if it is
   too old (a tolerance of ~5 minutes is typical). This is what stops an
   attacker replaying a captured delivery.
3. Recompute `expected = hex(HMAC_SHA256(secret, t + "." + raw_body))` using the
   raw body bytes.
4. Compare `expected` to `v1` with a **constant-time** comparison (e.g.
   `crypto.timingSafeEqual`, `hmac.compare_digest`, `hmac.Equal`). Never use a
   plain `==` on the hex strings.
5. Only after the signature checks out, act on the event. Use `X-DePix-Event-Id`
   / `data.event_id` to make handling **idempotent** (see §4).

The [`../examples/verify-webhook/`](../examples/verify-webhook/) programs do
exactly this against the committed vectors, in Node, Python and Go.

---

## 4. Delivery, retries and idempotency

- **Retries.** A delivery that does not get a `2xx` (or times out — the send
  timeout is 30s) is retried on a fixed backoff schedule:

  | Attempt | Delay after the previous |
  |---|---|
  | 1 | immediate |
  | 2 | 1 minute |
  | 3 | 10 minutes |
  | 4 | 1 hour |
  | 5 | 4 hours |
  | 6 | 12 hours |

  **Maximum 6 attempts**, spread over roughly 17 hours. After the sixth failed
  attempt the delivery is abandoned.

- **Acknowledge fast.** Respond with any `2xx` quickly to stop retries; do slow
  fulfillment work asynchronously. A timeout counts as a failure and triggers a
  retry, which can cause duplicate deliveries.

- **Deduplicate.** Every attempt of the same event reuses the same
  `data.event_id` / `X-DePix-Event-Id`. Treat that id as the idempotency key so a
  retried delivery is processed at most once. (Each retry is re-signed with a
  **fresh `t`**, so the `v1` value differs between attempts — do not dedupe on the
  signature.)

---

## 5. Source of truth

Derived from `depix-backend` `api/_lib/webhook-dispatch.js`
(`attemptWebhookDelivery` computes `t`, the HMAC over `` `${timestamp}.${payload}` ``,
and the `RETRY_DELAYS = [0, 60, 600, 3600, 14400, 43200]` / `MAX_ATTEMPTS = 6`
schedule), and cross-checked against the public OpenAPI webhook description
served at `GET /openapi.json`.
