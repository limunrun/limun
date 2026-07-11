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
  (0, eval)(mod.default);
}

await loadScript("./suite/resources/testharness.js");
await loadScript("./testharnessreport.js");

setup({ explicit_done: true });
const realDone = done;
globalThis.done = () => {};

// Default subset: tests for specs we implement, that are self-contained
// (no document/DOM element creation, no fetch of WPT server fixtures, no
// Worker). Expand as implementations converge on spec correctness.
const defaultFiles = [
  "hr-time/monotonic-clock.any.js",
  "encoding/api-basics.any.js",
  "encoding/textdecoder-fatal.any.js",
  "dom/abort/resources/abort-signal-any-tests.js",
  "dom/abort/abort-signal-any.any.js",
  "dom/abort/event.any.js",
  "dom/abort/timeout.any.js",
  "dom/abort/AbortSignal.any.js",
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
  await loadScript(`./suite/${f}`);
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