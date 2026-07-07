//! `btoa`/`atob` — WHATWG HTML Standard
//! (https://html.spec.whatwg.org/multipage/webappapis.html#atob). Plain
//! operations (not classes), enumerable — verified against Node.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// `btoa(data: string): string` — `data` must be a "binary string" (every
/// UTF-16 code unit in the range U+0000-U+00FF); anything outside that
/// range throws (spec: `InvalidCharacterError`).
pub fn btoa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let input = args.get(0).to_rust_string_lossy(scope);

    let mut bytes = Vec::with_capacity(input.len());
    for c in input.chars() {
        let code = c as u32;
        if code > 0xFF {
            crate::web::throw_dom_exception(
                scope,
                "InvalidCharacterError",
                "btoa: the string to be encoded contains characters outside of the Latin1 range",
            );
            return;
        }
        bytes.push(code as u8);
    }

    let encoded = STANDARD.encode(&bytes);
    let s = v8::String::new(scope, &encoded).unwrap();
    rv.set(s.into());
}

/// `atob(data: string): string` — decodes base64 back to a binary string
/// (each output character's code unit is the corresponding decoded byte
/// value, 0-255).
pub fn atob(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let input = args.get(0).to_rust_string_lossy(scope);
    // Spec: "Remove all ASCII whitespace from data" before decoding.
    let cleaned: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();

    let Ok(bytes) = STANDARD.decode(&cleaned) else {
        crate::web::throw_dom_exception(scope, "InvalidCharacterError", "atob: invalid base64 string");
        return;
    };

    let binary_string: String = bytes.iter().map(|&b| b as char).collect();
    let s = v8::String::new(scope, &binary_string).unwrap();
    rv.set(s.into());
}
