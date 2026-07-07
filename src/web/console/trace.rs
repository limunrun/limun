//! §1.1.8 trace(...data) — a real captured V8 stack trace, not a placeholder.

use crate::web::console::common::{format_console_args, log_err};

pub fn trace(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let label = format_console_args(scope, &args, 0);
    let mut text = if label.is_empty() {
        "Trace".to_string()
    } else {
        format!("Trace: {label}")
    };

    if let Some(stack) = v8::StackTrace::current_stack_trace(scope, 10) {
        for i in 0..stack.get_frame_count() {
            let Some(frame) = stack.get_frame(scope, i) else {
                continue;
            };
            let func = frame
                .get_function_name(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "<anonymous>".to_string());
            let file = frame
                .get_script_name_or_source_url(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "<unknown>".to_string());
            text.push_str(&format!(
                "\n    at {func} ({file}:{}:{})",
                frame.get_line_number(),
                frame.get_column()
            ));
        }
    }
    log_err(&text);
}