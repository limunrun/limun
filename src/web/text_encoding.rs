//! WHATWG Encoding Standard (https://encoding.spec.whatwg.org/) —
//! `TextEncoder`/`TextDecoder`. Both are real constructible classes
//! (interface objects), so — unlike `console`/`Limun` (namespace objects)
//! or `setTimeout`/`alert` (plain operations) — they're installed
//! non-enumerable, matching how `Array`/`URL`/etc. behave in real engines
//! (verified empirically: `Object.getOwnPropertyDescriptor(globalThis,
//! "TextEncoder").enumerable === false` in Node).
//!
//! Scope cut: only UTF-8 is supported. `TextEncoder` only ever produces
//! UTF-8 per spec anyway; `TextDecoder` rejects any other label with a
//! `RangeError` rather than implementing the full legacy label table
//! (windows-1252, shift_jis, ...) — same kind of deliberate cut as import
//! attributes only supporting `json`/`text`.

use crate::web::native;

struct DecoderState {
    fatal: bool,
    ignore_bom: bool,
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
    let input = if args.length() > 0 {
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
    set_readonly_accessor(scope, proto, "encoding", decoder_encoding_getter);

    // `fatal`/`ignoreBOM` read per-instance state, so (like `URL`'s
    // accessors) they must live on the instance template, not the
    // prototype — this binding's property-callback args only expose
    // `.holder()`, which for a prototype-level accessor would be the
    // shared prototype object, not the actual instance.
    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "fatal", decoder_fatal_getter);
    set_readonly_accessor(scope, instance, "ignoreBOM", decoder_ignore_bom_getter);

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "TextDecoder", ctor.into());
}

/// `new TextDecoder(label = "utf-8", options?: { fatal, ignoreBOM })`
fn decoder_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !require_new(scope, &args, "TextDecoder") {
        return;
    }

    let label = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope).to_lowercase()
    } else {
        "utf-8".to_string()
    };
    // Canonical labels for UTF-8 per the Encoding Standard's label table —
    // everything else is "not supported" (see module doc comment).
    if !matches!(label.as_str(), "utf-8" | "utf8" | "unicode-1-1-utf-8") {
        crate::web::throw_range_error(
            scope,
            &format!("TextDecoder: unsupported encoding label \"{label}\" (only utf-8 is supported)"),
        );
        return;
    }

    let mut fatal = false;
    let mut ignore_bom = false;
    if args.length() > 1 {
        if let Ok(options) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            fatal = get_bool(scope, options, "fatal");
            ignore_bom = get_bool(scope, options, "ignoreBOM");
        }
    }

    let this = args.this();
    native::store(scope, this, 0, DecoderState { fatal, ignore_bom });
    rv.set(this.into());
}

/// `decode(input?: BufferSource): string`
fn decoder_decode(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    let state: &DecoderState = native::get(scope, this, 0);
    let fatal = state.fatal;
    let ignore_bom = state.ignore_bom;

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

    if !ignore_bom && bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(0..3);
    }

    let text = if fatal {
        match std::str::from_utf8(&bytes) {
            Ok(s) => s.to_string(),
            Err(_) => {
                crate::web::throw_type_error(scope, "decode: invalid UTF-8 (fatal: true)");
                return;
            }
        }
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    let s = v8::String::new(scope, &text).unwrap();
    rv.set(s.into());
}

fn decoder_encoding_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    _args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let s = v8::String::new(scope, "utf-8").unwrap();
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
