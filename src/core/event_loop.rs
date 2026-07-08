//! Single-channel bridge event loop.
//!
//! V8 isolate stays single-threaded on the main thread; a multi-thread
//! tokio runtime runs in the background. Tokio task completions ship back
//! to the main thread via a `tokio::sync::mpsc::unbounded_channel` of
//! `TaskResult` (plain-Rust, `Send`) — `v8::Global` is `!Send`, so V8
//! objects never cross threads. The main thread blocks on
//! `blocking_recv()` (safe — it's not a tokio worker) and settles the
//! matching `PromiseResolver` for each result.
//!
//! Three result kinds flow over the channel:
//!   - `Fetch`        — `fetch()` global result → resolve/reject the promise
//!   - `ImportSource` — http(s) dynamic `import()` body → compile+eval+resolve
//!   - `Timer`        — `tokio::time::sleep` elapsed → fire the JS callback
//!
//! Timers are tokio-driven: `schedule` spawns a task that sleeps then sends
//! a `Timer` result back. `setInterval` re-arms from `fire_timer` by
//! spawning a fresh task with a fresh `CancellationToken`. `clear` cancels
//! by dropping the token, which cancels the in-flight sleep.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

use crate::core::bridge::{FetchPayload, TaskResult};
use crate::core::state::PENDING_TASKS;

struct Timer {
    callback: v8::Global<v8::Function>,
    args: Vec<v8::Global<v8::Value>>,
    /// `Some(interval)` for setInterval; re-armed after firing unless cleared.
    repeat: Option<Duration>,
    /// Cancels the in-flight tokio sleep. `None` only briefly between fire
    /// and re-arm. Stored (not read) so dropping the `Timer` — either via
    /// `clear` or `clear_all` — cancels the sleep by dropping the token.
    #[allow(dead_code)]
    cancel: Option<CancellationToken>,
}

thread_local! {
    static TIMERS: RefCell<HashMap<u32, Timer>> = RefCell::new(HashMap::new());
    /// Marks ids cleared *while their own callback was running* (removed
    /// from TIMERS already, so `clear` has nothing to remove there).
    static CANCELLED: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    static NEXT_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
    /// Bridge receiver, installed once from `main.rs` before `core::execute`.
    static BRIDGE_RX: RefCell<Option<UnboundedReceiver<TaskResult>>> = const { RefCell::new(None) };
}

/// Install the bridge receiver. Called once from `main.rs` before the V8
/// isolate is created.
pub fn set_bridge_rx(rx: UnboundedReceiver<TaskResult>) {
    BRIDGE_RX.with(|cell| *cell.borrow_mut() = Some(rx));
}

/// Schedule `callback` to run after `delay_ms`. `repeat` = true re-arms it
/// every `delay_ms` (setInterval); false runs it once (setTimeout).
/// Returns the timer handle (what `clearTimeout`/`clearInterval` take).
pub fn schedule(
    callback: v8::Global<v8::Function>,
    args: Vec<v8::Global<v8::Value>>,
    delay_ms: f64,
    repeat: bool,
) -> u32 {
    let delay = Duration::from_secs_f64(delay_ms.max(0.0) / 1000.0);
    let id = NEXT_ID.with(|c| {
        let id = c.get();
        c.set(id.wrapping_add(1).max(1));
        id
    });
    let cancel = CancellationToken::new();
    let timer = Timer {
        callback,
        args,
        repeat: repeat.then_some(delay),
        cancel: Some(cancel.clone()),
    };
    TIMERS.with(|t| t.borrow_mut().insert(id, timer));
    spawn_timer_sleep(id, delay, cancel);
    id
}

/// Spawn the tokio sleep that will fire this timer. Separate from
/// `schedule` so the interval re-arm path can call it without allocating
/// a fresh `Timer` struct.
fn spawn_timer_sleep(timer_id: u32, delay: Duration, cancel: CancellationToken) {
    let tx = crate::core::runtime::tx().clone();
    crate::core::runtime::handle().spawn(async move {
        tokio::select! {
            _ = cancel.cancelled() => {}
            _ = tokio::time::sleep(delay) => {
                let _ = tx.send(TaskResult::Timer { timer_id });
            }
        }
    });
}

/// `clearTimeout`/`clearInterval`: cancel a scheduled (or currently-firing,
/// self-cancelling) timer. No-op on unknown ids, matches spec.
pub fn clear(id: u32) {
    let removed = TIMERS.with(|t| t.borrow_mut().remove(&id).is_some());
    if !removed {
        // Either unknown, or it's the timer currently invoking this very
        // call (we remove-before-call, see `fire_timer`) — mark it so
        // `fire_timer` doesn't re-arm it after the callback returns.
        CANCELLED.with(|c| {
            c.borrow_mut().insert(id);
        });
    }
}

/// Drive the loop: block on the bridge channel, dispatch each result,
/// drain microtasks after each dispatch. Exits when both `PENDING_TASKS`
/// and `TIMERS` are empty (nothing left to wait for). Call once, after the
/// entry module's top-level evaluation.
pub fn run(scope: &mut v8::PinScope) {
    // Flush whatever top-level evaluation already queued (e.g. a resolved
    // promise chain that never needed a timer or fetch).
    scope.perform_microtask_checkpoint();

    loop {
        // Idle check: nothing pending, nothing scheduled → done.
        let pending = PENDING_TASKS.with(|p| p.borrow().len());
        let timers = TIMERS.with(|t| t.borrow().len());
        if pending == 0 && timers == 0 {
            break;
        }

        // Block until a tokio task completes. Safe — the V8 main thread is
        // not a tokio worker, so `blocking_recv` won't panic.
        let Some(result) = BRIDGE_RX.with(|cell| {
            cell.borrow_mut().as_mut().and_then(|rx| rx.blocking_recv())
        }) else {
            // Channel closed (runtime shutting down) — nothing more to do.
            break;
        };

        match result {
            TaskResult::Fetch { task_id, result } => resolve_fetch(scope, task_id, result),
            TaskResult::ImportSource { task_id, url, kind, result } => {
                resolve_import(scope, task_id, url, kind, result)
            }
            TaskResult::Timer { timer_id } => fire_timer(scope, timer_id),
        }

        // Give V8 a chance to run whatever the callback (or its Promise
        // resolutions) queued — including `await` resumptions. Wrap in a
        // tc_scope so a thrown callback doesn't crash the loop: catch +
        // report + clear pending exception before the checkpoint.
        v8::tc_scope!(let tc, scope);
        tc.perform_microtask_checkpoint();
        if tc.has_caught() {
            let msg = crate::core::exception::exception_text(tc);
            eprintln!("limun: event loop: {msg}");
            tc.reset();
        }
    }
}

/// `TaskResult::Fetch` handler: settle the pending `PromiseResolver`.
fn resolve_fetch(scope: &mut v8::PinScope, task_id: u64, result: Result<FetchPayload, String>) {
    let Some(task) = PENDING_TASKS.with(|p| p.borrow_mut().remove(&task_id)) else {
        return;
    };
    let resolver = v8::Local::new(scope, &task.resolver);
    match result {
        Ok(payload) => {
            let instance = crate::web::fetch::response::new_instance(
                scope,
                payload.status,
                payload.status_text,
                payload.headers,
                payload.body,
                payload.original_url,
                payload.final_url,
                "basic",
                true,
            );
            let _ = resolver.resolve(scope, instance.into());
        }
        Err(message) => {
            let msg = v8::String::new(scope, &format!("fetch failed: {message}")).unwrap();
            let exception = v8::Exception::type_error(scope, msg);
            let _ = resolver.reject(scope, exception);
        }
    }
}

/// `TaskResult::ImportSource` handler: compile+instantiate+evaluate the
/// fetched source, then settle the pending `PromiseResolver`.
fn resolve_import(
    scope: &mut v8::PinScope,
    task_id: u64,
    url: url::Url,
    kind: crate::core::module::ModuleKind,
    result: Result<String, String>,
) {
    let Some(task) = PENDING_TASKS.with(|p| p.borrow_mut().remove(&task_id)) else {
        return;
    };
    let resolver = v8::Local::new(scope, &task.resolver);
    match result {
        Ok(source_text) => {
            match crate::core::module::finish_dynamic_import_from_source(
                scope, &url, kind, &source_text,
            ) {
                Ok(namespace) => {
                    let _ = resolver.resolve(scope, namespace);
                }
                Err(message) => {
                    let msg = v8::String::new(scope, &message).unwrap();
                    let exception = v8::Exception::type_error(scope, msg);
                    let _ = resolver.reject(scope, exception);
                }
            }
        }
        Err(message) => {
            let msg = v8::String::new(scope, &message).unwrap();
            let exception = v8::Exception::type_error(scope, msg);
            let _ = resolver.reject(scope, exception);
        }
    }
}

/// `TaskResult::Timer` handler: invoke the JS callback, re-arm if interval.
fn fire_timer(scope: &mut v8::PinScope, id: u32) {
    // Remove before calling: makes self-cancellation
    // (`clearInterval` from inside its own callback) detectable via
    // CANCELLED, and guards against re-entrant double-firing.
    let Some(timer) = TIMERS.with(|t| t.borrow_mut().remove(&id)) else {
        return; // a prior callback in this batch already cleared it
    };

    let func = v8::Local::new(scope, &timer.callback);
    let receiver = v8::undefined(scope).into();
    let args: Vec<v8::Local<v8::Value>> = timer
        .args
        .iter()
        .map(|a| v8::Local::new(scope, a))
        .collect();
    let _ = func.call(scope, receiver, &args);

    if let Some(interval) = timer.repeat {
        let self_cancelled = CANCELLED.with(|c| c.borrow_mut().remove(&id));
        if !self_cancelled {
            let cancel = CancellationToken::new();
            TIMERS.with(|t| {
                t.borrow_mut().insert(
                    id,
                    Timer {
                        callback: timer.callback,
                        args: timer.args,
                        repeat: Some(interval),
                        cancel: Some(cancel.clone()),
                    },
                );
            });
            spawn_timer_sleep(id, interval, cancel);
        }
    }
}

/// Drop all pending timers + cancel in-flight sleeps. Must run before the
/// isolate is torn down — `v8::Global` handles inside `Timer` must not
/// outlive it. Dropping `CancellationToken` cancels the tokio sleep.
pub fn clear_all() {
    TIMERS.with(|t| t.borrow_mut().clear());
    CANCELLED.with(|c| c.borrow_mut().clear());
}