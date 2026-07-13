// Copyright 2026 the Limun authors. MIT license.

// `Crypto`/`SubtleCrypto`/`CryptoKey` + the `crypto` global — WebCrypto
// (https://w3c.github.io/webcrypto/). Increment 1: `getRandomValues`,
// `randomUUID`, and `subtle.digest` (SHA-1/256/384/512 + SHA3-256/384/512).
// `encrypt`/`decrypt`/`sign`/`verify`/`generateKey`/`importKey`/`exportKey`/
// `deriveKey`/`deriveBits`/`wrapKey`/`unwrapKey` and working `CryptoKey`
// construction arrive in later increments.
//
// The spec surface (class shapes, WebIDL brand checks, algorithm name
// normalization, error-type selection, Promise wrapping for `digest`,
// `CryptoKey` getter shells) lives here in JS. The flat Rust ops
// (`op_crypto_get_random_values`, `op_crypto_random_uuid`,
// `op_crypto_digest`) in `src/core/ops.rs` are the irreducible native work:
// OS-entropy random byte generation, UUID v4 bit-fixing + hex formatting,
// and hash computation via the `sha1`/`sha2`/`sha3` crates.
//
// Ports Deno's `ext/crypto/00_crypto.js` — but REVERSED: Deno's JS is a
// thin shim over cppgc-wrapped Rust classes (`Crypto`/`SubtleCrypto`/
// `CryptoKey` from `core.ops`), where the spec surface lives in Rust. Here
// the spec surface is in JS and only the crypto primitives are in Rust ops.
// Rewires:
//   - `core.ops.Crypto`/`SubtleCrypto`/`CryptoKey` (cppgc classes) →
//     JS classes with `illegalConstructorKey` guards (same pattern as
//     `15_performance.js`'s `Performance` singleton).
//   - `core.ops.op_crypto_*` → `globalThis.__limunOps.op_crypto_*`.
//   - `webidl` (brand, assertBranded, illegalConstructor, converters) →
//     `globalThis.__bootstrap.webidl`.
//   - `DOMException` → `globalThis.DOMException` (installed by
//     `01_dom_exception.js`).
//   - `SymbolFor("Deno.privateCustomInspect")` → dropped (no Deno-style
//     custom inspect in Limun yet).
//   - `core.registerCloneableResource("CryptoKey", …)` → dropped (no
//     structured-clone channel for CryptoKey yet — later increment).
//   - `applyWebIdlInterfaceShape` (pin `Function.length` to 0, pin
//     `prototype` to non-writable) → inline `ObjectDefineProperty` calls
//     matching the same shape.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_crypto_get_random_values,
    op_crypto_random_uuid,
    op_crypto_digest,
  } = globalThis.__limunOps;
  const {
    ArrayBufferIsView,
    ArrayPrototypeIncludes,
    ObjectDefineProperty,
    SymbolToStringTag,
    TypedArrayPrototypeGetSymbolToStringTag,
    TypeError,
    Uint8Array,
  } = primordials;

  const DOMException = globalThis.DOMException;

  const illegalConstructorKey = Symbol("illegalConstructorKey");

  const integerTypedArrayTags = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "BigInt64Array",
    "BigUint64Array",
  ];

  const supportedDigestAlgorithms = [
    "SHA-1",
    "SHA-256",
    "SHA-384",
    "SHA-512",
    "SHA3-256",
    "SHA3-384",
    "SHA3-512",
  ];

  function applyWebIdlInterfaceShape(interface_) {
    ObjectDefineProperty(interface_, "length", {
      __proto__: null,
      value: 0,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    ObjectDefineProperty(interface_, "prototype", {
      __proto__: null,
      writable: false,
    });
  }

  // --- CryptoKey (shell — getters only, no working constructor yet) --------

  const _type = Symbol("type");
  const _extractable = Symbol("extractable");
  const _algorithm = Symbol("algorithm");
  const _usages = Symbol("usages");

  class CryptoKey {
    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      this[webidl.brand] = webidl.brand;
    }

    get type() {
      webidl.assertBranded(this, CryptoKeyPrototype, "CryptoKey");
      return this[_type];
    }

    get extractable() {
      webidl.assertBranded(this, CryptoKeyPrototype, "CryptoKey");
      return this[_extractable];
    }

    get algorithm() {
      webidl.assertBranded(this, CryptoKeyPrototype, "CryptoKey");
      return this[_algorithm];
    }

    get usages() {
      webidl.assertBranded(this, CryptoKeyPrototype, "CryptoKey");
      return this[_usages];
    }
  }

  const CryptoKeyPrototype = CryptoKey.prototype;
  ObjectDefineProperty(CryptoKeyPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "CryptoKey",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  applyWebIdlInterfaceShape(CryptoKey);

  // --- SubtleCrypto ---------------------------------------------------------

  class SubtleCrypto {
    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      this[webidl.brand] = webidl.brand;
    }

    async digest(algorithm, data) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");

      // Normalize `algorithm`: a string is treated as `{ name: string }`;
      // an object must have a `.name` property. A missing `name` →
      // TypeError (WebIDL required-member semantics, per WPT
      // `digest({}, ...)` "empty algorithm object" subtest).
      let normalizedName;
      if (typeof algorithm === "string") {
        normalizedName = algorithm;
      } else if (typeof algorithm === "object" && algorithm !== null) {
        const name = algorithm.name;
        if (name === undefined) {
          throw new TypeError(
            "Failed to execute 'digest' on 'SubtleCrypto': required member 'name' is undefined",
          );
        }
        normalizedName = webidl.converters.DOMString(name, {
          prefix: "Failed to execute 'digest' on 'SubtleCrypto'",
          context: "member 'name' of 'algorithm'",
        });
      } else {
        throw new TypeError(
          "Failed to execute 'digest' on 'SubtleCrypto': parameter 1 is not of type 'AlgorithmIdentifier'",
        );
      }

      const upperName = normalizedName.toUpperCase();

      // Read the algorithm name BEFORE extracting data bytes — the WPT
      // "altered buffer during call" subtest uses a `name` getter that
      // modifies the data buffer. Reading the name first (triggering the
      // getter) then extracting bytes gives the post-getter bytes, which
      // is what the spec requires (the algorithm object is inspected
      // before the data is snapshotted).
      // Note: this ordering is naturally correct because `normalizedName`
      // was already read above.

      // Validate `data` is a BufferSource (ArrayBuffer or ArrayBufferView).
      const bufferSource = webidl.converters.BufferSource(data, {
        prefix: "Failed to execute 'digest' on 'SubtleCrypto'",
        context: "Argument 2",
      });

      // Extract bytes. If the backing ArrayBuffer is detached (byteLength
      // is 0 on a previously-non-empty view), pass empty bytes — the WPT
      // "transferred buffer during call" subtest expects the digest of
      // empty data.
      let bytes;
      if (ArrayBufferIsView(bufferSource)) {
        const byteLength = bufferSource.byteLength;
        if (byteLength === 0) {
          bytes = new Uint8Array(0);
        } else {
          bytes = new Uint8Array(byteLength);
          bytes.set(new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, byteLength));
        }
      } else {
        // ArrayBuffer
        if (bufferSource.byteLength === 0) {
          bytes = new Uint8Array(0);
        } else {
          bytes = new Uint8Array(bufferSource);
        }
      }

      // Check algorithm is supported — after extracting bytes (so the
      // "transferred after call" subtest still works: bytes are already
      // captured, then the buffer is transferred outside this function).
      if (!ArrayPrototypeIncludes(supportedDigestAlgorithms, upperName)) {
        throw new DOMException(
          `Unrecognized algorithm name: "${normalizedName}"`,
          "NotSupportedError",
        );
      }

      // Call the Rust op. Synchronous in Rust; the async wrapper makes
      // the JS-side return a Promise per spec.
      return op_crypto_digest(upperName, bytes);
    }
  }

  const SubtleCryptoPrototype = SubtleCrypto.prototype;
  ObjectDefineProperty(SubtleCryptoPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "SubtleCrypto",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  applyWebIdlInterfaceShape(SubtleCrypto);

  // `digest` has `Function.length === 2` per WebIDL (two required params).
  // The `async` keyword preserves this naturally (both `algorithm` and
  // `data` are required), but pin it explicitly for idlharness compliance.
  ObjectDefineProperty(SubtleCryptoPrototype, "digest", {
    __proto__: null,
    value: SubtleCryptoPrototype.digest,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  ObjectDefineProperty(SubtleCryptoPrototype.digest, "length", {
    __proto__: null,
    value: 2,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // --- Crypto ---------------------------------------------------------------

  let subtleSingleton;

  class Crypto {
    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      this[webidl.brand] = webidl.brand;
    }

    getRandomValues(array) {
      webidl.assertBranded(this, CryptoPrototype, "Crypto");

      // Per WebCrypto spec, non-ArrayBufferView values, DataView, and
      // floating-point typed arrays all surface as `TypeMismatchError`
      // (not the WebIDL-default TypeError). Integer typed arrays are
      // accepted.
      if (!ArrayBufferIsView(array)) {
        throw new DOMException(
          "The provided value is not of type '(ArrayBufferView or ArrayBuffer)'",
          "TypeMismatchError",
        );
      }

      const tag = TypedArrayPrototypeGetSymbolToStringTag(array);
      if (!ArrayPrototypeIncludes(integerTypedArrayTags, tag)) {
        throw new DOMException(
          "The provided ArrayBufferView is not an integer typed array",
          "TypeMismatchError",
        );
      }

      if (array.byteLength > 65536) {
        throw new globalThis.QuotaExceededError(
          "The ArrayBufferView's byte length (" + array.byteLength +
            ") exceeds the limit of 65536",
        );
      }

      op_crypto_get_random_values(array);
      return array;
    }

    randomUUID() {
      webidl.assertBranded(this, CryptoPrototype, "Crypto");
      return op_crypto_random_uuid();
    }

    get subtle() {
      webidl.assertBranded(this, CryptoPrototype, "Crypto");
      if (subtleSingleton === undefined) {
        subtleSingleton = new SubtleCrypto(illegalConstructorKey);
      }
      return subtleSingleton;
    }
  }

  const CryptoPrototype = Crypto.prototype;
  ObjectDefineProperty(CryptoPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "Crypto",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  applyWebIdlInterfaceShape(Crypto);

  // --- Install globals ------------------------------------------------------

  const cryptoSingleton = new Crypto(illegalConstructorKey);

  function installGlobal(name, value) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("Crypto", Crypto);
  installGlobal("SubtleCrypto", SubtleCrypto);
  installGlobal("CryptoKey", CryptoKey);
  // `crypto` is an enumerable own property on `globalThis` per spec (Web IDL
  // §3.7.3 — ordinary interface attribute, enumerable/reassignable). Matches
  // browsers: `Object.getOwnPropertyDescriptor(globalThis, "crypto")` is
  // `{ value: <Crypto>, writable: true, enumerable: true, configurable: true }`.
  globalThis.crypto = cryptoSingleton;
})(globalThis);