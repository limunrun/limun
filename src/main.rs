//! limun — minimal V8 embed with ES modules.
//!
//! Layer model (where things will live as this grows):
//!   1. Web globals   — frozen, standards only. (console)
//!   2. `Limun` ns    — native surface for what the web doesn't cover.
//!                      Versioned, allowed to break/shrink. (`Limun.hello`)
//!   3. `@std/*`      — userland stability layer wrapping 1+2. (packages, not here)
//!
//! Modules: real ESM via V8's module machinery. The resolver is ours — this
//! is where limun's identity lives (later: #sha256, https, port-on-import).
//! For now: relative/absolute file paths + web-standard import maps read
//! from ./limun.json ("imports": exact keys and "prefix/" keys). Anything
//! else fails loud.

mod core;
mod limun;
mod web;

use std::{env, fs, process::ExitCode};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let Some(entry) = args.get(1) else {
        eprintln!("usage: limun <file.js>");
        return ExitCode::FAILURE;
    };

    let entry_path = match fs::canonicalize(entry) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("limun: cannot open {entry}: {e}");
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = core::import_map::load_import_map() {
        eprintln!("limun: limun.json: {e}");
        return ExitCode::FAILURE;
    }

    // --- V8 boot (once per process) ---
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    let exit = {
        let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
        let exit = core::execute(isolate, &entry_path);
        // Globals must drop while the isolate is still alive.
        core::state::clear_module_state();
        exit
    };

    // --- V8 teardown ---
    unsafe {
        v8::V8::dispose();
    }
    v8::V8::dispose_platform();

    exit
}