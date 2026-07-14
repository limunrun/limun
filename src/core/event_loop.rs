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
//! Timers use a single background tokio task that manages a `BinaryHeap`
//! of (deadline, sequence, timer_id) entries. This ensures timers with
//! the same deadline fire in creation order (FIFO) — tokio's individual
//! `time::sleep` does not guarantee ordering across independent sleeps.
//! `setInterval` re-arms from `fire_timer` by pushing a new entry.
//! `clear` cancels by dropping the token, which the background task
//! checks via the cancelled set.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

use crate::core::bridge::{FetchPayload, TaskResult, WsCreateResult, WsEventResult};
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

/// Commands sent to the timer background task.
enum TimerCmd {
    /// Schedule a timer: (timer_id, delay, sequence, cancel_token)
    Schedule(u32, Duration, u64, CancellationToken),
    /// Cancel a timer: timer_id
    Cancel(u32),
}

thread_local! {
    static TIMERS: RefCell<HashMap<u32, Timer>> = RefCell::new(HashMap::new());
    /// Marks ids cleared *while their own callback was running* (removed
    /// from TIMERS already, so `clear` has nothing to remove there).
    static CANCELLED: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    static NEXT_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
    /// Bridge receiver, installed once from `main.rs` before `core::execute`.
    static BRIDGE_RX: RefCell<Option<UnboundedReceiver<TaskResult>>> = const { RefCell::new(None) };
    /// Sender for timer commands (schedule/cancel). Installed once.
    static TIMER_TX: RefCell<Option<tokio::sync::mpsc::UnboundedSender<TimerCmd>>> = const { RefCell::new(None) };
    /// Monotonic sequence counter for timer creation order (FIFO tiebreak).
    static TIMER_SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Install the timer command sender. Called once from `main.rs`.
pub fn init_timer_channel() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<TimerCmd>();
    TIMER_TX.with(|cell| *cell.borrow_mut() = Some(tx));
    // Spawn the timer scheduler background task.
    crate::core::runtime::handle().spawn(async move {
        use std::collections::BinaryHeap;
        use tokio::time::{Instant, sleep_until};

        /// A pending timer entry in the heap. Ordered by (deadline, sequence)
        /// so the earliest-deadline timer fires first, and ties broken by
        /// creation order (FIFO).
        struct Pending {
            deadline: Instant,
            seq: u64,
            timer_id: u32,
            cancel: CancellationToken,
        }
        impl PartialEq for Pending {
            fn eq(&self, o: &Self) -> bool { self.deadline == o.deadline && self.seq == o.seq }
        }
        impl Eq for Pending {}
        impl PartialOrd for Pending {
            fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
                Some(self.cmp(o))
            }
        }
        impl Ord for Pending {
            fn cmp(&self, o: &Self) -> std::cmp::Ordering {
                // BinaryHeap is max-heap; we want min-heap, so reverse.
                // Compare by (deadline, seq) — earliest first.
                o.deadline.cmp(&self.deadline).then(o.seq.cmp(&self.seq))
            }
        }

        let mut heap: BinaryHeap<Pending> = BinaryHeap::new();
        let mut cancelled: HashSet<u32> = HashSet::new();

        loop {
            if let Some(p) = heap.peek() {
                let sleep = sleep_until(p.deadline);
                tokio::select! {
                    cmd = rx.recv() => {
                        match cmd {
                            Some(TimerCmd::Schedule(id, delay, seq, cancel)) => {
                                let deadline = Instant::now() + delay;
                                heap.push(Pending { deadline, seq, timer_id: id, cancel });
                            }
                            Some(TimerCmd::Cancel(id)) => {
                                cancelled.insert(id);
                            }
                            None => break,
                        }
                    }
                    _ = sleep => {
                        // The earliest timer's deadline has passed.
                        while let Some(entry) = heap.peek() {
                            if entry.deadline > Instant::now() {
                                break;
                            }
                            let entry = heap.pop().unwrap();
                            // Check if cancelled (via TimerCmd::Cancel).
                            if cancelled.remove(&entry.timer_id) {
                                continue;
                            }
                            if entry.cancel.is_cancelled() {
                                continue;
                            }
                            let tx = crate::core::runtime::tx().clone();
                            let _ = tx.send(TaskResult::Timer { timer_id: entry.timer_id });
                        }
                    }
                }
            } else {
                // No timers: just wait for a command.
                match rx.recv().await {
                    Some(TimerCmd::Schedule(id, delay, seq, cancel)) => {
                        let deadline = Instant::now() + delay;
                        heap.push(Pending { deadline, seq, timer_id: id, cancel });
                    }
                    Some(TimerCmd::Cancel(id)) => {
                        cancelled.insert(id);
                    }
                    None => break,
                }
            }
        }
    });
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
    let seq = TIMER_SEQ.with(|c| {
        let s = c.get();
        c.set(s.wrapping_add(1));
        s
    });
    let cancel = CancellationToken::new();
    let timer = Timer {
        callback,
        args,
        repeat: repeat.then_some(delay),
        cancel: Some(cancel.clone()),
    };
    TIMERS.with(|t| t.borrow_mut().insert(id, timer));
    TIMER_TX.with(|tx| {
        if let Some(tx) = tx.borrow().as_ref() {
            let _ = tx.send(TimerCmd::Schedule(id, delay, seq, cancel));
        }
    });
    id
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
    // Notify the background task to skip this timer if it hasn't fired yet.
    TIMER_TX.with(|tx| {
        if let Some(tx) = tx.borrow().as_ref() {
            let _ = tx.send(TimerCmd::Cancel(id));
        }
    });
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
            TaskResult::WsCreate { task_id, rid, result } => {
                resolve_ws_create(scope, task_id, rid, result)
            }
            TaskResult::WsEvent { task_id, rid, result } => {
                resolve_ws_event(scope, task_id, rid, result)
            }
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
///
/// On success, builds a *flat* plain `v8::Object` — own properties
/// `status` (number), `statusText` (string), `headers` (an `Array` of
/// `[name, value]` string pairs), `body` (`Uint8Array`), `url` (string,
/// the final URL after redirects), `redirected` (bool) — and resolves
/// the op's promise with it. `ext:limun/23_fetch.js`'s `fetch()`
/// continuation constructs the actual `Response` from this; no Rust
/// `Response` type exists anymore (the class is JS-defined, see
/// `ext:limun/22_response.js`).
fn resolve_fetch(scope: &mut v8::PinScope, task_id: u64, result: Result<FetchPayload, String>) {
    let Some(task) = PENDING_TASKS.with(|p| p.borrow_mut().remove(&task_id)) else {
        return;
    };
    let resolver = v8::Local::new(scope, &task.resolver);
    match result {
        Ok(payload) => {
            let obj = v8::Object::new(scope);

            let status_key = v8::String::new(scope, "status").unwrap();
            let status_val = v8::Number::new(scope, payload.status as f64);
            obj.set(scope, status_key.into(), status_val.into());

            let status_text_key = v8::String::new(scope, "statusText").unwrap();
            let status_text_val = v8::String::new(scope, &payload.status_text).unwrap();
            obj.set(scope, status_text_key.into(), status_text_val.into());

            let headers_key = v8::String::new(scope, "headers").unwrap();
            let pairs: Vec<v8::Local<v8::Value>> = payload
                .headers
                .iter()
                .map(|(k, v)| {
                    let k_str = v8::String::new(scope, k).unwrap();
                    let v_str = v8::String::new(scope, v).unwrap();
                    v8::Array::new_with_elements(scope, &[k_str.into(), v_str.into()]).into()
                })
                .collect();
            let headers_arr = v8::Array::new_with_elements(scope, &pairs);
            obj.set(scope, headers_key.into(), headers_arr.into());

            let body_key = v8::String::new(scope, "body").unwrap();
            let len = payload.body.len();
            let store = v8::ArrayBuffer::new_backing_store_from_vec(payload.body).make_shared();
            let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
            let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
            obj.set(scope, body_key.into(), view.into());

            let url_key = v8::String::new(scope, "url").unwrap();
            let url_val = v8::String::new(scope, &payload.final_url).unwrap();
            obj.set(scope, url_key.into(), url_val.into());

            let redirected_key = v8::String::new(scope, "redirected").unwrap();
            let redirected = payload.original_url != payload.final_url;
            obj.set(scope, redirected_key.into(), v8::Boolean::new(scope, redirected).into());

            let _ = resolver.resolve(scope, obj.into());
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
            let seq = TIMER_SEQ.with(|c| {
                let s = c.get();
                c.set(s.wrapping_add(1));
                s
            });
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
            TIMER_TX.with(|tx| {
                if let Some(tx) = tx.borrow().as_ref() {
                    let _ = tx.send(TimerCmd::Schedule(id, interval, seq, cancel));
                }
            });
        }
    } else {
        // One-shot timer: clean up any stale CANCELLED entry so that a
        // `clearTimeout(id)` call *after* the timer already fired does
        // not leak an entry in CANCELLED forever. `clear()` inserts into
        // CANCELLED when the id isn't in TIMERS (already fired); without
        // this cleanup, long-running processes with a cleanup-always-
        // clears pattern would grow CANCELLED unboundedly.
        CANCELLED.with(|c| {
            c.borrow_mut().remove(&id);
        });
    }
}

/// `TaskResult::WsCreate` handler: settle the pending `PromiseResolver`
/// with a plain object `{ rid, protocol, extensions }` on success, or
/// reject with a TypeError on failure.
fn resolve_ws_create(
    scope: &mut v8::PinScope,
    task_id: u64,
    rid: u32,
    result: Result<WsCreateResult, String>,
) {
    let Some(task) = PENDING_TASKS.with(|p| p.borrow_mut().remove(&task_id)) else {
        return;
    };
    let resolver = v8::Local::new(scope, &task.resolver);
    match result {
        Ok(payload) => {
            let obj = v8::Object::new(scope);

            let rid_key = v8::String::new(scope, "rid").unwrap();
            obj.set(scope, rid_key.into(), v8::Number::new(scope, rid as f64).into());

            let proto_key = v8::String::new(scope, "protocol").unwrap();
            obj.set(scope, proto_key.into(), v8::String::new(scope, &payload.protocol).unwrap().into());

            let ext_key = v8::String::new(scope, "extensions").unwrap();
            obj.set(scope, ext_key.into(), v8::String::new(scope, &payload.extensions).unwrap().into());

            let _ = resolver.resolve(scope, obj.into());
        }
        Err(message) => {
            let msg = v8::String::new(scope, &format!("WebSocket: {message}")).unwrap();
            let exception = v8::Exception::type_error(scope, msg);
            let _ = resolver.reject(scope, exception);
        }
    }
}

/// `TaskResult::WsEvent` handler: settle the pending `PromiseResolver`
/// with the event kind number (0=text, 1=binary, 2=pong, 3=error,
/// >=1000=close code). The actual payload is stashed in the
/// `WS_BUFFERS` thread-local for the JS side to retrieve via
/// `op_ws_get_buffer`/`op_ws_get_buffer_as_string`/`op_ws_get_error`.
fn resolve_ws_event(
    scope: &mut v8::PinScope,
    task_id: u64,
    rid: u32,
    result: WsEventResult,
) {
    let Some(task) = PENDING_TASKS.with(|p| p.borrow_mut().remove(&task_id)) else {
        return;
    };
    let resolver = v8::Local::new(scope, &task.resolver);

    let kind: f64 = match &result {
        WsEventResult::Text(_) => 0.0,
        WsEventResult::Binary(_) => 1.0,
        WsEventResult::Pong => 2.0,
        WsEventResult::Error(_) => 3.0,
        WsEventResult::Close(code, _) => *code as f64,
    };

    match result {
        WsEventResult::Text(text) => {
            crate::web::websocket::stash_buffer(rid, crate::web::websocket::WsBufferKind::Text(text));
        }
        WsEventResult::Binary(data) => {
            crate::web::websocket::stash_buffer(rid, crate::web::websocket::WsBufferKind::Binary(data));
        }
        WsEventResult::Error(msg) => {
            crate::web::websocket::stash_buffer(rid, crate::web::websocket::WsBufferKind::Error(msg));
        }
        WsEventResult::Close(code, reason) => {
            if code != 1005 && !reason.is_empty() {
                crate::web::websocket::stash_buffer(rid, crate::web::websocket::WsBufferKind::Text(reason));
            }
        }
        WsEventResult::Pong => {}
    }

    let _ = resolver.resolve(scope, v8::Number::new(scope, kind).into());
}

/// Drop all pending timers + cancel in-flight sleeps. Must run before the
/// isolate is torn down — `v8::Global` handles inside `Timer` must not
/// outlive it. Dropping `CancellationToken` cancels the tokio sleep.
pub fn clear_all() {
    TIMERS.with(|t| t.borrow_mut().clear());
    CANCELLED.with(|c| c.borrow_mut().clear());
}