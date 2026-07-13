//! `fetch()` — WHATWG Fetch Standard
//! (https://fetch.spec.whatwg.org/#fetch-method). Async: spawns a tokio
//! task on the process-global runtime and returns a pending Promise; the
//! result arrives over the bridge channel and is resolved by
//! `core::event_loop::resolve_fetch`. Two concurrent `fetch()` calls run
//! concurrently (multi-thread tokio runtime).
//!
//! Permission check still happens inline on the V8 thread (synchronous
//! failure → immediate rejection, no task spawned).
//!
//! `AbortSignal` support: if `init.signal` (or a `Request`'s signal) is
//! already aborted, the promise rejects inline with the signal's reason.
//! Otherwise a native `"abort"` listener is registered on the signal; if
//! the signal aborts while the tokio task is in flight, the listener
//! removes the pending task (so the late tokio result is a no-op),
//! rejects the promise with the reason, and cancels the tokio task via a
//! `CancellationToken` (`tokio::select!` between `req.send()` and
//! `cancel.cancelled()`).
//!
//! Simplifications vs. spec:
//!   - `Request` input is supported (Item 2). `input` may be a `Request`
//!     instance or a string.
//!   - `fetch()` only rejects on a genuine network failure or abort,
//!     never on a non-2xx HTTP status (that's `.ok === false`, per spec).

pub mod headers;
pub mod request;
pub mod response;

use crate::core::bridge::{FetchPayload, TaskResult};
use crate::core::ops;
use crate::core::permissions;
use crate::core::runtime;
use crate::core::state::{PENDING_TASKS, PendingKind, PendingTask, next_task_id};
use crate::web::native;

use std::cell::RefCell;
use std::collections::HashMap;

use tokio_util::sync::CancellationToken;

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    headers::install(scope, global);
    response::install(scope, global);
    request::install(scope, global);

    let key = v8::String::new(scope, "fetch").unwrap();
    let func = v8::Function::new(scope, fetch).unwrap();
    global.set(scope, key.into(), func.into());
}

fn fetch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    if args.length() == 0 {
        reject_type_error(scope, resolver, "fetch: 1 argument required, but only 0 present");
        return;
    }

    // Resolve `input`: a `Request` instance (clone its fields as the
    // base) or a string (the URL). `init` overrides the base.
    let mut method = String::from("GET");
    let mut url_str = String::new();
    let mut header_pairs = Vec::new();
    let mut body: Option<Vec<u8>> = None;
    let mut signal_obj: Option<v8::Local<v8::Object>> = None;

    let input = args.get(0);
    if let Ok(input_obj) = <v8::Local<v8::Object>>::try_from(input) {
        if request::is_request_instance(scope, input_obj) {
            let state = request::state(scope, input_obj);
            method = state.method.clone();
            url_str = state.url.clone();
            header_pairs = state.header_pairs.borrow().clone();
            body = state.body.borrow().clone();
            if let Some(g) = &state.signal {
                signal_obj = Some(v8::Local::new(scope, g));
            }
        }
    }
    if url_str.is_empty() {
        url_str = input.to_rust_string_lossy(scope);
    }

    let url = match url::Url::parse(&url_str) {
        Ok(u) => u,
        Err(e) => {
            reject_type_error(scope, resolver, &format!("fetch: invalid URL \"{url_str}\": {e}"));
            return;
        }
    };

    // `init` overrides (and may supply a `signal`, which wins over any
    // `Request`-inherited signal per spec).
    if args.length() > 1 {
        if let Ok(init) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            let method_key = v8::String::new(scope, "method").unwrap();
            if let Some(v) = init.get(scope, method_key.into()) {
                if !v.is_undefined() {
                    method = v.to_rust_string_lossy(scope).to_uppercase();
                }
            }
            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(v) = init.get(scope, headers_key.into()) {
                if !v.is_undefined() {
                    header_pairs = headers::parse_value(scope, v);
                }
            }
            let body_key = v8::String::new(scope, "body").unwrap();
            if let Some(v) = init.get(scope, body_key.into()) {
                if !v.is_undefined() && !v.is_null() {
                    body = Some(
                        native::read_buffer_source(v)
                            .unwrap_or_else(|| v.to_rust_string_lossy(scope).into_bytes()),
                    );
                }
            }
            let signal_key = v8::String::new(scope, "signal").unwrap();
            if let Some(v) = init.get(scope, signal_key.into()) {
                if v.is_null_or_undefined() {
                    signal_obj = None;
                } else if let Ok(obj) = <v8::Local<v8::Object>>::try_from(v) {
                    signal_obj = Some(obj);
                }
            }
        }
    }

    // AbortSignal: pre-aborted → reject inline with the signal's reason, no spawn.
    if let Some(sig) = signal_obj {
        if ops::abort_signal_is_aborted(scope, sig) {
            let reason = ops::abort_signal_get_reason(scope, sig)
                .unwrap_or_else(|| v8::undefined(scope).into());
            resolver.reject(scope, reason);
            return;
        }
    }

    // Permission gate is synchronous: a denied URL rejects inline rather
    // than spawning a task that would always reject. Sits after the
    // `init` overrides because the *final* method decides the mode —
    // safe methods only need a `read` grant, state-changing ones need
    // `write`.
    let mode = match method.as_str() {
        "GET" | "HEAD" | "OPTIONS" => permissions::Mode::Read,
        _ => permissions::Mode::Write,
    };
    if let Err(message) = permissions::check(&url, mode) {
        reject_type_error(scope, resolver, &format!("fetch: {message}"));
        return;
    }

    // Register the pending task before spawning so the receive handler is
    // guaranteed to find the resolver (no race where the tokio task
    // completes — and tries to send — before we insert).
    let task_id = next_task_id();
    let resolver_global = v8::Global::new(scope, resolver);
    PENDING_TASKS.with(|p| {
        p.borrow_mut().insert(
            task_id,
            PendingTask {
                resolver: resolver_global,
                kind: PendingKind::Fetch,
            },
        );
    });

    // Cancellation token for the tokio task. If a signal is present,
    // register an `"abort"` listener that — on fire — removes the
    // pending task, rejects the promise with the signal's reason, and
    // cancels the tokio task (so its in-flight `req.send()` aborts and
    // its late result is a no-op, the pending task being already gone).
    let cancel = CancellationToken::new();
    if let Some(sig) = signal_obj {
        register_abort_listener(scope, sig, task_id, cancel.clone());
    }

    let original_url = url_str;
    let cancel_for_task = cancel.clone();
    runtime::handle().spawn(async move {
        let result = do_fetch(method, url, header_pairs, body, Some(cancel_for_task)).await;
        let payload = result.map(|(status, status_text, headers, body, final_url)| FetchPayload {
            status,
            status_text,
            headers,
            body,
            original_url: original_url.clone(),
            final_url,
        });
        let _ = runtime::tx().send(TaskResult::Fetch { task_id, result: payload });
    });
}

/// Plain-Rust async fetch — runs on a tokio worker thread. `Send` only,
/// no V8 objects. Returns `(status, status_text, headers, body, final_url)`.
/// On cancel, returns `Err("aborted")` (the event loop's `resolve_fetch`
/// will find the pending task already removed and no-op the result).
async fn do_fetch(
    method: String,
    url: url::Url,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    cancel: Option<CancellationToken>,
) -> Result<(u16, String, Vec<(String, String)>, Vec<u8>, String), String> {
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("invalid HTTP method \"{method}\""))?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;
    let mut req = client.request(method, url.clone());
    for (n, v) in &headers {
        req = req.header(n, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = if let Some(cancel) = cancel {
        tokio::select! {
            r = req.send() => r.map_err(|e| format!("cannot fetch {url}: {e}"))?,
            _ = cancel.cancelled() => return Err("aborted".to_string()),
        }
    } else {
        req.send()
            .await
            .map_err(|e| format!("cannot fetch {url}: {e}"))?
    };
    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let final_url = resp.url().to_string();
    let response_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .filter_map(|(n, v)| v.to_str().ok().map(|s| (n.as_str().to_string(), s.to_string())))
        .collect();
    let body_bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("cannot read response body from {url}: {e}"))?
        .to_vec();
    Ok((status, status_text, response_headers, body_bytes, final_url))
}

// =========================================================================
// Abort-listener trampoline (for fetch's AbortSignal integration)
// =========================================================================

thread_local! {
    /// Id counter + data table for the fetch-abort trampoline. Fresh
    /// counter (disjoint from any event-module trampoline — the event
    /// module is now JS, so there's no longer a Rust counter there to
    /// collide with) so ids never collide. Entries are one-shot —
    /// removed on first fire.
    static NEXT_FETCH_ABORT_ID: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FETCH_ABORTS: RefCell<HashMap<usize, FetchAbortData>> = RefCell::new(HashMap::new());
}

/// Per-id data for the fetch-abort trampoline: the fetch task_id (so
/// the trampoline can find + remove the pending task and reject its
/// resolver), the signal (to read the abort reason off after fire), and
/// the cancellation token (to cancel the in-flight tokio task).
struct FetchAbortData {
    task_id: u64,
    signal: v8::Global<v8::Object>,
    cancel: CancellationToken,
}

fn next_fetch_abort_id() -> usize {
    NEXT_FETCH_ABORT_ID.with(|c| {
        let id = c.get();
        c.set(id.wrapping_add(1));
        id
    })
}

/// Build a native `Function` (with `data` = numeric id) that, when
/// called as an `"abort"` listener on `signal`, removes the pending
/// fetch task `task_id`, rejects its promise with the signal's reason,
/// and cancels the tokio task. Then attach it to the signal via the
/// JS `AbortSignal`'s public `addEventListener` (`abort_signal_add_listener`
/// — a `once` listener, so it auto-removes after firing).
fn register_abort_listener(
    scope: &mut v8::PinScope,
    signal: v8::Local<v8::Object>,
    task_id: u64,
    cancel: CancellationToken,
) {
    let id = next_fetch_abort_id();
    FETCH_ABORTS.with(|m| {
        m.borrow_mut().insert(
            id,
            FetchAbortData {
                task_id,
                signal: v8::Global::new(scope, signal),
                cancel,
            },
        );
    });
    let id_val = v8::Number::new(scope, id as f64).into();
    let func = v8::Function::builder(fetch_abort_trampoline)
        .data(id_val)
        .build(scope)
        .unwrap();
    ops::abort_signal_add_listener(scope, signal, func);
}

fn fetch_abort_trampoline(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.data()
        .number_value(scope)
        .map(|n| n as usize)
        .unwrap_or(0);
    let Some(data) = FETCH_ABORTS.with(|m| m.borrow_mut().remove(&id)) else {
        return;
    };
    // Cancel the tokio task (its `select!` returns "aborted"; the late
    // result finds the pending task already removed and no-ops).
    data.cancel.cancel();
    // Remove the pending task and reject its promise with the signal's
    // reason. Runs on the V8 thread — no bridge round-trip needed.
    let Some(task) = PENDING_TASKS.with(|p| p.borrow_mut().remove(&data.task_id)) else {
        return;
    };
    let signal_local = v8::Local::new(scope, &data.signal);
    let reason = ops::abort_signal_get_reason(scope, signal_local)
        .unwrap_or_else(|| v8::undefined(scope).into());
    let resolver = v8::Local::new(scope, &task.resolver);
    let _ = resolver.reject(scope, reason);
}

fn reject_type_error(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::type_error(scope, msg);
    resolver.reject(scope, exception);
}