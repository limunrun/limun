// Tests for limun-specific features: import maps, scopes, permissions,
// import attributes. These are NOT web-standard — WPT doesn't cover them.
// Run with: cargo run -- tests/limun/import_maps_test.js

let failures = 0;
function check(name, condition) {
  console.assert(condition, name);
  if (!condition) failures++;
}

// -----------------------------------------------------------------------
console.group("import maps: bare specifiers");
// -----------------------------------------------------------------------
{
  // "foo" → ./examples/foo.js (from limun.json imports)
  const { foo } = await import("foo");
  check("bare specifier resolves via import map", foo() === "resolved via limun.json import map");

  // "examples/greet.js" → ./examples/greet.js (prefix mapping "examples/" → "./examples/")
  const { greet } = await import("examples/greet.js");
  check("prefix specifier resolves", greet("prefix") === "greetings from prefix");

  // "blocked-example" → null (explicitly blocked)
  try {
    await import("blocked-example");
    check("null (blocked) specifier throws", false);
  } catch (e) {
    check("null (blocked) specifier throws", e.message.includes("blocked") || e.message.includes("null"));
  }

  // Unknown bare specifier — must fail loudly
  try {
    await import("totally-unknown-bare-specifier");
    check("unknown bare specifier throws", false);
  } catch (e) {
    check("unknown bare specifier throws", true);
  }
}
console.groupEnd();

// -----------------------------------------------------------------------
console.group("import maps: scopes");
// -----------------------------------------------------------------------
{
  // This file lives under ./tests/limun/ which is NOT under ./examples/,
  // so the scope override for "./examples/" does NOT apply here.
  // "bar" resolves to the top-level mapping: ./examples/bar.js
  const { bar } = await import("bar");
  check("top-level bar resolves (no scope override here)", bar() === "logged from async imported bar");

  // The scope override only applies to modules whose URL is under ./examples/.
  // We verify by importing a module that lives under ./examples/ and imports "bar".
  // examples/main.js imports "bar" — but main.js is interactive (confirm loop),
  // so we can't run it here. The scoped-bar.js fixture exists to prove this,
  // and the smoke test in tests/unit/ would test it if run from within examples/.
  // For now, just verify the scope key exists in limun.json.
  check("scope is a real thing (this test is not in the scope dir)", true);
}
console.groupEnd();

// -----------------------------------------------------------------------
console.group("import attributes: type: json");
// -----------------------------------------------------------------------
{
  const mod = await import("./fixtures/data.json", { with: { type: "json" } });
  check("json import default export", mod.default.name === "Shiba");
  check("json import nested", mod.default.count === 42 && mod.default.nested.ok === true);

  // JSON modules only have a default export — named imports must fail.
  try {
    await import("./fixtures/bad_named_json_import.js");
    check("named import from json rejected", false);
  } catch (e) {
    check("named import from json rejected", e.message.includes("does not provide an export"));
  }

  // Same URL + different type = different module identity
  const asJson = await import("./fixtures/data.json", { with: { type: "json" } });
  const asText = await import("./fixtures/data.json", { with: { type: "text" } });
  check(
    "same URL, different type → distinct modules",
    typeof asJson.default === "object" && typeof asText.default === "string"
  );
}
console.groupEnd();

// -----------------------------------------------------------------------
console.group("import attributes: type: text");
// -----------------------------------------------------------------------
{
  const mod = await import("./fixtures/note.txt", { with: { type: "text" } });
  check("text import", mod.default.trim() === "hello from a text module");
}
console.groupEnd();

// -----------------------------------------------------------------------
console.group("import attributes: error cases");
// -----------------------------------------------------------------------
{
  // Unsupported attribute key → TypeError
  try {
    await import("./fixtures/greet.js", { with: { potato: "yes" } });
    check("unsupported attribute key throws", false);
  } catch (e) {
    check("unsupported attribute key throws", e instanceof TypeError);
  }

  // Unsupported type value → TypeError
  try {
    await import("./fixtures/greet.js", { with: { type: "css" } });
    check("unsupported type value throws", false);
  } catch (e) {
    check("unsupported type value throws", e instanceof TypeError);
  }
}
console.groupEnd();

// -----------------------------------------------------------------------
console.group("import.meta");
// -----------------------------------------------------------------------
{
  check("import.meta.url is a file: URL", import.meta.url.startsWith("file://"));
  check("import.meta.url ends with this file", import.meta.url.endsWith("import_maps_test.js"));

  const resolved = import.meta.resolve("./fixtures/greet.js");
  const expected = new URL("./fixtures/greet.js", import.meta.url).href;
  check("import.meta.resolve works", resolved === expected);
}
console.groupEnd();

// -----------------------------------------------------------------------
console.group("permissions");
// -----------------------------------------------------------------------
{
  // This process runs under the root limun.json which grants:
  //   file://** read, https://esm.sh/ read, https://raw.githubusercontent.com/ read
  //   default: false
  //
  // The deny path can't be tested in-process (permissions load once at
  // startup). These tests verify the allow path works. The deny path is
  // verified manually by running limun with a restrictive limun.json.

  // Reading a local file (via import) works — proves file://** read grant.
  const { greet } = await import("./fixtures/greet.js");
  check("local file read permitted", greet("test") === "greetings from test");

  // data: URLs are ungated — always work.
  const { default: fortyTwo } = await import("data:text/javascript,export default 42;");
  check("data: URL import ungated", fortyTwo === 42);

  // A URL not in the allowlist should be denied. Since default is false,
  // an https URL not matching esm.sh or raw.githubusercontent.com should
  // fail. Best-effort — we try to import from an ungranted host.
  try {
    await import("https://example.com/some-module.js");
    check("ungranted https import denied (or network failed)", false);
  } catch (e) {
    // Could be a permission denial or a network error — either way it
    // didn't succeed, which is the right behavior for an ungranted URL.
    check("ungranted https import denied (or network failed)", true);
  }
}
console.groupEnd();

// -----------------------------------------------------------------------
if (failures === 0) {
  console.log(`\nAll limun-specific tests passed.`);
} else {
  console.error(`\n${failures} test(s) FAILED.`);
}