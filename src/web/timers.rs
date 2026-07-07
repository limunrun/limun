//! Timer globals from the WHATWG HTML Standard —
//! `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`, plus
//! `queueMicrotask`. These are the JS-facing surface only; the actual
//! scheduling machinery (timer wheel, run loop) lives in
//! `core::event_loop` — same split as `console`'s globals vs. its
//! formatting logic.
//!
//! Simplifications vs. spec:
//!   - `setTimeout("code as a string", ...)` (indirect eval) is not
//!     supported — the handler must be a function. Non-function handlers
//!     are silently ignored (returns a handle that resolves to nothing).
//!   - No clamping of nested/minimum delays (HTML's 4ms floor for deeply
//!     nested timers) — not worth modeling yet without real perf pressure.

use crate::core::event_loop;

/// `setTimeout(handler, timeout？, ...args): number`
pub fn set_timeout(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    schedule(scope, args, rv, false);
}

/// `setInterval(handler, timeout?, ...args): number`
pub fn set_interval(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    schedule(scope, args, rv, true);
}

fn schedule(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
    repeat: bool,
) {
    let Ok(callback): Result<v8::Local<v8::Function>, _> = args.get(0).try_into() else {
        // Not a function (e.g. a string body): unsupported, no-op handle.
        rv.set(v8::Number::new(scope, 0.0).into());
        return;
    };

    let delay_ms = if args.length() > 1 {
        args.get(1).number_value(scope).unwrap_or(0.0)
    } else {
        0.0
    };

    // Extra arguments (setTimeout(fn, ms, a, b) -> fn(a, b)) per spec.
    let extra_args: Vec<v8::Global<v8::Value>> = (2..args.length())
        .map(|i| v8::Global::new(scope, args.get(i)))
        .collect();

    let callback_global = v8::Global::new(scope, callback);
    let id = event_loop::schedule(callback_global, extra_args, delay_ms, repeat);
    rv.set(v8::Number::new(scope, id as f64).into());
}

/// `clearTimeout(id?: number): void`
pub fn clear_timeout(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    clear(scope, args, rv);
}

/// `clearInterval(id?: number): void`
pub fn clear_interval(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    clear(scope, args, rv);
}

fn clear(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if args.length() == 0 {
        return;
    }
    if let Some(id) = args.get(0).number_value(scope) {
        if id.is_finite() && id >= 0.0 {
            event_loop::clear(id as u32);
        }
    }
}

/// `queueMicrotask(callback): void` — enqueues directly on V8's microtask
/// queue (not the timer wheel; runs before any timer, same tick).
pub fn queue_microtask(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if let Ok(callback) = <v8::Local<v8::Function>>::try_from(args.get(0)) {
        scope.enqueue_microtask(callback);
    }
}
