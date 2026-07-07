//! `Limun.hello` — placeholder demo native function. Will go away once the
//! namespace grows real surface area.

pub fn hello(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let arg = args.get(0);
    let name = if arg.is_undefined() {
        "world".to_string()
    } else {
        arg.to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "world".to_string())
    };

    let message = format!("Hello, {name}!");
    let message = v8::String::new(scope, &message).unwrap();
    rv.set(message.into());
}