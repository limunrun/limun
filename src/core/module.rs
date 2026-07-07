//! Module loading & resolution — the V8 module-resolution callback IS the loader.

use crate::core::resolver::resolve_specifier;
use crate::core::state::{MODULE_DIRS, REGISTRY};
use std::path::{Path, PathBuf};
use std::{env, fs};

/// Compile (or fetch from registry) the module at `path`.
/// On failure an exception is scheduled in the isolate and None is returned.
pub fn load_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    path: &Path,
) -> Option<v8::Local<'s, v8::Module>> {
    // Dedup: the same file must yield the same module instance.
    let cached = REGISTRY.with(|r| r.borrow().get(path).cloned());
    if let Some(global) = cached {
        return Some(v8::Local::new(scope, &global));
    }

    let source_text = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            throw(scope, &format!("cannot read module {}: {e}", path.display()));
            return None;
        }
    };

    let resource_name = v8::String::new(scope, &path.display().to_string()).unwrap();
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
    REGISTRY.with(|r| r.borrow_mut().insert(path.to_path_buf(), global));

    let dir = path.parent().unwrap_or(Path::new("/")).to_path_buf();
    MODULE_DIRS.with(|d| {
        d.borrow_mut()
            .insert(module.get_identity_hash().get(), dir)
    });

    Some(module)
}

/// V8 calls this for every `import` specifier while instantiating the graph.
pub fn resolve_module_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);

    let specifier = specifier.to_rust_string_lossy(scope);

    let referrer_dir = MODULE_DIRS
        .with(|d| d.borrow().get(&referrer.get_identity_hash().get()).cloned())
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    match resolve_specifier(&specifier, &referrer_dir) {
        Ok(path) => load_module(scope, &path),
        Err(msg) => {
            throw(scope, &msg);
            None
        }
    }
}

pub fn throw(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
}