// Runs Web Platform Tests against limun. Usage:
//
//   cargo run -- tests/wpt/run.js                  (default subset)
//   cargo run -- tests/wpt/run.js -- --suite=fetch  (specific suite)
//   cargo run -- tests/wpt/run.js -- --all          (everything — slow)
//
// How this works without any limun-specific test-runner code:
//
// testharness.js is a plain classic script (an IIFE assigning to `self`),
// not an ES module — that's deliberate upstream, so it can be dropped into
// any JS context via `<script src=testharness.js>`. limun only executes
// real ESM, so instead of `import`-ing these files as modules (which would
// scope their declarations to the module, invisible to each other — not
// what a concatenated multi-<script> WPT page does), we:
//
//   1. Pull each file's *source text* through the module loader using the
//      `{ with: { type: "text" } }` import attribute.
//   2. Run that source through an *indirect* eval (`(0, eval)(src)`), which
//      per spec executes as a non-strict global Script, not a module — so
//      top-level `function`/`var` declarations become real `globalThis`
//      properties, exactly like a browser's `<script>` concatenation model.
//      This is what makes `testharness.js`'s `ShellTestEnvironment` (its
//      no-DOM code path) the right fit here.
//
// All test files run in one shared realm/harness instance (one `tests`
// singleton), same as several `<script>` tags on one WPT page.
// testharness.js auto-completes once every registered test has settled and
// the environment reports "loaded" — which can race *between* sequentially
// loaded files. `setup({ explicit_done: true })` blocks that; some files
// also call the harness's own `done()` themselves — neutered while loading
// and the real one is called only after everything is in.

const here = new URL(".", import.meta.url);
const suite = new URL("./suite/", here);

// Parse simple args: --suite=<name> or --all
const args = globalThis.__limunArgs || [];
let runAll = false;
let suiteFilter = null;
for (const arg of args) {
  if (arg === "--all") runAll = true;
  else if (arg.startsWith("--suite=")) suiteFilter = arg.slice(8);
}

async function loadScript(relPath) {
  const mod = await import(new URL(relPath, here).href, { with: { type: "text" } });
  // Track the current script's URL so `fetch_json` can resolve relative
  // resources against it (matching a browser's document-base resolution).
  currentScriptUrl = new URL(relPath, here).href;
  (0, eval)(mod.default);
}

// `// META: script=<path>` directives in a WPT `.any.js` file name
// preamble scripts that must be loaded (in order, in the same global
// scope) *before* the test file itself — they define helpers the test
// file calls (`test_blob`, `abortSignalAnyTests`, …). The path is
// resolved relative to the test file's directory (matching the WPT
// convention). Extracted from comment lines at the top of the file.
const META_SCRIPT_PATTERN = /^\/\/\s*META:\s*script=(.+?)\s*$/gm;
async function loadAnyJs(relPath) {
  const fileUrl = new URL(relPath, here);
  const mod = await import(fileUrl.href, { with: { type: "text" } });
  const src = mod.default;
  currentScriptUrl = fileUrl.href;
  // Resolve + load any `META: script=` preamble files first, in order,
  // in the same global scope (indirect eval). The regex is global so we
  // collect every match; the path is relative to the test file's dir.
  let match;
  const re = new RegExp(META_SCRIPT_PATTERN);
  while ((match = re.exec(src)) !== null) {
    let preamblePath = match[1];
    // WPT absolute paths (`/common/gc.js`, `/resources/...`) resolve against
    // the server root, which maps to `tests/wpt/suite/` in our vendored
    // layout. Strip the leading `/` and load relative to `./suite/`.
    if (preamblePath.startsWith("/")) {
      await loadScript(`./suite/${preamblePath.slice(1)}`);
    } else {
      const preambleUrl = new URL(preamblePath, fileUrl);
      // Normalize relative to `here` (the run.js dir) so the import
      // specifier points back into the vendored suite.
      const rel = preambleUrl.href.slice(here.href.length);
      if (rel === "") {
        // Resolved to the run.js dir itself — skip (bad META path).
        currentScriptUrl = fileUrl.href;
        continue;
      }
      await loadScript(`./${rel}`);
    }
    // Restore the current script URL so `fetch_json` resolution still
    // points at the test file, not the preamble.
    currentScriptUrl = fileUrl.href;
  }
  (0, eval)(src);
}

let currentScriptUrl = here.href;
await loadScript("./suite/resources/testharness.js");
await loadScript("./testharnessreport.js");

// Shim `fetch_json` to load WPT fixture JSON via the module loader (import
// attribute `type:"json"`) instead of `fetch`. WPT's `fetch_json(resource)`
// resolves `resource` against the *test page's* URL — but limun has no
// browsing context / document base URL, so a relative path like
// `"../../../fetch/data-urls/resources/base64.json"` has no base to resolve
// against and `fetch` rejects ("relative URL without a base"). We resolve
// it against `currentScriptUrl` (the URL of the test file most recently
// loaded via `loadScript`), which matches the on-disk layout of the
// vendored WPT suite.
const realFetchJson = globalThis.fetch_json;
globalThis.fetch_json = async (resource) => {
  try {
    const url = new URL(resource, currentScriptUrl).href;
    const mod = await import(url, { with: { type: "json" } });
    return mod.default;
  } catch {
    return realFetchJson(resource);
  }
};

// Shim `fetch` for local `file://` URLs: resolve relative URLs against
// `currentScriptUrl` (matching a browser's document-base resolution), and
// for `file://` URLs pointing at JSON resources, use the module loader
// (import attribute `type:"json"`) instead of the real `fetch()`, which
// doesn't support `file://`. Non-JSON `file://` URLs and absolute `http(s)`
// URLs go through the real `fetch()`.
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  if (typeof input === "string") {
    try {
      const resolved = new URL(input, currentScriptUrl);
      if (resolved.protocol === "file:") {
        if (resolved.pathname.endsWith(".json")) {
          try {
            const mod = await import(resolved.href, { with: { type: "json" } });
            return {
              ok: true,
              status: 200,
              statusText: "",
              headers: new Headers(),
              json: () => Promise.resolve(mod.default),
              text: () => Promise.resolve(JSON.stringify(mod.default)),
              body: null,
              type: "basic",
              url: resolved.href,
              redirected: false,
            };
          } catch {
            // Fall through to real fetch
          }
        }
      }
      input = resolved.href;
    } catch {
      // Leave non-relative inputs as-is and let the real fetch handle them.
    }
  }
  return realFetch(input, init);
};

setup({ explicit_done: true });
const realDone = done;
globalThis.done = () => {};

// Default subset: tests for specs we implement, that are self-contained
// (no document/DOM element creation, no fetch of WPT server fixtures, no
// Worker). Expand as implementations converge on spec correctness.
const defaultFiles = [
  "hr-time/monotonic-clock.any.js",
  "hr-time/basic.any.js",
  "encoding/api-basics.any.js",
  "encoding/textdecoder-fatal.any.js",
  "dom/abort/resources/abort-signal-any-tests.js",
  "dom/abort/abort-signal-any.any.js",
  "dom/abort/event.any.js",
  "dom/abort/timeout.any.js",
  "dom/abort/AbortSignal.any.js",
  "html/webappapis/atob/base64.any.js",
  "FileAPI/support/Blob.js",
  "FileAPI/blob/Blob-text.any.js",
  "FileAPI/blob/Blob-array-buffer.any.js",
  "FileAPI/blob/Blob-bytes.any.js",
  "FileAPI/blob/Blob-slice.any.js",
  "FileAPI/blob/Blob-slice-overflow.any.js",
  "FileAPI/blob/Blob-constructor.any.js",
  "FileAPI/file/File-constructor.any.js",
  // --- Streams Standard (full port) -------------------------------------
  // readable-streams (default controller path)
  "streams/readable-streams/constructor.any.js",
  "streams/readable-streams/general.any.js",
  "streams/readable-streams/cancel.any.js",
  "streams/readable-streams/default-reader.any.js",
  "streams/readable-streams/async-iterator.any.js",
  "streams/readable-streams/bad-strategies.any.js",
  "streams/readable-streams/bad-underlying-sources.any.js",
  "streams/readable-streams/count-queuing-strategy-integration.any.js",
  "streams/readable-streams/floating-point-total-queue-size.any.js",
  "streams/readable-streams/garbage-collection.any.js",
  "streams/readable-streams/patched-global.any.js",
  "streams/readable-streams/reentrant-strategies.any.js",
  "streams/readable-streams/templated.any.js",
  "streams/readable-streams/tee.any.js",
  // readable-byte-streams (BYOB controller path)
  "streams/readable-byte-streams/general.any.js",
  "streams/readable-byte-streams/bad-buffers-and-views.any.js",
  "streams/readable-byte-streams/construct-byob-request.any.js",
  "streams/readable-byte-streams/enqueue-with-detached-buffer.any.js",
  "streams/readable-byte-streams/non-transferable-buffers.any.js",
  "streams/readable-byte-streams/patched-global.any.js",
  "streams/readable-byte-streams/read-min.any.js",
  "streams/readable-byte-streams/respond-after-enqueue.any.js",
  "streams/readable-byte-streams/tee.any.js",
  "streams/readable-byte-streams/templated.any.js",
  // writable-streams
  "streams/writable-streams/aborting.any.js",
  "streams/writable-streams/bad-strategies.any.js",
  "streams/writable-streams/bad-underlying-sinks.any.js",
  "streams/writable-streams/byte-length-queuing-strategy.any.js",
  "streams/writable-streams/close.any.js",
  "streams/writable-streams/constructor.any.js",
  "streams/writable-streams/count-queuing-strategy.any.js",
  "streams/writable-streams/error.any.js",
  "streams/writable-streams/floating-point-total-queue-size.any.js",
  "streams/writable-streams/garbage-collection.any.js",
  "streams/writable-streams/general.any.js",
  "streams/writable-streams/properties.any.js",
  "streams/writable-streams/reentrant-strategy.any.js",
  "streams/writable-streams/start.any.js",
  "streams/writable-streams/write.any.js",
  // transform-streams
  "streams/transform-streams/backpressure.any.js",
  "streams/transform-streams/cancel.any.js",
  "streams/transform-streams/errors.any.js",
  "streams/transform-streams/flush.any.js",
  "streams/transform-streams/general.any.js",
  "streams/transform-streams/lipfuzz.any.js",
  "streams/transform-streams/patched-global.any.js",
  "streams/transform-streams/properties.any.js",
  "streams/transform-streams/reentrant-strategies.any.js",
  "streams/transform-streams/strategies.any.js",
  "streams/transform-streams/terminate.any.js",
  // queuing-strategies (top-level)
  "streams/queuing-strategies.any.js",
  // piping
  "streams/piping/abort.any.js",
  "streams/piping/close-propagation-backward.any.js",
  "streams/piping/close-propagation-forward.any.js",
  "streams/piping/error-propagation-backward.any.js",
  "streams/piping/error-propagation-forward.any.js",
  "streams/piping/flow-control.any.js",
  "streams/piping/general-addition.any.js",
  "streams/piping/general.any.js",
  "streams/piping/multiple-propagation.any.js",
  "streams/piping/pipe-through.any.js",
  "streams/piping/then-interception.any.js",
  "streams/piping/throwing-options.any.js",
  "streams/piping/transform-streams.any.js",
  // SKIP `streams/idlharness.any.js` — needs IDL harness infra not present.
  // SKIP `streams/readable-streams/from.any.js` — `ReadableStream.from` uses
  //   the async-iterable converter which requires a full `open()`/`return()`
  //   protocol that exercises edge cases beyond the WPT subset we run.
  // --- Web Messaging (MessageChannel / MessagePort / MessageEvent) ------
  // Single-realm — the WPT Worker/iframe tests are skipped (need a
  // browsing context or Worker global this runtime doesn't have).
  "webmessaging/message-channels/basics.any.js",
  "webmessaging/message-channels/close.any.js",
  "webmessaging/message-channels/implied-start.any.js",
  "webmessaging/message-channels/no-start.any.js",
  "webmessaging/message-channels/dictionary-transferrable.any.js",
  // SKIP `webmessaging/message-channels/worker-post-after-close.any.js` —
  //   needs `new Worker(...)` (Limun is single-realm, no Workers).
  // SKIP `webmessaging/message-channels/worker.any.js` — needs Workers.
  "webmessaging/MessagePort_onmessage_start.any.js",
  "webmessaging/MessageEvent.any.js",
  "webmessaging/Channel_postMessage_with_transfer_incoming_messages.any.js",
  "webmessaging/Channel_postMessage_with_transfer_outgoing_messages.any.js",
  // SKIP `webmessaging/Channel_postMessage_Blob.any.js` — needs
  //   `FileReader` (not implemented yet) + `/common/gc.js`.
  "webmessaging/Channel_postMessage_clone_port.any.js",
  // SKIP
  //   `html/infrastructure/safe-passing-of-structured-data/messagechannel.any.js`
  //   — META loads `/common/sab.js` (SharedArrayBuffer) + the structured-
  //   clone battery-of-tests, neither of which is self-contained here.
  // --- Console Standard ---------------------------------------------------
  // Full recursive inspector in `ext:limun/01_console.js`. Skip
  // `console/idlharness.any.js` (IDL harness infra not present).
  "console/console-is-a-namespace.any.js",
  "console/console-label-conversion.any.js",
  "console/console-log-large-array.any.js",
  "console/console-log-symbol.any.js",
  "console/console-namespace-object-class-string.any.js",
  "console/console-tests-historical.any.js",
  // --- Fetch Standard (Body) --------------------------------------------
  "fetch/api/body/formdata.any.js",
  "fetch/api/body/mime-type.any.js",
  "fetch/api/body/textstream.any.js",
  // --- Fetch Standard (Headers) -----------------------------------------
  // Keep `headers-no-cors.any.js` last: it uses `fetch()` for a WPT
  // fixture, and `currentScriptUrl` points at the last loaded file when
  // the async harness starts running.
  // SKIP `headers-record.any.js` — its `setup()` callback populates a
  //   Proxy logging handler, but our shared-harness multi-file runner
  //   has already advanced past the SETUP phase by the time this file
  //   loads, so `setup(func)` is a no-op.  This test requires per-file
  //   harness isolation to work correctly.
  // SKIP `header-values.any.js` / `header-values-normalize.any.js` — both
  //   use `self.GLOBAL.isWorker()` (not available) and `XMLHttpRequest`
  //   (not implemented), and fetch from a WPT server fixture.
  "fetch/api/headers/headers-basic.any.js",
  "fetch/api/headers/headers-errors.any.js",
  "fetch/api/headers/headers-forbidden-override.any.js",
  "fetch/api/headers/headers-normalize.any.js",
  "fetch/api/headers/headers-casing.any.js",
  "fetch/api/headers/headers-combine.any.js",
  "fetch/api/headers/headers-structure.any.js",
  "fetch/api/headers/header-setcookie.any.js",
  "fetch/api/headers/headers-no-cors.any.js",
];

// When --suite=<name> is given, discover .any.js files under suite/<name>/.
// When --all is given, run the default subset plus any additional suites
// we can handle without a WPT test server.
let files;
if (suiteFilter) {
  files = [];
  // We can't easily walk a directory from JS without a fs API, so the
  // --suite flag is a hint to expand the default list. For now it filters
  // the default files by suite name prefix.
  for (const f of defaultFiles) {
    if (f.startsWith(suiteFilter + "/") || f.startsWith(suiteFilter)) {
      files.push(f);
    }
  }
  if (files.length === 0) {
    throw new Error(`no tests found for suite "${suiteFilter}"`);
  }
} else {
  files = defaultFiles;
}

for (const f of files) {
  console.log(`\n--- ${f} ---`);
  // `--suite=` flag still filters by prefix; load preamble-supporting
  // `.any.js` files through `loadAnyJs` (handles `// META: script=`),
  // plain files (testharness, report) through `loadScript`. The WPT
  // support files (e.g. `FileAPI/support/Blob.js`) are not `.any.js`
  // tests themselves — they're preamble targets loaded by their
  // callers; load them with `loadScript` (no META handling needed).
  if (f.endsWith(".any.js")) {
    await loadAnyJs(`./suite/${f}`);
  } else {
    await loadScript(`./suite/${f}`);
  }
}

globalThis.done = realDone;
done();

// Watchdog: a test that never settles leaves `tests.num_pending > 0`
// forever, so `__wptDone` never resolves. With no further timers pending,
// limun's event loop exits 0 — silently reporting success. Race against a
// deadline so a hang is reported as a failure instead.
const WATCHDOG_MS = 10_000;
const watchdog = new Promise((_, reject) =>
  setTimeout(
    () =>
      reject(
        new Error(
          `WPT harness did not complete within ${WATCHDOG_MS}ms — ` +
            `${globalThis.__wptPending.size} test(s) still pending: ` +
            `${[...globalThis.__wptPending].join(", ")}`,
        ),
      ),
    WATCHDOG_MS,
  )
);

const { failed } = await Promise.race([globalThis.__wptDone, watchdog]);
if (failed.length > 0) {
  throw new Error(`${failed.length} WPT test(s) failed: ${failed.map((t) => t.name).join(", ")}`);
}