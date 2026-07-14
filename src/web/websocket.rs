//! WebSocket ops — the async transport backing WHATWG WebSocket Standard
//! (https://websockets.spec.whatwg.org/). The spec surface (class shape,
//! URL parsing, protocol validation, readyState, event handlers, send/close)
//! lives in JS (`ext:limun/24_websocket.js`); this module is the irreducible
//! native work: `tokio-tungstenite` TCP/TLS transport.
//!
//! Each WebSocket connection has:
//!   - A `rid` (resource id) in a global registry.
//!   - A tokio task that owns the `tungstenite::WebSocket` and runs a
//!     `select!` loop between incoming messages and outgoing commands.
//!   - A command channel (`UnboundedSender<WsCmd>`) for sending data /
//!     closing (used by `op_ws_send_text`/`op_ws_send_binary`/`op_ws_close`).
//!   - An event receiver (`UnboundedReceiver<WsEvent>`) guarded by a
//!     `tokio::sync::Mutex`. `op_ws_next_event` spawns a tokio task that
//!     receives one event from it and sends it back via the bridge channel.

use crate::core::bridge::{TaskResult, WsCreateResult, WsEventResult};
use crate::core::permissions;
use crate::core::runtime;
use crate::core::state::{PENDING_TASKS, PendingKind, PendingTask, next_task_id};

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

enum WsCmd {
    SendText(String),
    SendBinary(Vec<u8>),
    Close(Option<u16>, Option<String>),
}

enum WsEvent {
    Text(String),
    Binary(Vec<u8>),
    Pong,
    Error(String),
    Close(u16, String),
}

struct WsHandle {
    cmd_tx: tokio::sync::mpsc::UnboundedSender<WsCmd>,
    event_rx: Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<WsEvent>>>,
}

static WS_REGISTRY: LazyLock<StdMutex<HashMap<u32, WsHandle>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static NEXT_RID: AtomicU32 = AtomicU32::new(1);

thread_local! {
    static WS_BUFFERS: std::cell::RefCell<HashMap<u32, WsBuffer>> = std::cell::RefCell::new(HashMap::new());
}

enum WsBuffer {
    Text(String),
    Binary(Vec<u8>),
    Error(String),
}

pub enum WsBufferKind {
    Text(String),
    Binary(Vec<u8>),
    Error(String),
}

pub fn stash_buffer(rid: u32, kind: WsBufferKind) {
    let buffer = match kind {
        WsBufferKind::Text(t) => WsBuffer::Text(t),
        WsBufferKind::Binary(b) => WsBuffer::Binary(b),
        WsBufferKind::Error(e) => WsBuffer::Error(e),
    };
    WS_BUFFERS.with(|b| {
        b.borrow_mut().insert(rid, buffer);
    });
}

fn alloc_rid() -> u32 {
    NEXT_RID.fetch_add(1, Ordering::Relaxed).max(1)
}

pub fn op_ws_create(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    let url_str = args.get(0).to_rust_string_lossy(scope);
    let protocols_str = args.get(1).to_rust_string_lossy(scope);

    let url = match url::Url::parse(&url_str) {
        Ok(u) => u,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("WebSocket: invalid URL: {e}")).unwrap();
            let err = v8::Exception::type_error(scope, msg);
            resolver.reject(scope, err);
            return;
        }
    };

    if let Err(msg) = permissions::check(&url, permissions::Mode::Read) {
        let msg = v8::String::new(scope, &format!("WebSocket: {msg}")).unwrap();
        let err = v8::Exception::type_error(scope, msg);
        resolver.reject(scope, err);
        return;
    }

    let task_id = next_task_id();
    let resolver_global = v8::Global::new(scope, resolver);
    PENDING_TASKS.with(|p| {
        p.borrow_mut().insert(
            task_id,
            PendingTask {
                resolver: resolver_global,
                kind: PendingKind::WebSocket,
            },
        );
    });

    let rid = alloc_rid();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<WsCmd>();
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel::<WsEvent>();

    WS_REGISTRY
        .lock()
        .unwrap()
        .insert(rid, WsHandle {
            cmd_tx,
            event_rx: Arc::new(tokio::sync::Mutex::new(event_rx)),
        });

    runtime::handle().spawn(async move {
        let result = do_ws_connect(&url_str, &protocols_str, cmd_rx, event_tx).await;
        match result {
            Ok((protocol, extensions)) => {
                let _ = runtime::tx().send(TaskResult::WsCreate {
                    task_id,
                    rid,
                    result: Ok(WsCreateResult { protocol, extensions }),
                });
            }
            Err(e) => {
                let _ = runtime::tx().send(TaskResult::WsCreate {
                    task_id,
                    rid,
                    result: Err(e),
                });
            }
        }
    });
}

async fn do_ws_connect(
    url: &str,
    protocols: &str,
    mut cmd_rx: tokio::sync::mpsc::UnboundedReceiver<WsCmd>,
    event_tx: tokio::sync::mpsc::UnboundedSender<WsEvent>,
) -> Result<(String, String), String> {
    use tokio_tungstenite::tungstenite::handshake::client::Request;
    use tokio_tungstenite::tungstenite::http::Uri;

    let uri: Uri = url.parse().map_err(|e: tokio_tungstenite::tungstenite::http::uri::InvalidUri| format!("WebSocket: invalid URI: {e}"))?;

    let host = uri.host().unwrap_or("");
    let host_header = match uri.port_u16() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };

    let mut request = Request::builder()
        .uri(uri)
        .header("Host", host_header)
        .header("User-Agent", "limun")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        );
    if !protocols.is_empty() {
        request = request.header("Sec-WebSocket-Protocol", protocols);
    }

    let request = request
        .body(())
        .map_err(|e| format!("WebSocket: failed to build request: {e}"))?;

    let (ws_stream, response) =
        tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("WebSocket connection failed: {e}"))?;

    let protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let extensions = response
        .headers()
        .get("sec-websocket-extensions")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = ws_receiver.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            let _ = event_tx.send(WsEvent::Text(text.to_string()));
                        }
                        Some(Ok(WsMessage::Binary(data))) => {
                            let _ = event_tx.send(WsEvent::Binary(data.to_vec()));
                        }
                        Some(Ok(WsMessage::Pong(_))) => {
                            let _ = event_tx.send(WsEvent::Pong);
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            let (code, reason) = if let Some(cf) = frame {
                                (u16::from(cf.code), cf.reason.to_string())
                            } else {
                                (1005u16, String::new())
                            };
                            let _ = event_tx.send(WsEvent::Close(code, reason));
                            break;
                        }
                        Some(Ok(WsMessage::Ping(_))) => {}
                        Some(Ok(WsMessage::Frame(_))) => {}
                        Some(Err(e)) => {
                            let _ = event_tx.send(WsEvent::Error(format!("{e}")));
                            break;
                        }
                        None => {
                            let _ = event_tx.send(WsEvent::Close(1005, String::new()));
                            break;
                        }
                    }
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(WsCmd::SendText(text)) => {
                            let _ = ws_sender.send(WsMessage::Text(text.into())).await;
                        }
                        Some(WsCmd::SendBinary(data)) => {
                            let _ = ws_sender.send(WsMessage::Binary(data.into())).await;
                        }
                        Some(WsCmd::Close(code, reason)) => {
                            if let Some(c) = code {
                                let _ = ws_sender.send(WsMessage::Close(Some(
                                    tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                        code: CloseCode::from(c),
                                        reason: reason.unwrap_or_default().into(),
                                    },
                                ))).await;
                            } else {
                                let _ = ws_sender.send(WsMessage::Close(None)).await;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    Ok((protocol, extensions))
}

pub fn op_ws_next_event(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;

    let task_id = next_task_id();
    let resolver_global = v8::Global::new(scope, resolver);
    PENDING_TASKS.with(|p| {
        p.borrow_mut().insert(
            task_id,
            PendingTask {
                resolver: resolver_global,
                kind: PendingKind::WebSocket,
            },
        );
    });

    runtime::handle().spawn(async move {
        let event = wait_next_event(rid).await;
        let _ = runtime::tx().send(TaskResult::WsEvent {
            task_id,
            rid,
            result: event,
        });
    });
}

async fn wait_next_event(rid: u32) -> WsEventResult {
    let event_rx = {
        let registry = WS_REGISTRY.lock().unwrap();
        registry.get(&rid).map(|h| h.event_rx.clone())
    };

    let Some(event_rx) = event_rx else {
        return WsEventResult::Error("WebSocket not found".to_string());
    };

    let event = {
        let mut guard = event_rx.lock().await;
        guard.recv().await
    };

    match event {
        Some(WsEvent::Text(text)) => WsEventResult::Text(text),
        Some(WsEvent::Binary(data)) => WsEventResult::Binary(data),
        Some(WsEvent::Pong) => WsEventResult::Pong,
        Some(WsEvent::Error(msg)) => WsEventResult::Error(msg),
        Some(WsEvent::Close(code, reason)) => WsEventResult::Close(code, reason),
        None => WsEventResult::Close(1005, String::new()),
    }
}

pub fn op_ws_send_text(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let text = args.get(1).to_rust_string_lossy(scope);

    if let Some(handle) = WS_REGISTRY.lock().unwrap().get(&rid) {
        let _ = handle.cmd_tx.send(WsCmd::SendText(text));
    }
    rv.set(v8::undefined(scope).into());
}

pub fn op_ws_send_binary(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let data = read_bytes(args.get(1)).unwrap_or_default();

    if let Some(handle) = WS_REGISTRY.lock().unwrap().get(&rid) {
        let _ = handle.cmd_tx.send(WsCmd::SendBinary(data));
    }
    rv.set(v8::undefined(scope).into());
}

pub fn op_ws_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let code = if args.get(1).is_undefined() || args.get(1).is_null() {
        None
    } else {
        Some(args.get(1).integer_value(scope).unwrap_or(0) as u16)
    };
    let reason = if args.get(2).is_undefined() || args.get(2).is_null() {
        None
    } else {
        Some(args.get(2).to_rust_string_lossy(scope))
    };

    if let Some(handle) = WS_REGISTRY.lock().unwrap().get(&rid) {
        let _ = handle.cmd_tx.send(WsCmd::Close(code, reason));
    }

    let _ = resolver.resolve(scope, v8::undefined(scope).into());
}

pub fn op_ws_get_buffer(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let buffer = WS_BUFFERS.with(|b| b.borrow_mut().remove(&rid));
    match buffer {
        Some(WsBuffer::Binary(data)) => {
            let len = data.len();
            let store = v8::ArrayBuffer::new_backing_store_from_vec(data).make_shared();
            let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
            let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
            rv.set(view.into());
        }
        _ => {
            rv.set(v8::undefined(scope).into());
        }
    }
}

pub fn op_ws_get_buffer_as_string(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let buffer = WS_BUFFERS.with(|b| b.borrow_mut().remove(&rid));
    match buffer {
        Some(WsBuffer::Text(text)) => {
            let s = v8::String::new(scope, &text).unwrap();
            rv.set(s.into());
        }
        _ => {
            rv.set(v8::undefined(scope).into());
        }
    }
}

pub fn op_ws_get_error(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let rid = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let buffer = WS_BUFFERS.with(|b| b.borrow_mut().remove(&rid));
    match buffer {
        Some(WsBuffer::Error(msg)) => {
            let s = v8::String::new(scope, &msg).unwrap();
            rv.set(s.into());
        }
        Some(WsBuffer::Text(text)) => {
            let s = v8::String::new(scope, &text).unwrap();
            rv.set(s.into());
        }
        _ => {
            let s = v8::String::new(scope, "").unwrap();
            rv.set(s.into());
        }
    }
}

pub fn op_ws_get_buffered_amount(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Number::new(scope, 0.0).into());
}

fn read_bytes(value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
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

#[allow(dead_code)]
pub fn drop_ws(rid: u32) {
    WS_REGISTRY.lock().unwrap().remove(&rid);
    WS_BUFFERS.with(|b| {
        b.borrow_mut().remove(&rid);
    });
}