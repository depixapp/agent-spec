// pull-canonical.mjs — drift guard against the LIVE canonical sources.
//
// The canonical, living sources of truth are served at depixapp.com (OpenAPI,
// agent.json, llms.txt). This repo pins a few load-bearing values from them
// (discovery/canonical.json) plus a versioned snapshot (discovery/agent.json,
// discovery/llms.txt). If the live sources move ahead of what this repo pins,
// the repo's normative docs / vectors / collections may be describing a stale
// API — this check makes that loud instead of silent.
//
//   node scripts/pull-canonical.mjs
//
// Robustness (mirrors depix-frontend/scripts/check-sdk-version.mjs): the only
// fragile part is the network. A transient fetch failure or empty response
// SKIPS the check with a warning and exits 0 — CI never goes red on
// infrastructure. It exits 1 ONLY on a real, observed divergence between a
// pinned value and the live value.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const pinPath = join(HERE, "..", "discovery", "canonical.json");
const pin = JSON.parse(readFileSync(pinPath, "utf8"));

const FETCH_TIMEOUT_MS = 20_000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function skip(reason) {
  console.warn(`pull-canonical: WARN — ${reason}; skipping the drift check (infrastructure, not drift).`);
  process.exit(0);
}

let openapi, agent;
try {
  [openapi, agent] = await Promise.all([getJson(pin.sources.openapi), getJson(pin.sources.agent_json)]);
} catch (err) {
  skip(`could not reach a live source (${err.message || err})`);
}

// Guard against an empty/garbage response being read as "no drift".
if (!openapi?.info?.version || !agent?.version) {
  skip("a live source returned an unexpected shape");
}

const checks = [
  ["openapi.info.version", pin.openapi_version, openapi.info.version],
  ["agent.json version", pin.agent_manifest_version, agent.version],
  ["agent.json agent_sdk.version", pin.agent_sdk_version, agent.agent_sdk?.version],
  ["agent.json mcp.gateway.tool_count", pin.mcp_tool_count, agent.mcp?.gateway?.tool_count],
  ["agent.json mcp.gateway.tool_count_merchant", pin.mcp_tool_count_merchant, agent.mcp?.gateway?.tool_count_merchant],
  ["agent.json mcp.gateway.tool_count_support", pin.mcp_tool_count_support, agent.mcp?.gateway?.tool_count_support],
  // `@depixapp/mcp` is ONE server at two levels of access, so the manifest
  // carries two totals: the hosted deployment's 22 (above) and the
  // operator-run npx deployment's 49, of which 27 are the `wallet_*` tools
  // that only exist where a seed is present.
  ["agent.json mcp.wallet.tool_count_full", pin.mcp_tool_count_full, agent.mcp?.wallet?.tool_count_full],
  ["agent.json mcp.wallet.tool_count_wallet", pin.mcp_tool_count_wallet, agent.mcp?.wallet?.tool_count_wallet],
];

const drifts = checks.filter(([, pinned, live]) => String(pinned) !== String(live));

if (drifts.length > 0) {
  console.error("pull-canonical: FAIL — the live canonical sources have drifted from this repo's pins:\n");
  for (const [field, pinned, live] of drifts) {
    console.error(`  ${field}\n    pinned here: ${pinned}\n    live now:    ${live}`);
  }
  console.error(
    "\nFix: refresh discovery/agent.json + discovery/llms.txt from live, update the pinned\n" +
      "values in discovery/canonical.json, and (if the OpenAPI version moved) regenerate the\n" +
      "collections and re-check the signing docs/vectors — all in one commit."
  );
  process.exit(1);
}

console.log("pull-canonical: OK — all pinned canonical values match the live sources.");
for (const [field, , live] of checks) console.log(`  ${field} = ${live}`);
