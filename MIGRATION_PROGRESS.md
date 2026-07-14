# Migration Progress — JS-on-Ops Architecture

Limun is migrating from 100% Rust web APIs to Deno's architecture: JS web APIs
in the isolate on top of thin Rust ops. This file is the source of truth for
progress across subagents and context compactions.

## Reference
- Deno source: `Projects/@nomadshiba/deno` (read-only)
- Limun conventions: `IO.md` + existing `src/core/` ops/permissions
- Completed phases archived in `docs/MIGRATION_ARCHIVE.md`

## Current state

All web APIs are JS-on-ops. 42 ops. WPT 8249/8261. Build clean, zero warnings.
Present: URL/URLSearchParams, WebIDL, console (recursive inspector), DOMException,
Event/EventTarget/AbortController/AbortSignal, structuredClone, timers, base64,
full Streams (Readable/Writable/Transform/BYOB), TextEncoder/TextDecoder, Blob/File,
FormData, MessageChannel/MessagePort/MessageEvent, performance (real EventTarget),
Body/Headers/Request/Response/fetch, alert/confirm/prompt,
Crypto (getRandomValues, randomUUID, subtle.{digest, generateKey, importKey, exportKey, sign, verify, encrypt, decrypt}), HMAC, AES-CBC/CTR/GCM/KW.

## This run's items

### 1. Web Crypto (the biggest gap — Limun has NONE of it)
- [x] `crypto.subtle` (SubtleCrypto) — symmetric algorithms complete
  - Increment 2a: framework + HMAC + AES-CBC/CTR/GCM/KW — complete, WPT 8249/8261
    - Framework: `normalizeAlgorithm`, `constructKey`, WebIDL algorithm dictionary converters
    - SubtleCrypto methods: `generateKey`, `importKey`, `exportKey`, `sign`, `verify`, `encrypt`, `decrypt`, `deriveBits`, `deriveKey`, `wrapKey`, `unwrapKey` (method shells with NotSupportedError stubs for unimplemented algorithms)
    - Ops added: `op_crypto_generate_key`, `op_crypto_sign_hmac`, `op_crypto_encrypt_aes_cbc`, `op_crypto_decrypt_aes_cbc`, `op_crypto_encrypt_aes_ctr`, `op_crypto_decrypt_aes_ctr`, `op_crypto_encrypt_aes_gcm`, `op_crypto_decrypt_aes_gcm`
    - Crates added: hmac 0.12, aes 0.8, cbc 0.1, ctr 0.9, aes-gcm 0.10
    - 8 remaining WPT failures in `sign_verify/hmac.https.any.js` are HMAC "generate wrong key step" tests that require ECDSA `generateKey` to create a wrong key — out of scope for this increment (will be fixed when ECDSA is implemented)
- [ ] `crypto.subtle` (SubtleCrypto): RSA (PKCS1-v1_5/PSS/OAEP), EC (ECDSA/ECDH), Ed25519/X25519, HKDF, PBKDF2, wrapKey/unwrapKey fully implemented
- [x] Add WebCryptoAPI WPT suites (getRandomValues, randomUUID, digest, HMAC, AES symmetric tests green)
- **Status:** increment 2a done; increment 2b (asymmetric + KDFs) in progress
- **Ops added:** `op_crypto_get_random_values`, `op_crypto_random_uuid`, `op_crypto_digest`, `op_crypto_generate_key`, `op_crypto_sign_hmac`, `op_crypto_encrypt_aes_cbc`, `op_crypto_decrypt_aes_cbc`, `op_crypto_encrypt_aes_ctr`, `op_crypto_decrypt_aes_ctr`, `op_crypto_encrypt_aes_gcm`, `op_crypto_decrypt_aes_gcm`
- **Deviations:**
  - Limun stores key material on the JS CryptoKey directly (private symbol `_keyData`), rather than in a Rust key_store / cppgc handle (simpler, matches JS-on-ops architecture)
  - Used sha1 0.11 / sha3 0.12 (not 0.10) to match sha2 0.11's digest crate version
  - Added `QuotaExceededError` DOMException subclass (WPT harness checks constructor identity)
  - `crypto` global is enumerable (correct per Web IDL §3.7.3, matches browsers)

### 2. Complete `ext/web`
- [ ] `10_filereader.js` — FileReader
- [ ] `14_compression.js` — CompressionStream / DecompressionStream
- [ ] TextEncoderStream / TextDecoderStream (in Deno's `08_text_encoding.js`)
- [ ] `01_mimesniff.js` — MIME type parsing. Wire into Blob/Response
- [ ] `00_infra.js` — shared infra helpers
- [ ] `reportError`
- **Status:** not started

### 3. navigator + URLPattern
- [ ] `navigator` global (Navigator interface: userAgent, hardwareConcurrency, language)
- [ ] `URLPattern` — port Deno's `ext/url/01_urlpattern.js`
- **Status:** not started

### 4. WebSocket + BroadcastChannel
- [ ] `WebSocket` — port `ext/websocket`. Transport is Rust op; spec surface is JS.
      Permission-gated like `fetch`.
- [ ] `BroadcastChannel` — port `ext/broadcast_channel`
- **Status:** not started

### 5. Fix the 4 remaining WPT failures
- [ ] Enumerate, diagnose, fix each. If out of scope, explain in this file.
- **Status:** not started

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
- Current WPT: 8249/8261