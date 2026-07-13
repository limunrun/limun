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
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{IsTerminal, Write};

use crate::core::event_loop;

/// Install the `__limunOps` namespace on `globalThis` with every registered
/// op attached. Called once from `core::mod::execute`, before internal JS
/// modules evaluate (so primordials/infra modules can call ops during
/// their top-level evaluation).
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);
    let ops = v8::Object::new(scope);

    set_fn(scope, ops, "op_test_add", op_test_add);
    set_fn(scope, ops, "op_print", op_print);
    set_fn(scope, ops, "op_is_proxy", op_is_proxy);
    set_fn(scope, ops, "op_base64_atob", op_base64_atob);
    set_fn(scope, ops, "op_base64_btoa", op_base64_btoa);
    set_fn(scope, ops, "op_encoding_normalize_label", op_encoding_normalize_label);
    set_fn(scope, ops, "op_encoding_decode_single", op_encoding_decode_single);
    set_fn(scope, ops, "op_encoding_new_decoder", op_encoding_new_decoder);
    set_fn(scope, ops, "op_encoding_decode", op_encoding_decode);
    set_fn(scope, ops, "op_encoding_decode_finish", op_encoding_decode_finish);
    set_fn(scope, ops, "op_encoding_encode_into", op_encoding_encode_into);
    set_fn(scope, ops, "op_timer_schedule", op_timer_schedule);
    set_fn(scope, ops, "op_timer_clear", op_timer_clear);
    set_fn(scope, ops, "op_queue_microtask", op_queue_microtask);
    set_fn(scope, ops, "op_now", op_now);
    set_fn(scope, ops, "op_time_origin", op_time_origin);
    set_fn(scope, ops, "op_prompt_alert", op_prompt_alert);
    set_fn(scope, ops, "op_prompt_confirm", op_prompt_confirm);
    set_fn(scope, ops, "op_prompt_prompt", op_prompt_prompt);
    set_fn(scope, ops, "op_prompt_is_tty", op_prompt_is_tty);

    // AbortSignal bridge ops — let Rust callers (fetch) read the JS-defined
    // `AbortSignal`'s state and register abort listeners without reaching
    // into JS private symbols. The JS class owns the spec surface; these
    // ops are thin bridges that call the public getters / `addEventListener`.
    set_fn(scope, ops, "op_abort_signal_is_aborted", op_abort_signal_is_aborted);
    set_fn(scope, ops, "op_abort_signal_get_reason", op_abort_signal_get_reason);
    set_fn(scope, ops, "op_abort_signal_add_listener", op_abort_signal_add_listener);

    // Fetch Standard — the async HTTP transport (reqwest + tokio + the
    // bridge channel). The spec surface lives entirely in JS
    // (`ext:limun/20_headers.js` through `ext:limun/23_fetch.js`); see
    // `web::fetch::op_fetch`'s doc comment.
    set_fn(scope, ops, "op_fetch", crate::web::fetch::op_fetch);

    // URL Standard ops — parse/reparse/serialize + search-params helpers.
    // The spec surface (the `URL`/`URLSearchParams` classes, getters,
    // setters, live linkage, WebIDL argument validation) lives in the JS
    // module `ext:limun/00_url.js`; these ops are the irreducible native
    // work (the `url` crate's parser, which is the same one Servo/Firefox
    // use). Flat: strings + a `Uint32Array` scratch buffer in, number
    // (status) / string out.
    set_fn(scope, ops, "op_url_parse", op_url_parse);
    set_fn(scope, ops, "op_url_parse_with_base", op_url_parse_with_base);
    set_fn(scope, ops, "op_url_get_serialization", op_url_get_serialization);
    set_fn(scope, ops, "op_url_reparse", op_url_reparse);
    set_fn(scope, ops, "op_url_parse_search_params", op_url_parse_search_params);
    set_fn(scope, ops, "op_url_stringify_search_params", op_url_stringify_search_params);

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

/// `op_is_proxy(value: any) -> boolean` — returns `true` iff `value` is a
/// `Proxy` (V8 `Value::is_proxy`). The one bit of irreducible native work
/// backing the shared WebIDL module's `createRecordConverter` fast path
/// (a Proxy with an own-keys trap would otherwise sneak past the
/// `for...in` + `ObjectHasOwn` loop). Pure spec — see
/// `ext:limun/00_webidl.js`'s `createRecordConverter`.
fn op_is_proxy(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let is_proxy = args.get(0).is_proxy();
    rv.set(v8::Boolean::new(scope, is_proxy).into());
}

/// `op_print(text: String, is_err: bool) -> undefined` — writes `text` to
/// stdout (`is_err: false`) or stderr (`is_err: true`). The irreducible
/// native work backing `console` (WHATWG Console Standard §2.1 "Printer").
/// All formatting, group indentation, table layout, and timer/count
/// state lives in `ext:limun/01_console.js`; this op only does the write.
/// `text` is a UTF-8 `String` (V8 → Rust lossy), printed with a trailing
/// newline (the JS layer does not include one — matches the previous
/// Rust impl, which used `println!`/`eprintln!`).
fn op_print(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let is_err = args.get(1).boolean_value(scope);
    if is_err {
        eprintln!("{text}");
    } else {
        println!("{text}");
    }
    rv.set(v8::undefined(scope).into());
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

// --- Text Encoding ops -----------------------------------------------------
//
// WHATWG Encoding Standard `TextEncoder`/`TextDecoder` backing ops. The
// spec surface (label normalization fast path, WebIDL argument validation,
// BOM/fatal/ignoreBOM option parsing, streaming state, error-type
// selection) lives in `ext:limun/08_text_encoding.js`. These ops are flat:
// bytes/strings/numbers in, string/number out. Errors are bare
// `TypeError`s; the JS layer catches and rethrows as the spec-correct
// exception (TypeError for fatal decode, RangeError for bad label).
//
// Streaming decode uses a thread-local registry of `encoding_rs::Decoder`
// handles: `op_encoding_new_decoder` allocates one and returns an integer
// id; `op_encoding_decode` feeds bytes through it; the JS layer calls
// `op_encoding_decode_finish` to drop the handle when a non-streaming
// `decode()` finalizes a run (or drops it itself on GC — but JS explicitly
// finalizes, matching Deno's `#handle = null` in the `finally` block).

/// Per-handle streaming decoder state. `fatal` is stored here so the
/// decode op doesn't need it passed every call (the JS layer knows it
/// per-instance but the Rust handle owns the run's decode mode).
struct StreamingDecoder {
    decoder: encoding_rs::Decoder,
    fatal: bool,
}

thread_local! {
    /// Map of active streaming decoder handles. The u32 id is returned to
    /// JS as a Number; JS holds it in a private field and passes it back to
    /// `op_encoding_decode`. Cleared by `op_encoding_decode_finish` (or
    /// leaks on process exit — same model as `WEAK_HANDLES`).
    static DECODER_REGISTRY: RefCell<HashMap<u32, StreamingDecoder>> =
        RefCell::new(HashMap::new());
    /// Monotonic id generator for `DECODER_REGISTRY`.
    static NEXT_DECODER_ID: RefCell<u32> = const { RefCell::new(1) };
}

fn alloc_decoder_id() -> u32 {
    NEXT_DECODER_ID.with(|id| {
        let mut id = id.borrow_mut();
        let cur = *id;
        *id = id.wrapping_add(1);
        cur
    })
}

/// Read bytes out of a JS value that's an `ArrayBufferView` or
/// `ArrayBuffer` (a `BufferSource` per Web IDL). Returns `None` for
/// anything else — the JS layer is expected to have validated the input
/// shape already, so `None` here means a bug in JS, not a user error.
/// Same helper as `web::native::read_buffer_source` but inlined here to
/// keep `core::ops` self-contained.
fn read_bytes(value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    if let Ok(view) = <v8::Local<v8::ArrayBufferView>>::try_from(value) {
        let mut bytes = vec![0u8; view.byte_length()];
        view.copy_contents(&mut bytes);
        return Some(bytes);
    }
    if let Ok(ab) = <v8::Local<v8::ArrayBuffer>>::try_from(value) {
        let len = ab.byte_length();
        let data = ab.data()?;
        return Some(unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, len) }.to_vec());
    }
    None
}

/// `op_encoding_normalize_label(label: String) -> String` — resolves a
/// WHATWG encoding label to its canonical lowercase name via
/// `encoding_rs::Encoding::for_label_no_replacement`. Returns `None` (as
/// a thrown TypeError) for unknown labels and the `replacement` encoding
/// (and its aliases like `iso-2022-kr`), both of which the spec rejects
/// with a `RangeError` — the JS layer catches the TypeError and rethrows
/// as RangeError. `for_label_no_replacement` already does the spec's
/// ASCII-case-insensitive + ASCII-whitespace-trim normalization, so we
/// feed it the raw JS string bytes.
fn op_encoding_normalize_label(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let label = args.get(0).to_rust_string_lossy(scope);
    let Some(encoding) = encoding_rs::Encoding::for_label_no_replacement(label.as_bytes()) else {
        let msg = v8::String::new(
            scope,
            &format!("TextDecoder: unsupported encoding label \"{label}\""),
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };
    // encoding_rs returns canonical names in its own casing ("UTF-8",
    // "Shift_JIS", "UTF-16LE"). The WHATWG canonical names are lowercase,
    // which is what `TextDecoder.encoding` must expose.
    let name = encoding.name().to_ascii_lowercase();
    let s = v8::String::new(scope, &name).unwrap();
    rv.set(s.into());
}

/// `op_encoding_decode_single(bytes: Uint8Array, encoding_name: String,
/// fatal: bool, ignore_bom: bool) -> String` — one-shot decode (no
/// streaming). Creates a fresh decoder, feeds all bytes with `last =
/// true`, returns the decoded string. On `fatal: true` + malformed input,
/// throws a TypeError (the JS layer surfaces it directly — TextDecoder's
/// fatal mode throws TypeError per spec).
fn op_encoding_decode_single(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let bytes = match read_bytes(args.get(0)) {
        Some(b) => b,
        None => Vec::new(),
    };
    let encoding_name = args.get(1).to_rust_string_lossy(scope);
    let fatal = args.get(2).boolean_value(scope);
    let ignore_bom = args.get(3).boolean_value(scope);

    let Some(encoding) = encoding_rs::Encoding::for_label(encoding_name.as_bytes()) else {
        let msg = v8::String::new(
            scope,
            &format!("decode: unsupported encoding \"{encoding_name}\""),
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    let mut decoder = if ignore_bom {
        encoding.new_decoder_without_bom_handling()
    } else {
        encoding.new_decoder_with_bom_removal()
    };

    let text: String = if fatal {
        let cap = decoder
            .max_utf8_buffer_length_without_replacement(bytes.len())
            .unwrap_or(0);
        let mut out = String::with_capacity(cap);
        let (result, _read) = decoder.decode_to_string_without_replacement(&bytes, &mut out, true);
        match result {
            encoding_rs::DecoderResult::InputEmpty => out,
            encoding_rs::DecoderResult::Malformed(_, _) => {
                let msg = v8::String::new(
                    scope,
                    "decode: invalid byte sequence (fatal: true)",
                ).unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
            encoding_rs::DecoderResult::OutputFull => {
                let msg = v8::String::new(
                    scope,
                    "decode: output buffer too small (fatal: true)",
                ).unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        }
    } else {
        let cap = decoder.max_utf8_buffer_length(bytes.len()).unwrap_or(0);
        let mut out = String::with_capacity(cap);
        let (_result, _read, _had_errors) = decoder.decode_to_string(&bytes, &mut out, true);
        out
    };

    let s = v8::String::new(scope, &text).unwrap();
    rv.set(s.into());
}

/// `op_encoding_new_decoder(encoding_name: String, fatal: bool,
/// ignore_bom: bool) -> number` — allocate a streaming decoder handle,
/// store it in the thread-local registry, return its integer id. The JS
/// layer holds the id in a private field and passes it to
/// `op_encoding_decode`.
fn op_encoding_new_decoder(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let encoding_name = args.get(0).to_rust_string_lossy(scope);
    let fatal = args.get(1).boolean_value(scope);
    let ignore_bom = args.get(2).boolean_value(scope);

    let Some(encoding) = encoding_rs::Encoding::for_label(encoding_name.as_bytes()) else {
        let msg = v8::String::new(
            scope,
            &format!("decode: unsupported encoding \"{encoding_name}\""),
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    let decoder = if ignore_bom {
        encoding.new_decoder_without_bom_handling()
    } else {
        encoding.new_decoder_with_bom_removal()
    };

    let id = alloc_decoder_id();
    DECODER_REGISTRY.with(|reg| {
        reg.borrow_mut().insert(id, StreamingDecoder { decoder, fatal });
    });

    rv.set(v8::Number::new(scope, id as f64).into());
}

/// `op_encoding_decode(bytes: Uint8Array, handle_id: number,
/// stream: bool) -> String` — feed `bytes` through the streaming decoder
/// identified by `handle_id`. `stream: true` keeps the decoder alive for
/// the next call (retains partial-sequence state); `stream: false`
/// finalizes the run (flushes any trailing partial sequence as U+FFFD or
/// a fatal TypeError). The JS layer drops the handle with
/// `op_encoding_decode_finish` when a non-streaming `decode()` ends a
/// run. On fatal error, the handle is dropped here (the run is over).
fn op_encoding_decode(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let bytes = read_bytes(args.get(0)).unwrap_or_default();
    let handle_id = args.get(1).integer_value(scope).unwrap_or(0) as u32;
    let stream = args.get(2).boolean_value(scope);
    let last = !stream;

    let text: String = DECODER_REGISTRY.with(|reg| {
        let mut reg = reg.borrow_mut();
        let Some(entry) = reg.get_mut(&handle_id) else {
            // JS layer passed a stale/unknown handle — treat as empty.
            return String::new();
        };
        let StreamingDecoder { decoder, fatal } = entry;
        let fatal = *fatal;
        if fatal {
            let cap = decoder
                .max_utf8_buffer_length_without_replacement(bytes.len())
                .unwrap_or(0);
            let mut out = String::with_capacity(cap);
            let (result, _read) = decoder.decode_to_string_without_replacement(&bytes, &mut out, last);
            match result {
                encoding_rs::DecoderResult::InputEmpty => out,
                encoding_rs::DecoderResult::Malformed(_, _) => {
                    // Fatal error — the JS layer's catch block calls
                    // `op_encoding_decode_finish` to drop the handle. We
                    // don't drop it here to avoid a double-remove (the JS
                    // layer always finalizes on error). Return a sentinel
                    // string; the outer frame throws the TypeError.
                    return String::from("\u{FFFF}\u{FFFF}__FATAL__");
                }
                encoding_rs::DecoderResult::OutputFull => {
                    return String::from("\u{FFFF}\u{FFFF}__OVERFLOW__");
                }
            }
        } else {
            let cap = decoder.max_utf8_buffer_length(bytes.len()).unwrap_or(0);
            let mut out = String::with_capacity(cap);
            let (_result, _read, _had_errors) = decoder.decode_to_string(&bytes, &mut out, last);
            out
        }
    });

    // Handle fatal-error sentinels from the closure (couldn't throw inside
    // because `scope` was borrowed alongside the registry RefMut).
    if text == "\u{FFFF}\u{FFFF}__FATAL__" {
        let msg = v8::String::new(
            scope,
            "decode: invalid byte sequence (fatal: true)",
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }
    if text == "\u{FFFF}\u{FFFF}__OVERFLOW__" {
        let msg = v8::String::new(
            scope,
            "decode: output buffer too small (fatal: true)",
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let s = v8::String::new(scope, &text).unwrap();
    rv.set(s.into());
}

/// `op_encoding_decode_finish(handle_id: number) -> undefined` — drop a
/// streaming decoder handle from the registry. Called by the JS layer in
/// the `finally` block of `decode()` when `stream` is false (finalizing a
/// run). No-op if the handle was already dropped (e.g. by a fatal error).
fn op_encoding_decode_finish(
    _scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle_id = args.get(0).integer_value(_scope).unwrap_or(0) as u32;
    DECODER_REGISTRY.with(|reg| {
        reg.borrow_mut().remove(&handle_id);
    });
    rv.set(v8::undefined(_scope).into());
}

/// `op_encoding_encode_into(input: String, dest: Uint8Array) -> Number` —
/// encodes as much of `input` as fits into `dest` without splitting a
/// UTF-8 scalar value's bytes across the boundary. Returns a packed
/// Number: `read * 2^32 + written`, where `read` is the number of UTF-16
/// code units consumed and `written` is the number of bytes written into
/// `dest`. The JS layer unpacks this. A `read` of `-1` (sentinel) signals
/// "use fallback" — but Limun's simpler impl always succeeds (no
/// fast-path overflow), so the sentinel is never returned.
///
/// Matches Deno's packing scheme (read in high 32 bits, written in low 32)
/// so the JS unpacking code can be identical.
fn op_encoding_encode_into(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let input = args.get(0).to_rust_string_lossy(scope);
    let Ok(view): Result<v8::Local<v8::ArrayBufferView>, _> = args.get(1).try_into() else {
        let msg = v8::String::new(
            scope,
            "encodeInto: destination must be a Uint8Array",
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    let dest_len = view.byte_length();
    let bytes = input.as_bytes();
    let max = dest_len.min(bytes.len());
    let mut written = max;
    while written > 0 && !input.is_char_boundary(written) {
        written -= 1;
    }

    if written > 0 {
        let data_ptr = view.data() as *mut u8;
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), data_ptr, written) };
    }
    // `read` = number of UTF-16 code units in the consumed prefix (matches
    // Deno/the spec: `read` is in UTF-16 code units, not bytes).
    let read = input[..written].encode_utf16().count();

    let packed = (read as f64) * ((1u64 << 32) as f64) + (written as f64);
    rv.set(v8::Number::new(scope, packed).into());
}

// --- Timers ops ------------------------------------------------------------
//
// WHATWG HTML `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/
// `queueMicrotask` backing ops. The spec surface (the `this` check,
// WebIDL `long` coercion of the timeout, string-callback indirect eval,
// extra-args handling, numeric ID exposure) lives in the JS module
// `ext:limun/02_timers.js`. These ops are flat: a JS callback + delay +
// repeat flag in, numeric ID out; an ID in, nothing out. The timer
// scheduling machinery (timer wheel, tokio integration, callback
// execution) stays in `core::event_loop` — it's irreducible native work
// (thread coordination, tokio runtime, binary heap of deadlines).
//
// `op_timer_schedule` is a `FunctionCallback` (not a flat "primitive in,
// primitive out" op) because the callback is a `v8::Function` that must
// be captured as a `v8::Global<v8::Function>` and handed to
// `event_loop::schedule`. This is the same pattern the previous Rust
// `web::timers` module used — just relocated here and renamed.

/// `op_timer_schedule(callback: Function, delay: number, repeat: boolean,
/// ...args) -> number` — capture the callback + extra args, call
/// `event_loop::schedule`, return the numeric timer ID. `delay` is in
/// milliseconds (the JS layer has already done WebIDL `long` coercion;
/// `event_loop::schedule` clamps negatives to 0). `repeat = true` arms an
/// interval (re-fires every `delay` ms); `repeat = false` arms a one-shot.
fn op_timer_schedule(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // The callback must be a function — the JS layer has validated this
    // (string-callback eval is resolved to a function in JS before calling
    // this op). A non-function here is a JS-layer bug, not a user error;
    // match the previous Rust behavior and return a 0 (no-op) handle.
    let Ok(callback): Result<v8::Local<v8::Function>, _> = args.get(0).try_into() else {
        rv.set(v8::Number::new(scope, 0.0).into());
        return;
    };

    let delay_ms = args.get(1).number_value(scope).unwrap_or(0.0);
    let repeat = args.get(2).boolean_value(scope);

    // Extra arguments (setTimeout(fn, ms, a, b) -> fn(a, b)) per spec.
    // Starts at index 3: callback, delay, repeat, ...args.
    let extra_args: Vec<v8::Global<v8::Value>> = (3..args.length())
        .map(|i| v8::Global::new(scope, args.get(i)))
        .collect();

    let callback_global = v8::Global::new(scope, callback);
    let id = event_loop::schedule(callback_global, extra_args, delay_ms, repeat);
    rv.set(v8::Number::new(scope, id as f64).into());
}

/// `op_timer_clear(id: number) -> undefined` — cancel a scheduled timer.
/// No-op on unknown ids, matches spec. The JS layer has already coerced
/// `id` to a number and validated it's finite and ≥ 0.
fn op_timer_clear(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if let Some(id) = args.get(0).number_value(scope) {
        if id.is_finite() && id >= 0.0 {
            event_loop::clear(id as u32);
        }
    }
    rv.set(v8::undefined(scope).into());
}

/// `op_queue_microtask(callback: Function) -> undefined` — enqueue
/// `callback` directly on V8's microtask queue (not the timer wheel; runs
/// before any timer, same tick). The JS layer has validated the callback
/// is a function. Cannot be done in pure JS — V8 doesn't expose
/// `enqueueMicrotask` to JS directly (the primordials' `queueMicrotask`
/// slot is wired to this op by `02_timers.js`).
fn op_queue_microtask(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if let Ok(callback) = <v8::Local<v8::Function>>::try_from(args.get(0)) {
        scope.enqueue_microtask(callback);
    }
    rv.set(v8::undefined(scope).into());
}

// --- High Resolution Time ops ----------------------------------------------
//
// W3C HR Time L3 `performance.now()`/`performance.timeOrigin` backing ops.
// The spec surface (the `performance` singleton, the `Performance`
// interface shape, `toJSON`) lives in `ext:limun/15_performance.js`; these
// ops are flat clock reads — the irreducible native work (accessing the
// monotonic + wall clocks). The clock anchors themselves live in
// `web::performance` (shared with `02_event.js` for `Event.timeStamp`,
// which calls `op_now` at construction time).

/// `op_now() -> f64` — monotonic milliseconds since the time origin
/// (first clock access). Backs `performance.now()`. Never decreases
/// (monotonic clock, immune to system-clock adjustments). Per spec §7.1
/// returns a `DOMHighResTimeStamp` (a duration from the time origin).
fn op_now(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Number::new(scope, crate::web::performance::now_value()).into());
}

/// `op_time_origin() -> f64` — Unix-epoch wall-clock milliseconds at the
/// time origin. Backs `performance.timeOrigin`. Stable across reads (spec
/// §7.2 — the same value every call; the anchor is captured once).
fn op_time_origin(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Number::new(scope, crate::web::performance::time_origin_value()).into());
}

// --- User-prompt ops -------------------------------------------------------
//
// WHATWG HTML user-prompt globals (`alert`/`confirm`/`prompt`) backing ops.
// The spec surface (argument coercion, default values, return shaping) lives
// in `ext:limun/41_prompt.js`; these ops are the irreducible native work:
// writing the prompt to stderr, reading a line from stdin, returning the
// raw answer. The JS layer decides whether stdin is a terminal (non-TTY
// → no-op/false/null) by calling `op_prompt_is_tty` once at module load.
//
// Models after the previous Rust `web::prompt` module (now removed): stderr
// for prompt text so it doesn't pollute stdout pipelines; stdin `read_line`
// for the answer; EOF or read error → empty string (treated as no input).

/// `op_prompt_is_tty() -> bool` — returns `true` if stdin is a terminal.
/// Called once at module load to cache the answer (matches the previous
/// Rust behavior, which checked `stdin().is_terminal()` at each call — but
/// the answer is stable for the process lifetime, so caching is safe).
fn op_prompt_is_tty(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Boolean::new(scope, std::io::stdin().is_terminal()).into());
}

/// `op_prompt_alert(message: String) -> undefined` — writes `message + "
/// [Enter] "` to stderr (no trailing newline — the prompt sits on the same
/// line as the user's Enter), blocks for one line of stdin. The JS layer
/// guards with the TTY check before calling; the op just does the IO.
fn op_prompt_alert(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let message = args.get(0).to_rust_string_lossy(scope);
    let line = format!("{message} [Enter] ");
    let _ = write_err(&line);
    let _ = read_line();
    rv.set(v8::undefined(scope).into());
}

/// `op_prompt_confirm(message: String) -> bool` — writes `message + " [y/N]
/// "` to stderr, reads one line, returns `true` only if the trimmed answer
/// is exactly `y` or `Y`. The JS layer guards with the TTY check.
fn op_prompt_confirm(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let message = args.get(0).to_rust_string_lossy(scope);
    let line = format!("{message} [y/N] ");
    let _ = write_err(&line);
    let answer = read_line().unwrap_or_default();
    let yes = answer.trim() == "y" || answer.trim() == "Y";
    rv.set(v8::Boolean::new(scope, yes).into());
}

/// `op_prompt_prompt(message: String, default: String) -> String|null` —
/// writes `message` (already formatted with trailing space by JS) to
/// stderr, reads one line. Empty input + non-empty `default` → returns
/// `default`; otherwise returns the trimmed input; EOF → null. The JS
/// layer guards with the TTY check and does argument coercion.
fn op_prompt_prompt(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let message = args.get(0).to_rust_string_lossy(scope);
    let default_value = args.get(1).to_rust_string_lossy(scope);
    let _ = write_err(&message);
    let input = match read_line() {
        Some(s) => s,
        None => {
            rv.set(v8::null(scope).into());
            return;
        }
    };
    let trimmed = input.trim_end_matches(['\n', '\r']);
    let result = if trimmed.is_empty() && args.length() > 1 {
        default_value
    } else {
        trimmed.to_string()
    };
    rv.set(v8::String::new(scope, &result).unwrap().into());
}

/// Write `text` to stderr and flush. Returns `Err` on IO failure (the
/// caller ignores it — a failed prompt is a best-effort no-op, matching the
/// previous Rust behavior).
fn write_err(text: &str) -> std::io::Result<()> {
    let mut stderr = std::io::stderr().lock();
    stderr.write_all(text.as_bytes())?;
    stderr.flush()?;
    Ok(())
}

/// Read one line from stdin. Returns `None` on EOF or read error (matches
/// the previous Rust `wait_for_line`).
fn read_line() -> Option<String> {
    let mut buf = String::new();
    match std::io::stdin().read_line(&mut buf) {
        Ok(0) => None,
        Ok(_) => Some(buf),
        Err(_) => None,
    }
}

// --- AbortSignal bridge ops ----------------------------------------------
//
// The `AbortSignal` class is defined in JS (`ext:limun/02_event.js`); its
// state (`aborted`/`reason`) lives in private JS symbols. Rust callers
// (fetch, for cancellation) need to (a) check whether a signal object is
// aborted, (b) read its reason, and (c) register a native callback that
// fires when the signal aborts. Rather than expose the private symbols or
// duplicate state in a Rust table, these ops bridge by calling the JS
// public getters / `addEventListener` from within the op. The signal is
// passed as the first argument; the op re-enters JS via a `tc_scope!` to
// read `signal.aborted` / `signal.reason` or call
// `signal.addEventListener("abort", cb, {once:true})`.
//
// `op_abort_signal_add_listener` captures the callback as a
// `Global<Function>` so it survives across the op boundary; the JS
// `addEventListener` stores it in the listener map and dispatches it when
// the abort event fires (same path as any user-registered listener).
//
// The `pub(crate)` helpers below the op wrappers let Rust callers (fetch)
// bridge without a `__limunOps` lookup round-trip — they take `Local`s
// directly and call the JS getters / `addEventListener` via a `tc_scope`.

/// `op_abort_signal_is_aborted(signal: object) -> bool` — read the JS
/// `signal.aborted` getter. Returns `false` if `signal` isn't an object
/// or the getter throws / returns a non-boolean.
fn op_abort_signal_is_aborted(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(signal) = <v8::Local<v8::Object>>::try_from(args.get(0)) else {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    };
    let aborted = abort_signal_is_aborted(scope, signal);
    rv.set(v8::Boolean::new(scope, aborted).into());
}

/// `op_abort_signal_get_reason(signal: object) -> value` — read the JS
/// `signal.reason` getter. Returns `undefined` if `signal` isn't an
/// object or the getter throws.
fn op_abort_signal_get_reason(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(signal) = <v8::Local<v8::Object>>::try_from(args.get(0)) else {
        rv.set(v8::undefined(scope).into());
        return;
    };
    let reason = abort_signal_get_reason(scope, signal).unwrap_or_else(|| v8::undefined(scope).into());
    rv.set(reason);
}

/// `op_abort_signal_add_listener(signal: object, callback: Function) ->
/// undefined` — register `callback` as a one-shot `"abort"` listener on
/// the JS `signal` via its public `addEventListener`. Used by fetch to
/// wire cancellation: the callback removes the pending task, rejects the
/// promise, and cancels the tokio task.
fn op_abort_signal_add_listener(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(signal) = <v8::Local<v8::Object>>::try_from(args.get(0)) else {
        rv.set(v8::undefined(scope).into());
        return;
    };
    let Ok(callback) = <v8::Local<v8::Function>>::try_from(args.get(1)) else {
        rv.set(v8::undefined(scope).into());
        return;
    };
    abort_signal_add_listener(scope, signal, callback);
    rv.set(v8::undefined(scope).into());
}

// --- AbortSignal bridge helpers (pub(crate) — callable from fetch) --------

/// Read the JS `signal.aborted` getter. Returns `false` if the getter
/// throws or `signal` isn't a valid object. Re-enters JS via a `tc_scope`
/// to invoke the getter — the JS class owns the state in a private
/// symbol; this is the only way to read it from Rust.
pub(crate) fn abort_signal_is_aborted(
    scope: &mut v8::PinScope,
    signal: v8::Local<v8::Object>,
) -> bool {
    v8::tc_scope!(let tc, scope);
    let key = v8::String::new(tc, "aborted").unwrap();
    let v = signal.get(tc, key.into()).unwrap_or_else(|| v8::Boolean::new(tc, false).into());
    let aborted = v.boolean_value(tc);
    if tc.has_caught() { tc.reset(); }
    aborted
}

/// Read the JS `signal.reason` getter. Returns `None` if the getter
/// throws or `signal` isn't a valid object. The returned `Local<Value>`
/// is the abort reason (any JS value — `DOMException`, `Error`, string,
/// `undefined` for a non-aborted signal).
pub(crate) fn abort_signal_get_reason<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    signal: v8::Local<v8::Object>,
) -> Option<v8::Local<'s, v8::Value>> {
    v8::tc_scope!(let tc, scope);
    let key = v8::String::new(tc, "reason").unwrap();
    let v = signal.get(tc, key.into());
    if tc.has_caught() {
        tc.reset();
        return None;
    }
    v
}

/// Register `callback` as a one-shot `"abort"` listener on the JS
/// `signal` via its public `addEventListener`. Re-enters JS to call
/// `signal.addEventListener("abort", callback, {once:true})`. Used by
/// `fetch()` to wire cancellation: the callback removes the pending
/// task, rejects the promise, and cancels the tokio task.
pub(crate) fn abort_signal_add_listener(
    scope: &mut v8::PinScope,
    signal: v8::Local<v8::Object>,
    callback: v8::Local<v8::Function>,
) {
    v8::tc_scope!(let tc, scope);
    let ael_key = v8::String::new(tc, "addEventListener").unwrap();
    let Some(ael) = signal.get(tc, ael_key.into()) else {
        return;
    };
    let Ok(ael_fn) = <v8::Local<v8::Function>>::try_from(ael) else {
        return;
    };
    let type_key = v8::String::new(tc, "abort").unwrap();
    // `{ once: true }` — the listener auto-removes after firing.
    let opts = v8::Object::new(tc);
    let once_key = v8::String::new(tc, "once").unwrap();
    opts.set(tc, once_key.into(), v8::Boolean::new(tc, true).into());
    let _ = ael_fn.call(tc, signal.into(), &[type_key.into(), callback.into(), opts.into()]);
    if tc.has_caught() { tc.reset(); }
}

// --- URL Standard ops -------------------------------------------------------
//
// WHATWG URL Standard `URL`/`URLSearchParams` backing ops. The spec surface
// (the class shapes, getters, setters, live `searchParams` linkage, WebIDL
// argument validation, `canParse`/`parse` static methods) lives in the JS
// module `ext:limun/00_url.js`; these ops are the irreducible native work —
// the `url` crate's parser (rust-url, same one Servo/Firefox use).
//
// Ports Deno's `ext/web/url.rs` ops, adapted to Limun's flat-op model (no
// `op2`, no `OpState`, no `#[buffer]` macro). The JS side passes a
// `Uint32Array` scratch buffer (`componentsBuf`, 8 elements) as one of the
// args; the op writes the 8 internal component offsets into it and returns
// a status number:
//   0 = Ok            — parse succeeded, serialization == input href (the
//                       JS side can use the input href as-is).
//   1 = OkSerialization — parse succeeded, serialization != input href; the
//                       serialized string is stashed in a thread-local and
//                       the JS side fetches it via `op_url_get_serialization`.
//   2 = Err           — parse failed (the JS side throws TypeError).
//
// The thread-local `URL_SERIALIZATION` stash mirrors Deno's
// `state.put(UrlSerialization(…))` — the *only* way to carry a String from
// the parse op to the JS side without an extra return slot. It's
// single-slot (overwritten on each parse/reparse), which is safe because
// the JS side calls `op_url_get_serialization` immediately after a
// `OkSerialization` status, before any other parse op runs.
//
// `op_url_parse_search_params` / `op_url_stringify_search_params` handle
// the `application/x-www-form-urlencoded` parse/serialize. The parse op
// returns a flat `v8::Array` of `[key, value]` string-pairs (a data-only
// array — no spec-observable V8 object crosses the boundary, just strings
// in a list). The stringify op takes the same shape back and produces the
// serialized query string. This matches Deno's
// `Vec<(String, String)>` in/out, just built by hand (no serde_v8).
//
// Setter codes (must match the JS `SET_*` constants):
//   0=hash 1=host 2=hostname 3=password 4=pathname 5=port 6=protocol
//   7=search 8=username.

// `URL_SERIALIZATION` — thread-local stash for the serialized URL when it
// differs from the input href (status `OkSerialization`). Single slot —
// see the section comment above on why that's safe.
thread_local! {
    static URL_SERIALIZATION: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Status codes returned by `op_url_parse` / `op_url_parse_with_base` /
/// `op_url_reparse`.
const URL_OK: u32 = 0;
const URL_OK_SERIALIZATION: u32 = 1;
const URL_ERR: u32 = 2;

/// `NO_PORT` sentinel — a port cannot exceed 2^16-1, so 65536 means "no
/// port". Matches Deno's `NO_PORT` constant and the JS-side `NO_PORT`.
const NO_PORT: u32 = 65536;

/// Write the 8 internal component offsets of `url` into the `Uint32Array`
/// scratch buffer `buf` (passed as arg `buf_idx`). Returns `URL_OK` if
/// `url`'s serialization equals `href` (the JS side can reuse the input),
/// or `URL_OK_SERIALIZATION` after stashing the serialization in the
/// thread-local. Caller passes the raw `href` so we can compare without
/// re-serializing a `&Url`.
fn fill_components_and_status(
    url: &::url::Url,
    href: &str,
    buf: v8::Local<v8::ArrayBufferView>,
) -> u32 {
    let inner = ::url::quirks::internal_components(url);
    // SAFETY: `buf` is a `Uint32Array` with ≥8 elements (the JS side
    // allocates `new Uint32Array(8)` once and reuses it). `data()` returns
    // a pointer to the view's storage (byte_offset already applied). We
    // write 8 u32s = 32 bytes, which fits the 32-byte view.
    let ptr = buf.data() as *mut u32;
    unsafe {
        *ptr.add(0) = inner.scheme_end;
        *ptr.add(1) = inner.username_end;
        *ptr.add(2) = inner.host_start;
        *ptr.add(3) = inner.host_end;
        *ptr.add(4) = inner.port.map(|p| p as u32).unwrap_or(NO_PORT);
        *ptr.add(5) = inner.path_start;
        *ptr.add(6) = inner.query_start.unwrap_or(0);
        *ptr.add(7) = inner.fragment_start.unwrap_or(0);
    }
    let serialization: String = url.to_string();
    if serialization == href {
        URL_OK
    } else {
        URL_SERIALIZATION.with(|s| *s.borrow_mut() = Some(serialization));
        URL_OK_SERIALIZATION
    }
}

/// Read the `Uint32Array` scratch buffer from args at index `buf_idx`.
/// Returns `None` if the arg isn't a typed array view (a JS-layer bug, not
/// a user error — the JS side always passes `componentsBuf`).
fn get_components_buf<'a>(
    args: &'a v8::FunctionCallbackArguments<'a>,
    buf_idx: i32,
) -> Option<v8::Local<'a, v8::ArrayBufferView>> {
    <v8::Local<v8::ArrayBufferView>>::try_from(args.get(buf_idx)).ok()
}

/// `op_url_parse(href: String, buf: Uint32Array) -> u32` — parse `href`
/// with no base URL. Fills `buf` with the 8 component offsets and returns a
/// status code (see the section comment). On parse failure returns
/// `URL_ERR` (no components written, no stash set).
fn op_url_parse(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let href = args.get(0).to_rust_string_lossy(scope);
    let Some(buf) = get_components_buf(&args, 1) else {
        rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        return;
    };
    match ::url::Url::parse(&href) {
        Ok(url) => {
            let status = fill_components_and_status(&url, &href, buf);
            rv.set(v8::Number::new(scope, status as f64).into());
        }
        Err(_) => {
            rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        }
    }
}

/// `op_url_parse_with_base(href: String, base: String, buf: Uint32Array)
/// -> u32` — parse `href` against `base`. Same status convention as
/// `op_url_parse`. If `base` itself fails to parse, returns `URL_ERR`.
fn op_url_parse_with_base(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let href = args.get(0).to_rust_string_lossy(scope);
    let base_str = args.get(1).to_rust_string_lossy(scope);
    let Some(buf) = get_components_buf(&args, 2) else {
        rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        return;
    };
    let Ok(base_url) = ::url::Url::parse(&base_str) else {
        rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        return;
    };
    match ::url::Url::options().base_url(Some(&base_url)).parse(&href) {
        Ok(url) => {
            let status = fill_components_and_status(&url, &href, buf);
            rv.set(v8::Number::new(scope, status as f64).into());
        }
        Err(_) => {
            rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        }
    }
}

/// `op_url_get_serialization() -> String` — return the stashed
/// serialization from the last `OkSerialization` parse/reparse, then clear
/// the stash. Called by the JS side immediately after a `OkSerialization`
/// status. Returns the empty string if the stash is empty (shouldn't
/// happen in correct use, but be safe).
fn op_url_get_serialization(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let s = URL_SERIALIZATION.with(|cell| cell.borrow_mut().take()).unwrap_or_default();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

/// `op_url_reparse(href: String, setter: u32, value: String, buf:
/// Uint32Array) -> u32` — re-parse `href`, apply the component `setter` with
/// `value`, fill `buf` with the new component offsets, and return a
/// status. `setter` is one of the `UrlSetter` codes (0–8). For setters
/// that can fail (`host`/`hostname`/`password`/`port`/`protocol`/
/// `username`), a failure returns `URL_ERR` (spec: component setters
/// silently no-op on failure — the JS side catches and ignores). For
/// `hash`/`pathname`/`search` (which can't fail), always returns `URL_OK`
/// or `URL_OK_SERIALIZATION`.
fn op_url_reparse(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let href = args.get(0).to_rust_string_lossy(scope);
    let setter = args.get(1).uint32_value(scope).unwrap_or(99) as u8;
    let value = args.get(2).to_rust_string_lossy(scope);
    let Some(buf) = get_components_buf(&args, 3) else {
        rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        return;
    };

    let Ok(mut url) = ::url::Url::parse(&href) else {
        rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        return;
    };

    use ::url::quirks;
    let result: Result<(), ()> = match setter {
        0 => { quirks::set_hash(&mut url, &value); Ok(()) }          // hash
        1 => quirks::set_host(&mut url, &value),                      // host
        2 => quirks::set_hostname(&mut url, &value),                  // hostname
        3 => quirks::set_password(&mut url, &value),                  // password
        4 => { quirks::set_pathname(&mut url, &value); Ok(()) }       // pathname
        5 => quirks::set_port(&mut url, &value),                      // port
        6 => quirks::set_protocol(&mut url, &value),                  // protocol
        7 => { quirks::set_search(&mut url, &value); Ok(()) }        // search
        8 => quirks::set_username(&mut url, &value),                  // username
        _ => Err(()),
    };

    if result.is_err() {
        rv.set(v8::Number::new(scope, URL_ERR as f64).into());
        return;
    }
    let status = fill_components_and_status(&url, &href, buf);
    rv.set(v8::Number::new(scope, status as f64).into());
}

/// `op_url_parse_search_params(query: String) -> Array<[String, String]>`
/// — parse `query` (a query string, no leading `?`) as
/// `application/x-www-form-urlencoded` and return a flat `v8::Array` of
/// `[key, value]` string-pairs. The JS side reads it as an array of
/// 2-element string arrays. Empty query → empty array.
fn op_url_parse_search_params(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let query = args.get(0).to_rust_string_lossy(scope);
    let pairs: Vec<(String, String)> = ::url::form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let arr = v8::Array::new(scope, pairs.len() as i32);
    for (i, (k, v)) in pairs.into_iter().enumerate() {
        let pair = v8::Array::new(scope, 2);
        let k_str = v8::String::new(scope, &k).unwrap();
        let v_str = v8::String::new(scope, &v).unwrap();
        pair.set_index(scope, 0, k_str.into());
        pair.set_index(scope, 1, v_str.into());
        arr.set_index(scope, i as u32, pair.into());
    }
    rv.set(arr.into());
}

/// `op_url_stringify_search_params(pairs: Array<[String, String]>) ->
/// String` — serialize `pairs` (a `v8::Array` of `[key, value]` string
/// pairs) as `application/x-www-form-urlencoded` and return the query
/// string (no leading `?`). The JS side passes its `_list` array directly.
fn op_url_stringify_search_params(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(arr) = <v8::Local<v8::Array>>::try_from(args.get(0)) else {
        rv.set(v8::String::new(scope, "").unwrap().into());
        return;
    };
    let len = arr.length();
    let mut ser = ::url::form_urlencoded::Serializer::new(String::new());
    for i in 0..len {
        let Some(pair_val) = arr.get_index(scope, i) else { continue };
        let Ok(pair) = <v8::Local<v8::Array>>::try_from(pair_val) else { continue };
        let k = pair.get_index(scope, 0).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
        let v = pair.get_index(scope, 1).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
        ser.append_pair(&k, &v);
    }
    let out = ser.finish();
    rv.set(v8::String::new(scope, &out).unwrap().into());
}