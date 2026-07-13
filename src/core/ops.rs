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