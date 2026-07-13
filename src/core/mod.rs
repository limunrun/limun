//! Run an entry module to completion in a fresh V8 context.

pub mod bridge;
pub mod event_loop;
pub mod exception;
pub mod import_map;
pub mod import_meta;
pub mod internal_js;
pub mod io;
pub mod module;
pub mod ops;
pub mod permissions;
pub mod rejections;
pub mod resolver;
pub mod runtime;
pub mod state;

use crate::core::exception::report_exception;
use crate::core::import_meta::host_initialize_import_meta_object_callback;
use crate::core::module::{
    ModuleKind, dynamic_import_callback, load_module, resolve_module_callback,
};
use crate::limun;
use crate::web;
use std::process::ExitCode;
use url::Url;

pub fn execute(isolate: &mut v8::Isolate, entry: &Url) -> ExitCode {
    // Drive microtasks explicitly: the event loop performs the checkpoints
    // (after top-level evaluation and after each timer/fetch/import
    // settlement). With the default `Auto` policy V8 would *also* drain at
    // every JS->C++ return, double-running the queue and making it ambiguous
    // whose checkpoint ran a given reaction; `Explicit` makes the loop the
    // single authority. (This is the same choice Deno/Node make.)
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    rejections::install(isolate);
    isolate.set_host_import_module_dynamically_callback(dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(
        host_initialize_import_meta_object_callback,
    );

    v8::scope!(let scope, isolate);

    let context = v8::Context::new(scope, Default::default());
    let mut context_scope = v8::ContextScope::new(scope, context);
    v8::scope!(let scope, &mut context_scope);

    web::install(scope, context);
    limun::install(scope, context);
    // Install the `__limunOps` namespace before the internal JS modules
    // evaluate — primordials/infra modules call ops at top level.
    ops::install(scope, context);

    // Bootstrap the internal JS modules. Order is the registry order
    // (see `internal_js::REGISTRY`): primordials first, then infra modules,
    // then the proof module. Each is compiled as an ES module and
    // evaluated before the user's entry module. They bypass `core::io` and
    // `core::permissions` — internal modules are trusted and built into the
    // binary.
    v8::tc_scope!(let tc, scope);

    for m in internal_js::iter() {
        let Some(url) = internal_js::specifier_url(m.specifier) else {
            eprintln!("limun: bad internal specifier \"{}\"", m.specifier);
            return ExitCode::FAILURE;
        };
        let Some(module) = module::load_module_from_source(
            tc,
            &url,
            ModuleKind::JavaScript,
            m.source,
        ) else {
            report_exception(tc, m.specifier);
            return ExitCode::FAILURE;
        };
        if module
            .instantiate_module(tc, resolve_module_callback)
            .is_none()
        {
            report_exception(tc, m.specifier);
            return ExitCode::FAILURE;
        }
        let _completion = module.evaluate(tc);
        if module.get_status() == v8::ModuleStatus::Errored {
            let exception = module.get_exception();
            let text = exception
                .to_string(tc)
                .map(|s| s.to_rust_string_lossy(tc))
                .unwrap_or_else(|| "<unprintable exception>".to_string());
            eprintln!("limun: {}: {text}", m.specifier);
            return ExitCode::FAILURE;
        }
        if tc.has_caught() {
            report_exception(tc, m.specifier);
            return ExitCode::FAILURE;
        }
    }

    // Cache the JS-defined `DOMException` constructor for Rust callers
    // (`throw_dom_exception`, `AbortSignal`'s default abort reason). The
    // class was installed on `globalThis` by `ext:limun/01_dom_exception.js`
    // in the loop above; stash a `v8::Global` so `new_instance` can mint
    // instances without a `globalThis` lookup.
    web::dom_exception::cache_ctor(tc);

    // Cache the JS-defined `createFixedReadableStream` factory for Rust
    // callers (`Response.body` / `Request.body` / `Blob.stream()`). The
    // factory was installed on `globalThis.__bootstrap` by
    // `ext:limun/06_streams.js` in the loop above; stash a `v8::Global` so
    // `streams::new_fixed_stream` can mint fixed (fully-buffered)
    // streams without a `globalThis` lookup.
    web::streams::cache_factory(tc);

    // The entry point is always plain JS — import attributes only make
    // sense on an `import` statement/expression, and there's no such thing
    // for the script you hand to `limun` on the command line.
    let Some(module) = load_module(tc, entry, ModuleKind::JavaScript) else {
        report_exception(tc, entry.as_str());
        return ExitCode::FAILURE;
    };

    if module
        .instantiate_module(tc, resolve_module_callback)
        .is_none()
    {
        report_exception(tc, entry.as_str());
        return ExitCode::FAILURE;
    }

    let _completion = module.evaluate(tc);

    if module.get_status() == v8::ModuleStatus::Errored {
        let exception = module.get_exception();
        let text = exception
            .to_string(tc)
            .map(|s| s.to_rust_string_lossy(tc))
            .unwrap_or_else(|| "<unprintable exception>".to_string());
        eprintln!("limun: {entry}: {text}");
        return ExitCode::FAILURE;
    }

    if tc.has_caught() {
        report_exception(tc, entry.as_str());
        return ExitCode::FAILURE;
    }

    // Drive pending timers/microtasks (e.g. top-level await on a setTimeout)
    // to completion. Runs until no timers are left scheduled.
    event_loop::run(tc);

    if tc.has_caught() {
        report_exception(tc, entry.as_str());
        return ExitCode::FAILURE;
    }

    // Anything still rejected with no `.catch()` once the loop's idle is a
    // failure, matching Node/Deno/browser devtools behavior.
    if rejections::report_unhandled(tc) {
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
