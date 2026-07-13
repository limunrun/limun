// Copyright 2026 the Limun authors. MIT license.

// `performance` global — W3C High Resolution Time L3
// (https://w3.org/TR/hr-time/). The `Performance` interface extends
// `EventTarget` and has three own members: `now()` (monotonic
// sub-millisecond duration since the time origin), `timeOrigin`
// (epoch-relative wall-clock ms at startup), and `toJSON()` (returns
// `{ timeOrigin }`). `addEventListener`/`removeEventListener`/
// `dispatchEvent` are inherited from `EventTarget`.
//
// Fifth web API migrated from Rust to JS-on-ops (after base64,
// DOMException, console, timers, text encoding). The spec surface lives
// here in JS; the flat Rust ops (`op_now`, `op_time_origin`) in `core::ops`
// do the native clock reads. The clock anchors (`now_value`/
// `time_origin_value`, shared with `web::event` for `Event.timeStamp`)
// stay in `web::performance` — Rust→Rust callers don't need an op.
//
// Ports Deno's `ext/web/15_performance.js` — but only the
// `Performance : EventTarget` singleton (the "hr-time" spec). Deno's full
// module also implements `PerformanceEntry`/`PerformanceMark`/
// `PerformanceMeasure`/`PerformanceObserver` (the Performance Timeline
// API, a separate spec: https://w3c.github.io/performance-timeline/).
// Limun doesn't expose those yet (no WPT subset exercises them here), so
// this module is the minimal `Performance : EventTarget` singleton with
// `now`/`timeOrigin`/`toJSON`. When the Performance Timeline API lands,
// this is the place to grow.
//
// Rewires vs Deno:
//   - `core.ops.op_now`/`op_time_origin` → `globalThis.__limunOps`
//     (Deno packs nanoseconds into a `Uint8Array` to avoid `f64` precision
//     loss across the op2 boundary; Limun's flat ops return `f64`
//     directly — no packing needed, no precision loss, V8 stores
//     `Number`s as `f64` anyway).
//   - `core.loadExtScript("ext:deno_web/02_event.js").EventTarget` →
//     `globalThis.EventTarget` (installed as a non-enumerable global by
//     `02_event.js`, which loads before this module per REGISTRY order).
//   - `webidl` (brand, assertBranded, illegalConstructor) →
//     `globalThis.__bootstrap.webidl` (shared `ext:limun/00_webidl.js`).
//   - `webidl.configureInterface` → dropped (only sets
//     `[Symbol.toStringTag]`; Limun sets the tag inline).
//   - `webidl.converters.PerformanceMarkOptions`/`PerformanceMeasureOptions`
//     → dropped (no mark/measure surface to guard).
//   - `SymbolFor("Deno.privateCustomInspect")` → dropped (no Deno-style
//     custom inspect in Limun yet).
//   - `PerformanceEntry`/`PerformanceMark`/`PerformanceMeasure`/
//     `PerformanceObserver`/`PerformanceObserverEntryList` → dropped
//     (Performance Timeline API, not in Limun's current WPT subset).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const { op_now, op_time_origin } = globalThis.__limunOps;
  const {
    ObjectDefineProperty,
    SymbolToStringTag,
  } = primordials;

  // `EventTarget` is installed as a non-enumerable global by
  // `02_event.js` (which loads before this module per REGISTRY order).
  // Reference it directly — it's the same class `addEventListener`/
  // `removeEventListener`/`dispatchEvent` live on.
  const { EventTarget } = globalThis;

  // `timeOrigin` is captured once at module load (the op reads the
  // wall-clock anchor, lazily initialized on first call — this *is* the
  // first call) and stashed as a constant; `now()` reads the monotonic
  // clock on every call.
  const timeOrigin = op_time_origin();

  // `illegalConstructorKey` — `Performance`'s constructor throws unless
  // called with this private symbol (so `new Performance()` from user
  // code throws, but this module can mint the singleton internally).
  // Matches Deno's pattern.
  const illegalConstructorKey = Symbol("illegalConstructorKey");

  class Performance extends EventTarget {
    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      super();
      this[webidl.brand] = webidl.brand;
    }

    get timeOrigin() {
      webidl.assertBranded(this, PerformancePrototype, "Performance");
      return timeOrigin;
    }

    now() {
      webidl.assertBranded(this, PerformancePrototype, "Performance");
      return op_now();
    }

    toJSON() {
      webidl.assertBranded(this, PerformancePrototype, "Performance");
      return { timeOrigin };
    }
  }

  const PerformancePrototype = Performance.prototype;
  ObjectDefineProperty(PerformancePrototype, SymbolToStringTag, {
    __proto__: null,
    value: "Performance",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Instantiate the singleton — the only `Performance` instance.
  const performance = new Performance(illegalConstructorKey);

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