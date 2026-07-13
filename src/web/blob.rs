//! `Blob`/`File` — Rust bridge for the JS-defined classes.
//!
//! Spec logic (the `Blob`/`File` classes, getters, methods, brand
//! checks, `BlobPart`/`BlobPropertyBag` conversion, `slice`/`text`/
//! `arrayBuffer`/`stream`, `File` name/lastModified) lives in
//! `ext:limun/09_blob.js`. This file is only the Rust-side bridge: it
//! caches the JS factory functions `globalThis.__bootstrap.createBlob`
//! and `globalThis.__bootstrap.createFile` after the JS module evaluates
//! so Rust callers that need to mint `Blob`/`File` instances
//! (`Response.blob()`, `Request.blob()`, and the FormData multipart
//! parser) can do so without re-entering JS to look up the factory every
//! time.
//!
//! `cache_factories` is called from `core::mod::execute` after the
//! internal JS bootstrap loop (the module installs the factories on
//! `globalThis.__bootstrap` and `cache_factories` stashes `v8::Global`s
//! to them). Before that runs the `CREATE_BLOB`/`CREATE_FILE`
//! thread_locals are `None` and `new_blob_instance`/`new_file_instance`
//! fall back to constructing through the public `globalThis.Blob`/
//! `globalThis.File` constructor (only reachable if something throws
//! during bootstrap itself).

use std::cell::RefCell;

thread_local! {
    /// Cached `globalThis.__bootstrap.createBlob`. Populated by
    /// `cache_factories` after `ext:limun/09_blob.js` evaluates. Rust
    /// callers (`Response.blob()`, `Request.blob()`) mint `Blob`
    /// instances through it.
    static CREATE_BLOB: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
    /// Cached `globalThis.__bootstrap.createFile`. Populated by
    /// `cache_factories` after `ext:limun/09_blob.js` evaluates. Rust
    /// callers (the FormData multipart parser, the previous
    /// `form_data.rs` bridge) mint `File` instances through it.
    static CREATE_FILE: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

/// Cache `globalThis.__bootstrap.createBlob` / `createFile` into the
/// thread_locals. Called from `core::mod::execute` after the internal
/// JS bootstrap loop — the JS module has installed the factories on
/// `globalThis.__bootstrap` by then. Must run before any Rust caller
/// can `new_blob_instance` / `new_file_instance`.
pub fn cache_factories(scope: &mut v8::PinScope) {
    let global = scope.get_current_context().global(scope);
    let bs_key = v8::String::new(scope, "__bootstrap").unwrap();
    let Some(bs_val) = global.get(scope, bs_key.into()) else {
        return;
    };
    let Ok(bs) = <v8::Local<v8::Object>>::try_from(bs_val) else {
        return;
    };

    let key = v8::String::new(scope, "createBlob").unwrap();
    if let Some(v) = bs.get(scope, key.into()) {
        if let Ok(f) = <v8::Local<v8::Function>>::try_from(v) {
            CREATE_BLOB.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, f)));
        }
    }

    let key = v8::String::new(scope, "createFile").unwrap();
    if let Some(v) = bs.get(scope, key.into()) {
        if let Ok(f) = <v8::Local<v8::Function>>::try_from(v) {
            CREATE_FILE.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, f)));
        }
    }
}

/// Build a `Blob` instance from Rust by calling the cached JS factory
/// `createBlob(bytes, type)`. `bytes` is moved into a fresh
/// `ArrayBuffer`-backed `Uint8Array` (the factory takes ownership via a
/// byte read; the backing store keeps the bytes alive until the Blob is
/// GC'd). Used by `Response.blob()` / `Request.blob()` where a Blob
/// must be minted without going through the JS constructor's
/// `BlobPart[]` parsing.
pub fn new_blob_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: Vec<u8>,
    type_: String,
) -> v8::Local<'s, v8::Object> {
    let factory = CREATE_BLOB.with(|c| c.borrow().clone());
    let Some(factory) = factory else {
        // Only reachable if something throws before `cache_factories`
        // ran — fall back to the public constructor.
        return new_via_ctor(scope, "Blob", &bytes, Some(&type_), None, None);
    };
    let factory = v8::Local::new(scope, &factory);
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
    let type_str = v8::String::new(scope, &type_).unwrap();
    let argv: [v8::Local<v8::Value>; 2] = [view.into(), type_str.into()];
    match factory.call(scope, factory.into(), &argv) {
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

/// Build a `File` instance from Rust by calling the cached JS factory
/// `createFile(bytes, type, name, lastModified)`. Used by any future
/// Rust caller that needs a `File` (currently none — the FormData
/// multipart parser moved to JS in `10_form_data.js`). Retained for
/// symmetry with `new_blob_instance` and the previous Rust surface.
#[allow(dead_code)]
pub fn new_file_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: Vec<u8>,
    type_: String,
    name: String,
    last_modified: f64,
) -> v8::Local<'s, v8::Object> {
    let factory = CREATE_FILE.with(|c| c.borrow().clone());
    let Some(factory) = factory else {
        return new_via_ctor(scope, "File", &bytes, Some(&type_), Some(&name), Some(last_modified));
    };
    let factory = v8::Local::new(scope, &factory);
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
    let type_str = v8::String::new(scope, &type_).unwrap();
    let name_str = v8::String::new(scope, &name).unwrap();
    let lm = v8::Number::new(scope, last_modified);
    let argv: [v8::Local<v8::Value>; 4] = [view.into(), type_str.into(), name_str.into(), lm.into()];
    match factory.call(scope, factory.into(), &argv) {
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

/// Bootstrap-time fallback: construct via the public `globalThis.<Name>`
/// constructor (used only if the cached factory is missing — i.e. a
/// bootstrap throw before `cache_factories` ran). Builds a
/// `Uint8Array`-from-bytes argument and an options object so the
/// constructor's normal `BlobPart[]`/options parsing produces a Blob
/// with the right bytes/type. For `File`, passes `name` as the second
/// arg and `lastModified` in the options.
fn new_via_ctor<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    class_name: &str,
    bytes: &[u8],
    type_: Option<&str>,
    name: Option<&str>,
    last_modified: Option<f64>,
) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, class_name).unwrap();
    let ctor: v8::Local<v8::Function> = global
        .get(scope, key.into())
        .unwrap()
        .try_into()
        .unwrap();
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.to_vec()).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
    let parts = v8::Array::new_with_elements(scope, &[view.into()]);

    let opts = v8::Object::new(scope);
    if let Some(t) = type_ {
        let k = v8::String::new(scope, "type").unwrap();
        let v = v8::String::new(scope, t).unwrap();
        opts.set(scope, k.into(), v.into());
    }

    let argv: Vec<v8::Local<v8::Value>> = if let Some(n) = name {
        let n_str = v8::String::new(scope, n).unwrap();
        if let Some(lm) = last_modified {
            let k = v8::String::new(scope, "lastModified").unwrap();
            let v = v8::Number::new(scope, lm);
            opts.set(scope, k.into(), v.into());
        }
        vec![parts.into(), n_str.into(), opts.into()]
    } else {
        vec![parts.into(), opts.into()]
    };

    ctor.new_instance(scope, &argv).unwrap()
}