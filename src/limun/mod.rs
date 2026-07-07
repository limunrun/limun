//! Layer 2: the `Limun` namespace — native surface for what the web doesn't
//! cover. Versioned, allowed to break/shrink (per MISSION.md). Installed as a
//! non-enumerable own property of `globalThis`.

mod hello;

/// Attach the `Limun` namespace object to `global` (non-enumerable).
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);

    let limun = v8::Object::new(scope);
    set_fn(scope, limun, "hello", hello::hello);

    crate::web::set_global(scope, global, "Limun", limun.into());
}

fn set_fn(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    target.set(scope, key.into(), func.into());
}