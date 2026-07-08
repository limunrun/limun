//! `performance` global — W3C High Resolution Time L3
//! (https://w3.org/TR/hr-time/). The `Performance` interface has three
//! members: `now()` (monotonic sub-millisecond duration since the time
//! origin), `timeOrigin` (epoch-relative wall-clock ms at startup), and
//! `toJSON()` (default — returns `{ timeOrigin }`).
//!
//! `Performance : EventTarget` per spec — the `performance` singleton
//! is constructed via the `EventTarget` machinery (so
//! `performance instanceof EventTarget` is `true` and
//! `addEventListener`/`removeEventListener`/`dispatchEvent` work on
//! it), with `now`/`toJSON`/`timeOrigin` added as own properties.
//!
//! Time sources (per spec §2.1):
//!   - `now()` uses the monotonic clock (`std::time::Instant`) — never
//!     goes backwards, immune to system-clock adjustments.
//!   - `timeOrigin` uses the wall clock (`std::time::SystemTime`),
//!     captured once at process startup as a Unix-epoch millisecond
//!     count — approximately what `Date.now()` would have returned at
//!     that instant (per spec §4).
//!
//! No coarsening or jitter (spec §9.1 allows implementation-defined
//! resolution; a single-process CLI runtime has no cross-origin
//! timing-attack threat model to mitigate).

use std::cell::OnceCell;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

thread_local! {
    /// Monotonic-clock anchor (`performance.now()` = elapsed since this).
    /// Lazily initialized on first `now()`/`timeOrigin` access — which
    /// happens after V8 is up and globals are installed, so the anchor
    /// reflects "first JS use" rather than process start. Per spec §4
    /// the time origin is "early in the initialization of a relevant
    /// environment settings object" — first JS access is the closest
    /// analog in a single-script CLI runtime (no navigation/worker
    /// lifecycle to hook into).
    static ORIGIN_INSTANT: OnceCell<Instant> = const { OnceCell::new() };
    /// Wall-clock Unix-epoch ms captured alongside `ORIGIN_INSTANT` so
    /// `timeOrigin` is a stable constant (not recomputed every read).
    /// Spec §7.2: `timeOrigin` MUST return the same value across reads.
    static TIME_ORIGIN_MS: OnceCell<f64> = const { OnceCell::new() };
}

fn ensure_origin() -> (Instant, f64) {
    let instant = ORIGIN_INSTANT.with(|cell| *cell.get_or_init(Instant::now));
    let ms = TIME_ORIGIN_MS.with(|cell| {
        *cell.get_or_init(|| {
            let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
            wall.as_secs_f64() * 1000.0
        })
    });
    (instant, ms)
}

/// The raw monotonic-ms-since-origin value backing `performance.now()`
/// — also used by `web::event` for `Event.timeStamp` (same clock, so
/// an event constructed at the same instant as a `performance.now()`
/// call observes the same value).
pub fn now_value() -> f64 {
    let (origin, _) = ensure_origin();
    origin.elapsed().as_secs_f64() * 1000.0
}

/// `performance.now(): DOMHighResTimeStamp` — monotonic ms since
/// `timeOrigin`. Per spec §7.1, returns the current high resolution
/// time (a duration from the time origin to now).
fn now(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Number::new(scope, now_value()).into());
}

/// `performance.timeOrigin: DOMHighResTimeStamp` (readonly getter) —
/// Unix-epoch milliseconds at the time origin. Per spec §7.2 + §4, the
/// duration from the Unix epoch to the time origin, on the wall clock.
fn get_time_origin(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    _args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let (_, ms) = ensure_origin();
    rv.set(v8::Number::new(scope, ms).into());
}

/// `performance.toJSON(): object` — default toJSON per Web IDL: returns
/// `{ timeOrigin }`. (Spec §7.3 + Web IDL default toJSON steps.)
fn to_json(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let (_, ms) = ensure_origin();
    let obj = v8::Object::new(scope);
    let key = v8::String::new(scope, "timeOrigin").unwrap();
    obj.set(scope, key.into(), v8::Number::new(scope, ms).into());
    rv.set(obj.into());
}

/// Install the `performance` global on `globalThis`. Per spec §8.1 +
/// Web IDL `[Replaceable] readonly attribute`, `performance` is an
/// ordinary interface attribute (enumerable, reassignable). Verified
/// shape: `Object.getOwnPropertyDescriptor(globalThis, "performance")`
/// is `{ value: <object>, writable: true, enumerable: true,
/// configurable: true }` in browsers.
///
/// `performance` is a singleton `EventTarget` instance (not a
/// constructor) with `now`/`toJSON`/`timeOrigin` as own properties.
pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    // Construct a fresh `EventTarget` instance via the cached template
    // in `web::event` — gives us the listener map + the three
    // dispatch methods on the prototype for free.
    let perf = crate::web::event::new_event_target_instance(scope);

    // `now`/`toJSON` are own function properties (per spec they're
    // methods on `Performance.prototype`, but `performance` is a
    // singleton — there's no other `Performance` instance to share a
    // prototype with, so own properties are observationally identical
    // and simpler. Same approach the pre-EventTarget `performance`
    // took.)
    let now_key = v8::String::new(scope, "now").unwrap();
    let now_fn = v8::Function::new(scope, now).unwrap();
    perf.set(scope, now_key.into(), now_fn.into());

    let json_key = v8::String::new(scope, "toJSON").unwrap();
    let json_fn = v8::Function::new(scope, to_json).unwrap();
    perf.set(scope, json_key.into(), json_fn.into());

    // `timeOrigin` is a readonly accessor on the instance (per spec, an
    // IDL readonly attribute). Installed as an own accessor property.
    let time_origin_key = v8::String::new(scope, "timeOrigin").unwrap();
    let config = v8::AccessorConfiguration::new(get_time_origin)
        .property_attribute(v8::PropertyAttribute::READ_ONLY);
    perf.set_accessor_with_configuration(scope, time_origin_key.into(), config);

    // `performance` is enumerable per Web IDL `[Replaceable]` — plain
    // `set`, NOT `set_global` (which would mark it non-enumerable).
    let perf_key = v8::String::new(scope, "performance").unwrap();
    global.set(scope, perf_key.into(), perf.into());
}