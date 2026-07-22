#!/usr/bin/env python3
"""Verify DePix App webhook signatures (Python stdlib only) against the committed
test vectors. Mirrors a real receiver per signing/webhook-signature.md:

    v1 == hex(HMAC_SHA256(secret, f"{t}.{raw_body}")), constant-time compared.

    python3 verify.py

Exit code 0 = all vectors verified; 1 = a mismatch.
"""
import hashlib
import hmac
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "..", "..", "..", "signing", "vectors", "webhook.json")


def parse_header(header: str) -> dict:
    out = {}
    for part in header.split(","):
        k, _, v = part.partition("=")
        out[k.strip()] = v.strip()
    return out


def verify(secret: str, header: str, raw_body: str) -> bool:
    fields = parse_header(header)
    t, v1 = fields["t"], fields["v1"]
    # A real receiver also rejects a stale `t` (e.g. abs(now - t) > 300s).
    expected = hmac.new(secret.encode(), f"{t}.{raw_body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)


def main() -> int:
    with open(VECTORS, encoding="utf-8") as fh:
        doc = json.load(fh)
    secret = doc["test_secret"]["value"]

    failures = 0
    for v in doc["vectors"]:
        ok = verify(secret, v["header"], v["payload"])
        print(f"{'OK  ' if ok else 'FAIL'}  {v['name']}")
        failures += 0 if ok else 1

    # Negative control: a tampered body must NOT verify.
    tampered_ok = verify(secret, doc["vectors"][0]["header"], doc["vectors"][0]["payload"] + " ")
    print(f"{'FAIL' if tampered_ok else 'OK  '}  negative control (tampered body is rejected)")
    failures += 1 if tampered_ok else 0

    if failures:
        print(f"\n{failures} check(s) failed", file=sys.stderr)
        return 1
    print(f"\nAll {len(doc['vectors'])} webhook vectors verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
