//! User-prompt globals from the WHATWG HTML `Window` interface —
//! `alert`/`confirm`/`prompt`. Spec'd on browsers as modal dialogs; Deno
//! reuses them as stdin-prompting terminal functions, and that's the model
//! `limun` follows too (per https://docs.deno.com/api/web/platform/).
//!
//! Behavior, cross-checked against Deno:
//!   - `alert(message?)`        — writes `message + " [Enter]"` to stderr,
//!     blocks for one line of stdin, returns `undefined`. Non-TTY stdin: no-op.
//!   - `confirm(message?)`      — writes `message + " [y/N]"` to stderr,
//!     reads one line, returns `true` only if it's exactly `y` or `Y`.
//!     Non-TTY stdin: returns `false`.
//!   - `prompt(message?, def?)` — writes `message + " "` to stderr, reads one
//!     line. Returns the trimmed line; empty input with a `def` returns `def`;
//!     empty input with no `def` returns `""`. Non-TTY stdin: returns `null`.
//!
//! Installed as enumerable own properties of `globalThis` (matching `self` —
//! these are ordinary interface attributes per Web IDL §3.7.3, not namespace
//! objects like `console`).

use std::io::{IsTerminal, Write};

/// `alert(message?: any): void`
pub fn alert(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if !std::io::stdin().is_terminal() {
        return;
    }
    let mut line = format!("{} [Enter] ", message_arg(scope, &args, 0));
    if let Err(e) = write_and_flush(&line) {
        line = format!("limun: alert failed: {e}");
        let _ = write_and_flush(&line);
        return;
    }
    wait_for_line();
}

/// `confirm(message?: any): boolean`
pub fn confirm(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    if !std::io::stdin().is_terminal() {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }
    let mut line = format!("{} [y/N] ", message_arg(scope, &args, 0));
    if let Err(e) = write_and_flush(&line) {
        line = format!("limun: confirm failed: {e}");
        let _ = write_and_flush(&line);
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }
    let answer = wait_for_line().unwrap_or_default();
    let yes = answer.trim() == "y" || answer.trim() == "Y";
    rv.set(v8::Boolean::new(scope, yes).into());
}

/// `prompt(message?: any, defaultValue?: string): string | null`
pub fn prompt(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    if !std::io::stdin().is_terminal() {
        rv.set(v8::null(scope).into());
        return;
    }
    let prompt_text = format!("{} ", message_arg(scope, &args, 0));
    if let Err(e) = write_and_flush(&prompt_text) {
        let line = format!("limun: prompt failed: {e}");
        let _ = write_and_flush(&line);
        rv.set(v8::null(scope).into());
        return;
    }
    let input = match wait_for_line() {
        Some(s) => s,
        None => {
            rv.set(v8::null(scope).into());
            return;
        }
    };
    let trimmed = input.trim_end_matches(['\n', '\r']);
    let result = if trimmed.is_empty() && args.length() > 1 {
        // Empty input + defaultValue given: return the default.
        args.get(1)
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default()
    } else {
        trimmed.to_string()
    };
    rv.set(v8::String::new(scope, &result).unwrap().into());
}

fn message_arg(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    if args.length() <= i {
        return String::new();
    }
    args.get(i)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default()
}

fn write_and_flush(text: &str) -> std::io::Result<()> {
    let mut stderr = std::io::stderr().lock();
    stderr.write_all(text.as_bytes())?;
    stderr.flush()?;
    Ok(())
}

fn wait_for_line() -> Option<String> {
    let mut buf = String::new();
    match std::io::stdin().read_line(&mut buf) {
        Ok(0) => None, // EOF
        Ok(_) => Some(buf),
        Err(_) => None,
    }
}