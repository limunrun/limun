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

- [ ] dom_exception (JS port + ops if any)
- [ ] console/* (JS port)
- [ ] event (Event/EventTarget/AbortController/AbortSignal)
- [ ] performance (HR Time)
- [ ] text_encoding (TextEncoder/TextDecoder)
- [ ] url / url_search_params
- [ ] timers
- [ ] fetch/* (fetch, Headers, Response, Request)
- [ ] blob / form_data
- [ ] streams
- [ ] prompt (alert/confirm/prompt)

## Core verification
- [ ] Verify src/core/ (event loop, module/resolver, permissions, io, exceptions, rejections)

## Notes
- Build: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo build`
- WPT: `distrobox-host-exec podman exec -w /workspaces/limun gallant_chaplygin cargo run -- tests/wpt/run.js`
- Baseline WPT: 78/79 (1 known failure: AbortSignal.any() event ordering — FINDINGS.md #3)