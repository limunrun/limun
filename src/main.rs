use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: limun <file>");
        return ExitCode::from(1);
    }

    let path = &args[1];
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {}: {}", path, e);
            return ExitCode::from(1);
        }
    };

    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    {
        let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
        isolate.set_capture_stack_trace_for_uncaught_exceptions(true, 10);

        v8::scope!(let handle_scope, isolate);
        let context = v8::Context::new(handle_scope, Default::default());
        let scope = &v8::ContextScope::new(handle_scope, context);

        let source = v8::String::new(scope, &source).unwrap();
        let script = match v8::Script::compile(scope, source, None) {
            Some(s) => s,
            None => {
                eprintln!("error: failed to compile script");
                return ExitCode::from(1);
            }
        };

        match script.run(scope) {
            Some(_) => ExitCode::from(0),
            None => ExitCode::from(1),
        }
    }
}