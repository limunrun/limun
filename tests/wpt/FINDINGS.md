# WPT conformance findings

Gap analysis from running `tests/wpt/run.js` against limun's real build,
plus limun's own self-documented gaps (`../../TODO.md`). Dated 2026-07-11.

Bottom line: **3 confirmed bugs** (found by actually running real,
upstream, spec-authored tests against limun — not guessed), **19
self-documented missing/limited features**, and **5 implemented specs with
zero real conformance testing yet** (we've only pointed WPT at Abort,
Encoding, and High Resolution Time so far).

## A. Confirmed bugs (verified against limun's real build)

10 raw test failures/hangs from the last run collapse into 3 distinct root
causes:

### 1. `EventTarget` has no `on<event>` handler-attribute support

Only `addEventListener`/`removeEventListener` work — assigning
`signal.onabort = fn` (the IDL "event handler attribute" every
`EventTarget`-derived interface is supposed to expose per DOM §2.11) is
silently a no-op. Confirmed absent: `grep -rn "on<event>\|EventHandler"
src/web/event.rs` → nothing.

Not `AbortSignal`-specific — the mechanism doesn't exist for *any*
`EventTarget`, so every future one (a hypothetical `onclick`, etc.) would
hit the same gap.

Accounts for **8 of the 10** raw failures/hangs in the last run, all of
which assign `.onabort`:

- `dom/abort/timeout.any.js`: 2 tests hang forever (never call `t.done()`
  since `.onabort` never fires) — the harness only surfaces this via a
  watchdog timeout (`run.js`'s own `WATCHDOG_MS` guard), because with no
  further pending timers the process would otherwise just exit 0, falsely
  reporting success.
- `dom/abort/abort-signal-any.any.js`: 1 more hang (`AbortSignal.any() works
  with signals returned by AbortSignal.timeout()`) + 4 FAILs (`follows a
  single signal`, `follows multiple signals`, `signals are composable`,
  `works with intermediate signals`) — all assign `.onabort` on a
  clone/combined signal and assert the callback fired.
- `dom/abort/event.any.js`: 1 FAIL (`controller.abort() should do nothing
  the second time it is called`) — assigns `signal.onabort` and counts
  invocations.

**Fix location:** `src/web/event.rs` — needs a generic mechanism (an
"event handler IDL attribute" is really just sugar for "at most one
listener registered via a special slot, replaced on reassignment, fired in
listener order alongside `addEventListener`-registered ones"), then wire
`onabort` on `AbortSignal` specifically (the only interface today that
needs one).

### 2. `TextEncoder.encode(undefined)` encodes the literal string `"undefined"`

Should default to `""` per WebIDL default-argument rules — an *omitted*
`USVString` argument defaults to `""`, and per spec `undefined` passed
explicitly for a non-nullable string argument coerces via `ToString`
too... except `encode()`'s IDL signature gives it a default value of `""`
specifically for the no-argument case, and `undefined` should still trigger
that default (WebIDL: an explicit `undefined` for an argument with a
default value acts as if the argument were omitted).

Caught by `encoding/api-basics.any.js`'s "Default inputs" test, which checks
*both* `encode()` and `encode(undefined)`:

```js
assert_array_equals(new TextEncoder().encode(), [], ...)          // passes
assert_array_equals(new TextEncoder().encode(undefined), [], ...) // FAILS
```

Got 9 bytes back — the UTF-8 encoding of the literal string `"undefined"`.

**Root cause** (`src/web/text_encoding.rs:75`):

```rust
let input = if args.length() > 0 {
    args.get(0).to_rust_string_lossy(scope)
} else {
    String::new()
};
```

This checks *argument count*, not whether argument 0 *is* `undefined`.
`encode()` (0 args) takes the `else` branch correctly; `encode(undefined)`
(1 arg, whose value happens to be `undefined`) takes the `if` branch and
stringifies it. **Fix:** also check `args.get(0).is_undefined()`.

### 3. `AbortSignal.any()`'s dependent-signal abort events fire in the wrong order

`abort-signal-any.any.js`'s "Abort events for AbortSignal.any() signals
fire in the right order" test (uses `addEventListener`, so this is
independent of bug #1):

```js
controller.abort();
assert_equals(result, "01234"); // got "41230"
```

A real event-dispatch-order conformance bug in the dependent/composed
signal wiring — haven't traced the exact line in `src/web/event.rs` yet.
Spec requires the originating signal's listeners fire before its
dependents', and dependents in the order they were created.

## B. Self-documented gaps (`../../TODO.md`, not yet WPT-verified)

The maintainer's own accounting — authoritative, but not independently
confirmed by running spec tests (most of these are architecturally big
enough that "confirm via WPT" isn't really the open question; "build it"
is).

**Deferred, no driver yet** (9): `WebSocket`; `crypto`/Web Crypto
(`crypto.getRandomValues`, `crypto.subtle.*`); `structuredClone`;
`Worker`/`MessagePort`/`BroadcastChannel` (real architecture project —
multi-isolate); `Intl`; `URL.createObjectURL`/`revokeObjectURL` (no Blob
URL store); `WritableStream`/`TransformStream`; BYOB `ReadableStream`
readers; `HTMLFormElement` for the `FormData` constructor (no DOM to have
one).

**Known limitations, working as intended** (8): `TextEncoder` is
UTF-8-only (spec-correct, not a gap); `console` formatting is flat
`ToString`, no recursive inspector; static `import` is forced synchronous
(V8 API constraint, not fixable without a different module-instantiation
API); disk-backed dynamic `import()` stays sync (low priority — disk is
fast); `ReadableStream` is `start`-only (no `pull`/backpressure/tee/pipe);
`Event.bubbles`/`cancelable`/`composed` are stored but never observed (no
DOM tree to propagate through); `FormData`'s constructor ignores an
`HTMLFormElement` argument (no DOM); import-map `integrity` only supports
`sha256` (spec allows `sha384`/`sha512` too).

**Low priority** (2): disk-backed dynamic `import()` not moved to
`tokio::fs` (no real concurrency win); `TextDecoderStream`/
`TextEncoderStream` not implemented (streaming variants of the encoding
classes).

## C. Untested blind spots

Real WPT has only been pointed at 3 of ~8 implemented specs (Abort,
Encoding, High Resolution Time) — given that hand-written smoke tests (`tests/unit/smoke_test.js`/`review_test.js`)
completely missed a whole missing
mechanism (finding #1 above), the following are unmeasured, not
necessarily fine:

- **`url/`** — WPT's URL suite is large and adversarial (IDNA, unusual
  schemes, setter edge cases). Most of it fetches
  `resources/urltestdata.json` from the WPT test server; running it here
  needs that fixture vendored + a `fetch()` shim reading it locally (the
  `{ with: { type: "json" } }` import attribute this runtime already
  supports would work for loading the fixture itself — just needs wiring).
- **`streams/`** — beyond the `start`-only path already known-limited (see
  B), no real spec tests run at all.
- **`FileAPI/`** — `Blob`/`File` untested against spec.
- **`fetch/`** conformance — `Headers` normalization/`Response` statics
  have real WPT suites, untouched so far.
- **`dom/events/`** general `EventTarget`/`Event` conformance beyond abort
  — likely to surface more `on<event>` fallout (finding #1) on any other
  interface, plus possibly capture-phase/`stopPropagation` edge cases.

## Priority if fixing

1. **Finding #1** (`on<event>` mechanism) — highest leverage, fixes 8 of 10
   raw failures/hangs in one generic change, and prevents the same class of
   bug on every future `EventTarget`-based interface.
2. **Finding #2** (`TextEncoder.encode(undefined)`) — trivial, one-line.
3. **Finding #3** (`AbortSignal.any()` ordering) — needs tracing before a
   fix, lower urgency (edge case: composed signals with multiple
   dependents).
4. Expand vendored WPT coverage (section C) to actually measure instead of
   guess.
