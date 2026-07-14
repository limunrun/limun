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

// Trait imports for V8's structured-clone delegate. `ValueSerializer` /
// `ValueDeserializer` expose `write_header` / `read_header` /
// `transfer_array_buffer` / `write_value` / `read_value` through these
// helper traits (the impls forward to the pinned C++ delegate), so the
// traits must be in scope to call the methods.
use v8::ValueDeserializerHelper;
use v8::ValueSerializerHelper;

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
    set_fn(scope, ops, "op_navigator_hardware_concurrency", op_navigator_hardware_concurrency);
    set_fn(scope, ops, "op_navigator_platform", op_navigator_platform);
    set_fn(scope, ops, "op_base64_atob", op_base64_atob);
    set_fn(scope, ops, "op_base64_btoa", op_base64_btoa);
    set_fn(scope, ops, "op_compression_new", op_compression_new);
    set_fn(scope, ops, "op_compression_write", op_compression_write);
    set_fn(scope, ops, "op_compression_finish", op_compression_finish);
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

    // Structured clone / MessagePort — V8 `ValueSerializer`/`ValueDeserializer`
    // backing ops. The spec surface (`structuredClone` global,
    // `MessageChannel`/`MessagePort`/`MessageEvent`, transfer-list validation,
    // JS-side message queues for single-realm delivery) lives in the JS
    // modules `ext:limun/02_structured_clone.js` and
    // `ext:limun/13_message_port.js`. These three ops are the irreducible
    // native work: V8's structured-clone wire format (serialize to bytes,
    // deserialize back), with host-object brand callbacks (for MessagePort
    // transfer) and `ArrayBuffer` transfer (detach on serialize, mint fresh
    // backing stores on deserialize).
    //
    // Limun has no `SharedArrayBuffer` and no Wasm module store, so the
    // `get_shared_array_buffer_id`/`get_wasm_module_transfer_id` delegate
    // hooks return `None` (V8 then refuses to clone SABs / Wasm modules,
    // matching `core.structuredClone`'s TypeError → DOMException
    // "DataCloneError" path in the JS wrapper).
    set_fn(scope, ops, "op_structured_clone", op_structured_clone);
    set_fn(scope, ops, "op_serialize", op_serialize);
    set_fn(scope, ops, "op_deserialize", op_deserialize);

    // WebCrypto — `crypto.getRandomValues()`, `crypto.randomUUID()`, and
    // `crypto.subtle.digest()` backing ops. The spec surface (the `Crypto`/
    // `SubtleCrypto`/`CryptoKey` classes, WebIDL argument validation,
    // algorithm name normalization, error-type selection, Promise wrapping
    // for `digest`) lives in the JS module `ext:limun/03_crypto.js`; these
    // ops are the irreducible native work: OS-entropy random byte
    // generation, UUID v4 bit-fixing + hex formatting, and hash computation
    // via the `sha1`/`sha2`/`sha3` crates.
    set_fn(scope, ops, "op_crypto_get_random_values", op_crypto_get_random_values);
    set_fn(scope, ops, "op_crypto_random_uuid", op_crypto_random_uuid);
    set_fn(scope, ops, "op_crypto_digest", op_crypto_digest);
    set_fn(scope, ops, "op_crypto_generate_key", op_crypto_generate_key);
    set_fn(scope, ops, "op_crypto_sign_hmac", op_crypto_sign_hmac);
    set_fn(scope, ops, "op_crypto_encrypt_aes_cbc", op_crypto_encrypt_aes_cbc);
    set_fn(scope, ops, "op_crypto_decrypt_aes_cbc", op_crypto_decrypt_aes_cbc);
    set_fn(scope, ops, "op_crypto_encrypt_aes_ctr", op_crypto_encrypt_aes_ctr);
    set_fn(scope, ops, "op_crypto_decrypt_aes_ctr", op_crypto_decrypt_aes_ctr);
    set_fn(scope, ops, "op_crypto_encrypt_aes_gcm", op_crypto_encrypt_aes_gcm);
    set_fn(scope, ops, "op_crypto_decrypt_aes_gcm", op_crypto_decrypt_aes_gcm);
    set_fn(scope, ops, "op_crypto_generate_rsa_key", op_crypto_generate_rsa_key);
    set_fn(scope, ops, "op_crypto_import_rsa_pkcs8", op_crypto_import_rsa_pkcs8);
    set_fn(scope, ops, "op_crypto_import_rsa_spki", op_crypto_import_rsa_spki);
    set_fn(scope, ops, "op_crypto_export_rsa_pkcs8", op_crypto_export_rsa_pkcs8);
    set_fn(scope, ops, "op_crypto_export_rsa_spki", op_crypto_export_rsa_spki);
    set_fn(scope, ops, "op_crypto_import_rsa_jwk", op_crypto_import_rsa_jwk);
    set_fn(scope, ops, "op_crypto_export_rsa_jwk", op_crypto_export_rsa_jwk);
    set_fn(scope, ops, "op_crypto_sign_rsa", op_crypto_sign_rsa);
    set_fn(scope, ops, "op_crypto_verify_rsa", op_crypto_verify_rsa);
    set_fn(scope, ops, "op_crypto_encrypt_rsa_oaep", op_crypto_encrypt_rsa_oaep);
    set_fn(scope, ops, "op_crypto_decrypt_rsa_oaep", op_crypto_decrypt_rsa_oaep);
    set_fn(scope, ops, "op_crypto_generate_ec_keypair", op_crypto_generate_ec_keypair);
    set_fn(scope, ops, "op_crypto_import_ec_raw", op_crypto_import_ec_raw);
    set_fn(scope, ops, "op_crypto_import_ec_pkcs8", op_crypto_import_ec_pkcs8);
    set_fn(scope, ops, "op_crypto_import_ec_spki", op_crypto_import_ec_spki);
    set_fn(scope, ops, "op_crypto_export_ec_raw", op_crypto_export_ec_raw);
    set_fn(scope, ops, "op_crypto_export_ec_pkcs8", op_crypto_export_ec_pkcs8);
    set_fn(scope, ops, "op_crypto_export_ec_spki", op_crypto_export_ec_spki);
    set_fn(scope, ops, "op_crypto_ec_public_from_private", op_crypto_ec_public_from_private);
    set_fn(scope, ops, "op_crypto_import_ec_jwk_private", op_crypto_import_ec_jwk_private);
    set_fn(scope, ops, "op_crypto_sign_ecdsa", op_crypto_sign_ecdsa);
    set_fn(scope, ops, "op_crypto_verify_ecdsa", op_crypto_verify_ecdsa);
    set_fn(scope, ops, "op_crypto_derive_bits_ecdh", op_crypto_derive_bits_ecdh);
    set_fn(scope, ops, "op_crypto_generate_ed25519_keypair", op_crypto_generate_ed25519_keypair);
    set_fn(scope, ops, "op_crypto_import_spki_ed25519", op_crypto_import_spki_ed25519);
    set_fn(scope, ops, "op_crypto_import_pkcs8_ed25519", op_crypto_import_pkcs8_ed25519);
    set_fn(scope, ops, "op_crypto_export_spki_ed25519", op_crypto_export_spki_ed25519);
    set_fn(scope, ops, "op_crypto_export_pkcs8_ed25519", op_crypto_export_pkcs8_ed25519);
    set_fn(scope, ops, "op_crypto_jwk_x_ed25519", op_crypto_jwk_x_ed25519);
    set_fn(scope, ops, "op_crypto_sign_ed25519", op_crypto_sign_ed25519);
    set_fn(scope, ops, "op_crypto_verify_ed25519", op_crypto_verify_ed25519);
    set_fn(scope, ops, "op_crypto_generate_x25519_keypair", op_crypto_generate_x25519_keypair);
    set_fn(scope, ops, "op_crypto_import_spki_x25519", op_crypto_import_spki_x25519);
    set_fn(scope, ops, "op_crypto_import_pkcs8_x25519", op_crypto_import_pkcs8_x25519);
    set_fn(scope, ops, "op_crypto_export_spki_x25519", op_crypto_export_spki_x25519);
    set_fn(scope, ops, "op_crypto_export_pkcs8_x25519", op_crypto_export_pkcs8_x25519);
    set_fn(scope, ops, "op_crypto_x25519_public_key", op_crypto_x25519_public_key);
    set_fn(scope, ops, "op_crypto_derive_bits_x25519", op_crypto_derive_bits_x25519);
    set_fn(scope, ops, "op_crypto_derive_bits_hkdf", op_crypto_derive_bits_hkdf);
    set_fn(scope, ops, "op_crypto_derive_bits_pbkdf2", op_crypto_derive_bits_pbkdf2);
    set_fn(scope, ops, "op_crypto_wrap_key_aes_kw", op_crypto_wrap_key_aes_kw);
    set_fn(scope, ops, "op_crypto_unwrap_key_aes_kw", op_crypto_unwrap_key_aes_kw);

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

// --- Navigator Standard ----------------------------------------------------
//
// HTML Navigator interface (`navigator` global). The spec surface (the
// `Navigator` class, WebIDL branding, readonly getters) lives in
// `ext:limun/12_navigator.js`; these two ops are the irreducible native
// work. Both return plain V8 strings/numbers with no side effects.

fn op_navigator_hardware_concurrency(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let count = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1);
    rv.set(v8::Number::new(scope, count as f64).into());
}

fn op_navigator_platform(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let platform = std::env::consts::OS;
    let s = v8::String::new(scope, platform).unwrap();
    rv.set(s.into());
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

// --- Compression ops -------------------------------------------------------
//
// WHATWG CompressionStream / DecompressionStream backing ops. The spec
// surface (the `CompressionStream`/`DecompressionStream` classes, the
// `TransformStream` wiring, WebIDL enum/dictionary validation) lives in
// `ext:limun/14_compression.js`. These ops are the irreducible native
// work: `flate2`-based deflate/gzip/deflate-raw compression and
// decompression. The JS side holds a numeric handle (id into a thread-
// local registry); `op_compression_write` feeds bytes through the
// encoder/decoder and returns the flushed output as a `Uint8Array`;
// `op_compression_finish` finalizes the stream and returns trailing
// bytes.

use flate2::write::{
    DeflateDecoder as ZlibDecoder, DeflateEncoder, GzDecoder, GzEncoder,
    ZlibDecoder as DeflateDecoder, ZlibEncoder as ZlibEncoder,
};
use flate2::Compression;

enum CompressionInner {
    DeflateEncoder(ZlibEncoder<Vec<u8>>),
    DeflateDecoder(ZlibDecoder<Vec<u8>>),
    DeflateRawEncoder(DeflateEncoder<Vec<u8>>),
    DeflateRawDecoder(DeflateDecoder<Vec<u8>>),
    GzipEncoder(GzEncoder<Vec<u8>>),
    GzipDecoder(GzDecoder<Vec<u8>>),
}

thread_local! {
    static COMPRESSION_REGISTRY: RefCell<HashMap<u32, CompressionInner>> =
        RefCell::new(HashMap::new());
    static NEXT_COMPRESSION_ID: RefCell<u32> = const { RefCell::new(1) };
}

fn alloc_compression_id() -> u32 {
    NEXT_COMPRESSION_ID.with(|id| {
        let mut id = id.borrow_mut();
        let cur = *id;
        *id = id.wrapping_add(1);
        cur
    })
}

/// `op_compression_new(format: String, is_decoder: boolean) -> number` —
/// allocate a new compression/decompression handle. `format` is one of
/// `"deflate"`, `"deflate-raw"`, `"gzip"`. Returns the integer handle id.
fn op_compression_new(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let format = args.get(0).to_rust_string_lossy(scope);
    let is_decoder = args.get(1).boolean_value(scope);

    let inner = match (format.as_str(), is_decoder) {
        ("deflate", false) => {
            CompressionInner::DeflateEncoder(ZlibEncoder::new(Vec::new(), Compression::default()))
        }
        ("deflate", true) => {
            CompressionInner::DeflateDecoder(ZlibDecoder::new(Vec::new()))
        }
        ("deflate-raw", false) => {
            CompressionInner::DeflateRawEncoder(DeflateEncoder::new(Vec::new(), Compression::default()))
        }
        ("deflate-raw", true) => {
            CompressionInner::DeflateRawDecoder(DeflateDecoder::new(Vec::new()))
        }
        ("gzip", false) => {
            CompressionInner::GzipEncoder(GzEncoder::new(Vec::new(), Compression::default()))
        }
        ("gzip", true) => {
            CompressionInner::GzipDecoder(GzDecoder::new(Vec::new()))
        }
        _ => {
            let msg = v8::String::new(scope, "Unsupported compression format").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let id = alloc_compression_id();
    COMPRESSION_REGISTRY.with(|reg| {
        reg.borrow_mut().insert(id, inner);
    });
    rv.set(v8::Number::new(scope, id as f64).into());
}

/// `op_compression_write(handle_id: number, data: Uint8Array) -> Uint8Array` —
/// feed `data` through the encoder/decoder identified by `handle_id`,
/// flush, and return the output bytes. Returns an empty `Uint8Array` if
/// no output was produced.
fn op_compression_write(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle_id = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let input = read_bytes(args.get(1)).unwrap_or_default();

    let output: Vec<u8> = COMPRESSION_REGISTRY.with(|reg| {
        let mut reg = reg.borrow_mut();
        let Some(inner) = reg.get_mut(&handle_id) else {
            return Vec::new();
        };
        match inner {
            CompressionInner::DeflateEncoder(e) => {
                let _ = std::io::Write::write_all(e, &input);
                let _ = std::io::Write::flush(e);
                std::mem::take(e.get_mut())
            }
            CompressionInner::DeflateDecoder(d) => {
                let _ = std::io::Write::write_all(d, &input);
                let _ = std::io::Write::flush(d);
                std::mem::take(d.get_mut())
            }
            CompressionInner::DeflateRawEncoder(e) => {
                let _ = std::io::Write::write_all(e, &input);
                let _ = std::io::Write::flush(e);
                std::mem::take(e.get_mut())
            }
            CompressionInner::DeflateRawDecoder(d) => {
                let _ = std::io::Write::write_all(d, &input);
                let _ = std::io::Write::flush(d);
                std::mem::take(d.get_mut())
            }
            CompressionInner::GzipEncoder(e) => {
                let _ = std::io::Write::write_all(e, &input);
                let _ = std::io::Write::flush(e);
                std::mem::take(e.get_mut())
            }
            CompressionInner::GzipDecoder(d) => {
                let _ = std::io::Write::write_all(d, &input);
                let _ = std::io::Write::flush(d);
                std::mem::take(d.get_mut())
            }
        }
    });

    rv.set(vec_to_uint8_array(scope, output).into());
}

/// `op_compression_finish(handle_id: number, report_errors: boolean) -> Uint8Array` —
/// finalize the encoder/decoder, return any remaining output bytes, and
/// drop the handle. If `report_errors` is false, errors from the
/// encoder/decoder are swallowed (returns an empty `Uint8Array`).
fn op_compression_finish(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle_id = args.get(0).integer_value(scope).unwrap_or(0) as u32;
    let report_errors = args.get(1).boolean_value(scope);

    let inner = COMPRESSION_REGISTRY.with(|reg| {
        reg.borrow_mut().remove(&handle_id)
    });

    let Some(inner) = inner else {
        rv.set(vec_to_uint8_array(scope, Vec::new()).into());
        return;
    };

    let result: Result<Vec<u8>, std::io::Error> = match inner {
        CompressionInner::DeflateEncoder(e) => e.finish(),
        CompressionInner::DeflateDecoder(d) => d.finish(),
        CompressionInner::DeflateRawEncoder(e) => e.finish(),
        CompressionInner::DeflateRawDecoder(d) => d.finish(),
        CompressionInner::GzipEncoder(e) => e.finish(),
        CompressionInner::GzipDecoder(d) => d.finish(),
    };

    match result {
        Ok(bytes) => {
            rv.set(vec_to_uint8_array(scope, bytes).into());
        }
        Err(_) => {
            if report_errors {
                let msg = v8::String::new(scope, "compression/decompression error").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
            } else {
                rv.set(vec_to_uint8_array(scope, Vec::new()).into());
            }
        }
    }
}

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

// --- Structured clone ops --------------------------------------------------
//
// V8 `ValueSerializer`/`ValueDeserializer` backing for `structuredClone` and
// `MessagePort.postMessage`. Ports Deno's `SerializeDeserialize` struct + the
// `op_serialize`/`op_deserialize`/`op_structured_clone` ops from
// `libs/core/ops_builtin_v8.rs`, adapted to Limun's flat-op model:
//   - No `OpState`, no `op2` macro, no `JsErrorBox` — bare `v8::FunctionCallback`s
//     that return flat V8 values or throw.
//   - No `SharedArrayBufferStore` (`get_shared_array_buffer_id` → `None`) —
//     Limun is single-realm with no SAB.
//   - No `CompiledWasmModuleStore` (`get_wasm_module_transfer_id` → `None`).
//   - No `for_storage` flag, no `deserializers` map, no broadcast mode.
//   - The host-object brand symbol is `Symbol.for("limun.hostObject")` (Deno
//     uses `Symbol.for("hostObject")` via a static string). The MessagePort
//     JS class sets this symbol on instances so the serializer recognizes
//     them as host objects and calls the brand's serialize method.
//
// `ArrayBuffer` transfer protocol (matches Deno/V8):
//   - Serialize: the JS side passes a `transferredArrayBuffers` array of
//     `ArrayBuffer`s. For each one, we detach the original (V8 transfers
//     ownership of the backing store), call
//     `value_serializer.transfer_array_buffer(index, buf)`, and write the
//     *index* back into the same array slot (the JS side stashes the index
//     for the deserialize side).
//   - Deserialize: the JS side passes the same array (now containing
//     indices). For each one, we mint a fresh `ArrayBuffer` and call
//     `value_deserializer.transfer_array_buffer(index, new_buf)` *before*
//     `read_value` — V8 then wires the fresh buffer into the deserialized
//     graph wherever the index appears. The fresh buffer is written back
//     into the array slot so the JS side can collect the transferred
//     buffers and hand them out as transferables.

/// The brand symbol key. `Symbol.for("limun.hostObject")` — JS classes
/// opt into host-object serialization by setting this symbol on instances
/// (a per-class serialize method as the value). Deno uses
/// `Symbol.for("hostObject")`; the different key keeps Limun's host-object
/// registry disjoint from any future Deno-interop layer.
const HOST_OBJECT_SYMBOL_KEY: &str = "limun.hostObject";

/// A transferred `ArrayBuffer`'s backing store + byte length, stashed by
/// `op_serialize` for `op_deserialize` to recover. Single-realm: both
/// ops run in the same isolate/thread, back-to-back, so the backing store
/// (a `SharedRef<BackingStore>`) survives across the boundary. V8's
/// `transfer_array_buffer` on the serializer side writes only the id into
/// the wire format (not the contents); the deserializer must provide a
/// fresh `ArrayBuffer` for each id, and we give it one backed by the
/// *same* backing store — no copy, same memory.
struct TransferredBuffer {
    backing_store: v8::SharedRef<v8::BackingStore>,
    #[allow(dead_code)]
    byte_length: usize,
}

thread_local! {
    /// Stash of transferred `ArrayBuffer` backing stores, keyed by the
    /// index (slot in the `transferredArrayBuffers` array). Populated by
    /// `op_serialize` (one entry per transferred ArrayBuffer), consumed
    /// and cleared by `op_deserialize`. Single-slot per index — safe
    /// because serialize and deserialize are synchronous and
    /// non-overlapping in the single-realm model.
    static TRANSFERRED_BUFFERS: RefCell<HashMap<u32, TransferredBuffer>> =
        RefCell::new(HashMap::new());
}

/// `SerializeDeserialize` — the V8 `ValueSerializerImpl` /
/// `ValueDeserializerImpl` delegate. Holds the per-call state: the
/// host-object brand symbol, the `host_objects` array (for the
/// index-by-position fallback when a host object isn't brand-tagged), the
/// `error_callback` (called on DataCloneError instead of throwing
/// directly, so the JS side can rewrite the message), and the
/// `transferred_array_buffers` array (for ArrayBuffer transfer).
///
/// Simplified vs Deno: no `for_storage`, no `deserializers`, no SAB store,
/// no broadcast mode.
struct SerializeDeserialize<'a> {
    host_objects: Option<v8::Local<'a, v8::Array>>,
    error_callback: Option<v8::Local<'a, v8::Function>>,
    host_object_brand: Option<v8::Local<'a, v8::Symbol>>,
}

impl v8::ValueSerializerImpl for SerializeDeserialize<'_> {
    fn throw_data_clone_error<'s, 'i>(
        &self,
        scope: &mut v8::PinScope<'s, 'i>,
        message: v8::Local<'s, v8::String>,
    ) {
        if let Some(cb) = self.error_callback {
            v8::tc_scope!(let tc, scope);
            let undefined = v8::undefined(tc).into();
            cb.call(tc, undefined, &[message.into()]);
            if tc.has_caught() || tc.has_terminated() {
                tc.rethrow();
                return;
            }
            return;
        }
        let error = v8::Exception::type_error(scope, message);
        scope.throw_exception(error);
    }

    fn get_shared_array_buffer_id<'s, 'i>(
        &self,
        _scope: &mut v8::PinScope<'s, 'i>,
        _shared_array_buffer: v8::Local<'s, v8::SharedArrayBuffer>,
    ) -> Option<u32> {
        // Limun has no SharedArrayBuffer — refuse to clone.
        None
    }

    fn get_wasm_module_transfer_id<'s, 'i>(
        &self,
        scope: &mut v8::PinScope<'s, 'i>,
        _module: v8::Local<v8::WasmModuleObject>,
    ) -> Option<u32> {
        // Limun has no Wasm module store — refuse to clone. Throw a
        // DataCloneError via the delegate so the JS side's error callback
        // can rewrite the message (matches Deno's "Wasm modules cannot be
        // stored" path, though here it's not just storage mode).
        let msg = v8::String::new(scope, "Wasm modules cannot be cloned").unwrap();
        self.throw_data_clone_error(scope, msg);
        None
    }

    fn has_custom_host_object(&self, _isolate: &v8::Isolate) -> bool {
        self.host_object_brand.is_some()
    }

    fn is_host_object<'s, 'i>(
        &self,
        scope: &mut v8::PinScope<'s, 'i>,
        object: v8::Local<'s, v8::Object>,
    ) -> Option<bool> {
        match self.host_object_brand {
            Some(symbol) => object.has(scope, symbol.into()),
            _ => Some(false),
        }
    }

    fn write_host_object<'s, 'i>(
        &self,
        scope: &mut v8::PinScope<'s, 'i>,
        object: v8::Local<'s, v8::Object>,
        value_serializer: &dyn v8::ValueSerializerHelper,
    ) -> Option<bool> {
        // Brand-tagged path: the host object's brand symbol property is a
        // function that returns the serialization payload (a v8 value).
        // Write the sentinel `u32::MAX` so the deserialize side knows to
        // read a value (the payload) and hand it to the brand's
        // deserializer. Deno's `read_host_object` then looks up a
        // `deserializers` map keyed by the payload's `type` field; Limun
        // instead stashes the payload on the deserialized host object and
        // lets the JS `MessagePort` class reconstruct from it (see
        // `13_message_port.js`).
        if let Some(host_object_brand) = self.host_object_brand {
            let value = object.get(scope, host_object_brand.into())?;
            if let Ok(func) = value.try_cast::<v8::Function>() {
                let result = func.call(scope, object.into(), &[])?;
                value_serializer.write_uint32(u32::MAX);
                value_serializer.write_value(scope.get_current_context(), result);
                return Some(true);
            }
        }
        // Index-by-position fallback: host object isn't brand-tagged but
        // appears in the `host_objects` array — write its index. The
        // deserialize side returns the same object from the array (no
        // copy — this is the "transfer a reference" path used when the
        // JS side explicitly lists a host object in `hostObjects`).
        if let Some(host_objects) = self.host_objects {
            for i in 0..host_objects.length() {
                let value = host_objects.get_index(scope, i).unwrap();
                if value.strict_equals(object.into()) {
                    value_serializer.write_uint32(i);
                    return Some(true);
                }
            }
        }
        let message = v8::String::new(scope, "Unsupported object type").unwrap();
        self.throw_data_clone_error(scope, message);
        None
    }
}

impl v8::ValueDeserializerImpl for SerializeDeserialize<'_> {
    fn get_shared_array_buffer_from_id<'s, 'i>(
        &self,
        _scope: &mut v8::PinScope<'s, 'i>,
        _transfer_id: u32,
    ) -> Option<v8::Local<'s, v8::SharedArrayBuffer>> {
        // Limun has no SharedArrayBuffer.
        None
    }

    fn get_wasm_module_from_id<'s, 'i>(
        &self,
        _scope: &mut v8::PinScope<'s, 'i>,
        _clone_id: u32,
    ) -> Option<v8::Local<'s, v8::WasmModuleObject>> {
        // Limun has no Wasm module store.
        None
    }

    fn read_host_object<'s, 'i>(
        &self,
        scope: &mut v8::PinScope<'s, 'i>,
        value_deserializer: &dyn v8::ValueDeserializerHelper,
    ) -> Option<v8::Local<'s, v8::Object>> {
        let mut i = 0u32;
        if !value_deserializer.read_uint32(&mut i) {
            return None;
        }
        if i == u32::MAX {
            // Brand-tagged path: a payload value follows. Read it, wrap
            // it in a `{ data, __limunHostObject: true }` object, and
            // return that. The JS `MessagePort.deserialize` static method
            // (registered as the brand symbol's *deserialize* side via a
            // per-class side table) reconstructs the real instance from
            // `data`. Limun has no `deserializers` map (Deno's
            // `core.getCloneableDeserializers`); instead the brand symbol
            // on the *prototype* carries a `deserialize` static method
            // the JS side invokes. Here we just hand back the payload
            // wrapped so the JS side's deserialize wrapper can find it.
            if let Some(value) =
                value_deserializer.read_value(scope.get_current_context())
            {
                // Stash the payload in a fresh host-object shell. The JS
                // `MessagePort` post-deserialize pass walks the result
                // graph for these shells and swaps them for real
                // `MessagePort` instances built from the payload.
                let shell = v8::Object::new(scope);
                let key = v8::String::new(scope, "__limunHostObjectPayload").unwrap();
                shell.set(scope, key.into(), value);
                // Brand the shell so the JS side can recognize it.
                if let Some(brand) = self.host_object_brand {
                    shell.set(scope, brand.into(), v8::Boolean::new(scope, true).into());
                }
                return Some(shell);
            }
        } else if let Some(host_objects) = self.host_objects {
            // Index-by-position path: return the original object from the
            // array (no copy — a transferred reference).
            if let Some(value) = host_objects.get_index(scope, i) {
                if let Ok(obj) = value.try_cast::<v8::Object>() {
                    return Some(obj);
                }
            }
        }

        let message: v8::Local<v8::String> =
            v8::String::new(scope, "Failed to deserialize host object").unwrap();
        let error = v8::Exception::error(scope, message);
        scope.throw_exception(error);
        None
    }
}

/// Look up (or create) the host-object brand symbol
/// `Symbol.for("limun.hostObject")`. Cached on a thread_local so we don't
/// re-`Symbol::for_key` on every serialize call (V8 dedups it anyway, but
/// the round-trip still costs).
fn host_object_brand_symbol<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> v8::Local<'s, v8::Symbol> {
    let key = v8::String::new(scope, HOST_OBJECT_SYMBOL_KEY).unwrap();
    v8::Symbol::for_key(scope, key)
}

/// Wrap `bytes` into a fresh `Uint8Array` (V8 owns the backing store —
/// `new_backing_store_from_vec` moves the `Vec`'s allocation into V8's
/// heap, so no copy). Used by `op_serialize` (returns the wire-format
/// bytes) and internally by `op_structured_clone` (passes the bytes to the
/// deserializer).
fn vec_to_uint8_array<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: Vec<u8>,
) -> v8::Local<'s, v8::Uint8Array> {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Uint8Array::new(scope, ab, 0, len).unwrap()
}

/// `op_structured_clone(value) -> value` — serialize `value` to bytes via
/// V8's `ValueSerializer`, then immediately deserialize back. The
/// `structuredClone()` global (no transferables) calls this. Host objects
/// brand-tagged with `Symbol.for("limun.hostObject")` round-trip through
/// the brand's serialize/deserialize methods (the JS `MessagePort` class
/// uses this for `structuredClone(port)` — clone, not transfer).
///
/// On serialize failure, rethrows the V8 exception (the JS wrapper in
/// `02_structured_clone.js` catches a TypeError and rethrows as
/// DOMException "DataCloneError").
fn op_structured_clone(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let value = args.get(0);
    let brand = host_object_brand_symbol(scope);

    let sd = Box::new(SerializeDeserialize {
        host_objects: None,
        error_callback: None,
        host_object_brand: Some(brand),
    });
    let value_serializer = v8::ValueSerializer::new(scope, sd);
    value_serializer.write_header();

    v8::tc_scope!(let tc, scope);
    let ret = value_serializer.write_value(tc.get_current_context(), value);
    if tc.has_caught() || tc.has_terminated() {
        tc.rethrow();
        return;
    }
    if !matches!(ret, Some(true)) {
        let msg = v8::String::new(tc, "Failed to serialize value").unwrap();
        tc.throw_exception(v8::Exception::type_error(tc, msg));
        return;
    }
    let vector = value_serializer.release();

    let sd = Box::new(SerializeDeserialize {
        host_objects: None,
        error_callback: None,
        host_object_brand: Some(brand),
    });
    let value_deserializer = v8::ValueDeserializer::new(tc, sd, &vector);
    let parsed_header = value_deserializer
        .read_header(tc.get_current_context())
        .unwrap_or(false);
    if !parsed_header {
        let msg = v8::String::new(tc, "could not deserialize value").unwrap();
        tc.throw_exception(v8::Exception::range_error(tc, msg));
        return;
    }
    let value = value_deserializer.read_value(tc.get_current_context());
    match value {
        Some(deserialized) => {
            rv.set(deserialized);
        }
        None => {
            if !tc.has_caught() {
                let msg = v8::String::new(tc, "could not deserialize value").unwrap();
                tc.throw_exception(v8::Exception::range_error(tc, msg));
            }
        }
    }
}

/// `op_serialize(value, hostObjects?, transferredArrayBuffers?,
/// errorCallback?) -> Uint8Array` — serialize `value` to V8's
/// structured-clone wire format. `hostObjects` is an array of host objects
/// (for the index-by-position transfer path); `transferredArrayBuffers`
/// is an array of `ArrayBuffer`s to transfer (detach + write index back);
/// `errorCallback` is called on DataCloneError with the V8 message (so the
/// JS side can rewrite it to a DOMException-friendly form).
fn op_serialize(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let value = args.get(0);
    let host_objects = if args.length() > 1 && !args.get(1).is_null_or_undefined() {
        match <v8::Local<v8::Array>>::try_from(args.get(1)) {
            Ok(arr) => Some(arr),
            Err(_) => {
                let msg = v8::String::new(scope, "hostObjects not an array").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        }
    } else {
        None
    };
    let transferred_array_buffers: Option<v8::Local<v8::Array>> =
        if args.length() > 2 && !args.get(2).is_null_or_undefined() {
            match <v8::Local<v8::Array>>::try_from(args.get(2)) {
                Ok(arr) => Some(arr),
                Err(_) => {
                    let msg = v8::String::new(
                        scope,
                        "transferredArrayBuffers not an array",
                    )
                    .unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        } else {
            None
        };
    let error_callback = if args.length() > 3 && !args.get(3).is_null_or_undefined() {
        match <v8::Local<v8::Function>>::try_from(args.get(3)) {
            Ok(cb) => Some(cb),
            Err(_) => {
                let msg = v8::String::new(scope, "error callback not a function").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        }
    } else {
        None
    };

    let brand = host_object_brand_symbol(scope);

    let sd = Box::new(SerializeDeserialize {
        host_objects,
        error_callback,
        host_object_brand: Some(brand),
    });
    let value_serializer = v8::ValueSerializer::new(scope, sd);
    value_serializer.write_header();

    // ArrayBuffer transfer: register each `ArrayBuffer` in
    // `transferredArrayBuffers` with V8's serializer (writes the id into
    // the wire format wherever the buffer appears) and stash its backing
    // store for the deserialize side. The original buffers are detached
    // AFTER `write_value` completes (detaching before would make the
    // buffer's data inaccessible to the serializer, causing a
    // "DataCloneError: detached" — V8 needs to read the buffer's
    // contents during `write_value`).
    let mut buffers_to_detach: Vec<v8::Local<v8::ArrayBuffer>> = Vec::new();
    if let Some(tabs) = transferred_array_buffers {
        for index in 0..tabs.length() {
            let i = v8::Number::new(scope, index as f64).into();
            let buf_val = tabs.get(scope, i).unwrap();
            let buf = match <v8::Local<v8::ArrayBuffer>>::try_from(buf_val) {
                Ok(b) => b,
                Err(_) => {
                    let msg = v8::String::new(
                        scope,
                        "item in transferredArrayBuffers not an ArrayBuffer",
                    )
                    .unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            if !buf.is_detachable() {
                let msg = v8::String::new(
                    scope,
                    "item in transferredArrayBuffers is not transferable",
                )
                .unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
            if buf.was_detached() {
                let msg = v8::String::new(
                    scope,
                    &format!("ArrayBuffer at index {index} is already detached"),
                )
                .unwrap();
                scope.throw_exception(v8::Exception::error(scope, msg));
                return;
            }
            let byte_length = buf.byte_length();
            // Grab the backing store BEFORE detaching (the backing store
            // ref we hold here keeps it alive). The deserializer creates
            // a fresh ArrayBuffer with this backing store — same
            // contents, same memory, no copy.
            let backing_store = buf.get_backing_store();
            // Register the transfer with V8. `transfer_array_buffer`
            // records the id so V8 writes it (not the contents) into the
            // wire format wherever this buffer appears. The contents are
            // carried via the stashed backing store.
            value_serializer.transfer_array_buffer(index, buf);
            // Stash the backing store for the deserialize side.
            TRANSFERRED_BUFFERS.with(|cell| {
                cell.borrow_mut().insert(
                    index as u32,
                    TransferredBuffer {
                        backing_store,
                        byte_length,
                    },
                );
            });
            // Remember to detach after `write_value` (V8 reads the
            // buffer's contents during serialization).
            buffers_to_detach.push(buf);
            // Write the index back so the JS side can pass the array to
            // `op_deserialize`.
            let id = v8::Number::new(scope, index as f64).into();
            tabs.set(scope, i, id);
        }
    }

    v8::tc_scope!(let tc, scope);
    let ret = value_serializer.write_value(tc.get_current_context(), value);
    if tc.has_caught() || tc.has_terminated() {
        tc.rethrow();
        return;
    }
    if !matches!(ret, Some(true)) {
        let msg = v8::String::new(tc, "Failed to serialize value").unwrap();
        tc.throw_exception(v8::Exception::type_error(tc, msg));
        return;
    }
    // Now that V8 has read the buffers' contents, detach the originals
    // (the sender gives up ownership — spec: transferred ArrayBuffers
    // are detached after the clone).
    for buf in &buffers_to_detach {
        buf.detach(None);
    }
    let vector = value_serializer.release();
    rv.set(vec_to_uint8_array(tc, vector).into());
}

/// `op_deserialize(bytes, hostObjects?, transferredArrayBuffers?) -> value`
/// — deserialize `bytes` (a `Uint8Array` produced by `op_serialize`) back
/// into a V8 value. `hostObjects` is the same array passed to
/// `op_serialize` (for the index-by-position path); `transferredArrayBuffers`
/// is the array of indices written back by `op_serialize` — for each
/// index, we mint a fresh `ArrayBuffer` and call
/// `transfer_array_buffer(index, new_buf)` *before* `read_value`, so V8
/// wires the fresh buffer into the deserialized graph wherever the index
/// appears. The fresh buffer is written back into the array slot so the
/// JS side can collect the transferred buffers.
fn op_deserialize(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Read the bytes: accept `Uint8Array` or any `ArrayBufferView` /
    // `ArrayBuffer` (the JS side always passes a `Uint8Array` from
    // `op_serialize`, but be tolerant).
    let bytes: Vec<u8> = match read_bytes(args.get(0)) {
        Some(b) => b,
        None => {
            let msg = v8::String::new(scope, "deserialize: expected Uint8Array").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let host_objects = if args.length() > 1 && !args.get(1).is_null_or_undefined() {
        match <v8::Local<v8::Array>>::try_from(args.get(1)) {
            Ok(arr) => Some(arr),
            Err(_) => {
                let msg = v8::String::new(scope, "hostObjects not an array").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        }
    } else {
        None
    };
    let _transferred_array_buffers: Option<v8::Local<v8::Array>> =
        if args.length() > 2 && !args.get(2).is_null_or_undefined() {
            match <v8::Local<v8::Array>>::try_from(args.get(2)) {
                Ok(arr) => Some(arr),
                Err(_) => {
                    let msg = v8::String::new(
                        scope,
                        "transferredArrayBuffers not an array",
                    )
                    .unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        } else {
            None
        };

    let brand = host_object_brand_symbol(scope);

    let sd = Box::new(SerializeDeserialize {
        host_objects,
        error_callback: None,
        host_object_brand: Some(brand),
    });
    let value_deserializer = v8::ValueDeserializer::new(scope, sd, &bytes);
    let parsed_header = value_deserializer
        .read_header(scope.get_current_context())
        .unwrap_or(false);
    if !parsed_header {
        let msg = v8::String::new(scope, "could not deserialize value").unwrap();
        scope.throw_exception(v8::Exception::range_error(scope, msg));
        return;
    }

    // ArrayBuffer transfer: for each index in `transferredArrayBuffers`,
    // recover the stashed backing store (from the serialize side) and
    // mint a fresh `ArrayBuffer` with that backing store. Call
    // `transfer_array_buffer(index, new_buf)` so V8 wires the fresh
    // buffer into the deserialized graph wherever the index appears. The
    // fresh buffer is written back into the array slot (replacing the
    // index) so the JS side can collect it as a transferable.
    //
    // Single-realm: the backing store was stashed in `TRANSFERRED_BUFFERS`
    // by `op_serialize` (same thread, back-to-back). The stash is cleared
    // after each deserialize to avoid leaks.
    if let Some(tabs) = _transferred_array_buffers {
        for i in 0..tabs.length() {
            let i_key = v8::Number::new(scope, i as f64).into();
            let id_val = tabs.get(scope, i_key).unwrap();
            let id = match id_val.number_value(scope) {
                Some(id) => id as u32,
                None => {
                    let msg = v8::String::new(
                        scope,
                        "item in transferredArrayBuffers not a number (index)",
                    )
                    .unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            // Recover the stashed backing store.
            let transferred = TRANSFERRED_BUFFERS.with(|cell| {
                cell.borrow_mut().remove(&id)
            });
            let Some(TransferredBuffer { backing_store, byte_length: _ }) = transferred
            else {
                // No backing store stashed for this index — the serialize
                // side didn't transfer this buffer (or the stash was
                // cleared). V8 will fail to deserialize the transferred
                // ArrayBuffer reference; surface a TypeError.
                let msg = v8::String::new(
                    scope,
                    "transferred ArrayBuffer backing store not found",
                )
                .unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            };
            // Mint a fresh ArrayBuffer with the original's backing store
            // (same contents, same memory — no copy). Single-realm makes
            // this safe: both sides run in the same isolate.
            let new_buf = v8::ArrayBuffer::with_backing_store(scope, &backing_store);
            value_deserializer.transfer_array_buffer(id, new_buf);
            // Write the fresh buffer back so the JS side can collect it.
            tabs.set(scope, i_key, new_buf.into());
        }
    }

    let value = value_deserializer.read_value(scope.get_current_context());
    match value {
        Some(deserialized) => {
            rv.set(deserialized);
        }
        None => {
            // `read_value` returned `None` — either V8 threw (in which
            // case the pending exception is already on the isolate) or
            // the stream was truncated. Surface a RangeError only if V8
            // didn't already set an exception (matches Deno's
            // `JsErrorBox::range_error("could not deserialize value")`).
            v8::tc_scope!(let tc, scope);
            if !tc.has_caught() {
                let msg = v8::String::new(tc, "could not deserialize value").unwrap();
                tc.throw_exception(v8::Exception::range_error(tc, msg));
            }
            tc.rethrow();
        }
    }
}

// --- WebCrypto ops ---------------------------------------------------------
//
// WebCrypto `crypto.getRandomValues()` / `crypto.randomUUID()` /
// `crypto.subtle.digest()` / `generateKey` / `sign` / `verify` / `encrypt` /
// `decrypt` / `importKey` / `exportKey` backing ops. The spec surface (the
// `Crypto`/`SubtleCrypto`/`CryptoKey` classes, WebIDL argument validation,
// algorithm name normalization, error-type selection, Promise wrapping)
// lives in the JS module `ext:limun/03_crypto.js`. These ops are flat: a
// TypedArray in (filled in place), no return; a string out (UUID); a string
// name + Uint8Array in, Uint8Array out (digest); or Uint8Array/number args
// in, Uint8Array out (generate_key, sign_hmac, encrypt/decrypt AES). Errors
// are bare TypeErrors; the JS layer catches and rethrows as DOMException
// with the spec-correct name.

/// `op_crypto_get_random_values(typedArray) -> undefined` — fill the backing
/// store of an integer TypedArray with cryptographically-secure random bytes
/// from the OS entropy source (`rand::rngs::OsRng`). The JS layer has already
/// validated that `typedArray` is an integer TypedArray (not Float*Array or
/// DataView) and that `byteLength <= 65536`. The fill is in-place — no return
/// value; the JS side already holds the array reference and returns it.
fn op_crypto_get_random_values(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand::RngCore;

    let Ok(view) = <v8::Local<v8::ArrayBufferView>>::try_from(args.get(0)) else {
        let msg = v8::String::new(
            scope,
            "getRandomValues: argument is not a TypedArray",
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    let byte_offset = view.byte_offset();
    let byte_length = view.byte_length();
    if byte_length == 0 {
        rv.set(v8::undefined(scope).into());
        return;
    }

    let Some(ab) = view.buffer(scope) else {
        let msg = v8::String::new(
            scope,
            "getRandomValues: cannot access backing ArrayBuffer (detached?)",
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    let Some(data) = ab.data() else {
        let msg = v8::String::new(
            scope,
            "getRandomValues: backing ArrayBuffer has no data (detached?)",
        ).unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    // SAFETY: V8 guarantees byte_offset + byte_length is within the backing
    // store, and a non-detached buffer has a non-null data ptr. The JS layer
    // has already validated the array is not detached.
    let slice = unsafe {
        let ptr = data.as_ptr() as *mut u8;
        std::slice::from_raw_parts_mut(ptr.add(byte_offset), byte_length)
    };

    // `OsRng` is a cryptographically-secure entropy source (reads from
    // /dev/urandom on Linux, getrandom() syscall, etc.). `fill_bytes` is
    // infallible for OsRng (it retries on EINTR).
    rand::rngs::OsRng.fill_bytes(slice);

    rv.set(v8::undefined(scope).into());
}

/// `op_crypto_random_uuid() -> String` — generate a v4 UUID (random bytes +
/// version/variant bit-fixing) and return it as a formatted
/// `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` string. Uses `OsRng` for the 16
/// random bytes, then sets version (4) and variant (RFC 4122) bits per
/// RFC 4122 §4.4.
fn op_crypto_random_uuid(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand::RngCore;

    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);

    // Version 4 (random) — top 4 bits of byte 6 = 0b0100.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Variant RFC 4122 — top 2 bits of byte 8 = 0b10.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex = b"0123456789abcdef";
    let buf = [
        hex[(bytes[0] >> 4) as usize],
        hex[(bytes[0] & 0x0f) as usize],
        hex[(bytes[1] >> 4) as usize],
        hex[(bytes[1] & 0x0f) as usize],
        hex[(bytes[2] >> 4) as usize],
        hex[(bytes[2] & 0x0f) as usize],
        hex[(bytes[3] >> 4) as usize],
        hex[(bytes[3] & 0x0f) as usize],
        b'-',
        hex[(bytes[4] >> 4) as usize],
        hex[(bytes[4] & 0x0f) as usize],
        hex[(bytes[5] >> 4) as usize],
        hex[(bytes[5] & 0x0f) as usize],
        b'-',
        hex[(bytes[6] >> 4) as usize],
        hex[(bytes[6] & 0x0f) as usize],
        hex[(bytes[7] >> 4) as usize],
        hex[(bytes[7] & 0x0f) as usize],
        b'-',
        hex[(bytes[8] >> 4) as usize],
        hex[(bytes[8] & 0x0f) as usize],
        hex[(bytes[9] >> 4) as usize],
        hex[(bytes[9] & 0x0f) as usize],
        b'-',
        hex[(bytes[10] >> 4) as usize],
        hex[(bytes[10] & 0x0f) as usize],
        hex[(bytes[11] >> 4) as usize],
        hex[(bytes[11] & 0x0f) as usize],
        hex[(bytes[12] >> 4) as usize],
        hex[(bytes[12] & 0x0f) as usize],
        hex[(bytes[13] >> 4) as usize],
        hex[(bytes[13] & 0x0f) as usize],
        hex[(bytes[14] >> 4) as usize],
        hex[(bytes[14] & 0x0f) as usize],
        hex[(bytes[15] >> 4) as usize],
        hex[(bytes[15] & 0x0f) as usize],
    ];

    // SAFETY: the buffer is all valid UTF-8 (ASCII hex + '-').
    let s = unsafe { String::from_utf8_unchecked(buf.to_vec()) };
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

/// `op_crypto_digest(algorithmName: String, data: Uint8Array) -> Uint8Array`
/// — compute the hash of `data` using the algorithm named by
/// `algorithmName` (already normalized to uppercase by JS). Supported
/// algorithms: SHA-1, SHA-256, SHA-384, SHA-512, SHA3-256, SHA3-384,
/// SHA3-512. Returns a fresh Uint8Array with the digest. On unknown
/// algorithm, throws a TypeError (the JS layer catches and rethrows as
/// DOMException "NotSupportedError").
fn op_crypto_digest(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use sha1::Sha1;
    use sha2::{Sha256, Sha384, Sha512};
    use sha3::{Sha3_256, Sha3_384, Sha3_512};
    use sha2::Digest;

    let algorithm = args.get(0).to_rust_string_lossy(scope);
    let data = read_bytes(args.get(1)).unwrap_or_default();

    let digest_bytes: Vec<u8> = match algorithm.as_str() {
        "SHA-1" => Sha1::digest(&data).to_vec(),
        "SHA-256" => Sha256::digest(&data).to_vec(),
        "SHA-384" => Sha384::digest(&data).to_vec(),
        "SHA-512" => Sha512::digest(&data).to_vec(),
        "SHA3-256" => Sha3_256::digest(&data).to_vec(),
        "SHA3-384" => Sha3_384::digest(&data).to_vec(),
        "SHA3-512" => Sha3_512::digest(&data).to_vec(),
        _ => {
            let msg = v8::String::new(
                scope,
                &format!("digest: unrecognized algorithm name \"{algorithm}\""),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, digest_bytes).into());
}

/// `op_crypto_generate_key(algorithm: String, length: u32) -> Uint8Array` —
/// generate `length / 8` cryptographically-secure random bytes for a new
/// symmetric key (HMAC or AES). `algorithm` is "HMAC" or "AES" (ignored
/// beyond dispatch — the op just needs the byte count). The JS layer has
/// already validated `length` (128/192/256 for AES; any for HMAC). Returns
/// a fresh Uint8Array with the key material.
fn op_crypto_generate_key(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand::RngCore;

    let _algorithm = args.get(0).to_rust_string_lossy(scope);
    let length_bits = args.get(1).uint32_value(scope).unwrap_or(0);
    let byte_len = (length_bits / 8) as usize;
    let mut bytes = vec![0u8; byte_len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    rv.set(vec_to_uint8_array(scope, bytes).into());
}

/// `op_crypto_sign_hmac(keyData: Uint8Array, hashName: String, data:
/// Uint8Array) -> Uint8Array` — compute HMAC of `data` with `keyData` using
/// the hash named by `hashName` (SHA-1, SHA-256, SHA-384, SHA-512). Returns
/// the HMAC tag as a fresh Uint8Array. HMAC is implemented manually (RFC
/// 2104) because the `hmac` crate (0.12) pulls `digest` 0.10 which
/// conflicts with `sha2` 0.11's `digest` 0.11.
fn op_crypto_sign_hmac(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use sha1::Sha1;
    use sha2::{Sha256, Sha384, Sha512};
    use sha2::Digest;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let hash_name = args.get(1).to_rust_string_lossy(scope);
    let data = read_bytes(args.get(2)).unwrap_or_default();

    let (block_size, output_size) = match hash_name.as_str() {
        "SHA-1" => (64, 20),
        "SHA-256" => (64, 32),
        "SHA-384" => (128, 48),
        "SHA-512" => (128, 64),
        _ => {
            let msg = v8::String::new(
                scope,
                &format!("HMAC: unsupported hash \"{hash_name}\""),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let mut key = key_data.clone();
    if key.len() > block_size {
        let hashed = match hash_name.as_str() {
            "SHA-1" => Sha1::digest(&key).to_vec(),
            "SHA-256" => Sha256::digest(&key).to_vec(),
            "SHA-384" => Sha384::digest(&key).to_vec(),
            "SHA-512" => Sha512::digest(&key).to_vec(),
            _ => unreachable!(),
        };
        key = hashed;
    }
    if key.len() < block_size {
        key.resize(block_size, 0u8);
    }

    let mut o_key_pad = vec![0x5cu8; block_size];
    let mut i_key_pad = vec![0x36u8; block_size];
    for i in 0..block_size {
        o_key_pad[i] ^= key[i];
        i_key_pad[i] ^= key[i];
    }

    let inner_hash: Vec<u8> = {
        let mut inner = i_key_pad;
        inner.extend_from_slice(&data);
        match hash_name.as_str() {
            "SHA-1" => Sha1::digest(&inner).to_vec(),
            "SHA-256" => Sha256::digest(&inner).to_vec(),
            "SHA-384" => Sha384::digest(&inner).to_vec(),
            "SHA-512" => Sha512::digest(&inner).to_vec(),
            _ => unreachable!(),
        }
    };

    let outer_input = {
        let mut outer = o_key_pad;
        outer.extend_from_slice(&inner_hash);
        outer
    };

    let tag: Vec<u8> = match hash_name.as_str() {
        "SHA-1" => Sha1::digest(&outer_input).to_vec(),
        "SHA-256" => Sha256::digest(&outer_input).to_vec(),
        "SHA-384" => Sha384::digest(&outer_input).to_vec(),
        "SHA-512" => Sha512::digest(&outer_input).to_vec(),
        _ => unreachable!(),
    };

    let _ = output_size;
    rv.set(vec_to_uint8_array(scope, tag).into());
}

/// `op_crypto_encrypt_aes_cbc(keyData: Uint8Array, iv: Uint8Array, data:
/// Uint8Array) -> Uint8Array` — AES-CBC encryption with PKCS7 padding.
/// Returns the ciphertext as a fresh Uint8Array.
fn op_crypto_encrypt_aes_cbc(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
    type Aes192CbcEnc = cbc::Encryptor<aes::Aes192>;
    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    let key = read_bytes(args.get(0)).unwrap_or_default();
    let iv = read_bytes(args.get(1)).unwrap_or_default();
    let data = read_bytes(args.get(2)).unwrap_or_default();

    if iv.len() != 16 {
        let msg = v8::String::new(scope, "AES-CBC: IV must be 16 bytes").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let cipher_text: Vec<u8> = match key.len() {
        16 => Aes128CbcEnc::new(key.as_slice().into(), iv.as_slice().into())
            .encrypt_padded_vec_mut::<Pkcs7>(&data),
        24 => Aes192CbcEnc::new(key.as_slice().into(), iv.as_slice().into())
            .encrypt_padded_vec_mut::<Pkcs7>(&data),
        32 => Aes256CbcEnc::new(key.as_slice().into(), iv.as_slice().into())
            .encrypt_padded_vec_mut::<Pkcs7>(&data),
        _ => {
            let msg = v8::String::new(
                scope,
                &format!("AES-CBC: invalid key length {}", key.len() * 8),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, cipher_text).into());
}

/// `op_crypto_decrypt_aes_cbc(keyData: Uint8Array, iv: Uint8Array, data:
/// Uint8Array) -> Uint8Array` — AES-CBC decryption with PKCS7 unpadding.
/// Throws on padding error (the JS layer converts to OperationError).
fn op_crypto_decrypt_aes_cbc(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
    type Aes192CbcDec = cbc::Decryptor<aes::Aes192>;
    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

    let key = read_bytes(args.get(0)).unwrap_or_default();
    let iv = read_bytes(args.get(1)).unwrap_or_default();
    let data = read_bytes(args.get(2)).unwrap_or_default();

    if iv.len() != 16 {
        let msg = v8::String::new(scope, "AES-CBC: IV must be 16 bytes").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let plain_text: Option<Vec<u8>> = match key.len() {
        16 => Aes128CbcDec::new(key.as_slice().into(), iv.as_slice().into())
            .decrypt_padded_vec_mut::<Pkcs7>(&data)
            .ok(),
        24 => Aes192CbcDec::new(key.as_slice().into(), iv.as_slice().into())
            .decrypt_padded_vec_mut::<Pkcs7>(&data)
            .ok(),
        32 => Aes256CbcDec::new(key.as_slice().into(), iv.as_slice().into())
            .decrypt_padded_vec_mut::<Pkcs7>(&data)
            .ok(),
        _ => None,
    };

    match plain_text {
        Some(pt) => rv.set(vec_to_uint8_array(scope, pt).into()),
        None => {
            let msg = v8::String::new(scope, "AES-CBC: decryption failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

/// `op_crypto_encrypt_aes_ctr(keyData: Uint8Array, counter: Uint8Array,
/// ctrLength: u32, data: Uint8Array) -> Uint8Array` — AES-CTR encryption
/// (no padding; CTR is symmetric so encrypt == decrypt). `ctrLength` is
/// the counter length in bits (1-128) but is unused here — the full 128-bit
/// counter block is used as-is.
fn op_crypto_encrypt_aes_ctr(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{KeyIvInit, StreamCipher};
    type Aes128CtrEnc = ctr::Ctr128BE<aes::Aes128>;
    type Aes192CtrEnc = ctr::Ctr128BE<aes::Aes192>;
    type Aes256CtrEnc = ctr::Ctr128BE<aes::Aes256>;

    let key = read_bytes(args.get(0)).unwrap_or_default();
    let counter = read_bytes(args.get(1)).unwrap_or_default();
    let _ctr_length = args.get(2).uint32_value(scope).unwrap_or(0);
    let data = read_bytes(args.get(3)).unwrap_or_default();

    if counter.len() != 16 {
        let msg = v8::String::new(scope, "AES-CTR: counter must be 16 bytes").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let mut buf = data.clone();
    match key.len() {
        16 => {
            let mut cipher = Aes128CtrEnc::new(key.as_slice().into(), counter.as_slice().into());
            cipher.apply_keystream(&mut buf);
        }
        24 => {
            let mut cipher = Aes192CtrEnc::new(key.as_slice().into(), counter.as_slice().into());
            cipher.apply_keystream(&mut buf);
        }
        32 => {
            let mut cipher = Aes256CtrEnc::new(key.as_slice().into(), counter.as_slice().into());
            cipher.apply_keystream(&mut buf);
        }
        _ => {
            let msg = v8::String::new(
                scope,
                &format!("AES-CTR: invalid key length {}", key.len() * 8),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    }

    rv.set(vec_to_uint8_array(scope, buf).into());
}

/// `op_crypto_decrypt_aes_ctr(keyData: Uint8Array, counter: Uint8Array,
/// ctrLength: u32, data: Uint8Array) -> Uint8Array` — AES-CTR decryption
/// (identical to encryption — CTR is a stream cipher).
fn op_crypto_decrypt_aes_ctr(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    op_crypto_encrypt_aes_ctr(scope, args, rv);
}

fn gcm_compute_tag(
    ghash_key: &[u8; 16],
    iv: &[u8],
    aad: &[u8],
    data: &[u8],
) -> ([u8; 16], [u8; 16]) {
    use cipher::generic_array::GenericArray;
    use ghash::universal_hash::{KeyInit, UniversalHash};

    let mut ghash = ghash::GHash::new(GenericArray::from_slice(ghash_key));

    let j0: [u8; 16] = if iv.len() == 12 {
        let mut block = [0u8; 16];
        block[..12].copy_from_slice(iv);
        block[15] = 1;
        block
    } else {
        ghash.update_padded(iv);
        let mut len_block = [0u8; 16];
        let iv_bits = (iv.len() as u64) * 8;
        len_block[8..].copy_from_slice(&iv_bits.to_be_bytes());
        ghash.update(&[GenericArray::from_slice(&len_block).clone()]);
        let j0_ga = ghash.finalize();
        let mut block = [0u8; 16];
        block.copy_from_slice(&j0_ga);
        block
    };

    let mut ghash2 = ghash::GHash::new(GenericArray::from_slice(ghash_key));
    ghash2.update_padded(aad);
    ghash2.update_padded(data);
    let aad_bits = (aad.len() as u64) * 8;
    let data_bits = (data.len() as u64) * 8;
    let mut len_block = [0u8; 16];
    len_block[..8].copy_from_slice(&aad_bits.to_be_bytes());
    len_block[8..].copy_from_slice(&data_bits.to_be_bytes());
    ghash2.update(&[GenericArray::from_slice(&len_block).clone()]);
    let tag = ghash2.finalize();
    let mut tag_arr = [0u8; 16];
    tag_arr.copy_from_slice(&tag);

    (j0, tag_arr)
}

/// `op_crypto_encrypt_aes_gcm(keyData: Uint8Array, iv: Uint8Array,
/// additionalData: Uint8Array|null, tagLength: u32, data: Uint8Array) ->
/// Uint8Array` — AES-GCM encryption. Returns ciphertext + tag concatenated
/// (tag at the end, `tagLength/8` bytes). `tagLength` is in bits (32-128).
fn op_crypto_encrypt_aes_gcm(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{BlockEncrypt, KeyInit, KeyIvInit, StreamCipher};
    use cipher::generic_array::GenericArray;

    let key = read_bytes(args.get(0)).unwrap_or_default();
    let iv = read_bytes(args.get(1)).unwrap_or_default();
    let aad_val = args.get(2);
    let tag_length = args.get(3).uint32_value(scope).unwrap_or(128);
    let data = read_bytes(args.get(4)).unwrap_or_default();

    let tag_bytes = (tag_length / 8) as usize;
    if tag_bytes < 4 || tag_bytes > 16 {
        let msg = v8::String::new(scope, "AES-GCM: invalid tag length").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let aad: Vec<u8> = if aad_val.is_null_or_undefined() {
        Vec::new()
    } else {
        read_bytes(aad_val).unwrap_or_default()
    };

    macro_rules! do_gcm_encrypt {
        ($cipher_ty:ty) => {{
            let cipher = <$cipher_ty>::new(GenericArray::from_slice(&key));

            let mut ghash_key = [0u8; 16];
            cipher.encrypt_block(GenericArray::from_mut_slice(&mut ghash_key));

            let (j0, _) = gcm_compute_tag(&ghash_key, &iv, &aad, &[]);

            let mut ctr_state = j0;
            ctr_state[15] = ctr_state[15].wrapping_add(1);
            let mut ctr_enc = ctr::Ctr32BE::<$cipher_ty>::new(
                GenericArray::from_slice(&key),
                GenericArray::from_slice(&ctr_state),
            );

            let mut buffer = data.clone();
            if !buffer.is_empty() {
                ctr_enc.apply_keystream(&mut buffer);
            }

            let (_, mut tag) = gcm_compute_tag(&ghash_key, &iv, &aad, &buffer);

            let mut mask = j0;
            cipher.encrypt_block(GenericArray::from_mut_slice(&mut mask));
            for (a, b) in tag.iter_mut().zip(mask.iter()) {
                *a ^= *b;
            }

            let mut output = Vec::with_capacity(buffer.len() + tag_bytes);
            output.extend_from_slice(&buffer);
            output.extend_from_slice(&tag[..tag_bytes]);
            output
        }};
    }

    let output = match key.len() {
        16 => do_gcm_encrypt!(aes::Aes128),
        24 => do_gcm_encrypt!(aes::Aes192),
        32 => do_gcm_encrypt!(aes::Aes256),
        _ => {
            let msg = v8::String::new(
                scope,
                &format!("AES-GCM: invalid key length {}", key.len() * 8),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, output).into());
}

/// `op_crypto_decrypt_aes_gcm(keyData: Uint8Array, iv: Uint8Array,
/// additionalData: Uint8Array|null, tagLength: u32, ciphertext: Uint8Array)
/// -> Uint8Array` — AES-GCM decryption. Expects ciphertext with truncated
/// tag appended. On authentication failure, throws a TypeError.
fn op_crypto_decrypt_aes_gcm(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{BlockEncrypt, KeyInit, KeyIvInit, StreamCipher};
    use cipher::generic_array::GenericArray;

    let key = read_bytes(args.get(0)).unwrap_or_default();
    let iv = read_bytes(args.get(1)).unwrap_or_default();
    let aad_val = args.get(2);
    let tag_length = args.get(3).uint32_value(scope).unwrap_or(128);
    let data = read_bytes(args.get(4)).unwrap_or_default();

    let tag_bytes = (tag_length / 8) as usize;
    if tag_bytes < 4 || tag_bytes > 16 {
        let msg = v8::String::new(scope, "AES-GCM: invalid tag length").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    if data.len() < tag_bytes {
        let msg = v8::String::new(scope, "AES-GCM: ciphertext too short").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let aad: Vec<u8> = if aad_val.is_null_or_undefined() {
        Vec::new()
    } else {
        read_bytes(aad_val).unwrap_or_default()
    };

    let ct_len = data.len() - tag_bytes;
    let ciphertext = &data[..ct_len];
    let provided_tag = &data[ct_len..];

    macro_rules! do_gcm_decrypt {
        ($cipher_ty:ty) => {{
            let cipher = <$cipher_ty>::new(GenericArray::from_slice(&key));

            let mut ghash_key = [0u8; 16];
            cipher.encrypt_block(GenericArray::from_mut_slice(&mut ghash_key));

            let (j0, mut tag) = gcm_compute_tag(&ghash_key, &iv, &aad, ciphertext);

            let mut mask = j0;
            cipher.encrypt_block(GenericArray::from_mut_slice(&mut mask));
            for (a, b) in tag.iter_mut().zip(mask.iter()) {
                *a ^= *b;
            }

            let tag_match = tag[..tag_bytes]
                .iter()
                .zip(provided_tag.iter())
                .all(|(a, b)| a == b);

            if !tag_match {
                None
            } else {
                let mut ctr_state = j0;
                ctr_state[15] = ctr_state[15].wrapping_add(1);
                let mut ctr_dec = ctr::Ctr32BE::<$cipher_ty>::new(
                    GenericArray::from_slice(&key),
                    GenericArray::from_slice(&ctr_state),
                );
                let mut plain_text = ciphertext.to_vec();
                if !plain_text.is_empty() {
                    ctr_dec.apply_keystream(&mut plain_text);
                }
                Some(plain_text)
            }
        }};
    }

    let result = match key.len() {
        16 => do_gcm_decrypt!(aes::Aes128),
        24 => do_gcm_decrypt!(aes::Aes192),
        32 => do_gcm_decrypt!(aes::Aes256),
        _ => {
            let msg = v8::String::new(
                scope,
                &format!("AES-GCM: invalid key length {}", key.len() * 8),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    match result {
        Some(pt) => rv.set(vec_to_uint8_array(scope, pt).into()),
        None => {
            let msg = v8::String::new(scope, "AES-GCM: decryption failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

// --- RSA ops ---------------------------------------------------------------

use rsa::traits::PublicKeyParts;
use pkcs8::DecodePrivateKey;
use spki::DecodePublicKey;
use pkcs8::EncodePrivateKey;
use spki::EncodePublicKey;

fn op_crypto_generate_rsa_key(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand_core::UnwrapErr;
    use getrandom::SysRng;

    let modulus_length = args.get(0).uint32_value(scope).unwrap_or(2048) as usize;
    let exp_bytes = read_bytes(args.get(1)).unwrap_or_default();
    let exp = rsa::BoxedUint::from_be_slice_vartime(&exp_bytes);

    let mut rng = UnwrapErr(SysRng::default());
    let private_key = match rsa::RsaPrivateKey::new_with_exp(&mut rng, modulus_length, exp) {
        Ok(k) => k,
        Err(e) => {
            let msg = v8::String::new(
                scope,
                &format!("RSA key generation failed: {e}"),
            ).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let pkcs8_der = match private_key.to_pkcs8_der() {
        Ok(doc) => doc.as_bytes().to_vec(),
        Err(e) => {
            let msg = v8::String::new(scope, &format!("RSA PKCS8 export failed: {e}")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let public_key = rsa::RsaPublicKey::from(&private_key);
    let spki_der = match public_key.to_public_key_der() {
        Ok(doc) => doc.as_bytes().to_vec(),
        Err(e) => {
            let msg = v8::String::new(scope, &format!("RSA SPKI export failed: {e}")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let result = v8::Object::new(scope);
    let pk_key = v8::String::new(scope, "privateKey").unwrap();
    let pk_val = vec_to_uint8_array(scope, pkcs8_der);
    result.set(scope, pk_key.into(), pk_val.into());
    let pub_key = v8::String::new(scope, "publicKey").unwrap();
    let pub_val = vec_to_uint8_array(scope, spki_der);
    result.set(scope, pub_key.into(), pub_val.into());
    rv.set(result.into());
}

fn op_crypto_import_rsa_pkcs8(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let pkcs8 = read_bytes(args.get(0)).unwrap_or_default();
    let private_key = match rsa::RsaPrivateKey::from_pkcs8_der(&pkcs8) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA import: invalid PKCS8 data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let modulus_length = private_key.n().bits() as u32;
    let public_exponent = private_key.e().to_be_bytes_trimmed_vartime().to_vec();
    let pkcs8_der = match private_key.to_pkcs8_der() {
        Ok(doc) => doc.as_bytes().to_vec(),
        Err(_) => {
            let msg = v8::String::new(scope, "RSA import: PKCS8 export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let result = v8::Object::new(scope);
    let ml_key = v8::String::new(scope, "modulusLength").unwrap();
    let ml_val = v8::Number::new(scope, modulus_length as f64);
    result.set(scope, ml_key.into(), ml_val.into());
    let pe_key = v8::String::new(scope, "publicExponent").unwrap();
    let pe_val = vec_to_uint8_array(scope, public_exponent);
    result.set(scope, pe_key.into(), pe_val.into());
    let rd_key = v8::String::new(scope, "rawData").unwrap();
    let rd_val = vec_to_uint8_array(scope, pkcs8_der);
    result.set(scope, rd_key.into(), rd_val.into());
    rv.set(result.into());
}

fn op_crypto_import_rsa_spki(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let spki = read_bytes(args.get(0)).unwrap_or_default();
    let public_key = match rsa::RsaPublicKey::from_public_key_der(&spki) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA import: invalid SPKI data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let modulus_length = public_key.n().bits() as u32;
    let public_exponent = public_key.e().to_be_bytes_trimmed_vartime().to_vec();
    let spki_der = match public_key.to_public_key_der() {
        Ok(doc) => doc.as_bytes().to_vec(),
        Err(_) => {
            let msg = v8::String::new(scope, "RSA import: SPKI export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let result = v8::Object::new(scope);
    let ml_key = v8::String::new(scope, "modulusLength").unwrap();
    let ml_val = v8::Number::new(scope, modulus_length as f64);
    result.set(scope, ml_key.into(), ml_val.into());
    let pe_key = v8::String::new(scope, "publicExponent").unwrap();
    let pe_val = vec_to_uint8_array(scope, public_exponent);
    result.set(scope, pe_key.into(), pe_val.into());
    let rd_key = v8::String::new(scope, "rawData").unwrap();
    let rd_val = vec_to_uint8_array(scope, spki_der);
    result.set(scope, rd_key.into(), rd_val.into());
    rv.set(result.into());
}

fn op_crypto_export_rsa_pkcs8(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let private_key = match rsa::RsaPrivateKey::from_pkcs8_der(&key_data) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA export: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let pkcs8_der = match private_key.to_pkcs8_der() {
        Ok(doc) => doc.as_bytes().to_vec(),
        Err(_) => {
            let msg = v8::String::new(scope, "RSA export: PKCS8 export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    rv.set(vec_to_uint8_array(scope, pkcs8_der).into());
}

fn op_crypto_export_rsa_spki(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let public_key = match rsa::RsaPublicKey::from_public_key_der(&key_data) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA export: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let spki_der = match public_key.to_public_key_der() {
        Ok(doc) => doc.as_bytes().to_vec(),
        Err(_) => {
            let msg = v8::String::new(scope, "RSA export: SPKI export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    rv.set(vec_to_uint8_array(scope, spki_der).into());
}

fn op_crypto_import_rsa_jwk(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rsa::traits::PublicKeyParts;

    let jwk = args.get(0);
    let jwk = if jwk.is_object() {
        v8::Local::<v8::Object>::try_from(jwk).unwrap()
    } else {
        let msg = v8::String::new(scope, "RSA JWK import: not an object").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    };

    fn get_b64url_field(
        scope: &mut v8::PinScope,
        obj: v8::Local<v8::Object>,
        key: &str,
    ) -> Option<Vec<u8>> {
        let key_str = v8::String::new(scope, key).unwrap();
        let val = obj.get(scope, key_str.into())?;
        if val.is_null_or_undefined() {
            return None;
        }
        let s = val.to_rust_string_lossy(scope);
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        match base64::Engine::decode(&engine, &s) {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                let engine = base64::engine::general_purpose::STANDARD_NO_PAD;
                match base64::Engine::decode(&engine, s) {
                    Ok(bytes) => Some(bytes),
                    Err(_) => None,
                }
            }
        }
    }

    let n = match get_b64url_field(scope, jwk, "n") {
        Some(v) => v,
        None => {
            let msg = v8::String::new(scope, "RSA JWK import: missing or invalid 'n'").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let e = match get_b64url_field(scope, jwk, "e") {
        Some(v) => v,
        None => {
            let msg = v8::String::new(scope, "RSA JWK import: missing or invalid 'e'").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let d = get_b64url_field(scope, jwk, "d");

    if let Some(d_bytes) = d {
        let bits = (n.len() * 8) as u32;
        let n_uint = match rsa::BoxedUint::from_be_slice(&n, bits) {
            Ok(v) => v,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid modulus").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };
        let e_uint = match rsa::BoxedUint::from_be_slice(&e, bits) {
            Ok(v) => v,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid exponent").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };
        let d_uint = match rsa::BoxedUint::from_be_slice(&d_bytes, bits) {
            Ok(v) => v,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid private exponent").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let mut primes = Vec::new();
        if let Some(p_bytes) = get_b64url_field(scope, jwk, "p") {
            let p_bits = (p_bytes.len() * 8) as u32;
            if let Ok(p_uint) = rsa::BoxedUint::from_be_slice(&p_bytes, p_bits) {
                primes.push(p_uint);
            }
        }
        if let Some(q_bytes) = get_b64url_field(scope, jwk, "q") {
            let q_bits = (q_bytes.len() * 8) as u32;
            if let Ok(q_uint) = rsa::BoxedUint::from_be_slice(&q_bytes, q_bits) {
                primes.push(q_uint);
            }
        }

        let private_key = match rsa::RsaPrivateKey::from_components(n_uint, e_uint, d_uint, primes) {
            Ok(k) => k,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid key components").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let modulus_length = private_key.n().bits_vartime() as u32;
        let public_exponent = private_key.e().to_be_bytes_trimmed_vartime().to_vec();
        let pkcs8_der = match private_key.to_pkcs8_der() {
            Ok(doc) => doc.as_bytes().to_vec(),
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: PKCS8 export failed").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let result = v8::Object::new(scope);
        let kt_key = v8::String::new(scope, "keyType").unwrap();
        let kt_val = v8::String::new(scope, "private").unwrap();
        result.set(scope, kt_key.into(), kt_val.into());
        let ml_key = v8::String::new(scope, "modulusLength").unwrap();
        let ml_val = v8::Number::new(scope, modulus_length as f64);
        result.set(scope, ml_key.into(), ml_val.into());
        let pe_key = v8::String::new(scope, "publicExponent").unwrap();
        let pe_val = vec_to_uint8_array(scope, public_exponent);
        result.set(scope, pe_key.into(), pe_val.into());
        let rd_key = v8::String::new(scope, "rawData").unwrap();
        let rd_val = vec_to_uint8_array(scope, pkcs8_der);
        result.set(scope, rd_key.into(), rd_val.into());
        rv.set(result.into());
    } else {
        let bits = (n.len() * 8) as u32;
        let n_uint = match rsa::BoxedUint::from_be_slice(&n, bits) {
            Ok(v) => v,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid modulus").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };
        let e_uint = match rsa::BoxedUint::from_be_slice(&e, bits) {
            Ok(v) => v,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid exponent").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };
        let public_key = match rsa::RsaPublicKey::new(n_uint, e_uint) {
            Ok(k) => k,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: invalid public key").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let modulus_length = public_key.n().bits_vartime() as u32;
        let public_exponent = public_key.e().to_be_bytes_trimmed_vartime().to_vec();
        let spki_der = match public_key.to_public_key_der() {
            Ok(doc) => doc.as_bytes().to_vec(),
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK import: SPKI export failed").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let result = v8::Object::new(scope);
        let kt_key = v8::String::new(scope, "keyType").unwrap();
        let kt_val = v8::String::new(scope, "public").unwrap();
        result.set(scope, kt_key.into(), kt_val.into());
        let ml_key = v8::String::new(scope, "modulusLength").unwrap();
        let ml_val = v8::Number::new(scope, modulus_length as f64);
        result.set(scope, ml_key.into(), ml_val.into());
        let pe_key = v8::String::new(scope, "publicExponent").unwrap();
        let pe_val = vec_to_uint8_array(scope, public_exponent);
        result.set(scope, pe_key.into(), pe_val.into());
        let rd_key = v8::String::new(scope, "rawData").unwrap();
        let rd_val = vec_to_uint8_array(scope, spki_der);
        result.set(scope, rd_key.into(), rd_val.into());
        rv.set(result.into());
    }
}

fn op_crypto_export_rsa_jwk(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rsa::traits::PublicKeyParts;
    use rsa::traits::PrivateKeyParts;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let is_private = args.get(1).to_rust_string_lossy(scope) == "private";

    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;

    if is_private {
        let private_key = match rsa::RsaPrivateKey::from_pkcs8_der(&key_data) {
            Ok(k) => k,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK export: invalid key data").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let n_bytes = private_key.n().to_be_bytes_trimmed_vartime();
        let e_bytes = private_key.e().to_be_bytes_trimmed_vartime();
        let d_bytes = private_key.d().to_be_bytes_trimmed_vartime();

        let result = v8::Object::new(scope);
        let kty_key = v8::String::new(scope, "kty").unwrap();
        let kty_val = v8::String::new(scope, "RSA").unwrap();
        result.set(scope, kty_key.into(), kty_val.into());

        let n_str = base64::Engine::encode(&engine, n_bytes.as_ref());
        let n_key = v8::String::new(scope, "n").unwrap();
        let n_val = v8::String::new(scope, &n_str).unwrap();
        result.set(scope, n_key.into(), n_val.into());

        let e_str = base64::Engine::encode(&engine, e_bytes.as_ref());
        let e_key = v8::String::new(scope, "e").unwrap();
        let e_val = v8::String::new(scope, &e_str).unwrap();
        result.set(scope, e_key.into(), e_val.into());

        let d_str = base64::Engine::encode(&engine, d_bytes.as_ref());
        let d_key = v8::String::new(scope, "d").unwrap();
        let d_val = v8::String::new(scope, &d_str).unwrap();
        result.set(scope, d_key.into(), d_val.into());

        let primes = private_key.primes();
        if primes.len() >= 2 {
            let p_bytes = primes[0].to_be_bytes_trimmed_vartime();
            let q_bytes = primes[1].to_be_bytes_trimmed_vartime();
            let p_str = base64::Engine::encode(&engine, p_bytes.as_ref());
            let q_str = base64::Engine::encode(&engine, q_bytes.as_ref());
            let p_key = v8::String::new(scope, "p").unwrap();
            let p_val = v8::String::new(scope, &p_str).unwrap();
            result.set(scope, p_key.into(), p_val.into());
            let q_key = v8::String::new(scope, "q").unwrap();
            let q_val = v8::String::new(scope, &q_str).unwrap();
            result.set(scope, q_key.into(), q_val.into());
        }

        if let (Some(dp), Some(dq)) = (private_key.dp(), private_key.dq()) {
            let dp_bytes = dp.to_be_bytes_trimmed_vartime();
            let dq_bytes = dq.to_be_bytes_trimmed_vartime();
            let dp_str = base64::Engine::encode(&engine, dp_bytes.as_ref());
            let dq_str = base64::Engine::encode(&engine, dq_bytes.as_ref());
            let dp_key = v8::String::new(scope, "dp").unwrap();
            let dp_val = v8::String::new(scope, &dp_str).unwrap();
            result.set(scope, dp_key.into(), dp_val.into());
            let dq_key = v8::String::new(scope, "dq").unwrap();
            let dq_val = v8::String::new(scope, &dq_str).unwrap();
            result.set(scope, dq_key.into(), dq_val.into());
        }

        if let Some(qinv) = private_key.qinv() {
            let qi_uint = qinv.retrieve();
            let qi_bytes = qi_uint.to_be_bytes_trimmed_vartime();
            let qi_str = base64::Engine::encode(&engine, qi_bytes.as_ref());
            let qi_key = v8::String::new(scope, "qi").unwrap();
            let qi_val = v8::String::new(scope, &qi_str).unwrap();
            result.set(scope, qi_key.into(), qi_val.into());
        }

        rv.set(result.into());
    } else {
        let public_key = match rsa::RsaPublicKey::from_public_key_der(&key_data) {
            Ok(k) => k,
            Err(_) => {
                let msg = v8::String::new(scope, "RSA JWK export: invalid key data").unwrap();
                scope.throw_exception(v8::Exception::type_error(scope, msg));
                return;
            }
        };

        let n_bytes = public_key.n().to_be_bytes_trimmed_vartime();
        let e_bytes = public_key.e().to_be_bytes_trimmed_vartime();

        let result = v8::Object::new(scope);
        let kty_key = v8::String::new(scope, "kty").unwrap();
        let kty_val = v8::String::new(scope, "RSA").unwrap();
        result.set(scope, kty_key.into(), kty_val.into());

        let n_str = base64::Engine::encode(&engine, n_bytes.as_ref());
        let n_key = v8::String::new(scope, "n").unwrap();
        let n_val = v8::String::new(scope, &n_str).unwrap();
        result.set(scope, n_key.into(), n_val.into());

        let e_str = base64::Engine::encode(&engine, e_bytes.as_ref());
        let e_key = v8::String::new(scope, "e").unwrap();
        let e_val = v8::String::new(scope, &e_str).unwrap();
        result.set(scope, e_key.into(), e_val.into());

        rv.set(result.into());
    }
}

fn op_crypto_sign_rsa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rsa::pkcs1v15::SigningKey;
    use rsa::pss::SigningKey as PssSigningKey;
    use rsa::signature::Signer;
    use signature::SignatureEncoding;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let algorithm = args.get(1).to_rust_string_lossy(scope);
    let hash_name = args.get(2).to_rust_string_lossy(scope);
    let salt_length = args.get(3).uint32_value(scope).unwrap_or(0) as usize;
    let data = read_bytes(args.get(4)).unwrap_or_default();

    let private_key = match rsa::RsaPrivateKey::from_pkcs8_der(&key_data) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA sign: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let signature: Vec<u8> = match algorithm.as_str() {
        "RSASSA-PKCS1-v1_5" => {
            match hash_name.as_str() {
                "SHA-1" => {
                    let signing_key: SigningKey<sha1::Sha1> = SigningKey::new(private_key);
                    signing_key.sign(&data).to_vec()
                }
                "SHA-256" => {
                    let signing_key: SigningKey<sha2::Sha256> = SigningKey::new(private_key);
                    signing_key.sign(&data).to_vec()
                }
                "SHA-384" => {
                    let signing_key: SigningKey<sha2::Sha384> = SigningKey::new(private_key);
                    signing_key.sign(&data).to_vec()
                }
                "SHA-512" => {
                    let signing_key: SigningKey<sha2::Sha512> = SigningKey::new(private_key);
                    signing_key.sign(&data).to_vec()
                }
                _ => {
                    let msg = v8::String::new(scope, &format!("RSA sign: unsupported hash \"{hash_name}\"")).unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        }
        "RSA-PSS" => {
            use rand_core::UnwrapErr;
            use getrandom::SysRng;
            use rsa::signature::RandomizedSigner;
            let mut rng = UnwrapErr(SysRng::default());
            match hash_name.as_str() {
                "SHA-1" => {
                    let signing_key: PssSigningKey<sha1::Sha1> = PssSigningKey::new_with_salt_len(private_key, salt_length);
                    let signature = signing_key.sign_with_rng(&mut rng, &data);
                    signature.to_bytes().to_vec()
                }
                "SHA-256" => {
                    let signing_key: PssSigningKey<sha2::Sha256> = PssSigningKey::new_with_salt_len(private_key, salt_length);
                    let signature = signing_key.sign_with_rng(&mut rng, &data);
                    signature.to_bytes().to_vec()
                }
                "SHA-384" => {
                    let signing_key: PssSigningKey<sha2::Sha384> = PssSigningKey::new_with_salt_len(private_key, salt_length);
                    let signature = signing_key.sign_with_rng(&mut rng, &data);
                    signature.to_bytes().to_vec()
                }
                "SHA-512" => {
                    let signing_key: PssSigningKey<sha2::Sha512> = PssSigningKey::new_with_salt_len(private_key, salt_length);
                    let signature = signing_key.sign_with_rng(&mut rng, &data);
                    signature.to_bytes().to_vec()
                }
                _ => {
                    let msg = v8::String::new(scope, &format!("RSA-PSS sign: unsupported hash \"{hash_name}\"")).unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        }
        _ => {
            let msg = v8::String::new(scope, &format!("RSA sign: unsupported algorithm \"{algorithm}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, signature).into());
}

fn op_crypto_verify_rsa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rsa::pkcs1v15::VerifyingKey;
    use rsa::pss::VerifyingKey as PssVerifyingKey;
    use rsa::signature::Verifier;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let algorithm = args.get(1).to_rust_string_lossy(scope);
    let hash_name = args.get(2).to_rust_string_lossy(scope);
    let salt_length = args.get(3).uint32_value(scope).unwrap_or(0) as usize;
    let signature = read_bytes(args.get(4)).unwrap_or_default();
    let data = read_bytes(args.get(5)).unwrap_or_default();

    let public_key = match rsa::RsaPublicKey::from_public_key_der(&key_data) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA verify: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let verified = match algorithm.as_str() {
        "RSASSA-PKCS1-v1_5" => {
            let sig = match rsa::pkcs1v15::Signature::try_from(signature.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    rv.set(v8::Boolean::new(scope, false).into());
                    return;
                }
            };
            match hash_name.as_str() {
                "SHA-1" => {
                    let vk: VerifyingKey<sha1::Sha1> = VerifyingKey::new(public_key);
                    vk.verify(&data, &sig).is_ok()
                }
                "SHA-256" => {
                    let vk: VerifyingKey<sha2::Sha256> = VerifyingKey::new(public_key);
                    vk.verify(&data, &sig).is_ok()
                }
                "SHA-384" => {
                    let vk: VerifyingKey<sha2::Sha384> = VerifyingKey::new(public_key);
                    vk.verify(&data, &sig).is_ok()
                }
                "SHA-512" => {
                    let vk: VerifyingKey<sha2::Sha512> = VerifyingKey::new(public_key);
                    vk.verify(&data, &sig).is_ok()
                }
                _ => false,
            }
        }
        "RSA-PSS" => {
            let sig = match rsa::pss::Signature::try_from(signature.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    rv.set(v8::Boolean::new(scope, false).into());
                    return;
                }
            };
            match hash_name.as_str() {
                "SHA-1" => {
                    let vk: PssVerifyingKey<sha1::Sha1> = PssVerifyingKey::new_with_salt_len(public_key, salt_length);
                    vk.verify(&data, &sig).is_ok()
                }
                "SHA-256" => {
                    let vk: PssVerifyingKey<sha2::Sha256> = PssVerifyingKey::new_with_salt_len(public_key, salt_length);
                    vk.verify(&data, &sig).is_ok()
                }
                "SHA-384" => {
                    let vk: PssVerifyingKey<sha2::Sha384> = PssVerifyingKey::new_with_salt_len(public_key, salt_length);
                    vk.verify(&data, &sig).is_ok()
                }
                "SHA-512" => {
                    let vk: PssVerifyingKey<sha2::Sha512> = PssVerifyingKey::new_with_salt_len(public_key, salt_length);
                    vk.verify(&data, &sig).is_ok()
                }
                _ => false,
            }
        }
        _ => false,
    };

    rv.set(v8::Boolean::new(scope, verified).into());
}

fn op_crypto_encrypt_rsa_oaep(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rsa::Oaep;
    use rand_core::UnwrapErr;
    use getrandom::SysRng;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let hash_name = args.get(1).to_rust_string_lossy(scope);
    let label_val = args.get(2);
    let data = read_bytes(args.get(3)).unwrap_or_default();

    let public_key = match rsa::RsaPublicKey::from_public_key_der(&key_data) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA-OAEP encrypt: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let label: Vec<u8> = if label_val.is_null_or_undefined() {
        Vec::new()
    } else {
        read_bytes(label_val).unwrap_or_default()
    };

    let mut rng = UnwrapErr(SysRng::default());

    let ciphertext: Vec<u8> = match hash_name.as_str() {
        "SHA-1" => {
            let padding = if label.is_empty() {
                Oaep::<sha1::Sha1>::new()
            } else {
                Oaep::<sha1::Sha1>::new_with_label(label.clone())
            };
            match public_key.encrypt(&mut rng, padding, &data) {
                Ok(ct) => ct,
                Err(_) => {
                    let msg = v8::String::new(scope, "RSA-OAEP encrypt failed").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        }
        "SHA-256" => {
            let padding = if label.is_empty() {
                Oaep::<sha2::Sha256>::new()
            } else {
                Oaep::<sha2::Sha256>::new_with_label(label.clone())
            };
            match public_key.encrypt(&mut rng, padding, &data) {
                Ok(ct) => ct,
                Err(_) => {
                    let msg = v8::String::new(scope, "RSA-OAEP encrypt failed").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        }
        "SHA-384" => {
            let padding = if label.is_empty() {
                Oaep::<sha2::Sha384>::new()
            } else {
                Oaep::<sha2::Sha384>::new_with_label(label.clone())
            };
            match public_key.encrypt(&mut rng, padding, &data) {
                Ok(ct) => ct,
                Err(_) => {
                    let msg = v8::String::new(scope, "RSA-OAEP encrypt failed").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        }
        "SHA-512" => {
            let padding = if label.is_empty() {
                Oaep::<sha2::Sha512>::new()
            } else {
                Oaep::<sha2::Sha512>::new_with_label(label.clone())
            };
            match public_key.encrypt(&mut rng, padding, &data) {
                Ok(ct) => ct,
                Err(_) => {
                    let msg = v8::String::new(scope, "RSA-OAEP encrypt failed").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            }
        }
        _ => {
            let msg = v8::String::new(scope, &format!("RSA-OAEP: unsupported hash \"{hash_name}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, ciphertext).into());
}

fn op_crypto_decrypt_rsa_oaep(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rsa::Oaep;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let hash_name = args.get(1).to_rust_string_lossy(scope);
    let label_val = args.get(2);
    let data = read_bytes(args.get(3)).unwrap_or_default();

    let private_key = match rsa::RsaPrivateKey::from_pkcs8_der(&key_data) {
        Ok(k) => k,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA-OAEP decrypt: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let label: Vec<u8> = if label_val.is_null_or_undefined() {
        Vec::new()
    } else {
        read_bytes(label_val).unwrap_or_default()
    };

    let plaintext: Result<Vec<u8>, rsa::Error> = match hash_name.as_str() {
        "SHA-1" => {
            let padding = if label.is_empty() {
                Oaep::<sha1::Sha1>::new()
            } else {
                Oaep::<sha1::Sha1>::new_with_label(label.clone())
            };
            private_key.decrypt(padding, &data)
        }
        "SHA-256" => {
            let padding = if label.is_empty() {
                Oaep::<sha2::Sha256>::new()
            } else {
                Oaep::<sha2::Sha256>::new_with_label(label.clone())
            };
            private_key.decrypt(padding, &data)
        }
        "SHA-384" => {
            let padding = if label.is_empty() {
                Oaep::<sha2::Sha384>::new()
            } else {
                Oaep::<sha2::Sha384>::new_with_label(label.clone())
            };
            private_key.decrypt(padding, &data)
        }
        "SHA-512" => {
            let padding = if label.is_empty() {
                Oaep::<sha2::Sha512>::new()
            } else {
                Oaep::<sha2::Sha512>::new_with_label(label.clone())
            };
            private_key.decrypt(padding, &data)
        }
        _ => {
            let msg = v8::String::new(scope, &format!("RSA-OAEP: unsupported hash \"{hash_name}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let plaintext = match plaintext {
        Ok(p) => p,
        Err(_) => {
            let msg = v8::String::new(scope, "RSA-OAEP decryption failed").unwrap();
            scope.throw_exception(v8::Exception::error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, plaintext).into());
}

// --- EC ops -----------------------------------------------------------------

fn op_crypto_generate_ec_keypair(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand_core::UnwrapErr;
    use getrandom::SysRng;
    use elliptic_curve::Generate;

    let named_curve = args.get(0).to_rust_string_lossy(scope);

    let (private_bytes, public_bytes): (Vec<u8>, Vec<u8>) = match named_curve.as_str() {
        "P-256" => {
            let secret = p256::SecretKey::generate_from_rng(&mut UnwrapErr(SysRng::default()));
            let public = secret.public_key();
            (secret.to_bytes().to_vec(), public.to_sec1_bytes().to_vec())
        }
        "P-384" => {
            let secret = p384::SecretKey::generate_from_rng(&mut UnwrapErr(SysRng::default()));
            let public = secret.public_key();
            (secret.to_bytes().to_vec(), public.to_sec1_bytes().to_vec())
        }
        "P-521" => {
            let secret = p521::SecretKey::generate_from_rng(&mut UnwrapErr(SysRng::default()));
            let public = secret.public_key();
            (secret.to_bytes().to_vec(), public.to_sec1_bytes().to_vec())
        }
        _ => {
            let msg = v8::String::new(scope, &format!("EC: unsupported curve \"{named_curve}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let result = v8::Object::new(scope);
    let pk_key = v8::String::new(scope, "privateKey").unwrap();
    let pk_val = vec_to_uint8_array(scope, private_bytes);
    result.set(scope, pk_key.into(), pk_val.into());
    let pub_key = v8::String::new(scope, "publicKey").unwrap();
    let pub_val = vec_to_uint8_array(scope, public_bytes);
    result.set(scope, pub_key.into(), pub_val.into());
    rv.set(result.into());
}

fn op_crypto_import_ec_raw(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let public_bytes = match named_curve.as_str() {
        "P-256" => {
            let pk = p256::PublicKey::from_sec1_bytes(&key_data).map_err(|_| ());
            pk.map(|k| k.to_sec1_bytes().to_vec())
        }
        "P-384" => {
            let pk = p384::PublicKey::from_sec1_bytes(&key_data).map_err(|_| ());
            pk.map(|k| k.to_sec1_bytes().to_vec())
        }
        "P-521" => {
            let pk = p521::PublicKey::from_sec1_bytes(&key_data).map_err(|_| ());
            pk.map(|k| k.to_sec1_bytes().to_vec())
        }
        _ => Err(()),
    };

    match public_bytes {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC import: invalid raw key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    }
}

fn op_crypto_import_ec_pkcs8(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let private_bytes = match named_curve.as_str() {
        "P-256" => {
            let sk = p256::SecretKey::from_pkcs8_der(&key_data).map_err(|_| ());
            sk.map(|k| k.to_bytes().to_vec())
        }
        "P-384" => {
            let sk = p384::SecretKey::from_pkcs8_der(&key_data).map_err(|_| ());
            sk.map(|k| k.to_bytes().to_vec())
        }
        "P-521" => {
            let sk = p521::SecretKey::from_pkcs8_der(&key_data).map_err(|_| ());
            sk.map(|k| k.to_bytes().to_vec())
        }
        _ => Err(()),
    };

    match private_bytes {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC import: invalid PKCS8 data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_import_ec_spki(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let public_bytes = match named_curve.as_str() {
        "P-256" => {
            let pk = p256::PublicKey::from_public_key_der(&key_data).map_err(|_| ());
            pk.map(|k| k.to_sec1_bytes().to_vec())
        }
        "P-384" => {
            let pk = p384::PublicKey::from_public_key_der(&key_data).map_err(|_| ());
            pk.map(|k| k.to_sec1_bytes().to_vec())
        }
        "P-521" => {
            let pk = p521::PublicKey::from_public_key_der(&key_data).map_err(|_| ());
            pk.map(|k| k.to_sec1_bytes().to_vec())
        }
        _ => Err(()),
    };

    match public_bytes {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC import: invalid SPKI data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_export_ec_raw(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let _named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();
    rv.set(vec_to_uint8_array(scope, key_data).into());
}

fn op_crypto_export_ec_pkcs8(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let pkcs8_der = match named_curve.as_str() {
        "P-256" => {
            let sk = p256::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.and_then(|k| k.to_pkcs8_der().map(|d| d.as_bytes().to_vec()).map_err(|_| ()))
        }
        "P-384" => {
            let sk = p384::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.and_then(|k| k.to_pkcs8_der().map(|d| d.as_bytes().to_vec()).map_err(|_| ()))
        }
        "P-521" => {
            let sk = p521::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.and_then(|k| k.to_pkcs8_der().map(|d| d.as_bytes().to_vec()).map_err(|_| ()))
        }
        _ => Err(()),
    };

    match pkcs8_der {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC export: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_export_ec_spki(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let spki_der = match named_curve.as_str() {
        "P-256" => {
            let pk = p256::PublicKey::from_sec1_bytes(&key_data).map_err(|_| ());
            pk.and_then(|k| k.to_public_key_der().map(|d| d.as_bytes().to_vec()).map_err(|_| ()))
        }
        "P-384" => {
            let pk = p384::PublicKey::from_sec1_bytes(&key_data).map_err(|_| ());
            pk.and_then(|k| k.to_public_key_der().map(|d| d.as_bytes().to_vec()).map_err(|_| ()))
        }
        "P-521" => {
            let pk = p521::PublicKey::from_sec1_bytes(&key_data).map_err(|_| ());
            pk.and_then(|k| k.to_public_key_der().map(|d| d.as_bytes().to_vec()).map_err(|_| ()))
        }
        _ => Err(()),
    };

    match spki_der {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC export: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_ec_public_from_private(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let public_bytes = match named_curve.as_str() {
        "P-256" => {
            let sk = p256::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.map(|k| k.public_key().to_sec1_bytes().to_vec())
        }
        "P-384" => {
            let sk = p384::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.map(|k| k.public_key().to_sec1_bytes().to_vec())
        }
        "P-521" => {
            let sk = p521::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.map(|k| k.public_key().to_sec1_bytes().to_vec())
        }
        _ => Err(()),
    };

    match public_bytes {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC public from private: invalid key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_import_ec_jwk_private(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();

    let private_bytes = match named_curve.as_str() {
        "P-256" => {
            let sk = p256::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.map(|k| k.to_bytes().to_vec())
        }
        "P-384" => {
            let sk = p384::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.map(|k| k.to_bytes().to_vec())
        }
        "P-521" => {
            let sk = p521::SecretKey::from_slice(key_data.as_slice()).map_err(|_| ());
            sk.map(|k| k.to_bytes().to_vec())
        }
        _ => Err(()),
    };

    match private_bytes {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "EC JWK import: invalid private key data").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_sign_ecdsa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand_core::UnwrapErr;
    use getrandom::SysRng;
    use sha1::Digest as _;
    use signature::hazmat::RandomizedPrehashSigner;

    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let hash_name = args.get(1).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(2)).unwrap_or_default();
    let data = read_bytes(args.get(3)).unwrap_or_default();

    let prehash: Vec<u8> = match hash_name.as_str() {
        "SHA-1" => sha1::Sha1::digest(&data).to_vec(),
        "SHA-256" => sha2::Sha256::digest(&data).to_vec(),
        "SHA-384" => sha2::Sha384::digest(&data).to_vec(),
        "SHA-512" => sha2::Sha512::digest(&data).to_vec(),
        _ => {
            let msg = v8::String::new(scope, &format!("ECDSA sign: unsupported hash \"{hash_name}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let signature: Vec<u8> = match named_curve.as_str() {
        "P-256" => {
            let secret = match p256::SecretKey::from_slice(key_data.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDSA sign: invalid private key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let signing_key = p256::ecdsa::SigningKey::from(&secret);
            let mut rng = UnwrapErr(SysRng::default());
            let sig: p256::ecdsa::Signature = signing_key.sign_prehash_with_rng(&mut rng, &prehash).unwrap();
            sig.to_bytes().to_vec()
        }
        "P-384" => {
            let secret = match p384::SecretKey::from_slice(key_data.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDSA sign: invalid private key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let signing_key = p384::ecdsa::SigningKey::from(&secret);
            let mut rng = UnwrapErr(SysRng::default());
            let sig: p384::ecdsa::Signature = signing_key.sign_prehash_with_rng(&mut rng, &prehash).unwrap();
            sig.to_bytes().to_vec()
        }
        "P-521" => {
            let secret = match p521::SecretKey::from_slice(key_data.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDSA sign: invalid private key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let signing_key = p521::ecdsa::SigningKey::from(&secret);
            let mut rng = UnwrapErr(SysRng::default());
            let prehash_p521 = if prehash.len() < 33 {
                let mut padded = vec![0u8; 33 - prehash.len()];
                padded.extend_from_slice(&prehash);
                padded
            } else {
                prehash
            };
            let sig: p521::ecdsa::Signature = signing_key.sign_prehash_with_rng(&mut rng, &prehash_p521).unwrap();
            sig.to_bytes().to_vec()
        }
        _ => {
            let msg = v8::String::new(scope, &format!("ECDSA sign: unsupported curve \"{named_curve}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    rv.set(vec_to_uint8_array(scope, signature).into());
}

fn op_crypto_verify_ecdsa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use sha1::Digest as _;
    use signature::hazmat::PrehashVerifier;

    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let hash_name = args.get(1).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(2)).unwrap_or_default();
    let signature = read_bytes(args.get(3)).unwrap_or_default();
    let data = read_bytes(args.get(4)).unwrap_or_default();

    let prehash: Vec<u8> = match hash_name.as_str() {
        "SHA-1" => sha1::Sha1::digest(&data).to_vec(),
        "SHA-256" => sha2::Sha256::digest(&data).to_vec(),
        "SHA-384" => sha2::Sha384::digest(&data).to_vec(),
        "SHA-512" => sha2::Sha512::digest(&data).to_vec(),
        _ => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let verified = match named_curve.as_str() {
        "P-256" => {
            let public = match p256::PublicKey::from_sec1_bytes(&key_data) {
                Ok(pk) => pk,
                Err(_) => {
                    rv.set(v8::Boolean::new(scope, false).into());
                    return;
                }
            };
            let verifying_key = p256::ecdsa::VerifyingKey::from(&public);
            match p256::ecdsa::Signature::from_slice(&signature) {
                Ok(s) => verifying_key.verify_prehash(&prehash, &s).is_ok(),
                Err(_) => false,
            }
        }
        "P-384" => {
            let public = match p384::PublicKey::from_sec1_bytes(&key_data) {
                Ok(pk) => pk,
                Err(_) => {
                    rv.set(v8::Boolean::new(scope, false).into());
                    return;
                }
            };
            let verifying_key = p384::ecdsa::VerifyingKey::from(&public);
            match p384::ecdsa::Signature::from_slice(&signature) {
                Ok(s) => verifying_key.verify_prehash(&prehash, &s).is_ok(),
                Err(_) => false,
            }
        }
        "P-521" => {
            let public = match p521::PublicKey::from_sec1_bytes(&key_data) {
                Ok(pk) => pk,
                Err(_) => {
                    rv.set(v8::Boolean::new(scope, false).into());
                    return;
                }
            };
            let verifying_key = p521::ecdsa::VerifyingKey::from(&public);
            let prehash_p521 = if prehash.len() < 33 {
                let mut padded = vec![0u8; 33 - prehash.len()];
                padded.extend_from_slice(&prehash);
                padded
            } else {
                prehash
            };
            match p521::ecdsa::Signature::from_slice(&signature) {
                Ok(s) => verifying_key.verify_prehash(&prehash_p521, &s).is_ok(),
                Err(_) => false,
            }
        }
        _ => false,
    };

    rv.set(v8::Boolean::new(scope, verified).into());
}

fn op_crypto_derive_bits_ecdh(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use elliptic_curve::ecdh::diffie_hellman;

    let named_curve = args.get(0).to_rust_string_lossy(scope);
    let private_key_data = read_bytes(args.get(1)).unwrap_or_default();
    let public_key_data = read_bytes(args.get(2)).unwrap_or_default();
    let length = args.get(3).uint32_value(scope).unwrap_or(0) as usize;

    let shared_secret: Vec<u8> = match named_curve.as_str() {
        "P-256" => {
            let secret = match p256::SecretKey::from_slice(private_key_data.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDH: invalid private key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let public = match p256::PublicKey::from_sec1_bytes(&public_key_data) {
                Ok(p) => p,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDH: invalid public key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let shared = diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
            shared.raw_secret_bytes().to_vec()
        }
        "P-384" => {
            let secret = match p384::SecretKey::from_slice(private_key_data.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDH: invalid private key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let public = match p384::PublicKey::from_sec1_bytes(&public_key_data) {
                Ok(p) => p,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDH: invalid public key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let shared = diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
            shared.raw_secret_bytes().to_vec()
        }
        "P-521" => {
            let secret = match p521::SecretKey::from_slice(private_key_data.as_slice()) {
                Ok(s) => s,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDH: invalid private key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let public = match p521::PublicKey::from_sec1_bytes(&public_key_data) {
                Ok(p) => p,
                Err(_) => {
                    let msg = v8::String::new(scope, "ECDH: invalid public key").unwrap();
                    scope.throw_exception(v8::Exception::type_error(scope, msg));
                    return;
                }
            };
            let shared = diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
            shared.raw_secret_bytes().to_vec()
        }
        _ => {
            let msg = v8::String::new(scope, &format!("ECDH: unsupported curve \"{named_curve}\"")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    if length > 0 && length < shared_secret.len() * 8 {
        let byte_len = (length + 7) / 8;
        rv.set(vec_to_uint8_array(scope, shared_secret[..byte_len].to_vec()).into());
    } else {
        rv.set(vec_to_uint8_array(scope, shared_secret).into());
    }
}

// --- Ed25519 / X25519 ops ---------------------------------------------------

fn op_crypto_generate_ed25519_keypair(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    let _ = args;
    let mut rng = OsRng;
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key = signing_key.verifying_key();

    let result = v8::Object::new(scope);
    let pk_key = v8::String::new(scope, "privateKey").unwrap();
    let pk_val = vec_to_uint8_array(scope, signing_key.to_bytes().to_vec());
    result.set(scope, pk_key.into(), pk_val.into());
    let pub_key = v8::String::new(scope, "publicKey").unwrap();
    let pub_val = vec_to_uint8_array(scope, verifying_key.to_bytes().to_vec());
    result.set(scope, pub_key.into(), pub_val.into());
    rv.set(result.into());
}

fn op_crypto_import_spki_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {

    let spki = read_bytes(args.get(0)).unwrap_or_default();
    let out: v8::Local<v8::Uint8Array> = match args.get(1).try_into() {
        Ok(arr) => arr,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let spki_obj = match spki::SubjectPublicKeyInfoRef::try_from(spki.as_slice()) {
        Ok(s) => s,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let public_key = match spki_obj.subject_public_key.as_bytes() {
        Some(b) => b,
        None => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };
    if public_key.len() != 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let out_len = out.byte_length();
    if out_len < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let data = out.data();
    if !data.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(public_key.as_ptr(), data as *mut u8, 32);
        }
    }
    rv.set(v8::Boolean::new(scope, true).into());
}

fn op_crypto_import_pkcs8_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {

    let pkcs8 = read_bytes(args.get(0)).unwrap_or_default();
    let out: v8::Local<v8::Uint8Array> = match args.get(1).try_into() {
        Ok(arr) => arr,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let pki = match pkcs8::PrivateKeyInfoRef::try_from(pkcs8.as_slice()) {
        Ok(p) => p,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let private_key_octets = pki.private_key.as_bytes();
    if private_key_octets.len() < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let private_bytes = &private_key_octets[private_key_octets.len() - 32..];
    if private_bytes.len() != 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let out_len = out.byte_length();
    if out_len < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let data = out.data();
    if !data.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(private_bytes.as_ptr(), data as *mut u8, 32);
        }
    }
    rv.set(v8::Boolean::new(scope, true).into());
}

fn op_crypto_export_spki_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use pkcs8::der::Encode as _;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    if key_data.len() != 32 {
        let msg = v8::String::new(scope, "Ed25519 SPKI export: invalid key length").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let alg_id = spki::AlgorithmIdentifier::<spki::der::Any> {
        oid: spki::ObjectIdentifier::new_unwrap("1.3.101.112"),
        parameters: None,
    };

    let bit_string = match spki::der::asn1::BitString::from_bytes(&key_data) {
        Ok(b) => b,
        Err(_) => {
            let msg = v8::String::new(scope, "Ed25519 SPKI export: bit string failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let spki_obj = spki::SubjectPublicKeyInfo::<spki::der::Any, spki::der::asn1::BitString> {
        algorithm: alg_id,
        subject_public_key: bit_string,
    };

    match spki_obj.to_der() {
        Ok(der) => rv.set(vec_to_uint8_array(scope, der).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "Ed25519 SPKI export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_export_pkcs8_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use pkcs8::der::Encode as _;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    if key_data.len() != 32 {
        let msg = v8::String::new(scope, "Ed25519 PKCS8 export: invalid key length").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let alg_id = spki::AlgorithmIdentifier::<spki::der::Any> {
        oid: spki::ObjectIdentifier::new_unwrap("1.3.101.112"),
        parameters: None,
    };

    let private_key_octet = match pkcs8::der::asn1::OctetString::new(key_data) {
        Ok(o) => o,
        Err(_) => {
            let msg = v8::String::new(scope, "Ed25519 PKCS8 export: octet string failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let pk_info = pkcs8::PrivateKeyInfoOwned::new(alg_id, private_key_octet);

    match pk_info.to_der() {
        Ok(der) => rv.set(vec_to_uint8_array(scope, der).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "Ed25519 PKCS8 export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_jwk_x_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let signing_key = match key_data.as_slice().try_into() {
        Ok(bytes) => ed25519_dalek::SigningKey::from_bytes(bytes),
        Err(_) => {
            let msg = v8::String::new(scope, "Ed25519 JWK: invalid key length").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let verifying_key = signing_key.verifying_key();
    let public_bytes = verifying_key.to_bytes();
    rv.set(v8::String::new(scope, &base64url_encode(&public_bytes)).unwrap().into());
}

fn op_crypto_sign_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use ed25519_dalek::Signer;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let data = read_bytes(args.get(1)).unwrap_or_default();
    let out: v8::Local<v8::Uint8Array> = match args.get(2).try_into() {
        Ok(arr) => arr,
        Err(_) => {
            let msg = v8::String::new(scope, "Ed25519 sign: invalid output buffer").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let signing_key = match key_data.as_slice().try_into() {
        Ok(bytes) => ed25519_dalek::SigningKey::from_bytes(bytes),
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };
    let signature = signing_key.sign(&data);

    let out_len = out.byte_length();
    if out_len < 64 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let data_ptr = out.data();
    if !data_ptr.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(signature.to_bytes().as_ptr(), data_ptr as *mut u8, 64);
        }
    }
    rv.set(v8::Boolean::new(scope, true).into());
}

fn op_crypto_verify_ed25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use ed25519_dalek::Verifier;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let data = read_bytes(args.get(1)).unwrap_or_default();
    let signature = read_bytes(args.get(2)).unwrap_or_default();

    let public_key = match key_data.as_slice().try_into() {
        Ok(bytes) => match ed25519_dalek::VerifyingKey::from_bytes(bytes) {
            Ok(k) => k,
            Err(_) => {
                rv.set(v8::Boolean::new(scope, false).into());
                return;
            }
        },
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let sig = match ed25519_dalek::Signature::from_slice(&signature) {
        Ok(s) => s,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let verified = public_key.verify(&data, &sig).is_ok();
    rv.set(v8::Boolean::new(scope, verified).into());
}

// --- X25519 ops -------------------------------------------------------------

fn op_crypto_generate_x25519_keypair(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use rand::rngs::OsRng;
    use rand::RngCore;

    let _ = args;
    let mut private_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut private_bytes);
    let public_bytes = x25519_dalek::x25519(private_bytes, x25519_dalek::X25519_BASEPOINT_BYTES);

    let result = v8::Object::new(scope);
    let pk_key = v8::String::new(scope, "privateKey").unwrap();
    let pk_val = vec_to_uint8_array(scope, private_bytes.to_vec());
    result.set(scope, pk_key.into(), pk_val.into());
    let pub_key = v8::String::new(scope, "publicKey").unwrap();
    let pub_val = vec_to_uint8_array(scope, public_bytes.to_vec());
    result.set(scope, pub_key.into(), pub_val.into());
    rv.set(result.into());
}

fn op_crypto_import_spki_x25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {

    let spki = read_bytes(args.get(0)).unwrap_or_default();
    let out: v8::Local<v8::Uint8Array> = match args.get(1).try_into() {
        Ok(arr) => arr,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let spki_obj = match spki::SubjectPublicKeyInfoRef::try_from(spki.as_slice()) {
        Ok(s) => s,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let public_key = match spki_obj.subject_public_key.as_bytes() {
        Some(b) => b,
        None => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };
    if public_key.len() != 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let out_len = out.byte_length();
    if out_len < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let data = out.data();
    if !data.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(public_key.as_ptr(), data as *mut u8, 32);
        }
    }
    rv.set(v8::Boolean::new(scope, true).into());
}

fn op_crypto_import_pkcs8_x25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {

    let pkcs8 = read_bytes(args.get(0)).unwrap_or_default();
    let out: v8::Local<v8::Uint8Array> = match args.get(1).try_into() {
        Ok(arr) => arr,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let pki = match pkcs8::PrivateKeyInfoRef::try_from(pkcs8.as_slice()) {
        Ok(p) => p,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let private_key_octets = pki.private_key.as_bytes();
    if private_key_octets.len() < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let private_bytes = &private_key_octets[private_key_octets.len() - 32..];
    if private_bytes.len() != 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let out_len = out.byte_length();
    if out_len < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let data = out.data();
    if !data.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(private_bytes.as_ptr(), data as *mut u8, 32);
        }
    }
    rv.set(v8::Boolean::new(scope, true).into());
}

fn op_crypto_export_spki_x25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use pkcs8::der::Encode as _;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();

    let alg_id = spki::AlgorithmIdentifier::<spki::der::Any> {
        oid: spki::ObjectIdentifier::new_unwrap("1.3.101.110"),
        parameters: None,
    };

    let bit_string = match spki::der::asn1::BitString::from_bytes(&key_data) {
        Ok(b) => b,
        Err(_) => {
            let msg = v8::String::new(scope, "X25519 SPKI export: bit string failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let spki_obj = spki::SubjectPublicKeyInfo::<spki::der::Any, spki::der::asn1::BitString> {
        algorithm: alg_id,
        subject_public_key: bit_string,
    };

    match spki_obj.to_der() {
        Ok(der) => rv.set(vec_to_uint8_array(scope, der).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "X25519 SPKI export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_export_pkcs8_x25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use pkcs8::der::Encode as _;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();

    let alg_id = spki::AlgorithmIdentifier::<spki::der::Any> {
        oid: spki::ObjectIdentifier::new_unwrap("1.3.101.110"),
        parameters: None,
    };

    let private_key_octet = match pkcs8::der::asn1::OctetString::new(key_data) {
        Ok(o) => o,
        Err(_) => {
            let msg = v8::String::new(scope, "X25519 PKCS8 export: octet string failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let pk_info = pkcs8::PrivateKeyInfoOwned::new(alg_id, private_key_octet);

    match pk_info.to_der() {
        Ok(der) => rv.set(vec_to_uint8_array(scope, der).into()),
        Err(_) => {
            let msg = v8::String::new(scope, "X25519 PKCS8 export failed").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_x25519_public_key(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let private_bytes: [u8; 32] = match key_data.as_slice().try_into() {
        Ok(b) => b,
        Err(_) => {
            let msg = v8::String::new(scope, "X25519: invalid key length").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };
    let public_bytes = x25519_dalek::x25519(private_bytes, x25519_dalek::X25519_BASEPOINT_BYTES);
    rv.set(vec_to_uint8_array(scope, public_bytes.to_vec()).into());
}

fn op_crypto_derive_bits_x25519(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let private_key_data = read_bytes(args.get(0)).unwrap_or_default();
    let public_key_data = read_bytes(args.get(1)).unwrap_or_default();
    let out: v8::Local<v8::Uint8Array> = match args.get(2).try_into() {
        Ok(arr) => arr,
        Err(_) => {
            let msg = v8::String::new(scope, "X25519 deriveBits: invalid output buffer").unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
            return;
        }
    };

    let private_bytes: [u8; 32] = match private_key_data.as_slice().try_into() {
        Ok(b) => b,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };
    let public_bytes: [u8; 32] = match public_key_data.as_slice().try_into() {
        Ok(b) => b,
        Err(_) => {
            rv.set(v8::Boolean::new(scope, false).into());
            return;
        }
    };

    let shared_bytes = x25519_dalek::x25519(private_bytes, public_bytes);

    let out_len = out.byte_length();
    if out_len < 32 {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let data = out.data();
    if !data.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(shared_bytes.as_ptr(), data as *mut u8, 32);
        }
    }
    rv.set(v8::Boolean::new(scope, true).into());
}

// --- HKDF / PBKDF2 ops ------------------------------------------------------

fn op_crypto_derive_bits_hkdf(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use hkdf::Hkdf;

    let hash_name = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();
    let salt = read_bytes(args.get(2)).unwrap_or_default();
    let info = read_bytes(args.get(3)).unwrap_or_default();
    let length = args.get(4).uint32_value(scope).unwrap_or(0) as usize;

    if length == 0 {
        rv.set(vec_to_uint8_array(scope, Vec::new()).into());
        return;
    }

    let okm: Result<Vec<u8>, String> = match hash_name.as_str() {
        "SHA-1" => {
            let h = Hkdf::<sha1::Sha1>::new(Some(&salt), &key_data);
            let mut out = vec![0u8; length];
            h.expand(&info, &mut out).map_err(|e| e.to_string()).map(|_| out)
        }
        "SHA-256" => {
            let h = Hkdf::<sha2::Sha256>::new(Some(&salt), &key_data);
            let mut out = vec![0u8; length];
            h.expand(&info, &mut out).map_err(|e| e.to_string()).map(|_| out)
        }
        "SHA-384" => {
            let h = Hkdf::<sha2::Sha384>::new(Some(&salt), &key_data);
            let mut out = vec![0u8; length];
            h.expand(&info, &mut out).map_err(|e| e.to_string()).map(|_| out)
        }
        "SHA-512" => {
            let h = Hkdf::<sha2::Sha512>::new(Some(&salt), &key_data);
            let mut out = vec![0u8; length];
            h.expand(&info, &mut out).map_err(|e| e.to_string()).map(|_| out)
        }
        _ => Err(format!("HKDF: unsupported hash \"{hash_name}\"")),
    };

    match okm {
        Ok(bytes) => rv.set(vec_to_uint8_array(scope, bytes).into()),
        Err(e) => {
            let msg = v8::String::new(scope, &format!("HKDF: {e}")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

fn op_crypto_derive_bits_pbkdf2(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use pbkdf2::pbkdf2_hmac;

    let hash_name = args.get(0).to_rust_string_lossy(scope);
    let key_data = read_bytes(args.get(1)).unwrap_or_default();
    let salt = read_bytes(args.get(2)).unwrap_or_default();
    let iterations = args.get(3).uint32_value(scope).unwrap_or(0) as u32;
    let length = args.get(4).uint32_value(scope).unwrap_or(0) as usize;

    if length == 0 {
        rv.set(vec_to_uint8_array(scope, Vec::new()).into());
        return;
    }

    let mut out = vec![0u8; length];

    let result: Result<(), String> = match hash_name.as_str() {
        "SHA-1" => {
            pbkdf2_hmac::<sha1::Sha1>(&key_data, &salt, iterations, &mut out);
            Ok(())
        }
        "SHA-256" => {
            pbkdf2_hmac::<sha2::Sha256>(&key_data, &salt, iterations, &mut out);
            Ok(())
        }
        "SHA-384" => {
            pbkdf2_hmac::<sha2::Sha384>(&key_data, &salt, iterations, &mut out);
            Ok(())
        }
        "SHA-512" => {
            pbkdf2_hmac::<sha2::Sha512>(&key_data, &salt, iterations, &mut out);
            Ok(())
        }
        _ => Err(format!("PBKDF2: unsupported hash \"{hash_name}\"")),
    };

    match result {
        Ok(()) => rv.set(vec_to_uint8_array(scope, out).into()),
        Err(e) => {
            let msg = v8::String::new(scope, &format!("{e}")).unwrap();
            scope.throw_exception(v8::Exception::type_error(scope, msg));
        }
    }
}

// --- AES-KW wrap/unwrap -----------------------------------------------------

fn op_crypto_wrap_key_aes_kw(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{BlockEncrypt, KeyInit};
    use aes::Aes128;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let data = read_bytes(args.get(1)).unwrap_or_default();

    if data.len() % 8 != 0 || data.len() < 16 {
        let msg = v8::String::new(scope, "AES-KW: data must be multiple of 8 bytes and at least 16 bytes").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    if key_data.len() != 16 {
        let msg = v8::String::new(scope, "AES-KW: only 128-bit keys supported").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let cipher = Aes128::new(key_data.as_slice().into());
    let a_iv = [0xA6u8, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6];
    let n = data.len() / 8;
    let mut a = a_iv.to_vec();
    a.extend_from_slice(&data);
    let mut r = a[a.len() - 8 * n..].to_vec();
    let mut a_block = [0u8; 16];

    for j in 0..6 {
        for i in 0..n {
            a_block[..8].copy_from_slice(&a[..8]);
            a_block[8..].copy_from_slice(&r[i * 8..(i + 1) * 8]);
            let block = aes::Block::from_mut_slice(&mut a_block);
            cipher.encrypt_block(block);
            let t = ((n * j) + i + 1) as u64;
            for k in 0..8 {
                a_block[k] ^= (t >> (56 - 8 * k)) as u8;
            }
            a[..8].copy_from_slice(&a_block[..8]);
            r[i * 8..(i + 1) * 8].copy_from_slice(&a_block[8..]);
        }
    }

    let mut output = Vec::with_capacity(8 * (n + 1));
    output.extend_from_slice(&a[..8]);
    output.extend_from_slice(&r);

    rv.set(vec_to_uint8_array(scope, output).into());
}

fn op_crypto_unwrap_key_aes_kw(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use aes::cipher::{BlockDecrypt, KeyInit};
    use aes::Aes128;

    let key_data = read_bytes(args.get(0)).unwrap_or_default();
    let data = read_bytes(args.get(1)).unwrap_or_default();

    if data.len() % 8 != 0 || data.len() < 24 {
        let msg = v8::String::new(scope, "AES-KW: data must be multiple of 8 bytes and at least 24 bytes").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    if key_data.len() != 16 {
        let msg = v8::String::new(scope, "AES-KW: only 128-bit keys supported").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    let cipher = Aes128::new(key_data.as_slice().into());
    let n = data.len() / 8 - 1;
    let mut a = data[..8].to_vec();
    let mut r = data[8..].to_vec();
    let mut a_block = [0u8; 16];

    for j in (0..6).rev() {
        for i in (0..n).rev() {
            let t = ((n * j) + i + 1) as u64;
            for k in 0..8 {
                a_block[k] = a[k] ^ (t >> (56 - 8 * k)) as u8;
            }
            a_block[8..].copy_from_slice(&r[i * 8..(i + 1) * 8]);
            let block = aes::Block::from_mut_slice(&mut a_block);
            cipher.decrypt_block(block);
            a[..8].copy_from_slice(&a_block[..8]);
            r[i * 8..(i + 1) * 8].copy_from_slice(&a_block[8..]);
        }
    }

    if &a[..8] != &[0xA6u8, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6] {
        let msg = v8::String::new(scope, "AES-KW: integrity check failed").unwrap();
        scope.throw_exception(v8::Exception::type_error(scope, msg));
        return;
    }

    rv.set(vec_to_uint8_array(scope, r).into());
}

// --- base64url helper -------------------------------------------------------

fn base64url_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}