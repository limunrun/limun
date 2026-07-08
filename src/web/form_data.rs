//! `FormData` — XMLHttpRequest Standard
//! (https://xhr.spec.whatwg.org/#interface-formdata).
//!
//! Simplifications vs. spec (documented):
//!   - Constructor takes no args. The spec's optional `HTMLFormElement` arg
//!     isn't supported (no DOM) — args are silently ignored.
//!   - `FormDataEntryValue` is `File | USVString`, as in the spec: a `Blob`
//!     value is stored with its filename and read back as a `File` (name
//!     defaults to `"blob"`, per the "create an entry" steps). A `File`
//!     value keeps its own `name`/`lastModified` unless a `filename`
//!     argument overrides the name.

use crate::web::blob;
use crate::web::native;
use std::cell::RefCell;
use std::rc::Rc;

/// One entry in a FormData. `Text` for USVString values; `File` for anything
/// Blob-ish (the spec's "create an entry" steps convert a `Blob` value into a
/// `File` with a filename, defaulting to `"blob"`).
#[derive(Clone)]
pub(crate) enum FormDataEntry {
    Text(String),
    File {
        bytes: Vec<u8>,
        type_: String,
        filename: String,
        last_modified: f64,
    },
}

type Entries = Rc<RefCell<Vec<(String, FormDataEntry)>>>;

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "FormData").unwrap();
    tmpl.set_class_name(name);
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "append", append);
    set_method(scope, proto, "set", set);
    set_method(scope, proto, "delete", delete);
    set_method(scope, proto, "get", get);
    set_method(scope, proto, "getAll", get_all);
    set_method(scope, proto, "has", has);
    set_method(scope, proto, "forEach", for_each);
    set_method(scope, proto, "entries", entries);
    set_method(scope, proto, "keys", keys);
    set_method(scope, proto, "values", values);

    let entries_fn = v8::FunctionTemplate::new(scope, entries);
    let iterator_key = v8::Symbol::get_iterator(scope);
    proto.set(iterator_key.into(), entries_fn.into());

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "FormData", ctor.into());
}

/// Build an empty `FormData` instance from Rust (used by
/// `Response.formData()`).
pub fn new_instance<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "FormData").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    ctor.new_instance(scope, &[]).unwrap()
}

/// Parse `bytes` as `application/x-www-form-urlencoded` and append each
/// `(name, value)` pair to `fd` as a `Text` entry. Used by
/// `Response.formData()`.
pub(crate) fn append_urlencoded(scope: &mut v8::PinScope, fd: v8::Local<v8::Object>, bytes: &[u8]) {
    let entries = entries_state(scope, fd);
    let mut list = entries.borrow_mut();
    for (k, v) in url::form_urlencoded::parse(bytes) {
        list.push((k.into_owned(), FormDataEntry::Text(v.into_owned())));
    }
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'FormData': Please use the 'new' operator");
        return;
    }
    // Spec's optional `HTMLFormElement` arg isn't supported (no DOM) — args
    // are silently ignored.
    let this = args.this();
    native::store(scope, this, 0, Rc::new(RefCell::new(Vec::new())) as Entries);
    rv.set(this.into());
}

fn entries_state<'a>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> &'a Entries {
    native::get(scope, obj, 0)
}

/// Shared by `append`/`set`: build a `FormDataEntry` from a value (Blob or
/// USVString) + optional filename. Returns `None` if `value` was neither a
/// Blob nor coercible to a string (shouldn't happen — string coercion is
/// always possible — but guards the Blob branch cleanly).
fn make_entry(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, filename: Option<v8::Local<v8::Value>>) -> FormDataEntry {
    if let Ok(obj) = <v8::Local<v8::Object>>::try_from(value) {
        if blob::is_blob_instance(scope, obj) {
            let st = blob::state(scope, obj);
            let bytes = st.bytes.clone();
            let type_ = st.type_.clone();
            // Per the "create an entry" steps: an explicit `filename`
            // argument always wins; otherwise a `File` keeps its own name and
            // a plain `Blob` gets the literal name "blob".
            let explicit = filename
                .filter(|v| !v.is_undefined())
                .map(|v| v.to_rust_string_lossy(scope));
            let (existing_name, last_modified) = blob::file_meta(scope, obj)
                .unwrap_or_else(|| ("blob".to_string(), blob::now_ms()));
            let filename = explicit.unwrap_or(existing_name);
            return FormDataEntry::File { bytes, type_, filename, last_modified };
        }
    }
    // USVString.
    FormDataEntry::Text(value.to_rust_string_lossy(scope))
}

fn append(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let name = args.get(0).to_rust_string_lossy(scope);
    let filename = if args.length() > 2 && !args.get(2).is_undefined() {
        Some(args.get(2))
    } else {
        None
    };
    let entry = make_entry(scope, args.get(1), filename);
    entries.borrow_mut().push((name, entry));
}

fn set(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let name = args.get(0).to_rust_string_lossy(scope);
    let filename = if args.length() > 2 && !args.get(2).is_undefined() {
        Some(args.get(2))
    } else {
        None
    };
    let entry = make_entry(scope, args.get(1), filename);
    let mut list = entries.borrow_mut();
    list.retain(|(k, _)| k != &name);
    list.push((name, entry));
}

fn delete(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let name = args.get(0).to_rust_string_lossy(scope);
    entries.borrow_mut().retain(|(k, _)| k != &name);
}

fn get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let name = args.get(0).to_rust_string_lossy(scope);
    let list = entries.borrow();
    match list.iter().find(|(k, _)| k == &name) {
        Some((_, entry)) => rv.set(entry_to_value(scope, entry).into()),
        None => rv.set(v8::null(scope).into()),
    }
}

fn get_all(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let name = args.get(0).to_rust_string_lossy(scope);
    let list = entries.borrow();
    let values: Vec<v8::Local<v8::Value>> = list
        .iter()
        .filter(|(k, _)| k == &name)
        .map(|(_, e)| entry_to_value(scope, e))
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

fn has(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let name = args.get(0).to_rust_string_lossy(scope);
    let found = entries.borrow().iter().any(|(k, _)| k == &name);
    rv.set(v8::Boolean::new(scope, found).into());
}

fn for_each(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let list = entries.borrow().clone();
    let Ok(callback): Result<v8::Local<v8::Function>, _> = args.get(0).try_into() else {
        crate::web::throw_type_error(scope, "forEach: callback must be a function");
        return;
    };
    let receiver = args.this();
    for (k, e) in list {
        let value = entry_to_value(scope, &e);
        let key = v8::String::new(scope, &k).unwrap();
        let argv = [value, key.into(), receiver.into()];
        callback.call(scope, receiver.into(), &argv);
    }
}

fn entries(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let list = entries.borrow().clone();
    let items: Vec<v8::Local<v8::Value>> = list
        .into_iter()
        .map(|(k, e)| {
            let key = v8::String::new(scope, &k).unwrap();
            let value = entry_to_value(scope, &e);
            v8::Array::new_with_elements(scope, &[key.into(), value]).into()
        })
        .collect();
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(native::array_iterator(scope, array));
}

fn keys(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let list = entries.borrow().clone();
    let items: Vec<v8::Local<v8::Value>> = list
        .into_iter()
        .map(|(k, _)| v8::String::new(scope, &k).unwrap().into())
        .collect();
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(native::array_iterator(scope, array));
}

fn values(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let entries = entries_state(scope, args.this());
    let list = entries.borrow().clone();
    let items: Vec<v8::Local<v8::Value>> = list
        .into_iter()
        .map(|(_, e)| entry_to_value(scope, &e))
        .collect();
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(native::array_iterator(scope, array));
}

/// Materialize a `FormDataEntry` back into a JS value: `Text` → string;
/// `File` → a fresh `File` instance (the spec's `FormDataEntryValue`).
fn entry_to_value<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    entry: &FormDataEntry,
) -> v8::Local<'s, v8::Value> {
    match entry {
        FormDataEntry::Text(s) => v8::String::new(scope, s).unwrap().into(),
        FormDataEntry::File { bytes, type_, filename, last_modified } => blob::new_file_instance(
            scope,
            bytes.clone(),
            type_.clone(),
            filename.clone(),
            *last_modified,
        )
        .into(),
    }
}

/// Parse `bytes` as `multipart/form-data` with the given `boundary` and append
/// each part to `fd`. Returns `Err` on a malformed body (per the Fetch
/// Standard, `formData()` then rejects with a `TypeError`).
///
/// Body grammar (RFC 7578 / RFC 2046 §5.1), operating on raw bytes because
/// part bodies are arbitrary binary:
///
/// ```text
///   --boundary CRLF (part-headers CRLF CRLF part-body CRLF)* --boundary-- 
/// ```
///
/// A part's `Content-Disposition: form-data; name="…"[; filename="…"]` names
/// it; a `filename` (even empty) makes it a `File` entry, otherwise it's a
/// text entry decoded as UTF-8. `Content-Type` supplies the file's type.
pub(crate) fn append_multipart(
    scope: &mut v8::PinScope,
    fd: v8::Local<v8::Object>,
    bytes: &[u8],
    boundary: &str,
) -> Result<(), String> {
    let delimiter = format!("--{boundary}");
    let delimiter = delimiter.as_bytes();

    // Find each delimiter occurrence; parts live between consecutive ones.
    let mut positions = Vec::new();
    let mut i = 0;
    while let Some(found) = find(&bytes[i..], delimiter) {
        positions.push(i + found);
        i += found + delimiter.len();
    }
    if positions.is_empty() {
        return Err("multipart body has no boundary delimiter".to_string());
    }

    let entries = entries_state(scope, fd);
    for window in positions.windows(2) {
        let start = window[0] + delimiter.len();
        let end = window[1];
        // Between delimiters: CRLF <headers> CRLF CRLF <body> CRLF.
        // A closing delimiter is followed by "--"; skip anything that isn't
        // an actual part (the preamble before the first delimiter, and the
        // epilogue after the last, are ignored per RFC 2046).
        let Some(section) = bytes.get(start..end) else { continue };
        let Some(section) = strip_prefix(section, b"\r\n") else { continue };
        let section = strip_suffix(section, b"\r\n").unwrap_or(section);

        let Some(sep) = find(section, b"\r\n\r\n") else {
            return Err("multipart part has no header/body separator".to_string());
        };
        let header_bytes = &section[..sep];
        let body = &section[sep + 4..];

        let headers = String::from_utf8_lossy(header_bytes);
        let mut name: Option<String> = None;
        let mut filename: Option<String> = None;
        let mut content_type = String::new();
        for line in headers.split("\r\n") {
            let Some((key, value)) = line.split_once(':') else { continue };
            let key = key.trim();
            let value = value.trim();
            if key.eq_ignore_ascii_case("content-disposition") {
                name = param(value, "name");
                filename = param(value, "filename");
            } else if key.eq_ignore_ascii_case("content-type") {
                content_type = value.to_string();
            }
        }

        let Some(name) = name else {
            return Err("multipart part is missing a Content-Disposition name".to_string());
        };

        let entry = match filename {
            Some(filename) => FormDataEntry::File {
                bytes: body.to_vec(),
                type_: content_type.to_ascii_lowercase(),
                filename,
                last_modified: blob::now_ms(),
            },
            None => FormDataEntry::Text(String::from_utf8_lossy(body).into_owned()),
        };
        entries.borrow_mut().push((name, entry));
    }

    Ok(())
}

/// Extract a `; key="value"` (or `; key=value`) parameter from a header value.
fn param(header_value: &str, key: &str) -> Option<String> {
    for part in header_value.split(';').skip(1) {
        let part = part.trim();
        // Skip malformed (no '=') parameters instead of giving up entirely.
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let v = v.trim();
        // Quoted-string form is by far the common one; RFC 7578 requires it
        // for `name`/`filename`. Unquoted is tolerated.
        let v = v.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(v);
        return Some(v.to_string());
    }
    None
}

/// First index of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn strip_prefix<'a>(bytes: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    bytes.strip_prefix(prefix)
}

fn strip_suffix<'a>(bytes: &'a [u8], suffix: &[u8]) -> Option<&'a [u8]> {
    bytes.strip_suffix(suffix)
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