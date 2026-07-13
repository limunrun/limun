//! `FormData` — Rust bridge for the JS-defined class.
//!
//! Spec logic (the `FormData` class, append/delete/get/getAll/has/set,
//! iteration, "create an entry" steps, `multipart/form-data` and
//! `application/x-www-form-urlencoded` parsing) lives in
//! `ext:limun/10_form_data.js`. This file is only the Rust-side bridge:
//! it caches the JS factory `globalThis.__bootstrap.createFormData` and
//! the JS parsers `formDataAppendUrlEncoded` / `formDataParseMultipart`
//! after the JS module evaluates so Rust callers
//! (`Response.formData()`, `Request.formData()`) can mint and populate
//! a `FormData` without re-entering JS to look up the functions every
//! time.
//!
//! `cache_factories` is called from `core::mod::execute` after the
//! internal JS bootstrap loop (the module installs the functions on
//! `globalThis.__bootstrap` and `cache_factories` stashes `v8::Global`s
//! to them). Before that runs the thread_locals are `None` and
//! `new_instance` falls back to a bare `globalThis.FormData` lookup.

use std::cell::RefCell;

thread_local! {
    /// Cached `globalThis.__bootstrap.createFormData`. Populated by
    /// `cache_factories` after `ext:limun/10_form_data.js` evaluates.
    static CREATE_FORM_DATA: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
    /// Cached `globalThis.__bootstrap.formDataAppendUrlEncoded`.
    static APPEND_URLENCODED: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
    /// Cached `globalThis.__bootstrap.formDataParseMultipart`. Returns
    /// `null` on success, a string error message on failure.
    static PARSE_MULTIPART: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

/// Cache the JS factory + parsers into the thread_locals. Called from
/// `core::mod::execute` after the internal JS bootstrap loop — the JS
/// module has installed the functions on `globalThis.__bootstrap` by
/// then. Must run before any Rust caller can `new_instance` /
/// `append_urlencoded` / `append_multipart`.
pub fn cache_factories(scope: &mut v8::PinScope) {
    let global = scope.get_current_context().global(scope);
    let bs_key = v8::String::new(scope, "__bootstrap").unwrap();
    let Some(bs_val) = global.get(scope, bs_key.into()) else {
        return;
    };
    let Ok(bs) = <v8::Local<v8::Object>>::try_from(bs_val) else {
        return;
    };

    cache_one(scope, bs, "createFormData", &CREATE_FORM_DATA);
    cache_one(scope, bs, "formDataAppendUrlEncoded", &APPEND_URLENCODED);
    cache_one(scope, bs, "formDataParseMultipart", &PARSE_MULTIPART);
}

fn cache_one(
    scope: &mut v8::PinScope,
    bs: v8::Local<v8::Object>,
    name: &str,
    slot: &'static std::thread::LocalKey<RefCell<Option<v8::Global<v8::Function>>>>,
) {
    let key = v8::String::new(scope, name).unwrap();
    if let Some(v) = bs.get(scope, key.into()) {
        if let Ok(f) = <v8::Local<v8::Function>>::try_from(v) {
            slot.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, f)));
        }
    }
}

/// Build an empty `FormData` instance from Rust by calling the cached
/// JS factory `createFormData()`. Used by `Response.formData()` /
/// `Request.formData()`.
pub fn new_instance<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    let factory = CREATE_FORM_DATA.with(|c| c.borrow().clone());
    let Some(factory) = factory else {
        // Only reachable if something throws before `cache_factories`
        // ran — fall back to the public constructor.
        let global = scope.get_current_context().global(scope);
        let key = v8::String::new(scope, "FormData").unwrap();
        let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
        return ctor.new_instance(scope, &[]).unwrap();
    };
    let factory = v8::Local::new(scope, &factory);
    match factory.call(scope, factory.into(), &[]) {
        Some(ret) => {
            if let Ok(obj) = <v8::Local<v8::Object>>::try_from(ret) {
                obj
            } else {
                v8::Object::new(scope)
            }
        }
        None => v8::Object::new(scope),
    }
}

/// Parse `bytes` as `application/x-www-form-urlencoded` and append each
/// `(name, value)` pair to `fd` by calling the cached JS parser
/// `formDataAppendUrlEncoded(fd, bytes)`. Used by
/// `Response.formData()` / `Request.formData()`.
pub fn append_urlencoded(scope: &mut v8::PinScope, fd: v8::Local<v8::Object>, bytes: &[u8]) {
    let factory = APPEND_URLENCODED.with(|c| c.borrow().clone());
    let Some(factory) = factory else { return };
    let factory = v8::Local::new(scope, &factory);
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.to_vec()).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let view = v8::Uint8Array::new(scope, ab, 0, bytes.len()).unwrap();
    let argv: [v8::Local<v8::Value>; 2] = [fd.into(), view.into()];
    let _ = factory.call(scope, factory.into(), &argv);
}

/// Parse `bytes` as `multipart/form-data` with the given `boundary`
/// and append each part to `fd` by calling the cached JS parser
/// `formDataParseMultipart(fd, bytes, boundary)`. Returns `Ok(())` on
/// success or `Err(message)` on a malformed body (the Rust fetch
/// caller then rejects the `formData()` promise with a `TypeError`).
pub fn append_multipart(
    scope: &mut v8::PinScope,
    fd: v8::Local<v8::Object>,
    bytes: &[u8],
    boundary: &str,
) -> Result<(), String> {
    let factory = PARSE_MULTIPART.with(|c| c.borrow().clone());
    let Some(factory) = factory else {
        return Err("multipart parser not available".to_string());
    };
    let factory = v8::Local::new(scope, &factory);
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.to_vec()).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let view = v8::Uint8Array::new(scope, ab, 0, bytes.len()).unwrap();
    let boundary_str = v8::String::new(scope, boundary).unwrap();
    let argv: [v8::Local<v8::Value>; 3] = [fd.into(), view.into(), boundary_str.into()];
    let Some(ret) = factory.call(scope, factory.into(), &argv) else {
        return Err("multipart parser threw".to_string());
    };
    if ret.is_null() {
        Ok(())
    } else {
        Err(ret.to_rust_string_lossy(scope))
    }
}