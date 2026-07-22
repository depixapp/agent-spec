# discovery/ — versioned snapshot of the live discovery surface

The **canonical, living** discovery files are served at depixapp.com and are the
source of truth:

- `agent.json` → <https://depixapp.com/.well-known/agent.json>
- `llms.txt` → <https://depixapp.com/llms.txt>
- OpenAPI → <https://api.depixapp.com/openapi.json>

The copies here are a **point-in-time snapshot** kept for reference and change
tracking. They are **not** a second source of truth: `scripts/pull-canonical.mjs`
runs in CI and fails if the load-bearing values pinned in
[`canonical.json`](./canonical.json) (OpenAPI version, manifest version, SDK
version, MCP tool counts) drift from the live sources.

The guard deliberately compares **stable fields**, not a byte-for-byte diff, so
volatile fields (like the manifest's daily `updated` date) never cause a false
failure. When the live sources legitimately change, refresh these snapshots and
bump `canonical.json` in the same commit.
