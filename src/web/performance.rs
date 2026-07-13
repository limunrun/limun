//! High Resolution Time L3 (https://w3.org/TR/hr-time/) — native clock
//! bridge. The `performance` global itself now lives in JS
//! (`ext:limun/15_performance.js`); this module only owns the monotonic +
//! wall clock anchors and exposes them to two Rust callers:
//!
//!   - `core::ops::op_now` / `core::ops::op_time_origin` — flat ops called
//!     from the JS module to read the clocks.
//!   - `ext:limun/02_event.js` — `Event.timeStamp` calls `op_now()` (which
//!     calls `now_value()`) at construction time (Rust→Rust under the op
//!     boundary; same clock as `performance.now()` so an event constructed
//!     at the same instant observes the same value).
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
/// — also used by `02_event.js` for `Event.timeStamp` (via the `op_now`
/// op; same clock, so an event constructed at the same instant as a
/// `performance.now()` call observes the same value).
pub fn now_value() -> f64 {
    let (origin, _) = ensure_origin();
    origin.elapsed().as_secs_f64() * 1000.0
}

/// The wall-clock Unix-epoch ms at the time origin, backing
/// `performance.timeOrigin`. Stable across reads (spec §7.2).
pub fn time_origin_value() -> f64 {
    let (_, ms) = ensure_origin();
    ms
}