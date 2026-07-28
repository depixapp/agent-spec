# DePix App MCP servers

This repo does **not** re-host the MCP server code or its schema — that lives,
public and maintained, in [`depixapp/depix-mcp`](https://github.com/depixapp/depix-mcp).
This page is a pointer and a disambiguation.

## There are TWO MCP servers, and they are not interchangeable

Pick by **which side of the transaction** the agent is on:

| | `@depixapp/mcp` | `depix-wallet-mcp` |
|---|---|---|
| Side | **Merchant / gateway** | **Wallet** |
| What it does | Reads & creates checkouts and products; reads pay-status | Holds/signs/moves funds from the agent's own non-custodial wallet |
| Moves funds? | **No** — it cannot create deposits or withdrawals | **Yes** — with the agent's key |
| Transport | Hosted Streamable HTTP at `https://mcp.depixapp.com/mcp` (also `npx -y @depixapp/mcp` over stdio) | stdio, ships inside `@depixapp/sdk` (`npx depix-wallet-mcp`) |
| Tools | **22 total** — 16 merchant-side + 6 support-ticket | `wallet_convert`, `wallet_quote`, `wallet_send`, … |
| Source | [`depixapp/depix-mcp`](https://github.com/depixapp/depix-mcp) | [`depixapp/depix-sdk`](https://github.com/depixapp/depix-sdk) |

The hosted `@depixapp/mcp` gateway is a **pure client of the public DePix App API** —
it holds no critical credentials and goes through the same auth, scopes and rate
limits as any other agent. It is **not custodial**.

## The 22 gateway tools (`@depixapp/mcp`)

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

The authoritative tool list is `src/server.ts` in `depix-mcp`; the count here is
kept honest by the discovery drift guards (see the repo root README).

## Registry / discovery files (in `depix-mcp`)

- `registry/server.json` — the Model Context Protocol registry manifest (the
  seed for catalog listings).
- `/.well-known/mcp.json` — served live from the hosted deployment.

## Connecting

- Claude Code (remote HTTP):
  `claude mcp add --transport http depix https://mcp.depixapp.com/mcp --header "Authorization: Bearer sk_test_..."`
- Local stdio: `npx -y @depixapp/mcp` with `DEPIX_API_KEY` in the environment.

Use an `sk_test_` key for sandbox and `sk_live_` for production. The canonical
hosted URL is **`https://mcp.depixapp.com/mcp`** — your `sk_` key should never be
pasted into any third-party endpoint.
