# IO & Permissions

## URLs everywhere

Everything in Limun is addressed by URL. We never use bare paths — we use
URLs, because the protocol is part of the access model. The protocol tells
us where the bytes come from: disk, network, or inline.

When you run `limun` on a project or script, the project root (cwd) comes as
a `file:` URL. This is the base for resolving relative specifiers. Because
the base is already a `file:` URL, you can use relative paths like `./foo.js`
or even `/` (which resolves to the root of the `file:` protocol) without
thinking about it — the URL machinery handles it.

### Supported URL schemes

| Scheme | Source |
|---|---|
| `file:` | local disk |
| `data:` | inline — the bytes are in the specifier itself |
| `http:` / `https:` | network |

That's it. Four schemes, two of which (`http`/`https`) are the same thing.

### What this means in practice

- Reading a file from disk → `file:///path/to/thing`
- Fetching from the internet → `https://example.com/api`
- Reading a data URL → `data:text/plain,hello`
- Importing a module → any of the above, depending on the specifier

All of these go through the same IO layer. The IO layer looks at the
protocol and dispatches accordingly: `file:` reads from disk, `http:`/`https:`
hits the network, `data:` decodes inline. The caller doesn't care about the
mechanism — it says "give me the bytes at this URL" and the IO layer figures
out how.

---

## The IO layer

`src/core/io.rs` is the permission gate for the whole project and the single
place synchronous / module-loading byte IO happens. Every permission decision
is made by one function (`permissions::check`), reached through this module.
Reading a file, importing a module, streaming a module's source — all of it
goes through `io`, and none of it touches bytes without first passing that one
gate.

The one transport that isn't (yet) routed through this file is `fetch()`: it
owns its own async `reqwest` + tokio path in `crate::web::fetch`, because it
predates the async surface here. But it makes its permission decision through
the *same* `permissions::check` — it does not carry a second copy of the gate.
Folding its transport onto `io`'s async variants is the eventual goal; sharing
the gate is the invariant we hold today.

### Why one gate

1. **There is exactly one permission check.** Every function here runs
   `permissions::check` before touching bytes, and it's the only check in the
   project. A second, "mirrored" check living in some other module is a bug,
   not a feature: two checks drift, and the stale one becomes the hole. That's
   why `fetch()` calls *this* gate rather than reimplementing it.

2. **Protocol dispatch is centralized.** The caller doesn't need to know
   whether a URL is `file:`, `https:`, or `data:`. The IO layer inspects the
   scheme and routes to the right handler. This means adding a new scheme (if
   ever needed) is one place, not scattered across the codebase.

3. **It's the foundation for everything.** Module loading, `fetch()`, future
   `Limun.fs.*`, future File System API — all of it sits on top of this. The
   IO layer should expose all low-level operations we might need (read,
   write, stream, open, close) so higher-level APIs build on it rather than
   reimplementing.

### What lives here

The IO layer is a URL-based file system library — a full FS surface, not a
handful of read helpers. Every operation takes a `Url` and dispatches on
scheme internally; the caller never picks a handler.

- `open(url)` — open a streaming `Reader` (implements `std::io::Read`) over
  the URL. `file:` reads from disk, `http:`/`https:` streams the response
  body (decompresses/decodes per headers), `data:` is an in-memory cursor.
- `read(url)` / `read_to_string(url)` — convenience wrappers that buffer
  the full body (what module loading uses).
- `stat(url)` — filesystem metadata (size, is_dir, modified). `file:` only.
- `list_dir(url)` — directory entries as fully-formed `file:` URLs.
- `write_file(url, bytes)` — write bytes. `file:` only; `http:`/`https:`
  is not a file system operation (use `fetch()`), `data:` is a category
  error.
- `resolve(specifier, referrer)` — resolve a relative specifier to an
  absolute URL against the referrer (plain URL resolution, no import map).
- `read_async(url)` / `open_async(url)` — async variants for the future
  `Limun.fs.*` async surface. `read_async` buffers the whole body: `reqwest`
  for `http:`/`https:`, `tokio::fs` for `file:`. `open_async` is `file:`-only
  streaming (`tokio::fs::File`) for now — the network case is served by
  `read_async` buffering until a streaming async reader lands.

Every function that does `file:` or `http`/`https:` IO runs a permission
check against the `io` allowlist *before* dispatching. The scheme in the URL
is the mechanism gate — `"file://**"` covers disk, `"https://**"` covers
network. `data:` URLs are ungated — no IO happens, the bytes are already in
the specifier.

For `file:` URLs, the path is **canonicalized before both the check and the
operation**: symlinks and `..` are resolved first, the `file:` URL is rebuilt
from the canonical path, and *that* is what the permission check matches. So a
symlink can't be granted under one path and then resolve to a target outside
the grant — the check and the read/write always see the same real path. (Not-
yet-existing write targets canonicalize their parent and rejoin the final
component, so a fresh file is still matched by its real location.)

Writing is `file:` only: writing to `http:`/`https:` is rejected before the
permission check (it's not an FS operation — use `fetch()`), and `data:` is
rejected as a category error. Each non-`file:` scheme gets its own rejection
message.

### Scope

This file may grow large enough to warrant its own directory under `core/`
(or even separate from `core/`). That's fine — the point is that it's the one
place the permission gate lives and the one place synchronous IO happens, not
that it's one file. Split when it makes sense, but keep the invariant: exactly
one permission check, and no synchronous raw IO outside this module. (`fetch()`
is the one transport exception, and it still checks through this gate — see
*Why one gate*.)

---

## Permissions

Two permissions: **read** and **write**. That's it.

### Why only read and write

No `import`, `execute`, or other permissions. If you can read it, you can
import it already — even if we added an `import` permission and denied it,
you could still read the file, wrap it in a `data:` URL, and import that.
Creating an illusion of permissions that can be trivially bypassed is worse
than being honest about the two we actually enforce.

### How it works

Permissions are configured in `limun.json`:

```json
{
  "permissions": {
    "io": {
      "default": true,
      "https://evil.com/": { "read": false, "write": false },
      "file://**": { "read": true }
    },
    "legacy": false
  }
}
```

#### `io` — the allowlist

Keys are URL patterns (plus the special `"default"` key). Keys without `://`
are file-path patterns, resolved against cwd into `file:` URLs. The scheme
in the pattern is the mechanism gate — `"file://**"` allows all disk IO,
`"https://**"` allows all network IO. No separate kill switches; the pattern
says what it says.

Values are `true` (read+write), `false` (grants nothing — placeholder), or
`{ read?, write? }`.

Pattern syntax (matched against the serialized URL):
- `*` — any run of characters except `/`
- `?` — one char except `/`
- `**` — any run, `/` included
- trailing `/` — prefix-match sugar (equivalent to `/**`)

For `file:` URLs the path is canonicalized (symlinks and `..` resolved) before
matching, so a pattern is matched against the *real* location, not a symlinked
alias. Write your `file:` patterns against where the bytes actually live.

#### `default` — the fallback grant

The special `"default"` key sets the grant for URLs that don't match any
explicit pattern. It defaults to `false` (deny unmatched — whitelist mode).
Set `"default": true` for blacklist mode: everything allowed except what you
explicitly deny.

Missing `read`/`write` fields in a pattern entry inherit from `default` — so
`"https://api.example.com/": {}` with `"default": true` grants both read and
write, while with `"default": false` (or absent) it grants neither.

Semantics:
1. If any matching pattern explicitly sets this mode to `false` → deny.
   (Explicit deny wins — makes blacklist mode work with `default: true`.)
2. If any matching pattern explicitly sets this mode to `true` → allow.
3. If no matching pattern explicitly sets this mode → fall back to `default`.

The entry script is exempt from the `io` list (you invoked it explicitly —
it would be absurd to deny the very thing you asked to run). Everything
else, including modules imported by the entry script, is subject to the
list.

#### `legacy` — capability opt-in

Boolean (default `false` once a `permissions` key exists) gating the
`Limun.legacy.nodejs.*` surface (Node compat).

#### `data:` URLs

Ungated entirely. The bytes are embedded in the specifier — no IO happens,
and the importing code was itself already granted — so the `io` list
doesn't apply.

### Defaults

No `limun.json` / no `permissions` key: allow-all. This is a config knob for
constraining a deployment, not a zero-trust sandbox by default.

Once a `permissions` key exists: an omitted `io` denies all IO, and `legacy`
stays off.

### No prompting, ever

There is deliberately no interactive prompting. Prompting halts the program
until a human finds the terminal. Anything not granted by `limun.json` is
rejected, immediately and loudly.