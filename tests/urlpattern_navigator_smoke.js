// URLPattern + navigator smoke test — verifies the globals are installed and
// behave as expected. Not a WPT harness; just sanity checks.

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = String(actual);
  const e = String(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

// --- URLPattern constructor ------------------------------------------------
const p = new URLPattern({ pathname: "/*" });
check("URLPattern exists", typeof URLPattern, "function");
check("pathname getter", p.pathname, "/*");
check("test", p.test("https://example.com/foo"), true);
check("test root", p.test("https://example.com"), true);
check("exec pathname", p.exec("https://example.com/bar")?.pathname.groups[0], "bar");

const p2 = new URLPattern("https://example.com/:name/*");
check("string ctor", p2.test("https://example.com/alice/bob"), true);
check("exec named group", p2.exec("https://example.com/alice/bob")?.pathname.groups.name, "alice");

const p3 = new URLPattern({ pathname: "/api/:version/users" });
check("dict pathname", p3.test("https://x.com/api/v2/users"), true);
check("dict pathname no match", p3.test("https://x.com/api/v2/admins"), false);

// --- URLPattern RegExp groups --------------------------------------------
const p4 = new URLPattern({ pathname: "/(\\d+)" });
const m = p4.exec("https://x.com/42");
check("regexp group", m?.pathname.groups[0], "42");
check("hasRegExpGroups", p4.hasRegExpGroups, true);
check("no hasRegExpGroups", p.hasRegExpGroups, false);

// --- URLPattern errors -----------------------------------------------------
let threw = false;
try {
  new URLPattern({ protocol: "a b" });
} catch (e) {
  threw = e instanceof TypeError;
}
check("invalid protocol throws TypeError", threw, true);

// --- navigator --------------------------------------------------------------
check("navigator exists", typeof navigator === "object" || typeof navigator === "function", true);
check("navigator.userAgent", navigator.userAgent, "Limun/0.0.1");
check("navigator.language", navigator.language, "en-US");
check("navigator.languages[0]", navigator.languages[0], "en-US");
check("navigator.onLine", navigator.onLine, true);
check("navigator.hardwareConcurrency > 0", navigator.hardwareConcurrency > 0, true);
check("navigator.platform string", typeof navigator.platform, "string");

if (fail === 0) {
  console.log(`All ${pass} checks passed`);
} else {
  console.log(`${pass} passed, ${fail} failed`);
  throw new Error("Smoke test failed");
}
