//! Internal op registration — flat Rust functions callable from internal JS.
//!
//! Ops are plain `v8::FunctionCallback`s registered under string names on a
//! `globalThis.__limunOps` object. Internal JS calls them as
//! `__limunOps.op_name(args…)`. The op does native work and returns a flat
//! V8 value (string/number/ArrayBuffer) — no structured V8 objects cross
//! this boundary.
//!
//! This is deliberately *not* Deno's op2 infrastructure. There's no codegen,
//! no async ops, no resource table, no `OpState`. Each op is a bare
//! `FunctionCallback` registered by name in `install`. When a later phase
//! needs richer ops (async, resources), this is the place to grow — but
//! the surface stays "register a fn under a name" for now.
//!
//! Ops are internal-only: `__limunOps` is installed as a non-enumerable
//! own property of `globalThis` and is intended for use by the embedded
//! `ext:limun/*.js` modules, not user code. User code reaching into
//! `__limunOps` is unsupported (not enforced — it's the same global object
//! — but the contract is "internal APIs may change without notice").

use base64::Engine as _;

/// Install the `__limunOps` namespace on `globalThis` with every registered
/// op attached. Called once from `core::mod::execute`, before internal JS
/// modules evaluate (so primordials/infra modules can call ops during
/// their top-level evaluation).
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);
    let ops = v8::Object::new(scope);

    set_fn(scope, ops, "op_test_add", op_test_add);
    set_fn(scope, ops, "op_base64_atob", op_base64_atob);
    set_fn(scope, ops, "op_base64_btoa", op_base64_btoa);

    crate::web::set_global(scope, global, "__limunOps", ops.into());
}

/// `op_test_add(a: number, b: number) -> number` — the proof op. Returns
/// `a + b` as a Number. Exists only to prove the op-registration path
/// works end-to-end (see `ext:limun/99_test.js`).
fn op_test_add(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let a = args.get(0).integer_value(scope).unwrap_or(0);
    let b = args.get(1).integer_value(scope).unwrap_or(0);
    let sum = v8::Number::new(scope, (a + b) as f64);
    rv.set(sum.into());
}

/// `op_base64_btoa(input: String) -> String` — encodes a "binary string"
/// (every UTF-16 code unit ≤ U+00FF) to base64. If a code unit > 0xFF, throws
/// a `TypeError`; the JS layer converts that into a DOMException
/// ("InvalidCharacterError"). Spec-observable behavior (argument validation,
/// DOMString conversion, error types) lives in the JS layer; this op is just
/// encode.
///
/// `input` is a Rust `String` (UTF-8) here, but V8 hands us a Latin-1-checked
/// value: the JS layer does `String(input)` (DOMString conversion), and this
/// op validates each `char` is ≤ U+00FF before encoding the byte. We push the
/// Latin-1 bytes into a `Vec<u8>` and run the `base64` crate's STANDARD
/// engine.
fn op_base64_btoa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let input = args.get(0).to_rust_string_lossy(scope);

    let mut bytes = Vec::with_capacity(input.len());
    for c in input.chars() {
        let code = c as u32;
        if code > 0xFF {
            // Throw a TypeError — the JS layer catches this and rethrows as
            // DOMException("InvalidCharacterError", …). Matches Deno's
            // WebError::Base64Decode → DOMException conversion path (the
            // `#[class("DOMExceptionInvalidCharacterError")]` annotation
            // produces a DOMException in Deno; here the JS layer does it).
            let msg = v8::String::new(
                scope,
                "btoa: the string to be encoded contains characters outside of the Latin1 range",
            ).unwrap();
            let err = v8::Exception::type_error(scope, msg);
            scope.throw_exception(err);
            return;
        }
        bytes.push(code as u8);
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let s = v8::String::new(scope, &encoded).unwrap();
    rv.set(s.into());
}

/// `op_base64_atob(input: String) -> String` — decodes a *normalized*
/// base64 string (no whitespace, no `=`, validated length) to a "binary
/// string" (each output char's code unit is the decoded byte value,
/// 0-255). On invalid base64, throws a `TypeError`; the JS layer converts
/// that into a DOMException("InvalidCharacterError", …).
///
/// The JS layer (`ext:limun/05_base64.js`) does all spec-observable
/// validation: ASCII-whitespace stripping, padding stripping, length-%-4
/// checks, alphabet validation. This op receives a pure base64-alphabet
/// string and does the bit math (Infra "forgiving-base64 decode" step 5):
/// decode with `STANDARD_NO_PAD` (no `=` expected) and
/// `with_decode_allow_trailing_bits(true)` (discard leftover bits —
/// `YQ` and `YR` both decode to `"a"`).
fn op_base64_atob(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let input = args.get(0).to_rust_string_lossy(scope);

    let decoded = match FORGIVING.decode(input.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => {
            // Throw a TypeError — the JS layer catches and rethrows as
            // DOMException("InvalidCharacterError", …). Shouldn't happen
            // post-normalize, but be safe.
            let msg = v8::String::new(
                scope,
                "atob: invalid base64 string",
            ).unwrap();
            let err = v8::Exception::type_error(scope, msg);
            scope.throw_exception(err);
            return;
        }
    };

    // Build a "binary string": each char's code unit is the byte value
    // (0-255). `b as char` for b in 0..=255 yields U+0000..U+00FF, each a
    // single UTF-16 code unit — which is what a "binary string" is.
    let binary_string: String = decoded.iter().map(|&b| b as char).collect();
    let s = v8::String::new(scope, &binary_string).unwrap();
    rv.set(s.into());
}

/// Forgiving base64 decode engine: standard alphabet, no padding expected
/// (JS strips `=` before calling), trailing bits in the last symbol
/// silently discarded (Infra forgiving-base64 step 9: e.g. `YQ`/`YR` both
/// → `"a"`). Matches the Infra Standard's "forgiving-base64 decode".
const FORGIVING: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::GeneralPurposeConfig::new()
            .with_encode_padding(false)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true),
    );

/// Attach a native function to `target` under `name`. Local copy of
/// `web::mod::set_fn` — kept here so `ops` doesn't reach into `web`'s
/// private helpers (that `set_fn` is `pub(crate)`-private to `web`).
fn set_fn(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    target.set(scope, key.into(), func.into());
}