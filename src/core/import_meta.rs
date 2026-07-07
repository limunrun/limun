//! `import.meta` — per-module metadata (WHATWG HTML). `url` is the actual
//! spec requirement; `resolve(specifier)` is a common addition (Node,
//! browsers) that we get almost for free by reusing `core::resolver` — it
//! resolves exactly like a static `import` would, relative to this module.

use crate::core::module::{current_dir_url, throw};
use crate::core::resolver::resolve_specifier;
use crate::core::state::MODULE_URLS;
use url::Url;

/// V8 calls this the first time `import.meta` is accessed in a module.
pub extern "C" fn host_initialize_import_meta_object_callback(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    v8::callback_scope!(unsafe scope, context);

    let url = MODULE_URLS
        .with(|d| {
            d.borrow()
                .get(&module.get_identity_hash().get())
                .cloned()
        })
        .unwrap_or_else(current_dir_url);

    let url_key = v8::String::new(scope, "url").unwrap();
    let url_value = v8::String::new(scope, url.as_str()).unwrap();
    meta.create_data_property(scope, url_key.into(), url_value.into());

    // Stash this module's URL as the function's associated data so
    // `resolve(specifier)` knows what to resolve relative to.
    let resolve_key = v8::String::new(scope, "resolve").unwrap();
    let referrer_data = v8::String::new(scope, url.as_str()).unwrap();
    let resolve_fn = v8::Function::builder(resolve)
        .data(referrer_data.into())
        .build(scope)
        .unwrap();
    meta.create_data_property(scope, resolve_key.into(), resolve_fn.into());
}

/// `import.meta.resolve(specifier): string` — throws on an unresolvable
/// specifier, same as a static/dynamic import would.
fn resolve(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let referrer = args
        .data()
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .and_then(|s| Url::parse(&s).ok())
        .unwrap_or_else(current_dir_url);

    let specifier = args
        .get(0)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    match resolve_specifier(&specifier, &referrer) {
        Ok(url) => rv.set(v8::String::new(scope, url.as_str()).unwrap().into()),
        Err(msg) => throw(scope, &msg),
    }
}
