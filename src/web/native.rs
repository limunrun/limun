//! Shared helper for stashing native Rust state inside a V8 object's
//! internal field (used by every real constructible class with per-instance
//! state — `URL`, `URLSearchParams`, `Headers`, `TextDecoder`, `Response`,
//! `Request`, `Blob`, `FormData`, `ReadableStream`, `Event`, `EventTarget`,
//! `AbortSignal`, …).
//!
//! # Type-tagged storage (brand safety)
//! Every stored value is boxed inside a `#[repr(C)]` `NativeCell<T>` whose
//! first field is `TypeId::of::<T>()`. The `v8::External` in the internal
//! field points at that cell. Because the tag is at offset 0 for *every*
//! cell regardless of `T`, [`is`] can read the tag out of an arbitrary
//! foreign object's field and compare it without knowing `T` up front —
//! which is what makes cross-class brand checks (`is_blob_instance`,
//! `is_request_instance`, …) sound. Two different native classes both
//! storing an `External` in field 0 (e.g. `URL` and `Response`) no longer
//! alias: their tags differ, so `is::<UrlInternal>` is false for a
//! `Response` and [`get`] refuses to reinterpret one as the other.
//!
//! # Lifetime
//! `store` registers a guaranteed GC finalizer via
//! `v8::Weak::with_guaranteed_finalizer`; when the wrapping JS object is
//! collected the finalizer frees the box. The `Weak` must outlive the JS
//! object (dropping it early cancels the finalizer), so it is parked in the
//! thread-local `WEAK_HANDLES` vec in `core::state`. At isolate teardown
//! that vec is dropped: for any object still alive, dropping its `Weak`
//! *cancels* the (still-pending) finalizer rather than running it — so those
//! boxes leak once, at process exit, where the OS reclaims them anyway.
//! Everything collected before teardown is freed promptly.

use std::any::TypeId;
use std::os::raw::c_void;

use crate::core::state::WEAK_HANDLES;

/// Heap layout for stored native state: a type tag followed by the value.
/// `#[repr(C)]` guarantees `tag` sits at offset 0 for every `T`, so the tag
/// can be read back through a type-erased pointer (see [`is`]).
#[repr(C)]
struct NativeCell<T> {
    tag: TypeId,
    value: T,
}

/// Box `value` (tagged with its `TypeId`) and store it as a `v8::External`
/// in `obj`'s internal field `index`, registering a GC finalizer that frees
/// the box when `obj` is collected. `obj`'s template must have been created
/// with `set_internal_field_count(index + 1)` (or more).
pub fn store<T: 'static>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, index: usize, value: T) {
    let ptr = Box::into_raw(Box::new(NativeCell {
        tag: TypeId::of::<T>(),
        value,
    }));
    let external = v8::External::new(scope, ptr as *mut c_void);
    let ok = obj.set_internal_field(index, external.into());
    assert!(
        ok,
        "internal field {index} out of bounds — object template needs set_internal_field_count"
    );

    // Guaranteed finalizer: runs when `obj` is GC'd (or is cancelled at
    // isolate teardown — see module docs). Frees the boxed cell exactly once.
    let obj_value: v8::Local<v8::Value> = obj.into();
    let weak = v8::Weak::with_guaranteed_finalizer(
        scope,
        obj_value,
        Box::new(move || {
            let _ = unsafe { Box::from_raw(ptr) };
        }),
    );
    WEAK_HANDLES.with(|w| w.borrow_mut().push(weak));
}

/// Read the `TypeId` tag out of the `External` at `obj`'s internal field
/// `index`, if present. Type-erased: works on any object without knowing
/// the stored `T`, because the tag is always at offset 0 of `NativeCell`.
fn read_tag(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, index: usize) -> Option<TypeId> {
    if obj.internal_field_count() <= index {
        return None;
    }
    let field = obj.get_internal_field(scope, index)?;
    let external: v8::Local<v8::External> = field.try_into().ok()?;
    let ptr = external.value();
    if ptr.is_null() {
        return None;
    }
    // SAFETY: every External stored in an internal field points at a
    // `NativeCell<_>` whose first field (offset 0, `#[repr(C)]`) is a
    // `TypeId`. The pointer is aligned for its cell (hence for `TypeId`).
    Some(unsafe { *(ptr as *const TypeId) })
}

/// `true` iff `obj`'s internal field `index` holds native state of type `T`.
/// Sound to call on *any* object (foreign or of another native class) — the
/// tag comparison distinguishes classes that would otherwise both look like
/// "an object with an External in field N".
pub fn is<T: 'static>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, index: usize) -> bool {
    read_tag(scope, obj, index) == Some(TypeId::of::<T>())
}

/// Read back a reference to state previously stashed with `store` at the
/// same `index`. Returns `None` if the field is empty or holds a *different*
/// type than `T` (brand mismatch) — callers that already brand-checked can
/// `unwrap`/`expect`; callers handed arbitrary objects should match on it.
pub fn get_opt<'a, T: 'static>(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    index: usize,
) -> Option<&'a T> {
    if read_tag(scope, obj, index) != Some(TypeId::of::<T>()) {
        return None;
    }
    let field = obj.get_internal_field(scope, index)?;
    let external: v8::Local<v8::External> = field.try_into().ok()?;
    let cell = external.value() as *const NativeCell<T>;
    // SAFETY: tag matched `T`, so the cell really is a `NativeCell<T>`; the
    // box lives as long as the JS object (single-threaded runtime).
    Some(unsafe { &(*cell).value })
}

/// Read back a reference to state stashed with `store` at `index`.
///
/// # Panics
/// If the field is empty or holds a different type than `T`. Use on `this`/
/// `holder` inside a class's own methods (where the type is guaranteed);
/// use [`get_opt`]/[`is`] for values that might be foreign objects.
pub fn get<'a, T: 'static>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, index: usize) -> &'a T {
    get_opt(scope, obj, index)
        .expect("internal field missing or holds a different native type than expected")
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
