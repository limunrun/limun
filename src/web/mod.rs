//! Layer 1 globals — web-standard surface installed on `globalThis`.
//! `console` (WHATWG Console Standard) is the seed; `self` is the realm-
//! agnostic self-reference from the WHATWG HTML `Window`/`WorkerGlobalScope`
//! mixin. `alert`/`confirm`/`prompt` are the user-prompt globals from the
//! WHATWG HTML `Window` interface, adapted to a terminal (Deno model). No
//! `window` itself: there is no browsing context here to name.

pub mod blob;
pub mod console;
pub mod dom_exception;
pub mod event;
pub mod fetch;
pub mod form_data;
mod native;
pub mod performance;
pub mod prompt;
pub mod streams;
pub mod text_encoding;
pub mod timers;
pub mod url;
pub mod url_search_params;

/// Install all web-standard globals onto `context`'s global object.
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);

    // Web IDL `DOMException` — installed first: `throw_dom_exception` (used
    // by `atob`, `dispatchEvent`, `AbortSignal`, …) mints instances through
    // it, so its constructor must be cached before anything can throw.
    dom_exception::install(scope, global);

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

    // `btoa`/`atob` — installed by the JS module `ext:limun/05_base64.js`
    // during bootstrap (plain operations, enumerable — verified against
    // Node/Deno/browsers). The JS layer owns the spec surface (WebIDL
    // argument validation, DOMString conversion, DOMException error
    // types); the Rust ops `op_base64_atob`/`op_base64_btoa` (registered in
    // `core::ops`) are flat encode/decode.

    // URL Standard — real constructible classes, non-enumerable.
    url::install(scope, global);
    url_search_params::install(scope, global);

    // Fetch Standard — `fetch` itself is a plain operation (enumerable);
    // `Headers`/`Response` are constructible classes (non-enumerable).
    fetch::install(scope, global);

    // Streams Standard — `ReadableStream`/`ReadableStreamReader`
    // (interface objects, non-enumerable). Used by `Response.body`.
    streams::install(scope, global);

    // File API + XHR Standard — `Blob`/`FormData` (interface objects,
    // non-enumerable). `Blob` is used by `Response.blob()`; `FormData` by
    // `Response.formData()`.
    blob::install(scope, global);
    form_data::install(scope, global);

    // DOM Standard — `Event`/`CustomEvent`/`EventTarget`/
    // `AbortController`/`AbortSignal` (interface objects, non-enumerable).
    // Installed before `performance` because `performance` is constructed
    // via the `EventTarget` machinery (`Performance : EventTarget`).
    event::install(scope, global);

    // High Resolution Time L3 — `performance` is a `[Replaceable]
    // readonly attribute` on `WindowOrWorkerGlobalScope`, installed as
    // an ordinary enumerable own property (verified shape in browsers:
    // writable/configurable/enumerable all true). `Performance` extends
    // `EventTarget`, so the singleton is built on top of the
    // `EventTarget` machinery + the three spec members
    // (`now`/`timeOrigin`/`toJSON`) as own properties.
    performance::install(scope, global);
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

/// Throw a real `DOMException` with the given `name` (e.g.
/// `"InvalidCharacterError"`, `"InvalidStateError"`). Used by `atob`,
/// `dispatchEvent`, and anywhere the spec says "throw a `NameError`
/// DOMException". The thrown value satisfies both
/// `e instanceof DOMException` and `e instanceof Error`, and carries the
/// legacy numeric `.code` where one exists.
pub fn throw_dom_exception(scope: &mut v8::PinScope, name: &str, message: &str) {
    let exception = dom_exception::new_instance(scope, name, message);
    scope.throw_exception(exception);
}