//! `ReadableStream` — Rust bridge for the JS-defined class.
//!
//! Spec logic (the `ReadableStream` / `ReadableStreamDefaultReader` /
//! `ReadableStreamDefaultController` classes, the stream state machine,
//! queue, read requests, lock, cancel, async iteration) lives in
//! `ext:limun/06_streams.js`. This file is only the Rust-side bridge: it
//! caches the JS factory `globalThis.__bootstrap.createFixedReadableStream`
//! after the JS module evaluates so Rust callers that need to mint
//! `ReadableStream` instances (`Response.body`, `Request.body`,
//! `Blob.stream()`) can do so without re-entering JS to look up the
//! factory every time.
//!
//! `cache_factory` is called from `core::mod::execute` after the
//! internal JS bootstrap loop (the module installs the factory on
//! `globalThis.__bootstrap` and `cache_factory` stashes a `v8::Global` to
//! it). Before that runs the FACTORY thread_local is `None` and
//! `new_fixed_stream` falls back to a bare `v8::undefined` (only
//! reachable if something throws during bootstrap itself).

use std::cell::RefCell;

thread_local! {
    /// Cached `globalThis.__bootstrap.createFixedReadableStream`. Populated
    /// by `cache_factory` after `ext:limun/06_streams.js` evaluates. Rust
    /// callers (`blob::stream`, `fetch::response::get_body`,
    /// `fetch::request::get_body`) mint fixed (fully-buffered) streams
    /// through it.
    static FACTORY: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

/// Cache `globalThis.__bootstrap.createFixedReadableStream` into the
/// `FACTORY` thread_local. Called from `core::mod::execute` after the
/// internal JS bootstrap loop — the JS module has installed the factory
/// on `globalThis.__bootstrap` by then. Must run before any Rust caller
/// can `new_fixed_stream`.
pub fn cache_factory(scope: &mut v8::PinScope) {
    let global = scope.get_current_context().global(scope);
    let bs_key = v8::String::new(scope, "__bootstrap").unwrap();
    let Some(bs_val) = global.get(scope, bs_key.into()) else {
        return;
    };
    let Ok(bs) = <v8::Local<v8::Object>>::try_from(bs_val) else {
        return;
    };
    let key = v8::String::new(scope, "createFixedReadableStream").unwrap();
    let Some(factory_val) = bs.get(scope, key.into()) else {
        return;
    };
    let Ok(factory) = <v8::Local<v8::Function>>::try_from(factory_val) else {
        return;
    };
    FACTORY.with(|f| *f.borrow_mut() = Some(v8::Global::new(scope, factory)));
}

/// Build a fixed `ReadableStream` from Rust by calling the cached JS
/// factory `createFixedReadableStream(chunks)`. The stream's chunks are
/// pre-populated and the stream is already closed (the body is fully
/// buffered) — used by `Response.body` / `Request.body` / `Blob.stream()`.
/// Empty chunks are dropped by the factory (an empty body reads as
/// `{ done: true }` straight away, matching browsers).
///
/// Returns a bare `v8::undefined` (wrapped as an object) if the factory
/// isn't cached yet (only reachable if something throws before
/// `cache_factory` ran).
pub fn new_fixed_stream<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    chunks: Vec<Vec<u8>>,
) -> v8::Local<'s, v8::Object> {
    let factory = FACTORY.with(|f| f.borrow().clone());
    let Some(factory) = factory else {
        // Only reachable if something throws before `cache_factory` ran.
        return v8::Object::new(scope);
    };
    let factory = v8::Local::new(scope, &factory);

    // Build the `Uint8Array[]` argument: one `Uint8Array` per chunk,
    // backed by a fresh `ArrayBuffer` (the factory takes ownership via
    // `byteLength` reads; the backing store keeps the bytes alive until
    // the stream is drained).
    let arr = v8::Array::new(scope, chunks.len() as i32);
    for (i, bytes) in chunks.into_iter().enumerate() {
        let len = bytes.len();
        let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
        let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
        let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
        arr.set_index(scope, i as u32, view.into());
    }

    let argv: [v8::Local<v8::Value>; 1] = [arr.into()];
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