//! Shared plumbing for console methods: argument formatting, stringification,
//! stdout/stderr routing with group indentation, and the per-arg label helper
//! used by count/countReset/time/timeLog/timeEnd.

use crate::web::console::state::GROUP_DEPTH;
use std::time::Duration;

/// §2.1 Logger + §2.2 Formatter, collapsed into one pass: if there's exactly
/// one argument, print it unformatted (spec: no substitution with no
/// "rest"). Otherwise, if the first argument is a string, walk it for
/// %s/%d/%i/%f/%o/%O/%c specifiers, consuming subsequent args positionally,
/// then space-join anything left over.
pub fn format_console_args(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, skip: i32) -> String {
    let len = args.length();
    if len <= skip {
        return String::new();
    }
    if len == skip + 1 {
        return stringify(scope, args.get(skip));
    }

    let first = args.get(skip);
    if !first.is_string() {
        return join_all(scope, args, skip);
    }

    let template = first.to_rust_string_lossy(scope);
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    let mut next_arg = skip + 1;
    let mut consumed_any = false;

    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('%') => {
                chars.next();
                out.push('%');
            }
            Some(spec @ ('s' | 'd' | 'i' | 'f' | 'o' | 'O' | 'c')) if next_arg < len => {
                chars.next();
                let value = args.get(next_arg);
                next_arg += 1;
                consumed_any = true;
                match spec {
                    's' => out.push_str(&value.to_rust_string_lossy(scope)),
                    'd' | 'i' => out.push_str(&if value.is_symbol() {
                        "NaN".to_string()
                    } else {
                        value.integer_value(scope).unwrap_or(0).to_string()
                    }),
                    'f' => out.push_str(&if value.is_symbol() {
                        "NaN".to_string()
                    } else {
                        value.number_value(scope).unwrap_or(f64::NAN).to_string()
                    }),
                    'o' | 'O' => out.push_str(&stringify(scope, value)),
                    'c' => {} // CSS styling: no terminal equivalent, just consume the arg.
                    _ => unreachable!(),
                }
            }
            _ => out.push('%'),
        }
    }

    if !consumed_any {
        return join_all(scope, args, skip);
    }
    for i in next_arg..len {
        out.push(' ');
        out.push_str(&stringify(scope, args.get(i)));
    }
    out
}

fn join_all(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, skip: i32) -> String {
    let mut parts = Vec::with_capacity((args.length() - skip).max(0) as usize);
    for i in skip..args.length() {
        parts.push(stringify(scope, args.get(i)));
    }
    parts.join(" ")
}

pub fn stringify(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> String {
    value
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "<unprintable>".to_string())
}

/// Print to stdout, honoring current group indentation (§1.3).
pub fn log_out(text: &str) {
    print_indented(text, false);
}

/// Print to stderr, honoring current group indentation (§1.3).
pub fn log_err(text: &str) {
    print_indented(text, true);
}

fn print_indented(text: &str, err: bool) {
    let indent = "  ".repeat(GROUP_DEPTH.with(|d| *d.borrow()));
    for line in text.split('\n') {
        if err {
            eprintln!("{indent}{line}");
        } else {
            println!("{indent}{line}");
        }
    }
}

/// Shared "label" argument default used by count/countReset/time/*, per
/// spec (`optional DOMString label = "default"`).
pub fn label_arg(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    if args.length() > i {
        stringify(scope, args.get(i))
    } else {
        "default".to_string()
    }
}

pub fn format_duration(d: Duration) -> String {
    format!("{:.3}ms", d.as_secs_f64() * 1000.0)
}