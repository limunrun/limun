// Quick URL smoke test — verifies the JS-on-ops URL module works end-to-end.
// Not a WPT harness; just sanity checks.

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

// --- URL constructor + getters -------------------------------------------
const u = new URL("https://user:pass@example.com:8080/foo/bar?baz=1#frag");
check("href", u.href, "https://user:pass@example.com:8080/foo/bar?baz=1#frag");
check("origin", u.origin, "https://example.com:8080");
check("protocol", u.protocol, "https:");
check("username", u.username, "user");
check("password", u.password, "pass");
check("host", u.host, "example.com:8080");
check("hostname", u.hostname, "example.com");
check("port", u.port, "8080");
check("pathname", u.pathname, "/foo/bar");
check("search", u.search, "?baz=1");
check("hash", u.hash, "#frag");
check("toString", u.toString(), u.href);
check("toJSON", u.toJSON(), u.href);

// --- URL with base -------------------------------------------------------
const u2 = new URL("/path", "https://example.com/base");
check("base.href", u2.href, "https://example.com/path");

// --- canParse / parse ----------------------------------------------------
check("canParse true", URL.canParse("https://example.com"), true);
check("canParse false", URL.canParse("not a url"), false);
check("canParse with base", URL.canParse("/x", "https://example.com"), true);
check("parse ok", URL.parse("https://example.com") instanceof URL, true);
check("parse fail", URL.parse("not a url"), null);

// --- setters -------------------------------------------------------------
const s = new URL("https://example.com/path");
s.protocol = "http:";
check("set protocol", s.href, "http://example.com/path");
s.host = "other.com:90";
check("set host", s.href, "http://other.com:90/path");
s.pathname = "/x/y";
check("set pathname", s.href, "http://other.com:90/x/y");
s.hash = "#h";
check("set hash", s.href, "http://other.com:90/x/y#h");
s.search = "?q=1";
check("set search", s.href, "http://other.com:90/x/y?q=1#h");
s.port = "";
check("set port empty", s.host, "other.com");
s.username = "bob";
check("set username", s.href, "http://bob@other.com/x/y?q=1#h");
s.password = "pw";
check("set password", s.href, "http://bob:pw@other.com/x/y?q=1#h");

// --- href setter throws TypeError on invalid -----------------------------
let threw = false;
try {
  new URL("not a url");
} catch (e) {
  threw = e instanceof TypeError;
}
check("ctor throws TypeError", threw, true);

threw = false;
try {
  const t = new URL("https://example.com");
  t.href = "not a url";
} catch (e) {
  threw = e instanceof TypeError;
}
check("href setter throws TypeError", threw, true);

// --- searchParams live linkage -------------------------------------------
const u3 = new URL("https://example.com/?a=1&b=2");
const sp = u3.searchParams;
check("sp.get", sp.get("a"), "1");
check("sp.get missing", sp.get("z"), null);
check("sp.getAll", sp.getAll("a").join(","), "1");
check("sp.has", sp.has("b"), true);
check("sp.has missing", sp.has("z"), false);
check("sp.size", sp.size, 2);

// Live: mutating searchParams updates URL.search/href
sp.append("c", "3");
check("append updates search", u3.search, "?a=1&b=2&c=3");
check("append updates href", u3.href, "https://example.com/?a=1&b=2&c=3");

sp.set("a", "9");
check("set updates search", u3.search, "?a=9&b=2&c=3");

sp.delete("b");
check("delete updates search", u3.search, "?a=9&c=3");

sp.sort();
check("sort", u3.search, "?a=9&c=3");

// Live: setting URL.search updates searchParams
u3.search = "?x=1&y=2";
check("search setter updates sp", sp.get("x"), "1");
check("search setter updates sp2", sp.get("y"), "2");
check("search setter updates sp3", sp.size, 2);

// Live: setting href updates searchParams
u3.href = "https://example.com/?p=1&q=2";
check("href setter updates sp", sp.get("p"), "1");
check("href setter updates sp2", sp.size, 2);

// --- URLSearchParams standalone ------------------------------------------
const params = new URLSearchParams("a=1&b=2&a=3");
check("standalone get", params.get("a"), "1");
check("standalone getAll", params.getAll("a").join(","), "1,3");
check("standalone size", params.size, 3);
check("standalone toString", params.toString(), "a=1&b=2&a=3");

// Construct from sequence
const seq = new URLSearchParams([["x", "1"], ["y", "2"]]);
check("seq toString", seq.toString(), "x=1&y=2");

// Construct from record
const rec = new URLSearchParams({ x: "1", y: "2" });
check("rec toString", rec.toString(), "x=1&y=2");

// --- iterators -----------------------------------------------------------
const it = new URLSearchParams("a=1&b=2");
const entries = [];
for (const [k, v] of it) {
  entries.push(k + "=" + v);
}
check("entries iterator", entries.join("&"), "a=1&b=2");

const keys = [];
for (const k of it.keys()) keys.push(k);
check("keys iterator", keys.join(","), "a,b");

const vals = [];
for (const v of it.values()) vals.push(v);
check("values iterator", vals.join(","), "1,2");

let forEachOut = [];
it.forEach((v, k) => forEachOut.push(k + "=" + v));
check("forEach", forEachOut.join("&"), "a=1&b=2");

// --- toStringTag ---------------------------------------------------------
check("URL toStringTag", URL.prototype[Symbol.toStringTag], "URL");
check("URLSearchParams toStringTag", URLSearchParams.prototype[Symbol.toStringTag], "URLSearchParams");

// --- empty search params toString ---------------------------------------
const empty = new URLSearchParams();
check("empty toString", empty.toString(), "");
check("empty size", empty.size, 0);

// --- leading ? stripped -------------------------------------------------
const q = new URLSearchParams("?a=1");
check("leading ? stripped", q.get("a"), "1");

// --- searchParams from URL.search (leading ?) ---------------------------
const u4 = new URL("https://example.com/?a=1");
const sp4 = new URLSearchParams(u4.search);
check("from search", sp4.get("a"), "1");

console.log(`\nURL smoke test: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  throw new Error(`${fail} URL smoke test failures`);
}