//! Build-time snapshot generator.
//!
//! Produces a V8 startup snapshot that captures the fully bootstrapped context:
//! web globals, the `Limun` namespace, `__limunOps`, and all evaluated internal
//! JS modules. The resulting blob is embedded in the main binary at compile
//! time.

use limun::core;
use limun::limun as limun_mod;
use limun::web;
use std::fs;

fn main() {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    let external_refs = core::external_refs::get();
    let params = v8::CreateParams::default()
        .external_references(external_refs.into());

    let mut snapshot_creator = v8::Isolate::snapshot_creator(
        Some(external_refs.into()),
        Some(params),
    );

    {
        v8::scope!(let scope, &mut snapshot_creator);

        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);

        web::install(scope, context);
        limun_mod::install(scope, context);
        // Install the `__limunOps` namespace before the internal JS modules
        // evaluate — primordials/infra modules call ops at top level.
        core::ops::install(scope, context);

        // Bootstrap the internal JS modules. Order is the registry order
        // (see `internal_js::REGISTRY`): primordials first, then infra
        // modules, then the proof module. Each is compiled as an ES module
        // and evaluated before the user's entry module.
        {
            v8::tc_scope!(let tc, scope);

            for m in core::internal_js::iter() {
                let Some(url) = core::internal_js::specifier_url(m.specifier) else {
                    eprintln!("limun: bad internal specifier \"{}\"", m.specifier);
                    std::process::exit(1);
                };
                let Some(module) = core::module::load_module_from_source(
                    tc,
                    &url,
                    core::module::ModuleKind::JavaScript,
                    m.source,
                ) else {
                    eprintln!("limun: failed to compile {}", m.specifier);
                    std::process::exit(1);
                };
                if module
                    .instantiate_module(tc, core::module::resolve_module_callback)
                    .is_none()
                {
                    eprintln!("limun: failed to instantiate {}", m.specifier);
                    std::process::exit(1);
                }
                let _completion = module.evaluate(tc);
                if module.get_status() == v8::ModuleStatus::Errored {
                    let exception = module.get_exception();
                    let text = exception
                        .to_string(tc)
                        .map(|s| s.to_rust_string_lossy(tc))
                        .unwrap_or_else(|| "<unprintable exception>".to_string());
                    eprintln!("limun: {}: {text}", m.specifier);
                    std::process::exit(1);
                }
                if tc.has_caught() {
                    eprintln!("limun: exception while evaluating {}", m.specifier);
                    std::process::exit(1);
                }
            }

            // Cache the JS-defined `DOMException` constructor for Rust callers.
            // We clear the cache immediately because `v8::Global` handles are
            // not serializable in the snapshot blob.
            web::dom_exception::cache_ctor(tc);
            web::dom_exception::clear_cache();
        }

        scope.set_default_context(context);
    }

    // Drop the Rust-side module registry before serializing. The module
    // objects themselves are not part of the snapshot — only the side effects
    // installed on `globalThis` are preserved.
    core::state::clear_module_state();

    let Some(blob) = snapshot_creator.create_blob(v8::FunctionCodeHandling::Keep) else {
        eprintln!("limun: failed to create snapshot blob");
        std::process::exit(1);
    };

    fs::write("src/snapshot.bin", blob.as_ref()).expect("failed to write snapshot.bin");
    println!("snapshot.bin written ({} bytes)", blob.len());

    // Globals must drop while the isolate is still alive.
    core::state::clear_module_state();

    unsafe {
        v8::V8::dispose();
    }
    v8::V8::dispose_platform();
}
