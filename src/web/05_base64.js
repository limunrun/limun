// Copyright 2026 the Limun authors. MIT license.

// `atob`/`btoa` — WHATWG HTML Standard
// (https://html.spec.whatwg.org/multipage/webappapis.html#atob).
//
// PILOT module: first web API migrated from Rust to JS-on-ops. The pattern
// this establishes for every subsequent module:
//
//   1. Rust op (`src/core/ops.rs`) is a flat `FunctionCallback` — bytes /
//      numbers / strings in, flat V8 value out. No spec-observable behavior
//      here: no argument count checks, no DOMString conversion, no error
//      type selection. The op throws a bare `TypeError` on failure; the JS
//      layer catches it and rethrows as the spec-correct exception.
//   2. This JS module owns the spec surface: WebIDL argument validation,
//      DOMString conversion, catching op errors and rethrowing them as the
//      right exception type (here, `DOMException("InvalidCharacterError")`).
//   3. Globals are installed on `globalThis` during bootstrap — the module
//      is in the `internal_js::REGISTRY`, evaluated before user code.
//   4. Primordials come from `globalThis.__bootstrap.primordials` (captured
//      before user code can mutate builtins). Ops come from
//      `globalThis.__limunOps`. Cross-module values that are still in Rust
//      (here `DOMException`) come from `globalThis`.
//
// Ports Deno's `ext/web/05_base64.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `core.loadExtScript("ext:deno_web/01_dom_exception.js")` →
//     `globalThis.DOMException` (still in Rust until the DOMException
//     migration).
//   - `webidl.requiredArguments` / `webidl.converters.DOMString` →
//     `globalThis.__bootstrap.webidl` (shared `ext:limun/00_webidl.js`).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const { op_base64_atob, op_base64_btoa } = globalThis.__limunOps;
  const {
    ObjectPrototypeIsPrototypeOf,
    RegExpPrototypeSymbolReplace,
    RegExpPrototypeTest,
    StringPrototypeEndsWith,
    StringPrototypeSlice,
    TypeErrorPrototype,
  } = primordials;

  const { DOMException } = globalThis;

  // --- ASCII whitespace stripping + forgiving-base64 validation --------
  //
  // Spec (Infra "forgiving-base64 decode", which HTML's `atob` defers to):
  //
  //   1. Remove all ASCII whitespace from data. (ASCII whitespace per Infra
  //      is U+0009/U+000A/U+000C/U+000D/U+0020 — NOT U+000B. The WPT suite
  //      confirms this: `ab\u000Bcd` decodes to `null` because U+000B is an
  //      invalid base64 char, not stripped.)
  //   2. If length % 4 == 0 and data ends with 1-2 `=`, strip them.
  //   3. If length % 4 == 1, fail.
  //   4. If data contains a char outside [A-Za-z0-9+/], fail.
  //   5. Decode (discard leftover trailing bits).
  //
  // Steps 1-4 are spec-observable (they decide throw vs. success and the
  // exact error), so they live in JS. Step 5 (the bit math) is pure
  // computation → Rust op. The op receives a pure-base64-alphabet string
  // (no `=`, no whitespace, validated length) and decodes it, discarding
  // trailing bits — that's `STANDARD_NO_PAD` with
  // `with_decode_allow_trailing_bits(true)` on the Rust side.
  const ASCII_WHITESPACE = /[\t\n\f\r ]/g;
  const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/;

  function normalizeForAtob(data) {
    // Step 1: strip ASCII whitespace.
    data = RegExpPrototypeSymbolReplace(ASCII_WHITESPACE, data, "");
    // Step 2: if length % 4 == 0, strip 1-2 trailing `=`.
    if (data.length % 4 === 0) {
      if (StringPrototypeEndsWith(data, "==")) {
        data = StringPrototypeSlice(data, 0, -2);
      } else if (StringPrototypeEndsWith(data, "=")) {
        data = StringPrototypeSlice(data, 0, -1);
      }
    }
    // Step 3: length % 4 == 1 → invalid.
    if (data.length % 4 === 1) {
      return null;
    }
    // Step 4: must be pure base64 alphabet (no `=`, no whitespace, no
    // other chars). After step 2, `=` should be gone; any remaining `=`
    // means it was in a non-trailing position or length wasn't mult of 4
    // — both invalid.
    if (!RegExpPrototypeTest(BASE64_ALPHABET, data)) {
      return null;
    }
    return data;
  }

  // --- atob / btoa --------------------------------------------------------

  function atob(data) {
    const prefix = "Failed to execute 'atob'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    data = webidl.converters.DOMString(data);
    const normalized = normalizeForAtob(data);
    if (normalized === null) {
      throw new DOMException(
        "Failed to decode base64: invalid character",
        "InvalidCharacterError",
      );
    }
    try {
      return op_base64_atob(normalized);
    } catch (e) {
      // The op rejects only on a decode failure that JS validation missed
      // (shouldn't happen post-normalize, but be safe). Re-throw as the
      // spec-correct DOMException.
      if (ObjectPrototypeIsPrototypeOf(TypeErrorPrototype, e)) {
        throw new DOMException(
          "Failed to decode base64: invalid character",
          "InvalidCharacterError",
        );
      }
      throw e;
    }
  }

  function btoa(data) {
    const prefix = "Failed to execute 'btoa'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    data = webidl.converters.DOMString(data);
    try {
      return op_base64_btoa(data);
    } catch (e) {
      if (ObjectPrototypeIsPrototypeOf(TypeErrorPrototype, e)) {
        throw new DOMException(
          "Cannot encode string: string contains characters outside of the Latin1 range",
          "InvalidCharacterError",
        );
      }
      throw e;
    }
  }

  // Install as enumerable globals (matches every other engine: Node,
  // Deno, browsers — `Object.keys(globalThis)` includes `atob`/`btoa`).
  // Plain `set` (writable, configurable, enumerable) — `defineProperty`
  // with the default attributes would be non-enumerable, which is wrong.
  const atobKey = "atob";
  const btoaKey = "btoa";
  globalThis[atobKey] = atob;
  globalThis[btoaKey] = btoa;
})(globalThis);