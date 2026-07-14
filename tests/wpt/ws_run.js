const here = new URL(".", import.meta.url);

async function loadScript(relPath) {
  const mod = await import(new URL(relPath, here).href, { with: { type: "text" } });
  (0, eval)(mod.default);
}

const META_SCRIPT_PATTERN = /^\/\/\s*META:\s*script=(.+?)\s*$/gm;

async function loadAnyJs(relPath) {
  const fileUrl = new URL(relPath, here);
  const mod = await import(fileUrl.href, { with: { type: "text" } });
  const src = mod.default;

  const parts = [];
  let match;
  const re = new RegExp(META_SCRIPT_PATTERN);
  while ((match = re.exec(src)) !== null) {
    let preamblePath = match[1];
    let preambleUrl;
    if (preamblePath.startsWith("/")) {
      preambleUrl = new URL(`./suite/${preamblePath.slice(1)}`, here);
    } else {
      preambleUrl = new URL(preamblePath, fileUrl);
    }
    let shimUrl = preambleUrl.href.replace(/\.sub\.js$/, ".shim.js");
    if (shimUrl !== preambleUrl.href) {
      try {
        const shimMod = await import(shimUrl, { with: { type: "text" } });
        parts.push(shimMod.default);
        continue;
      } catch {
      }
    }
    const preambleMod = await import(preambleUrl.href, { with: { type: "text" } });
    parts.push(preambleMod.default);
  }
  parts.push(src);
  const combined = parts.join("\n");
  new Function(combined)();
}

let currentScriptUrl = here.href;
await loadScript("./suite/resources/testharness.js");
await loadScript("./testharnessreport.js");
globalThis.location = new URL("http://example.com/");

setup({ explicit_done: true });
const realDone = done;
globalThis.done = () => {};

const files = [
  "websockets/Create-invalid-urls.any.js",
  "websockets/Create-non-absolute-url.any.js",
  "websockets/Create-nonAscii-protocol-string.any.js",
  "websockets/Create-protocol-with-space.any.js",
  "websockets/Create-protocols-repeated.any.js",
  "websockets/Create-protocols-repeated-case-insensitive.any.js",
  "websockets/Create-url-with-space.any.js",
  "websockets/Create-valid-url.any.js",
  "websockets/Create-valid-url-protocol-empty.any.js",
  "websockets/Create-valid-url-protocol-setCorrectly.any.js",
  "websockets/Create-valid-url-protocol-string.any.js",
  "websockets/Create-valid-url-protocol.any.js",
  "websockets/Create-extensions-empty.any.js",
  "websockets/constructor.any.js",
  "websockets/binaryType-wrong-value.any.js",
  "websockets/close-invalid.any.js",
  "websockets/Close-undefined.any.js",
  "websockets/Close-onlyReason.any.js",
  "websockets/Close-1000.any.js",
  "websockets/Close-1000-reason.any.js",
  "websockets/Close-1000-verify-code.any.js",
  "websockets/Close-1005.any.js",
  "websockets/Close-1005-verify-code.any.js",
  "websockets/Close-2999-reason.any.js",
  "websockets/Close-3000-reason.any.js",
  "websockets/Close-3000-verify-code.any.js",
  "websockets/Close-4999-reason.any.js",
  "websockets/Close-Reason-124Bytes.any.js",
  "websockets/Close-readyState-Closed.any.js",
  "websockets/Close-readyState-Closing.any.js",
  "websockets/Close-server-initiated-close.any.js",
  "websockets/Close-delayed.any.js",
  "websockets/Send-data.any.js",
  "websockets/Send-0byte-data.any.js",
  "websockets/Send-null.any.js",
  "websockets/Send-unicode-data.any.js",
  "websockets/Send-paired-surrogates.any.js",
  "websockets/Send-unpaired-surrogates.any.js",
  "websockets/Send-before-open.any.js",
  "websockets/Send-binary-arraybuffer.any.js",
  "websockets/Send-binary-65K-arraybuffer.any.js",
  "websockets/Send-binary-blob.any.js",
  "websockets/Send-binary-arraybufferview-int8.any.js",
  "websockets/Send-binary-arraybufferview-uint8-offset.any.js",
  "websockets/Send-binary-arraybufferview-uint8-offset-length.any.js",
  "websockets/Send-binary-arraybufferview-int16-offset.any.js",
  "websockets/Send-binary-arraybufferview-uint16-offset-length.any.js",
  "websockets/Send-binary-arraybufferview-int32.any.js",
  "websockets/Send-binary-arraybufferview-uint32-offset.any.js",
  "websockets/Send-binary-arraybufferview-float32.any.js",
  "websockets/Send-binary-arraybufferview-float64.any.js",
  "websockets/Send-65K-data.any.js",
];

for (const f of files) {
  console.log(`\n--- ${f} ---`);
  await loadAnyJs(`./suite/${f}`);
}

globalThis.done = realDone;
done();

const WATCHDOG_MS = 30_000;
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