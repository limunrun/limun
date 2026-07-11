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

`src/core/io.rs` is the single choke-point for all byte-level operations in
the entire project. Every IO operation — reading a file, fetching a URL,
importing a module, streaming a response — goes through this file. No part of
the project does raw IO; everything calls through `io`.

### Why one choke-point

1. **Permissions are global.** Every function in this file does a permission
   check before touching bytes. Because all IO flows through here, there is
   no way to bypass the permission system — no back door, no raw `std::fs`
   call hidden in some other module that forgets to check. One gate, checked
   every time.

2. **Protocol dispatch is centralized.** The caller doesn't need to know
   whether a URL is `file:`, `https:`, or `data:`. The IO layer inspects the
   scheme and routes to the right handler. This means adding a new scheme
   (if ever needed) is one place, not scattered across the codebase.

3. **It's the foundation for everything.** Module loading, `fetch()`, future
   `Limun.fs.*`, future File System API — all of it sits on top of this. The
   IO layer should expose all low-level operations we might need (read,
   write, stream, open, close) so higher-level APIs build on it rather than
   reimplementing.

### What lives here

- `read_file(path)` — read a local file as text
- `fetch(url)` — fetch a remote URL (blocking, for the sync import path)
- `decode_data_url(url)` — decode a `data:` URL (no permission check needed;
  the bytes are in the specifier)
- Future: streaming reads, writes, file open/close, etc.

Every function that does `file:` or `http`/`https` IO runs a permission check
against the `io` allowlist. The scheme in the URL is the mechanism gate —
`"file://**"` covers disk, `"https://**"` covers network. `data:` URLs are
ungated — no IO happens, the bytes are already in the specifier.

### Scope

This file may grow large enough to warrant its own directory under `core/`
(or even separate from `core/`). That's fine — the point is that it's the one
place IO happens, not that it's one file. Split when it makes sense, but
keep the choke-point property: nothing outside this module does raw IO.

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