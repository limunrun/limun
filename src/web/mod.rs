//! Layer 1 globals — web-standard surface installed on `globalThis`.
//! `console` (WHATWG Console Standard) is the seed; `self` is the realm-
//! agnostic self-reference from the WHATWG HTML `Window`/`WorkerGlobalScope`
//! mixin. `alert`/`confirm`/`prompt` are the user-prompt globals from the
//! WHATWG HTML `Window` interface, adapted to a terminal (Deno model). No
//! `window` itself: there is no browsing context here to name.

pub mod console;
pub mod prompt;
pub mod timers;

/// Install all web-standard globals onto `context`'s global object.
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);

    console::install(scope, global);

    // User-prompt globals (alert/confirm/prompt) — ordinary interface
    // attributes, enumerable per Web IDL §3.7.3 (same bucket as `self`).
    set_fn(scope, global, "alert", prompt::alert);
    set_fn(scope, global, "confirm", prompt::confirm);
    set_fn(scope, global, "prompt", prompt::prompt);

    // Timers (WHATWG HTML) — ordinary interface attributes, enumerable.
    set_fn(scope, global, "setTimeout", timers::set_timeout);
    set_fn(scope, global, "setInterval", timers::set_interval);
    set_fn(scope, global, "clearTimeout", timers::clear_timeout);
    set_fn(scope, global, "clearInterval", timers::clear_interval);
    set_fn(scope, global, "queueMicrotask", timers::queue_microtask);

    // `self`: realm-agnostic self-reference (WHATWG HTML, shared with Worker
    // scope). Same object as `globalThis` — not a subclass, not a wrapper.
    //
    // Unlike `console` (a namespace object — non-enumerable per Web IDL
    // §3.7.5), `self` is an ordinary interface attribute, which defaults to
    // enumerable per Web IDL §3.7.3. Verified against real browsers:
    // `Object.keys(globalThis)` includes "self" there, so use plain `set`.
    let key = v8::String::new(scope, "self").unwrap();
    global.set(scope, key.into(), global.into());
}

/// Install a platform global the way real engines do — own, writable,
/// configurable, but non-enumerable so it doesn't clutter
/// `Object.keys(globalThis)`/`for...in` (matches `Array`, `console`, etc.
/// in V8/Node/Deno/browsers).
pub fn set_global(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    name: &str,
    value: v8::Local<v8::Value>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.define_own_property(scope, key.into(), value, v8::PropertyAttribute::DONT_ENUM);
}

/// Helper: attach a native function to an object under `name`.
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