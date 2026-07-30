# Guardrails and limits

There are **two different things** called "limits" in the DePix App agent stack, on
opposite sides of the wire. They are easy to conflate; they are not the same and
they are enforced by different code. This document names both and points to the
live source of truth for the numbers.

---

## 1. SDK client-side guardrails (agent-side, in the wallet SDK)

These live **inside the agent**, in the `@depixapp/sdk` wallet. They are the
owner's ceilings on the agent's own spending, and their job is to contain a
**prompt-injected or hallucinating agent** — not a malicious owner (who controls
the process anyway). They are checked before the SDK signs any money-moving
operation.

| Guardrail | Default | Env override |
|---|---|---|
| Per-transaction cap | **R$ 100,00** (`10000` cents) | `DEPIX_GUARDRAIL_PER_TX_BRL_CENTS` |
| Rolling 24h cap | **R$ 500,00** (`50000` cents) | `DEPIX_GUARDRAIL_DAILY_BRL_CENTS` |
| Destination allowlist | **disabled** (value ceilings only) | `DEPIX_GUARDRAIL_ALLOWLIST` (JSON) |

Precedence is `option > env > default`, resolved per field. Key properties:

- **Immutable at runtime.** The resolved config is deeply frozen; there is no
  method, MCP tool, or setter an injected LLM could call to raise its own
  ceiling. Changing a limit means editing the option/env and restarting.
- **`0`/negative is a config error, not "off".** To *remove* a ceiling you must
  set it explicitly to `Number.MAX_SAFE_INTEGER` — a conscious, diff-visible
  decision.
- **Allowlist is opt-in and fail-closed when enabled.** When the allowlist is
  `enabled`, every signing operation validates its final destination against the
  matching opt-in class (Liquid addresses, Pix keys, Lightning, BTC/EVM/Tron
  settle addresses, gift-card beneficiaries, SideShift refund addresses); a
  class that was not opted in is denied. Default is disabled, i.e. only the value
  ceilings apply.

Source: `depix-sdk` `src/guardrails/config.ts`.

---

## 2. Server-side agent pacing (API-side, enforced by the backend)

These are enforced by the **DePix App API**, independent of any client. They pace a
young/unverified agent account so it graduates gradually instead of discovering
caps through opaque `4xx`s. The account can read its own envelope so it can pace
itself.

The fields (integer BRL cents unless noted):

| Field | Meaning |
|---|---|
| `first_deposit_max_cents` | Cap on the account's very first deposit. |
| `unverified_per_tx_max_cents` | Per-deposit cap before verification. |
| `unverified_lifetime_max_cents` | Cumulative deposit cap before verification. |
| `inter_deposit_delay_hours` | Settlement delay applied to deposits 2–5 of an unverified account (the DePix payout is held this many hours). |
| `payer_velocity` | Per-payer deposit velocity gate: `{ max_per_window, window_minutes }`. |
| `verified_per_tx_deposit_max_cents` | Per-deposit cap after verification. |
| `verified_per_tx_withdraw_max_cents` | Per-withdrawal cap after verification. |

### Read your live caps — do not hardcode these numbers

The **authoritative, current values** are returned to the agent itself in the
`response.pacing` object of the **`POST /api/agents/register`** `201` response
(the same call that self-onboards the agent). Read them there and pace against
them; they can be tuned server-side and any value copied into a static document
will eventually drift.

> **Accuracy note.** Some earlier internal notes said the `pacing` object is
> returned by `GET /api/agents/status`. It is not — in the production API the
> `pacing` envelope is part of the `POST /api/agents/register` response.
> `GET /api/agents/status` returns account state and **graduation** progress
> (`account_status`, `graduated`, `graduation`, `keys`), but it does not echo
> the numeric pacing caps. Both are in the public OpenAPI at
> `GET /openapi.json`.

> **Graduation is not a deposit count.** An earlier version of this page listed
> `settled_personal_deposits` in that payload and called it "how an agent tracks
> its path to higher limits". Both are gone, and the second was the more
> damaging: it invited an agent to make deposits and wait for a threshold that
> never unlocks anything.
>
> The gate is, and always was, **account verification** — the deposit count was
> only ever *one way* an account used to become verified, and that path is
> retired. An agent verifies by **proving a registrable domain over DNS**, which
> also unlocks receiving from third parties. So one action unlocks both.
>
> Read `graduation.blocked_on` from `GET /api/agents/status` and branch on it:
> `"domain_proof"` means the next move is yours (prove the domain);
> `"gate_review"` means the proof landed and the account is being reviewed on our
> side — poll, don't act; `null` means graduated.

This repo deliberately does **not** hardcode the pacing numbers: the field
*names and semantics* are public (they are in the OpenAPI document), but the
exact envelope is best read live from the API per account and moment.

Source: `depix-backend` `api/_lib/routes/agents.js` (`register`, `response.pacing`)
and the `AgentRegisterResponse` schema in `api/_lib/openapi.js`.

---

## 3. Aside: the two MCP levels are not interchangeable

Related and often confused — there is ONE MCP server, `@depixapp/mcp`, at two
levels of access (see [`../mcp/README.md`](../mcp/README.md)). Pick by whether
the agent needs a key to the money:

- **Level 1 — hosted.** `https://mcp.depixapp.com/mcp`, Streamable HTTP,
  **22 tools**. Reads and creates checkouts, products and charges (dated
  payment links) and reads pay-status; it
  **cannot move funds** — this deployment holds no seed, so the `wallet_*`
  tools are structurally absent from it.
- **Level 2 — local.** `npx -y @depixapp/mcp` over stdio, run where the agent
  lives, **49 tools**. The extra 27 `wallet_*` tools expose the operator's own
  non-custodial wallet and **do move funds**, signed in-process with the
  operator's key. The guardrails in §1 apply here. First run is
  `npx -y @depixapp/mcp init`; the seed never leaves that machine.
