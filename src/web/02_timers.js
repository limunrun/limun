// Copyright 2026 the Limun authors. MIT license.

// `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/
// `queueMicrotask` — WHATWG HTML Standard
// (https://html.spec.whatwg.org/multipage/webappapis.html#timers).
//
// Third web API migrated from Rust to JS-on-ops (after base64,
// DOMException). The spec surface lives here in JS; the flat Rust ops
// (`op_timer_schedule`, `op_timer_clear`, `op_queue_microtask`) in
// `core::ops` do the native work. The timer scheduling machinery (timer
// wheel, tokio integration, callback execution) stays in
// `core::event_loop` — it's irreducible native work (thread coordination,
// tokio runtime, binary heap of deadlines), untouched by this migration.
//
// Ports Deno's `ext/web/02_timers.js`. Rewires:
//   - `core.ops`               → `globalThis.__limunOps`
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.createTimer`/`core.cancelTimer` → flat ops
//     `op_timer_schedule`/`op_timer_clear`. Deno's timer API takes a
//     callback + delay + interval flag and returns a timer *object* with
//     a `_timerId` field; Limun's op takes the callback + delay + repeat
//     flag + extra args and returns the numeric ID directly — no
//     `activeTimers` map needed (the Rust `event_loop` already owns the
//     id→timer mapping, and `op_timer_clear(id)` looks it up there).
//   - `webidl.converters.long`  → `globalThis.__bootstrap.webidl`
//     (shared `ext:limun/00_webidl.js`).
//   - `webidl.converters.DOMString` (for string-callback eval) →
//     `globalThis.__bootstrap.webidl` (same module).
//
// Dropped vs Deno (Limun doesn't model these yet):
//   - Timer nesting depth tracking (HTML's 4ms floor for deeply nested
//     timers) — not worth modeling without real perf pressure; the
//     previous Rust code didn't track it either.
//   - AsyncContext propagation across the callback boundary — no
//     AsyncContext API in Limun yet.
//   - `refTimer`/`unrefTimer`/`defer` — no ref/unref timer API in Limun's
//     event loop; `defer` is a Deno-specific helper not in the spec.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_timer_schedule,
    op_timer_clear,
    op_queue_microtask,
  } = globalThis.__limunOps;
  const {
    indirectEval,
  } = primordials;

  // --- `this` check (WHATWG "Illegal invocation") ------------------------

  // `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` are ordinary
  // interface attributes backed by functions that reject a non-global
  // `this`. Deno's `checkThis` throws `TypeError("Illegal invocation")`
  // when `this` is anything other than `null`/`undefined`/`globalThis`.
  function checkThis(thisArg) {
    if (thisArg !== null && thisArg !== undefined && thisArg !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
  }

  // --- setTimeout / setInterval -------------------------------------------

  // `setTimeout(callback, timeout = 0, ...args) -> number`
  //
  // Spec: if `callback` is not a function, coerce it to a DOMString and
  // evaluate it via indirect eval when the timer fires. Limun's previous
  // Rust code silently returned a 0 (no-op) handle for non-functions; we
  // now implement the spec behavior via `primordials.indirectEval`
  // (renamed from `eval` in `00_primordials.js` to make it an indirect
  // eval — no access to local variables of the calling frame).
  function setTimeout(callback, timeout = 0, ...args) {
    checkThis(this);
    if (typeof callback !== "function") {
      const unboundCallback = webidl.converters.DOMString(callback);
      callback = () => indirectEval(unboundCallback);
    }
    timeout = webidl.converters.long(timeout);
    return op_timer_schedule(callback, timeout, false, ...args);
  }

  // `setInterval(callback, timeout = 0, ...args) -> number`
  function setInterval(callback, timeout = 0, ...args) {
    checkThis(this);
    if (typeof callback !== "function") {
      const unboundCallback = webidl.converters.DOMString(callback);
      callback = () => indirectEval(unboundCallback);
    }
    timeout = webidl.converters.long(timeout);
    return op_timer_schedule(callback, timeout, true, ...args);
  }

  // --- clearTimeout / clearInterval ---------------------------------------

  // Both clear functions are the same op (`op_timer_clear(id)`); the spec
  // separates them only for the Web IDL interface (`clearTimeout` and
  // `clearInterval` are distinct operations on
  // `WindowOrWorkerGlobalScope`). `id` coerced to `long`; the op is a
  // no-op on unknown ids (matches spec and the previous Rust behavior).
  function clearTimeout(id = 0) {
    checkThis(this);
    id = webidl.converters.long(id);
    op_timer_clear(id);
  }

  function clearInterval(id = 0) {
    checkThis(this);
    id = webidl.converters.long(id);
    op_timer_clear(id);
  }

  // --- queueMicrotask ----------------------------------------------------

  // `queueMicrotask(callback) -> undefined` — enqueues `callback`
  // directly on V8's microtask queue (not the timer wheel; runs before
  // any timer, same tick). The op wraps `scope.enqueue_microtask`; V8
  // doesn't expose microtask enqueue to JS directly, so this can't be
  // pure JS. The spec throws `TypeError` if `callback` is not a function
  // — validated here (the op silently ignores non-functions, matching
  // the previous Rust behavior, but the spec-observable throw lives in
  // JS).
  function queueMicrotask(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("queueMicrotask requires a function argument");
    }
    op_queue_microtask(callback);
  }

  // Wire the primordials' `queueMicrotask` slot to this impl. The
  // primordials object (`00_primordials.js`) exposes a `queueMicrotask`
  // getter backed by `setQueueMicrotask` — internal modules that use
  // `primordials.queueMicrotask` (e.g. `SafePromise` plumbing) get the
  // real impl instead of the user-mutable global. Called once at module
  // load; `setQueueMicrotask` throws if already set, so this is safe
  // (no other module sets it).
  primordials.setQueueMicrotask(queueMicrotask);

  // Install as enumerable globals (matches every other engine: Node,
  // Deno, browsers — `Object.keys(globalThis)` includes `setTimeout`,
  // `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask`).
  // Plain assignment (writable, configurable, enumerable) — matches the
  // previous Rust `set_fn` (plain `set`) and the base64 pattern.
  const setTimeoutKey = "setTimeout";
  const setIntervalKey = "setInterval";
  const clearTimeoutKey = "clearTimeout";
  const clearIntervalKey = "clearInterval";
  const queueMicrotaskKey = "queueMicrotask";
  globalThis[setTimeoutKey] = setTimeout;
  globalThis[setIntervalKey] = setInterval;
  globalThis[clearTimeoutKey] = clearTimeout;
  globalThis[clearIntervalKey] = clearInterval;
  globalThis[queueMicrotaskKey] = queueMicrotask;
})(globalThis);