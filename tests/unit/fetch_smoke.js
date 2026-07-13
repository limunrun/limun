// Focused smoke test for the fetch module JS migration (Headers/
// Request/Response/fetch — `src/js/{19_body,20_headers,21_request,
// 22_response,23_fetch}.js`).
//
// Runs unattended; exits 0 if all checks pass. Real-network checks
// (fetch() against `esm.sh`, permitted by this repo's `limun.json`) are
// best-effort: if genuinely unreachable, they're skipped with a
// console.warn rather than failing the run — mirrors `smoke_test.js`.

let failures = 0;
function check(name, condition) {
  console.assert(condition, name);
  if (!condition) failures++;
}
async function checkThrows(name, fn, ctor) {
  try {
    await fn();
    check(name, false);
  } catch (e) {
    check(name, ctor === undefined || e instanceof ctor);
  }
}

// =========================================================================
console.group("Headers");
// =========================================================================
{
  check("Headers is a constructor", typeof Headers === "function");
  try {
    Headers();
    check("Headers() without new throws", false);
  } catch (e) {
    check("Headers() without new throws TypeError", e instanceof TypeError);
  }

  // Construction: array of pairs, record, another Headers.
  const fromArray = new Headers([["Content-Type", "text/plain"], ["X-A", "1"]]);
  check("from array: normalizes name to lowercase", fromArray.get("content-type") === "text/plain");
  check("from array: X-A", fromArray.get("x-a") === "1");

  const fromRecord = new Headers({ "X-B": "2" });
  check("from record", fromRecord.get("x-b") === "2");

  const fromHeaders = new Headers(fromArray);
  check("from Headers instance copies entries", fromHeaders.get("content-type") === "text/plain");
  fromHeaders.set("x-a", "mutated");
  check("from Headers instance is an independent copy", fromArray.get("x-a") === "1");

  const empty = new Headers();
  check("no-arg construction is empty", empty.get("anything") === null);

  // append/delete/get/has/set.
  const h = new Headers({ "Content-Type": "text/plain", "X-Foo": "bar" });
  check("get() normalizes lookup name", h.get("CONTENT-TYPE") === "text/plain");
  h.append("X-Foo", "baz");
  check("append() combines on read with ', '", h.get("x-foo") === "bar, baz");
  check("has() true", h.has("x-foo") === true);
  check("has() false", h.has("nope") === false);
  h.delete("x-foo");
  check("delete()", h.get("x-foo") === null);
  check("has() false after delete", h.has("x-foo") === false);
  h.set("x-foo", "only");
  check("set() replaces (not combine)", h.get("x-foo") === "only");
  h.set("x-foo", "replaced-again");
  check("set() twice still one value", h.get("x-foo") === "replaced-again");

  // getSetCookie — never combined.
  const cookies = new Headers();
  cookies.append("Set-Cookie", "a=1");
  cookies.append("Set-Cookie", "b=2");
  check("getSetCookie() returns each separately", cookies.getSetCookie().length === 2);
  check("getSetCookie() preserves insertion order", cookies.getSetCookie()[0] === "a=1" && cookies.getSetCookie()[1] === "b=2");
  check("get('set-cookie') still combines (spec quirk, matches browsers)",
    cookies.get("set-cookie") === "a=1, b=2");

  // Iteration: sorted by name, combined values, entries/keys/values/forEach/@@iterator.
  const it = new Headers([["b", "2"], ["a", "1"], ["a", "3"]]);
  const entries = [...it.entries()];
  check("entries() sorted by name", entries[0][0] === "a" && entries[1][0] === "b");
  check("entries() combines same-name values", entries[0][1] === "1, 3");
  check("keys()", [...it.keys()].join(",") === "a,b");
  check("values()", [...it.values()].join(",") === "1, 3,2");
  check("[Symbol.iterator] === entries()", typeof it[Symbol.iterator] === "function");
  const viaForOf = [];
  for (const [k, v] of it) viaForOf.push(`${k}=${v}`);
  check("for...of iterates like entries()", viaForOf.join(";") === "a=1, 3;b=2");
  let forEachCount = 0;
  it.forEach((value, key, target) => {
    forEachCount++;
    check("forEach() 3rd arg is the Headers itself", target === it);
  });
  check("forEach() visits every (combined) entry", forEachCount === 2);

  // Required-argument / illegal-invocation checks.
  await checkThrows("get() with 0 args throws", () => h.get(), TypeError);
  await checkThrows("append() with 1 arg throws", () => h.append("x"), TypeError);
  await checkThrows("Headers method called on plain object throws", () => Headers.prototype.get.call({}, "x"), TypeError);
}
console.groupEnd();

// =========================================================================
console.group("Request");
// =========================================================================
{
  check("Request is a constructor", typeof Request === "function");
  await checkThrows("new Request() with 0 args throws", () => new Request(), TypeError);
  await checkThrows("new Request(invalid url) throws", () => new Request("not a url"), TypeError);

  const req = new Request("https://example.com/path", {
    method: "post",
    headers: { "X-Test": "1" },
    body: "hello",
  });
  check("Request.method is uppercased", req.method === "POST");
  check("Request.url", req.url === "https://example.com/path");
  check("Request.headers is a real Headers", req.headers instanceof Headers);
  check("Request.headers reflects init", req.headers.get("x-test") === "1");
  check("Request.bodyUsed starts false", req.bodyUsed === false);
  check("Request.signal is undefined by default", req.signal === undefined);

  // GET/HEAD + body throws.
  await checkThrows(
    "GET with body throws TypeError",
    () => new Request("https://example.com/", { method: "GET", body: "x" }),
    TypeError,
  );
  await checkThrows(
    "HEAD with body throws TypeError",
    () => new Request("https://example.com/", { method: "HEAD", body: "x" }),
    TypeError,
  );
  // Bodyless GET is fine.
  const getReq = new Request("https://example.com/");
  check("default method is GET", getReq.method === "GET");
  check("GET request has null body", getReq.body === null);
  check("GET request bodyUsed is false", getReq.bodyUsed === false);
  check("GET request .text() resolves empty", (await getReq.text()) === "");

  // Body mixin + bodyUsed transition + re-read throws.
  const reqText = await req.text();
  check("Request.text()", reqText === "hello");
  check("Request.bodyUsed after text()", req.bodyUsed === true);
  await checkThrows("re-reading a consumed Request body throws", () => req.text(), TypeError);

  // clone().
  const req2 = new Request("https://example.com/", { method: "POST", headers: { "x-test": "1" }, body: "body" });
  const cloned = req2.clone();
  check("clone() is a different object", cloned !== req2);
  check("clone() copies method", cloned.method === "POST");
  check("clone() copies headers (independent Headers instance)", cloned.headers.get("x-test") === "1");
  cloned.headers.set("x-test", "mutated");
  check("clone()'s Headers is independent", req2.headers.get("x-test") === "1");
  check("clone() copies body independently", (await cloned.text()) === "body");
  check("cloning doesn't disturb the original", req2.bodyUsed === false);
  check("original body still readable after clone()", (await req2.text()) === "body");

  // clone() on a disturbed body throws.
  const req3 = new Request("https://example.com/", { method: "POST", body: "x" });
  await req3.text();
  await checkThrows("clone() on a disturbed body throws", () => req3.clone(), TypeError);

  // Request from Request (clone-with-override) inherits then overrides.
  const base = new Request("https://example.com/base", { headers: { "x-a": "1" } });
  const derived = new Request(base, { method: "POST", body: "override" });
  check("Request(Request) inherits url", derived.url === base.url);
  check("Request(Request) inherits headers", derived.headers.get("x-a") === "1");
  check("Request(Request, init) applies init overrides", derived.method === "POST");
  check("Request(Request, init) body override", (await derived.text()) === "override");

  // signal: inherited from a Request input, overridden by init.signal,
  // untouched when init has no signal key at all (bug fix vs. the
  // previous Rust behavior — see 21_request.js's file header comment).
  const ac = new AbortController();
  const withSignal = new Request("https://example.com/", { signal: ac.signal });
  check("Request captures init.signal", withSignal.signal === ac.signal);
  const inheritedNoInit = new Request(withSignal);
  check("Request(Request) inherits signal (no init)", inheritedNoInit.signal === ac.signal);
  const inheritedWithInit = new Request(withSignal, { method: "POST" });
  check(
    "Request(Request, init-without-signal-key) still inherits signal",
    inheritedWithInit.signal === ac.signal,
  );
  const ac2 = new AbortController();
  const overridden = new Request(withSignal, { signal: ac2.signal });
  check("Request(Request, init.signal) overrides", overridden.signal === ac2.signal);
  const cleared = new Request(withSignal, { signal: null });
  check("Request(Request, {signal:null}) clears the signal", cleared.signal === undefined);

  // .body is a ReadableStream, identity-stable.
  const reqStream = new Request("https://example.com/", { method: "POST", body: "stream-me" });
  check("Request.body is a ReadableStream", reqStream.body instanceof ReadableStream);
  check("Request.body identity stable across reads", reqStream.body === reqStream.body);
}
console.groupEnd();

// =========================================================================
console.group("Response");
// =========================================================================
{
  check("Response is a constructor", typeof Response === "function");

  const r = new Response("hello world", {
    status: 201,
    statusText: "Created",
    headers: { "x-test": "1" },
  });
  check("status/statusText/ok", r.status === 201 && r.statusText === "Created" && r.ok === true);
  check("headers reflects init", r.headers.get("x-test") === "1");
  check("type is basic", r.type === "basic");
  check("url defaults to empty string", r.url === "");
  check("redirected defaults to false", r.redirected === false);
  check("bodyUsed starts false", r.bodyUsed === false);
  check("text()", (await r.text()) === "hello world");
  check("bodyUsed after text()", r.bodyUsed === true);
  await checkThrows("re-reading a consumed Response body throws", () => r.text(), TypeError);

  // Status range validation.
  await checkThrows("status < 200 throws RangeError", () => new Response("x", { status: 100 }), RangeError);
  await checkThrows("status > 599 throws RangeError", () => new Response("x", { status: 600 }), RangeError);
  await checkThrows("NaN status throws RangeError", () => new Response("x", { status: NaN }), RangeError);
  const okStatus = new Response(null, { status: 200 });
  check("status 200 is fine", okStatus.status === 200);

  // Null-body statuses reject a non-null body.
  for (const s of [204, 205, 304]) {
    await checkThrows(`status ${s} + body throws TypeError`, () => new Response("x", { status: s }), TypeError);
  }
  const noBody = new Response(null, { status: 204 });
  check("status 204 with null body constructs fine", noBody.status === 204);
  check("null-body Response.body is null", noBody.body === null);
  check("null-body Response.bodyUsed is false", noBody.bodyUsed === false);
  check("null-body Response.text() resolves empty", (await noBody.text()) === "");

  // .ok for non-2xx.
  check(".ok is false for 4xx", new Response("x", { status: 404 }).ok === false);
  check(".ok is false for 3xx", new Response("x", { status: 301 }).ok === false);
  check(".ok is true for 2xx boundaries", new Response("x", { status: 200 }).ok === true && new Response("x", { status: 299 }).ok === true);

  // Body mixin: json/arrayBuffer/blob round trips.
  const rJson = new Response(JSON.stringify({ a: 1, b: [1, 2, 3] }));
  const parsed = await rJson.json();
  check("Response.json() round trip", parsed.a === 1 && parsed.b.length === 3);

  const rBuf = new Response(new Uint8Array([1, 2, 3, 255]));
  const ab = await rBuf.arrayBuffer();
  check("Response.arrayBuffer() is an ArrayBuffer", ab instanceof ArrayBuffer);
  check("Response.arrayBuffer() bytes round trip", new Uint8Array(ab).join(",") === "1,2,3,255");

  const rBlob = new Response("blob body", { headers: { "content-type": "text/plain" } });
  const blob = await rBlob.blob();
  check("Response.blob() is a Blob", blob instanceof Blob);
  check("Response.blob() carries content-type", blob.type === "text/plain");
  check("Response.blob() text round trip", (await blob.text()) === "blob body");

  // formData(): application/x-www-form-urlencoded.
  const rForm = new Response("name=limun&lang=rust%2Bjs", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const fd = await rForm.formData();
  check("formData() urlencoded name", fd.get("name") === "limun");
  check("formData() urlencoded percent-decoding", fd.get("lang") === "rust+js");

  // formData(): multipart/form-data (build the body by hand).
  const boundary = "----limunTestBoundary";
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="field1"\r\n\r\n` +
    `value1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file1"; filename="a.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `file contents\r\n` +
    `--${boundary}--\r\n`;
  const rMultipart = new Response(multipartBody, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  const fdMultipart = await rMultipart.formData();
  check("multipart formData() text field", fdMultipart.get("field1") === "value1");
  const fileEntry = fdMultipart.get("file1");
  check("multipart formData() file field is a File", fileEntry instanceof File);
  check("multipart formData() file name", fileEntry.name === "a.txt");
  check("multipart formData() file type", fileEntry.type === "text/plain");
  check("multipart formData() file contents", (await fileEntry.text()) === "file contents");

  // multipart without a boundary parameter rejects without consuming the body.
  const rNoBoundary = new Response("irrelevant", { headers: { "content-type": "multipart/form-data" } });
  await checkThrows("multipart without boundary rejects", () => rNoBoundary.formData(), TypeError);
  check("rejecting for missing boundary doesn't mark bodyUsed", rNoBoundary.bodyUsed === false);

  // Unsupported content-type rejects.
  const rBadType = new Response("x", { headers: { "content-type": "application/octet-stream" } });
  await checkThrows("formData() with unsupported content-type rejects", () => rBadType.formData(), TypeError);

  // clone().
  const rClone = new Response("clone me", { status: 201, headers: { "x-a": "1" } });
  const rCloned = rClone.clone();
  check("clone() is a different object", rCloned !== rClone);
  check("clone() copies status", rCloned.status === 201);
  rCloned.headers.set("x-a", "mutated");
  check("clone()'s Headers is independent", rClone.headers.get("x-a") === "1");
  check("clone() and original both independently readable", (await rCloned.text()) === "clone me");
  check("cloning doesn't disturb the original", rClone.bodyUsed === false);
  check("original still readable after clone()", (await rClone.text()) === "clone me");

  const rDisturbed = new Response("x");
  await rDisturbed.text();
  await checkThrows("clone() on a disturbed body throws", () => rDisturbed.clone(), TypeError);

  // .body is a ReadableStream, identity-stable, disturbs bodyUsed on read.
  const rStream = new Response("stream body");
  check("Response.body is a ReadableStream", rStream.body instanceof ReadableStream);
  check("Response.body identity stable across reads", rStream.body === rStream.body);
  const reader = rStream.body.getReader();
  check("bodyUsed becomes true once body stream is locked", rStream.bodyUsed === true);
  let streamed = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    streamed += decoder.decode(value);
  }
  check("Response.body stream yields the full content", streamed === "stream body");

  // Static helpers.
  const rStaticJson = Response.json({ hello: "world" }, { status: 202 });
  check("Response.json() static: status", rStaticJson.status === 202);
  check("Response.json() static: content-type", rStaticJson.headers.get("content-type") === "application/json");
  check("Response.json() static: body", (await rStaticJson.text()) === '{"hello":"world"}');

  const rError = Response.error();
  check("Response.error(): status 0", rError.status === 0);
  check("Response.error(): type is error", rError.type === "error");
  check("Response.error(): null body", rError.body === null);

  const rRedirect = Response.redirect("https://example.com/target", 301);
  check("Response.redirect(): status", rRedirect.status === 301);
  check("Response.redirect(): statusText", rRedirect.statusText === "Moved Permanently");
  check("Response.redirect(): Location header", rRedirect.headers.get("location") === "https://example.com/target");
  await checkThrows(
    "Response.redirect() with an invalid status throws RangeError",
    () => Response.redirect("https://example.com/", 200),
    RangeError,
  );
  await checkThrows(
    "Response.redirect() with an invalid URL throws TypeError",
    () => Response.redirect("not a url"),
    TypeError,
  );
}
console.groupEnd();

// =========================================================================
console.group("fetch()");
// =========================================================================
{
  check("fetch is a function", typeof fetch === "function");
  await checkThrows("fetch() with 0 args rejects", () => fetch(), TypeError);
  await checkThrows("fetch(malformed url) rejects with TypeError", () => fetch("not a url"), TypeError);

  // Permission-denied host (this repo's limun.json only grants
  // esm.sh/raw.githubusercontent.com — see limun.json's permissions.io).
  await checkThrows(
    "fetch() to a permission-denied host rejects with TypeError",
    () => fetch("https://example.com/"),
    TypeError,
  );

  // Genuine network failure (unresolvable host) rejects.
  await checkThrows(
    "fetch() genuine network failure rejects with TypeError",
    () => fetch("https://this-host-should-not-resolve-abcxyz.invalid/"),
    TypeError,
  );

  try {
    const p = fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    check("fetch() returns a pending Promise", p instanceof Promise);
    const res = await p;
    check("fetch(): real request resolves with Response", res instanceof Response);
    check("fetch(): .ok is true", res.ok === true);
    check("fetch(): .status is a number", typeof res.status === "number");
    check("fetch(): .url is the (possibly redirected) final URL", typeof res.url === "string" && res.url.length > 0);
    check("fetch(): .redirected is a boolean", typeof res.redirected === "boolean");
    const body = await res.text();
    check("fetch(): response body is non-empty text", body.length > 0);

    // Non-2xx resolves, never rejects.
    const res404 = await fetch("https://esm.sh/this-definitely-does-not-exist-12345");
    check("fetch(): non-2xx resolves (not rejects)", res404.ok === false && res404.status === 404);

    // fetch(Request) — body is peeked non-destructively (doesn't mark
    // the Request's own bodyUsed).
    const getRequest = new Request("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    const viaRequest = await fetch(getRequest);
    check("fetch(Request) resolves", viaRequest.ok === true);
    check("fetch(Request) doesn't disturb the Request's body", getRequest.bodyUsed === false);
    // Same Request object can be fetched twice.
    const viaRequestAgain = await fetch(getRequest);
    check("fetch(Request) can be reused", viaRequestAgain.ok === true);

    // AbortSignal: pre-aborted rejects immediately with the reason.
    const ac1 = new AbortController();
    const reason = new Error("custom abort reason");
    ac1.abort(reason);
    await checkThrows(
      "fetch() with pre-aborted signal rejects",
      () => fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac1.signal }),
    );
    try {
      await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac1.signal });
    } catch (e) {
      check("fetch() pre-aborted rejects with the exact reason", e === reason);
    }

    // Abort during a pending fetch rejects with the reason, and the
    // event loop isn't blocked waiting on the network (a timer set
    // for later still fires before the (aborted) fetch would complete).
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 10);
    await checkThrows(
      "fetch() aborted mid-flight rejects",
      () => fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac2.signal }),
    );

    // Request carries its inherited signal into fetch().
    const ac3 = new AbortController();
    const reqWithSignal = new Request("https://esm.sh/lodash-es@4.17.21/isEqual.js", { signal: ac3.signal });
    ac3.abort();
    await checkThrows(
      "fetch(Request-with-aborted-signal) rejects",
      () => fetch(reqWithSignal),
    );

    // Response.body streaming from a real fetch.
    const resStream = await fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js");
    check("fetch() Response.body is a ReadableStream", resStream.body instanceof ReadableStream);
    const reader = resStream.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
    }
    check("fetch() Response.body stream has content", total > 0);
  } catch (e) {
    console.warn("fetch() network checks skipped (no network?):", e.message);
  }
}
console.groupEnd();

// ---------------------------------------------------------------------
if (failures === 0) {
  console.log("\nall fetch/Headers/Request/Response checks passed");
} else {
  throw new Error(`${failures} fetch check(s) failed`);
}
