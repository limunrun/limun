//! `URLSearchParams` — WHATWG URL Standard
//! (https://url.spec.whatwg.org/#interface-urlsearchparams).
//!
//! Two backing modes for the same class: a `new URLSearchParams(...)`
//! instance owns its own list of pairs (`Standalone`); `someUrl
//! .searchParams` instead shares the parent `URL`'s own state
//! (`Linked`) so mutating one is immediately visible through the other,
//! matching spec's "live" `searchParams` requirement. Every mutating
//! method (`append`/`delete`/`set`/`sort`) goes through the same
//! read-all-pairs -> mutate -> write-all-pairs round trip regardless of
//! backing, so both modes share one implementation.

use crate::web::native;
use std::cell::RefCell;
use std::rc::Rc;
use url::Url;

pub(crate) enum ParamsBacking {
    Standalone(Rc<RefCell<Vec<(String, String)>>>),
    Linked(Rc<RefCell<Url>>),
}

thread_local! {
    /// Stashed at `install` time so `web::url`'s `searchParams` getter can
    /// mint new `URLSearchParams` instances (in `Linked` mode) from Rust,
    /// reusing the exact same class/prototype real `new URLSearchParams()`
    /// user code gets.
    static CTOR: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "URLSearchParams").unwrap();
    tmpl.set_class_name(name);
    tmpl.instance_template(scope).set_internal_field_count(1);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "append", append);
    set_method(scope, proto, "delete", delete);
    set_method(scope, proto, "get", get);
    set_method(scope, proto, "getAll", get_all);
    set_method(scope, proto, "has", has);
    set_method(scope, proto, "set", set);
    set_method(scope, proto, "sort", sort);
    set_method(scope, proto, "toString", to_string);
    set_method(scope, proto, "forEach", for_each);
    set_method(scope, proto, "entries", entries);
    set_method(scope, proto, "keys", keys);
    set_method(scope, proto, "values", values);
    // `size` reads per-instance state, so (like `URL`'s accessors) it goes
    // on the instance template — property-callback `.holder()` would
    // otherwise resolve to the shared prototype, not the actual instance.
    set_readonly_accessor(scope, tmpl.instance_template(scope), "size", size_getter);

    let entries_fn = v8::FunctionTemplate::new(scope, entries);
    let iterator_key = v8::Symbol::get_iterator(scope);
    proto.set(iterator_key.into(), entries_fn.into());

    let ctor = tmpl.get_function(scope).unwrap();
    let global_ctor = v8::Global::new(scope, ctor);
    CTOR.with(|c| *c.borrow_mut() = Some(global_ctor));

    crate::web::set_global(scope, global, "URLSearchParams", ctor.into());
}

/// Build a new `URLSearchParams` instance sharing `url_state` (used by
/// `URL.prototype.searchParams`). Constructs via the real registered
/// class (empty/standalone) then overwrites the internal field with the
/// `Linked` backing. The constructor's `Standalone` Vec and its
/// `v8::External`/finalizer registration are both superseded by the
/// second `store` call — the throwaway Vec is reclaimed by the finalizer
/// registered for the `Linked` box when the JS object is collected.
pub(crate) fn new_linked_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url_state: Rc<RefCell<Url>>,
) -> v8::Local<'s, v8::Object> {
    let ctor = CTOR
        .with(|c| c.borrow().clone())
        .expect("URLSearchParams not installed yet");
    let ctor = v8::Local::new(scope, &ctor);
    let instance = ctor.new_instance(scope, &[]).unwrap();
    native::store(scope, instance, 0, ParamsBacking::Linked(url_state));
    instance
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(
            scope,
            "Failed to construct 'URLSearchParams': Please use the 'new' operator",
        );
        return;
    }

    let pairs = parse_init(scope, &args);
    let this = args.this();
    native::store(
        scope,
        this,
        0,
        ParamsBacking::Standalone(Rc::new(RefCell::new(pairs))),
    );
    rv.set(this.into());
}

fn parse_init(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Vec<(String, String)> {
    if args.length() == 0 || args.get(0).is_undefined() {
        return Vec::new();
    }
    let arg = args.get(0);

    // Another URLSearchParams instance: copy its current pairs.
    if let Ok(obj) = <v8::Local<v8::Object>>::try_from(arg) {
        if native::is::<ParamsBacking>(scope, obj, 0) {
            let backing: &ParamsBacking = native::get(scope, obj, 0);
            return read_pairs(backing);
        }
    }

    // Sequence of [name, value] pairs.
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
                    pairs.push((k, v));
                }
            }
        }
        return pairs;
    }

    // Record (plain object): own enumerable string-keyed properties.
    if let Ok(obj) = <v8::Local<v8::Object>>::try_from(arg) {
        if let Some(keys) = obj.get_own_property_names(scope, Default::default()) {
            let mut pairs = Vec::new();
            for i in 0..keys.length() {
                if let Some(key) = keys.get_index(scope, i) {
                    let key_str = key.to_rust_string_lossy(scope);
                    if let Some(value) = obj.get(scope, key) {
                        pairs.push((key_str, value.to_rust_string_lossy(scope)));
                    }
                }
            }
            return pairs;
        }
    }

    // Fallback: a query string, optionally leading with "?".
    let s = arg.to_rust_string_lossy(scope);
    let s = s.strip_prefix('?').unwrap_or(&s);
    url::form_urlencoded::parse(s.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn read_pairs(backing: &ParamsBacking) -> Vec<(String, String)> {
    match backing {
        ParamsBacking::Standalone(v) => v.borrow().clone(),
        ParamsBacking::Linked(u) => u
            .borrow()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
    }
}

fn write_pairs(backing: &ParamsBacking, pairs: Vec<(String, String)>) {
    match backing {
        ParamsBacking::Standalone(v) => *v.borrow_mut() = pairs,
        ParamsBacking::Linked(u) => {
            let mut url = u.borrow_mut();
            if pairs.is_empty() {
                url.set_query(None);
            } else {
                let mut ser = url::form_urlencoded::Serializer::new(String::new());
                for (k, v) in &pairs {
                    ser.append_pair(k, v);
                }
                url.set_query(Some(&ser.finish()));
            }
        }
    }
}

fn append(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    let mut pairs = read_pairs(backing);
    pairs.push((name, value));
    write_pairs(backing, pairs);
}

fn delete(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = if args.length() > 1 && !args.get(1).is_undefined() {
        Some(args.get(1).to_rust_string_lossy(scope))
    } else {
        None
    };
    let pairs = read_pairs(backing);
    let filtered = pairs
        .into_iter()
        .filter(|(k, v)| !(k == &name && value.as_ref().is_none_or(|val| v == val)))
        .collect();
    write_pairs(backing, filtered);
}

fn get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope);
    let pairs = read_pairs(backing);
    match pairs.into_iter().find(|(k, _)| k == &name) {
        Some((_, v)) => rv.set(v8::String::new(scope, &v).unwrap().into()),
        None => rv.set(v8::null(scope).into()),
    }
}

fn get_all(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope);
    let pairs = read_pairs(backing);
    let values: Vec<v8::Local<v8::Value>> = pairs
        .into_iter()
        .filter(|(k, _)| k == &name)
        .map(|(_, v)| v8::String::new(scope, &v).unwrap().into())
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

fn has(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = if args.length() > 1 && !args.get(1).is_undefined() {
        Some(args.get(1).to_rust_string_lossy(scope))
    } else {
        None
    };
    let pairs = read_pairs(backing);
    let found = pairs
        .iter()
        .any(|(k, v)| k == &name && value.as_ref().is_none_or(|val| v == val));
    rv.set(v8::Boolean::new(scope, found).into());
}

fn set(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    let pairs = read_pairs(backing);

    let mut result = Vec::with_capacity(pairs.len());
    let mut inserted = false;
    for (k, v) in pairs {
        if k == name {
            if !inserted {
                result.push((k, value.clone()));
                inserted = true;
            }
            // subsequent entries with the same name are dropped
        } else {
            result.push((k, v));
        }
    }
    if !inserted {
        result.push((name, value));
    }
    write_pairs(backing, result);
}

fn sort(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let mut pairs = read_pairs(backing);
    // Stable sort by UTF-16 code unit order of the name, per spec.
    pairs.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    write_pairs(backing, pairs);
}

fn to_string(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let pairs = read_pairs(backing);
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in &pairs {
        ser.append_pair(k, v);
    }
    rv.set(v8::String::new(scope, &ser.finish()).unwrap().into());
}

fn size_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.holder(), 0);
    let count = read_pairs(backing).len();
    rv.set(v8::Number::new(scope, count as f64).into());
}

fn for_each(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let pairs = read_pairs(backing);
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
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let pairs = read_pairs(backing);
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
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let pairs = read_pairs(backing);
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
    let backing: &ParamsBacking = native::get(scope, args.this(), 0);
    let pairs = read_pairs(backing);
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

fn set_readonly_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor(key.into(), getter);
}
