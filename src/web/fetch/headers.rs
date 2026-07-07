//! `Headers` — WHATWG Fetch Standard
//! (https://fetch.spec.whatwg.org/#headers-class).
//!
//! Simplified vs. spec: names are normalized to lowercase on the way in
//! (spec technically preserves original casing for single-value entries
//! and only normalizes for comparison/iteration — verified against Node,
//! which *does* just lowercase everything on the way in, so this matches
//! real-world behavior even if not the letter of the spec). No
//! `getSetCookie()`/forbidden-header-name guarding.

use crate::web::native;
use std::cell::RefCell;

pub(crate) struct HeadersState(pub RefCell<Vec<(String, String)>>);

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "Headers").unwrap();
    tmpl.set_class_name(name);
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "append", append);
    set_method(scope, proto, "delete", delete);
    set_method(scope, proto, "get", get);
    set_method(scope, proto, "has", has);
    set_method(scope, proto, "set", set);
    set_method(scope, proto, "forEach", for_each);
    set_method(scope, proto, "entries", entries);
    set_method(scope, proto, "keys", keys);
    set_method(scope, proto, "values", values);

    let entries_fn = v8::FunctionTemplate::new(scope, entries);
    let iterator_key = v8::Symbol::get_iterator(scope);
    proto.set(iterator_key.into(), entries_fn.into());

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "Headers", ctor.into());
}

/// Build a `Headers` instance from Rust (used by `Response`'s constructor
/// and `fetch()`'s result).
pub(crate) fn new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    pairs: Vec<(String, String)>,
) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "Headers").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    let instance = ctor.new_instance(scope, &[]).unwrap();
    native::store(scope, instance, 0, HeadersState(RefCell::new(pairs)));
    instance
}

pub(crate) fn read_pairs(scope: &mut v8::PinScope, headers: v8::Local<v8::Object>) -> Vec<(String, String)> {
    let state: &HeadersState = native::get(scope, headers, 0);
    state.0.borrow().clone()
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'Headers': Please use the 'new' operator");
        return;
    }
    let pairs = parse_init(scope, &args);
    let this = args.this();
    native::store(scope, this, 0, HeadersState(RefCell::new(pairs)));
    rv.set(this.into());
}

fn parse_init(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Vec<(String, String)> {
    if args.length() == 0 || args.get(0).is_undefined() {
        return Vec::new();
    }
    parse_value(scope, args.get(0))
}

/// Parse anything spec-legal as a `HeadersInit`: a sequence of `[name,
/// value]` pairs, a record (plain object), or another `Headers` instance.
/// Shared with `Response`'s constructor (`headers` init option) and
/// `fetch()`'s `init.headers`.
pub(crate) fn parse_value(scope: &mut v8::PinScope, arg: v8::Local<v8::Value>) -> Vec<(String, String)> {
    if let Ok(array) = <v8::Local<v8::Array>>::try_from(arg) {
        let mut pairs = Vec::new();
        for i in 0..array.length() {
            if let Some(entry) = array.get_index(scope, i) {
                if let Ok(pair) = <v8::Local<v8::Array>>::try_from(entry) {
                    let k = pair
                        .get_index(scope, 0)
                        .map(|v| v.to_rust_string_lossy(scope))
                        .unwrap_or_default();
                    let v = pair
                        .get_index(scope, 1)
                        .map(|v| v.to_rust_string_lossy(scope))
                        .unwrap_or_default();
                    pairs.push((k.to_lowercase(), v));
                }
            }
        }
        return pairs;
    }

    if let Ok(obj) = <v8::Local<v8::Object>>::try_from(arg) {
        // Another Headers instance: copy its pairs.
        if obj.internal_field_count() > 0 {
            if let Some(field) = obj.get_internal_field(scope, 0) {
                if <v8::Local<v8::External>>::try_from(field).is_ok() {
                    return read_pairs(scope, obj);
                }
            }
        }
        // Record (plain object).
        if let Some(keys) = obj.get_own_property_names(scope, Default::default()) {
            let mut pairs = Vec::new();
            for i in 0..keys.length() {
                if let Some(key) = keys.get_index(scope, i) {
                    let key_str = key.to_rust_string_lossy(scope).to_lowercase();
                    if let Some(value) = obj.get(scope, key) {
                        pairs.push((key_str, value.to_rust_string_lossy(scope)));
                    }
                }
            }
            return pairs;
        }
    }

    Vec::new()
}

fn append(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let state: &HeadersState = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope).to_lowercase();
    let value = args.get(1).to_rust_string_lossy(scope);
    let mut pairs = state.0.borrow_mut();
    if let Some(existing) = pairs.iter_mut().find(|(k, _)| *k == name) {
        existing.1 = format!("{}, {}", existing.1, value);
    } else {
        pairs.push((name, value));
    }
}

fn delete(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let state: &HeadersState = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope).to_lowercase();
    state.0.borrow_mut().retain(|(k, _)| *k != name);
}

fn get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &HeadersState = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope).to_lowercase();
    match state.0.borrow().iter().find(|(k, _)| *k == name) {
        Some((_, v)) => rv.set(v8::String::new(scope, v).unwrap().into()),
        None => rv.set(v8::null(scope).into()),
    }
}

fn has(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &HeadersState = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope).to_lowercase();
    let found = state.0.borrow().iter().any(|(k, _)| *k == name);
    rv.set(v8::Boolean::new(scope, found).into());
}

fn set(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let state: &HeadersState = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope).to_lowercase();
    let value = args.get(1).to_rust_string_lossy(scope);
    let mut pairs = state.0.borrow_mut();
    pairs.retain(|(k, _)| *k != name);
    pairs.push((name, value));
}

fn for_each(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let pairs = read_pairs(scope, args.this());
    let Ok(callback): Result<v8::Local<v8::Function>, _> = args.get(0).try_into() else {
        crate::web::throw_type_error(scope, "forEach: callback must be a function");
        return;
    };
    let receiver = args.this();
    for (k, v) in pairs {
        let value = v8::String::new(scope, &v).unwrap();
        let key = v8::String::new(scope, &k).unwrap();
        let argv = [value.into(), key.into(), receiver.into()];
        callback.call(scope, receiver.into(), &argv);
    }
}

fn entries(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let mut pairs = read_pairs(scope, args.this());
    pairs.sort_by(|a, b| a.0.cmp(&b.0)); // spec: iteration order is sorted by name
    let items: Vec<v8::Local<v8::Value>> = pairs
        .into_iter()
        .map(|(k, v)| {
            let k = v8::String::new(scope, &k).unwrap();
            let v = v8::String::new(scope, &v).unwrap();
            v8::Array::new_with_elements(scope, &[k.into(), v.into()]).into()
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
    let mut pairs = read_pairs(scope, args.this());
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let items: Vec<v8::Local<v8::Value>> = pairs
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
    let mut pairs = read_pairs(scope, args.this());
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let items: Vec<v8::Local<v8::Value>> = pairs
        .into_iter()
        .map(|(_, v)| v8::String::new(scope, &v).unwrap().into())
        .collect();
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(native::array_iterator(scope, array));
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
