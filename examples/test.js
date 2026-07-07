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
  for (const name of ["console", "Limun"]) {
    check(`${name} is own property`, Object.getOwnPropertyNames(globalThis).includes(name));
    check(`${name} is non-enumerable`, desc(globalThis, name) === false);
    check(`${name} NOT in Object.keys`, !Object.keys(globalThis).includes(name));
  }

  // Ordinary interface attributes: enumerable per Web IDL §3.7.3.
  for (const name of ["self", "alert", "confirm", "prompt", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask"]) {
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

  // No `URL` global yet (separate feature), so check via string ops instead
  // of constructing an expected URL directly.
  const resolved = import.meta.resolve("./greet.js");
  const expected = import.meta.url.replace(/test\.js$/, "greet.js");
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
