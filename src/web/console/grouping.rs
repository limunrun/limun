//! Grouping functions (§1.3) — group/groupCollapsed/groupEnd.
//! "Collapsed" is a UI-only distinction; on a plain text stream it behaves
//! the same as group().

use crate::web::console::common::{format_console_args, log_out};
use crate::web::console::state::GROUP_DEPTH;

/// §1.3.1 group(...data)
pub fn group(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    open_group(scope, &args);
}

/// §1.3.2 groupCollapsed(...data)
pub fn group_collapsed(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    open_group(scope, &args);
}

fn open_group(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) {
    let label = if args.length() > 0 {
        format_console_args(scope, args, 0)
    } else {
        "console.group".to_string()
    };
    log_out(&label);
    GROUP_DEPTH.with(|d| *d.borrow_mut() += 1);
}

/// §1.3.3 groupEnd()
pub fn group_end(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    GROUP_DEPTH.with(|d| {
        let mut d = d.borrow_mut();
        *d = d.saturating_sub(1);
    });
}