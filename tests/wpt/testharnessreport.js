// Custom reporter for testharness.js — NOT vendored from upstream.
//
// Upstream's testharnessreport.js renders results into an HTML #results
// table and calls DOM APIs limun doesn't have. This is limun's own
// replacement: same job (hook the harness's callbacks and report), zero
// DOM dependency. Loaded via `run.js` the same way as testharness.js — an
// indirect `eval` of its source text, so it lands in the same global Script
// scope and can see `add_result_callback`/`add_completion_callback`/`tests`.
//
// Exposes `globalThis.__wptDone` — a Promise that resolves once the harness
// finishes — so `run.js` can decide the process exit status. Also exposes
// `globalThis.__wptPending` for the watchdog.

globalThis.__wptPending = new Set();

globalThis.__wptDone = new Promise((resolve) => {
  add_test_state_callback((test) => {
    globalThis.__wptPending.add(test.name);
  });

  add_result_callback((test) => {
    globalThis.__wptPending.delete(test.name);
    const label = test.status === 0 ? "PASS" : test.status === 2 ? "TIMEOUT" : test.status === 3 ? "NOTRUN" : test.status === 4 ? "PRECONDITION_FAILED" : "FAIL";
    if (test.status === 0) {
      console.log(`  ${label}  ${test.name}`);
    } else {
      console.error(`  ${label}  ${test.name}${test.message ? ` — ${test.message}` : ""}`);
    }
  });

  add_completion_callback((tests, status) => {
    const statusNames = ["OK", "ERROR", "TIMEOUT", "PRECONDITION_FAILED"];
    const failed = tests.filter((t) => t.status !== 0);
    console.log(`\n${tests.length - failed.length}/${tests.length} passed.`);
    if (status.status !== 0) {
      console.error(`harness status: ${statusNames[status.status] || status.status}${status.message ? ` — ${status.message}` : ""}`);
    }
    resolve({ tests, status, failed });
  });
});