//! Layer 1 globals — web-standard surface installed on `globalThis`.
//! `console` (WHATWG Console Standard) is the seed; `self` is the realm-
//! agnostic self-reference from the WHATWG HTML `Window`/`WorkerGlobalScope`
//! mixin. `alert`/`confirm`/`prompt` are the user-prompt globals from the
//! WHATWG HTML `Window` interface, adapted to a terminal (Deno model). No
//! `window` itself: there is no browsing context here to name.

pub mod blob;
pub mod dom_exception;
pub mod fetch;
pub mod form_data;
mod native;
pub mod performance;
pub mod streams;
pub mod url;
pub mod url_search_params;

/// Install all web-standard globals onto `context`'s global object.
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);

    // `DOMException` is installed by the JS module
    // `ext:limun/01_dom_exception.js` during bootstrap (a constructible
    // class, non-enumerable global). Its constructor is cached into a
    // Rust thread_local by `dom_exception::cache_ctor` after the JS
    // bootstrap loop runs (see `core::mod::execute`) — Rust callers
    // (`throw_dom_exception`, `AbortSignal`'s default abort reason) mint
    // instances through that cached ctor.

    // `console` is installed by the JS module
    // `ext:limun/01_console.js` during bootstrap (a namespace object,
    // non-enumerable global — Web IDL §3.7.5). The JS layer owns the
    // WHATWG Console Standard surface (formatting, group indentation,
    // table, timer/count state); the flat Rust op `op_print` (registered
    // in `core::ops`) is the irreducible stdout/stderr write.

    // User-prompt globals (alert/confirm/prompt) — installed by the JS
    // module `ext:limun/41_prompt.js` during bootstrap (plain operations,
    // enumerable per Web IDL §3.7.3). The JS layer owns the spec surface
    // (argument coercion, TTY gating, return shaping); the flat Rust ops
    // (`op_prompt_alert`, `op_prompt_confirm`, `op_prompt_prompt`,
    // `op_prompt_is_tty`) live in `core::ops`.

    // Timers (WHATWG HTML) — installed by the JS module
    // `ext:limun/02_timers.js` during bootstrap (plain operations,
    // enumerable). The JS layer owns the spec surface (the `this`
    // check, WebIDL `long` coercion of the timeout, string-callback
    // indirect eval, extra-args handling, numeric ID exposure); the
    // flat Rust ops (`op_timer_schedule`, `op_timer_clear`,
    // `op_queue_microtask`) live in `core::ops`.

    // `self`: realm-agnostic self-reference (WHATWG HTML, shared with Worker
    // scope). Same object as `globalThis` — not a subclass, not a wrapper.
    //
    // Unlike `console` (a namespace object — non-enumerable per Web IDL
    // §3.7.5), `self` is an ordinary interface attribute, which defaults to
    // enumerable per Web IDL §3.7.3. Verified against real browsers:
    // `Object.keys(globalThis)` includes "self" there, so use plain `set`.
    let key = v8::String::new(scope, "self").unwrap();
    global.set(scope, key.into(), global.into());

    // Encoding Standard — `TextEncoder`/`TextDecoder` installed by the JS
    // module `ext:limun/08_text_encoding.js` during bootstrap (real
    // constructible classes, non-enumerable — matches Node/Deno/browsers).
    // The JS layer owns the spec surface (label normalization fast-path,
    // WebIDL argument validation, BOM/fatal/ignoreBOM option parsing,
    // streaming state, error-type selection); the flat Rust ops
    // (`op_encoding_normalize_label`, `op_encoding_decode_single`,
    // `op_encoding_new_decoder`, `op_encoding_decode`,
    // `op_encoding_decode_finish`, `op_encoding_encode_into`) live in
    // `core::ops`.

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
    // Installed by the JS module `ext:limun/02_event.js` during
    // bootstrap (real constructible classes). The JS layer owns the spec
    // surface (listener dispatch, `on<event>` handler attributes,
    // `AbortSignal.any()`/`timeout()`/`abort()`); the flat Rust ops
    // (`op_abort_signal_is_aborted`/`op_abort_signal_get_reason`/
    // `op_abort_signal_add_listener` in `core::ops`) are thin bridges
    // so `fetch()` can read an `AbortSignal`'s state and register abort
    // listeners without reaching into JS private symbols.

    // High Resolution Time L3 — `performance` is installed by the JS module
    // `ext:limun/15_performance.js` during bootstrap (an enumerable own
    // property on `globalThis`, matching browsers). The flat Rust ops
    // (`op_now`, `op_time_origin`) live in `core::ops`; the clock anchors
    // (`now_value`/`time_origin_value`, also used by `02_event.js` for
    // `Event.timeStamp` via the `op_now` op) live in `web::performance`.
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
/// `"InvalidCharacterError"`, `"InvalidStateError"`). The thrown value
/// satisfies both `e instanceof DOMException` and `e instanceof Error`,
/// and carries the legacy numeric `.code` where one exists.
///
/// Currently unused (the previous caller, `web::event`'s `dispatchEvent`
/// validation, migrated to JS where DOMException is thrown directly).
/// Retained for the next Rust caller that needs a DOMException throw —
/// the JS class is cached by `dom_exception::cache_ctor` after bootstrap,
/// so this is ready to use.
#[allow(dead_code)]
pub fn throw_dom_exception(scope: &mut v8::PinScope, name: &str, message: &str) {
    let exception = dom_exception::new_instance(scope, name, message);
    scope.throw_exception(exception);
}