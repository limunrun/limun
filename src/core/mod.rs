//! Run an entry module to completion in a fresh V8 context.

pub mod event_loop;
pub mod exception;
pub mod import_map;
pub mod import_meta;
pub mod io;
pub mod module;
pub mod rejections;
pub mod resolver;
pub mod state;

use crate::core::exception::report_exception;
use crate::core::import_meta::host_initialize_import_meta_object_callback;
use crate::core::module::{dynamic_import_callback, load_module, resolve_module_callback};
use crate::limun;
use crate::web;
use std::process::ExitCode;
use url::Url;

pub fn execute(isolate: &mut v8::Isolate, entry: &Url) -> ExitCode {
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

    v8::tc_scope!(let tc, scope);

    let Some(module) = load_module(tc, entry) else {
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
