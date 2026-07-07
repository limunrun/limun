//! Logging functions (§1.1) — log/info/debug/warn/error/assert/clear/dir/dirxml.
//! `log`/`info`/`debug` go to stdout; `warn`/`error`/`assert` go to stderr
//! (matches real Node and Deno, despite the spec's own illustrative example
//! printer sending warn to stdout).

use std::io::Write;

use crate::web::console::common::{format_console_args, log_err, log_out, stringify};

/// §1.1.6 log(...data)
pub fn log(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    log_out(&format_console_args(scope, &args, 0));
}

/// §1.1.5 info(...data) — same "log" grouping as log(), per spec table.
pub fn info(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    log_out(&format_console_args(scope, &args, 0));
}

/// §1.1.3 debug(...data)
pub fn debug(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    log_out(&format_console_args(scope, &args, 0));
}

/// §1.1.9 warn(...data) — stderr.
pub fn warn(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    log_err(&format_console_args(scope, &args, 0));
}

/// §1.1.4 error(...data)
pub fn error(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    log_err(&format_console_args(scope, &args, 0));
}

/// §1.1.1 assert(condition, ...data) — logs only when condition is falsy.
pub fn assert(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if args.get(0).boolean_value(scope) {
        return;
    }

    let len = args.length();
    let first_is_string = len > 1 && args.get(1).is_string();
    let mut text = if first_is_string {
        format!("Assertion failed: {}", args.get(1).to_rust_string_lossy(scope))
    } else {
        "Assertion failed".to_string()
    };
    let data_start = if first_is_string { 2 } else { 1 };
    for i in data_start..len {
        text.push(' ');
        text.push_str(&stringify(scope, args.get(i)));
    }
    log_err(&text);
}

/// §1.1.2 clear() — resets group nesting and emits the ANSI clear-screen
/// sequence (no-op on a non-terminal stdout; never an error).
pub fn clear(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    crate::web::console::state::GROUP_DEPTH.with(|d| *d.borrow_mut() = 0);
    print!("\x1B[2J\x1B[H");
    let _ = std::io::stdout().flush();
}

/// §1.1.10 dir(item, options) — simplified to plain stringification (no
/// recursive/interactive object formatting).
pub fn dir(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let text = if args.length() > 0 {
        stringify(scope, args.get(0))
    } else {
        "undefined".to_string()
    };
    log_out(&text);
}

/// §1.1.11 dirxml(...data) — no DOM here, so this degrades to log().
pub fn dirxml(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    log_out(&format_console_args(scope, &args, 0));
}