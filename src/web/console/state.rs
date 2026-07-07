//! Per-thread state for the WHATWG Console Standard (§1.2-1.4).

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

thread_local! {
    /// console.group()/groupEnd() nesting depth — indents all output (§1.3).
    pub static GROUP_DEPTH: RefCell<usize> = RefCell::new(0);
    /// console.count() per-label counters (§1.2).
    pub static COUNTS: RefCell<HashMap<String, u64>> = RefCell::new(HashMap::new());
    /// console.time() per-label start instants (§1.4).
    pub static TIMERS: RefCell<HashMap<String, Instant>> = RefCell::new(HashMap::new());
}