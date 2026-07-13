# Migration Progress — JS-on-Ops Architecture

Limun is migrating from 100% Rust web APIs to Deno's architecture: JS web APIs
in the isolate on top of thin Rust ops. This file is the source of truth for
progress across subagents and context compactions.

## Reference
- Deno source: `Projects/@nomadshiba/deno` (read-only)
- Limun conventions: `IO.md` + existing `src/core/` ops/permissions
- Completed phases archived in `docs/MIGRATION_ARCHIVE.md`

## Current state

All web APIs are JS-on-ops. 32 ops. WPT 2156/2160. Build clean, zero warnings.
Present: URL/URLSearchParams, WebIDL, console (recursive inspector), DOMException,
Event/EventTarget/AbortController/AbortSignal, structuredClone, timers, base64,
full Streams (Readable/Writable/Transform/BYOB), TextEncoder/TextDecoder, Blob/File,
FormData, MessageChannel/MessagePort/MessageEvent, performance (real EventTarget),
Body/Headers/Request/Response/fetch, alert/confirm/prompt.

## This run's items

### 1. Web Crypto (the biggest gap — Limun has NONE of it)
- [ ] `crypto.getRandomValues()` + `crypto.randomUUID()` — small, high-value
- [ ] `crypto.subtle` (SubtleCrypto): digest, generateKey, importKey/exportKey,
      encrypt/decrypt, sign/verify, deriveBits/deriveKey, wrapKey/unwrapKey
- [ ] Add WebCryptoAPI WPT suites — green before moving on
- **Status:** not started
- **Ops added:** (none yet)
- **Deviations:** (none yet)

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
- Current WPT: 2156/2160