# The DePix App MCP server

This repo does **not** re-host the MCP server code or its schema — that lives,
public and maintained, in [`depixapp/depix-mcp`](https://github.com/depixapp/depix-mcp).
This page is a pointer and a disambiguation.

## ONE server, TWO levels of access

There is one DePix MCP server: **`@depixapp/mcp`** (Apache-2.0, registry id
`io.github.depixapp/depix-mcp`). It registers **49 tools**. Which of them
actually work depends on nothing but where the server runs and whether that
process holds a wallet seed.

| | Level 1 — hosted | Level 2 — local |
|---|---|---|
| Package | `@depixapp/mcp` | `@depixapp/mcp` (same package, same bin `depix-mcp`) |
| Who runs it | DePix App | the operator, where the agent lives |
| Transport | Streamable HTTP at `https://mcp.depixapp.com/mcp` (stateless) | stdio — `npx -y @depixapp/mcp` |
| Seed | **none** | the operator's |
| Tools | **22** — 16 merchant/gateway + 6 support-ticket | **49** — the same 22 + 27 `wallet_*` |
| Moves funds? | **No** — it cannot create deposits or withdrawals | **Yes** — signed in-process with the operator's key |
| Auth | OAuth 2.1 connector, or `Authorization: Bearer sk_…` | `DEPIX_API_KEY` + `DEPIX_WALLET_PASSPHRASE` in the environment |
| Custody | non-custodial (holds nothing) | non-custodial (the operator holds the seed) |

**The split is custody, not features withheld.** Every spend materialises the
signer in-process; there is no remote/delegate-sign path. So whichever process
executes a fund-moving tool **is** the seed holder. DePix App will not hold
seeds, therefore the hosted deployment can only ever expose the keyless 22 —
physics, not a product decision. The 27 `wallet_*` tools are structurally
absent from the hosted build (separate import graph), not merely disabled.

The hosted level is a **pure client of the public DePix App API** — it holds no
critical credentials and goes through the same auth, scopes and rate limits as
any other agent.

⚠️ **stdio is the only default-safe transport for level 2.** The wallet server
loads the seed process-wide and carries no auth of its own. Exposed over HTTP,
anyone who reaches the port can drain the wallet — require operator-provided
auth plus network isolation (bind localhost / bearer / mTLS) before doing that.

## First run (level 2)

```
npx -y @depixapp/mcp init            # create a new wallet
npx -y @depixapp/mcp init --restore  # import an existing mnemonic
```

A TTY-only human ceremony: it prints the 12 words once, challenges you to type
some back, and finishes by printing the exact `mcpServers` block to paste into
the agent's client. **Seed creation is deliberately not an MCP tool** — the
mnemonic must never transit model context or conversation logs. That invariant
survives every future revision of this spec.

Environment:

| Variable | Required | Meaning |
|---|---|---|
| `DEPIX_API_KEY` | for the 22 gateway tools | `sk_test_` / `sk_live_`, forwarded verbatim to the REST API |
| `DEPIX_WALLET_PASSPHRASE` | for the 27 wallet tools | unlocks the seed created by `init` |
| `DEPIX_WALLET_DIR` | optional | where the encrypted wallet lives; defaults to the per-user data directory |

Without a configured wallet the `wallet_*` tools stay **listed** and return a
typed `wallet_not_configured` error naming `init`. The catalog is static at 49
on the local level on purpose: MCP hosts snapshot `tools/list` at connect and
`list_changed` support is uneven, so a catalog that grew after `init` would
mean "restart your client".

## The 22 gateway tools (both levels)

- Checkouts (5): `create_checkout`, `get_checkout`, `list_checkouts`,
  `simulate_checkout_payment` (sandbox only), `wait_for_checkout`
- Products (8): `create_product`, `list_products`, `get_product`,
  `update_product`, `activate_product`, `deactivate_product`,
  `set_featured_products`, `list_product_checkouts`
- Account (1): `get_account`
- Pay-status, read-only (2, scope `wallet_read`): `get_deposit_status`,
  `get_withdrawal_status`
- Support tickets (6, no scope): `open_support_ticket`, `get_support_ticket`,
  `list_support_tickets`, `reply_support_ticket`, `close_support_ticket`,
  `attach_support_ticket_file` (attach ONE file — base64, up to ~3 MB — to a
  ticket; counts as a reply)

## The 27 wallet tools (level 2 only)

These **move funds** with the operator's key, under guardrails the operator
sets.

- State (8): `wallet_status`, `wallet_get_balances`, `wallet_get_address`,
  `wallet_list_transactions`, `wallet_pending`, `wallet_get_guardrails`,
  `wallet_diagnostics`, `wallet_recover`
- Pix on/off-ramp (4): `wallet_create_deposit`, `wallet_wait_deposit`,
  `wallet_create_withdrawal`, `wallet_wait_withdrawal`
- Move & convert (7): `wallet_send`, `wallet_quote`, `wallet_convert`,
  `wallet_swap_quote`, `wallet_swap_execute`, `wallet_to_stablecoin`,
  `wallet_shift_usdt`
- Lightning (2): `wallet_pay_lightning_invoice`, `wallet_receive_lightning`
- Gift cards (6): `wallet_list_giftcards`, `wallet_list_giftcard_products`,
  `wallet_giftcard_price`, `wallet_buy_giftcard`, `wallet_list_giftcard_orders`,
  `wallet_get_giftcard_order_status`

The authoritative lists are `src/server.ts` (the hosted 22) and
`src/vendor/depix-sdk/mcp/server.ts` (the 27 `wallet_*`) in `depix-mcp`; the
counts here are kept honest by the discovery drift guards (see the repo root
README).

## Registry / discovery files (in `depix-mcp`)

- `registry/server.json` — the Model Context Protocol registry manifest (the
  seed for catalog listings). ONE entry: `remotes[]` carries the hosted
  keyless endpoint, `packages[]` carries the npm package with all 49 tools.
- `/.well-known/mcp.json` — served live from the hosted deployment.

The registry schema has no per-remote/per-package tool field, so a client that
adds only the `mcp.depixapp.com` remote silently gets 22 (no wallet). That
delta is not machine-expressible today — it is disambiguated in the entry's
description and here.

## Connecting

Level 1 — hosted, nothing to install:

```
claude mcp add --transport http depix https://mcp.depixapp.com/mcp \
  --header "Authorization: Bearer sk_test_..."
```

Level 2 — local, the full wallet:

```json
{
  "mcpServers": {
    "depix": {
      "command": "npx",
      "args": ["-y", "@depixapp/mcp"],
      "env": {
        "DEPIX_API_KEY": "sk_test_...",
        "DEPIX_WALLET_PASSPHRASE": "<the passphrase you typed>"
      }
    }
  }
}
```

Use an `sk_test_` key for sandbox and `sk_live_` for production. The canonical
hosted URL is **`https://mcp.depixapp.com/mcp`** — your `sk_` key should never be
pasted into any third-party endpoint.

## Code-level lineage

[`@depixapp/sdk`](https://www.npmjs.com/package/@depixapp/sdk) (AGPL-3.0, 1.2.1)
is the code-level lineage of the same wallet engine that powers the 27
`wallet_*` tools. It stays published for code-first integrations, and the
tarball ships `AGENTS.md` (routing table, units, examples). When an **agent** is
driving, connect `@depixapp/mcp` instead — that is the successor public surface.
