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

## Phase 1 — Pilot: base64

- [ ] Port Deno's `05_base64.js` to internal JS
- [ ] Add `op_base64_atob` / `op_base64_btoa` Rust ops
- [ ] Rewire boundaries (ops, primordials, DOMException from JS layer)
- [ ] Reduce old Rust `src/web/base64.rs` to ops only
- [ ] WPT `html/webappapis/atob/base64.any.js` green through JS path
- [ ] Verifier passes

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