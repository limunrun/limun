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
use crate::core::import_map;
use crate::core::internal_js;
use crate::core::io;
use crate::core::resolver::resolve_specifier;
use crate::core::state::{MODULE_URLS, REGISTRY, SYNTHETIC_EXPORTS};
use crate::core::{permissions, runtime, state};
use crate::core::bridge::TaskResult;
use base64::Engine as _;
use sha2::{Digest, Sha256};
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

    load_module_from_source(scope, url, kind, &source_text)
}

/// Compile (or fetch from registry) a module from already-read source
/// text. Split out of `load_module` so the async dynamic-import path
/// (`finish_dynamic_import_from_source`) can reuse the compile/instantiate/
/// register logic after fetching the body over the network on a tokio
/// worker thread. Performs the integrity check against the supplied bytes.
pub fn load_module_from_source<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
    kind: ModuleKind,
    source_text: &str,
) -> Option<v8::Local<'s, v8::Module>> {
    let cache_key = (url.clone(), kind);
    let cached = REGISTRY.with(|r| r.borrow().get(&cache_key).cloned());
    if let Some(global) = cached {
        return Some(v8::Local::new(scope, &global));
    }

    if let Err(e) = verify_integrity(url, source_text.as_bytes()) {
        throw(scope, &e);
        return None;
    }

    let module = match kind {
        ModuleKind::JavaScript => compile_js_module(scope, url, source_text)?,
        ModuleKind::Json => {
            let code = v8::String::new(scope, source_text)?;
            let value = v8::json::parse(scope, code)?;
            create_synthetic_module(scope, url, value)
        }
        ModuleKind::Text => {
            let value = v8::String::new(scope, source_text)?.into();
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

/// Compile (or fetch from registry) an internal `ext:limun/…` module.
/// Bypasses `core::io` and `core::permissions` — internal modules are
/// embedded in the binary and trusted. The specifier is parsed into a
/// synthetic `Url` for the dedup cache key, so a static and a dynamic
/// import of the same internal module share one compiled instance.
fn load_internal<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    specifier: &str,
) -> Option<v8::Local<'s, v8::Module>> {
    let Some(source) = internal_js::source_for(specifier) else {
        throw(
            scope,
            &format!("cannot resolve \"{specifier}\": not in internal module registry"),
        );
        return None;
    };
    let url = internal_js::specifier_url(specifier).unwrap();
    load_module_from_source(scope, &url, ModuleKind::JavaScript, source)
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

/// Read the module body as UTF-8 source text. The scheme dispatch lives in
/// `core::io::read_to_string` — `file:` reads disk, `http(s):` fetches the
/// network, `data:` decodes inline. Permission checks happen inside `io`
/// (one choke-point: see `core::io`'s doc comment).
fn read_source(url: &Url) -> Result<String, String> {
    io::read_to_string(url).map_err(|e| format!("cannot resolve \"{url}\": {e}"))
}

/// Subresource Integrity check: if the import map declared an `integrity`
/// value for `url`, hash `bytes` (SHA-256) and compare to the expected SRI
/// string (`sha256-<base64>`). Only sha256 is supported — other algorithms
/// are silently ignored (the entry has no effect). Returns `Ok(())` when
/// there's no integrity entry for this URL, or when the hash matches.
fn verify_integrity(url: &Url, bytes: &[u8]) -> Result<(), String> {
    let Some(expected) = import_map::integrity_for(url) else {
        return Ok(());
    };
    // SRI format: "<algo>-<base64>". We only enforce sha256; any other
    // algorithm prefix is a no-op (documented limitation — spec also
    // allows sha384/sha512, but sha256 covers the common case).
    let Some((algo, expected_b64)) = expected.split_once('-') else {
        return Err(format!(
            "integrity check failed for {url}: bad SRI string \"{expected}\" (expected \"<algo>-<base64>\")"
        ));
    };
    if algo != "sha256" {
        // Unsupported algorithm — skip rather than fail. Matches the
        // spirit of SRI (browsers ignore unknown algorithms too).
        return Ok(());
    }
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let actual_b64 = base64::engine::general_purpose::STANDARD.encode(digest);
    if actual_b64 != expected_b64 {
        return Err(format!(
            "integrity check failed for {url}: expected sha256-{expected_b64}, got sha256-{actual_b64}"
        ));
    }
    Ok(())
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

    // Internal `ext:` modules bypass the IO/permission path — they're
    // embedded in the binary (see `internal_js`). Only internal modules
    // (whose own URL is `ext:limun/…`) may resolve `ext:` specifiers —
    // user/remote modules cannot `import "ext:limun/…"`.
    if internal_js::is_internal(&specifier) {
        let referrer_is_internal = MODULE_URLS
            .with(|d| {
                d.borrow()
                    .get(&referrer.get_identity_hash().get())
                    .is_some_and(|url| internal_js::is_internal(url.as_str()))
            });
        if !referrer_is_internal {
            throw_syntax(
                scope,
                &format!(
                    "Cannot import \"{specifier}\": `ext:` specifiers are internal and cannot be imported from user code"
                ),
            );
            return None;
        }
        return load_internal(scope, &specifier);
    }

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

/// V8 calls this for every dynamic `import()` expression. We resolve the
/// specifier and dispatch on scheme:
///   - already-cached / `file` / `data` — synchronous load+eval, settle the
///     promise inline (still spec-legal: browsers *may* settle sync).
///   - `http`/`https` — spawn a tokio task to fetch the body; the promise
///     stays pending until `event_loop::resolve_import` settles it after the
///     bridge channel delivers the bytes. Two concurrent dynamic imports of
///     remote modules run concurrently on the multi-thread runtime.
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

    // Internal `ext:` modules via dynamic `import()` — same short-circuit
    // as the static path. Only internal modules (whose own URL is
    // `ext:limun/…`) may resolve `ext:` specifiers — user/remote modules
    // cannot `import("ext:limun/…")`.
    if internal_js::is_internal(&specifier) {
        let referrer_is_internal = resource_name
            .to_string(scope)
            .is_some_and(|s| internal_js::is_internal(&s.to_rust_string_lossy(scope)));
        if !referrer_is_internal {
            let msg = v8::String::new(
                scope,
                &format!(
                    "Cannot import \"{specifier}\": `ext:` specifiers are internal and cannot be imported from user code"
                ),
            )
            .unwrap();
            let exception = v8::Exception::type_error(scope, msg);
            resolver.reject(scope, exception);
            return Some(promise);
        }
        let resolver = v8::PromiseResolver::new(scope)?;
        let promise = resolver.get_promise(scope);
        v8::tc_scope!(let tc, scope);
        match load_internal(tc, &specifier) {
            Some(module) => {
                if module.instantiate_module(tc, resolve_module_callback).is_none() {
                    let msg = exception_text(tc);
                    let s = v8::String::new(tc, &msg).unwrap();
                    let exc = v8::Exception::type_error(tc, s);
                    let _ = resolver.reject(tc, exc);
                } else {
                    let _ = module.evaluate(tc);
                    if module.get_status() == v8::ModuleStatus::Errored {
                        let _ = resolver.reject(tc, module.get_exception());
                    } else if tc.has_caught() {
                        let msg = exception_text(tc);
                        let s = v8::String::new(tc, &msg).unwrap();
                        let exc = v8::Exception::type_error(tc, s);
                        let _ = resolver.reject(tc, exc);
                    } else {
                        let _ = resolver.resolve(tc, module.get_module_namespace());
                    }
                }
            }
            None => {
                let msg = v8::String::new(
                    tc,
                    &format!("cannot resolve \"{specifier}\": not in internal module registry"),
                )
                .unwrap();
                let exc = v8::Exception::type_error(tc, msg);
                let _ = resolver.reject(tc, exc);
            }
        }
        return Some(promise);
    }

    let referrer_url = resource_name
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .and_then(|s| Url::parse(&s).ok())
        .unwrap_or_else(current_dir_url);

    let url = match resolve_specifier(&specifier, &referrer_url) {
        Ok(u) => u,
        Err(msg) => {
            let message = v8::String::new(scope, &msg).unwrap();
            let exception = v8::Exception::type_error(scope, message);
            resolver.reject(scope, exception);
            return Some(promise);
        }
    };

    // Fast path: already compiled (e.g. a static import of the same URL
    // happened earlier). Resolve synchronously with the namespace.
    let cache_key = (url.clone(), kind);
    if REGISTRY.with(|r| r.borrow().get(&cache_key).is_some()) {
        match load_and_run(scope, &url, kind) {
            Ok(namespace) => {
                let _ = resolver.resolve(scope, namespace);
            }
            Err(message) => {
                let message = v8::String::new(scope, &message).unwrap();
                let exception = v8::Exception::type_error(scope, message);
                let _ = resolver.reject(scope, exception);
            }
        }
        return Some(promise);
    }

    match url.scheme() {
        "file" | "data" => {
            // Synchronous load+eval — disk/data: are fast, low priority to
            // async-ify.
            match load_and_run(scope, &url, kind) {
                Ok(namespace) => {
                    let _ = resolver.resolve(scope, namespace);
                }
                Err(message) => {
                    let message = v8::String::new(scope, &message).unwrap();
                    let exception = v8::Exception::error(scope, message);
                    let _ = resolver.reject(scope, exception);
                }
            }
        }
        "http" | "https" => {
            // Permission gate inline — a denied URL rejects immediately.
            if let Err(message) =
                permissions::check(&url, permissions::Mode::Read)
            {
                let message = v8::String::new(scope, &format!("import: {message}")).unwrap();
                let exception = v8::Exception::type_error(scope, message);
                resolver.reject(scope, exception);
                return Some(promise);
            }
            let task_id = state::next_task_id();
            let resolver_global = v8::Global::new(scope, resolver);
            state::PENDING_TASKS.with(|p| {
                p.borrow_mut().insert(
                    task_id,
                    state::PendingTask {
                        resolver: resolver_global,
                        kind: state::PendingKind::Import { url: url.clone(), kind },
                    },
                );
            });
            let url_clone = url.clone();
            runtime::handle().spawn(async move {
                let result = fetch_module_source(&url_clone).await;
                let _ = runtime::tx().send(TaskResult::ImportSource {
                    task_id,
                    url: url_clone,
                    kind,
                    result,
                });
            });
        }
        scheme => {
            let message = v8::String::new(
                scope,
                &format!(
                    "cannot resolve \"{url}\": unsupported scheme \"{scheme}:\" (only file/http/https/data are supported)"
                ),
            )
            .unwrap();
            let exception = v8::Exception::type_error(scope, message);
            resolver.reject(scope, exception);
        }
    }

    Some(promise)
}

/// Plain-Rust async GET for http(s) dynamic `import()`. Runs on a tokio
/// worker thread. Unlike `fetch()` global, a non-2xx is a hard error
/// (modules don't have a "Response with `.ok === false`" representation —
/// the import rejects).
async fn fetch_module_source(url: &Url) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("cannot fetch {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("cannot fetch {url}: HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("cannot read module body from {url}: {e}"))
}

/// Phase-2 of async dynamic import — called from `event_loop::resolve_import`
/// on the V8 thread once the module body arrives over the bridge channel.
/// Compiles, instantiates, and evaluates the module graph and returns its
/// namespace object (or an error string for the rejection).
pub fn finish_dynamic_import_from_source<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    url: &Url,
    kind: ModuleKind,
    source_text: &str,
) -> Result<v8::Local<'s, v8::Value>, String> {
    v8::tc_scope!(let tc, scope);

    let module = load_module_from_source(tc, url, kind, source_text)
        .ok_or_else(|| exception_text(tc))?;

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
