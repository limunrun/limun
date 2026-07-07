//! Timing functions (§1.4) — time/timeLog/timeEnd.

use crate::web::console::common::{format_duration, label_arg, log_err, log_out, stringify};
use crate::web::console::state::TIMERS;
use std::time::Instant;

/// §1.4.1 time(label = "default")
pub fn time(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let label = label_arg(scope, &args, 0);
    TIMERS.with(|t| {
        let mut t = t.borrow_mut();
        if t.contains_key(&label) {
            log_err(&format!("Timer '{label}' already exists"));
        } else {
            t.insert(label, Instant::now());
        }
    });
}

/// §1.4.2 timeLog(label = "default", ...data)
pub fn time_log(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let label = label_arg(scope, &args, 0);
    let Some(elapsed) = TIMERS.with(|t| t.borrow().get(&label).map(Instant::elapsed)) else {
        log_err(&format!("Timer '{label}' does not exist"));
        return;
    };
    let mut text = format!("{label}: {}", format_duration(elapsed));
    for i in 1..args.length() {
        text.push(' ');
        text.push_str(&stringify(scope, args.get(i)));
    }
    log_out(&text);
}

/// §1.4.3 timeEnd(label = "default")
pub fn time_end(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let label = label_arg(scope, &args, 0);
    let Some(elapsed) = TIMERS.with(|t| t.borrow_mut().remove(&label)).map(|s| s.elapsed()) else {
        log_err(&format!("Timer '{label}' does not exist"));
        return;
    };
    log_out(&format!("{label}: {}", format_duration(elapsed)));
}