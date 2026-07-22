// gen-collections.mjs — GENERATE Postman + Bruno collections from the LIVE
// OpenAPI document. Collections are derived artifacts, never hand-authored, so
// they cannot drift from the API by hand: regenerate instead of editing.
//
//   node collections/gen-collections.mjs            # fetch live openapi.json
//   node collections/gen-collections.mjs --from path/to/openapi.json
//
// Output (committed):
//   collections/postman/depix-core.postman_collection.json
//   collections/bruno/**                          (bruno.json + one .bru per request)
//
// This intentionally covers a MINIMAL but real core flow — create/list/get a
// checkout, simulate a sandbox payment, identify the caller, read agent status —
// rather than the whole surface. The full, always-current API is the OpenAPI
// document itself (https://api.depixapp.com/openapi.json); these collections are
// a runnable on-ramp, not a second copy of it.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_OPENAPI_URL = "https://api.depixapp.com/openapi.json";
const BASE_URL = "https://api.depixapp.com";

// The core flow to include, in order. `auth: "agent-signed"` marks a route that
// needs Ed25519 request signing (see signing/agent-auth.md) — a static Bearer
// token cannot call it, so the collection documents it with a note.
const SELECTED = [
  { operationId: "createCheckout", auth: "bearer", bodyExample: "minimal" },
  { operationId: "listCheckouts", auth: "bearer" },
  { operationId: "getCheckout", auth: "bearer" },
  { operationId: "simulateCheckoutPayment", auth: "bearer" },
  { operationId: "getMe", auth: "bearer" },
  { operationId: "getAgentStatus", auth: "agent-signed" },
];

async function loadOpenapi() {
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx !== -1 && process.argv[fromIdx + 1]) {
    const p = process.argv[fromIdx + 1];
    console.log(`gen-collections: reading OpenAPI from ${p}`);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  console.log(`gen-collections: fetching live OpenAPI from ${LIVE_OPENAPI_URL}`);
  const res = await fetch(LIVE_OPENAPI_URL);
  if (!res.ok) throw new Error(`could not fetch ${LIVE_OPENAPI_URL}: HTTP ${res.status}`);
  return res.json();
}

/** Find { method, path, op } for an operationId. */
function findOperation(openapi, operationId) {
  for (const [path, item] of Object.entries(openapi.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === "object" && op.operationId === operationId) {
        return { method: method.toUpperCase(), path, op };
      }
    }
  }
  throw new Error(`operationId ${operationId} not found in the OpenAPI document`);
}

/** Pull a JSON request-body example (by key, else the first) if the op has one. */
function bodyExampleFor(op, key) {
  const content = op.requestBody?.content?.["application/json"];
  if (!content) return undefined;
  if (content.examples) {
    const picked = (key && content.examples[key]) || Object.values(content.examples)[0];
    return picked?.value;
  }
  if (content.example) return content.example;
  return undefined;
}

/** Replace {id}-style path params with a copy-paste placeholder. */
function fillPathParams(path) {
  return path.replace(/\{(\w+)\}/g, (_, name) => `:${name}`);
}

// ── Postman v2.1 ─────────────────────────────────────────────────────────────
function buildPostman(openapi, requests) {
  return {
    info: {
      name: "DePix — core flow",
      _postman_id: "depix-agent-spec-core-0001",
      description:
        `Generated from the live DePix OpenAPI (${openapi.openapi}, info.version ${openapi.info.version}) ` +
        "by collections/gen-collections.mjs. Set {{apiKey}} to an sk_test_/sk_live_ key. " +
        "Do not hand-edit — regenerate.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [
      { key: "baseUrl", value: BASE_URL },
      { key: "apiKey", value: "sk_test_REPLACE_ME" },
      { key: "checkoutId", value: "chk_REPLACE_ME" },
    ],
    item: requests.map((r) => {
      const headers = [];
      if (r.auth === "bearer") headers.push({ key: "Authorization", value: "Bearer {{apiKey}}" });
      if (r.body) headers.push({ key: "Content-Type", value: "application/json" });
      const pathSegments = fillPathParams(r.path).replace(/^\//, "").split("/");
      const item = {
        name: `${r.operationId} — ${r.summary || ""}`.trim(),
        request: {
          method: r.method,
          header: headers,
          url: {
            raw: `{{baseUrl}}${fillPathParams(r.path)}`,
            host: ["{{baseUrl}}"],
            path: pathSegments.map((s) => (s === ":id" ? "{{checkoutId}}" : s)),
          },
          description: r.auth === "agent-signed" ? AGENT_NOTE : r.description || undefined,
        },
      };
      if (r.body) {
        item.request.body = { mode: "raw", raw: JSON.stringify(r.body, null, 2), options: { raw: { language: "json" } } };
      }
      return item;
    }),
  };
}

// ── Bruno ────────────────────────────────────────────────────────────────────
function bruField(lines) {
  return lines.join("\n");
}

function buildBruRequest(r, seq) {
  const blocks = [];
  blocks.push(bruField(["meta {", `  name: ${r.operationId}`, "  type: http", `  seq: ${seq}`, "}"]));
  const reqLines = [`${r.method.toLowerCase()} {`, `  url: {{baseUrl}}${fillPathParams(r.path)}`];
  if (r.body) reqLines.push("  body: json");
  if (r.auth === "bearer") reqLines.push("  auth: bearer");
  reqLines.push("}");
  blocks.push(bruField(reqLines));
  if (r.auth === "bearer") {
    blocks.push(bruField(["auth:bearer {", "  token: {{apiKey}}", "}"]));
  }
  if (r.body) {
    const body = JSON.stringify(r.body, null, 2).split("\n").map((l) => "  " + l).join("\n");
    blocks.push(bruField(["headers {", "  Content-Type: application/json", "}"]));
    blocks.push(bruField(["body:json {", body, "}"]));
  }
  const docNote = r.auth === "agent-signed" ? AGENT_NOTE : r.summary || "";
  if (docNote) blocks.push(bruField(["docs {", ...docNote.split("\n").map((l) => "  " + l), "}"]));
  return blocks.join("\n\n") + "\n";
}

const AGENT_NOTE =
  "This route requires per-request Ed25519 signing (X-Agent-* headers), not a static Bearer token. " +
  "See signing/agent-auth.md and examples/sign-request/. A static collection cannot sign it for you.";

// ── main ─────────────────────────────────────────────────────────────────────
const openapi = await loadOpenapi();

const requests = SELECTED.map((sel) => {
  const { method, path, op } = findOperation(openapi, sel.operationId);
  return {
    ...sel,
    method,
    path,
    summary: op.summary,
    description: op.description,
    body: sel.auth === "bearer" ? bodyExampleFor(op, sel.bodyExample) : undefined,
  };
});

// Postman
const postmanDir = join(HERE, "postman");
mkdirSync(postmanDir, { recursive: true });
writeFileSync(
  join(postmanDir, "depix-core.postman_collection.json"),
  JSON.stringify(buildPostman(openapi, requests), null, 2) + "\n"
);

// Bruno
const brunoDir = join(HERE, "bruno");
rmSync(brunoDir, { recursive: true, force: true });
mkdirSync(join(brunoDir, "environments"), { recursive: true });
writeFileSync(
  join(brunoDir, "bruno.json"),
  JSON.stringify(
    { version: "1", name: "DePix — core flow", type: "collection", ignore: ["node_modules", ".git"] },
    null,
    2
  ) + "\n"
);
writeFileSync(
  join(brunoDir, "environments", "DePix.bru"),
  bruField([
    "vars {",
    `  baseUrl: ${BASE_URL}`,
    "  apiKey: sk_test_REPLACE_ME",
    "  checkoutId: chk_REPLACE_ME",
    "}",
  ]) + "\n"
);
requests.forEach((r, i) => {
  writeFileSync(join(brunoDir, `${String(i + 1).padStart(2, "0")}-${r.operationId}.bru`), buildBruRequest(r, i + 1));
});

console.log(
  `gen-collections: wrote Postman + Bruno collections for ${requests.length} operations ` +
    `(OpenAPI ${openapi.openapi} / info.version ${openapi.info.version}).`
);
