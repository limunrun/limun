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
}

pub struct FetchPayload {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// The URL the user originally requested (pre-redirect). Carried through
    /// the tokio task as a plain `String` (captured at spawn time) so the
    /// receive-side can pass it to `Response::new_instance` along with
    /// `final_url` for the `.redirected` computation.
    pub original_url: String,
    /// Final URL after redirects (reqwest follows them by default). Matches
    /// browser `Response.url`.
    pub final_url: String,
}