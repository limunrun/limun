# Migration Progress — JS-on-Ops Architecture

Limun is migrating from 100% Rust web APIs to Deno's architecture: JS web APIs
in the isolate on top of thin Rust ops. This file is the source of truth for
progress across subagents and context compactions.

## Reference
- Deno source: `Projects/@nomadshiba/deno` (read-only)
- Limun conventions: `IO.md` + existing `src/core/` ops/permissions

## Phase 0 — Infrastructure ✅ DONE

- [x] Internal ESM loading — `src/core/internal_js.rs`, `ext:limun/` specifiers,
  static registry via `include_str!`, bypasses IO/permissions
- [x] Op registration — `src/core/ops.rs`, `globalThis.__limunOps` flat object
- [x] Primordials — `src/core/00_primordials.js` (Deno's, MIT), first module evaluated
- [x] Ext bootstrap ordering — registry order in `src/core/mod.rs` execute()
- [x] Proof test — `tests/infra/proof.js` asserts `__infraProof === "HELLO 5"`, passes

### Infrastructure details
- Internal scheme: `ext:limun/<path>` (analogous to Deno's `ext:deno_web/`)
- Ops: bare `v8::FunctionCallback` registered by name on `__limunOps` object
- No `core.loadExtScript` — internal modules are ESM in static registry
- No snapshot — modules compile on first eval, dedup via REGISTRY
- Differences from Deno: simpler ops surface (no OpState/op2), no snapshot, `__limunOps` vs `Deno.core.ops`

## Phase 1 — Pilot: base64 ✅ DONE

- [x] Port Deno's `05_base64.js` to `src/web/05_base64.js`
- [x] Add `op_base64_atob` / `op_base64_btoa` Rust ops in `src/core/ops.rs`
- [x] Rewire: `__limunOps`, primordials, `globalThis.DOMException`
- [x] Remove `src/web/base64.rs`, remove `set_fn` calls from `src/web/mod.rs`
- [x] WPT `html/webappapis/atob/base64.any.js` green (380/380 base64 tests, 458/459 overall)
- [x] Verifier passes

### Ops added
- `op_base64_btoa(input: String) -> String` — Latin-1 validate + base64 encode, TypeError on >0xFF
- `op_base64_atob(input: String) -> String` — forgiving base64 decode to binary string, TypeError on invalid

### Deviations from Deno
- WebIDL inline (no full webidl module yet) — will extract when 2nd module needs it
- Forgiving-base64 validation split: spec steps (whitespace/padding/length/alphabet) in JS, bit math in Rust op
- Uses `base64` crate instead of simdutf
- `fetch_json` shim in WPT runner for local JSON fixtures (module loader instead of fetch)

## Phase 2 — Remaining modules (dependency-first)

- [x] dom_exception (JS port + Rust bridge for new_instance)
- [x] text_encoding (JS port + 6 ops, bug #2 fixed)
- [x] console (JS port, 1 op: op_print)
- [x] timers (JS port, 3 ops: op_timer_schedule/clear/queue_microtask)
- [x] performance (JS port, 2 ops: op_now/op_time_origin; EventTarget stubbed)
- [x] prompt (JS port, 4 ops: op_prompt_is_tty/alert/confirm/prompt)
- [x] event (Event/CustomEvent/EventTarget/AbortController/AbortSignal) — 459/459, bugs #1 and #3 fixed
- [x] url / url_search_params (JS port, 6 handle-based ops, 61 smoke tests)
- [x] streams (JS port, start-only; Rust bridge for blob/fetch stream creation)
- [x] blob / form_data (JS port, no ops; 293 new FileAPI WPT tests added)
- [x] fetch/* (fetch, Headers, Response, Request) — LAST module, all web APIs now JS-on-ops
  - JS: `src/web/{19_body,20_headers,21_request,22_response,23_fetch}.js`
  - One op: `op_fetch(method, url, headerPairs, body, signal) -> Promise` — permission check,
    tokio spawn, AbortSignal cancellation trampoline all stay in Rust (`src/web/fetch/mod.rs`,
    reduced to transport only). `event_loop::resolve_fetch` settles with a flat result object
    (status/statusText/headers/body/url/redirected); JS constructs the actual `Response`.
  - Deleted (dead bridges, no Rust callers left): `src/web/{blob,form_data,streams,native}.rs`
  - Fixed a signal-handling bug: `init.signal` was cleared whenever any `init` object was
    passed, even without a `signal` key (v8 `get()` quirk) — now only touches signal when
    the key is present.

**ALL WEB MODULES MIGRATED.** `src/web/` is now: `fetch/mod.rs` (transport op only),
`dom_exception.rs`/`performance.rs`/`streams.rs`(deleted)/`blob.rs`(deleted)/`form_data.rs`(deleted)
bridges reduced or removed, `mod.rs` (global install wiring only). All spec-observable
behavior lives in `src/web/`.

## Core verification ✅ DONE

- [x] Verify src/core/ (event loop, module/resolver, permissions, io, exceptions, rejections)

**Verdict: complete and correct.** No bugs block web/ or the migration. Reviewed:
event loop (bridge channel dispatch, microtask checkpoints, teardown ordering),
module system (static/dynamic import, JSON/text attributes, `ext:` routing, SRI),
permissions (glob matcher, deny/allow/default semantics, single choke point
confirmed), exception/rejection reporting, `ops.rs` (1214 lines, no dead ops, no
duplicates, every op called from `src/web/`), `internal_js.rs` registry order (no
dependency violations — modules mutate `globalThis` directly, evaluated in
registry order, no cross-module static imports).

Two minor findings, both non-blocking (out of scope for this migration per
"prefer NOT to rewrite core unless a failure traces to it or it blocks web"):
- `event_loop.rs`: `clearTimeout`/`clearInterval` on an id after its one-shot
  timer already fired naturally leaks an entry in the `CANCELLED` set (can't
  distinguish "self-cancel mid-fire" from "stale clear after completion").
  Slow, unbounded growth in very long-running processes with a
  cleanup-always-clears pattern. Left as a follow-up — doesn't block web.
- `internal_js.rs` doc comment claimed a referrer check for `ext:` imports
  that isn't actually implemented (any importer can `import "ext:limun/…"`
  directly) — fixed the doc to describe actual behavior; the missing
  enforcement is a hardening task, not a migration requirement (harmless
  today — importing an `ext:` module doesn't expose anything beyond
  already-installed globals).

Full test suite green: `tests/infra/proof.js`, `tests/unit/smoke_test.js`,
`tests/unit/review_test.js`, `tests/limun/import_maps_test.js` all pass;
WPT 752/753 (1 pre-existing MessageChannel gap, unrelated to core).
`cargo build` clean, zero warnings.

## Post-migration cleanup found during fetch verification
- `tests/unit/smoke_test.js` referenced the old non-spec `ReadableStreamReader` global
  (dropped by the streams migration in favor of the spec-correct `ReadableStreamDefaultReader`)
  — fixed to use the correct name.
- `src/web/06_streams.js`'s `enqueue()` didn't coerce string chunks to UTF-8 bytes, a
  documented simplification the old Rust streams.rs had ("Chunks are byte slices...
  string on enqueue"). Restored via `coerceChunk()` since Limun's streams are only ever
  byte streams in practice (Response.body/Request.body/Blob.stream()).
- `WEAK_HANDLES` in `src/core/state.rs` is now dead (its only pusher, `web::native::store`,
  is deleted) — left as infrastructure for a future native class, doc comment updated.

## Post-migration cleanup — Item 1: Layout fix ✅ DONE

The flat `src/js/` directory is gone. Internal JS is colocated with its Rust:
- web-surface modules (17) → `src/web/*.js` (flat, next to `fetch/`, `mod.rs`, etc.)
- runtime infra (primordials, test harness) → `src/core/*.js` (next to `internal_js.rs`, `ops.rs`)
- `include_str!` paths in `src/core/internal_js.rs` updated; `ext:limun/…` specifiers and
  REGISTRY bootstrap order UNCHANGED.
- Verified by independent verifier: `src/js/` absent, no `src/js/` or `../js/` references
  remain, build clean 0 warnings, WPT 752/753, all unit/infra tests pass, git diff is pure
  renames + path-string swaps (no logic change).

## Post-migration cleanup — Item 2: Shared WebIDL module ✅ DONE

Ported Deno's `ext/webidl/00_webidl.js` (1558 lines) into `src/web/00_webidl.js`
(1616 lines), exposed as `globalThis.__bootstrap.webidl`. Rewired all 14 modules
that had inline WebIDL copies (`00_url`, `01_dom_exception`, `02_event`,
`02_timers`, `05_base64`, `06_streams`, `08_text_encoding`, `09_blob`,
`10_form_data`, `20_headers`, `21_request`, `22_response`, `41_prompt` +
`19_body` via adapters). Deleted every inline `requiredArguments`/
`convertDOMString`/`convertUSVString`/`convertLong`/`convertObject`/`convertAny`/
`convertUnsignedLongLong`/`brand` symbol/`assertBranded`/inline
`mixinPairIterable` — now all delegate to `webidl.*`.

### Ops added
- `op_is_proxy(value) -> boolean` — `src/core/ops.rs`; the one `core.*` call in
  Deno's webidl (`core.isProxy`), used by `createRecordConverter` to reject Proxy
  traps. Calls `v8::Value::is_proxy()`. Registered on `__limunOps`.

### Registry
- `src/core/internal_js.rs` REGISTRY: `00_webidl.js` inserted after
  `00_primordials.js`, before `01_dom_exception.js`. Specifier
  `ext:limun/00_webidl.js`.

### Deviations from Deno's WebIDL
- `core.isProxy` → `op_is_proxy` op (no `core.*` shim in Limun).
- `core.isArrayBuffer`/`isDataView`/`isTypedArray` → pure-JS
  `ObjectPrototypeIsPrototypeOf` checks; `core.isSharedArrayBuffer` → constant
  `false` (Limun has no SAB — `allowShared` opts collapse to spec-correct branch).
- `internals.webidlBrand = brand` dropped (no `internals` namespace, no reader).
- `return {…}` → `globalThis.__bootstrap.webidl = {…}` (Limun's cross-module pattern).

### Module-local composites kept (delegate to webidl.converters.*)
- `09_blob.js`: `convertBlobPart`/`convertBlobParts`/`encodeUSVStringPartToBytes`
  (Blob-specific union dispatch + byte snapshot).
- `10_form_data.js`: `roundTripUSVString` (byte-identical USVString round-trip).
- `08_text_encoding.js`: `convertTextDecoderOptions`/`convertTextDecodeOptions`
  (tiny dicts, inlined to avoid per-call dictionary-converter allocation).
- `21_request.js`/`22_response.js`: 2-arg `assertBranded` adapters binding the
  interface name for `19_body.js`'s `mixinBody` callback.

Verified: build clean 0 warnings, WPT 752/753, all unit/infra tests pass.

## Post-migration cleanup — Item 3: Spec gaps (in progress)

### 3a. Streams — full Streams Standard ✅ DONE

Replaced the 880-line start-only subset (`src/web/06_streams.js`) with a 7118-line
full port of Deno's `ext/web/06_streams.js`. Classes: `ReadableStream` (pull,
cancel, backpressure, `static from`), `ReadableStreamDefaultReader`,
`ReadableStreamBYOBReader`, `ReadableStreamBYOBRequest`,
`ReadableStreamDefaultController`, `ReadableByteStreamController`,
`WritableStream`, `WritableStreamDefaultWriter`, `WritableStreamDefaultController`,
`TransformStream`, `TransformStreamDefaultController`, `ByteLengthQueuingStrategy`,
`CountQueuingStrategy`, + 177 internal algorithms (pipeTo/pipeThrough/tee/async
iteration/BYOB/byte streams). `createFixedReadableStream` preserved on
`globalThis.__bootstrap` (consumed by `09_blob.js`/`19_body.js`/`22_response.js`).

Deno machinery dropped: resource/rid ops (`op_readable_stream_resource_*`/
`op_read_all`/`op_pipe`/`fastPipeTo`), `_resourceBacking`, custom-inspect
(`[SymbolFor("Deno.privateCustomInspect")]`), transferable
(`core.registerTransferableResource`/`*TransferSteps`), Node.js interop symbols,
`core.refOpPromise`/`unrefOpPromise`, `core.tryClose`/`close`. `structuredClone`
dep replaced with in-module `cloneChunk` (byte-copy for tee — full structured-clone
is MessageChannel's task).

`02_event.js` gained `globalThis.__bootstrap.abortSignal` surface
(`{ AbortSignalPrototype, signalAbort, add, remove, newSignal }`) +
`webidl.converters.AbortSignal` + `webidl.converters["sequence<AbortSignal>"]`
for the Streams Standard's abort wiring.

WPT: **1859/1868** (added 70 streams test files: readable-streams 14,
readable-byte-streams 10, writable-streams 15, transform-streams 11,
queuing-strategies 1, piping 13). 9 failures: 1 pre-existing MessageChannel +
8 streams edge cases (5 ArrayBuffer `transfer()`/detach — structured-clone
territory; 2 microtask-timing in `pipeTo` pump; 1 transform-cancel race).
Build clean 0 warnings; all unit/infra tests pass.

Deviations from Deno:
- `coerceChunk` defined but NOT applied to public `enqueue` (WPT requires strings
  pass through; old Limun byte-coercion kept only for `createFixedReadableStream`).
- `cloneChunk` (byte-copy) replaces `structuredClone` in `tee`.
- `assert` is in-module TypeError-thrower; `rethrowAssertionErrorRejection` no-op.
- `fastPipeTo`/`op_pipe` dropped — `readableStreamPipeTo` pure-JS slow path.

### 3b. MessageChannel/MessagePort/MessageEvent + structured clone ✅ DONE

Implemented `MessageChannel`/`MessagePort`/`MessageEvent` + `structuredClone`
global. Single-realm (per MISSION.md): transport is JS-side message queues +
microtask delivery — no tokio channels, no resource table, no
`op_message_port_*` ops.

Rust ops added (`src/core/ops.rs`, flat `v8::FunctionCallback`):
- `op_structured_clone(value) -> value` — V8 `ValueSerializer`→`ValueDeserializer`
  round-trip.
- `op_serialize(value, hostObjects?, transferredArrayBuffers?, errorCallback?)
  -> Uint8Array` — full serialize with host-object + ArrayBuffer-transfer support.
- `op_deserialize(bytes, hostObjects?, transferredArrayBuffers?) -> value` —
  deserialize. ArrayBuffer transfer via stashed backing stores (thread_local
  `TRANSFERRED_BUFFERS` — safe: serialize→deserialize is synchronous, same
  thread).
- Supporting: `SerializeDeserialize` struct (impls `ValueSerializerImpl`/
  `ValueDeserializerImpl`), `TransferredBuffer` struct, `host_object_brand_symbol`
  (`Symbol.for("limun.hostObject")`).

JS modules:
- `src/web/02_structured_clone.js` (244 lines) — `structuredClone` global;
  ArrayBuffer/TypedArray/DataView fast paths; TypeError→DOMException
  DataCloneError wrapping.
- `src/web/13_message_port.js` (707 lines) — `MessageChannel`/`MessagePort`/
  `MessageEvent`; single-realm JS-side queue + microtask delivery; port
  transfer via host-object brand + `partnerPorts` sideband + `_pendingQueue`
  buffering.
- `02_event.js` updated: `defineEventHandler` gained optional `onFirstSet`
  callback (for `onmessage`→`start()`); `globalThis.__bootstrap.event`
  exposed.

REGISTRY: `02_structured_clone.js` + `13_message_port.js` inserted after
`02_event.js`, before `05_base64.js`.

WPT: **1888/1892** (was 1859/1868). FileAPI MessagePort test passes ✅. 5
streams ArrayBuffer-transfer tests now pass ✅ (structuredClone wired into
streams `cloneChunk`). New messagechannel suites added. Remaining 4
failures: 3 pre-existing streams microtask/transform edge cases + 1
multi-hop port-transfer ordering edge case (single-hop transfer works).
Build clean 0 warnings; all unit/infra tests pass.

Deviations from Deno:
- No `op_message_port_*` / resource-rid model — JS-side queues.
- ArrayBuffer transfer via stashed backing stores (Deno uses SAB store).
- No SAB / Wasm module store (returns `None`).
- Host-object brand `Symbol.for("limun.hostObject")` (Deno: `hostObject`).
- `defineEventHandler` extended with optional `onFirstSet`.
- `MessageEvent` defined in `13_message_port.js` (Deno: `02_event.js`).
- No `core.registerTransferableResource`/`Transferable`/`*TransferSteps` —
  brand-symbol mechanism.

## Notes
- Build: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo build`
- WPT: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo run -- tests/wpt/run.js`
- Baseline WPT (pre-migration): 78/79 (1 known failure: AbortSignal.any() event ordering)
- Current WPT: 752/753 (added base64 + FileAPI suites; AbortSignal.any ordering FIXED by the
  event migration; 1 remaining failure needs MessageChannel, not implemented, unrelated)
- Other passing suites: `tests/infra/proof.js`, `tests/unit/smoke_test.js`,
  `tests/unit/review_test.js`, `tests/unit/fetch_smoke.js`, `tests/unit/blob_formdata_test.js`,
  `tests/url_smoke.js`