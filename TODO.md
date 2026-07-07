# TODO

Honest accounting of what's missing or half-implemented. Ordered by
priority. Nothing here is secretly "done" — if it's not checked off
below, don't assume it works.

Explicitly **not** in scope (per discussion, don't re-add):
- `npm:` specifiers, `blob:` module scheme
- Node/Deno-style globals (`process.*`, `Deno.*`) in the core runtime
- Import attribute `resolution-mode` (TypeScript-only, not our concern)
- Permission system — considered done, no open issues

---

## P0 — Concurrency (the actual root cause)

This is one architectural gap, not three. `src/core/event_loop.rs` is a
timer wheel (`std::thread::sleep`) + microtask drain. It has never
multiplexed I/O because there's been no async I/O to multiplex. Fixing
this properly is a prerequisite for the two items under it.

- [ ] Replace the sleep-loop event loop with a real reactor. Either:
  - pull in `tokio` (current-thread runtime is enough, we're single-isolate)
    and drive V8 microtask checkpoints from tokio task wakeups, or
  - hand-roll a poll-based loop (`mio`) if we want to avoid the tokio
    dependency weight — but this is much more work to get right
    (cross-platform readiness polling, timer + I/O fd multiplexing).
  - Recommendation: tokio. Don't hand-roll a reactor for a project this
    stage — it's a rabbit hole with a well-known correct answer already
    on crates.io.
- [ ] `setTimeout`/`setInterval` (`src/web/timers.rs`, `event_loop.rs`)
  need to become tokio timers instead of the current manual deadline scan
  + blocking sleep, so they run concurrently with pending I/O instead of
  blocking it.
- [ ] Decide the concurrency model for V8 itself: single isolate stays
  single-threaded (correct — V8 isolates aren't thread-safe), so "async"
  here means non-blocking *I/O* multiplexed on one thread via tokio, not
  parallel JS execution. Worker threads (separate isolates) are a
  separate, later feature (see Missing Globals section).

## P0 — fetch() must be genuinely async

Currently: `src/web/fetch/mod.rs` calls `ureq` (blocking) inline and
resolves the Promise before returning to JS. Needs a real HTTP client
integrated with the reactor above.

- [ ] Swap `ureq` → `reqwest` (or `hyper` directly) running on tokio.
- [ ] `fetch()` must return its Promise immediately and resolve/reject it
  later, from a spawned task, once the response actually arrives —
  requires a bridge between tokio task completion and V8's
  `PromiseResolver` (this must be done on the isolate's own thread; V8
  objects aren't `Send`, so the task result needs to hop back via a
  channel polled by the event loop, not resolved directly from the tokio
  task).
- [ ] Concurrent fetches: two in-flight `fetch()` calls should actually
  run concurrently (this is the whole point — currently impossible since
  everything blocks serially).
- [ ] `AbortController`/`AbortSignal` support for `fetch()` — needs
  `EventTarget` (below) first, since `AbortSignal` is an `EventTarget`.
- [ ] Streaming response body: `Response.body` as a `ReadableStream`,
  instead of always buffering the whole response up front.
- [ ] `Request` class — `fetch(request)` where `request instanceof
  Request`, not just a string. Needed for real fetch ergonomics (passing
  around a request, cloning it, attaching a signal, etc.)
- [ ] `Response.url` should reflect the final URL after redirects (not
  the originally-requested one); `.redirected` should reflect whether a
  redirect actually happened. Both currently hardcoded/wrong.
- [ ] `.blob()` / `.formData()` on `Response` — needs `Blob`/`FormData`
  classes, which don't exist yet.

## P0 — dynamic import() must be genuinely async

Currently: `src/core/module.rs`'s `dynamic_import_callback` does the
full load → compile → instantiate → evaluate synchronously inline, then
settles the Promise. Needs the same reactor + async HTTP client as fetch.

- [ ] Network-backed dynamic imports (`http:`/`https:` specifiers) must
  not block the thread — same fix as fetch, reusing the same async HTTP
  client.
- [ ] Disk-backed dynamic imports (`file:`) should probably move to
  `tokio::fs` too, for consistency, though this is much less urgent than
  network (disk reads are fast and don't need real concurrency here).
- [ ] Static `import` resolution (`resolve_module_callback`) is
  inherently synchronous by V8's own design (module instantiation is a
  synchronous call in V8's API) — this is **not** fixable the same way
  and is expected to stay blocking. Only dynamic `import()` can become
  truly async. Worth confirming this constraint against V8's actual API
  before starting, not assuming.

## P1 — Memory: fix the native-state leak

`src/web/native.rs`'s `store`/`get` boxes native Rust state
(`Box::into_raw`) into a V8 internal field and never frees it. Explained
above — fine for run-once-then-exit, wrong for anything long-running
(which the async event loop work above is explicitly moving toward).

- [ ] Add `v8::Global::set_weak_with_finalizer` (or equivalent in this
  `v8` crate version — check what's actually exposed) on every object
  that stores native state via `web::native::store`, so GC collection of
  the JS wrapper drops the boxed Rust value (`Box::from_raw` then drop).
- [ ] Applies to every current consumer: `URL`, `URLSearchParams`,
  `Headers`, `Response`, `TextDecoder`.
- [ ] Also applies to any new native-backed class added by the fetch/async
  work above (`Request`, `AbortSignal`, `ReadableStream`, `EventTarget`
  listener lists, etc.) — fix the mechanism once, not per-class.
- [ ] Fix the secondary leak in `url_search_params.rs`'s
  `new_linked_instance` (throwaway `Standalone` Vec built then discarded
  when swapping to `Linked` backing).

## P1 — EventTarget + event system

Correctly identified as foundational, not optional — `AbortSignal`,
`WebSocket`, and (eventually) `Worker`/`MessagePort` are all
`EventTarget`s in the real spec. Building fetch's async pieces without
this means redoing them later.

- [ ] Implement `EventTarget` (`addEventListener`/`removeEventListener`/
  `dispatchEvent`), `Event`, `CustomEvent` as real classes.
- [ ] `AbortController`/`AbortSignal` built on top of `EventTarget`
  (`signal.addEventListener("abort", ...)`, `AbortSignal.timeout()`,
  `AbortSignal.any()`).
- [ ] Decide install order: `EventTarget` needs to land before
  `AbortController`, which needs to land before `fetch()`'s
  cancellation support.

## P1 — TextEncoder/TextDecoder

`TextEncoder` only ever producing UTF-8 is actually spec-correct (the
Encoding Standard defines `TextEncoder` as UTF-8-only — that part isn't
a bug). The real gap is `TextDecoder`:

- [ ] `TextDecoder` needs the full legacy label table (windows-1252,
  iso-8859-*, shift_jis, euc-jp, gbk, big5, utf-16le/be, etc.) — check if
  the `encoding_rs` crate covers this (it's the same crate Firefox/Servo
  use for this exact purpose, matches the `url` crate's own lineage
  choice) instead of hand-rolling label parsing.
- [ ] `TextDecoderStream`/`TextEncoderStream` (streaming variants) — low
  priority until `ReadableStream` exists, but should be tracked.

## P2 — URL fixes

- [ ] Fix `set_host`'s `host:port` split to special-case bracketed IPv6
  literals (`[::1]:8080`) instead of a naive `rsplit_once(':')` — check
  what the `url` crate itself already exposes for this before hand
  re-parsing it.

## P2 — Import map integrity checking

Parsed into the struct, never enforced — this was simply never wired
up, not a hard problem.

- [ ] After fetching a remote module body, if the import map entry has
  an `integrity` field, hash the raw bytes (SHA-256, matching the
  `sha256-<base64>` Subresource Integrity format) and compare before
  compiling/executing. Reject with a clear error on mismatch.
- [ ] Needs a `sha2` (or similar) crate dependency — not currently in
  `Cargo.toml`.

## Missing globals — only build what fetch/events actually need

Do **not** build all of these speculatively. Build only what's required
to make fetch/EventTarget complete, per above. Everything else stays
explicitly out of scope until there's a concrete reason:

- [ ] `Request` (needed by fetch — see P0 above)
- [ ] `ReadableStream` (needed by fetch streaming body — see P0 above)
- [ ] `Blob`, `FormData` (needed by `Response.blob()`/`.formData()`)
- [ ] `EventTarget`, `Event`, `CustomEvent`, `AbortController`,
  `AbortSignal` (see P1 above)
- Still explicitly deferred, no immediate driver: `WebSocket`, `crypto`
  (Web Crypto), `structuredClone`, `Worker`/`MessagePort`/
  `BroadcastChannel`, `Intl`, real `DOMException` class,
  `URL.createObjectURL`.

## Not tracked as bugs (working as intended, noting for clarity)

- `TextEncoder` UTF-8-only — spec-correct, not a gap.
- Permission system (`src/core/permissions.rs`) — considered complete,
  no open items.
- `console` object formatting being flat `ToString` instead of a
  recursive inspector — cosmetic, not blocking anything above; revisit
  later if it actually bothers real usage.
