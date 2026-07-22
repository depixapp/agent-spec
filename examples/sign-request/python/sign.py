#!/usr/bin/env python3
"""Sign DePix agent requests (Python) and prove the result matches the committed
vectors. Implements signing/agent-auth.md end to end: rebuild the canonical
string from the request fields, sign it with the TEST-ONLY key, and assert both
the canonical string and the signature match the vector exactly.

Requires: `cryptography` (pip install cryptography).

    python3 sign.py

Exit code 0 = every vector reproduced; 1 = a mismatch.
"""
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "..", "..", "..", "signing", "vectors", "agent-auth.json")


def sha256_hex(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


def canonical_body(body) -> str:
    """Body normalization (signing/agent-auth.md §4): None/{} -> ""."""
    if body is None:
        return ""
    if isinstance(body, dict) and len(body) == 0:
        return ""
    # Compact JSON, keys in insertion order (json.load preserves it), matching
    # JS JSON.stringify: no whitespace, non-ASCII left as-is.
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False)


def build_canonical(scheme, audience, method, path, timestamp, nonce, body) -> str:
    return "\n".join([
        scheme,
        audience,
        method.upper(),
        path,
        timestamp,
        nonce,
        sha256_hex(canonical_body(body)),
    ])


def main() -> int:
    with open(VECTORS, encoding="utf-8") as fh:
        doc = json.load(fh)

    seed = bytes.fromhex(doc["test_key"]["seed_hex"])
    private_key = Ed25519PrivateKey.from_private_bytes(seed)

    # Sanity: derived public key must match the vector's.
    from cryptography.hazmat.primitives import serialization
    pub_hex = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    ).hex()
    if pub_hex != doc["test_key"]["public_key_hex"]:
        print("FAIL  derived public key does not match the vector", file=sys.stderr)
        return 1

    failures = 0
    for v in doc["vectors"]:
        canonical = build_canonical(
            doc["scheme"],
            v.get("audience", doc["audience"]),
            v["method"],
            v["path"],
            v["timestamp"],
            v["nonce"],
            v["body"],
        )
        signature = private_key.sign(canonical.encode("utf-8")).hex()

        canonical_ok = canonical == v["canonical_string"]
        sig_ok = signature == v["signature_hex"]
        ok = canonical_ok and sig_ok
        print(f"{'OK  ' if ok else 'FAIL'}  {v['name']}")
        if not canonical_ok:
            print("      canonical string mismatch")
        if not sig_ok:
            print("      signature mismatch")
        failures += 0 if ok else 1

    if failures:
        print(f"\n{failures} vector(s) did not reproduce", file=sys.stderr)
        return 1
    print(f"\nAll {len(doc['vectors'])} agent-auth vectors reproduced (canonical + signature).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
