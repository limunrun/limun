//! `Blob` — File API (https://w3c.github.io/FileAPI/#blob-section).
//!
//! Also implements `File` (https://w3c.github.io/FileAPI/#file-section),
//! which extends `Blob` with `name`/`lastModified`. `FormData` stores its
//! non-string entries as `File`s, per the XHR Standard.
//!
//! Simplifications vs. spec (documented):
//!   - `stream()` returns a fixed `ReadableStream` yielding the whole body in
//!     one chunk, then closes (no incremental pull-source model).
//!   - `text()`/`arrayBuffer()` resolve synchronously (body is buffered) —
//!     same simplification `Response.text()` already makes.
//!   - `File`'s `endings: "native"` blob option is ignored (no line-ending
//!     transcoding); `"transparent"` is the default and the only behavior.

use crate::web::native;
use crate::web::streams;
use std::cell::RefCell;
use std::time::{SystemTime, UNIX_EPOCH};

thread_local! {
    /// Cached `File` constructor so Rust callers (`FormData`) can mint
    /// `File`s without a `globalThis` lookup.
    static FILE_CTOR: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

/// `File`-specific state (internal field 1). Field 0 holds the inherited
/// `BlobState`, so every `Blob` method/accessor works unchanged on a `File`.
struct FileState {
    name: String,
    last_modified: f64,
}

pub struct BlobState {
    pub bytes: Vec<u8>,
    pub type_: String,
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "Blob").unwrap();
    tmpl.set_class_name(name);
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    // Per-instance accessors (same holder-vs-prototype reasoning as `URL`:
    // property-callback `.holder()` resolves to the shared prototype when
    // placed there, which has no internal field data).
    set_readonly_accessor(scope, instance, "size", get_size);
    set_readonly_accessor(scope, instance, "type", get_type);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "slice", slice);
    set_method(scope, proto, "text", text);
    set_method(scope, proto, "arrayBuffer", array_buffer);
    set_method(scope, proto, "stream", stream);

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "Blob", ctor.into());

    install_file(scope, global, tmpl);
}

/// `File : Blob` — the prototype chain is wired by `FunctionTemplate::inherit`
/// (so `slice`/`text`/`arrayBuffer`/`stream`, which live on `Blob.prototype`
/// and read `args.this()`, work unchanged). `size`/`type` must be *re-declared*
/// here: they're instance-template accessors on `Blob`, and `inherit` only
/// chains prototypes — an instance minted from `File`'s own instance template
/// would otherwise lack them. Both getters read internal field 0, which a
/// `File` also populates with a `BlobState`.
fn install_file(
    scope: &mut v8::PinScope,
    global: v8::Local<v8::Object>,
    blob_tmpl: v8::Local<v8::FunctionTemplate>,
) {
    let tmpl = v8::FunctionTemplate::new(scope, file_constructor);
    tmpl.set_class_name(v8::String::new(scope, "File").unwrap());
    tmpl.inherit(blob_tmpl);
    let instance = tmpl.instance_template(scope);
    // Field 0: BlobState (inherited shape). Field 1: FileState.
    instance.set_internal_field_count(2);

    set_readonly_accessor(scope, instance, "size", get_size);
    set_readonly_accessor(scope, instance, "type", get_type);
    set_readonly_accessor(scope, instance, "name", file_get_name);
    set_readonly_accessor(scope, instance, "lastModified", file_get_last_modified);

    let ctor = tmpl.get_function(scope).unwrap();
    FILE_CTOR.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, ctor)));
    crate::web::set_global(scope, global, "File", ctor.into());
}

/// `new File(fileBits, fileName, options?)` — `fileName` is required per spec
/// (a missing second argument is a `TypeError`).
fn file_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'File': Please use the 'new' operator");
        return;
    }
    if args.length() < 2 {
        crate::web::throw_type_error(
            scope,
            "Failed to construct 'File': 2 arguments required, but fewer present",
        );
        return;
    }

    let bytes = collect_parts(scope, args.get(0));
    let name = args.get(1).to_rust_string_lossy(scope);

    let mut type_ = String::new();
    let mut last_modified = now_ms();
    if args.length() > 2 && !args.get(2).is_undefined() {
        if let Ok(opts) = <v8::Local<v8::Object>>::try_from(args.get(2)) {
            let key = v8::String::new(scope, "type").unwrap();
            if let Some(v) = opts.get(scope, key.into()) {
                if !v.is_undefined() {
                    type_ = v.to_rust_string_lossy(scope).to_ascii_lowercase();
                }
            }
            let key = v8::String::new(scope, "lastModified").unwrap();
            if let Some(v) = opts.get(scope, key.into()) {
                if !v.is_undefined() {
                    last_modified = v.number_value(scope).unwrap_or(last_modified);
                }
            }
        }
    }

    let this = args.this();
    native::store(scope, this, 0, BlobState { bytes, type_ });
    native::store(scope, this, 1, FileState { name, last_modified });
    rv.set(this.into());
}

/// Build a `File` from Rust (used by `FormData`, whose non-string entries are
/// `File`s per the XHR Standard).
pub(crate) fn new_file_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: Vec<u8>,
    type_: String,
    name: String,
    last_modified: f64,
) -> v8::Local<'s, v8::Object> {
    let ctor = FILE_CTOR
        .with(|c| c.borrow().clone())
        .expect("File not installed yet");
    let ctor = v8::Local::new(scope, &ctor);
    // Construct with placeholder args (the constructor requires 2), then
    // overwrite both internal fields with the exact state we want — avoids
    // round-tripping bytes through a JS array of parts.
    let empty = v8::Array::new(scope, 0);
    let name_val = v8::String::new(scope, &name).unwrap();
    let instance = ctor.new_instance(scope, &[empty.into(), name_val.into()]).unwrap();
    native::store(scope, instance, 0, BlobState { bytes, type_ });
    native::store(scope, instance, 1, FileState { name, last_modified });
    instance
}

/// `true` iff `obj` is a `File` (has `FileState` in internal field 1).
#[allow(dead_code)]
pub(crate) fn is_file_instance(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    native::is::<FileState>(scope, obj, 1)
}

/// `(name, lastModified)` if `obj` is a `File`, else `None` (a plain `Blob`).
/// Used by `FormData` to preserve a `File`'s identity when it's appended.
pub(crate) fn file_meta(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> Option<(String, f64)> {
    let st: &FileState = native::get_opt(scope, obj, 1)?;
    Some((st.name.clone(), st.last_modified))
}

fn file_get_name(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &FileState = native::get(scope, args.holder(), 1);
    rv.set(v8::String::new(scope, &st.name).unwrap().into());
}

fn file_get_last_modified(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &FileState = native::get(scope, args.holder(), 1);
    rv.set(v8::Number::new(scope, st.last_modified).into());
}

/// Wall-clock ms since the Unix epoch — `File.lastModified`'s default
/// (spec: "the current date and time").
pub(crate) fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Concatenate a `BlobPart[]` (or a lone part) into one byte buffer.
fn collect_parts(scope: &mut v8::PinScope, arg: v8::Local<v8::Value>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if arg.is_undefined() || arg.is_null() {
        return bytes;
    }
    if let Ok(parts) = <v8::Local<v8::Array>>::try_from(arg) {
        for i in 0..parts.length() {
            if let Some(part) = parts.get_index(scope, i) {
                append_part(scope, &mut bytes, part);
            }
        }
    } else {
        append_part(scope, &mut bytes, arg);
    }
    bytes
}

/// Build a `Blob` instance from Rust with the given bytes and type. Used by
/// `Response.blob()` and `FormData.get()` where a Blob must be minted
/// without going through the JS constructor's option parsing.
pub fn new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: Vec<u8>,
    type_: String,
) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "Blob").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    let instance = ctor.new_instance(scope, &[]).unwrap();
    native::store(scope, instance, 0, BlobState { bytes, type_ });
    instance
}

/// `true` iff `obj` is a `Blob` instance (field 0 = External pointing at a
/// `BlobState`). Used by the constructor (to read another Blob's bytes when
/// it appears as a `BlobPart`) and by `FormData`.
pub(crate) fn is_blob_instance(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    native::is::<BlobState>(scope, obj, 0)
}

/// Read a `BlobState` reference out of a Blob instance.
pub(crate) fn state<'a>(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
) -> &'a BlobState {
    native::get(scope, obj, 0)
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'Blob': Please use the 'new' operator");
        return;
    }

    // Concatenate every part's bytes into one buffer. (A single non-array
    // part isn't spec-legal, but `collect_parts` tolerates it as a
    // one-element sequence — matches Node's leniency here.)
    let bytes = if args.length() > 0 { collect_parts(scope, args.get(0)) } else { Vec::new() };

    // options.type — lowercased per spec.
    let mut type_ = String::new();
    if args.length() > 1 && !args.get(1).is_undefined() {
        if let Ok(opts) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            let key = v8::String::new(scope, "type").unwrap();
            if let Some(v) = opts.get(scope, key.into()) {
                if !v.is_undefined() {
                    type_ = v.to_rust_string_lossy(scope).to_ascii_lowercase();
                }
            }
        }
    }

    let this = args.this();
    native::store(scope, this, 0, BlobState { bytes, type_ });
    rv.set(this.into());
}

/// Append one `BlobPart`'s bytes to `out`: Blob → read internal bytes;
/// BufferSource (ArrayBuffer/ArrayBufferView) → raw bytes; else → UTF-8 of
/// the value's string coercion (USVString).
fn append_part(scope: &mut v8::PinScope, out: &mut Vec<u8>, part: v8::Local<v8::Value>) {
    if let Ok(obj) = <v8::Local<v8::Object>>::try_from(part) {
        if is_blob_instance(scope, obj) {
            let st = state(scope, obj);
            out.extend_from_slice(&st.bytes);
            return;
        }
    }
    if let Some(buf) = native::read_buffer_source(part) {
        out.extend_from_slice(&buf);
        return;
    }
    let s = part.to_rust_string_lossy(scope);
    out.extend_from_slice(s.as_bytes());
}

fn get_size(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &BlobState = native::get(scope, args.holder(), 0);
    rv.set(v8::Number::new(scope, st.bytes.len() as f64).into());
}

fn get_type(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &BlobState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &st.type_).unwrap().into());
}

/// `slice(start?, end?, contentType?)` — returns a new Blob with the
/// sliced bytes. Negative `start`/`end` are offsets from the end (per
/// spec). Clamped to [0, size]. The new Blob's `type` is `contentType`
/// (lowercased) or `""`.
fn slice(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &BlobState = native::get(scope, args.this(), 0);
    let size = st.bytes.len() as i64;

    let raw_start = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).integer_value(scope).unwrap_or(0)
    } else {
        0
    };
    let raw_end = if args.length() > 1 && !args.get(1).is_undefined() {
        args.get(1).integer_value(scope).unwrap_or(size)
    } else {
        size
    };

    // Spec: negative start/end → offset from the end; then clamp to [0, size].
    let start = clamp_relative(raw_start, size);
    let end = clamp_relative(raw_end, size);
    let (start, end) = if start > end { (end, start) } else { (start, end) };

    let mut type_ = String::new();
    if args.length() > 2 && !args.get(2).is_undefined() {
        type_ = args.get(2).to_rust_string_lossy(scope).to_ascii_lowercase();
    }

    let sliced = st.bytes[start as usize..end as usize].to_vec();
    let blob = new_instance(scope, sliced, type_);
    rv.set(blob.into());
}

/// Spec slice offset math: negative → `size + value`; then clamp to
/// `[0, size]`.
fn clamp_relative(value: i64, size: i64) -> i64 {
    let v = if value < 0 { size + value } else { value };
    v.clamp(0, size)
}

fn text(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &BlobState = native::get(scope, args.this(), 0);
    let text = String::from_utf8_lossy(&st.bytes).into_owned();
    let s = v8::String::new(scope, &text).unwrap();
    resolve_with(scope, &mut rv, s.into());
}

fn array_buffer(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &BlobState = native::get(scope, args.this(), 0);
    let bytes = st.bytes.clone();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    resolve_with(scope, &mut rv, ab.into());
}

fn stream(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &BlobState = native::get(scope, args.this(), 0);
    let stream = streams::new_fixed_stream(scope, vec![st.bytes.clone()]);
    rv.set(stream.into());
}

/// Body is buffered → resolve immediately (same shape as `Response.text()`).
fn resolve_with(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue<v8::Value>, value: v8::Local<v8::Value>) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    resolver.resolve(scope, value);
    rv.set(resolver.get_promise(scope).into());
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