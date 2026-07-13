//! `DOMException` — Rust bridge for the JS-defined class.
//!
//! Spec logic (the class, getters, legacy constants, brand checking,
//! `Error` inheritance) lives in `ext:limun/01_dom_exception.js`. This
//! file is only the Rust-side bridge: it caches the JS constructor
//! global after the JS module evaluates so Rust callers that need to
//! mint `DOMException` instances (`throw_dom_exception`, `AbortSignal`'s
//! default abort reason) can do so without re-entering JS to look up
//! `globalThis.DOMException` every time.
//!
//! `cache_ctor` is called from `core::mod::execute` after the internal JS
//! bootstrap loop (the module installs `DOMException` on `globalThis` and
//! `cache_ctor` stashes a `v8::Global` to it). Before that runs the CTOR
//! thread_local is `None` and `new_instance` falls back to a bare V8
//! `Error` (only reachable if something throws during bootstrap itself).

use std::cell::RefCell;

thread_local! {
    /// Cached constructor so Rust callers (`throw_dom_exception`,
    /// `AbortSignal`) can mint instances without a `globalThis` lookup —
    /// and so a user reassigning `globalThis.DOMException` can't change
    /// what the runtime itself throws. Populated by `cache_ctor` after
    /// `ext:limun/01_dom_exception.js` evaluates.
    static CTOR: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

/// Cache `globalThis.DOMException` into the `CTOR` thread_local. Called
/// from `core::mod::execute` after the internal JS bootstrap loop — the
/// JS module has installed the class on `globalThis` by then. Must run
/// before any Rust caller can `throw_dom_exception`.
pub fn cache_ctor(scope: &mut v8::PinScope) {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "DOMException").unwrap();
    let Some(ctor_val) = global.get(scope, key.into()) else {
        return;
    };
    let Ok(ctor) = <v8::Local<v8::Function>>::try_from(ctor_val) else {
        return;
    };
    CTOR.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, ctor)));
}

/// Build a `DOMException` from Rust by calling the cached JS constructor.
/// Used by `throw_dom_exception` and (previously) by `AbortSignal` (whose
/// default abort reason is now minted in JS). Returns a bare V8 `Error`
/// if the constructor isn't cached yet (only reachable if something
/// throws before `cache_ctor` ran).
#[allow(dead_code)]
pub fn new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    message: &str,
) -> v8::Local<'s, v8::Value> {
    let ctor = CTOR.with(|c| c.borrow().clone());
    let Some(ctor) = ctor else {
        // Only reachable if something throws before `cache_ctor` ran.
        let msg = v8::String::new(scope, message).unwrap();
        return v8::Exception::error(scope, msg);
    };
    let ctor = v8::Local::new(scope, &ctor);
    let msg = v8::String::new(scope, message).unwrap();
    let nm = v8::String::new(scope, name).unwrap();
    match ctor.new_instance(scope, &[msg.into(), nm.into()]) {
        Some(instance) => instance.into(),
        None => {
            let msg = v8::String::new(scope, message).unwrap();
            v8::Exception::error(scope, msg)
        }
    }
}