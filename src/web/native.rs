//! Shared helper for stashing native Rust state inside a V8 object's
//! internal field (used by `TextDecoder`, `URL`, `URLSearchParams` — real
//! constructible classes with per-instance state, as opposed to a plain
//! namespace object like `console`).
//!
//! Known simplification: the boxed state is intentionally leaked
//! (`Box::into_raw`, never freed via `Box::from_raw`) — there's no
//! `SetWeak`/GC-finalization wiring yet. Fine for this runtime's current
//! shape (a single script run to completion, then the whole process
//! exits and the OS reclaims everything); would need real finalizers
//! before this becomes a long-running server/worker runtime.

use std::os::raw::c_void;

/// Box `value` and store it (as a `v8::External`) in `obj`'s internal
/// field `index`. `obj`'s template must have been created with
/// `set_internal_field_count(index + 1)` (or more).
pub fn store<T>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, index: usize, value: T) {
    let ptr = Box::into_raw(Box::new(value)) as *mut c_void;
    let external = v8::External::new(scope, ptr);
    let ok = obj.set_internal_field(index, external.into());
    assert!(
        ok,
        "internal field {index} out of bounds — object template needs set_internal_field_count"
    );
}

/// Read back a reference to state previously stashed with `store` at the
/// same `index`. Aliases the boxed value in place — does not take
/// ownership or clone it.
///
/// # Panics
/// If `obj` doesn't have a `v8::External` in that internal field (i.e.
/// `store` was never called on it with this `index`).
pub fn get<'a, T>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, index: usize) -> &'a T {
    let field = obj
        .get_internal_field(scope, index)
        .expect("missing internal field");
    let external: v8::Local<v8::External> = field.try_into().expect("internal field is not External");
    let ptr = external.value() as *const T;
    unsafe { &*ptr }
}

/// Read raw bytes out of a JS value that's an `ArrayBufferView`
/// (`Uint8Array`, etc.) or a plain `ArrayBuffer`. Used wherever a
/// `BufferSource` is spec-legal (`TextDecoder.decode`, fetch bodies, ...).
pub fn read_buffer_source(value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    if let Ok(view) = <v8::Local<v8::ArrayBufferView>>::try_from(value) {
        let mut bytes = vec![0u8; view.byte_length()];
        view.copy_contents(&mut bytes);
        return Some(bytes);
    }
    if let Ok(ab) = <v8::Local<v8::ArrayBuffer>>::try_from(value) {
        let len = ab.byte_length();
        let data = ab.data()?;
        return Some(unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, len) }.to_vec());
    }
    None
}

/// Get a real `Array Iterator` for `array` by invoking its own
/// `[Symbol.iterator]()` — reuses V8's built-in iterator (correct
/// `{value, done}`/`.next()` shape for free) instead of hand-rolling one.
/// Used by `URLSearchParams`/`Headers`'s `entries`/`keys`/`values`.
pub fn array_iterator<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    array: v8::Local<'s, v8::Array>,
) -> v8::Local<'s, v8::Value> {
    let sym = v8::Symbol::get_iterator(scope);
    let iter_fn: v8::Local<v8::Function> = array.get(scope, sym.into()).unwrap().try_into().unwrap();
    iter_fn.call(scope, array.into(), &[]).unwrap()
}
