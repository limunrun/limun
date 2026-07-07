//! Unhandled promise rejection reporting — matches Node/Deno/browser devtools:
//! print `Uncaught (in promise) <value>` to stderr and treat it as a failure,
//! instead of V8's default of silently doing nothing.
//!
//! V8 tells us about this via `PromiseRejectCallback`, which fires for four
//! event kinds; we only need the pair that tracks "does this rejection
//! currently have a handler": `PromiseRejectWithNoHandler` marks a promise
//! as unhandled, `PromiseHandlerAddedAfterReject` un-marks it if a `.catch()`
//! gets attached later in the same tick (a common pattern: reject, then
//! synchronously chain `.catch` right after). Whatever's still marked once
//! the event loop goes idle gets reported.

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static PENDING: RefCell<HashMap<i32, v8::Global<v8::Value>>> = RefCell::new(HashMap::new());
}

/// Wire the callback up. Call once, right after isolate creation.
pub fn install(isolate: &mut v8::Isolate) {
    isolate.set_promise_reject_callback(on_promise_reject);
}

extern "C" fn on_promise_reject(msg: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe scope, &msg);
    let id = msg.get_promise().get_identity_hash().get();

    match msg.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let Some(value) = msg.get_value() else { return };
            let value = v8::Global::new(scope, value);
            PENDING.with(|p| {
                p.borrow_mut().insert(id, value);
            });
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => {
            PENDING.with(|p| {
                p.borrow_mut().remove(&id);
            });
        }
        // Reject/resolve-after-already-settled: spec-legal no-ops, nothing
        // for us to track.
        v8::PromiseRejectEvent::PromiseRejectAfterResolved
        | v8::PromiseRejectEvent::PromiseResolveAfterResolved => {}
    }
}

/// Report anything still unhandled once the loop's gone idle. Returns
/// `true` if at least one was reported (caller should treat as failure).
pub fn report_unhandled(scope: &mut v8::PinScope) -> bool {
    let pending: Vec<v8::Global<v8::Value>> =
        PENDING.with(|p| p.borrow_mut().drain().map(|(_, v)| v).collect());
    let any = !pending.is_empty();

    for value in pending {
        let local = v8::Local::new(scope, &value);
        let text = local
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "<unprintable rejection>".to_string());
        eprintln!("limun: Uncaught (in promise) {text}");
    }

    any
}

/// Drop pending rejection values. Must run before the isolate is torn down —
/// `v8::Global` handles here must not outlive it.
pub fn clear_all() {
    PENDING.with(|p| p.borrow_mut().clear());
}
