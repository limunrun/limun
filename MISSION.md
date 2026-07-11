# Limun

Goal: making the JS runtime space cleaner. That is the whole reason Limun
exists. If we are not maximizing for this, there is no reason for Limun to
exist — we can just use Bun or Node.js directly. It's the API.

## Principle: minimize the isolate

The runtime should be as small as possible. Everything that can live outside
the runtime, should. Node.js compat, npm package acquisition, package
resolution — none of that belongs in the runtime binary. The runtime loads
plain ESM through an import map; everything else is a userland concern.

## Why web standard API?

Not for browser compatibility — that is a side effect. The reason is that
it's a good standard.

## API

Web-standard API by default. Uses the web-native API even for FS stuff
(https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). If
something exists in the web standard, implement it and use it. If it's
missing for our case, have a global namespace like `Limun` and put things
in it — e.g. `Limun.fs.stat`.

Global space always keeps close to the web standards, only excluding DOM
stuff.

The only breaking changes can happen on `Limun`, which might lose an impl
if it now exists in the web standard and we implement it using the standard.

So `Limun` namespace exists purely for things that don't exist in the web
standard yet.

`Limun` namespace mode is async by default (returns promises), but `Sync`
suffix variants exist.

Things like FS might be spread across the web standard API and `Limun` at
the same time. A `@std/fs` library can combine them into a single library,
which also prevents breaking your code when something in `Limun` later moves
into the standard web globals.

Web URL packages (like `https://esm.sh`) can be checksummed with a `#sha256`
suffix, plus a lock file.

## Permissions

Permission model is simple: **read** and **write**. That's it. No `import`,
`execute`, or other permissions — if you can read it, you can import it
already (eval the read, or use a Worker with a data URL). Creating an illusion
of more permissions than you actually enforce is worse than being honest
about the two you have.

Permissions are URL-based. Everything in the project — imports, file access,
network — is addressed via URLs, so one pattern list covers all IO. See
[IO.md](./IO.md) for the full model.

## Node compat

Node.js compatibility is never ambient and never in the runtime. It's an
external package you install — something like `@limun/node` or `@std/node` —
which wraps `@std` packages to implement the Node API in pure TypeScript.

That package injects Node globals into `globalThis` explicitly:
`injectNodeJs(globalThis)`. Nobody can pollute your scope implicitly; you
have to deliberately pollute it. You can disable global scope protection
from `limun.json`.

See [COMPAT.md](./COMPAT.md) for the full design.

## One realm

Everything runs in a single V8 context (one realm, one set of intrinsics).
No separate `globalThis` per package — that would shatter identity across
the boundary (`arr instanceof Array` breaks, `Error` types don't match,
Buffer brand-checks fail). The Node surface is injected via a source
transform, not via a second realm.

## Runtime

V8 + Rust. Should be easy.