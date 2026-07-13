//! `Request` — WHATWG Fetch Standard
//! (https://fetch.spec.whatwg.org/#request-class).
//!
//! Implements the Body mixin (`body`/`bodyUsed`/`text`/`json`/
//! `arrayBuffer`/`blob`/`formData`) on top of a fully-buffered body, the
//! same way `Response` does: consuming a body takes the bytes and flips
//! `bodyUsed`, and `clone()` throws on an already-used body.
//!
//! Simplifications vs. spec: the body is buffered rather than streamed, so
//! `.body` is a one-chunk `ReadableStream` over the bytes.
//! `mode`/`credentials`/`cache`/`redirect`/`referrer`/`integrity`/
//! `duplex`/`keepalive` are omitted (the underlying HTTP client handles
//! them implicitly or they have no observable effect here). `signal` is
//! stored as the raw `AbortSignal` object (or `undefined`/`null`) —
//! `fetch()` reads it back and threads it through its own abort wiring.

use crate::web::blob;
use crate::web::fetch::headers;
use crate::web::form_data;
use crate::web::native;
use crate::web::streams;
use std::cell::RefCell;

/// Per-`Request` state, stored in internal field 0.
pub(crate) struct RequestState {
    pub method: String,
    pub url: String,
    pub header_pairs: RefCell<Vec<(String, String)>>,
    /// Cached `Headers` instance, lazily built on first `.headers`
    /// access so the same object is returned each time (spec says
    /// `.headers` is the same `Headers` instance across reads).
    pub headers_obj: RefCell<Option<v8::Global<v8::Object>>>,
    /// Whether the request has a body at all (a GET never does).
    pub has_body: bool,
    /// `Some(bytes)` until consumed by `text()`/`json()`/`arrayBuffer()`/
    /// `blob()`/`formData()`, then taken (`None`) — this is what `bodyUsed`
    /// reports.
    pub body: RefCell<Option<Vec<u8>>>,
    /// Cached `ReadableStream` for `.body` — lazily built, identity stable
    /// across accesses (per spec).
    pub body_stream: RefCell<Option<v8::Global<v8::Object>>>,
    /// `AbortSignal` object if one was provided, else `None`.
    pub signal: Option<v8::Global<v8::Object>>,
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "Request").unwrap();
    tmpl.set_class_name(name);
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    set_readonly_accessor(scope, instance, "method", get_method);
    set_readonly_accessor(scope, instance, "url", get_url);
    set_readonly_accessor(scope, instance, "headers", get_headers);
    set_readonly_accessor(scope, instance, "signal", get_signal);
    set_readonly_accessor(scope, instance, "bodyUsed", get_body_used);
    set_readonly_accessor(scope, instance, "body", get_body);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "clone", clone);
    set_method(scope, proto, "text", text);
    set_method(scope, proto, "json", json);
    set_method(scope, proto, "arrayBuffer", array_buffer);
    set_method(scope, proto, "blob", blob_method);
    set_method(scope, proto, "formData", form_data_method);

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "Request", ctor.into());
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'Request': Please use the 'new' operator");
        return;
    }

    let mut method = String::from("GET");
    let mut url = String::new();
    let mut header_pairs = Vec::new();
    let mut body: Option<Vec<u8>> = None;
    let mut signal: Option<v8::Global<v8::Object>> = None;

    // `input` is a `Request` OR a string. If `Request`, clone its fields
    // (the base); `init` (if present) overrides them.
    let input = args.get(0);
    if let Ok(input_obj) = <v8::Local<v8::Object>>::try_from(input) {
        if is_request_instance(scope, input_obj) {
            let state: &RequestState = native::get(scope, input_obj, 0);
            method = state.method.clone();
            url = state.url.clone();
            header_pairs = state.header_pairs.borrow().clone();
            // Body is cloned (spec: clone transfers the body; we have
            // no stream, so a byte-clone is the equivalent).
            body = state.body.borrow().clone();
            signal = state.signal.clone();
        }
    }
    if url.is_empty() {
        url = input.to_rust_string_lossy(scope);
    }

    // `init` overrides.
    if args.length() > 1 {
        if let Ok(init) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            let method_key = v8::String::new(scope, "method").unwrap();
            if let Some(v) = init.get(scope, method_key.into()) {
                if !v.is_undefined() {
                    method = v.to_rust_string_lossy(scope).to_uppercase();
                }
            }
            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(v) = init.get(scope, headers_key.into()) {
                if !v.is_undefined() {
                    header_pairs = headers::parse_value(scope, v);
                }
            }
            let body_key = v8::String::new(scope, "body").unwrap();
            if let Some(v) = init.get(scope, body_key.into()) {
                if !v.is_undefined() && !v.is_null() {
                    body = Some(
                        native::read_buffer_source(v)
                            .unwrap_or_else(|| v.to_rust_string_lossy(scope).into_bytes()),
                    );
                }
            }
            let signal_key = v8::String::new(scope, "signal").unwrap();
            if let Some(v) = init.get(scope, signal_key.into()) {
                if !v.is_null_or_undefined() {
                    if let Ok(sig_obj) = <v8::Local<v8::Object>>::try_from(v) {
                        signal = Some(v8::Global::new(scope, sig_obj));
                    }
                } else {
                    // Explicit `null`/`undefined` clears any inherited
                    // signal (init wins over base Request per spec).
                    signal = None;
                }
            }
        }
    }

    // Spec: "If parsedURL is failure, throw a TypeError." There's no
    // document base URL in a CLI runtime, so relative specifiers can't be
    // resolved and are a failure here.
    if url::Url::parse(&url).is_err() {
        crate::web::throw_type_error(scope, &format!("Failed to construct 'Request': invalid URL \"{url}\""));
        return;
    }
    // Spec: "If init.body is non-null and request's method is GET or HEAD,
    // throw a TypeError."
    if body.is_some() && (method == "GET" || method == "HEAD") {
        crate::web::throw_type_error(
            scope,
            "Failed to construct 'Request': Request with GET/HEAD method cannot have body",
        );
        return;
    }

    let this = args.this();
    native::store(
        scope,
        this,
        0,
        RequestState {
            method,
            url,
            header_pairs: RefCell::new(header_pairs),
            headers_obj: RefCell::new(None),
            has_body: body.is_some(),
            body: RefCell::new(body),
            body_stream: RefCell::new(None),
            signal,
        },
    );
    rv.set(this.into());
}

fn get_method(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &RequestState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &state.method).unwrap().into());
}

fn get_url(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &RequestState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &state.url).unwrap().into());
}

fn get_headers(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &RequestState = native::get(scope, args.holder(), 0);
    let cached = state.headers_obj.borrow().is_some();
    if !cached {
        let pairs = state.header_pairs.borrow().clone();
        let headers_instance = headers::new_instance(scope, pairs);
        *state.headers_obj.borrow_mut() = Some(v8::Global::new(scope, headers_instance));
    }
    let g = state.headers_obj.borrow().as_ref().unwrap().clone();
    rv.set(v8::Local::new(scope, &g).into());
}

fn get_signal(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &RequestState = native::get(scope, args.holder(), 0);
    match &state.signal {
        Some(g) => rv.set(v8::Local::new(scope, g).into()),
        None => rv.set(v8::undefined(scope).into()),
    }
}

fn get_body_used(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let used = is_disturbed(scope, args.holder());
    rv.set(v8::Boolean::new(scope, used).into());
}

/// The body is "disturbed" once its bytes were taken by a body-consuming
/// method, or once a reader was acquired on the `.body` stream. A request
/// with no body at all is never disturbed (spec: `bodyUsed` is `false`).
fn is_disturbed(scope: &mut v8::PinScope, this: v8::Local<v8::Object>) -> bool {
    let state: &RequestState = native::get(scope, this, 0);
    if !state.has_body {
        return false;
    }
    if state.body.borrow().is_none() {
        return true;
    }
    let stream_ref = state.body_stream.borrow();
    let Some(stream_global) = stream_ref.as_ref() else {
        return false;
    };
    let stream = v8::Local::new(scope, stream_global);
    let key = v8::String::new(scope, "locked").unwrap();
    stream.get(scope, key.into()).map(|v| v.boolean_value(scope)).unwrap_or(false)
}

/// `body` getter — `null` when there's no body at all (spec), otherwise a
/// `ReadableStream` over the buffered bytes, built once and cached.
fn get_body(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &RequestState = native::get(scope, args.holder(), 0);
    // Spec: `.body` is `null` for a bodyless request (every GET, for one).
    if !state.has_body {
        rv.set(v8::null(scope).into());
        return;
    }
    if let Some(cached) = state.body_stream.borrow().as_ref() {
        rv.set(v8::Local::new(scope, cached).into());
        return;
    }
    let bytes = state.body.borrow().clone().unwrap_or_default();
    let stream = streams::new_fixed_stream(scope, vec![bytes]);
    *state.body_stream.borrow_mut() = Some(v8::Global::new(scope, stream));
    rv.set(stream.into());
}

/// Take the buffered body, or throw `TypeError` if already used — shared by
/// every body-consuming method.
fn take_body(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<Vec<u8>> {
    let state: &RequestState = native::get(scope, args.this(), 0);
    // A bodyless request consumes as an empty body and never becomes "used".
    if !state.has_body {
        return Some(Vec::new());
    }
    if is_disturbed(scope, args.this()) {
        crate::web::throw_type_error(scope, "body stream already read");
        return None;
    }
    let taken = state.body.borrow_mut().take();
    if taken.is_none() {
        crate::web::throw_type_error(scope, "body stream already read");
    }
    taken
}

fn text(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(bytes) = take_body(scope, &args) else { return };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let s = v8::String::new(scope, &text).unwrap();
    resolve_with(scope, &mut rv, s.into());
}

fn json(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(bytes) = take_body(scope, &args) else { return };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let Some(code) = v8::String::new(scope, &text) else { return };
    match v8::json::parse(scope, code) {
        Some(value) => resolve_with(scope, &mut rv, value),
        None => { /* json::parse already scheduled a SyntaxError */ }
    }
}

fn array_buffer(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(bytes) = take_body(scope, &args) else { return };
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    resolve_with(scope, &mut rv, ab.into());
}

/// `blob()` — a `Blob` whose `type` is the request's `content-type` header.
fn blob_method(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(bytes) = take_body(scope, &args) else { return };
    let state: &RequestState = native::get(scope, args.this(), 0);
    let type_ = state
        .header_pairs
        .borrow()
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let blob = blob::new_blob_instance(scope, bytes, type_);
    resolve_with(scope, &mut rv, blob.into());
}

/// `formData()` — same body-type rules as `Response.formData()`.
fn form_data_method(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &RequestState = native::get(scope, args.this(), 0);
    let content_type = state
        .header_pairs
        .borrow()
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();

    let reject = |scope: &mut v8::PinScope, rv: &mut v8::ReturnValue<v8::Value>, message: &str| {
        let resolver = v8::PromiseResolver::new(scope).unwrap();
        let msg = v8::String::new(scope, message).unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        resolver.reject(scope, exc);
        rv.set(resolver.get_promise(scope).into());
    };

    match mime.as_str() {
        "application/x-www-form-urlencoded" => {
            let Some(bytes) = take_body(scope, &args) else { return };
            let fd = form_data::new_instance(scope);
            form_data::append_urlencoded(scope, fd, &bytes);
            resolve_with(scope, &mut rv, fd.into());
        }
        "multipart/form-data" => {
            let Some(boundary) = crate::web::fetch::response::content_type_boundary(&content_type) else {
                reject(scope, &mut rv, "formData: multipart/form-data content-type has no boundary parameter");
                return;
            };
            let Some(bytes) = take_body(scope, &args) else { return };
            let fd = form_data::new_instance(scope);
            match form_data::append_multipart(scope, fd, &bytes, &boundary) {
                Ok(()) => resolve_with(scope, &mut rv, fd.into()),
                Err(message) => reject(scope, &mut rv, &format!("formData: {message}")),
            }
        }
        _ => reject(
            scope,
            &mut rv,
            "formData: request content-type is neither application/x-www-form-urlencoded nor multipart/form-data",
        ),
    }
}

/// Bodies are buffered → the promise settles immediately.
fn resolve_with(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue<v8::Value>, value: v8::Local<v8::Value>) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    resolver.resolve(scope, value);
    rv.set(resolver.get_promise(scope).into());
}

fn clone(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    // Spec: "If this is disturbed or locked, throw a TypeError."
    if is_disturbed(scope, this) {
        crate::web::throw_type_error(scope, "clone: body stream already read");
        return;
    }
    let state: &RequestState = native::get(scope, this, 0);
    let header_pairs = state.header_pairs.borrow().clone();
    let body = state.body.borrow().clone();
    let signal = state.signal.clone();

    // Build the instance from the cached template's constructor. Pass the URL
    // so the constructor's validation passes; the state is then overwritten
    // wholesale below (the placeholder construction has no observable effect).
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "Request").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    let url_arg = v8::String::new(scope, &state.url).unwrap();
    let instance = ctor.new_instance(scope, &[url_arg.into()]).unwrap();
    native::store(
        scope,
        instance,
        0,
        RequestState {
            method: state.method.clone(),
            url: state.url.clone(),
            header_pairs: RefCell::new(header_pairs),
            headers_obj: RefCell::new(None),
            has_body: state.has_body,
            body: RefCell::new(body),
            body_stream: RefCell::new(None),
            signal,
        },
    );
    rv.set(instance.into());
}

/// `true` iff `obj` is a `Request` instance (field 0 = External
/// pointing at a `RequestState`).
pub(crate) fn is_request_instance(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    native::is::<RequestState>(scope, obj, 0)
}

/// Read the `RequestState` from a `Request` instance. Used by
/// `fetch()` when the input is a `Request`.
pub(crate) fn state<'a>(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
) -> &'a RequestState {
    let state: &RequestState = native::get(scope, obj, 0);
    state
}

fn set_method(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::FunctionTemplate::new(scope, callback);
    target.set(key.into(), func.into());
}

fn set_readonly_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor(key.into(), getter);
}