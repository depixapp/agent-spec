# The DePix App MCP server

This repo does **not** re-host the MCP server code or its schema — that lives,
public and maintained, in [`depixapp/depix-mcp`](https://github.com/depixapp/depix-mcp).
This page is a pointer and a disambiguation.

## ONE server, TWO levels of access

There is one DePix MCP server: **`@depixapp/mcp`** (Apache-2.0, registry id
`io.github.depixapp/depix-mcp`). It registers **59 tools**. Which of them
actually work depends on nothing but where the server runs and whether that
process holds a wallet seed.

| | Level 1 — hosted | Level 2 — local |
|---|---|---|
| Package | `@depixapp/mcp` | `@depixapp/mcp` (same package, same bin `depix-mcp`) |
| Who runs it | DePix App | the operator, where the agent lives |
| Transport | Streamable HTTP at `https://mcp.depixapp.com/mcp` (stateless) | stdio — `npx -y @depixapp/mcp` |
| Seed | **none** | the operator's |
| Tools | **26** — 20 merchant/gateway + 6 support-ticket | **59** — the same 26 + 29 `wallet_*` + 4 agent-local |
| Moves funds? | **No** — it cannot create deposits or withdrawals | **Yes** — signed in-process with the operator's key |
| Auth | OAuth 2.1 connector, or `Authorization: Bearer sk_…` | none to configure — `init` creates the wallet, self-registers the account (`register_account`), and stores the unlock key in the OS keychain |
| Custody | non-custodial (holds nothing) | non-custodial (the operator holds the seed) |

**The split is custody, not features withheld.** Every spend materialises the
signer in-process; there is no remote/delegate-sign path. So whichever process
executes a fund-moving tool **is** the seed holder. DePix App will not hold
seeds, therefore the hosted deployment can only ever expose the keyless 26 —
physics, not a product decision. The 29 `wallet_*` tools are structurally
absent from the hosted build (separate import graph), not merely disabled, and
so are the 4 agent-local tools — the hosted catalog never offers account
registration.

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
some back, sets the spending guardrails, and registers the server with the AI
hosts it finds on that machine (Claude Code, Claude Desktop, Cursor) — no
`mcpServers` block to paste by hand (printing one is the fallback for a host it
doesn't detect). It asks for no API key: the wallet's unlock key goes straight
into the OS keychain, never into a host config, and the agent opens its own
account later by calling `register_account`. **Seed creation is deliberately
not an MCP tool** — the mnemonic must never transit model context or
conversation logs. That invariant survives every future revision of this spec.

Environment variables exist too, but `init` and `register_account` are the
path — none of the following are required to get started. They're an advanced
fallback (a pre-existing key, a headless box with no keychain, CI):

| Variable | Meaning |
|---|---|
| `DEPIX_API_KEY` | `sk_test_` / `sk_live_`, forwarded verbatim to the REST API. Unnecessary once `register_account` has opened the account. |
| `DEPIX_WALLET_PASSPHRASE` | Unlocks the seed created by `init`. Usually unnecessary — `init` stores the unlock key in the OS keychain — but still honoured when set. **Never put a real passphrase in a host config file**; this is for the cases the keychain can't cover. |
| `DEPIX_WALLET_DIR` | Optional — where the encrypted wallet lives; defaults to the per-user data directory. |

Without a configured wallet the `wallet_*` tools stay **listed** and return a
typed `wallet_not_configured` error naming `init`. The catalog is static at 59
on the local level on purpose: MCP hosts snapshot `tools/list` at connect and
`list_changed` support is uneven, so a catalog that grew after `init` would
mean "restart your client".

## The 26 gateway tools (both levels)

- Checkouts (5): `create_checkout`, `get_checkout`, `list_checkouts`,
  `simulate_checkout_payment` (sandbox only), `wait_for_checkout`
- Products (8): `create_product`, `list_products`, `get_product`,
  `update_product`, `activate_product`, `deactivate_product`,
  `set_featured_products`, `list_product_checkouts`
- Account (1): `get_account`
- Pay-status, read-only (2, scope `wallet_read`): `get_deposit_status`,
  `get_withdrawal_status`
- Merchant state (4): `get_onboarding_status`, `update_merchant_profile`,
  `get_vault_status` (the Cofre hold window), `list_webhook_logs`
- Support tickets (6, no scope): `open_support_ticket`, `get_support_ticket`,
  `list_support_tickets`, `reply_support_ticket`, `close_support_ticket`,
  `attach_support_ticket_file` (attach ONE file — base64, up to ~3 MB — to a
  ticket; counts as a reply)

## The 29 wallet tools (level 2 only)

These **move funds** with the operator's key, under guardrails the operator
sets.

- State (10): `wallet_status`, `wallet_get_balances`, `wallet_get_address`,
  `wallet_list_transactions`, `wallet_pending`, `wallet_get_guardrails`,
  `wallet_diagnostics`, `wallet_recover`, `wallet_sync`, `wallet_list_utxos`
- Pix on/off-ramp (4): `wallet_create_deposit`, `wallet_wait_deposit`,
  `wallet_create_withdrawal`, `wallet_wait_withdrawal`
- Move & convert (7): `wallet_send`, `wallet_quote`, `wallet_convert`,
  `wallet_swap_quote`, `wallet_swap_execute`, `wallet_to_stablecoin`,
  `wallet_shift_usdt`
- Lightning (2): `wallet_pay_lightning_invoice`, `wallet_receive_lightning`
- Gift cards (6): `wallet_list_giftcards`, `wallet_list_giftcard_products`,
  `wallet_giftcard_price`, `wallet_buy_giftcard`, `wallet_list_giftcard_orders`,
  `wallet_get_giftcard_order_status`

## The 4 agent-local tools (level 2 only)

`register_account`, `agent_status`, `verify_domain`, `configure_depix_rail` —
they self-onboard the account on this machine (the Ed25519 keypair stays here,
see [`../signing/agent-auth.md`](../signing/agent-auth.md)) and toggle its DePix
direct rail. They are absent from the hosted level because registration is the
one thing an operator's own process must do for itself.

The authoritative lists are `src/server.ts` (the 26 gateway),
`src/agent-tools.ts` (the 4 agent-local) and `src/wallet-engine/mcp/server.ts`
(the 29 `wallet_*`) in `depix-mcp`; the counts here are kept honest by the
discovery drift guards (see the repo root README).

## Registry / discovery files (in `depix-mcp`)

- `registry/server.json` — the Model Context Protocol registry manifest (the
  seed for catalog listings). ONE entry: `remotes[]` carries the hosted
  keyless endpoint, `packages[]` carries the npm package with all 59 tools.
- `/.well-known/mcp.json` — served live from the hosted deployment.

The registry schema has no per-remote/per-package tool field, so a client that
adds only the `mcp.depixapp.com` remote silently gets 26 (no wallet). That
delta is not machine-expressible today — it is disambiguated in the entry's
description and here.

## Connecting

Level 1 — hosted, nothing to install:

```
claude mcp add --transport http depix https://mcp.depixapp.com/mcp \
  --header "Authorization: Bearer sk_test_..."
```

Level 2 — local, the full wallet:

```
npx -y @depixapp/mcp init
```

That's the whole setup. `init` creates the wallet, stores its unlock key in
the OS keychain, and writes the `mcpServers` entry into every AI host it finds
on the machine — nothing to hand-edit, no key to obtain first, no passphrase to
paste. The agent opens its own sandbox/live account afterwards with
`register_account`; there's no `DEPIX_API_KEY` to configure up front.

Only if a host isn't auto-detected does `init` fall back to printing a block to
paste by hand, and that block carries no secret — no API key, no passphrase:

```json
{
  "mcpServers": {
    "depix": {
      "command": "npx",
      "args": ["-y", "@depixapp/mcp"]
    }
  }
}
```

The environment variables in the table above (`DEPIX_API_KEY`,
`DEPIX_WALLET_PASSPHRASE`) exist only for the advanced cases that fallback
covers — never as something to type into a config file by default.

Where an `sk_` key is in play at all (level 1, or level 2's fallback), use
`sk_test_` for sandbox and `sk_live_` for production. The canonical hosted URL
is **`https://mcp.depixapp.com/mcp`** — your `sk_` key should never be pasted
into any third-party endpoint.

## Code-level lineage

The wallet engine behind the 29 `wallet_*` tools now lives in `depix-mcp` itself,
under `src/wallet-engine/`. `@depixapp/sdk` (AGPL-3.0) was its earlier home; it
is frozen at 1.2.2 and its repository has been archived. Do not start there:
`@depixapp/mcp` is the successor public surface for agents and for code-first
integrations alike.
