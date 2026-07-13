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
//   - `webidl.converters.long`  → inline `convertLong` (no full WebIDL
//     module yet — same approach as base64's inline `requiredArguments`/
//     `convertDOMString`).
//   - `webidl.converters.DOMString` (for string-callback eval) → inline
//     `convertDOMString` (shared shape with base64/01_dom_exception).
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
  const {
    op_timer_schedule,
    op_timer_clear,
    op_queue_microtask,
  } = globalThis.__limunOps;
  const {
    MathPow,
    MathSign,
    MathTrunc,
    Number,
    NumberIsFinite,
    ReflectApply,
    TypeError,
    indirectEval,
  } = primordials;

  // --- Inline WebIDL (minimal, pilot-scoped) -----------------------------

  // `webidl.converters.DOMString(V)` — same inline as base64/
  // 01_dom_exception. Strings pass through; symbols throw; everything
  // else goes through `String(V)`.
  function convertDOMString(V) {
    if (typeof V === "string") {
      return V;
    }
    if (typeof V === "symbol") {
      throw new TypeError("Cannot convert a Symbol value to a string");
    }
    return String(V);
  }

  // `webidl.converters.long(V)` — Web IDL `long` (32-bit signed integer)
  // conversion, no `enforceRange`, no `clamp`. Ports Deno's
  // `createIntegerConversion(32, { unsigned: false })` from
  // `00_webidl.js`. Steps:
  //   1. `toNumber(V)` — `Number(V)`, throws on BigInt (matches Web IDL:
  //      BigInt → Number throws `TypeError`).
  //   2. Censor negative zero (`-0` → `+0`).
  //   3. If not finite or zero, return 0.
  //   4. Take the integer part (trunc towards zero, censor `-0`).
  //   5. If within [-2^31, 2^31-1], return as-is.
  //   6. Wrap modulo 2^32 into the signed range.
  // Used for the `timeout` argument of `setTimeout`/`setInterval` and the
  // `id` argument of `clearTimeout`/`clearInterval`. NaN, ±Infinity, and
  // non-numeric values all coerce to 0 — matching the spec (a non-numeric
  // `timeout` doesn't throw; it just fires ASAP).
  const LONG_LOWER = -MathPow(2, 31); // -2147483648
  const LONG_UPPER = MathPow(2, 31) - 1; // 2147483647
  const TWO_TO_32 = MathPow(2, 32); // 4294967296
  const TWO_TO_31 = MathPow(2, 31); // 2147483648

  function toNumber(value) {
    if (typeof value === "bigint") {
      throw new TypeError("Cannot convert a BigInt value to a number");
    }
    return Number(value);
  }

  function censorNegativeZero(x) {
    return x === 0 ? 0 : x;
  }

  function integerPart(n) {
    return censorNegativeZero(MathTrunc(n));
  }

  // ECMA-262 modulo: result has the same sign as the divisor. `y` is
  // always positive here (`TWO_TO_32`), so the result is always
  // non-negative.
  function modulo(x, y) {
    const r = x % y;
    // `MathSign(0)` is 0, but `y > 0` always here so the sign check
    // simplifies: if `r` is negative, add `y` to flip the sign.
    if (r !== 0 && MathSign(r) !== MathSign(y)) {
      return r + y;
    }
    return r;
  }

  function convertLong(V) {
    let x = toNumber(V);
    x = censorNegativeZero(x);
    if (!NumberIsFinite(x) || x === 0) {
      return 0;
    }
    x = integerPart(x);
    if (x >= LONG_LOWER && x <= LONG_UPPER) {
      return x;
    }
    x = modulo(x, TWO_TO_32);
    if (x >= TWO_TO_31) {
      return x - TWO_TO_32;
    }
    return x;
  }

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
      const unboundCallback = convertDOMString(callback);
      callback = () => indirectEval(unboundCallback);
    }
    timeout = convertLong(timeout);
    return op_timer_schedule(callback, timeout, false, ...args);
  }

  // `setInterval(callback, timeout = 0, ...args) -> number`
  function setInterval(callback, timeout = 0, ...args) {
    checkThis(this);
    if (typeof callback !== "function") {
      const unboundCallback = convertDOMString(callback);
      callback = () => indirectEval(unboundCallback);
    }
    timeout = convertLong(timeout);
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
    id = convertLong(id);
    op_timer_clear(id);
  }

  function clearInterval(id = 0) {
    checkThis(this);
    id = convertLong(id);
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