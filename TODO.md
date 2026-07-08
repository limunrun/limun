# TODO

Honest accounting of what's missing, half-implemented, or deferred.
Ordered by priority. Nothing here is secretly "done" — if it's not
checked off below, don't assume it works.

Explicitly **not** in scope (per discussion, don't re-add):
- `npm:` specifiers, `blob:` module scheme
- Node/Deno-style globals (`process.*`, `Deno.*`) in the core runtime
- Import attribute `resolution-mode` (TypeScript-only, not our concern)
- Permission system — considered done, no open issues

---

## Done — kept for reference, not actionable

### P0 — Concurrency

Event loop is a real reactor: `tokio::sync::mpsc` channel + tokio
multi-thread runtime (4 workers) in the background, V8 isolate stays
single-threaded on the main thread. `event_loop::run` blocks on
`blocking_recv` and dispatches `TaskResult::{Fetch, ImportSource,
Timer}` completions, resolving/rejecting `PromiseResolver`s on the V8
thread. V8 objects (`Global<T>` is `!Send`/`!Sync`, verified) never
cross threads — only plain-Rust `Send` payloads do.

- [x] tokio runtime + channel bridge (`src/core/bridge.rs` +
  `src/core/runtime.rs`)
- [x] `setTimeout`/`setInterval` are tokio timers (no `thread::sleep`)
- [x] verified: 20ms `setTimeout` fires *during* a pending `fetch()`

### P0 — fetch() genuinely async

`fetch()` spawns a tokio task using `reqwest` (rustls, gzip, brotli),
returns a pending `Promise` immediately, resolves later via the bridge
channel. Two concurrent `fetch()` calls run concurrently
(`examples/concurrency.js`: ~500ms, not ~2s).

- [x] `reqwest` on tokio (replaces `ureq` for the fetch path; `ureq`
  stays for the static-import module-load path V8 forces sync)
- [x] Promise resolves later from the tokio task completion
- [x] Concurrent fetches verified
- [x] `AbortController`/`AbortSignal` support — pre-aborted rejects
  immediately; abort during pending fetch cancels the tokio task via
  `CancellationToken` + rejects via an abort event listener
- [x] `Request` class — `fetch(request)` works; constructor accepts
  `Request` or string + `init` overrides; `method`/`url`/`headers`/
  `signal`/`bodyUsed` accessors; `clone()`; `init.signal` overrides
  `Request.signal` per spec
- [x] `Response.url` reflects post-redirect URL; `.redirected` returns
  `true` when `original_url != final_url`
- [x] `.blob()` / `.formData()` — `blob()` returns a `Blob` with body +
  content-type; `formData()` parses BOTH `application/x-www-form-urlencoded`
  (via `url::form_urlencoded`) AND `multipart/form-data` (byte-level parser,
  files become `File` entries)
- [x] `Response.json()` static, `Response.error()` (type `"error"`, status 0,
  null body), `Response.redirect(url, status)` (301/302/303/307/308 →
  `Location` header, else RangeError)
- [x] Full Body mixin on `Request` too (`body`/`bodyUsed`/`text`/`json`/
  `arrayBuffer`/`blob`/`formData`); `bodyUsed` real, `clone()` throws on a
  used body; GET/HEAD-with-body and invalid-URL constructors throw TypeError
- [x] `Response.body` is a `ReadableStream` (one chunk = the whole buffered
  body, then closes); `null` for a null-body response, never throws after
  consumption; `bodyUsed` tracks mutual exclusion with the consuming methods
- [x] `ReadableStream` async iteration: `for await (const c of resp.body)`
  works (`values()` + `[Symbol.asyncIterator]`)

### P1 — Memory leak fix

`src/web/native.rs`'s `store<T>()` registers a
`v8::Weak::with_guaranteed_finalizer`; GC collection of the JS wrapper
runs `Box::from_raw(ptr as *mut T)` + drop, freeing the native Rust
state. `Weak` handles held in a thread-local `WEAK_HANDLES` vec in
`core::state` (cleared by `clear_module_state` before isolate teardown).

- [x] Finalizer on every native-backed class: `URL`, `URLSearchParams`,
  `Headers`, `Response`, `TextDecoder`, plus new classes (`Event`,
  `EventTarget`, `AbortSignal`, `Request`, `ReadableStream`, `Blob`,
  `FormData`).
- [x] Secondary leak in `url_search_params.rs`'s `new_linked_instance`
  fixed (throwaway `Standalone` Vec gets its own finalizer).

### P1 — EventTarget + event system

`src/web/event.rs` (~1430 lines). All five classes installed
non-enumerable on `globalThis`.

- [x] `EventTarget` (addEventListener/removeEventListener/dispatchEvent),
  `Event` (type/bubbles/cancelable/composed/defaultPrevented/timeStamp/
  isTrusted/target + preventDefault/stopPropagation/
  stopImmediatePropagation), `CustomEvent` (extends Event + detail)
- [x] `AbortController`/`AbortSignal` on `EventTarget` (timeout/any/
  abort statics, throwIfAborted method)
- [x] `Performance : EventTarget` — `performance` is now a real
  `EventTarget` instance + `now`/`timeOrigin`/`toJSON` (so
  `performance instanceof EventTarget === true`)

### P1 — TextEncoder/TextDecoder

`TextEncoder` UTF-8-only is spec-correct (not a gap). `TextDecoder`:

- [x] Full legacy label table via `encoding_rs` crate (same crate
  Firefox/Servo use) — `for_label_no_replacement` handles windows-1252,
  iso-8859-*, shift_jis, euc-jp, gbk, big5, utf-16le/be, replacement,
  etc. + label normalization + replacement-encoding rejection. `fatal:
  true` uses streaming decoder + MalformedInput → TypeError; `fatal:
  false` uses U+FFFD replacement. `ignoreBOM` strips leading BOM on
  UTF-8/UTF-16. `decode(input, { stream: true })` retains an incremental
  `encoding_rs::Decoder` across calls (partial multi-byte sequences at chunk
  boundaries decode correctly); a final `decode()` flushes and resets.

### P2 — URL IPv6 fix

- [x] `set_host` handles bracketed IPv6 literals (`[::1]:8080`) —
  checks for leading `[`, finds closing `]`, splits host (with brackets)
  from port after `]`. Verified.

### P2 — Import map integrity

- [x] After fetching a remote module body, if the import-map entry has
  an `integrity` field, SHA-256 the raw bytes (via `sha2` crate),
  base64-encode, compare to `sha256-<b64>`. Reject on mismatch. Only
  sha256 supported (sha384/sha512 silently skipped, documented
  limitation). Verified with manual scratch test.

### Missing globals — fetch/events core

- [x] `Request`, `ReadableStream` + `ReadableStreamReader`, `Blob`,
  `FormData`, `EventTarget`, `Event`, `CustomEvent`, `AbortController`,
  `AbortSignal`, `performance`

---

## Low priority — not blocking, no concrete driver yet

These are real gaps but small or niche. Build when there's a reason;
don't speculatively expand the surface.

- [ ] Disk-backed dynamic `import()` (`file:`) stays sync — low
  priority (disk is fast, no real concurrency benefit vs the network
  path). Could move to `tokio::fs` for consistency with the async
  network path, but the latency win is negligible.
- [ ] `TextDecoderStream`/`TextEncoderStream` — streaming encoding
  variants. `ReadableStream` now exists so these could be built as a
  follow-up; no concrete driver yet.
- [x] `File` (extends `Blob` with `name`/`lastModified`) — implemented;
  `FormData` non-string entries are now `File`s per the XHR Standard.

## Explicitly deferred — no immediate driver

Don't build speculatively. Each one needs a concrete use case before
it's worth the surface-area cost.

- `WebSocket`
- `crypto` (Web Crypto — `crypto.getRandomValues`, `crypto.subtle.*`)
- `structuredClone`
- `Worker`/`MessagePort`/`BroadcastChannel` (multi-isolate; a real
  architecture project, not a small addition)
- `Intl` (internationalization — large surface, no current driver)
- `URL.createObjectURL`/`revokeObjectURL` (no `Blob` URL store yet)
- `WritableStream`/`TransformStream` (no driver without a pipe-to
  consumer)
- BYOB readers for `ReadableStream` (byte-level stream control —
  the minimal `start`/`enqueue`/`close`/`error` controller is enough
  for `Response.body` + basic user-facing streams)
- `HTMLFormElement` for `FormData` constructor (no DOM)

## Known limitations — working as intended, documenting for clarity

- `TextEncoder` UTF-8-only — spec-correct, not a gap.
- Permission system (`src/core/permissions.rs`) — considered complete.
- `console` object formatting is flat `ToString` (no recursive
  inspector like Node's `util.inspect`) — cosmetic; revisit if real
  usage needs it.
- Static `import` stays sync (V8 API constraint —
  `ResolveModuleCallback` returns `*const Module` synchronously, no
  deferral token; not fixable without a different V8
  module-instantiation API).
- Disk-backed dynamic `import()` stays sync (low priority — disk is
  fast).
- `File` implemented (extends `Blob`); `FormData` blob entries are `File`s.
- `Response.formData()`/`Request.formData()` parse both
  `application/x-www-form-urlencoded` and `multipart/form-data`.
- `ReadableStream` minimal: `start` controller with enqueue/close/
  error only — no `pull`/`cancel`/`type`/`strategy`/BYOB. Enough for
  `Response.body` + basic user-facing streams.
- `FormData` constructor ignores `HTMLFormElement` arg (no DOM).
- `Event.bubbles`/`cancelable`/`composed` stored but never observed (no
  DOM tree → no propagation); `preventDefault()` still flips
  `defaultPrevented` (observable).
- `DOMException` is a real class now (Error-inheriting, legacy `code` +
  `*_ERR` constants). `AbortError`/`TimeoutError`/`InvalidCharacterError`
  etc. are real `DOMException`s, so `e instanceof DOMException` works.
- Import map integrity only supports `sha256` (spec allows
  sha384/sha512 too; sha256 covers the common case, others silently
  skipped).

---

## Review pass (post-GLM) — soundness fix + spec completion

Fixes applied while reviewing the GLM-generated pass. The build could not be
compiled locally (no Rust toolchain: only Ubuntu's 1.75 is reachable and
`v8 = "150"` needs edition-2024/~1.85+), so everything below was verified by
hand against the pinned `rusty_v8` v150.0.0 source and crate metadata.

- [x] **Soundness (was UB): cross-class type confusion.** Every native class
  branded instances by "internal field N holds a `v8::External`", but every
  class stores one — so `new Request(urlObject)`, `formData.append(k, headers)`,
  `dispatchEvent(url)`, etc. would reinterpret one class's Rust state as
  another's. `native::store` now tags each boxed cell with `TypeId`; `is::<T>`
  / `get_opt::<T>` / `get::<T>` check the tag, so brand checks are sound and a
  mismatched `get` panics instead of confusing types.
- [x] Event dispatch wraps each listener call in a `TryCatch` — a throwing
  listener is reported and dispatch continues (DOM §2.9), instead of leaving a
  pending exception that corrupts the loop or escapes `controller.abort()`.
- [x] Microtask policy set to `Explicit` so the event loop owns every
  checkpoint (no double-drain vs the default `Auto`).
- [x] `ReadableStream` FIFO delivery fixed (was LIFO for parked reads).
- [x] `AbortSignal.throwIfAborted()` throws the raw reason (was wrapping
  string reasons in `Error`).
- [x] Empty bodies read as `{done:true}` immediately (no spurious 0-length
  chunk).
- [x] `Headers.get()` combines duplicate values with `", "`; iteration is
  sort-and-combine; `getSetCookie()` added; `set-cookie` never combined.
- [x] Dead `io::fetch_full`/`RawResponse` (+ `ureq::ResponseExt`) removed.

Still open (unchanged from above, documented as intentional):
- Fetch body is fully buffered then wrapped in a one-chunk stream — not true
  incremental streaming. Making it stream would mean re-plumbing the tokio
  fetch task to hand chunks across the bridge; deferred (out of scope for a
  fix/complete pass, and buffering is observably spec-correct).
- `ReadableStream` still `start`-only (no `pull`/backpressure/BYOB/tee/pipe);
  async-iterator natural completion doesn't release the lock (only `break`/
  `throw` via `return()` does). Fine for one-shot `Response.body`.
- No header-guard / forbidden-header enforcement (no privilege boundary in a
  CLI).
