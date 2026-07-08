//! `URL` — WHATWG URL Standard (https://url.spec.whatwg.org/#url-class).
//! Backed by the real `url` crate (rust-url — the same parser used by
//! Servo/Firefox), not a hand-rolled parser.
//!
//! Per spec, only the `href` setter (and the constructor) throw
//! `TypeError` on an unparsable value — every other component setter
//! (`protocol`, `host`, `pathname`, ...) silently no-ops on failure.
//! `searchParams` is live: mutating it updates this URL's `search`/`href`
//! immediately, and vice versa (see `web::url_search_params`).
use crate::web::native;
use crate::web::url_search_params;
use std::cell::RefCell;
use std::rc::Rc;
use ::url::Url as RustUrl;

struct UrlInternal {
    url: Rc<RefCell<RustUrl>>,
    // Cached so `.searchParams` returns the *same* object every access,
    // per spec (`URLSearchParams` live-binding identity).
    search_params: RefCell<Option<v8::Global<v8::Object>>>,
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    let name = v8::String::new(scope, "URL").unwrap();
    tmpl.set_class_name(name);
    // Accessors go on the *instance* template, not the prototype: property
    // callbacks in this V8 binding only expose `.holder()` (the object the
    // accessor was found on), not the true receiver — putting them on the
    // shared prototype would mean every instance's accessor call sees the
    // prototype object (no internal field data) instead of itself. Own
    // per-instance accessors sidestep that (holder == the instance).
    // Deviates slightly from real engines (there, these are inherited
    // prototype accessors — `Object.getOwnPropertyNames(url)` would be
    // empty), same category of pragmatic simplification as `TextDecoder`'s
    // options being own properties.
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);
    set_accessor(scope, instance, "href", get_href, set_href);
    set_readonly_accessor(scope, instance, "origin", get_origin);
    set_accessor(scope, instance, "protocol", get_protocol, set_protocol);
    set_accessor(scope, instance, "username", get_username, set_username);
    set_accessor(scope, instance, "password", get_password, set_password);
    set_accessor(scope, instance, "host", get_host, set_host);
    set_accessor(scope, instance, "hostname", get_hostname, set_hostname);
    set_accessor(scope, instance, "port", get_port, set_port);
    set_accessor(scope, instance, "pathname", get_pathname, set_pathname);
    set_accessor(scope, instance, "search", get_search, set_search);
    set_readonly_accessor(scope, instance, "searchParams", get_search_params);
    set_accessor(scope, instance, "hash", get_hash, set_hash);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "toString", to_string);
    set_method(scope, proto, "toJSON", to_string);

    let ctor = tmpl.get_function(scope).unwrap();
    set_static_method(scope, ctor, "canParse", can_parse);
    set_static_method(scope, ctor, "parse", parse_static);

    crate::web::set_global(scope, global, "URL", ctor.into());
}

/// Reads arg0 (url) + optional arg1 (base: string or another URL) and
/// resolves per spec: parse `base` first (if given), then parse `url`
/// against it. Shared by the constructor and the `canParse`/`parse`
/// static methods.
fn resolve_args(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Result<RustUrl, String> {
    let url_str = args.get(0).to_rust_string_lossy(scope);

    let base = if args.length() > 1 && !args.get(1).is_undefined() {
        let base_arg = args.get(1);
        let base_str = if let Ok(obj) = <v8::Local<v8::Object>>::try_from(base_arg) {
            if native::is::<UrlInternal>(scope, obj, 0) {
                // Another URL instance: read its href directly instead of
                // going through JS's toString.
                let internal: &UrlInternal = native::get(scope, obj, 0);
                Some(internal.url.borrow().as_str().to_string())
            } else {
                Some(base_arg.to_rust_string_lossy(scope))
            }
        } else {
            Some(base_arg.to_rust_string_lossy(scope))
        };
        match base_str {
            Some(s) => Some(RustUrl::parse(&s).map_err(|e| format!("invalid base URL: {e}"))?),
            None => None,
        }
    } else {
        None
    };

    let parsed = match &base {
        Some(base) => base.join(&url_str),
        None => RustUrl::parse(&url_str),
    };
    parsed.map_err(|e| format!("Invalid URL: {url_str} ({e})"))
}

fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'URL': Please use the 'new' operator");
        return;
    }
    let parsed = match resolve_args(scope, &args) {
        Ok(u) => u,
        Err(msg) => {
            crate::web::throw_type_error(scope, &msg);
            return;
        }
    };
    let this = args.this();
    native::store(
        scope,
        this,
        0,
        UrlInternal {
            url: Rc::new(RefCell::new(parsed)),
            search_params: RefCell::new(None),
        },
    );
    rv.set(this.into());
}

fn can_parse(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let ok = resolve_args(scope, &args).is_ok();
    rv.set(v8::Boolean::new(scope, ok).into());
}

/// `URL.parse(url, base?)` — like the constructor, but returns `null`
/// instead of throwing on failure (newer, Baseline-widely-available
/// addition).
fn parse_static(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(parsed) = resolve_args(scope, &args) else {
        rv.set(v8::null(scope).into());
        return;
    };
    let instance = new_instance(scope, parsed);
    rv.set(instance.into());
}

/// Build a `URL` instance from Rust (used by `parse_static`, and
/// available for other native code that needs to hand JS a real `URL`).
pub fn new_instance<'s>(scope: &mut v8::PinScope<'s, '_>, url: RustUrl) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "URL").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    let href = v8::String::new(scope, url.as_str()).unwrap();
    let instance = ctor.new_instance(scope, &[href.into()]).unwrap();
    // Overwrite with the exact parsed value passed in (avoids re-parsing
    // round-trip surprises, though href round-trips losslessly in
    // practice for rust-url).
    native::store(
        scope,
        instance,
        0,
        UrlInternal {
            url: Rc::new(RefCell::new(url)),
            search_params: RefCell::new(None),
        },
    );
    instance
}

fn get_href(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal.url.borrow().as_str().to_string();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_href(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    match RustUrl::parse(&s) {
        Ok(new_url) => {
            let internal: &UrlInternal = native::get(scope, args.holder(), 0);
            *internal.url.borrow_mut() = new_url;
        }
        Err(e) => crate::web::throw_type_error(scope, &format!("Invalid URL: {s} ({e})")),
    }
}

fn get_origin(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let origin = internal.url.borrow().origin().ascii_serialization();
    rv.set(v8::String::new(scope, &origin).unwrap().into());
}

fn get_protocol(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = format!("{}:", internal.url.borrow().scheme());
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_protocol(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let scheme = s.trim_end_matches(':');
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let _ = internal.url.borrow_mut().set_scheme(scheme); // spec: silently ignore on failure
}

fn get_username(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal.url.borrow().username().to_string();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_username(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let _ = internal.url.borrow_mut().set_username(&s);
}

fn get_password(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal.url.borrow().password().unwrap_or("").to_string();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_password(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let opt = if s.is_empty() { None } else { Some(s.as_str()) };
    let _ = internal.url.borrow_mut().set_password(opt);
}

fn get_host(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let url = internal.url.borrow();
    let s = match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        (None, _) => String::new(),
    };
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_host(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let mut url = internal.url.borrow_mut();
    // Split host[:port], special-casing bracketed IPv6 literals like
    // "[::1]:8080" — a naive rsplit_once(':') would split on a ':' inside
    // the brackets. For a bracketed host, everything up to and including
    // the closing ']' is the host (rust-url's set_host wants the brackets
    // kept for IPv6); a ':' immediately after ']' begins the port.
    let (host, port_str): (&str, Option<&str>) = if let Some(rest) = s.strip_prefix('[') {
        match rest.find(']') {
            Some(end) => {
                // rest[end] == ']' maps to s[end + 1] == ']'.
                let host_with_brackets = &s[..=end + 1];
                let after = &s[end + 2..];
                let port = after.strip_prefix(':').filter(|p| !p.is_empty());
                (host_with_brackets, port)
            }
            None => (s.as_str(), None), // malformed — let set_host reject
        }
    } else {
        match s.rsplit_once(':') {
            Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
            _ => (s.as_str(), None),
        }
    };
    let _ = url.set_host(Some(host));
    if let Some(p) = port_str {
        let port = p.parse::<u16>().ok();
        let _ = url.set_port(port);
    }
}

fn get_hostname(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal.url.borrow().host_str().unwrap_or("").to_string();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_hostname(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let _ = internal.url.borrow_mut().set_host(Some(&s));
}

fn get_port(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal.url.borrow().port().map(|p| p.to_string()).unwrap_or_default();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_port(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let port = if s.is_empty() { None } else { s.parse::<u16>().ok() };
    let _ = internal.url.borrow_mut().set_port(port);
}

fn get_pathname(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal.url.borrow().path().to_string();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_pathname(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    internal.url.borrow_mut().set_path(&s);
}

fn get_search(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal
        .url
        .borrow()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_search(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let stripped = s.strip_prefix('?').unwrap_or(&s);
    let q = if stripped.is_empty() { None } else { Some(stripped) };
    internal.url.borrow_mut().set_query(q);
}

fn get_search_params(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.holder();
    let internal: &UrlInternal = native::get(scope, this, 0);

    if let Some(cached) = internal.search_params.borrow().as_ref() {
        rv.set(v8::Local::new(scope, cached).into());
        return;
    }

    let instance = url_search_params::new_linked_instance(scope, internal.url.clone());
    let global = v8::Global::new(scope, instance);
    *internal.search_params.borrow_mut() = Some(global);
    rv.set(instance.into());
}

fn get_hash(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let s = internal
        .url
        .borrow()
        .fragment()
        .map(|f| format!("#{f}"))
        .unwrap_or_default();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn set_hash(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let s = value.to_rust_string_lossy(scope);
    let internal: &UrlInternal = native::get(scope, args.holder(), 0);
    let stripped = s.strip_prefix('#').unwrap_or(&s);
    let f = if stripped.is_empty() { None } else { Some(stripped) };
    internal.url.borrow_mut().set_fragment(f);
}

fn to_string(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let internal: &UrlInternal = native::get(scope, args.this(), 0);
    let s = internal.url.borrow().as_str().to_string();
    rv.set(v8::String::new(scope, &s).unwrap().into());
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

fn set_static_method(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Function>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    target.set(scope, key.into(), func.into());
}

/// Getter + setter accessor, installed directly on the instance template
/// (see the comment in `install` for why not the prototype template).
fn set_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
    setter: impl v8::MapFnTo<v8::AccessorNameSetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor_with_setter(key.into(), getter, setter);
}

/// Getter-only accessor (`origin`, `searchParams`) — same instance-template
/// placement as `set_accessor`.
fn set_readonly_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor(key.into(), getter);
}
