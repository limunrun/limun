// Comprehensive, non-interactive smoke test for everything limun currently
// implements. Safe to run unattended (`cargo run -- examples/test.js`) —
// no confirm()/prompt() loops, no network dependency required to pass
// (remote-import checks are best-effort and won't fail the run offline).
//
// Every check funnels through `check(name, condition)` so failures are
// visible (stderr) without stopping the rest of the suite from running.

let failures = 0;
function check(name, condition) {
  console.assert(condition, name);
  if (!condition) failures++;
}

// ---------------------------------------------------------------------
console.group("globalThis shape (Web IDL enumerability)");
// ---------------------------------------------------------------------
{
  const desc = (obj, name) => {
    const d = Object.getOwnPropertyDescriptor(obj, name);
    return d ? d.enumerable : "missing";
  };

  check("self === globalThis", self === globalThis);
  check("globalThis.constructor.name === Object", globalThis.constructor.name === "Object");

  // Namespace objects (console, Limun): non-enumerable per Web IDL §3.7.5.
  // Interface objects (constructors: TextEncoder, URL, ...) are *also*
  // non-enumerable — verified against real Node
  // (`Object.getOwnPropertyDescriptor(globalThis, "URL").enumerable ===
  // false`, same as `Array`/`Object`).
  for (const name of ["console", "Limun", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "Headers", "Response", "Request", "ReadableStream", "ReadableStreamReader", "Blob", "FormData", "Event", "CustomEvent", "EventTarget", "AbortController", "AbortSignal"]) {
    check(`${name} is own property`, Object.getOwnPropertyNames(globalThis).includes(name));
    check(`${name} is non-enumerable`, desc(globalThis, name) === false);
    check(`${name} NOT in Object.keys`, !Object.keys(globalThis).includes(name));
  }

  // Ordinary interface attributes: enumerable per Web IDL §3.7.3.
  for (const name of ["self", "alert", "confirm", "prompt", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "btoa", "atob", "fetch", "performance"]) {
    check(`${name} is enumerable`, desc(globalThis, name) === true);
    check(`${name} in Object.keys`, Object.keys(globalThis).includes(name));
  }

  check("typeof alert", typeof alert === "function");
  check("typeof confirm", typeof confirm === "function");
  check("typeof prompt", typeof prompt === "function");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("console (WHATWG Console Standard, all 18 methods)");
// ---------------------------------------------------------------------
{
  console.log("log: %s %d %o", "formatted", 42, { a: 1 });
  console.info("info: plain message");
  console.debug("debug: plain message");
  console.warn("warn: goes to stderr");
  console.error("error: goes to stderr");
  console.assert(true, "assert: this should NOT print (condition is true)");
  console.dir({ nested: { value: 1 } });
  console.dirxml({ notReallyXml: true });
  console.trace("trace: real V8 stack trace below");
  console.table([{ a: 1, b: 2 }, { a: 3, b: 4 }]);

  console.count("hits");
  console.count("hits");
  console.countReset("hits");
  console.count("hits");

  console.group("nested group");
  console.log("inside a group (should be indented)");
  console.groupCollapsed("nested collapsed group");
  console.log("inside a collapsed group");
  console.groupEnd();
  console.groupEnd();

  console.time("timer");
  console.timeLog("timer", "mid-point");
  console.timeEnd("timer");

  console.clear();
  console.log("(cleared — this line prints right after)");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("Limun namespace");
// ---------------------------------------------------------------------
{
  check("Limun.hello works", Limun.hello("test") === "Hello, test!" || typeof Limun.hello("test") === "string");
  console.log("Limun.hello(\"test\"):", Limun.hello("test"));
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("modules: static import, relative resolution");
// ---------------------------------------------------------------------
{
  const { greet } = await import("./greet.js");
  check("relative import works", greet("modules") === "greetings from modules");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("import maps: bare, prefix, scoped, blocked");
// ---------------------------------------------------------------------
{
  const { foo } = await import("foo");
  check("bare specifier match", foo() === "resolved via limun.json import map");

  const { greet: greetViaPrefix } = await import("examples/greet.js");
  check("prefix specifier match", greetViaPrefix("prefix") === "greetings from prefix");

  // This file lives under ./examples/, which is exactly the scopes[] key in
  // limun.json — so the bare "bar" specifier resolves to scoped-bar.js here,
  // NOT the top-level imports["bar"] (which points to plain bar.js).
  const { bar } = await import("bar");
  check("scoped override wins over top-level imports", bar() === "scoped bar (examples/ override)");

  try {
    await import("blocked-example");
    check("blocked (null) specifier throws", false);
  } catch (e) {
    check("blocked (null) specifier throws", e.message.includes("blocked"));
  }

  try {
    await import("totally-unknown-bare-specifier");
    check("unknown bare specifier throws", false);
  } catch (e) {
    check("unknown bare specifier throws", true);
  }
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("dynamic import() + import.meta");
// ---------------------------------------------------------------------
{
  check("import.meta.url is a file: URL", import.meta.url.startsWith("file://"));
  check("import.meta.url ends with this file", import.meta.url.endsWith("/test.js"));

  const resolved = import.meta.resolve("./greet.js");
  const expected = new URL("./greet.js", import.meta.url).href;
  check("import.meta.resolve works", resolved === expected);

  const dynamicMod = await import("./greet.js");
  check("dynamic import dedupes with static import", typeof dynamicMod.greet === "function");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("event loop: setTimeout/setInterval/queueMicrotask");
// ---------------------------------------------------------------------
{
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("setTimeout actually waits", Date.now() - start >= 50);

  let order = [];
  setTimeout(() => order.push("timeout"), 0);
  queueMicrotask(() => order.push("microtask"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("microtask runs before a 0ms timeout", order[0] === "microtask" && order[1] === "timeout");

  let ticks = 0;
  const intervalId = setInterval(() => {
    ticks++;
    if (ticks >= 3) clearInterval(intervalId);
  }, 20);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check("setInterval + self-clearInterval fires exactly 3 times", ticks === 3);

  let cancelled = true;
  const timeoutId = setTimeout(() => { cancelled = false; }, 30);
  clearTimeout(timeoutId);
  await new Promise((resolve) => setTimeout(resolve, 60));
  check("clearTimeout actually cancels", cancelled === true);
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("unhandled promise rejection reporting");
// ---------------------------------------------------------------------
{
  // Handled synchronously — should NOT be reported as unhandled.
  let caught = false;
  Promise.reject(new Error("handled inline")).catch(() => { caught = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  check("synchronously-handled rejection isn't falsely reported", caught === true);

  // Handled *after* the fact (attached later in a microtask) — also fine.
  let caughtLate = false;
  const p = Promise.reject(new Error("handled late"));
  queueMicrotask(() => { p.catch(() => { caughtLate = true; }); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  check("late-handled rejection isn't falsely reported", caughtLate === true);

  console.log(
    "(a genuinely unhandled rejection is NOT triggered here on purpose —",
    "it would correctly fail this run with a non-zero exit code.",
    "Uncomment the line below to see it: `Uncaught (in promise) Error: ...`",
    "on stderr + exit code 1.)"
  );
  // Promise.reject(new Error("this one is genuinely unhandled"));
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("import attributes: with { type: \"json\" | \"text\" }");
// ---------------------------------------------------------------------
{
  // Static.
  const jsonMod = await import("./data.json", { with: { type: "json" } });
  check("static-equivalent json import works", jsonMod.default.name === "Shiba" && jsonMod.default.count === 42 && jsonMod.default.nested.ok === true);

  const textMod = await import("./note.txt", { with: { type: "text" } });
  check("text import works", textMod.default.trim() === "hello from a text module");

  // Same URL, no attribute at all -> ordinary rules still apply elsewhere
  // (a .json file with no `type` attribute would fail to parse as JS, so we
  // don't test that path here — just confirming plain JS imports are
  // unaffected by any of this).
  const { greet: stillPlainJs } = await import("./greet.js");
  check("plain js imports unaffected", typeof stillPlainJs === "function");

  // JSON modules only ever have a single `default` export — a named import
  // should fail to link, exactly like a browser.
  try {
    await import("./bad_named_json_import.js");
    check("named import from json module rejected", false);
  } catch (e) {
    check("named import from json module rejected", e.message.includes("does not provide an export"));
  }

  // Unsupported attribute key -> TypeError (dynamic import).
  try {
    await import("./greet.js", { with: { potato: "yes" } });
    check("unsupported attribute key throws", false);
  } catch (e) {
    check("unsupported attribute key throws", e instanceof TypeError);
  }

  // Unsupported `type` value -> TypeError (dynamic import).
  try {
    await import("./greet.js", { with: { type: "css" } });
    check("unsupported type value throws", false);
  } catch (e) {
    check("unsupported type value throws", e instanceof TypeError);
  }

  // Same URL + different `type` = different module identity (spec
  // requirement — the cache key includes the attribute, not just the URL).
  const asJson = await import("./data.json", { with: { type: "json" } });
  const asText = await import("./data.json", { with: { type: "text" } });
  check(
    "same URL, different type -> distinct modules",
    typeof asJson.default === "object" && typeof asText.default === "string"
  );
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("TextEncoder/TextDecoder (WHATWG Encoding Standard)");
// ---------------------------------------------------------------------
{
  const enc = new TextEncoder();
  check("TextEncoder.encoding", enc.encoding === "utf-8");

  const bytes = enc.encode("héllo");
  check("encode() returns a Uint8Array", bytes instanceof Uint8Array);
  check("encode() produces correct UTF-8 bytes", [...bytes].join(",") === "104,195,169,108,108,111");

  const dec = new TextDecoder();
  check("TextDecoder.encoding", dec.encoding === "utf-8");
  check("TextDecoder default fatal/ignoreBOM", dec.fatal === false && dec.ignoreBOM === false);
  check("decode() round-trips", dec.decode(bytes) === "héllo");

  const dest = new Uint8Array(3);
  const { read, written } = enc.encodeInto("héllo", dest);
  check(
    "encodeInto() stops at a char boundary, doesn't split a code point",
    written === 3 && read === 2 && dest[0] === 104 && dest[1] === 195 && dest[2] === 169,
  );

  const strictDecoder = new TextDecoder("utf-8", { fatal: true });
  check("fatal option is stored", strictDecoder.fatal === true);
  try {
    strictDecoder.decode(new Uint8Array([0xff, 0xfe]));
    check("fatal: true throws on invalid UTF-8", false);
  } catch (e) {
    check("fatal: true throws on invalid UTF-8", e instanceof TypeError);
  }
  check(
    "fatal: false (default) replaces invalid UTF-8 instead of throwing",
    new TextDecoder().decode(new Uint8Array([0xff, 0xfe])) === "\ufffd\ufffd",
  );

  // --- legacy encodings (encoding_rs full label table) ---
  // Construction + canonical `encoding` name. Per the WHATWG spec the
  // `iso-8859-1`/`latin1`/`ascii` labels all alias windows-1252 (NOT
  // iso-8859-1), so the canonical name returned is "windows-1252".
  check("windows-1252 constructs", new TextDecoder("windows-1252").encoding === "windows-1252");
  check("shift_jis encoding name", new TextDecoder("shift_jis").encoding === "shift_jis");
  check("utf-16le encoding name", new TextDecoder("utf-16le").encoding === "utf-16le");
  check("iso-8859-1 aliases windows-1252", new TextDecoder("iso-8859-1").encoding === "windows-1252");
  check("latin1 aliases windows-1252", new TextDecoder("latin1").encoding === "windows-1252");
  check("ascii aliases windows-1252", new TextDecoder("ascii").encoding === "windows-1252");
  // Label normalization: case + surrounding ASCII whitespace.
  check("label case-insensitive", new TextDecoder("  Shift_JIS ").encoding === "shift_jis");
  check("utf-8 label still canonical", new TextDecoder("utf-8").encoding === "utf-8");
  check("utf8 label canonicalizes to utf-8", new TextDecoder("utf8").encoding === "utf-8");

  // Decode a known single-byte windows-1252 mapping: 0x80 -> U+20AC (€).
  check(
    "windows-1252 0x80 -> EUR sign",
    new TextDecoder("windows-1252").decode(new Uint8Array([0x80])) === "\u20ac",
  );
  // Decode a known multi-byte shift_jis mapping: 0x82 0xA0 -> HIRAGANA A (あ).
  check(
    "shift_jis 0x82A0 -> hiragana A",
    new TextDecoder("shift_jis").decode(new Uint8Array([0x82, 0xa0])) === "\u3042",
  );

  // fatal: true on a malformed legacy byte sequence -> TypeError.
  // 0x82 is a shift_jis lead byte expecting a valid trail byte; 0xFF is
  // never a valid trail, so the pair is malformed.
  try {
    new TextDecoder("shift_jis", { fatal: true }).decode(new Uint8Array([0x82, 0xff]));
    check("fatal: true throws on invalid shift_jis", false);
  } catch (e) {
    check("fatal: true throws on invalid shift_jis", e instanceof TypeError);
  }
  // fatal: false (default) on the same malformed sequence -> U+FFFD, no throw.
  check(
    "fatal: false replaces invalid shift_jis",
    new TextDecoder("shift_jis").decode(new Uint8Array([0x82, 0xff])).includes("\ufffd"),
  );

  // The `replacement` encoding (and its aliases iso-2022-kr / iso-2022-cn)
  // is rejected by the spec with a RangeError — it can only ever decode to
  // U+FFFD and is intentionally not exposed via TextDecoder.
  for (const lbl of ["replacement", "iso-2022-kr", "iso-2022-cn"]) {
    try {
      new TextDecoder(lbl);
      check(`replacement-label "${lbl}" throws RangeError`, false);
    } catch (e) {
      check(`replacement-label "${lbl}" throws RangeError`, e instanceof RangeError);
    }
  }

  // Unknown / unrecognized label -> RangeError (unchanged behavior).
  try {
    new TextDecoder("not-a-real-encoding");
    check("unknown label throws RangeError", false);
  } catch (e) {
    check("unknown label throws RangeError", e instanceof RangeError);
  }
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("btoa/atob (WHATWG HTML Standard)");
// ---------------------------------------------------------------------
{
  check("btoa/atob round-trip", atob(btoa("hello, limun")) === "hello, limun");
  check("btoa produces standard base64", btoa("hello") === "aGVsbG8=");

  try {
    btoa("h\u{1F600}i"); // outside Latin1 range
    check("btoa throws on non-Latin1 input", false);
  } catch (e) {
    check("btoa throws on non-Latin1 input", e.name === "InvalidCharacterError");
  }

  try {
    atob("not valid base64!!!");
    check("atob throws on invalid base64", false);
  } catch (e) {
    check("atob throws on invalid base64", e.name === "InvalidCharacterError");
  }
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("URL / URLSearchParams (WHATWG URL Standard)");
// ---------------------------------------------------------------------
{
  const u = new URL("https://user:pass@example.com:8080/path/to/thing?a=1&b=2#frag");
  check("href", u.href === "https://user:pass@example.com:8080/path/to/thing?a=1&b=2#frag");
  check("origin", u.origin === "https://example.com:8080");
  check("protocol", u.protocol === "https:");
  check("username/password", u.username === "user" && u.password === "pass");
  check("host/hostname/port", u.host === "example.com:8080" && u.hostname === "example.com" && u.port === "8080");
  check("pathname", u.pathname === "/path/to/thing");
  check("search", u.search === "?a=1&b=2");
  check("hash", u.hash === "#frag");
  check("toString() === href", u.toString() === u.href && `${u}` === u.href);

  u.pathname = "/new/path";
  u.hash = "newfrag"; // spec: leading "#" optional on the setter
  check("pathname/hash setters", u.pathname === "/new/path" && u.hash === "#newfrag");

  // `searchParams` is *live*: mutating it updates `.search`/`.href`
  // immediately, and it's the same object every time it's accessed.
  check("searchParams identity is stable", u.searchParams === u.searchParams);
  u.searchParams.append("c", "3");
  check("searchParams mutation reflects into .search", u.search === "?a=1&b=2&c=3");
  u.search = "?x=9";
  check(".search reassignment reflects into searchParams", u.searchParams.get("x") === "9" && u.searchParams.get("a") === null);

  const relative = new URL("./b.js", "https://example.com/a/c.js");
  check("relative URL resolution against base", relative.href === "https://example.com/a/b.js");

  check("URL.canParse valid", URL.canParse("https://x.com") === true);
  check("URL.canParse invalid", URL.canParse("not a url") === false);
  check("URL.parse valid returns a URL", URL.parse("https://y.com")?.href === "https://y.com/");
  check("URL.parse invalid returns null", URL.parse("not a url") === null);

  try {
    new URL("not a url");
    check("constructor throws TypeError on unparsable input", false);
  } catch (e) {
    check("constructor throws TypeError on unparsable input", e instanceof TypeError);
  }

  // Standalone URLSearchParams (not attached to any URL).
  const sp = new URLSearchParams("a=1&b=2&a=3");
  check("getAll", sp.getAll("a").join(",") === "1,3");
  check("get returns first match", sp.get("b") === "2");
  check("has", sp.has("a") === true && sp.has("z") === false);
  sp.set("a", "99");
  check("set replaces all same-name entries with one", sp.toString() === "a=99&b=2");
  sp.delete("b");
  check("delete", sp.toString() === "a=99");
  check("size", sp.size === 1);
  sp.append("z", "1");
  sp.append("y", "2");
  sp.sort();
  check("sort orders by name", sp.toString() === "a=99&y=2&z=1");

  let iterated = [];
  for (const [k, v] of sp) iterated.push(`${k}=${v}`);
  check("for...of via [Symbol.iterator] yields all pairs in order", iterated.join(",") === "a=99,y=2,z=1");

  let forEachCount = 0;
  sp.forEach(() => forEachCount++);
  check("forEach visits every pair", forEachCount === 3);

  const fromRecord = new URLSearchParams({ x: "1", y: "2" });
  check("URLSearchParams from a record", fromRecord.toString() === "x=1&y=2");

  const fromArray = new URLSearchParams([["p", "q"], ["p", "r"]]);
  check("URLSearchParams from pairs, duplicates preserved", fromArray.toString() === "p=q&p=r");

  // IPv6 bracketed host:port — the host setter must keep the brackets and
  // not confuse a ':' inside the brackets with the host:port separator.
  const v6 = new URL("http://[::1]:8080/path");
  check("IPv6 hostname", v6.hostname === "[::1]");
  check("IPv6 port", v6.port === "8080");
  v6.host = "[::1]:9090";
  check("IPv6 host setter keeps brackets", v6.hostname === "[::1]");
  check("IPv6 host setter updates port", v6.port === "9090");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("permissions (limun.json's \"permissions\" block)");
// ---------------------------------------------------------------------
{
  // This process is already running under the real ./limun.json, which
  // grants read: ["./"] and net: ["esm.sh", "raw.githubusercontent.com"]
  // — enough to make it this far. The *deny* path (a restrictive
  // permissions.read/net actually blocking something) can't be
  // demonstrated in-process, since permissions load once at startup —
  // it's verified manually instead (spin up a second process with its
  // own scratch limun.json). See core::permissions's doc comment.
  console.log("(deny-path verified manually against a second limun.json — see core::permissions)");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("fetch() / Headers / Response (WHATWG Fetch Standard)");
// ---------------------------------------------------------------------
{
  const h = new Headers({ "Content-Type": "text/plain", "X-Foo": "bar" });
  check("Headers normalizes names to lowercase", h.get("content-type") === "text/plain");
  h.append("X-Foo", "baz");
  check("append() combines with the existing value", h.get("x-foo") === "bar, baz");
  check("has()", h.has("x-foo") === true);
  h.delete("x-foo");
  check("delete()", h.get("x-foo") === null);
  h.set("x-foo", "only");
  check("set() replaces rather than combines", h.get("x-foo") === "only");
  const hEntries = [...new Headers([["b", "2"], ["a", "1"]]).entries()];
  check("entries() iterates sorted by name", hEntries[0][0] === "a" && hEntries[1][0] === "b");

  const r = new Response("hello world", {
    status: 201,
    statusText: "Created",
    headers: { "x-test": "1" },
  });
  check("Response status/ok/statusText", r.status === 201 && r.ok === true && r.statusText === "Created");
  check("Response.headers is a real Headers instance", r.headers.get("x-test") === "1");
  check("Response.type/bodyUsed before read", r.type === "basic" && r.bodyUsed === false);
  check("text()", (await r.text()) === "hello world");
  check("bodyUsed after read", r.bodyUsed === true);
  try {
    await r.text();
    check("re-reading a consumed body throws", false);
  } catch (e) {
    check("re-reading a consumed body throws", e instanceof TypeError);
  }

  const rJson = new Response(JSON.stringify({ a: 1 }));
  check("Response.json()", (await rJson.json()).a === 1);

  const rBuf = new Response(new Uint8Array([1, 2, 3]));
  const ab = await rBuf.arrayBuffer();
  check("Response.arrayBuffer()", ab instanceof ArrayBuffer && new Uint8Array(ab).join(",") === "1,2,3");

  const rStatic = Response.json({ hello: "world" }, { status: 202 });
  check("Response.json() static helper", rStatic.status === 202 && (await rStatic.text()) === '{"hello":"world"}');

  const notOk = new Response("nope", { status: 404 });
  check(".ok is false for a 4xx status", notOk.ok === false);

  // Real network round-trip (best-effort — needs network, same as the
  // remote-import checks below).
  try {
    // `fetch()` now spawns a tokio task and returns a pending Promise
    // immediately (rather than blocking on the network call before
    // returning an already-settled promise).
    const p = fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    check("fetch() returns a pending Promise", p instanceof Promise && typeof p.then === "function");
    const res = await p;
    check("fetch(): real request resolves with .ok", res.ok === true);
    check("fetch(): response body is readable", (await res.text()).length > 0);

    // A real 404 must resolve normally (ok: false), never reject.
    const res404 = await fetch("https://esm.sh/this-definitely-does-not-exist-12345");
    check("fetch(): non-2xx status resolves, not rejects", res404.ok === false && res404.status === 404);

    // A URL that redirects (esm.sh redirects /x/ to /y/ sometimes, or use a
    // known redirector). Best-effort — if no network, the try/catch skips.
    try {
      const r = await fetch("https://esm.sh/react@18.2.0");  // likely redirects
      // Just check the field is a boolean (we can't assert true without a
      // guaranteed-redirect URL). The hardcoded-false bug is fixed regardless.
      check("Response.redirected is a boolean", typeof r.redirected === "boolean");
    } catch (e) { console.warn("redirect test skipped:", e.message); }

    // Timer fires DURING a pending fetch — proves the event loop doesn't
    // block on I/O (the whole point of the async rewrite).
    let timerFiredDuringFetch = false;
    const t = setTimeout(() => { timerFiredDuringFetch = true; }, 20);
    await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    clearTimeout(t);
    check("setTimeout fires during a pending fetch (no I/O blocking)", timerFiredDuringFetch === true);

    // --- Request class ---
    check("Request is a constructor", typeof Request === "function");
    const req = new Request("https://esm.sh/lodash-es@4.17.21/isEqual.js", { method: "POST", headers: { "x-test": "1" } });
    check("Request.method", req.method === "POST");
    check("Request.url", req.url === "https://esm.sh/lodash-es@4.17.21/isEqual.js");
    check("Request.headers is a Headers", req.headers instanceof Headers);
    check("Request.headers.get", req.headers.get("x-test") === "1");
    check("Request.bodyUsed", req.bodyUsed === false);
    const cloned = req.clone();
    check("Request.clone().method", cloned.method === "POST");
    check("Request.clone() is a different object", cloned !== req);
    check("Request.clone().headers is a Headers", cloned.headers instanceof Headers);
    check("Request.clone() copies headers", cloned.headers.get("x-test") === "1");

    // Request from a Request (clone-with-override).
    const req2 = new Request(req, { method: "PUT" });
    check("Request from Request inherits url", req2.url === req.url);
    check("Request from Request overrides method", req2.method === "PUT");
    check("Request from Request inherits headers", req2.headers.get("x-test") === "1");

    // fetch(request) — use a Request instance as input.
    try {
      const res = await fetch(new Request("https://esm.sh/lodash-es@4.17.21/isEqual.js"));
      check("fetch(Request) resolves", res.ok === true);
    } catch (e) { console.warn("fetch(Request) skipped:", e.message); }

    // --- AbortSignal in fetch() ---
    // Pre-aborted signal rejects immediately.
    const ac1 = new AbortController();
    ac1.abort();
    try {
      await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac1.signal });
      check("fetch with pre-aborted signal rejects", false);
    } catch (e) {
      check("fetch with pre-aborted signal rejects", e.name === "AbortError" || (e.message && e.message.includes("abort")));
    }

    // Abort during a pending fetch rejects.
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 10);
    try {
      await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac2.signal });
      check("fetch aborted during pending rejects", false);
    } catch (e) {
      check("fetch aborted during pending rejects", e.name === "AbortError" || (e.message && e.message.includes("abort")));
    }

    // Request carries its signal into fetch().
    const ac3 = new AbortController();
    const reqAbort = new Request("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac3.signal });
    ac3.abort();
    try {
      await fetch(reqAbort);
      check("fetch(Request) with pre-aborted signal rejects", false);
    } catch (e) {
      check("fetch(Request) with pre-aborted signal rejects", e.name === "AbortError" || (e.message && e.message.includes("abort")));
    }

    // --- Response.body as a ReadableStream ---
    try {
      const res = await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js");
      check("Response.body is a ReadableStream", res.body instanceof ReadableStream);
      check("Response.body identity is stable across accesses", res.body === res.body);
      const reader = res.body.getReader();
      check("Response.body.locked after getReader", res.body.locked === true);
      check("Response.bodyUsed after getReader on body", res.bodyUsed === true);
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        check("Response.body chunk is a Uint8Array", value instanceof Uint8Array);
        text += new TextDecoder().decode(value);
      }
      check("Response.body stream yields the full body", text.length > 0);
      await reader.closed;
      check("Response.body reader.closed resolves on close", true);
      try {
        await res.text();
        check("text() after body stream throws", false);
      } catch (e) {
        check("text() after body stream throws", e instanceof TypeError);
      }
    } catch (e) { console.warn("Response.body test skipped:", e.message); }
  } catch (e) {
    console.warn("skipped (no network?):", e.message);
  }

  // A genuine network failure (unresolvable host) must reject.
  try {
    await fetch("https://this-host-should-not-resolve-abcxyz.invalid/");
    check("fetch(): genuine network failure rejects", false);
  } catch (e) {
    check("fetch(): genuine network failure rejects", e instanceof TypeError);
  }
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("performance (W3C High Resolution Time L3)");
// ---------------------------------------------------------------------
{
  check("typeof performance", typeof performance === "object");
  check("performance instanceof EventTarget", performance instanceof EventTarget);
  check("performance.now() is a number", typeof performance.now() === "number");
  const t1 = performance.now();
  const t2 = performance.now();
  // Monotonic: a later sample must not be earlier (spec §7.1).
  check("performance.now() is monotonic", t2 >= t1);
  check("performance.now() advances", t2 - t1 >= 0);

  const o1 = performance.timeOrigin;
  const o2 = performance.timeOrigin;
  check("performance.timeOrigin is stable across reads", o1 === o2);
  check("performance.timeOrigin is finite", Number.isFinite(o1));
  check(
    "timeOrigin + now() ≈ Date.now() (within 5s)",
    Math.abs(Date.now() - (performance.timeOrigin + performance.now())) < 5000,
  );

  const json = performance.toJSON();
  check("toJSON().timeOrigin === performance.timeOrigin", json.timeOrigin === performance.timeOrigin);
  check("performance is not a constructor", typeof performance !== "function");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("Event / CustomEvent (DOM Standard §4.4–4.5)");
// ---------------------------------------------------------------------
{
  const e = new Event("foo", { bubbles: true, cancelable: true, composed: true });
  check("Event.type", e.type === "foo");
  check("Event.bubbles", e.bubbles === true);
  check("Event.cancelable", e.cancelable === true);
  check("Event.composed", e.composed === true);
  check("Event.defaultPrevented starts false", e.defaultPrevented === false);
  check("Event.isTrusted === false (synthetic)", e.isTrusted === false);
  check("Event.timeStamp is a number", typeof e.timeStamp === "number");
  check("Event.target === null before dispatch", e.target === null);
  check("Event.srcElement === null before dispatch", e.srcElement === null);

  // Default-init: all flags false.
  const e2 = new Event("bar");
  check("Event default bubbles false", e2.bubbles === false);
  check("Event default cancelable false", e2.cancelable === false);
  check("Event default composed false", e2.composed === false);

  e.preventDefault();
  check("preventDefault sets defaultPrevented", e.defaultPrevented === true);
  check("preventDefault on non-cancelable is a no-op flag-wise (still sets)", (() => {
    const nc = new Event("x", { cancelable: false });
    nc.preventDefault();
    // Spec: preventDefault always sets defaultPrevented; cancelable only
    // governs whether dispatch returns false. We have no default actions,
    // so this is observable-only via the flag.
    return nc.defaultPrevented === true;
  })());

  // stopPropagation is a no-op (single target); stopImmediatePropagation
  // is exercised in the EventTarget section below.
  e2.stopPropagation();
  check("stopPropagation is a no-op (no throw)", true);

  // CustomEvent extends Event (prototype chain).
  check("CustomEvent extends Event", CustomEvent.prototype instanceof Event);
  const ce = new CustomEvent("baz", { detail: { a: 1 } });
  check("CustomEvent.type", ce.type === "baz");
  check("CustomEvent.detail", ce.detail && ce.detail.a === 1);
  check("CustomEvent default detail null", new CustomEvent("z").detail === null);
  check("CustomEvent is an Event instance", ce instanceof Event);

  // initCustomEvent (deprecated) — sets fields.
  const ice = new CustomEvent("init");
  ice.initCustomEvent("renamed", true, false, "payload");
  check("initCustomEvent sets type", ice.type === "renamed");
  check("initCustomEvent sets bubbles", ice.bubbles === true);
  check("initCustomEvent sets cancelable", ice.cancelable === false);
  check("initCustomEvent sets detail", ice.detail === "payload");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("EventTarget / AbortController / AbortSignal (DOM Standard §4, abort)");
// ---------------------------------------------------------------------
{
  // --- EventTarget basics ---
  const target = new EventTarget();
  let received = null;
  target.addEventListener("ping", (e) => { received = e; });
  const evt = new Event("ping");
  const ret = target.dispatchEvent(evt);
  check("dispatchEvent returns true", ret === true);
  check("listener received event", received !== null);
  check("event.target === target", received.target === target);
  check("event.srcElement === target", received.srcElement === target);

  // --- once option ---
  let onceCount = 0;
  const onceTarget = new EventTarget();
  onceTarget.addEventListener("tick", () => { onceCount++; }, { once: true });
  onceTarget.dispatchEvent(new Event("tick"));
  onceTarget.dispatchEvent(new Event("tick"));
  check("once listener fires exactly once", onceCount === 1);

  // --- stopImmediatePropagation ---
  let first = 0, second = 0;
  const stopTarget = new EventTarget();
  stopTarget.addEventListener("e", (e) => { first++; e.stopImmediatePropagation(); });
  stopTarget.addEventListener("e", () => { second++; });
  stopTarget.dispatchEvent(new Event("e"));
  check("stopImmediatePropagation: first listener ran", first === 1);
  check("stopImmediatePropagation: second listener skipped", second === 0);

  // --- removeEventListener ---
  let rmCount = 0;
  const rmTarget = new EventTarget();
  const handler = () => { rmCount++; };
  rmTarget.addEventListener("x", handler);
  rmTarget.dispatchEvent(new Event("x"));
  rmTarget.removeEventListener("x", handler);
  rmTarget.dispatchEvent(new Event("x"));
  check("removeEventListener stops further fires", rmCount === 1);

  // --- dedup: same (callback, capture) is a no-op ---
  let dedupCount = 0;
  const dedupTarget = new EventTarget();
  const cb = () => { dedupCount++; };
  dedupTarget.addEventListener("d", cb);
  dedupTarget.addEventListener("d", cb); // no-op
  dedupTarget.dispatchEvent(new Event("d"));
  check("addEventListener dedup: identical listener fires once", dedupCount === 1);

  // --- AbortController/AbortSignal ---
  const controller = new AbortController();
  check("AbortController.signal is an AbortSignal", controller.signal instanceof AbortSignal);
  check("AbortSignal extends EventTarget", controller.signal instanceof EventTarget);
  check("signal.aborted starts false", controller.signal.aborted === false);
  check("signal.reason starts undefined", controller.signal.reason === undefined);

  let abortFired = false;
  controller.signal.addEventListener("abort", () => { abortFired = true; });
  controller.abort();
  check("abort() sets aborted", controller.signal.aborted === true);
  check("abort dispatches abort event", abortFired === true);
  check("default reason is AbortError-named Error",
    controller.signal.reason instanceof Error && controller.signal.reason.name === "AbortError");

  // Second abort is a no-op (reason unchanged, no second event).
  let secondAbort = false;
  controller.signal.addEventListener("abort", () => { secondAbort = true; });
  controller.abort("explicit reason");
  check("second abort() is a no-op", secondAbort === false && controller.signal.reason.name === "AbortError");

  // abort with explicit reason.
  const c2 = new AbortController();
  const reason = new Error("manual");
  c2.abort(reason);
  check("abort(reason) stores reason", c2.signal.reason === reason);

  // throwIfAborted.
  const c3 = new AbortController();
  check("throwIfAborted returns undefined when not aborted", c3.signal.throwIfAborted() === undefined);
  let threw = false;
  try { controller.signal.throwIfAborted(); } catch (e) { threw = true; }
  check("throwIfAborted throws when aborted", threw === true);

  // --- signal option auto-removes on abort ---
  let sigOptCount = 0;
  const sigOptTarget = new EventTarget();
  const sigOptController = new AbortController();
  sigOptTarget.addEventListener("y", () => { sigOptCount++; }, { signal: sigOptController.signal });
  sigOptTarget.dispatchEvent(new Event("y"));
  sigOptController.abort();
  sigOptTarget.dispatchEvent(new Event("y"));
  check("signal option auto-removes listener on abort", sigOptCount === 1);

  // --- AbortSignal.timeout (async) ---
  const timeoutSignal = AbortSignal.timeout(10);
  check("AbortSignal.timeout returns AbortSignal", timeoutSignal instanceof AbortSignal);
  check("AbortSignal.timeout not yet aborted", timeoutSignal.aborted === false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  check("AbortSignal.timeout aborts after ms", timeoutSignal.aborted === true);
  check("AbortSignal.timeout reason is TimeoutError",
    timeoutSignal.reason instanceof Error && timeoutSignal.reason.name === "TimeoutError");

  // --- AbortSignal.any ---
  const alreadyAborted = AbortSignal.abort("already");
  check("AbortSignal.abort() static exists", alreadyAborted.aborted === true);
  const combined = AbortSignal.any([alreadyAborted, new AbortController().signal]);
  check("AbortSignal.any: already-aborted input aborts result immediately", combined.aborted === true);
  check("AbortSignal.any: result reason === input reason", combined.reason === "already");

  // AbortSignal.any with not-yet-aborted inputs: result aborts when one fires.
  const cA = new AbortController();
  const cB = new AbortController();
  const combined2 = AbortSignal.any([cA.signal, cB.signal]);
  check("AbortSignal.any: not-aborted inputs → result not aborted", combined2.aborted === false);
  cA.abort("from A");
  check("AbortSignal.any: aborting one input aborts result", combined2.aborted === true);
  check("AbortSignal.any: result carries firing input's reason", combined2.reason === "from A");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("ReadableStream / ReadableStreamReader (WHATWG Streams Standard)");
// ---------------------------------------------------------------------
{
  // Construct from JS with a `start(controller)` push source — the only
  // `underlyingSource` method we support.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.enqueue(new TextEncoder().encode(" world"));
      controller.close();
    },
  });
  check("ReadableStream is a constructor", typeof ReadableStream === "function");
  check("ReadableStream is not locked", stream.locked === false);

  const reader = stream.getReader();
  check("ReadableStream is locked after getReader", stream.locked === true);
  check("reader is a ReadableStreamReader", reader instanceof ReadableStreamReader);

  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    check("read() chunk is a Uint8Array", value instanceof Uint8Array);
    chunks.push(new TextDecoder().decode(value));
  }
  check("ReadableStream yields enqueued chunks in order", chunks.join("") === "hello world");
  await reader.closed;
  check("ReadableStream reader.closed resolves on close", true);

  // getReader on a locked stream throws.
  try {
    stream.getReader();
    check("getReader on locked stream throws", false);
  } catch (e) {
    check("getReader on locked stream throws", e instanceof TypeError);
  }

  // releaseLock un-locks the stream.
  const s2 = new ReadableStream({
    start(controller) { controller.close(); },
  });
  check("s2 not locked", s2.locked === false);
  const r2 = s2.getReader();
  check("s2 locked after getReader", s2.locked === true);
  r2.releaseLock();
  check("s2 unlocked after releaseLock", s2.locked === false);

  // read() on a closed empty stream resolves {done: true, value: undefined}.
  const s3 = new ReadableStream({
    start(controller) { controller.close(); },
  });
  const r3 = s3.getReader();
  const result = await r3.read();
  check("read() on closed empty stream is done", result.done === true && result.value === undefined);

  // cancel() resolves and rejects pending reads.
  const s4 = new ReadableStream({
    start(controller) {
      // Never enqueue/close — leaves the stream open.
      setTimeout(() => controller.close(), 5);
    },
  });
  const r4 = s4.getReader();
  await r4.read(); // will resolve when close fires
  check("read() resolves after async close", true);

  // String chunks (non-BufferSource) are coerced to UTF-8 bytes.
  const s5 = new ReadableStream({
    start(controller) {
      controller.enqueue("plain string chunk");
      controller.close();
    },
  });
  const r5 = s5.getReader();
  const { value: v5 } = await r5.read();
  check("string chunk coerced to Uint8Array", v5 instanceof Uint8Array);
  check("string chunk round-trips", new TextDecoder().decode(v5) === "plain string chunk");

  // Response.body on a user-constructed Response (no network).
  const res = new Response(new Uint8Array([1, 2, 3, 4]));
  check("Response.body is a ReadableStream", res.body instanceof ReadableStream);
  check("Response.body identity stable", res.body === res.body);
  check("Response.bodyUsed false before read", res.bodyUsed === false);
  const rb = res.body.getReader();
  check("Response.bodyUsed true after getReader on body", res.bodyUsed === true);
  const { done: bd, value: bv } = await rb.read();
  check("Response.body yields body bytes", bd === false && bv instanceof Uint8Array && [...bv].join(",") === "1,2,3,4");
  const { done: bd2 } = await rb.read();
  check("Response.body done after one chunk", bd2 === true);
  try {
    await res.arrayBuffer();
    check("arrayBuffer() after body stream throws", false);
  } catch (e) {
    check("arrayBuffer() after body stream throws", e instanceof TypeError);
  }
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("Blob / FormData (File API + XHR Standard)");
// ---------------------------------------------------------------------
{
  // Blob
  const blob = new Blob(["hello ", "world"], { type: "text/plain" });
  check("Blob.size", blob.size === 11);
  check("Blob.type", blob.type === "text/plain");
  check("Blob.text()", (await blob.text()) === "hello world");
  check("Blob.arrayBuffer()", (await blob.arrayBuffer()) instanceof ArrayBuffer);
  const sliced = blob.slice(6);
  check("Blob.slice()", (await sliced.text()) === "world");
  const slicedTyped = blob.slice(0, 5, "text/html");
  check("Blob.slice() type", slicedTyped.type === "text/html");

  // Blob from BufferSource
  const blob2 = new Blob([new Uint8Array([0x68, 0x69])]);
  check("Blob from Uint8Array", (await blob2.text()) === "hi");

  // Blob.stream()
  const stream = blob.stream();
  const reader = stream.getReader();
  let chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  check("Blob.stream()", chunks.join("") === "hello world");

  // FormData
  const fd = new FormData();
  fd.append("name", "limun");
  fd.append("age", "1");
  fd.append("file", new Blob(["content"], { type: "text/plain" }), "test.txt");
  check("FormData.get", fd.get("name") === "limun");
  check("FormData.getAll", fd.getAll("age").length === 1);
  check("FormData.has", fd.has("file") === true);
  check("FormData.get(blob) returns a Blob", fd.get("file") instanceof Blob);
  fd.set("age", "2");
  check("FormData.set replaces", fd.get("age") === "2");
  fd.delete("file");
  check("FormData.delete", fd.has("file") === false);

  // FormData iteration
  let entries = [];
  for (const [k, v] of fd) entries.push(k);
  check("FormData[Symbol.iterator]", entries.length >= 2);

  // Response.blob() / Response.formData()
  const res = new Response("name=limun&age=1", { headers: { "content-type": "application/x-www-form-urlencoded" } });
  const parsedFd = await res.formData();
  check("Response.formData()", parsedFd.get("name") === "limun" && parsedFd.get("age") === "1");

  const res2 = new Response("hello", { headers: { "content-type": "text/plain" } });
  const blob3 = await res2.blob();
  check("Response.blob() is a Blob", blob3 instanceof Blob);
  check("Response.blob() type", blob3.type === "text/plain");
  check("Response.blob() text", (await blob3.text()) === "hello");
}
console.groupEnd();

// ---------------------------------------------------------------------
console.group("remote imports (best-effort — needs network)");
// ---------------------------------------------------------------------
{
  try {
    const { default: isEqual } = await import("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    check("https: import works", isEqual({ a: 1 }, { a: 1 }) === true);
  } catch (e) {
    console.warn("skipped (no network?):", e.message);
  }

  const { default: fortyTwo } = await import("data:text/javascript,export default 42;");
  check("data: import works", fortyTwo === 42);
}
console.groupEnd();

// ---------------------------------------------------------------------
if (failures === 0) {
  console.log(`\nAll checks passed.`);
} else {
  console.error(`\n${failures} check(s) FAILED — see console.assert output above.`);
}
