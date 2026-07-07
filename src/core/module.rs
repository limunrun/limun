//! Module loading & resolution — the V8 module-resolution callbacks ARE the
//! loader. Every module has a URL identity (`file://` local, `https://`
//! remote); `core::io` is where the actual bytes get read/fetched.
//!
//! Import attributes (`with { type: "..." }`,
//! https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with)
//! select the module's *kind* — plain JS (default), or a synthetic `json`/
//! `text` module built from the same fetched bytes. Same URL + different
//! `type` = a genuinely different module (per spec), so the registry keys
//! on `(Url, ModuleKind)`, not just `Url`.

use crate::core::exception::exception_text;
use crate::core::io;
use crate::core::resolver::resolve_specifier;
use crate::core::state::{MODULE_URLS, REGISTRY, SYNTHETIC_EXPORTS};
use url::Url;

/// What a module's body actually is, selected by the `type` import
/// attribute. Affects both module identity (cache key) and how the fetched
/// bytes get turned into a `v8::Module`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ModuleKind {
    /// No `type` attribute (or unrecognized): ordinary ES module source.
    JavaScript,
    /// `with { type: "json" }` — single `default` export, the parsed value.
    Json,
    /// `with { type: "text" }` — single `default` export, the raw string.
    Text,
}

/// Compile (or fetch from registry) the module at `url` as `kind`.
/// On failure an exception is scheduled in the isolate and None is returned.
pub fn load_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
    kind: ModuleKind,
) -> Option<v8::Local<'s, v8::Module>> {
    // Dedup: the same (URL, kind) must yield the same module instance.
    let cache_key = (url.clone(), kind);
    let cached = REGISTRY.with(|r| r.borrow().get(&cache_key).cloned());
    if let Some(global) = cached {
        return Some(v8::Local::new(scope, &global));
    }

    let source_text = match read_source(url) {
        Ok(s) => s,
        Err(e) => {
            throw(scope, &e);
            return None;
        }
    };

    let module = match kind {
        ModuleKind::JavaScript => compile_js_module(scope, url, &source_text)?,
        ModuleKind::Json => {
            let code = v8::String::new(scope, &source_text)?;
            let value = v8::json::parse(scope, code)?;
            create_synthetic_module(scope, url, value)
        }
        ModuleKind::Text => {
            let value = v8::String::new(scope, &source_text)?.into();
            create_synthetic_module(scope, url, value)
        }
    };

    let global = v8::Global::new(scope, module);
    REGISTRY.with(|r| r.borrow_mut().insert(cache_key, global));
    MODULE_URLS.with(|d| {
        d.borrow_mut()
            .insert(module.get_identity_hash().get(), url.clone())
    });

    Some(module)
}

fn compile_js_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
    source_text: &str,
) -> Option<v8::Local<'s, v8::Module>> {
    let resource_name = v8::String::new(scope, url.as_str()).unwrap();
    let origin = v8::ScriptOrigin::new(
        scope,
        resource_name.into(),
        0,     // line offset
        0,     // column offset
        false, // shared cross origin
        0,     // script id
        None,  // source map url
        false, // opaque
        false, // is wasm
        true,  // is module
        None,  // host defined options
    );

    let code = v8::String::new(scope, source_text)?;
    let mut source = v8::script_compiler::Source::new(code, Some(&origin));

    // On syntax error this throws into the isolate and returns None.
    v8::script_compiler::compile_module(scope, &mut source)
}

/// Build a single-`default`-export synthetic module. `value` is stashed by
/// identity hash for `synthetic_evaluation_steps` (which must be a captureless
/// fn item, per V8's synthetic-module API) to pick up during evaluation.
fn create_synthetic_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
    value: v8::Local<'s, v8::Value>,
) -> v8::Local<'s, v8::Module> {
    let name = v8::String::new(scope, url.as_str()).unwrap();
    let export_name = v8::String::new(scope, "default").unwrap();
    let module =
        v8::Module::create_synthetic_module(scope, name, &[export_name], synthetic_evaluation_steps);

    let global_value = v8::Global::new(scope, value);
    SYNTHETIC_EXPORTS.with(|m| {
        m.borrow_mut()
            .insert(module.get_identity_hash().get(), global_value)
    });

    module
}

fn synthetic_evaluation_steps<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    v8::callback_scope!(unsafe scope, context);

    let id = module.get_identity_hash().get();
    let global_value = SYNTHETIC_EXPORTS.with(|m| m.borrow_mut().remove(&id))?;
    let value = v8::Local::new(scope, &global_value);

    let export_name = v8::String::new(scope, "default").unwrap();
    module.set_synthetic_module_export(scope, export_name, value)?;

    Some(v8::undefined(scope).into())
}

/// Dispatch on scheme: `file:` reads local disk, `http(s):` fetches over
/// the network, `data:` decodes inline. All three go through `core::io`
/// (see its doc comment on the fs/net permission choke point).
fn read_source(url: &Url) -> Result<String, String> {
    match url.scheme() {
        "file" => {
            let path = url
                .to_file_path()
                .map_err(|_| format!("invalid file URL: {url}"))?;
            io::read_file(&path)
        }
        "http" | "https" => io::fetch(url),
        "data" => io::decode_data_url(url),
        scheme => Err(format!(
            "cannot resolve \"{url}\": unsupported scheme \"{scheme}:\" (only file/http/https/data are supported)"
        )),
    }
}

/// Read the `type` import attribute out of a `FixedArray`, whose layout
/// differs by call site (empirically verified against V8 15.0):
///   - static imports (`resolve_module_callback`): `[key, value, source_offset, ...]`
///   - dynamic imports (`dynamic_import_callback`): `[key, value, ...]`
/// `step` is 3 or 2 respectively. Any attribute key other than `type`, or an
/// unrecognized `type` value, is an error — matches spec ("a SyntaxError/
/// TypeError is thrown for an unsupported key" and unsupported values for a
/// supported key may also throw).
fn extract_module_kind(
    scope: &mut v8::PinScope,
    import_attributes: v8::Local<v8::FixedArray>,
    step: usize,
) -> Result<ModuleKind, String> {
    let len = import_attributes.length();
    let mut i = 0;
    let mut kind = ModuleKind::JavaScript;

    while i + 1 < len {
        let key = import_attributes.get(scope, i).unwrap();
        let key: v8::Local<v8::Value> = key.try_into().unwrap();
        let key = key.to_rust_string_lossy(scope);

        let value = import_attributes.get(scope, i + 1).unwrap();
        let value: v8::Local<v8::Value> = value.try_into().unwrap();
        let value = value.to_rust_string_lossy(scope);

        if key != "type" {
            return Err(format!("unsupported import attribute \"{key}\""));
        }
        kind = match value.as_str() {
            "json" => ModuleKind::Json,
            "text" => ModuleKind::Text,
            other => {
                return Err(format!(
                    "unsupported import attribute type \"{other}\" (only \"json\"/\"text\" are supported)"
                ));
            }
        };

        i += step;
    }

    Ok(kind)
}

/// V8 calls this for every static `import` specifier while instantiating
/// the graph.
pub fn resolve_module_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    import_attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);

    let specifier = specifier.to_rust_string_lossy(scope);

    // Static layout includes a per-attribute source offset: step 3.
    let kind = match extract_module_kind(scope, import_attributes, 3) {
        Ok(k) => k,
        Err(msg) => {
            throw_syntax(scope, &msg);
            return None;
        }
    };

    let referrer_url = MODULE_URLS
        .with(|d| {
            d.borrow()
                .get(&referrer.get_identity_hash().get())
                .cloned()
        })
        .unwrap_or_else(current_dir_url);

    match resolve_specifier(&specifier, &referrer_url) {
        Ok(url) => load_module(scope, &url, kind),
        Err(msg) => {
            throw(scope, &msg);
            None
        }
    }
}

/// V8 calls this for every dynamic `import()` expression. We load,
/// instantiate, and evaluate synchronously (this runtime has no async I/O
/// yet — even the network fetch in `read_source` blocks) and settle the
/// returned promise immediately; that's spec-legal even though browsers
/// usually settle it later.
pub fn dynamic_import_callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);

    // Dynamic layout has no source offsets: step 2.
    let kind = match extract_module_kind(scope, import_attributes, 2) {
        Ok(k) => k,
        Err(msg) => {
            let message = v8::String::new(scope, &msg).unwrap();
            let exception = v8::Exception::type_error(scope, message);
            resolver.reject(scope, exception);
            return Some(promise);
        }
    };

    let specifier = specifier.to_rust_string_lossy(scope);
    let referrer_url = resource_name
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .and_then(|s| Url::parse(&s).ok())
        .unwrap_or_else(current_dir_url);

    match resolve_specifier(&specifier, &referrer_url).and_then(|url| load_and_run(scope, &url, kind)) {
        Ok(namespace) => {
            resolver.resolve(scope, namespace);
        }
        Err(message) => {
            let message = v8::String::new(scope, &message).unwrap();
            let exception = v8::Exception::error(scope, message);
            resolver.reject(scope, exception);
        }
    }

    Some(promise)
}

/// Load + instantiate + evaluate a module graph, returning its namespace
/// object. Only used by dynamic `import()` — the entry-point path in
/// `core::execute` stays separate since it reports errors with source
/// location detail and an exit code instead of a rejected promise.
fn load_and_run<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
    kind: ModuleKind,
) -> Result<v8::Local<'s, v8::Value>, String> {
    v8::tc_scope!(let tc, scope);

    let module = load_module(tc, url, kind).ok_or_else(|| exception_text(tc))?;

    if module.instantiate_module(tc, resolve_module_callback).is_none() {
        return Err(exception_text(tc));
    }

    let _completion = module.evaluate(tc);

    if module.get_status() == v8::ModuleStatus::Errored {
        let exception = module.get_exception();
        let text = exception
            .to_string(tc)
            .map(|s| s.to_rust_string_lossy(tc))
            .unwrap_or_else(|| "<unprintable exception>".to_string());
        return Err(text);
    }

    if tc.has_caught() {
        return Err(exception_text(tc));
    }

    Ok(module.get_module_namespace())
}

pub fn current_dir_url() -> Url {
    std::env::current_dir()
        .ok()
        .and_then(|p| Url::from_directory_path(p).ok())
        .unwrap_or_else(|| Url::parse("file:///").unwrap())
}

pub fn throw(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
}

/// Same as `throw`, but a `SyntaxError` — matches spec for "unsupported
/// import attribute key/value" on a *static* import.
fn throw_syntax(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::syntax_error(scope, message);
    scope.throw_exception(exception);
}
