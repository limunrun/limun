// Proof test for the Phase 0 internal-JS infrastructure.
//
// Run: limun tests/infra/proof.js
// Exits 0 if `globalThis.__infraProof` was set to "HELLO 5" by the
// internal module `ext:limun/99_test.js` during bootstrap. Throws
// otherwise — the infrastructure is broken.

if (globalThis.__infraProof !== "HELLO 5") {
  throw new Error(
    `__infraProof expected "HELLO 5", got ${String(globalThis.__infraProof)}`,
  );
}

console.log("infra proof ok: " + globalThis.__infraProof);