# Migration Progress — JS-on-Ops Architecture

Limun is migrating from 100% Rust web APIs to Deno's architecture: JS web APIs
in the isolate on top of thin Rust ops. This file is the source of truth for
progress across subagents and context compactions.

## Reference
- Deno source: `Projects/@nomadshiba/deno` (read-only)
- Limun conventions: `IO.md` + existing `src/core/` ops/permissions
- Completed phases archived in `docs/MIGRATION_ARCHIVE.md`

## Current state

All web APIs are JS-on-ops. 35 ops. WPT 2314/2318. Build clean, zero warnings.
Present: URL/URLSearchParams, WebIDL, console (recursive inspector), DOMException,
Event/EventTarget/AbortController/AbortSignal, structuredClone, timers, base64,
full Streams (Readable/Writable/Transform/BYOB), TextEncoder/TextDecoder, Blob/File,
FormData, MessageChannel/MessagePort/MessageEvent, performance (real EventTarget),
Body/Headers/Request/Response/fetch, alert/confirm/prompt,
Crypto (getRandomValues, randomUUID, subtle.digest).

## This run's items

### 1. Web Crypto (the biggest gap — Limun has NONE of it)
- [x] `crypto.getRandomValues()` + `crypto.randomUUID()` + `crypto.subtle.digest()`
  - Increment 1: complete, WPT green (getRandomValues 39/39, randomUUID 4/4, digest 64/64)
  - Ops: `op_crypto_get_random_values`, `op_crypto_random_uuid`, `op_crypto_digest`
  - JS: `src/web/03_crypto.js` — Crypto/SubtleCrypto/CryptoKey classes + `crypto` global
  - Added `QuotaExceededError` subclass to `01_dom_exception.js` (WPT harness requires constructor identity)
  - Crates: rand 0.8, sha1 0.11, sha3 0.12 (sha2 0.11 already present)
- [ ] `crypto.subtle` (SubtleCrypto): generateKey, importKey/exportKey,
      encrypt/decrypt, sign/verify, deriveBits/deriveKey, wrapKey/unwrapKey
- [x] Add WebCryptoAPI WPT suites (getRandomValues, randomUUID, digest — green)
- **Status:** increment 1 done, increment 2 (SubtleCrypto full) in progress
- **Ops added:** `op_crypto_get_random_values`, `op_crypto_random_uuid`, `op_crypto_digest`
- **Deviations:** 
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
- Current WPT: 2314/2318