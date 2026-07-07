# Limun

Idea of a JS runtime, I will probably start making next year probably?

Goal is making the JS runtime space cleaner. thats the whole reason Limun will
exists. if we are not maximizing for this there is no reason for Limun to
exists, we can just use Bun or Node.js directly. its the API.

## API

Web native API by default.

Uses the web native api even for fs stuff
https://developer.mozilla.org/en-US/docs/Web/API/File_System_API

if something exists in the web standard impl it and use it, if its missing for
our case, have a global namespace like `Limun` and in it have things like
`Limun.fs.stat`.

Global space always keeps close to the web standards, only excluding DOM stuff.

Only breaking change can happen on `Limun`, which might lose an impl if it now
exists in web standard and we impl it using the standard.

so `Limun` namespace exists purely for things that doesnt exists in the web
standard yet.

`Limun` namespace mode is async by default, so it gives promises, but there are
`Sync` suffix variants exists.

so things like fs might be all over the place, like it can have some stuff in
standard web api, and some stuff `Limun` at the same time. so we can have things
like @std/fs which combines them all into a single library, which also prevents
breaking your code when something in `Limun` later moves into the standard web
globals.

web url packages, like https://esm.sh, we can checksum the version with
`#sha256` suffix. but also have a lock file.

deno like permission system, and also including worker permissions. it allows
isolated code running, and can be really useful for things like plugins which
can use wasm internally and we dont even need to know.

## Node Compat

First im gonna talk about nodejs like coding inside the existing codebase, not
gonna talk about importing nodejs packages.

so we can have a `Limun.legacy.require()` in the codebase.

then we can have big wrapper library that impls nodejs api in pure typescript by
wrapping @std packages.

it injects the nodejs globals to `globalThis` like this
`injectNodeJs(globalThis)`. this is a seperate package you install. something
like `@limun/node` or since it uses `@std` package it can be `@std/node` or
something.

so then you can write code with nodejs apis.

---

so next thing is nodejs/npm packages.

for these we can host a website similar to https://esm.sh but this would
basically convert `npm` packages into limun code that is using `@std/node` along
with its dependecies. it adds a `limun.json` file and stuff, transforms imports.
transforms entry points to use injections etc. it can be at https://limun.run or
https://limun.space we have both.

another thing we can do use, making a cli package that allows use to `add` npm
packages which auto transforms them. without needing to maintain a hosted site.
But hosted site is cool, because it would allow any web app to use nodejs
packages. using old things like `Buffer` and etc. we can do both.

---

one important thing here is limun js should have a seperete instance of
`globalThis` for every remote package, so they dont inject and override
each-other's globals. unless they allow it in `limun.json`.

thats the reason we do `injectNodeJs(globalThis)`. nobody can pollute your scope
implicitly. so you have to deliberately pollute your scope. of course you can
disable global scope protection from limun.js again.

## Runtime

Probably will use V8, probably will use rust.

---

Should be easy.
