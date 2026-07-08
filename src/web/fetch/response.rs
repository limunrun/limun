//! `Response` — WHATWG Fetch Standard
//! (https://fetch.spec.whatwg.org/#response-class).
//!
//! Simplifications vs. spec: body is always fully buffered up front (no
//! `ReadableStream`/`body` getter — there's no async I/O in this runtime
//! yet, same simplification dynamic `import()` already makes), so
//! `.text()`/`.json()`/`.arrayBuffer()`/`.blob()`/`.formData()` resolve
//! immediately once called. `.type` is always `"basic"`; redirects are
//! followed transparently by the underlying HTTP client, so `.redirected`
//! reflects whether the final URL differs from the originally requested
//! one, and `.url` is the final (post-redirect) URL.
//!
//! `formData()` parses both `application/x-www-form-urlencoded` and
//! `multipart/form-data` bodies (the latter needs a `boundary` parameter on
//! the content-type). Any other content-type rejects the promise with a
//! `TypeError`, per spec.

use crate::web::blob;
use crate::web::fetch::headers;
use crate::web::form_data;
use crate::web::native;
use crate::web::streams;
use std::cell::RefCell;

pub(crate) struct ResponseState {
    pub status: u16,
    pub status_text: String,
    pub headers: v8::Global<v8::Object>,
    /// The originally requested URL (pre-redirect). Empty for
    /// user-constructed `Response`s (no request happened).
    pub original_url: String,
    /// The final URL (post-redirect) — matches browser `Response.url`.
    pub url: String,
    /// Response `type`: "basic" for normal/constructed responses, "error"
    /// for `Response.error()`. (No CORS here, so "cors"/"opaque" never arise.)
    pub response_type: &'static str,
    /// Whether this response has a body *at all*. `new Response()` and
    /// `Response.error()` have a null body: `.body` is `null` and `bodyUsed`
    /// stays `false`, but `.text()` still resolves with `""`.
    pub has_body: bool,
    /// `Some(bytes)` until first consumed by `.text()`/`.json()`/
    /// `.arrayBuffer()`, then taken (`None`) — this drives `bodyUsed`.
    pub body: RefCell<Option<Vec<u8>>>,
    /// Cached `ReadableStream` for `.body` — lazily built on first access,
    /// identity stable across accesses (matches spec). `None` until built,
    /// and never built if the body was already consumed via
    /// `.text()`/`.json()`/`.arrayBuffer()` (those take the body first).
    pub body_stream: RefCell<Option<v8::Global<v8::Object>>>,
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "Response").unwrap();
    tmpl.set_class_name(name);
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    set_readonly_accessor(scope, instance, "status", get_status);
    set_readonly_accessor(scope, instance, "statusText", get_status_text);
    set_readonly_accessor(scope, instance, "ok", get_ok);
    set_readonly_accessor(scope, instance, "headers", get_headers);
    set_readonly_accessor(scope, instance, "url", get_url);
    set_readonly_accessor(scope, instance, "redirected", get_redirected);
    set_readonly_accessor(scope, instance, "type", get_type);
    set_readonly_accessor(scope, instance, "bodyUsed", get_body_used);
    set_readonly_accessor(scope, instance, "body", get_body);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "text", text);
    set_method(scope, proto, "json", json);
    set_method(scope, proto, "arrayBuffer", array_buffer);
    set_method(scope, proto, "blob", blob_method);
    set_method(scope, proto, "formData", form_data_method);
    set_method(scope, proto, "clone", clone);

    let ctor = tmpl.get_function(scope).unwrap();
    let key = v8::String::new(scope, "json").unwrap();
    let static_json = v8::Function::new(scope, static_json).unwrap();
    ctor.set(scope, key.into(), static_json.into());
    let key = v8::String::new(scope, "error").unwrap();
    let static_error = v8::Function::new(scope, static_error).unwrap();
    ctor.set(scope, key.into(), static_error.into());
    let key = v8::String::new(scope, "redirect").unwrap();
    let static_redirect = v8::Function::new(scope, static_redirect).unwrap();
    ctor.set(scope, key.into(), static_redirect.into());

    crate::web::set_global(scope, global, "Response", ctor.into());
}

/// Build a `Response` instance from Rust (used by `fetch()`'s result).
pub(crate) fn new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    status: u16,
    status_text: String,
    header_pairs: Vec<(String, String)>,
    body: Vec<u8>,
    original_url: String,
    final_url: String,
    response_type: &'static str,
    has_body: bool,
) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "Response").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    let instance = ctor.new_instance(scope, &[]).unwrap();

    let headers_instance = headers::new_instance(scope, header_pairs);
    let headers_global = v8::Global::new(scope, headers_instance);

    native::store(
        scope,
        instance,
        0,
        ResponseState {
            status,
            status_text,
            headers: headers_global,
            original_url,
            url: final_url,
            response_type,
            has_body,
            body: RefCell::new(Some(body)),
            body_stream: RefCell::new(None),
        },
    );
    instance
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'Response': Please use the 'new' operator");
        return;
    }

    let has_body = args.length() > 0 && !args.get(0).is_undefined() && !args.get(0).is_null();
    let body = if has_body {
        match native::read_buffer_source(args.get(0)) {
            Some(b) => b,
            None => args.get(0).to_rust_string_lossy(scope).into_bytes(),
        }
    } else {
        Vec::new()
    };

    let mut status = 200u16;
    let mut status_text = String::new();
    let mut header_pairs = Vec::new();

    if args.length() > 1 {
        if let Ok(init) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            let status_key = v8::String::new(scope, "status").unwrap();
            if let Some(v) = init.get(scope, status_key.into()) {
                if !v.is_undefined() {
                    // Spec: status is in [200, 599]; anything else (including
                    // NaN / out-of-u16 values) is a RangeError.
                    let raw = v.number_value(scope).unwrap_or(f64::NAN);
                    if !(200.0..=599.0).contains(&raw) {
                        crate::web::throw_range_error(
                            scope,
                            "Failed to construct 'Response': status must be in the range 200 to 599",
                        );
                        return;
                    }
                    status = raw as u16;
                }
            }
            let status_text_key = v8::String::new(scope, "statusText").unwrap();
            if let Some(v) = init.get(scope, status_text_key.into()) {
                if !v.is_undefined() {
                    status_text = v.to_rust_string_lossy(scope);
                }
            }
            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(v) = init.get(scope, headers_key.into()) {
                if !v.is_undefined() {
                    header_pairs = read_headers_init(scope, v);
                }
            }
        }
    }

    // Spec: a null-body status (204/205/304) with a non-null body is a
    // TypeError.
    if has_body && matches!(status, 204 | 205 | 304) {
        crate::web::throw_type_error(
            scope,
            "Failed to construct 'Response': Response with null body status cannot have body",
        );
        return;
    }

    let this = args.this();
    let headers_instance = headers::new_instance(scope, header_pairs);
    let headers_global = v8::Global::new(scope, headers_instance);
    native::store(
        scope,
        this,
        0,
        ResponseState {
            status,
            status_text,
            headers: headers_global,
            original_url: String::new(),
            url: String::new(),
            response_type: "basic",
            has_body,
            body: RefCell::new(Some(body)),
            body_stream: RefCell::new(None),
        },
    );
    rv.set(this.into());
}

/// `Response.json(data, init?)` — static convenience constructor.
fn static_json(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(json_str) = v8::json::stringify(scope, args.get(0)) else {
        crate::web::throw_type_error(scope, "Response.json: value could not be serialized");
        return;
    };
    let body = json_str.to_rust_string_lossy(scope).into_bytes();
    let mut header_pairs = vec![("content-type".to_string(), "application/json".to_string())];
    let mut status = 200u16;
    let mut status_text = String::new();

    if args.length() > 1 {
        if let Ok(init) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            let status_key = v8::String::new(scope, "status").unwrap();
            if let Some(v) = init.get(scope, status_key.into()) {
                if !v.is_undefined() {
                    status = v.number_value(scope).unwrap_or(200.0) as u16;
                }
            }
            let status_text_key = v8::String::new(scope, "statusText").unwrap();
            if let Some(v) = init.get(scope, status_text_key.into()) {
                if !v.is_undefined() {
                    status_text = v.to_rust_string_lossy(scope);
                }
            }
            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(v) = init.get(scope, headers_key.into()) {
                if !v.is_undefined() {
                    // A user-supplied `content-type` *replaces* the default
                    // `application/json` rather than appearing alongside it
                    // (the spec sets content-type only if the header list
                    // doesn't already contain one).
                    let user = read_headers_init(scope, v);
                    if user.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
                        header_pairs.clear();
                    }
                    header_pairs.extend(user);
                }
            }
        }
    }

    let instance = new_instance(
        scope,
        status,
        status_text,
        header_pairs,
        body,
        String::new(),
        String::new(),
        "basic",
        true,
    );
    rv.set(instance.into());
}

fn read_headers_init(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Vec<(String, String)> {
    headers::parse_value(scope, value)
}

/// `Response.error()` — a network-error response: status 0, empty body,
/// `type === "error"`. Per spec its headers list is empty and immutable;
/// we don't enforce immutability (no header guards), which is an
/// observable-only-on-mutation simplification.
fn static_error(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let instance = new_instance(
        scope,
        0,
        String::new(),
        Vec::new(),
        Vec::new(),
        String::new(),
        String::new(),
        "error",
        false,
    );
    rv.set(instance.into());
}

/// `Response.redirect(url, status = 302)` — a redirect response with the
/// `Location` header set to `url` (serialized/validated) and the given
/// redirect status. `status` must be one of 301/302/303/307/308, else a
/// `RangeError` is thrown (per spec).
fn static_redirect(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let url_str = args.get(0).to_rust_string_lossy(scope);
    // Parse+serialize the URL (spec: throws TypeError if it doesn't parse).
    let location = match url::Url::parse(&url_str) {
        Ok(u) => u.to_string(),
        Err(e) => {
            crate::web::throw_type_error(scope, &format!("Response.redirect: invalid URL {url_str:?}: {e}"));
            return;
        }
    };
    let status = if args.length() > 1 && !args.get(1).is_undefined() {
        args.get(1).number_value(scope).unwrap_or(302.0) as u16
    } else {
        302
    };
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        crate::web::throw_range_error(scope, "Response.redirect: status must be one of 301, 302, 303, 307, 308");
        return;
    }
    let status_text = reason_phrase(status);
    let instance = new_instance(
        scope,
        status,
        status_text,
        vec![("location".to_string(), location)],
        Vec::new(),
        String::new(),
        String::new(),
        "basic",
        false,
    );
    rv.set(instance.into());
}

/// Canonical HTTP reason phrase for the redirect status codes.
fn reason_phrase(status: u16) -> String {
    match status {
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        _ => "",
    }
    .to_string()
}

fn get_status(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    rv.set(v8::Number::new(scope, state.status as f64).into());
}

fn get_status_text(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &state.status_text).unwrap().into());
}

fn get_ok(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    let ok = (200..300).contains(&state.status);
    rv.set(v8::Boolean::new(scope, ok).into());
}

fn get_headers(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    rv.set(v8::Local::new(scope, &state.headers).into());
}

fn get_url(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &state.url).unwrap().into());
}

fn get_redirected(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    // User-constructed Responses (original_url empty) never redirected;
    // fetched Responses redirected iff the final URL differs from the
    // originally requested one.
    let redirected = !state.original_url.is_empty() && state.original_url != state.url;
    rv.set(v8::Boolean::new(scope, redirected).into());
}

fn get_type(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, state.response_type).unwrap().into());
}

fn get_body_used(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    // Spec: a null-body response is never "used". Otherwise `bodyUsed` is
    // true once the bytes were taken by `text()`/`json()`/`arrayBuffer()`,
    // or once a reader was acquired on the `.body` stream (disturbed).
    let used = state.has_body
        && (state.body.borrow().is_none() || is_body_stream_locked(scope, args.holder()));
    rv.set(v8::Boolean::new(scope, used).into());
}

/// `true` if a `.body` stream has been created AND a reader acquired on it
/// (i.e. the body is "disturbed" per spec). A stream created but never
/// read doesn't count — `bodyUsed` reflects actual consumption.
fn is_body_stream_locked(scope: &mut v8::PinScope, holder: v8::Local<v8::Object>) -> bool {
    let state: &ResponseState = native::get(scope, holder, 0);
    let stream_ref = state.body_stream.borrow();
    let Some(stream_global) = stream_ref.as_ref() else {
        return false;
    };
    let stream = v8::Local::new(scope, stream_global);
    // The stream's `locked` getter is on the instance template; read it
    // via the property rather than poking the internal field directly
    // (keeps the encapsulation honest).
    let key = v8::String::new(scope, "locked").unwrap();
    stream
        .get(scope, key.into())
        .map(|v| v.boolean_value(scope))
        .unwrap_or(false)
}

/// `body` getter — lazily builds a `ReadableStream` over the buffered
/// body on first access, caches it (identity stable across accesses),
/// and throws `TypeError` if the body was already consumed by
/// `text()`/`json()`/`arrayBuffer()` (i.e. `body` is `None`).
fn get_body(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);

    // Spec: `.body` is `null` for a null-body response (`new Response()`,
    // `Response.error()`, a 204). It is *not* an error to read `.body` after
    // the body was consumed — you get the same (disturbed) stream back.
    if !state.has_body {
        rv.set(v8::null(scope).into());
        return;
    }

    // Return the cached stream if one was already built (identity is stable).
    if let Some(cached) = state.body_stream.borrow().as_ref() {
        rv.set(v8::Local::new(scope, cached).into());
        return;
    }

    // Build a fixed stream: one chunk = the whole body, then done. Clone
    // the bytes so the stream is independent of `state.body` (the buffered
    // bytes stay available for text()/json()/arrayBuffer() until they take
    // them — the mutual exclusion is enforced by `bodyUsed`, not by moving
    // ownership here). A consumed body yields an already-empty stream.
    let bytes = state.body.borrow().clone().unwrap_or_default();
    let stream = streams::new_fixed_stream(scope, vec![bytes]);
    let global = v8::Global::new(scope, stream);
    *state.body_stream.borrow_mut() = Some(global);
    rv.set(stream.into());
}

/// Take the buffered body, or throw if already consumed — shared by
/// `text`/`json`/`arrayBuffer`. Also throws if a `.body` stream was built
/// and a reader acquired on it (the body is "disturbed" per spec).
fn take_body(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<Vec<u8>> {
    let state: &ResponseState = native::get(scope, args.this(), 0);
    // A null-body response consumes as an empty body (`new Response().text()`
    // resolves with `""`) and never becomes "used".
    if !state.has_body {
        return Some(Vec::new());
    }
    if is_body_stream_locked(scope, args.this()) {
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
    let Some(bytes) = take_body(scope, &args) else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let s = v8::String::new(scope, &text).unwrap();
    resolve_with(scope, &mut rv, s.into());
}

fn json(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(bytes) = take_body(scope, &args) else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let Some(code) = v8::String::new(scope, &text) else {
        return;
    };
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
    let Some(bytes) = take_body(scope, &args) else {
        return;
    };
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let _ = len;
    resolve_with(scope, &mut rv, ab.into());
}

/// `blob()` — resolve with a `Blob` whose `type` is the response's
/// `content-type` header (or `""`) and bytes = the body. Body is buffered
/// so the promise settles immediately.
fn blob_method(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(bytes) = take_body(scope, &args) else {
        return;
    };
    let state: &ResponseState = native::get(scope, args.this(), 0);
    let headers_obj = v8::Local::new(scope, &state.headers);
    let type_ = headers::read_pairs(scope, headers_obj)
        .into_iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v)
        .unwrap_or_default();
    let blob = blob::new_instance(scope, bytes, type_);
    resolve_with(scope, &mut rv, blob.into());
}

/// `formData()` — parse the body as `application/x-www-form-urlencoded` or
/// `multipart/form-data` and resolve with a `FormData`. Any other
/// content-type (or a multipart body with no `boundary`) rejects the
/// promise with a `TypeError`.
fn form_data_method(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.this(), 0);
    let headers_obj = v8::Local::new(scope, &state.headers);
    let content_type = headers::read_pairs(scope, headers_obj)
        .into_iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v)
        .unwrap_or_default();
    // `application/x-www-form-urlencoded` and `multipart/form-data` are the
    // two body types `formData()` accepts (Fetch Standard, "body mixin").
    // Strip any parameters (`; charset=…`, `; boundary=…`) before the check.
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
            let Some(bytes) = take_body(scope, &args) else {
                return;
            };
            let fd = form_data::new_instance(scope);
            form_data::append_urlencoded(scope, fd, &bytes);
            resolve_with(scope, &mut rv, fd.into());
        }
        "multipart/form-data" => {
            // The `boundary` parameter is mandatory for multipart bodies;
            // without it the body can't be split and the spec throws.
            let Some(boundary) = content_type_param(&content_type, "boundary") else {
                reject(scope, &mut rv, "formData: multipart/form-data content-type has no boundary parameter");
                return;
            };
            let Some(bytes) = take_body(scope, &args) else {
                return;
            };
            let fd = form_data::new_instance(scope);
            match form_data::append_multipart(scope, fd, &bytes, &boundary) {
                Ok(()) => resolve_with(scope, &mut rv, fd.into()),
                Err(message) => reject(scope, &mut rv, &format!("formData: {message}")),
            }
        }
        _ => reject(
            scope,
            &mut rv,
            "formData: response content-type is neither application/x-www-form-urlencoded nor multipart/form-data",
        ),
    }
}

/// The `boundary` parameter of a `multipart/form-data` content-type, if any.
/// Shared with `Request.formData()`.
pub(crate) fn content_type_boundary(content_type: &str) -> Option<String> {
    content_type_param(content_type, "boundary")
}

/// Pull a `; key=value` parameter out of a content-type header value,
/// unwrapping an optional quoted-string form (`boundary="----abc"`).
fn content_type_param(content_type: &str, key: &str) -> Option<String> {
    for part in content_type.split(';').skip(1) {
        // A parameter without '=' is malformed — skip it rather than
        // abandoning the search (there may be a valid one after it).
        let Some((k, v)) = part.trim().split_once('=') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let v = v.trim();
        let v = v.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(v);
        if v.is_empty() {
            return None;
        }
        return Some(v.to_string());
    }
    None
}

fn clone(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    let state: &ResponseState = native::get(scope, this, 0);
    let body = state.body.borrow();
    // Spec: cloning a disturbed or locked body throws. A null-body response
    // is neither, and clones fine.
    if state.has_body && (body.is_none() || is_body_stream_locked(scope, this)) {
        crate::web::throw_type_error(scope, "clone: body stream already read");
        return;
    }
    let bytes = body.clone().unwrap_or_default();
    let header_pairs = headers::read_pairs(scope, v8::Local::new(scope, &state.headers));
    let cloned = new_instance(
        scope,
        state.status,
        state.status_text.clone(),
        header_pairs,
        bytes,
        state.original_url.clone(),
        state.url.clone(),
        state.response_type,
        state.has_body,
    );
    rv.set(cloned.into());
}

/// All our body-consuming methods have the bytes ready synchronously (no
/// stream to await), so just settle a resolved promise immediately —
/// same simplification as dynamic `import()`.
fn resolve_with(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue<v8::Value>, value: v8::Local<v8::Value>) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    resolver.resolve(scope, value);
    rv.set(resolver.get_promise(scope).into());
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
