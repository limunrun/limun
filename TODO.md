# TODO

## Tests

The test infrastructure is set up. Three tiers:

### WPT (Web Platform Tests) — `tests/wpt/`

- [x] `tests/wpt/suite/` — solo-clone of `https://github.com/web-platform-tests/wpt.git`
  (shallow, `epochs/daily` branch, gitignored)
- [x] `tests/wpt/run.js` — runner that loads WPT test files via indirect eval
- [x] `tests/wpt/harness/` — `testharness.js` (from suite) + custom `testharnessreport.js`
- [x] Default subset: `hr-time`, `encoding`, `dom/abort`
- [ ] Expand to: `fetch`, `url`, `streams`, `FileAPI`, `dom/events`
  (needs fixtures or self-contained files only)
- [ ] Fix known bugs found by WPT (see `tests/wpt/FINDINGS.md`):
  - `on<event>` handler attribute support on `EventTarget`
  - `TextEncoder.encode(undefined)` should default to `""`
  - `AbortSignal.any()` dependent-signal abort event ordering

### Unit tests — `tests/unit/`

- [x] `smoke_test.js` — comprehensive web API smoke test (all implemented globals)
- [x] `review_test.js` — review-pass fixes verification
- [x] `fixtures/` — shared fixture files for the smoke tests

### Limun-specific tests — `tests/limun/`

Tests for things WPT doesn't cover — limun's own features:
- [x] `import_maps_test.js` — import maps (bare, prefix, blocked, scopes),
  import attributes (json, text, error cases), `import.meta`,
  permissions (allow path)
- [ ] Permissions deny path — needs a separate `limun.json` (can't test
  in-process; permissions load once at startup). Could spawn a subprocess
  with a custom config.
- [ ] `default: true` (blacklist mode) — same, needs separate config.

### Node compat tests

- [ ] `tests/node_compat/` — solo-clone of `https://github.com/denoland/node_test.git`
  (gitignored, pulled in devcontainer). Only relevant once `@limun/node`
  exists.

## Explicitly not in scope

- `npm:` specifiers, `blob:` module scheme
- Node/Deno-style globals (`process.*`, `Deno.*`) in the core runtime
- Import attribute `resolution-mode` (TypeScript-only)
- Submodules — tests are solo-cloned, not git submodules

## Deferred (build when there's a concrete driver)

- `WebSocket`
- `crypto` (Web Crypto — `crypto.getRandomValues`, `crypto.subtle.*`)
- `structuredClone`
- `Worker`/`MessagePort`/`BroadcastChannel` (multi-isolate; real architecture
  project). When it lands, worker permissions: `new Worker(url, { limun:
  { permissions } })` — an explicitly-set permissions object does NOT inherit
  the host's (empty object = no permissions at all), but the host's grants
  always cap it (worker ⊆ host, intersection). No CLI prompting.
- `Intl`
- `URL.createObjectURL`/`revokeObjectURL`
- `WritableStream`/`TransformStream`
- BYOB readers for `ReadableStream`

## Known limitations (working as intended)

- `TextEncoder` UTF-8-only — spec-correct.
- `console` formatting is flat `ToString` (no recursive inspector).
- Static `import` stays sync (V8 API constraint —
  `ResolveModuleCallback` returns `*const Module` synchronously).
- Fetch body is fully buffered then wrapped in a one-chunk stream — not true
  incremental streaming. Spec-correct; streaming is a perf optimization.
- `ReadableStream` is `start`-only (no `pull`/backpressure/BYOB/tee/pipe).
- No header-guard / forbidden-header enforcement (no privilege boundary in a
  CLI).