//! Layer 2: the `Limun` namespace — native surface for what the web doesn't
//! cover. Versioned, allowed to break/shrink (per MISSION.md). Installed as a
//! non-enumerable own property of `globalThis`.

mod hello;

macro_rules! limun_entries {
    ($(($name:expr, $callback:path)),* $(,)?) => {
        /// Attach the `Limun` namespace object to `global` (non-enumerable).
        pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
            let global = context.global(scope);

            let limun = v8::Object::new(scope);
            $(
                set_fn(scope, limun, $name, $callback);
            )*

            crate::web::set_global(scope, global, "Limun", limun.into());
        }

        /// Function callbacks that must be registered as external references
        /// so the snapshot can restore the native `Limun` functions.
        pub fn external_refs() -> Vec<v8::ExternalReference> {
            use v8::MapFnTo;
            vec![
                $(v8::ExternalReference { function: $callback.map_fn_to() }),*,
            ]
        }
    };
}

limun_entries! {
    ("hello", hello::hello),
}

fn set_fn(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let callback = callback.map_fn_to();
    let fn_template = v8::FunctionTemplate::builder_raw(callback).build(scope);
    let func = fn_template.get_function(scope).unwrap();
    target.set(scope, key.into(), func.into());
}