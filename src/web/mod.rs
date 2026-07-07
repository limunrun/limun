//! Layer 1 globals — web-standard surface installed on `globalThis`.
//! `console` (WHATWG Console Standard) is the seed; `self` is the realm-
//! agnostic self-reference from the WHATWG HTML `Window`/`WorkerGlobalScope`
//! mixin. `alert`/`confirm`/`prompt` are the user-prompt globals from the
//! WHATWG HTML `Window` interface, adapted to a terminal (Deno model). No
//! `window` itself: there is no browsing context here to name.

pub mod base64;
pub mod console;
pub mod fetch;
mod native;
pub mod prompt;
pub mod text_encoding;
pub mod timers;
pub mod url;
pub mod url_search_params;

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

    // Encoding Standard — real constructible classes (interface objects),
    // installed non-enumerable (verified against Node:
    // `Object.getOwnPropertyDescriptor(globalThis, "TextEncoder").enumerable
    // === false`).
    text_encoding::install(scope, global);

    // `btoa`/`atob` — plain operations, enumerable (verified against Node).
    set_fn(scope, global, "btoa", base64::btoa);
    set_fn(scope, global, "atob", base64::atob);

    // URL Standard — real constructible classes, non-enumerable.
    url::install(scope, global);
    url_search_params::install(scope, global);

    // Fetch Standard — `fetch` itself is a plain operation (enumerable);
    // `Headers`/`Response` are constructible classes (non-enumerable).
    fetch::install(scope, global);
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

pub fn throw_type_error(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::type_error(scope, message);
    scope.throw_exception(exception);
}

pub fn throw_range_error(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::range_error(scope, message);
    scope.throw_exception(exception);
}

/// `atob`/`btoa` throw a `DOMException` named e.g. "InvalidCharacterError"
/// per spec. We don't have a real `DOMException` class (no DOM), so this
/// throws a plain `Error` with `.name` set to match — same observable
/// shape for the common case (`e.name === "InvalidCharacterError"`),
/// documented simplification (see also: `Request` not implemented,
/// TypeScript's `resolution-mode` import attribute out of scope).
pub fn throw_dom_exception(scope: &mut v8::PinScope, name: &str, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, msg);
    if let Ok(obj) = <v8::Local<v8::Object>>::try_from(exception) {
        let key = v8::String::new(scope, "name").unwrap();
        let val = v8::String::new(scope, name).unwrap();
        obj.set(scope, key.into(), val.into());
    }
    scope.throw_exception(exception);
}