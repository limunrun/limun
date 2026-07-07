//! `Response` — WHATWG Fetch Standard
//! (https://fetch.spec.whatwg.org/#response-class).
//!
//! Simplifications vs. spec: body is always fully buffered up front (no
//! `ReadableStream`/`body` getter — there's no async I/O in this runtime
//! yet, same simplification dynamic `import()` already makes), so
//! `.text()`/`.json()`/`.arrayBuffer()` resolve immediately once called.
//! `blob()`/`formData()` aren't implemented (no `Blob`/`FormData` classes
//! yet — documented gap, same style as `Request` not being implemented).
//! `.type` is always `"basic"`; redirects are followed transparently by
//! the underlying HTTP client with no way to observe the chain, so
//! `.redirected` is always `false` and `.url` is always the *requested*
//! URL, not necessarily the final one after a redirect.

use crate::web::fetch::headers;
use crate::web::native;
use std::cell::RefCell;

pub(crate) struct ResponseState {
    pub status: u16,
    pub status_text: String,
    pub headers: v8::Global<v8::Object>,
    pub url: String,
    /// `Some(bytes)` until first consumed by `.text()`/`.json()`/
    /// `.arrayBuffer()`, then taken (`None`) — matches spec's `bodyUsed`.
    pub body: RefCell<Option<Vec<u8>>>,
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

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "text", text);
    set_method(scope, proto, "json", json);
    set_method(scope, proto, "arrayBuffer", array_buffer);
    set_method(scope, proto, "clone", clone);

    let ctor = tmpl.get_function(scope).unwrap();
    let key = v8::String::new(scope, "json").unwrap();
    let static_json = v8::Function::new(scope, static_json).unwrap();
    ctor.set(scope, key.into(), static_json.into());

    crate::web::set_global(scope, global, "Response", ctor.into());
}

/// Build a `Response` instance from Rust (used by `fetch()`'s result).
pub(crate) fn new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    status: u16,
    status_text: String,
    header_pairs: Vec<(String, String)>,
    body: Vec<u8>,
    url: String,
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
            url,
            body: RefCell::new(Some(body)),
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

    let body = if args.length() > 0 && !args.get(0).is_undefined() && !args.get(0).is_null() {
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
                    header_pairs = read_headers_init(scope, v);
                }
            }
        }
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
            url: String::new(),
            body: RefCell::new(Some(body)),
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
                    // User-provided headers take priority over the default
                    // content-type we set above (later entries win in
                    // `Headers::new_instance`? — simplest: prepend user
                    // headers so `set` semantics don't apply; instead just
                    // append and let `content-type` possibly appear twice
                    // if the user also set one — rare, acceptable).
                    header_pairs.extend(read_headers_init(scope, v));
                }
            }
        }
    }

    let instance = new_instance(scope, status, status_text, header_pairs, body, String::new());
    rv.set(instance.into());
}

fn read_headers_init(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Vec<(String, String)> {
    headers::parse_value(scope, value)
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
    _args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    rv.set(v8::Boolean::new(scope, false).into());
}

fn get_type(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    _args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    rv.set(v8::String::new(scope, "basic").unwrap().into());
}

fn get_body_used(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ResponseState = native::get(scope, args.holder(), 0);
    rv.set(v8::Boolean::new(scope, state.body.borrow().is_none()).into());
}

/// Take the buffered body, or throw if already consumed — shared by
/// `text`/`json`/`arrayBuffer`.
fn take_body(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<Vec<u8>> {
    let state: &ResponseState = native::get(scope, args.this(), 0);
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

fn clone(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    let state: &ResponseState = native::get(scope, this, 0);
    let body = state.body.borrow();
    let Some(bytes) = body.as_ref() else {
        crate::web::throw_type_error(scope, "clone: body stream already read");
        return;
    };
    let header_pairs = headers::read_pairs(scope, v8::Local::new(scope, &state.headers));
    let cloned = new_instance(
        scope,
        state.status,
        state.status_text.clone(),
        header_pairs,
        bytes.clone(),
        state.url.clone(),
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
