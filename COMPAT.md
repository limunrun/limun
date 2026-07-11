# Node.js Compatibility

Node.js compat is **not in the runtime**. It's an external package concern.
This document captures the design: how Node compat works, what the moving
parts are, and the casualties.

---

## 1. What "Node support" actually is

Node compat is not one thing, and not just globals. Sort by *how it's
reached*:

1. **Globals** — real properties on `globalThis`: `process`, `Buffer`,
   `global`, `setImmediate`, `clearImmediate`.
2. **Module-scoped locals** — injected per-module, not on `globalThis`:
   `require`, `module`, `exports`, `__dirname`, `__filename`. Part of the
   CJS format, not the global scope.
3. **Importable modules** (`node:x`) — `node:fs`, `node:path`, `node:crypto`,
   etc., reached by import specifier.
4. **Invisible machinery** — the module resolver and CJS/ESM loader. No JS
   surface; can't be a global because it isn't a JS value.
5. **Semantic/behavioral compat** — `process.nextTick` ordering vs
   microtasks, event-loop phase emulation, `process.version`, `ERR_*`
   codes, stream backpressure semantics.

`process` and `Buffer` live in both (1) and (3): a global form and a
`node:process` / `node:buffer` import form. `crypto` is a decoy — global
`crypto` is Web Crypto (a web standard, stays regardless); `node:crypto` is
the Node import, backed by native ops. Same word, unrelated things.

---

## 2. One realm, not two

The intuitive design — a clean Limun `globalThis` and a Node `globalThis`
— hits the hardest problem in V8 embedding.

In V8, `globalThis` is per-Context. Two globalThis means two `v8::Context`s
in the same isolate, and each Context gets its own copy of the intrinsics —
its own `Object`, `Array`, `Function`, `Promise`, `Error`, `ArrayBuffer`,
`%TypedArray%`, `Object.prototype`, everything. A spread copies named globals
across but cannot touch what the engine uses for literals: a `[]` in realm B
is a realm-B `Array` with realm-B `Array.prototype`, no matter what you
spread onto its global.

Every value crossing the boundary breaks identity:

- `arr instanceof Array` → false
- a `Buffer` from the Node realm fails `buf instanceof Uint8Array` against
  the other realm's `Uint8Array`, and every Web API brand-check rejects it
- `e instanceof TypeError` → false across realms
- `Object.getPrototypeOf(plainObj) === OtherRealm.Object.prototype` → false

This is the `vm.createContext` / iframe / `worker_threads` problem. npm
packages constantly exchange Buffers, streams, Errors, and plain objects
with each other and with your code — a realm boundary shatters all of it.

**Decision: stay in one realm.** Everything below assumes a single Context.

---

## 3. The architecture: source transform + `Limun.legacy`

One realm, one set of intrinsics, and a single namespace object —
`Limun.legacy` — that holds the entire Node surface. A **source transform**,
gated on module provenance, rewires Node-origin code to that namespace.
Because it's a source transform (not a wrapper), it works on ESM as well as
CJS.

The Node compat package (`@limun/node` or `@std/node`) implements the Node
API in pure TypeScript by wrapping `@std` packages. It injects Node globals
into `globalThis` explicitly: `injectNodeJs(globalThis)`. Nobody pollutes your
scope implicitly; you have to deliberately pollute it. Global scope protection
can be disabled from `limun.json`.

### 3.1 Globals → `Limun.legacy.globals`, via shadowing

Don't blanket-rewrite `globalThis` — Node code legitimately reaches web
globals through it. Use module-local shadowing so normal lexical scope does
the work:

```js
// injected per Node-origin module:
const globalThis = Limun.legacy.globals; // a Proxy (see below)
const global = globalThis;
const self = globalThis;
const { process, Buffer, setImmediate, clearImmediate } = globalThis; // free names only
```

- The shadow on `globalThis`/`global`/`self` handles every member access with
  zero per-reference rewriting.
- The destructuring line handles bare free identifiers (`process`, `Buffer`
  used without `globalThis.`), captured as locals so they cost no proxy hit.

Make `Limun.legacy.globals` a **Proxy**, not a snapshot: returns Node
polyfills for Node keys, forwards everything else to the real `globalThis`,
so web globals stay live.

**Critical constraint:** only inject names that are **free** in the module
(referenced but never bound). If a module does `import process from
"node:process"` or `function f(process){}`, injecting `const process` is a
redeclaration `SyntaxError`. One scope pass collects free-vs-bound
identifiers; inject only the free ones.

### 3.2 CJS bindings → per-module locals from namespace factories

`require`/`module`/`exports`/`__dirname`/`__filename` are per-module, so they
can't be single properties on a shared object. The factories live on the
namespace; each module instantiates its own locals:

```js
const require    = Limun.legacy.createRequire(import.meta.url);
const module     = { exports: {} };
const exports    = module.exports;
const __filename = Limun.legacy.fileURLToPath(import.meta.url);
const __dirname  = Limun.legacy.dirname(__filename);
```

- `module`/`exports` are plain locals — no factory needed.
- `require`/`__dirname`/`__filename` derive from `import.meta.url`, which is
  always correct wherever the file actually sits. Do not hardcode absolute
  paths at transform time — they break on relocation.
- `new URL(import.meta.url).pathname` is not a substitute: yields `/C:/foo`
  on Windows and skips percent-decoding. Use `fileURLToPath`.

Selective activation is inherent: a pure ESM project's files get no preamble
→ `module`/`require` undefined → `module.exports = {}` throws
`ReferenceError`, exactly as desired.

### 3.3 Provenance gating = the isolation

Apply the transform only to npm/`node:`-origin modules — provenance the
loader already tracks. Your own ESM is never touched, so it never sees Node
globals or CJS bindings. That gate is the quarantine.

---

## 4. Replacing npm with an AOT installer

Rip npm acquisition + Node resolution out of the runtime and move both into
a userland installer that resolves and transforms packages ahead-of-time,
then emits standards-ESM plus import-map entries. The runtime then only
ever loads plain ESM through the import map — zero Node resolution logic at
runtime.

### 4.1 esm.sh is a working reference

`https://esm.sh/express` returns a facade re-exporting from a pinned,
target-specific build path. The transformed build applies exactly the moves
needed: CJS→ESM via esbuild, dependency rewriting (every `require("dep")`
becomes an import of another pinned URL — the whole tree flattened into
URL-addressed ESM, resolution done ahead-of-time), and a per-module globals
banner injecting `process`/`Buffer`/`__dirname` at the top of each file.

Differences for Limun: self-host the build server (avoid a remote third-party
in the supply chain), and route injected globals through `Limun.legacy.*`
instead of ad-hoc shims, so everything traces to one quarantined namespace.

The import map in `limun.json` is the pivot config — standards-based,
natively understood by the runtime, zero Node coupling.

### 4.2 Detecting "this package expects Node"

Per-file at install time, inject only what's needed:

- CJS format (`.cjs`, or `.js` under `"type": "commonjs"`, or
  `require`/`module.exports` usage)
- `node:` builtin imports present
- free `process`/`Buffer`/`global`/`__dirname` references (scope pass)
- `package.json` signals (`engines.node`, `exports` with a `"node"` condition,
  `browser` field, `main`)
- bare specifiers resolving into `node_modules`

Install-time injection beats load-time: the runtime never needs the transform
machinery, and installed files are already standards ESM. Tradeoff: vendored
files are modified, so integrity hashing is over transformed output and you
want source maps for debugging.

### 4.3 `node_modules`

Keep it for now; later, intercept resolution and answer from a manifest (Yarn
Plug'n'Play / Deno's `nodeModulesDir: "none"` mode — no physical tree, a
manifest maps package→location). Well-trodden, not a hack.

---

## 5. The `node:` builtins

Split on one line: **does it do I/O?**

- **Pure-logic builtins** — `path`, `url`, `querystring`, `util`, `events`,
  `string_decoder`, `assert`, most of `stream`'s logic. Zero native op calls —
  pure string manipulation. Lift as-is into userland.

- **I/O builtins** — `fs`, `net`, `os`, `tls`, `dgram`, `child_process`,
  `crypto` primitives. These cannot be pure JS. The JS shim is a translation
  layer (Node-shaped work → hands the actual syscall to a native op). Re-target
  them onto public `Limun.*` APIs (`Limun.fs.*`, `Limun.open`, etc.), which
  are native but stable, public, and ours. A userland `@std/node-fs` on top
  of `Limun.*` is viable and keeps everything behind our sovereign surface.

Sorting rule: pure-logic modules are free (lift the JS); I/O modules re-target
native ops → `Limun.*`; only the `Limun.*`-uncovered residue (some fd-level
ops, `node:crypto` primitives absent from Web Crypto, `node:sqlite`, napi)
forces a real native decision.

---

## 6. CJS → ESM conversion

`createRequire` (consume side) and `module.exports` (produce side) are
opposite directions. Having `createRequire` does not remove the need for
`module.exports`.

**Mental model (IIFE bridge):**

```js
const __cjs = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  const require = Limun.legacy.createRequire(import.meta.url);
  const __filename = Limun.legacy.fileURLToPath(import.meta.url);
  const __dirname  = Limun.legacy.dirname(__filename);
  /* original CJS body verbatim: module.exports = express … */
  return module.exports;
})();
export default __cjs;
export const Router = __cjs.Router; // named exports, where statically detectable
```

Why an IIFE, not a flat preamble: CJS relies on function semantics illegal at
ESM top level — a bare `return` at the top (syntax error in ESM) and
`this === module.exports` at module scope (`this` is `undefined` in ESM).
The wrapping function preserves both. So: **ESM npm modules → preamble
injection; CJS npm modules → IIFE-wrap-and-bridge.**

**Production-correct form is the memoized registry**, not a plain IIFE.
Circular deps require `require("A")` to return A's partially-populated exports
mid-eval. A must register its `module.exports` object before its body runs,
and every `require("A")` must return that same live object. This is esbuild's
`__commonJS` lazy-init pattern:

```js
var init_A = __commonJS({ "A"(exports, module) { /* body mutates module.exports */ } });
// require("A") => init_A() (runs once, memoized) => the live module.exports
```

**Interop hazards:**

- `export default` captures the object reference. Mutations are visible; a
  later `module.exports = somethingElse` reassignment is not reflected.
- Named exports are heuristic (cjs-module-lexer statically scans
  `exports.foo =`; dynamically-added exports are missed, so `import { foo }`
  breaks while `import pkg; pkg.foo` works).

**`require` conversion is two cases:**

- **Static `require("literal")`** → hoist to a top-level ESM import + interop
  shim. Exceptions that must NOT hoist: requires inside `try/catch`
  (optional-dep probing) and dynamic `require(expr)`.
- **Dynamic `require(expr)`** → a runtime `Limun.legacy.createRequire(...)`
  shim that resolves synchronously against the already-loaded set.

**The sync/async wall (irreducible):** `require` is synchronous; `import` is
async. The sync shim only works because static deps were hoisted into imports
and are already loaded by the time the CJS body runs. A `require(computedPath)`
pointing at something not statically reachable was never pre-loaded — nothing
to look up synchronously — so it fails, unless you eagerly bundle the whole
package dir. This is the one genuinely irreducible casualty of AOT.

---

## 7. Dropping runtime CommonJS support

From the runtime, yes. But "drop CJS" is really "relocate CJS". The runtime's
native CJS loader doesn't exist; CJS semantics move into the AOT transform
and `Limun.legacy`. The `require` function survives as a userland shim over
the ESM registry. The runtime becomes CJS-unaware, not "CJS is gone".

`Limun.legacy` is a compact module runtime:

- `createRequire`, `fileURLToPath`, `dirname`
- `require.resolve` — resolve without loading (installer has the map)
- `require.cache` — some packages mutate it (hot-reload, test tooling)
- `require.main` — for `require.main === module` entry-point checks
- a synchronous module registry holding live `module.exports` objects —
  the load-bearing piece for circular-dep correctness

---

## 8. Known limitations / casualties

- **Native addons (napi / `.node`)** — can't be AOT-transformed to ESM at all;
  fundamentally need runtime napi support. Dropping napi loses
  `better-sqlite3`, `sharp` (native parts), `bcrypt`, etc.
- **Dynamic require of a not-statically-reachable module** — the sync/async
  wall. Mitigate by eager-bundling the package dir, or accept failure.
- **Loader-hacking tools** — `ts-node`, `module-alias`, `tsconfig-paths`,
  coverage tools, APM agents monkeypatch `Module.prototype` /
  `Module._load` / `Module._resolveFilename`. With no real `Module` class in
  the runtime, they have nothing to hook. Hard casualty.
- **`require.cache` deletion tricks** — proxyquire/rewire-style re-execution.
  Works only insofar as the registry mirrors the semantics; often it won't
  fully.
- **`node:crypto` primitives not in Web Crypto**, **`node:sqlite`**, and
  other `Limun.*`-uncovered ops — stay native or get dropped.

Saving grace: this residue is almost entirely dev/instrumentation tooling,
not runtime libraries. For "run my application's production dependencies," a
CJS-unaware runtime is clean and the casualties barely register. For "run
arbitrary Node tooling," they matter a lot.

---

## 9. Open decisions

1. **AOT-only vs. AOT + runtime `require` fallback** —
   - *AOT-only*: truly CJS-free runtime; dynamic-unreachable `require` just
     fails; loader-hacking tools don't run. Maximally clean.
   - *AOT + fallback*: compatible with the gnarly cases, but CJS isn't gone
     — you've moved the loader into `Limun.legacy` and kept it live.
   Pick based on target: *your deps* vs. *the whole Node tooling world*.
2. **napi** — keep a runtime native-addon extension, or drop native addons.
3. **`node:crypto` / `node:sqlite`** — re-target onto `Limun.*` where
   possible, keep as a minimal native ops extension, or drop.
4. **esm.sh** — self-host the build server (sovereign) vs. use the public
   service (fast bootstrap, remote dependency).

---

## 10. Build order (suggested)

1. Assemble the runtime from V8 + Rust, Node-free. Confirm a clean boot.
2. `@limun/node` package skeleton: relocate Node globals to `Limun.legacy`
   (accept red npm compat initially).
3. Free-vs-bound scope pass + preamble/shadow injection, provenance-gated.
4. Installer skeleton: acquire + AOT-resolve + emit import-map. Start by
   proxying a self-hosted esm.sh; replace stages with own logic incrementally.
5. CJS→ESM via the `__commonJS` registry pattern; hoist static requires, shim
   dynamic ones.
6. `node:` builtins: lift pure-logic modules; re-target I/O modules onto
   `Limun.*`.
7. Decide the residue (napi, node:crypto/sqlite) per §9.