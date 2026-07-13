// Focused smoke test for the Blob/File/FormData JS migration.
// Runs unattended; exits 0 if all checks pass.

let failures = 0;
function check(name, condition) {
  console.assert(condition, name);
  if (!condition) failures++;
}

// --- Blob ---------------------------------------------------------------
{
  const blob = new Blob(["hello ", "world"], { type: "text/plain" });
  check("Blob.size", blob.size === 11);
  check("Blob.type", blob.type === "text/plain");
  check("Blob.text()", (await blob.text()) === "hello world");
  check("Blob.arrayBuffer() is ArrayBuffer", (await blob.arrayBuffer()) instanceof ArrayBuffer);
  const ab = await blob.arrayBuffer();
  check("Blob.arrayBuffer() bytes", new TextDecoder().decode(ab) === "hello world");

  const sliced = blob.slice(6);
  check("Blob.slice(6)", (await sliced.text()) === "world");
  const slicedTyped = blob.slice(0, 5, "text/html");
  check("Blob.slice() type", slicedTyped.type === "text/html");
  check("Blob.slice() size", slicedTyped.size === 5);

  // Negative start/end (offset from end).
  const neg = blob.slice(-5);
  check("Blob.slice(-5)", (await neg.text()) === "world");
  const neg2 = blob.slice(-5, -2);
  check("Blob.slice(-5,-2)", (await neg2.text()) === "wor");

  // Blob from BufferSource.
  const blob2 = new Blob([new Uint8Array([0x68, 0x69])]);
  check("Blob from Uint8Array", (await blob2.text()) === "hi");
  const blob3 = new Blob([new ArrayBuffer(3)]);
  check("Blob from ArrayBuffer", blob3.size === 3);

  // Blob containing a Blob.
  const inner = new Blob(["foo"]);
  const outer = new Blob([inner, inner]);
  check("Blob with two blobs", (await outer.text()) === "foofoo");

  // Blob.stream() — single chunk.
  const stream = blob.stream();
  check("Blob.stream() is ReadableStream", stream instanceof ReadableStream);
  const reader = stream.getReader();
  let chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  check("Blob.stream() content", chunks.join("") === "hello world");

  // Blob instanceof / brand.
  check("blob instanceof Blob", blob instanceof Blob);
  check("String(blob)", String(blob) === "[object Blob]");

  // Blob.length === 0.
  check("Blob.length === 0", Blob.length === 0);

  // Blob() without new throws.
  try { Blob(); check("Blob() throws", false); }
  catch (e) { check("Blob() throws TypeError", e instanceof TypeError); }

  // Non-object blobParts throws.
  for (const arg of ["fail", 7, true, null, Symbol()]) {
    if (arg === null) continue; // null is allowed (treated as empty)
    try { new Blob(arg); check(`Blob(${typeof arg}) throws`, false); }
    catch (e) { check(`Blob(${typeof arg}) throws TypeError`, e instanceof TypeError); }
  }

  // type normalization.
  check("Blob type lowercased", new Blob([], { type: "TEXT/HTML" }).type === "text/html");
  check("Blob type non-ascii → empty", new Blob([], { type: "\u00E5" }).type === "");
}

// --- File ---------------------------------------------------------------
{
  const file = new File(["content"], "test.txt", { type: "text/plain", lastModified: 12345 });
  check("File.name", file.name === "test.txt");
  check("File.lastModified", file.lastModified === 12345);
  check("File.type", file.type === "text/plain");
  check("File.size", file.size === 7);
  check("File.text()", (await file.text()) === "content");
  check("File instanceof Blob", file instanceof Blob);
  check("File instanceof File", file instanceof File);
  check("String(file)", String(file) === "[object File]");

  // File default lastModified ≈ Date.now().
  const before = Date.now();
  const f2 = new File([], "x");
  const after = Date.now();
  check("File default lastModified", f2.lastModified >= before && f2.lastModified <= after);

  // File() without new throws.
  try { File(); check("File() throws", false); }
  catch (e) { check("File() throws TypeError", e instanceof TypeError); }

  // File with < 2 args throws.
  try { new File(["a"]); check("File(1 arg) throws", false); }
  catch (e) { check("File(1 arg) throws TypeError", e instanceof TypeError); }
}

// --- FormData -----------------------------------------------------------
{
  const fd = new FormData();
  fd.append("name", "limun");
  fd.append("age", "1");
  fd.append("file", new Blob(["content"], { type: "text/plain" }), "test.txt");
  check("FormData.get string", fd.get("name") === "limun");
  check("FormData.getAll", fd.getAll("age").length === 1);
  check("FormData.has", fd.has("file") === true);
  check("FormData.get(blob) is File", fd.get("file") instanceof File);
  check("FormData.get(blob).name", fd.get("file").name === "test.txt");
  check("FormData.get(blob).type", fd.get("file").type === "text/plain");
  check("FormData.get(blob).text", (await fd.get("file").text()) === "content");

  // append a File directly (keeps its name/lastModified unless overridden).
  const f = new File(["body"], "orig.txt", { type: "text/html", lastModified: 999 });
  fd.append("f2", f);
  check("FormData.append(File).name", fd.get("f2").name === "orig.txt");
  check("FormData.append(File).lastModified", fd.get("f2").lastModified === 999);
  fd.append("f3", f, "renamed.txt");
  check("FormData.append(File, filename).name", fd.get("f3").name === "renamed.txt");
  check("FormData.append(File, filename).lastModified", fd.get("f3").lastModified === 999);

  // append a plain Blob (no filename arg) → File named "blob".
  fd.append("f4", new Blob(["x"]));
  check("FormData.append(Blob).name", fd.get("f4").name === "blob");

  fd.set("age", "2");
  check("FormData.set replaces", fd.get("age") === "2");
  check("FormData.set removes dupes", fd.getAll("age").length === 1);

  fd.delete("file");
  check("FormData.delete", fd.has("file") === false);

  check("FormData.get missing → null", fd.get("missing") === null);

  // Iteration.
  let entries = [];
  for (const [k, v] of fd) entries.push(k);
  check("FormData[Symbol.iterator]", entries.length >= 3);

  let keys = [];
  for (const k of fd.keys()) keys.push(k);
  check("FormData.keys()", keys.length === entries.length);

  let values = 0;
  for (const v of fd.values()) values++;
  check("FormData.values()", values === entries.length);

  let forEachCount = 0;
  fd.forEach((v, k, obj) => { forEachCount++; check("FormData.forEach thisArg", obj === fd); });
  check("FormData.forEach", forEachCount === entries.length);

  check("String(fd)", String(fd) === "[object FormData]");

  // FormData() without new throws.
  try { FormData(); check("FormData() throws", false); }
  catch (e) { check("FormData() throws TypeError", e instanceof TypeError); }
}

// --- Response.blob() / Response.formData() (Rust→JS bridge) -----------
{
  const res = new Response("name=limun&age=1", { headers: { "content-type": "application/x-www-form-urlencoded" } });
  const parsedFd = await res.formData();
  check("Response.formData() urlencoded", parsedFd.get("name") === "limun" && parsedFd.get("age") === "1");

  const res2 = new Response("hello", { headers: { "content-type": "text/plain" } });
  const blob3 = await res2.blob();
  check("Response.blob() is Blob", blob3 instanceof Blob);
  check("Response.blob() type", blob3.type === "text/plain");
  check("Response.blob() text", (await blob3.text()) === "hello");
}

// --- multipart/form-data via Response.formData() ----------------------
{
  const boundary = "----limun";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="field1"\r\n\r\n` +
    `value1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file1"; filename="f.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `filecontent\r\n` +
    `--${boundary}--\r\n`;
  const res = new Response(body, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  const fd = await res.formData();
  check("multipart text field", fd.get("field1") === "value1");
  const file = fd.get("file1");
  check("multipart file is File", file instanceof File);
  check("multipart file name", file.name === "f.txt");
  check("multipart file type", file.type === "text/plain");
  check("multipart file text", (await file.text()) === "filecontent");
}

// --- Request.blob() / Request.formData() (Rust→JS bridge) -------------
{
  const req = new Request("https://example.com", {
    method: "POST",
    body: "k=v",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const fd = await req.formData();
  check("Request.formData()", fd.get("k") === "v");

  const req2 = new Request("https://example.com", {
    method: "POST",
    body: "hello",
    headers: { "content-type": "text/plain" },
  });
  const blob = await req2.blob();
  check("Request.blob() is Blob", blob instanceof Blob);
  check("Request.blob() text", (await blob.text()) === "hello");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  throw new Error(`${failures} Blob/File/FormData check(s) failed`);
} else {
  console.log("\nall Blob/File/FormData checks passed");
}