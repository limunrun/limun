//! Per-thread module state (single isolate per process for now).
//! Cleared before isolate teardown — v8::Global must not outlive the isolate.

use crate::core::import_map::ImportMap;
use std::cell::RefCell;
use std::collections::HashMap;
use url::Url;

thread_local! {
    /// module URL -> compiled module (dedup: same URL == same module instance)
    pub static REGISTRY: RefCell<HashMap<Url, v8::Global<v8::Module>>> =
        RefCell::new(HashMap::new());
    /// module identity hash -> its own URL (for resolving its relative imports)
    pub static MODULE_URLS: RefCell<HashMap<i32, Url>> = RefCell::new(HashMap::new());
    /// Parsed ./limun.json import map, if any.
    pub static IMPORT_MAP: RefCell<Option<ImportMap>> = RefCell::new(None);
}

pub fn clear_module_state() {
    REGISTRY.with(|r| r.borrow_mut().clear());
    MODULE_URLS.with(|d| d.borrow_mut().clear());
    crate::core::event_loop::clear_all();
    crate::core::rejections::clear_all();
}
