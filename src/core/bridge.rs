//! Wire format for tokio-task completions hopping back to the V8 thread.
//! Everything here is `Send` — V8 objects (`Global<T>` is `!Send`) never
//! cross threads; only plain-Rust payloads do.

use crate::core::module::ModuleKind;
use url::Url;

pub enum TaskResult {
    Fetch {
        task_id: u64,
        result: Result<FetchPayload, String>,
    },
    ImportSource {
        task_id: u64,
        url: Url,
        kind: ModuleKind,
        result: Result<String, String>,
    },
    Timer {
        timer_id: u32,
    },
    WsCreate {
        task_id: u64,
        rid: u32,
        result: Result<WsCreateResult, String>,
    },
    WsEvent {
        task_id: u64,
        rid: u32,
        result: WsEventResult,
    },
}

pub struct FetchPayload {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub original_url: String,
    pub final_url: String,
}

pub struct WsCreateResult {
    pub protocol: String,
    pub extensions: String,
}

pub enum WsEventResult {
    Text(String),
    Binary(Vec<u8>),
    Pong,
    Error(String),
    Close(u16, String),
}