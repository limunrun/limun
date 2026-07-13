// Copyright 2026 the Limun authors. MIT license.

// Proof-of-infrastructure module: verifies that (1) primordials were
// captured before user code can touch builtins, and (2) Rust ops are
// callable from internal JS. Runs during bootstrap, before the user's
// entry module. Sets `globalThis.__infraProof` so a user-side test can
// assert the machinery worked end-to-end.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const { StringPrototypeToUpperCase } = primordials;

  // `__limunOps.op_test_add(a, b)` returns `a + b` as a Number (Rust op
  // registered in src/core/ops.rs). Proves the op-registration path works.
  const sum = globalThis.__limunOps.op_test_add(2, 3);

  // `StringPrototypeToUpperCase("hello")` === "HELLO" — proves the
  // primordials capture succeeded (the uncurried original is intact and
  // unaffected by any later globalThis tampering).
  const upper = StringPrototypeToUpperCase("hello");

  globalThis.__infraProof = `${upper} ${sum}`;
})(globalThis);