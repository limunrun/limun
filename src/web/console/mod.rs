//! `console` — WHATWG Console Standard
//! (https://console.spec.whatwg.org/). Namespace object installed as a
//! non-enumerable own property of `globalThis`.
//!
//! Known simplifications vs. real engines:
//!   - Object formatting uses V8's `ToString` (so plain objects print as
//!     "[object Object]"), not a full util.inspect-style recursive/colorized
//!     inspector.
//!   - `%o`/`%O` format specifiers fall back to the same stringification.
//!   - `%c` (CSS styling) is recognized and its argument consumed, per spec,
//!     but no styling is applied (no terminal color support yet).

mod common;
mod counting;
mod grouping;
mod state;
mod table;
mod timing;
mod trace;
mod logging;

/// Attach the `console` namespace object to `global` (non-enumerable).
pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let console = v8::Object::new(scope);

    // Logging (§1.1)
    set_fn(scope, console, "assert", logging::assert);
    set_fn(scope, console, "clear", logging::clear);
    set_fn(scope, console, "debug", logging::debug);
    set_fn(scope, console, "error", logging::error);
    set_fn(scope, console, "info", logging::info);
    set_fn(scope, console, "log", logging::log);
    set_fn(scope, console, "table", table::table);
    set_fn(scope, console, "trace", trace::trace);
    set_fn(scope, console, "warn", logging::warn);
    set_fn(scope, console, "dir", logging::dir);
    set_fn(scope, console, "dirxml", logging::dirxml);
    // Counting (§1.2)
    set_fn(scope, console, "count", counting::count);
    set_fn(scope, console, "countReset", counting::count_reset);
    // Grouping (§1.3)
    set_fn(scope, console, "group", grouping::group);
    set_fn(scope, console, "groupCollapsed", grouping::group_collapsed);
    set_fn(scope, console, "groupEnd", grouping::group_end);
    // Timing (§1.4)
    set_fn(scope, console, "time", timing::time);
    set_fn(scope, console, "timeLog", timing::time_log);
    set_fn(scope, console, "timeEnd", timing::time_end);

    crate::web::set_global(scope, global, "console", console.into());
}

fn set_fn(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    target.set(scope, key.into(), func.into());
}