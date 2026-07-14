# Migration Progress — JS-on-Ops Architecture

Limun is migrating from 100% Rust web APIs to Deno's architecture: JS web APIs
in the isolate on top of thin Rust ops. This file is the source of truth for
progress across subagents and context compactions.

## Reference
- Deno source: `Projects/@nomadshiba/deno` (read-only)
- Limun conventions: `IO.md` + existing `src/core/` ops/permissions
- Completed phases archived in `docs/MIGRATION_ARCHIVE.md`

## Current state

All web APIs are JS-on-ops. 60+ ops. WPT 24196/24200. Build clean, zero warnings.
Present: URL/URLSearchParams, WebIDL, console (recursive inspector), DOMException,
Event/EventTarget/AbortController/AbortSignal, structuredClone, timers, base64,
full Streams (Readable/Writable/Transform/BYOB), TextEncoder/TextDecoder, Blob/File,
FormData, MessageChannel/MessagePort/MessageEvent, performance (real EventTarget),
Body/Headers/Request/Response/fetch, alert/confirm/prompt,
Full Web Crypto: getRandomValues, randomUUID, SubtleCrypto (digest, generateKey,
importKey, exportKey, sign, verify, encrypt, decrypt, deriveBits, deriveKey,
wrapKey, unwrapKey) — HMAC, AES-CBC/CTR/GCM/KW, RSA (PKCS1-v1_5/PSS/OAEP),
EC (ECDSA/ECDH P-256/P-384/P-521), Ed25519, X25519, HKDF, PBKDF2.

## This run's items

### 1. Web Crypto — COMPLETE
- [x] Increment 1: `crypto.getRandomValues()`, `crypto.randomUUID()`, `crypto.subtle.digest()`
- [x] Increment 2a: SubtleCrypto framework + HMAC + AES-CBC/CTR/GCM/KW
- [x] Increment 2b: RSA (PKCS1-v1_5/PSS/OAEP), EC (ECDSA/ECDH P-256/P-384/P-521),
      Ed25519, X25519, HKDF, PBKDF2, AES-KW wrap/unwrap, wrapKey/unwrapKey
- [x] WebCryptoAPI WPT suites green (getRandomValues, randomUUID, digest, HMAC, AES, RSA, EC, Ed25519, X25519, HKDF, PBKDF2, wrapKey/unwrapKey)
- **Status:** complete — WPT 24196/24200 (4 pre-existing streams/messaging failures)
- **Ops added:** `op_crypto_get_random_values`, `op_crypto_random_uuid`, `op_crypto_digest`,
  `op_crypto_generate_key`, `op_crypto_sign_hmac`, `op_crypto_encrypt_aes_{cbc,ctr,gcm}`,
  `op_crypto_decrypt_aes_{cbc,ctr,gcm}`, `op_crypto_sign_rsa`, `op_crypto_verify_rsa`,
  `op_crypto_encrypt_rsa_oaep`, `op_crypto_decrypt_rsa_oaep`, `op_crypto_sign_ecdsa`,
  `op_crypto_verify_ecdsa`, `op_crypto_derive_bits_ecdh`, `op_crypto_generate_key_ec`,
  `op_crypto_import_key_{spki,pkcs8,jwk}`, `op_crypto_export_key_{spki,pkcs8,jwk}`,
  `op_crypto_sign_ed25519`, `op_crypto_verify_ed25519`, `op_crypto_generate_key_ed25519`,
  `op_crypto_import_key_ed25519`, `op_crypto_export_key_ed25519`, `op_crypto_derive_bits_x25519`,
  `op_crypto_generate_key_x25519`, `op_crypto_import_key_x25519`, `op_crypto_export_key_x25519`,
  `op_crypto_derive_bits_hkdf`, `op_crypto_derive_bits_pbkdf2`, `op_crypto_wrap_key_aes_kw`,
  `op_crypto_unwrap_key_aes_kw`
- **Deviations:**
  - Limun stores key material on the JS CryptoKey directly (private symbol `_keyData`), rather than in a Rust key_store / cppgc handle (simpler, matches JS-on-ops architecture)
  - Used sha1 0.11 / sha3 0.12 (not 0.10) to match sha2 0.11's digest crate version
  - Added `QuotaExceededError` DOMException subclass (WPT harness checks constructor identity)
  - `crypto` global is enumerable (correct per Web IDL §3.7.3, matches browsers)

### 2. Complete `ext/web` — COMPLETE
- [x] `10_filereader.js` — FileReader
- [x] `14_compression.js` — CompressionStream / DecompressionStream
- [x] TextEncoderStream / TextDecoderStream
- [x] `01_mimesniff.js` — MIME type parsing, wired into FileReader.readAsText charset
- [x] `00_infra.js` — shared infra helpers
- [x] `reportError` global + ErrorEvent/ProgressEvent plumbing
- **Status:** complete — WPT 24339/24343 (4 pre-existing streams/messaging failures)

### 3. navigator + URLPattern — COMPLETE
- [x] `navigator` global (Navigator interface: userAgent, hardwareConcurrency, language, languages, platform, onLine)
- [x] `URLPattern` — ported from Deno's `ext/url/01_urlpattern.js`
- **Status:** complete — WPT 24339/24343 (4 pre-existing streams/messaging failures; no URLPattern WPT suite vendored)

### 4. WebSocket + BroadcastChannel — COMPLETE
- [x] `WebSocket` — full client using tokio-tungstenite, permission-gated
- [x] `BroadcastChannel` — pure JS in-process pub/sub
- **Status:** complete — WPT 24444/24449 (5 failures: 4 pre-existing + 1 CORS fetch)

### 5. Fix the remaining WPT failures
- [ ] Enumerate, diagnose, fix each. If out of scope, explain in this file.
- **Status:** not started — 5 failures:
  1. "When transferring a non-enabled port multiple times" (MessagePort)
  2. "Patched then() sees byobRequest after filling all pending pull-into descriptors" (Streams)
  3. "readable.cancel() and a parallel writable.close() should reject…" (Streams/TransformStream)
  4. "enqueue() must not synchronously call write algorithm" (Streams/TransformStream)
  5. "Loading data…" — CORS fetch test trying to load local file (fetch limitation)

### 6. V8 startup snapshot
- [ ] Snapshot bootstrapped heap at build time (rusty_v8 startup snapshots)
- [ ] Report startup-time delta
- **Status:** not started

## NOT in scope this run (known gaps)
Web Storage (localStorage/sessionStorage), Cache API, ImageData/canvas, Web Workers,
Performance Timeline (mark/measure/PerformanceObserver).

## Notes
- Build: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo build`
- WPT: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo run -- tests/wpt/run.js`
- Baseline WPT (pre-migration): 78/79
- Current WPT: 24444/24449