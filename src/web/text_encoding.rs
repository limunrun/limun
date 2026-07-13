//! WHATWG Encoding Standard (https://encoding.spec.whatwg.org/) —
//! `TextEncoder`/`TextDecoder`. Both are real constructible classes
//! (interface objects), so — unlike `console`/`Limun` (namespace objects)
//! or `setTimeout`/`alert` (plain operations) — they're installed
//! non-enumerable, matching how `Array`/`URL`/etc. behave in real engines
//! (verified empirically: `Object.getOwnPropertyDescriptor(globalThis,
//! "TextEncoder").enumerable === false` in Node).
//!
//! `TextDecoder` supports the full WHATWG legacy label table via the
//! `encoding_rs` crate (the same crate Firefox/Servo use). `TextEncoder`
//! only ever produces UTF-8 per spec, so it stays a hand-rolled UTF-8
//! encoder — no `encoding_rs` code path on the encode side.

use crate::web::native;
use std::cell::RefCell;

struct DecoderState {
    encoding: &'static encoding_rs::Encoding,
    fatal: bool,
    ignore_bom: bool,
    /// Active streaming decoder, retained across `decode(_, {stream:true})`
    /// calls and dropped when a non-streaming `decode()` finalizes the run
    /// (per the Encoding Standard's "serialize stream" / I/O queue model).
    /// `None` between runs.
    decoder: RefCell<Option<encoding_rs::Decoder>>,
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    install_encoder(scope, global);
    install_decoder(scope, global);
}

// --- TextEncoder ---------------------------------------------------------

fn install_encoder(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, encoder_constructor);
    let name = v8::String::new(scope, "TextEncoder").unwrap();
    tmpl.set_class_name(name);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "encode", encoder_encode);
    set_method(scope, proto, "encodeInto", encoder_encode_into);
    set_readonly_accessor(scope, proto, "encoding", encoder_encoding_getter);

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "TextEncoder", ctor.into());
}

fn encoder_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !require_new(scope, &args, "TextEncoder") {
        return;
    }
    rv.set(args.this().into());
}

fn encoder_encoding_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    _args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let s = v8::String::new(scope, "utf-8").unwrap();
    rv.set(s.into());
}

fn encoder_encode(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let input = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    rv.set(bytes_to_uint8array(scope, input.into_bytes()).into());
}

/// `encodeInto(source: string, destination: Uint8Array): { read, written }`
/// — encodes as much of `source` as fits into `destination` without
/// splitting a UTF-8 scalar value's bytes across the boundary.
fn encoder_encode_into(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let input = args.get(0).to_rust_string_lossy(scope);
    let Ok(view): Result<v8::Local<v8::ArrayBufferView>, _> = args.get(1).try_into() else {
        crate::web::throw_type_error(scope, "encodeInto: destination must be a Uint8Array");
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
    let read = input[..written].encode_utf16().count();

    let result = v8::Object::new(scope);
    set_num(scope, result, "read", read as f64);
    set_num(scope, result, "written", written as f64);
    rv.set(result.into());
}

// --- TextDecoder ----------------------------------------------------------

fn install_decoder(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, decoder_constructor);
    let name = v8::String::new(scope, "TextDecoder").unwrap();
    tmpl.set_class_name(name);
    tmpl.instance_template(scope).set_internal_field_count(1);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "decode", decoder_decode);

    // `encoding`/`fatal`/`ignoreBOM` all read per-instance state, so (like
    // `URL`'s accessors) they must live on the instance template, not the
    // prototype — this binding's property-callback args only expose
    // `.holder()`, which for a prototype-level accessor would be the
    // shared prototype object, not the actual instance. (At HEAD the
    // `encoding` getter returned a hardcoded "utf-8" so it could live
    // on the prototype; now that it reads the stored `Encoding` it has to
    // move down here alongside `fatal`/`ignoreBOM`.)
    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "encoding", decoder_encoding_getter);
    set_readonly_accessor(scope, instance, "fatal", decoder_fatal_getter);
    set_readonly_accessor(scope, instance, "ignoreBOM", decoder_ignore_bom_getter);

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "TextDecoder", ctor.into());
}

/// `new TextDecoder(label = "utf-8", options?: { fatal, ignoreBOM })`
///
/// Resolves `label` through the WHATWG label table via `encoding_rs`.
/// `for_label_no_replacement` returns `None` both for unrecognized labels
/// and for the `replacement` encoding (and its aliases like `iso-2022-kr`),
/// both of which the spec rejects with a `RangeError` — so a single `None`
/// arm covers both cases. `encoding_rs::for_label` already does the spec
/// label normalization (ASCII-case-insensitive + ASCII-whitespace trim),
/// so we feed it the raw JS string bytes rather than pre-lowercasing.
fn decoder_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !require_new(scope, &args, "TextDecoder") {
        return;
    }

    let label = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        "utf-8".to_string()
    };
    let Some(encoding) = encoding_rs::Encoding::for_label_no_replacement(label.as_bytes()) else {
        crate::web::throw_range_error(
            scope,
            &format!("TextDecoder: unsupported encoding label \"{label}\""),
        );
        return;
    };

    let mut fatal = false;
    let mut ignore_bom = false;
    if args.length() > 1 {
        if let Ok(options) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            fatal = get_bool(scope, options, "fatal");
            ignore_bom = get_bool(scope, options, "ignoreBOM");
        }
    }

    let this = args.this();
    native::store(
        scope,
        this,
        0,
        DecoderState { encoding, fatal, ignore_bom, decoder: RefCell::new(None) },
    );
    rv.set(this.into());
}

/// `decode(input?: BufferSource): string`
///
/// BOM handling: when `ignoreBOM` is `false` (default), a leading BOM for
/// this encoding is removed but the encoding is NOT morphed (matches the
/// spec's "remove" mode, not "sniff"). `encoding_rs` exposes this exactly
/// as `decode_with_bom_removal` / `new_decoder_with_bom_removal`.
/// `ignoreBOM: true` uses the `_without_bom_handling` variants, which leave
/// a BOM as part of the decoded output (spec "off" mode).
///
/// Error handling: `fatal: false` (default) replaces malformed sequences
/// with U+FFFD (encoding_rs's default replacement mode). `fatal: true`
/// runs the streaming decoder without replacement; any
/// `DecoderResult::Malformed` → `TypeError` (matches the prior UTF-8-only
/// fatal behavior and the spec's "decode without BOM or fail" concept).
fn decoder_decode(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();

    // `options.stream` (default false). When true, the decoder is retained
    // for the next call; when false, this call finalizes the run and the
    // decoder is reset. A single non-streaming `decode(bytes)` is the common
    // case: create decoder, feed with `last = true`, drop it.
    let stream = if args.length() > 1 && !args.get(1).is_undefined() {
        <v8::Local<v8::Object>>::try_from(args.get(1))
            .ok()
            .map(|o| get_bool(scope, o, "stream"))
            .unwrap_or(false)
    } else {
        false
    };
    let last = !stream;

    let mut bytes = Vec::new();
    if args.length() > 0 && !args.get(0).is_undefined() {
        match native::read_buffer_source(args.get(0)) {
            Some(b) => bytes = b,
            None => {
                crate::web::throw_type_error(scope, "decode: input must be a BufferSource");
                return;
            }
        }
    }

    let state: &DecoderState = native::get(scope, this, 0);
    let encoding = state.encoding;
    let fatal = state.fatal;
    let ignore_bom = state.ignore_bom;

    // Take the run's decoder out of the slot (starting one if this is the
    // first call of a run). Taking rather than borrowing keeps the borrow
    // checker happy *and* gives the right semantics on the error paths:
    // a fatal error ends the run, so the decoder is simply never put back.
    // BOM handling is a property of the decoder instance (applied to the
    // first bytes it sees), so it's chosen once, here, per run.
    let mut decoder = state.decoder.borrow_mut().take().unwrap_or_else(|| {
        if ignore_bom {
            encoding.new_decoder_without_bom_handling()
        } else {
            encoding.new_decoder_with_bom_removal()
        }
    });

    // Decode this chunk. Output buffers are reserved to encoding_rs's
    // documented worst case, so one call drains the whole input (never
    // `OutputFull`). `last = !stream` tells the decoder whether to flush
    // any trailing partial sequence (as U+FFFD, or a fatal error).
    let text: String = if fatal {
        let cap = decoder
            .max_utf8_buffer_length_without_replacement(bytes.len())
            .unwrap_or(0);
        let mut out = String::with_capacity(cap);
        let (result, _read) = decoder.decode_to_string_without_replacement(&bytes, &mut out, last);
        match result {
            encoding_rs::DecoderResult::InputEmpty => out,
            // A malformed sequence ends the run: don't restore the decoder.
            encoding_rs::DecoderResult::Malformed(_, _) => {
                crate::web::throw_type_error(scope, "decode: invalid byte sequence (fatal: true)");
                return;
            }
            encoding_rs::DecoderResult::OutputFull => {
                crate::web::throw_type_error(scope, "decode: output buffer too small (fatal: true)");
                return;
            }
        }
    } else {
        let cap = decoder.max_utf8_buffer_length(bytes.len()).unwrap_or(0);
        let mut out = String::with_capacity(cap);
        let (_result, _read, _had_errors) = decoder.decode_to_string(&bytes, &mut out, last);
        out
    };

    // `{stream: true}` keeps the decoder (and its partial-sequence state)
    // alive for the next call; a final `decode()` ends the run.
    if !last {
        *state.decoder.borrow_mut() = Some(decoder);
    }

    let s = v8::String::new(scope, &text).unwrap();
    rv.set(s.into());
}

fn decoder_encoding_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &DecoderState = native::get(scope, args.holder(), 0);
    // encoding_rs returns its canonical names in its own casing ("UTF-8",
    // "Shift_JIS", "UTF-16LE", ...). The WHATWG Encoding Standard's
    // canonical names are lowercase ("utf-8", "shift_jis", "utf-16le"),
    // which is what `TextDecoder.encoding` must expose — lowercase to
    // bridge the two. This holds for every name in the spec's table
    // (all-ASCII, no uppercase letters in the canonical form).
    let name = state.encoding.name().to_ascii_lowercase();
    let s = v8::String::new(scope, &name).unwrap();
    rv.set(s.into());
}

fn decoder_fatal_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &DecoderState = native::get(scope, args.holder(), 0);
    rv.set(v8::Boolean::new(scope, state.fatal).into());
}

fn decoder_ignore_bom_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &DecoderState = native::get(scope, args.holder(), 0);
    rv.set(v8::Boolean::new(scope, state.ignore_bom).into());
}

// --- shared helpers ---------------------------------------------------------

fn bytes_to_uint8array<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::Uint8Array> {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Uint8Array::new(scope, ab, 0, len).unwrap()
}

fn require_new(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, class_name: &str) -> bool {
    if args.is_construct_call() {
        return true;
    }
    crate::web::throw_type_error(
        scope,
        &format!("Failed to construct '{class_name}': Please use the 'new' operator"),
    );
    false
}

fn set_method(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::FunctionTemplate::new(scope, callback);
    target.set(key.into(), func.into());
}

fn set_readonly_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor(key.into(), getter);
}

fn set_num(scope: &mut v8::PinScope, target: v8::Local<v8::Object>, name: &str, value: f64) {
    let key = v8::String::new(scope, name).unwrap();
    target.set(scope, key.into(), v8::Number::new(scope, value).into());
}

fn get_bool(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str) -> bool {
    let key = v8::String::new(scope, name).unwrap();
    obj.get(scope, key.into())
        .map(|v| v.boolean_value(scope))
        .unwrap_or(false)
}
