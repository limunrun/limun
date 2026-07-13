//! Per-thread module state (single isolate per process for now).
//! Cleared before isolate teardown — v8::Global must not outlive the isolate.

use crate::core::import_map::ImportMap;
use crate::core::module::ModuleKind;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use url::Url;

/// What a pending task is waiting on. Mostly redundant with the
/// `TaskResult` variant that will eventually settle it — kept so the
/// receive handler can route without re-parsing the result payload.
#[allow(dead_code)]
pub enum PendingKind {
    Fetch,
    Import { url: Url, kind: ModuleKind },
}

/// A spawned-but-unfinished tokio task whose result will resolve/reject a
/// `PromiseResolver`. The `Global` must drop while the isolate is alive.
pub struct PendingTask {
    pub resolver: v8::Global<v8::PromiseResolver>,
    /// Carried for debugging / future routing; the dispatch routes on the
    /// `TaskResult` variant, not on this field.
    #[allow(dead_code)]
    pub kind: PendingKind,
}

thread_local! {
    /// (module URL, kind) -> compiled module — same URL with a different
    /// `type` import attribute is a genuinely different module (per spec),
    /// so kind is part of the dedup key, not just the URL.
    pub static REGISTRY: RefCell<HashMap<(Url, ModuleKind), v8::Global<v8::Module>>> =
        RefCell::new(HashMap::new());
    /// module identity hash -> its own URL (for resolving its relative imports)
    pub static MODULE_URLS: RefCell<HashMap<i32, Url>> = RefCell::new(HashMap::new());
    /// module identity hash -> its pending `default` export value, consumed
    /// by `synthetic_evaluation_steps` (json/text modules only).
    pub static SYNTHETIC_EXPORTS: RefCell<HashMap<i32, v8::Global<v8::Value>>> =
        RefCell::new(HashMap::new());
    /// Parsed ./limun.json import map, if any.
    pub static IMPORT_MAP: RefCell<Option<ImportMap>> = RefCell::new(None);

    /// `v8::Weak` handles holding guaranteed GC finalizers for native state
    /// boxed on a JS object's internal field. Each `Weak` must outlive the
    /// JS object it tracks — dropping it earlier cancels the finalizer.
    /// During normal running, GC collecting an object runs its finalizer
    /// and frees the box. At teardown, `clear_module_state` drops this vec
    /// while the isolate is alive: any object *still* live has its
    /// finalizer cancelled (not run), so its box leaks once — harmless, the
    /// process is exiting and the OS reclaims it. Objects collected earlier
    /// were already freed.
    ///
    /// Currently unused: every web module that used to box native state
    /// this way (URL/URLSearchParams/Headers/Response/Request/Blob/
    /// FormData/streams/events/TextDecoder/…) has been migrated to
    /// JS-on-ops (see MIGRATION_PROGRESS.md) — their state now lives in JS
    /// private fields, not Rust-boxed internal fields. Kept as
    /// infrastructure for any future native class that needs it (e.g. a
    /// resource handle with a GC-driven native finalizer).
    pub static WEAK_HANDLES: RefCell<Vec<v8::Weak<v8::Value>>> = RefCell::new(Vec::new());

    /// task id -> pending fetch/import() task. Drained by the event loop
    /// as results arrive over the bridge channel, or dropped wholesale by
    /// `clear_module_state` at isolate teardown.
    pub static PENDING_TASKS: RefCell<HashMap<u64, PendingTask>> = RefCell::new(HashMap::new());
    pub static NEXT_TASK_ID: Cell<u64> = const { Cell::new(1) };
}

pub fn clear_module_state() {
    REGISTRY.with(|r| r.borrow_mut().clear());
    MODULE_URLS.with(|d| d.borrow_mut().clear());
    SYNTHETIC_EXPORTS.with(|s| s.borrow_mut().clear());
    crate::core::event_loop::clear_all();
    crate::core::rejections::clear_all();
    // Drop pending-task resolvers before the weak finalizer handles — both
    // are `v8::Global`s that must drop while the isolate is still alive.
    PENDING_TASKS.with(|p| p.borrow_mut().clear());
    // Drop weak finalizer handles last. For objects already GC'd their
    // finalizers ran and freed the boxes; for objects still alive at
    // teardown, dropping the `Weak` cancels the pending finalizer (its box
    // leaks once at exit — see WEAK_HANDLES docs). Must happen while the
    // isolate is alive (a live `Weak` must not outlive its isolate).
    clear_weaks();
}

/// Drop every `v8::Weak` registered by `web::native::store`. For still-live
/// objects this cancels (does not run) their guaranteed finalizers — an
/// acceptable one-time leak at process exit (see WEAK_HANDLES docs).
pub fn clear_weaks() {
    WEAK_HANDLES.with(|w| w.borrow_mut().clear());
}

/// Monotonic task id for the next spawned fetch/import() task.
pub fn next_task_id() -> u64 {
    NEXT_TASK_ID.with(|c| {
        let id = c.get();
        c.set(id.wrapping_add(1).max(1));
        id
    })
}