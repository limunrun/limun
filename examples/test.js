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
  for (const name of ["console", "Limun", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "Headers", "Response"]) {
    check(`${name} is own property`, Object.getOwnPropertyNames(globalThis).includes(name));
    check(`${name} is non-enumerable`, desc(globalThis, name) === false);
    check(`${name} NOT in Object.keys`, !Object.keys(globalThis).includes(name));
  }

  // Ordinary interface attributes: enumerable per Web IDL §3.7.3.
  for (const name of ["self", "alert", "confirm", "prompt", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "btoa", "atob", "fetch"]) {
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

  try {
    new TextDecoder("shift_jis");
    check("unsupported label throws RangeError", false);
  } catch (e) {
    check("unsupported label throws RangeError", e instanceof RangeError);
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
    const res = await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    check("fetch(): real request resolves with .ok", res.ok === true);
    check("fetch(): response body is readable", (await res.text()).length > 0);

    // A real 404 must resolve normally (ok: false), never reject.
    const res404 = await fetch("https://esm.sh/this-definitely-does-not-exist-12345");
    check("fetch(): non-2xx status resolves, not rejects", res404.ok === false && res404.status === 404);
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
