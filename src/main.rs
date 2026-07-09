//! limun — minimal V8 embed with ES modules.
//!
//! Layer model (where things will live as this grows):
//!   1. Web globals   — frozen, standards only. (console)
//!   2. `Limun` ns    — native surface for what the web doesn't cover.
//!                      Versioned, allowed to break/shrink. (`Limun.hello`)
//!   3. `@std/*`      — userland stability layer wrapping 1+2. (packages, not here)
//!
//! Modules: real ESM via V8's module machinery, both static and dynamic
//! `import()`. Every module has a URL identity (`file://` local, `https://`
//! remote) so relative imports resolve the same way regardless of where the
//! importing module came from. The resolver is ours — this is where
//! limun's identity lives (later: #sha256 checksums, a lock file). Web-
//! standard import maps (`imports`/`scopes`/`integrity`) are read from
//! ./limun.json. Anything unresolvable fails loud.

mod core;
mod limun;
mod web;

use std::{env, fs, process::ExitCode};
use url::Url;

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

    let entry_url = match Url::from_file_path(&entry_path) {
        Ok(u) => u,
        Err(()) => {
            eprintln!("limun: cannot form a URL from {}", entry_path.display());
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = core::import_map::load_import_map() {
        eprintln!("limun: limun.json: {e}");
        return ExitCode::FAILURE;
    }

    if let Err(e) = core::permissions::load() {
        eprintln!("limun: limun.json: {e}");
        return ExitCode::FAILURE;
    }
    // The entry script is exempt from the `import` kill switch (the user
    // invoked it explicitly) but still subject to the `io` pattern list.
    core::permissions::set_entry(entry_url.clone());

    // --- tokio runtime boot (before V8 init) ---
    // Multi-thread so HTTP fetch tasks run concurrently while the V8 isolate
    // stays single-threaded on this (the main) thread. The V8 thread never
    // enters the runtime — it only holds a Handle and spawns onto it.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("failed to start tokio runtime");
    let handle = rt.handle().clone();
    let rx = core::runtime::init(handle);
    core::event_loop::set_bridge_rx(rx);

    // --- V8 boot (once per process) ---
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    let exit = {
        let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
        let exit = core::execute(isolate, &entry_url);
        // Globals must drop while the isolate is still alive.
        core::state::clear_module_state();
        exit
    };

    // --- V8 teardown (before dropping the tokio runtime — worker threads
    // may hold `Handle` clones, which is fine; the runtime itself is joined
    // when `rt` drops below) ---
    unsafe {
        v8::V8::dispose();
    }
    v8::V8::dispose_platform();
    drop(rt);

    exit
}