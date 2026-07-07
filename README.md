# limun

Web-standard JS runtime. Node.js is a guest, not a landlord.

Minimal V8 embed in Rust: real ESM modules with import maps, an event loop
(so `setTimeout`/`setInterval`/`await` actually work), the full WHATWG
Console Standard, and the web-standard globals (`self`, `alert`, `confirm`,
`prompt`). `Limun.hello` is the seed of the non-standard native namespace.

## Layout

```
src/main.rs                  entry point, V8 boot/teardown
src/core/                    engine internals (no JS-facing surface)
  mod.rs                     execute(): module graph -> eval -> event loop
  module.rs                  module loading & the V8 resolution callback
  resolver.rs                specifier -> file path (import map aware)
  import_map.rs               reads ./limun.json
  event_loop.rs               timer wheel + microtask draining
  rejections.rs                unhandled promise rejection reporting
  exception.rs                uncaught exception reporting
  state.rs                    thread-local module/timer/rejection registries
src/web/                     Layer 1 — web-standard globals on globalThis
  console/                    WHATWG Console Standard (all 18 methods)
  prompt.rs                    alert/confirm/prompt (Deno's terminal model)
  timers.rs                    setTimeout/setInterval/clearTimeout/
                                clearInterval/queueMicrotask
src/limun/                   Layer 2 — Limun namespace (non-standard)
  hello.rs                     Limun.hello, template for future ops
examples/                     smoke-test scripts
limun.json                    import map example
.devcontainer/                docker/podman dev environment
```

## Build & run

Inside the devcontainer (or any machine with stable Rust):

```sh
cargo run -- examples/main.js
```

First build downloads a prebuilt static libv8 (~100 MiB) from the rusty_v8
GitHub releases and takes a few minutes. After that, incremental builds are
normal Rust speed.

## Devcontainer

### docker

Open the folder in VS Code → "Reopen in Container". Nothing else needed.

### podman

Either set VS Code's engine once:

```jsonc
// VS Code settings.json
{ "dev.containers.dockerPath": "podman" }
```

or use the devcontainer CLI directly:

```sh
devcontainer up --workspace-folder . --docker-path podman
devcontainer exec --workspace-folder . --docker-path podman cargo run -- examples/main.js
```

Rootless podman: if the workspace mount comes up with wrong ownership,
uncomment the `--userns=keep-id` line in `.devcontainer/devcontainer.json`
(podman-only flag, remove for docker).

## Architecture (where things go as this grows)

1. **Web globals** (`src/web/`) — frozen, standards only. `console`, `self`,
   `alert`/`confirm`/`prompt`, and the timer globals are the seed; `fetch`,
   `URL`, streams etc. arrive here and never break.
2. **`Limun` namespace** (`src/limun/`) — native surface for what the web
   doesn't cover. Versioned, allowed to break and shrink. `Limun.hello`
   lives here as the template for every future op.
3. **`@std/*` packages** — userland stability layer wrapping 1+2. Not part
   of this binary.

`src/core/` is neither of these — it's engine plumbing (module loading, the
event loop, exception/rejection reporting) that `web`/`limun` sit on top of
but that defines no JS-facing global itself.

Node compat, when it comes, is a ported-package concern (separate context,
membrane at the boundary) — never ambient, never in these globals.

## Modules & import maps

Real ESM via V8's module machinery. Relative/absolute specifiers resolve
against the importing module's directory. Bare specifiers are resolved
against `./limun.json`'s `"imports"` map (exact keys and `"prefix/"` keys,
per the web-standard import map format) — anything else fails loud instead
of silently misresolving.

## Event loop

`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/`queueMicrotask`
are backed by a minimal single-threaded timer wheel in `core::event_loop`
(sleeps until the next deadline, no busy-waiting). `await`/`Promise`
themselves need no runtime code — that's all V8; the event loop's only job
is firing due timers and telling V8 when to drain its microtask queue.

Promises that reject with no handler are reported (`Uncaught (in promise)
...` to stderr) and fail the run, matching Node/Deno/browser devtools —
V8 itself does nothing by default.

## Adding a native function

Copy the `hello` pattern in `src/limun/hello.rs`:

1. Write a `fn(scope, args, rv)` callback.
2. Register it in `src/limun/mod.rs`'s `install` with
   `set_fn(scope, limun, "name", callback)`.

That's the whole op system for now. When this gets real, callbacks move to
a registry and the `Limun` object gets built from it, but this is the right
size today.
