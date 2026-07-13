// Copyright 2026 the Limun authors. MIT license.

// `performance` global — W3C High Resolution Time L3
// (https://w3.org/TR/hr-time/). The `Performance` interface has three
// members: `now()` (monotonic sub-millisecond duration since the time
// origin), `timeOrigin` (epoch-relative wall-clock ms at startup), and
// `toJSON()` (default — returns `{ timeOrigin }`).
//
// Fifth web API migrated from Rust to JS-on-ops (after base64,
// DOMException, console, timers, text encoding). The spec surface lives
// here in JS; the flat Rust ops (`op_now`, `op_time_origin`) in `core::ops`
// do the native clock reads. The clock anchors (`now_value`/
// `time_origin_value`, shared with `web::event` for `Event.timeStamp`)
// stay in `web::performance` — Rust→Rust callers don't need an op.
//
// Ports Deno's `ext/web/15_performance.js` — but Deno's full module also
// implements `PerformanceEntry`/`PerformanceMark`/`PerformanceMeasure`/
// `PerformanceObserver` (the Performance Timeline API, a separate spec:
// https://w3c.github.io/performance-timeline/). Limun doesn't expose
// those yet (no WPT subset exercises them here), so this module is the
// minimal `Performance : EventTarget` singleton with `now`/`timeOrigin`/
// `toJSON`. When the Performance Timeline API lands, this is the place to
// grow.
//
// Rewires vs Deno:
//   - `core.ops.op_now`/`op_time_origin` → `globalThis.__limunOps`
//     (Deno packs nanoseconds into a `Uint8Array` to avoid `f64` precision
//     loss across the op2 boundary; Limun's flat ops return `f64`
//     directly — no packing needed, no precision loss, V8 stores
//     `Number`s as `f64` anyway).
//   - `core.loadExtScript("ext:deno_web/02_event.js").EventTarget` →
//     dropped (see EventTarget deviation below).
//   - `webidl` (brand, assertBranded, configureInterface,
//     converters.PerformanceMarkOptions/PerformanceMeasureOptions) →
//     dropped (no full WebIDL module; no mark/measure surface to guard).
//   - `SymbolFor("Deno.privateCustomInspect")` → dropped (no Deno-style
//     custom inspect in Limun yet).
//   - `PerformanceEntry`/`PerformanceMark`/`PerformanceMeasure`/
//     `PerformanceObserver`/`PerformanceObserverEntryList` → dropped
//     (Performance Timeline API, not in Limun's current WPT subset).
//
// EventTarget deviation (option 4 from the migration plan):
// Per spec `Performance : EventTarget` — `performance` is an EventTarget
// instance and `addEventListener`/`removeEventListener`/`dispatchEvent`
// work on it. Limun's `EventTarget` is still in Rust (`web::event`), and
// there's no Rust op yet to mint an EventTarget instance from JS. This
// module builds `performance` as a plain object with the three spec
// members + no-op stubs for the three EventTarget methods. The default
// WPT subset (`hr-time/monotonic-clock.any.js`) doesn't exercise event
// dispatch on `performance`; the `hr-time/basic.any.js` test that *does*
// (`"Performance interface extends EventTarget."`) is not in the default
// subset. When `EventTarget` migrates to JS (or an
// `op_create_event_target` op lands), `performance` can be made a real
// EventTarget — until then the stubs are a documented deviation.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const { op_now, op_time_origin } = globalThis.__limunOps;
  const {
    ObjectCreate,
    ObjectDefineProperty,
  } = primordials;

  // --- `performance` singleton ------------------------------------------

  // A plain object with `now`/`timeOrigin`/`toJSON` as own properties.
  // `timeOrigin` is captured once at module load (the op reads the
  // wall-clock anchor, lazily initialized on first call — this *is* the
  // first call) and stashed as a constant; `now()` reads the monotonic
  // clock on every call.
  const timeOrigin = op_time_origin();

  function now() {
    return op_now();
  }

  function toJSON() {
    return { timeOrigin };
  }

  const performance = ObjectCreate(null, {
    now: {
      value: now,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    toJSON: {
      value: toJSON,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    timeOrigin: {
      value: timeOrigin,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    // EventTarget stubs — see deviation note above. No-op (no listener
    // map backing them); `addEventListener`/`removeEventListener` accept
    // any args and return `undefined`, `dispatchEvent` returns `true`
    // (spec: "the event was not canceled" — `preventDefault` was never
    // called since there's no listener to call it).
    addEventListener: {
      value: function addEventListener() {},
      writable: true,
      enumerable: true,
      configurable: true,
    },
    removeEventListener: {
      value: function removeEventListener() {},
      writable: true,
      enumerable: true,
      configurable: true,
    },
    dispatchEvent: {
      value: function dispatchEvent() {
        return true;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });

  // Install as an enumerable own property on `globalThis` (per spec §8.1 +
  // Web IDL `[Replaceable] readonly attribute` — ordinary interface
  // attribute, enumerable/reassignable). Matches the previous Rust
  // `install`, which used plain `set` (NOT `set_global`'s DONT_ENUM).
  // Plain assignment gives writable/configurable/enumerable — verified
  // shape in browsers:
  // `Object.getOwnPropertyDescriptor(globalThis, "performance")` is
  // `{ value: <object>, writable: true, enumerable: true,
  // configurable: true }`.
  globalThis.performance = performance;
})(globalThis);