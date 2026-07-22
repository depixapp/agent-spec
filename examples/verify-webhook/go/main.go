// Verify DePix webhook signatures (Go stdlib only) against the committed test
// vectors. Mirrors a real receiver per signing/webhook-signature.md:
//
//	v1 == hex(HMAC_SHA256(secret, t + "." + rawBody)), constant-time compared.
//
//	go run .
//
// Exit code 0 = all vectors verified; 1 = a mismatch.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type webhookDoc struct {
	TestSecret struct {
		Value string `json:"value"`
	} `json:"test_secret"`
	Vectors []struct {
		Name    string `json:"name"`
		Header  string `json:"header"`
		Payload string `json:"payload"`
	} `json:"vectors"`
}

func vectorsPath() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "signing", "vectors", "webhook.json")
}

func parseHeader(header string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) == 2 {
			out[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
		}
	}
	return out
}

func verify(secret, header, rawBody string) bool {
	f := parseHeader(header)
	// A real receiver also rejects a stale `t` (e.g. |now - t| > 300s).
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(f["t"] + "." + rawBody))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(f["v1"]))
}

func main() {
	raw, err := os.ReadFile(vectorsPath())
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read vectors:", err)
		os.Exit(1)
	}
	var doc webhookDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		fmt.Fprintln(os.Stderr, "cannot parse vectors:", err)
		os.Exit(1)
	}
	secret := doc.TestSecret.Value

	failures := 0
	for _, v := range doc.Vectors {
		ok := verify(secret, v.Header, v.Payload)
		status := "OK  "
		if !ok {
			status = "FAIL"
			failures++
		}
		fmt.Printf("%s  %s\n", status, v.Name)
	}

	// Negative control: a tampered body must NOT verify.
	tamperOK := verify(secret, doc.Vectors[0].Header, doc.Vectors[0].Payload+" ")
	if tamperOK {
		fmt.Println("FAIL  negative control (tampered body is rejected)")
		failures++
	} else {
		fmt.Println("OK    negative control (tampered body is rejected)")
	}

	if failures > 0 {
		fmt.Fprintf(os.Stderr, "\n%d check(s) failed\n", failures)
		os.Exit(1)
	}
	fmt.Printf("\nAll %d webhook vectors verified.\n", len(doc.Vectors))
}
