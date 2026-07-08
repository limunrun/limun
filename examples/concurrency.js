// Manual concurrency proof (not part of the default smoke suite — needs
// network). Two concurrent fetches to ~1s-latency endpoints. If serial,
// wall time ≈ 2s. If concurrent (the whole point of the async rewrite),
// wall time ≈ 1s.
const start = performance.now();
const [a, b] = await Promise.all([
  fetch("https://esm.sh/lodash-es@4.17.21/isEqual.js"),
  fetch("https://esm.sh/lodash-es@4.17.21/merge.js"),
]);
const elapsed = performance.now() - start;
console.log(`two concurrent fetches elapsed: ${Math.round(elapsed)}ms`);
if (!a.ok || !b.ok) { console.error("FAIL: fetches didn't resolve ok"); }
else { console.log("PASS: both fetches resolved ok"); }
if (elapsed > 1800) { console.error(`FAIL: fetches appear serial (${Math.round(elapsed)}ms >= 1800)`); }
else { console.log("PASS: fetches ran concurrently (under 1800ms)"); }