// Smoke test for the review-pass fixes: brand safety, DOMException, File,
// multipart FormData, Headers combining, Request/Response body mixins,
// ReadableStream async iteration, TextDecoder streaming, and the
// Response.error()/redirect() statics. Non-interactive, no network needed.
//
// Every assertion funnels through check() so one failure doesn't stop the
// rest. Exit-relevant failures are counted and printed at the end.

let failures = 0;
function check(name, cond) {
  console.assert(cond, name);
  if (!cond) failures++;
}
async function checkThrows(name, fn) {
  try {
    await fn();
    check(name + " (should throw)", false);
  } catch {
    check(name, true);
  }
}

// --------------------------------------------------------------------
console.group("brand safety — no cross-class type confusion");
// --------------------------------------------------------------------
{
  const u = new URL("https://example.com/a?x=1");
  // Feeding a URL where a Request/Headers/Blob is expected must NOT be
  // mistaken for one (previously this reinterpreted URL state as Request
  // state → UB). It should fall back to string coercion or be ignored.
  const r = new Request(u); // u stringifies to its href
  check("Request(URL) uses href", r.url === "https://example.com/a?x=1");

  const h = new Headers({ "x-test": "1" });
  const fd = new FormData();
  // append(name, URL/Headers) — not a Blob, so it becomes a string entry.
  fd.append("k", h);
  check("FormData.append(Headers) → string entry", typeof fd.get("k") === "string");

  const et = new EventTarget();
  // dispatchEvent(non-Event) must throw, not treat the URL as an Event.
  let threw = false;
  try { et.dispatchEvent(u); } catch { threw = true; }
  check("dispatchEvent(URL) throws", threw);
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("DOMException is a real class");
// --------------------------------------------------------------------
{
  const e = new DOMException("nope", "DataError");
  check("instanceof DOMException", e instanceof DOMException);
  check("instanceof Error", e instanceof Error);
  check("name", e.name === "DataError");
  check("message", e.message === "nope");
  check("legacy constant", DOMException.INVALID_STATE_ERR === 11);
  check("code from legacy name", new DOMException("x", "AbortError").code === 20);
  check("code 0 for modern name", e.code === 0);
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("File extends Blob");
// --------------------------------------------------------------------
{
  const f = new File(["hello ", "world"], "greeting.txt", { type: "text/plain", lastModified: 42 });
  check("instanceof File", f instanceof File);
  check("instanceof Blob", f instanceof Blob);
  check("name", f.name === "greeting.txt");
  check("size", f.size === 11);
  check("type", f.type === "text/plain");
  check("lastModified", f.lastModified === 42);
  check("File requires name", (() => { try { new File([]); return false; } catch { return true; } })());
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("Headers combining");
// --------------------------------------------------------------------
{
  const h = new Headers();
  h.append("x-a", "1");
  h.append("x-a", "2");
  check("get combines duplicates", h.get("x-a") === "1, 2");
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  check("getSetCookie keeps separate", h.getSetCookie().length === 2);
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("Response statics + null-body semantics");
// --------------------------------------------------------------------
{
  const err = Response.error();
  check("error() type", err.type === "error");
  check("error() status 0", err.status === 0);
  check("error() bodyUsed false", err.bodyUsed === false);
  check("error() body null", err.body === null);

  const red = Response.redirect("https://example.com/x", 301);
  check("redirect() status", red.status === 301);
  check("redirect() location", red.headers.get("location") === "https://example.com/x");
  check("redirect() bad status throws", (() => {
    try { Response.redirect("https://e.com", 200); return false; } catch { return true; }
  })());

  const empty = new Response();
  check("empty Response body null", empty.body === null);
  check("empty Response status range throws", (() => {
    try { new Response("x", { status: 999 }); return false; } catch { return true; }
  })());
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("Request body mixin");
// --------------------------------------------------------------------
{
  const r = new Request("https://example.com/", { method: "POST", body: "payload" });
  check("bodyUsed starts false", r.bodyUsed === false);
  check("GET with body throws", (() => {
    try { new Request("https://e.com/", { method: "GET", body: "x" }); return false; } catch { return true; }
  })());
  // clone before reading, then read the clone
  const clone = r.clone();
  await r.text().then((t) => check("Request.text()", t === "payload"));
  check("bodyUsed true after read", r.bodyUsed === true);
  await checkThrows("clone() after read throws", async () => r.clone());
  await clone.text().then((t) => check("clone body independent", t === "payload"));
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("multipart FormData round-trip via Request.formData()");
// --------------------------------------------------------------------
{
  const boundary = "----limunTest";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="field1"\r\n\r\n` +
    `value1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file1"; filename="a.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `file contents\r\n` +
    `--${boundary}--\r\n`;
  const req = new Request("https://example.com/", {
    method: "POST",
    body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  const fd = await req.formData();
  check("multipart text field", fd.get("field1") === "value1");
  const file = fd.get("file1");
  check("multipart file is File", file instanceof File);
  check("multipart file name", file && file.name === "a.txt");
  await file.text().then((t) => check("multipart file body", t === "file contents"));
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("ReadableStream async iteration");
// --------------------------------------------------------------------
{
  const rs = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("ab"));
      c.enqueue(new TextEncoder().encode("cd"));
      c.close();
    },
  });
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of rs) {
    out += dec.decode(chunk, { stream: true });
  }
  out += dec.decode();
  check("for-await over stream", out === "abcd");
}
console.groupEnd();

// --------------------------------------------------------------------
console.group("TextDecoder streaming across a split multi-byte char");
// --------------------------------------------------------------------
{
  // "€" is E2 82 AC in UTF-8. Feed it split across two chunks.
  const dec = new TextDecoder();
  const part1 = dec.decode(new Uint8Array([0xe2, 0x82]), { stream: true });
  const part2 = dec.decode(new Uint8Array([0xac]));
  check("split char yields nothing early", part1 === "");
  check("split char completes", part2 === "\u20ac");
}
console.groupEnd();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
