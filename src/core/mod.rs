//! Run an entry module to completion in a fresh V8 context.

pub mod bridge;
pub mod event_loop;
pub mod exception;
pub mod external_refs;
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

    // The isolate was created from a startup snapshot that already contains
    // the bootstrapped context: web globals, `Limun`, `__limunOps`, and all
    // evaluated internal JS modules. Restoring the default context re-creates
    // the global proxy and the heap state captured in the snapshot.
    let context = v8::Context::new(scope, Default::default());
    let mut context_scope = v8::ContextScope::new(scope, context);
    v8::scope!(let scope, &mut context_scope);

    v8::tc_scope!(let tc, scope);

    // The snapshot captures the JS-defined `DOMException` constructor, but
    // the Rust-side `v8::Global` cache is per-process state. Re-cache it now
    // so Rust callers can mint instances during this run.
    crate::web::dom_exception::cache_ctor(tc);

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
