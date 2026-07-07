//! Per-thread module state (single isolate per process for now).
//! Cleared before isolate teardown — v8::Global must not outlive the isolate.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

thread_local! {
    /// canonical path -> compiled module (dedup: same file == same module instance)
    pub static REGISTRY: RefCell<HashMap<PathBuf, v8::Global<v8::Module>>> =
        RefCell::new(HashMap::new());
    /// module identity hash -> its directory (for resolving its relative imports)
    pub static MODULE_DIRS: RefCell<HashMap<i32, PathBuf>> =
        RefCell::new(HashMap::new());
    /// (project root, "imports" from limun.json)
    pub static IMPORT_MAP: RefCell<Option<(PathBuf, HashMap<String, String>)>> =
        RefCell::new(None);
}

pub fn clear_module_state() {
    REGISTRY.with(|r| r.borrow_mut().clear());
    MODULE_DIRS.with(|d| d.borrow_mut().clear());
    crate::core::event_loop::clear_all();
    crate::core::rejections::clear_all();
}