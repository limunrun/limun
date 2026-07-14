//! External references table for V8 startup snapshots.
//!
//! V8 snapshots cannot serialize raw C++ function pointers. Every native
//! callback installed on the context (`__limunOps` and `Limun` functions) must
//! be registered as an external reference so V8 can resolve the callback
//! address when the snapshot is loaded in a fresh process.

/// Return the full external-reference table. The order is deterministic
/// (derived from the op/Limun registration lists), and a null terminator is
/// appended so V8 knows where the table ends. The slice is leaked so it
/// outlives the isolate.
pub fn get() -> &'static [v8::ExternalReference] {
    let mut refs: Vec<v8::ExternalReference> = Vec::new();
    refs.extend(crate::core::ops::external_refs());
    refs.extend(crate::limun::external_refs());
    refs.push(v8::ExternalReference {
        pointer: std::ptr::null_mut(),
    });
    refs.leak()
}
