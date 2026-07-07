//! Counting functions (§1.2) — count/countReset.

use crate::web::console::common::{label_arg, log_err, log_out};
use crate::web::console::state::COUNTS;

/// §1.2.1 count(label = "default")
pub fn count(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let label = label_arg(scope, &args, 0);
    let n = COUNTS.with(|c| {
        let mut c = c.borrow_mut();
        let entry = c.entry(label.clone()).or_insert(0);
        *entry += 1;
        *entry
    });
    log_out(&format!("{label}: {n}"));
}

/// §1.2.2 countReset(label = "default")
pub fn count_reset(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let label = label_arg(scope, &args, 0);
    let existed = COUNTS.with(|c| {
        let mut c = c.borrow_mut();
        match c.get_mut(&label) {
            Some(v) => {
                *v = 0;
                true
            }
            None => false,
        }
    });
    if !existed {
        log_err(&format!("Count for '{label}' does not exist"));
    }
}