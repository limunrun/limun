# Limun

Goal: making the JS runtime space cleaner. That is the whole reason Limun
exists. If we are not maximizing for this, there is no reason for Limun to
exist.

## Why web standard API?

Not for browser compatibility — that is a side effect. The reason is that
it's a good standard.

## IO

In Rust we should build an IO library, and it should have everything FS related, and also everything Network related basically.

So basically IO handles everything URL related.

These are all will be the primitive IO stuff we will use for everything in here, so permissions are applied correctly to every operation.

## Limun namespace

Every base native operation will be defined under the Limun namespace.

And everything under Limun namespace has their own scope. Such as `Limun.fs`

And everything under limun namespace is a native method.

Everything else being implemented is pure js like Deno does, they just wrap the `Limun` namespace for native operations.

And later we will also build an `@std` package that will let you use these in a nicer way. Similar to JSR:@std.

So everything on `Limun` namespace can break or change. but Web API and @std wrapping is doesnt break that often.

## `Limun.compat`

Everything we will add for compability will live under this scope.

Such as `Limun.compat.CommonJS.*`, `Limun.compat.NodeJS.*`

And for example CommonJS compability layer will transform CommonJS code during AOT, similar to `esm.sh` and use these primitive compat features.

## Web API

Limun will support every non-DOM web/browser API natively. All listed in [TODO.md](TODO.md).

This includes things like File System API which should open a file picker dialog, that lets you read files without getting permission from it in the `limun.json` similar to how browsers do it.

This also includes things like Geo Location, Sensors, Web GPU, Canvas, Share, Vibrate, Bluetooh, etc...

And things like `fetch()` API will also support `file:` URLs under the WebDAV standard.

Similarly we also support any ESM import such as `http:` or `file:` or `data:` URL based imports basically.

These can also be used for fs operations, or fetch, as i mentioned.

We also support import maps in `limun.json`, the same standard as on the web.

Current base is the CWD if the code is being run from CLI as `limun run ./app/main.ts`.

But if the app is compiled and standalone, its the base URL is the executation path.

And also includes LocalStorage, IDB, and stuff, which we can define the base location of in `limun.json` probably.

## Permissions

Everything is isolated with permissions and even more than browser basically since we limit fetch a lot too.

And unlike Deno, we dont have prompts for denied permissions, if permission is not defined, it fails.

So everything the an app can do should be defined in permissions in `limun.json` without that it has no permissions to fetch, or io or anything else.

IO permissions are a little different than Deno, because we know if you can read something you can import it or execute it already via eval or anything else. So only IO permission we have will be based on read and write.

Example:

```jsonc
{
    "permissions": {
        "default": true | false, // the default permissions for stuff that are not defined.
        "io": {
            "default": false, // default can be defined in every scope for ease and DX.
            "file://**": { read: true }, // Glob based
            "./data": true, // Based on base URL.
            "https://esm.sh": { read: true },
            "file:///etc": false, // bottom ones overwrite the top ones.
        },
        "io": false | true, // also posibble for each scope. 
        "sensors": {
            // sensors and geo location.
        },
        "process": {
            // process info and process management, getting current processes, or kill, exit etc...
        }
    },
    "permissions": true | false // also possible.
}
```

Another thing is, URLs defined in import map have read permission by default, since we typed it in `limun.json`.

Workers have their own permissions similar to Deno. But with some additions.

For example worker `default` can also be inherit by default, so `true | false | "inherit"`, so like:

```ts
new Worker(new URL("./worker.ts", import.meta.url), { limun: { permissions: "inherit" } })
```

BTW, its inherit by default anyway. It is the same interface as permissoins in `limun.json` but `default` can be `"inherit"` as well.

Also Worker permissions can't be wider than the parent's permissions.

But another thing it has is asking parent for permissions live.

```ts
new Worker(new URL("./worker.ts", import.meta.url), { limun: { permissionCallback: (event) => Promise<`${"deny" | "allow"} ${"always" | "once"}`> } })
```

This callback happens automatially when child worker tries to do something its not allowed to do.

So parent can prompt it on UI or terminal, or decide it based on something else automatically, all user code.

It runs sync on the child worker, but async on the parent.

`"always"` means always in this session only. So imagine a child is spamming the permissions, we can say `"always deny"`

Persistent permissions for children should be handled by the user code.

## Custom protocols

Limun only impl `file:`, `http(s):`, `ws(s):`, `data:`, `blob:` and etc.

It doesn't have `npm:`, `jsr:` or similar custom protocols.

But we allow custom user code to impl these, probably can be defined in `limun.json`.

And custom protocol packages, can handle the compat AOT stuff basically. Wrapping `Limun.compat.*` methods, and stuff.

But important thing here is these are not for packages only.

So user code can also define things like `stratum+tpc:`, `ipfs:`, and etc.

All handled as custom IO URLs, and can have defined IO permissions.
