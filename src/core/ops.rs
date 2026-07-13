//! Internal op registration — flat Rust functions callable from internal JS.
//!
//! Ops are plain `v8::FunctionCallback`s registered under string names on a
//! `globalThis.__limunOps` object. Internal JS calls them as
//! `__limunOps.op_name(args…)`. The op does native work and returns a flat
//! V8 value (string/number/ArrayBuffer) — no structured V8 objects cross
//! this boundary.
//!
//! This is deliberately *not* Deno's op2 infrastructure. There's no codegen,
//! no async ops, no resource table, no `OpState`. Each op is a bare
//! `FunctionCallback` registered by name in `install`. When a later phase
//! needs richer ops (async, resources), this is the place to grow — but
//! the surface stays "register a fn under a name" for now.
//!
//! Ops are internal-only: `__limunOps` is installed as a non-enumerable
//! own property of `globalThis` and is intended for use by the embedded
//! `ext:limun/*.js` modules, not user code. User code reaching into
//! `__limunOps` is unsupported (not enforced — it's the same global object
//! — but the contract is "internal APIs may change without notice").

/// Install the `__limunOps` namespace on `globalThis` with every registered
/// op attached. Called once from `core::mod::execute`, before internal JS
/// modules evaluate (so primordials/infra modules can call ops during
/// their top-level evaluation).
pub fn install(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    let global = context.global(scope);
    let ops = v8::Object::new(scope);

    set_fn(scope, ops, "op_test_add", op_test_add);

    crate::web::set_global(scope, global, "__limunOps", ops.into());
}

/// `op_test_add(a: number, b: number) -> number` — the proof op. Returns
/// `a + b` as a Number. Exists only to prove the op-registration path
/// works end-to-end (see `ext:limun/99_test.js`).
fn op_test_add(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let a = args.get(0).integer_value(scope).unwrap_or(0);
    let b = args.get(1).integer_value(scope).unwrap_or(0);
    let sum = v8::Number::new(scope, (a + b) as f64);
    rv.set(sum.into());
}

/// Attach a native function to `target` under `name`. Local copy of
/// `web::mod::set_fn` — kept here so `ops` doesn't reach into `web`'s
/// private helpers (that `set_fn` is `pub(crate)`-private to `web`).
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