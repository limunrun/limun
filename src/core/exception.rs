//! Error reporting for uncaught exceptions.

pub fn report_exception(
    try_catch: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>,
    path: &str,
) {
    let exception = match try_catch.exception() {
        Some(value) => value
            .to_string(try_catch)
            .map(|s| s.to_rust_string_lossy(try_catch))
            .unwrap_or_else(|| "<unprintable exception>".to_string()),
        None => "unknown error".to_string(),
    };

    let line = try_catch
        .message()
        .and_then(|m| m.get_line_number(try_catch))
        .unwrap_or(0);

    eprintln!("limun: {path}:{line}: {exception}");
}