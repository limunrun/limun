//! Module loading & resolution — the V8 module-resolution callbacks ARE the
//! loader. Every module has a URL identity (`file://` local, `https://`
//! remote); `core::io` is where the actual bytes get read/fetched.

use crate::core::exception::exception_text;
use crate::core::io;
use crate::core::resolver::resolve_specifier;
use crate::core::state::{MODULE_URLS, REGISTRY};
use url::Url;

/// Compile (or fetch from registry) the module at `url`.
/// On failure an exception is scheduled in the isolate and None is returned.
pub fn load_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
) -> Option<v8::Local<'s, v8::Module>> {
    // Dedup: the same URL must yield the same module instance.
    let cached = REGISTRY.with(|r| r.borrow().get(url).cloned());
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

    let code = v8::String::new(scope, &source_text)?;
    let mut source = v8::script_compiler::Source::new(code, Some(&origin));

    // On syntax error this throws into the isolate and returns None.
    let module = v8::script_compiler::compile_module(scope, &mut source)?;

    let global = v8::Global::new(scope, module);
    REGISTRY.with(|r| r.borrow_mut().insert(url.clone(), global));
    MODULE_URLS.with(|d| {
        d.borrow_mut()
            .insert(module.get_identity_hash().get(), url.clone())
    });

    Some(module)
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

/// V8 calls this for every static `import` specifier while instantiating
/// the graph.
pub fn resolve_module_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);

    let specifier = specifier.to_rust_string_lossy(scope);

    let referrer_url = MODULE_URLS
        .with(|d| {
            d.borrow()
                .get(&referrer.get_identity_hash().get())
                .cloned()
        })
        .unwrap_or_else(current_dir_url);

    match resolve_specifier(&specifier, &referrer_url) {
        Ok(url) => load_module(scope, &url),
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
    _import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);

    let specifier = specifier.to_rust_string_lossy(scope);
    let referrer_url = resource_name
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .and_then(|s| Url::parse(&s).ok())
        .unwrap_or_else(current_dir_url);

    match resolve_specifier(&specifier, &referrer_url).and_then(|url| load_and_run(scope, &url)) {
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
) -> Result<v8::Local<'s, v8::Value>, String> {
    v8::tc_scope!(let tc, scope);

    let module = load_module(tc, url).ok_or_else(|| exception_text(tc))?;

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
