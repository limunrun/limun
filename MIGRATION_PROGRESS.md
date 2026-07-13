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
- [x] Primordials — `src/js/00_primordials.js` (Deno's, MIT), first module evaluated
- [x] Ext bootstrap ordering — registry order in `src/core/mod.rs` execute()
- [x] Proof test — `tests/infra/proof.js` asserts `__infraProof === "HELLO 5"`, passes

### Infrastructure details
- Internal scheme: `ext:limun/<path>` (analogous to Deno's `ext:deno_web/`)
- Ops: bare `v8::FunctionCallback` registered by name on `__limunOps` object
- No `core.loadExtScript` — internal modules are ESM in static registry
- No snapshot — modules compile on first eval, dedup via REGISTRY
- Differences from Deno: simpler ops surface (no OpState/op2), no snapshot, `__limunOps` vs `Deno.core.ops`

## Phase 1 — Pilot: base64 ✅ DONE

- [x] Port Deno's `05_base64.js` to `src/js/05_base64.js`
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
  - JS: `src/js/{19_body,20_headers,21_request,22_response,23_fetch}.js`
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
behavior lives in `src/js/`.

## Core verification
- [ ] Verify src/core/ (event loop, module/resolver, permissions, io, exceptions, rejections)

## Post-migration cleanup found during fetch verification
- `tests/unit/smoke_test.js` referenced the old non-spec `ReadableStreamReader` global
  (dropped by the streams migration in favor of the spec-correct `ReadableStreamDefaultReader`)
  — fixed to use the correct name.
- `src/js/06_streams.js`'s `enqueue()` didn't coerce string chunks to UTF-8 bytes, a
  documented simplification the old Rust streams.rs had ("Chunks are byte slices...
  string on enqueue"). Restored via `coerceChunk()` since Limun's streams are only ever
  byte streams in practice (Response.body/Request.body/Blob.stream()).
- `WEAK_HANDLES` in `src/core/state.rs` is now dead (its only pusher, `web::native::store`,
  is deleted) — left as infrastructure for a future native class, doc comment updated.

## Notes
- Build: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo build`
- WPT: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo run -- tests/wpt/run.js`
- Baseline WPT (pre-migration): 78/79 (1 known failure: AbortSignal.any() event ordering)
- Current WPT: 752/753 (added base64 + FileAPI suites; AbortSignal.any ordering FIXED by the
  event migration; 1 remaining failure needs MessageChannel, not implemented, unrelated)
- Other passing suites: `tests/infra/proof.js`, `tests/unit/smoke_test.js`,
  `tests/unit/review_test.js`, `tests/unit/fetch_smoke.js`, `tests/unit/blob_formdata_test.js`,
  `tests/url_smoke.js`