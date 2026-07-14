// Copyright 2026 the Limun authors. MIT license.

// `Crypto`/`SubtleCrypto`/`CryptoKey` + the `crypto` global — WebCrypto
// (https://w3c.github.io/webcrypto/). Increment 1: `getRandomValues`,
// `randomUUID`, and `subtle.digest` (SHA-1/256/384/512 + SHA3-256/384/512).
// Increment 2a: algorithm normalization framework, `CryptoKey` construction,
// HMAC (generateKey, importKey, exportKey, sign, verify) + AES symmetric
// (generateKey, importKey, exportKey, encrypt, decrypt for CBC/CTR/GCM/KW).
// RSA/EC/Ed25519/X25519/HKDF/PBKDF2/ECDH arrive in later increments.
//
// The spec surface (class shapes, WebIDL brand checks, algorithm name
// normalization, error-type selection, Promise wrapping for `digest`,
// `CryptoKey` getter shells) lives here in JS. The flat Rust ops
// (`op_crypto_get_random_values`, `op_crypto_random_uuid`,
// `op_crypto_digest`, `op_crypto_generate_key`, `op_crypto_sign_hmac`,
// `op_crypto_encrypt_aes_*`, `op_crypto_decrypt_aes_*`) in
// `src/core/ops.rs` are the irreducible native work: OS-entropy random byte
// generation, UUID v4 bit-fixing + hex formatting, hash computation via the
// `sha1`/`sha2`/`sha3` crates, HMAC (RFC 2104 manual impl), and AES
// symmetric encryption/decryption via the `aes`/`cbc`/`ctr`/`aes-gcm`
// crates.
//
// Ports Deno's `ext/crypto/00_crypto.js` (pre-Rust-port version) — but
// REVERSED: Deno's JS is a thin shim over cppgc-wrapped Rust classes
// (`Crypto`/`SubtleCrypto`/`CryptoKey` from `core.ops`), where the spec
// surface lives in Rust. Here the spec surface is in JS and only the crypto
// primitives are in Rust ops. Key design decision: CryptoKey stores key
// material as a `Uint8Array` on a private Symbol `[_keyData]` — no Rust key
// store, no cppgc. Each crypto op receives the raw key bytes directly from
// JS.
//
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
//   - `op_crypto_key_store_insert`/`op_crypto_key_store_get` → dropped.
//     CryptoKey stores `keyData` (Uint8Array) directly on `[_keyData]`.
//   - `op_crypto_base64url_encode`/`op_crypto_base64url_decode` → pure-JS
//     `base64urlEncode`/`base64urlDecode` helpers (no Rust op needed).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_crypto_get_random_values,
    op_crypto_random_uuid,
    op_crypto_digest,
    op_crypto_generate_key,
    op_crypto_sign_hmac,
    op_crypto_encrypt_aes_cbc,
    op_crypto_decrypt_aes_cbc,
    op_crypto_encrypt_aes_ctr,
    op_crypto_decrypt_aes_ctr,
    op_crypto_encrypt_aes_gcm,
    op_crypto_decrypt_aes_gcm,
  } = globalThis.__limunOps;
  const {
    ArrayBufferIsView,
    ArrayBufferPrototypeGetByteLength,
    ArrayBufferPrototypeSlice,
    ArrayPrototypeEvery,
    ArrayPrototypeFilter,
    ArrayPrototypeFind,
    ArrayPrototypeIncludes,
    JSONParse,
    JSONStringify,
    MathCeil,
    ObjectAssign,
    ObjectCreate,
    ObjectDefineProperty,
    ObjectHasOwn,
    ObjectPrototypeIsPrototypeOf,
    SafeArrayIterator,
    StringFromCharCode,
    StringPrototypeCharCodeAt,
    StringPrototypeToLowerCase,
    StringPrototypeToUpperCase,
    SymbolToStringTag,
    TypedArrayPrototypeGetBuffer,
    TypedArrayPrototypeGetByteLength,
    TypedArrayPrototypeGetByteOffset,
    TypedArrayPrototypeGetSymbolToStringTag,
    TypedArrayPrototypeSlice,
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

  function isArrayBuffer(V) {
    return ObjectPrototypeIsPrototypeOf(
      primordials.ArrayBufferPrototype,
      V,
    );
  }
  function isTypedArray(V) {
    return ObjectPrototypeIsPrototypeOf(primordials.TypedArrayPrototype, V);
  }
  function isDataView(V) {
    return ObjectPrototypeIsPrototypeOf(primordials.DataViewPrototype, V);
  }

  // --- base64url helpers --------------------------------------------------

  function base64urlEncode(bytes) {
    const len = bytes.byteLength;
    let binary = "";
    for (let i = 0; i < len; i++) {
      binary += StringFromCharCode(bytes[i]);
    }
    let encoded = globalThis.btoa(binary);
    encoded = encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return encoded;
  }

  function base64urlDecode(str) {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad === 2) s += "==";
    else if (pad === 3) s += "=";

    const binary = globalThis.atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = StringPrototypeCharCodeAt(binary, i);
    }
    return bytes;
  }

  // --- Algorithm normalization framework ----------------------------------

  const supportedNamedCurves = ["P-256", "P-384", "P-521"];

  const recognisedUsages = [
    "encrypt",
    "decrypt",
    "sign",
    "verify",
    "deriveKey",
    "deriveBits",
    "wrapKey",
    "unwrapKey",
  ];

  const simpleAlgorithmDictionaries = {
    AesGcmParams: { iv: "BufferSource", additionalData: "BufferSource" },
    RsaHashedKeyGenParams: { hash: "HashAlgorithmIdentifier" },
    EcKeyGenParams: {},
    HmacKeyGenParams: { hash: "HashAlgorithmIdentifier" },
    RsaPssParams: {},
    EcdsaParams: { hash: "HashAlgorithmIdentifier" },
    HmacImportParams: { hash: "HashAlgorithmIdentifier" },
    HkdfParams: {
      hash: "HashAlgorithmIdentifier",
      salt: "BufferSource",
      info: "BufferSource",
    },
    Pbkdf2Params: { hash: "HashAlgorithmIdentifier", salt: "BufferSource" },
    RsaOaepParams: { label: "BufferSource" },
    RsaHashedImportParams: { hash: "HashAlgorithmIdentifier" },
    EcKeyImportParams: {},
  };

  const supportedAlgorithms = {
    "digest": {
      "SHA-1": null,
      "SHA-256": null,
      "SHA-384": null,
      "SHA-512": null,
      "SHA3-256": null,
      "SHA3-384": null,
      "SHA3-512": null,
    },
    "generateKey": {
      "RSASSA-PKCS1-v1_5": "RsaHashedKeyGenParams",
      "RSA-PSS": "RsaHashedKeyGenParams",
      "RSA-OAEP": "RsaHashedKeyGenParams",
      "ECDSA": "EcKeyGenParams",
      "ECDH": "EcKeyGenParams",
      "AES-CTR": "AesKeyGenParams",
      "AES-CBC": "AesKeyGenParams",
      "AES-GCM": "AesKeyGenParams",
      "AES-KW": "AesKeyGenParams",
      "HMAC": "HmacKeyGenParams",
    },
    "sign": {
      "RSASSA-PKCS1-v1_5": null,
      "RSA-PSS": "RsaPssParams",
      "ECDSA": "EcdsaParams",
      "HMAC": null,
    },
    "verify": {
      "RSASSA-PKCS1-v1_5": null,
      "RSA-PSS": "RsaPssParams",
      "ECDSA": "EcdsaParams",
      "HMAC": null,
    },
    "importKey": {
      "RSASSA-PKCS1-v1_5": "RsaHashedImportParams",
      "RSA-PSS": "RsaHashedImportParams",
      "RSA-OAEP": "RsaHashedImportParams",
      "ECDSA": "EcKeyImportParams",
      "ECDH": "EcKeyImportParams",
      "HMAC": "HmacImportParams",
      "HKDF": null,
      "PBKDF2": null,
      "AES-CTR": null,
      "AES-CBC": null,
      "AES-GCM": null,
      "AES-KW": null,
    },
    "deriveBits": {
      "HKDF": "HkdfParams",
      "PBKDF2": "Pbkdf2Params",
      "ECDH": "EcdhKeyDeriveParams",
    },
    "encrypt": {
      "RSA-OAEP": "RsaOaepParams",
      "AES-CBC": "AesCbcParams",
      "AES-GCM": "AesGcmParams",
      "AES-CTR": "AesCtrParams",
    },
    "decrypt": {
      "RSA-OAEP": "RsaOaepParams",
      "AES-CBC": "AesCbcParams",
      "AES-GCM": "AesGcmParams",
      "AES-CTR": "AesCtrParams",
    },
    "get key length": {
      "AES-CBC": "AesDerivedKeyParams",
      "AES-CTR": "AesDerivedKeyParams",
      "AES-GCM": "AesDerivedKeyParams",
      "AES-KW": "AesDerivedKeyParams",
      "HMAC": "HmacImportParams",
      "HKDF": null,
      "PBKDF2": null,
    },
    "wrapKey": {
      "AES-KW": null,
    },
    "unwrapKey": {
      "AES-KW": null,
    },
  };

  const aesJwkAlg = {
    "AES-CTR": {
      128: "A128CTR",
      192: "A192CTR",
      256: "A256CTR",
    },
    "AES-CBC": {
      128: "A128CBC",
      192: "A192CBC",
      256: "A256CBC",
    },
    "AES-GCM": {
      128: "A128GCM",
      192: "A192GCM",
      256: "A256GCM",
    },
    "AES-KW": {
      128: "A128KW",
      192: "A192KW",
      256: "A256KW",
    },
  };

  function normalizeAlgorithm(algorithm, op) {
    if (typeof algorithm === "string") {
      return normalizeAlgorithm({ name: algorithm }, op);
    }

    const initialAlg = webidl.converters.Algorithm(
      algorithm,
      "Failed to normalize algorithm",
      "passed algorithm",
    );
    let algName = initialAlg.name;

    let desiredType = undefined;
    const registeredAlgorithms = supportedAlgorithms[op];
    for (const key in registeredAlgorithms) {
      if (!ObjectHasOwn(registeredAlgorithms, key)) {
        continue;
      }
      if (
        StringPrototypeToUpperCase(key) === StringPrototypeToUpperCase(algName)
      ) {
        algName = key;
        desiredType = registeredAlgorithms[key];
      }
    }
    if (desiredType === undefined) {
      throw new DOMException(
        "Unrecognized algorithm name",
        "NotSupportedError",
      );
    }

    if (desiredType === null) {
      return { name: algName };
    }

    const normalizedAlgorithm = webidl.converters[desiredType](
      ObjectCreate(algorithm, { name: { value: algName, writable: true, enumerable: true, configurable: true } }),
      "Failed to normalize algorithm",
      "passed algorithm",
    );
    normalizedAlgorithm.name = algName;

    const dict = simpleAlgorithmDictionaries[desiredType];
    if (dict) {
      for (const member in dict) {
        if (!ObjectHasOwn(dict, member)) {
          continue;
        }
        const idlType = dict[member];
        const idlValue = normalizedAlgorithm[member];
        if (idlType === "BufferSource" && idlValue) {
          normalizedAlgorithm[member] = copyBuffer(idlValue);
        } else if (idlType === "HashAlgorithmIdentifier") {
          normalizedAlgorithm[member] = normalizeAlgorithm(idlValue, "digest");
        }
      }
    }

    return normalizedAlgorithm;
  }

  function copyBuffer(input) {
    if (isTypedArray(input)) {
      const byteLength = TypedArrayPrototypeGetByteLength(input);
      if (byteLength === 0) return new Uint8Array(0);
      return TypedArrayPrototypeSlice(
        new Uint8Array(
          TypedArrayPrototypeGetBuffer(input),
          TypedArrayPrototypeGetByteOffset(input),
          byteLength,
        ),
      );
    } else if (isDataView(input)) {
      return TypedArrayPrototypeSlice(
        new Uint8Array(
          primordials.DataViewPrototypeGetBuffer(input),
          primordials.DataViewPrototypeGetByteOffset(input),
          primordials.DataViewPrototypeGetByteLength(input),
        ),
      );
    }
    const byteLength = ArrayBufferPrototypeGetByteLength(input);
    if (byteLength === 0) return new Uint8Array(0);
    return TypedArrayPrototypeSlice(
      new Uint8Array(input, 0, byteLength),
    );
  }

  function usageIntersection(a, b) {
    return ArrayPrototypeFilter(
      a,
      (i) => ArrayPrototypeIncludes(b, i),
    );
  }

  function getKeyLength(algorithm) {
    switch (algorithm.name) {
      case "AES-CBC":
      case "AES-CTR":
      case "AES-GCM":
      case "AES-KW": {
        if (!ArrayPrototypeIncludes([128, 192, 256], algorithm.length)) {
          throw new DOMException(
            `Length must be 128, 192, or 256: received ${algorithm.length}`,
            "OperationError",
          );
        }
        return algorithm.length;
      }
      case "HMAC": {
        let length;
        if (algorithm.length === undefined) {
          switch (algorithm.hash.name) {
            case "SHA-1":
              length = 512;
              break;
            case "SHA-256":
              length = 512;
              break;
            case "SHA-384":
              length = 1024;
              break;
            case "SHA-512":
              length = 1024;
              break;
            default:
              throw new DOMException(
                `Unrecognized hash algorithm: ${algorithm.hash.name}`,
                "NotSupportedError",
              );
          }
        } else if (algorithm.length !== 0) {
          length = algorithm.length;
        } else {
          throw new TypeError(`Invalid length: ${algorithm.length}`);
        }
        return length;
      }
      case "HKDF":
        return null;
      case "PBKDF2":
        return null;
      default:
        throw new TypeError("Unreachable");
    }
  }

  // --- WebIDL converters for crypto dictionaries --------------------------

  webidl.converters.AlgorithmIdentifier = (V, prefix, context, opts) => {
    if (webidl.type(V) === "Object") {
      return webidl.converters.object(V, prefix, context, opts);
    }
    return webidl.converters.DOMString(V, prefix, context, opts);
  };

  webidl.converters.HashAlgorithmIdentifier =
    webidl.converters.AlgorithmIdentifier;

  webidl.converters["BufferSource or JsonWebKey"] = (
    V,
    prefix,
    context,
    opts,
  ) => {
    if (ArrayBufferIsView(V) || isArrayBuffer(V)) {
      return webidl.converters.BufferSource(V, prefix, context, opts);
    }
    return webidl.converters.JsonWebKey(V, prefix, context, opts);
  };

  webidl.converters.KeyFormat = webidl.createEnumConverter("KeyFormat", [
    "raw",
    "pkcs8",
    "spki",
    "jwk",
    "raw-secret",
    "raw-public",
    "raw-private",
    "raw-seed",
  ]);

  webidl.converters.KeyType = webidl.createEnumConverter("KeyType", [
    "public",
    "private",
    "secret",
  ]);

  webidl.converters.KeyUsage = webidl.createEnumConverter("KeyUsage", [
    "encrypt",
    "decrypt",
    "sign",
    "verify",
    "deriveKey",
    "deriveBits",
    "wrapKey",
    "unwrapKey",
  ]);

  webidl.converters["sequence<KeyUsage>"] = webidl.createSequenceConverter(
    webidl.converters.KeyUsage,
  );

  const dictAlgorithm = [{
    key: "name",
    converter: webidl.converters.DOMString,
    required: true,
  }];

  webidl.converters.Algorithm = webidl.createDictionaryConverter(
    "Algorithm",
    dictAlgorithm,
  );

  webidl.converters.BigInteger = webidl.converters.Uint8Array;

  const dictAesKeyGenParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "length",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned short"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
      required: true,
    },
  ];

  webidl.converters.AesKeyGenParams = webidl.createDictionaryConverter(
    "AesKeyGenParams",
    dictAesKeyGenParams,
  );

  const dictAesDerivedKeyParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "length",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
      required: true,
    },
  ];

  webidl.converters.AesDerivedKeyParams = webidl.createDictionaryConverter(
    "AesDerivedKeyParams",
    dictAesDerivedKeyParams,
  );

  const dictHmacKeyGenParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
    {
      key: "length",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
    },
  ];

  webidl.converters.HmacKeyGenParams = webidl.createDictionaryConverter(
    "HmacKeyGenParams",
    dictHmacKeyGenParams,
  );

  const dictHmacImportParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
    {
      key: "length",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
    },
  ];

  webidl.converters.HmacImportParams = webidl.createDictionaryConverter(
    "HmacImportParams",
    dictHmacImportParams,
  );

  const dictAesCbcParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "iv",
      converter: webidl.converters["BufferSource"],
      required: true,
    },
  ];

  webidl.converters.AesCbcParams = webidl.createDictionaryConverter(
    "AesCbcParams",
    dictAesCbcParams,
  );

  const dictAesCtrParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "counter",
      converter: webidl.converters["BufferSource"],
      required: true,
    },
    {
      key: "length",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned short"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
      required: true,
    },
  ];

  webidl.converters.AesCtrParams = webidl.createDictionaryConverter(
    "AesCtrParams",
    dictAesCtrParams,
  );

  const dictAesGcmParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "iv",
      converter: webidl.converters["BufferSource"],
      required: true,
    },
    {
      key: "tagLength",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
    },
    {
      key: "additionalData",
      converter: webidl.converters["BufferSource"],
    },
  ];

  webidl.converters.AesGcmParams = webidl.createDictionaryConverter(
    "AesGcmParams",
    dictAesGcmParams,
  );

  const dictRsaPssParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "saltLength",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
      required: true,
    },
  ];

  webidl.converters.RsaPssParams = webidl.createDictionaryConverter(
    "RsaPssParams",
    dictRsaPssParams,
  );

  const dictEcdsaParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
  ];

  webidl.converters.EcdsaParams = webidl.createDictionaryConverter(
    "EcdsaParams",
    dictEcdsaParams,
  );

  const dictRsaOaepParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "label",
      converter: webidl.converters["BufferSource"],
    },
  ];

  webidl.converters.RsaOaepParams = webidl.createDictionaryConverter(
    "RsaOaepParams",
    dictRsaOaepParams,
  );

  const dictRsaHashedKeyGenParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "modulusLength",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
      required: true,
    },
    {
      key: "publicExponent",
      converter: webidl.converters.BigInteger,
      required: true,
    },
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
  ];

  webidl.converters.RsaHashedKeyGenParams = webidl.createDictionaryConverter(
    "RsaHashedKeyGenParams",
    dictRsaHashedKeyGenParams,
  );

  const dictRsaHashedImportParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
  ];

  webidl.converters.RsaHashedImportParams = webidl.createDictionaryConverter(
    "RsaHashedImportParams",
    dictRsaHashedImportParams,
  );

  webidl.converters.NamedCurve = webidl.converters.DOMString;

  const dictEcKeyImportParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "namedCurve",
      converter: webidl.converters.NamedCurve,
      required: true,
    },
  ];

  webidl.converters.EcKeyImportParams = webidl.createDictionaryConverter(
    "EcKeyImportParams",
    dictEcKeyImportParams,
  );

  const dictEcKeyGenParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "namedCurve",
      converter: webidl.converters.NamedCurve,
      required: true,
    },
  ];

  webidl.converters.EcKeyGenParams = webidl.createDictionaryConverter(
    "EcKeyGenParams",
    dictEcKeyGenParams,
  );

  const dictRsaOtherPrimesInfo = [
    { key: "r", converter: webidl.converters["DOMString"] },
    { key: "d", converter: webidl.converters["DOMString"] },
    { key: "t", converter: webidl.converters["DOMString"] },
  ];

  webidl.converters.RsaOtherPrimesInfo = webidl.createDictionaryConverter(
    "RsaOtherPrimesInfo",
    dictRsaOtherPrimesInfo,
  );
  webidl.converters["sequence<RsaOtherPrimesInfo>"] = webidl
    .createSequenceConverter(webidl.converters.RsaOtherPrimesInfo);

  const dictJsonWebKey = [
    { key: "kty", converter: webidl.converters["DOMString"] },
    { key: "use", converter: webidl.converters["DOMString"] },
    { key: "key_ops", converter: webidl.converters["sequence<DOMString>"] },
    { key: "alg", converter: webidl.converters["DOMString"] },
    { key: "ext", converter: webidl.converters["boolean"] },
    { key: "crv", converter: webidl.converters["DOMString"] },
    { key: "x", converter: webidl.converters["DOMString"] },
    { key: "y", converter: webidl.converters["DOMString"] },
    { key: "d", converter: webidl.converters["DOMString"] },
    { key: "n", converter: webidl.converters["DOMString"] },
    { key: "e", converter: webidl.converters["DOMString"] },
    { key: "p", converter: webidl.converters["DOMString"] },
    { key: "q", converter: webidl.converters["DOMString"] },
    { key: "dp", converter: webidl.converters["DOMString"] },
    { key: "dq", converter: webidl.converters["DOMString"] },
    { key: "qi", converter: webidl.converters["DOMString"] },
    { key: "oth", converter: webidl.converters["sequence<RsaOtherPrimesInfo>"] },
    { key: "k", converter: webidl.converters["DOMString"] },
  ];

  webidl.converters.JsonWebKey = webidl.createDictionaryConverter(
    "JsonWebKey",
    dictJsonWebKey,
  );

  const dictHkdfParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
    {
      key: "salt",
      converter: webidl.converters["BufferSource"],
      required: true,
    },
    {
      key: "info",
      converter: webidl.converters["BufferSource"],
      required: true,
    },
  ];

  webidl.converters.HkdfParams = webidl.createDictionaryConverter(
    "HkdfParams",
    dictHkdfParams,
  );

  const dictPbkdf2Params = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "hash",
      converter: webidl.converters.HashAlgorithmIdentifier,
      required: true,
    },
    {
      key: "iterations",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
      required: true,
    },
    {
      key: "salt",
      converter: webidl.converters["BufferSource"],
      required: true,
    },
  ];

  webidl.converters.Pbkdf2Params = webidl.createDictionaryConverter(
    "Pbkdf2Params",
    dictPbkdf2Params,
  );

  webidl.converters.KeyAlgorithm = webidl.createDictionaryConverter(
    "KeyAlgorithm",
    dictAlgorithm,
  );

  // --- CryptoKey ----------------------------------------------------------

  const _type = Symbol("type");
  const _extractable = Symbol("extractable");
  const _algorithm = Symbol("algorithm");
  const _usages = Symbol("usages");
  const _keyData = Symbol("keyData");

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

  webidl.converters.CryptoKey = webidl.createInterfaceConverter(
    "CryptoKey",
    CryptoKey.prototype,
  );

  function constructKey(type, extractable, usages, algorithm, keyData) {
    const key = webidl.createBranded(CryptoKey);
    key[_type] = type;
    key[_extractable] = extractable;
    key[_usages] = usages;
    key[_algorithm] = algorithm;
    key[_keyData] = keyData;
    return key;
  }

  // --- Per-algorithm implementations: generateKey -------------------------

  function generateKeyHMAC(normalizedAlgorithm, extractable, usages) {
    if (
      ArrayPrototypeFind(
        usages,
        (u) => !ArrayPrototypeIncludes(["sign", "verify"], u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    let length;
    if (normalizedAlgorithm.length === undefined) {
      length = null;
    } else if (normalizedAlgorithm.length !== 0) {
      length = normalizedAlgorithm.length;
    } else {
      throw new DOMException("Invalid length", "OperationError");
    }

    const keyData = op_crypto_generate_key(
      "HMAC",
      length === null
        ? getKeyLength({
          name: "HMAC",
          hash: normalizedAlgorithm.hash,
        })
        : length,
    );

    const algorithm = {
      name: "HMAC",
      hash: {
        name: normalizedAlgorithm.hash.name,
      },
      length: TypedArrayPrototypeGetByteLength(keyData) * 8,
    };

    return constructKey(
      "secret",
      extractable,
      usages,
      algorithm,
      new Uint8Array(keyData),
    );
  }

  function generateKeyAES(normalizedAlgorithm, extractable, usages) {
    const algorithmName = normalizedAlgorithm.name;

    const supportedUsages = algorithmName === "AES-KW"
      ? ["wrapKey", "unwrapKey"]
      : ["encrypt", "decrypt", "wrapKey", "unwrapKey"];
    if (
      ArrayPrototypeFind(
        usages,
        (u) => !ArrayPrototypeIncludes(supportedUsages, u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (!ArrayPrototypeIncludes([128, 192, 256], normalizedAlgorithm.length)) {
      throw new DOMException(
        `Invalid key length: ${normalizedAlgorithm.length}`,
        "OperationError",
      );
    }

    const keyData = op_crypto_generate_key("AES", normalizedAlgorithm.length);

    const algorithm = {
      name: algorithmName,
      length: normalizedAlgorithm.length,
    };

    return constructKey(
      "secret",
      extractable,
      usages,
      algorithm,
      new Uint8Array(keyData),
    );
  }

  async function generateKey(normalizedAlgorithm, extractable, usages) {
    switch (normalizedAlgorithm.name) {
      case "HMAC":
        return generateKeyHMAC(normalizedAlgorithm, extractable, usages);
      case "AES-CTR":
      case "AES-CBC":
      case "AES-GCM":
      case "AES-KW":
        return generateKeyAES(normalizedAlgorithm, extractable, usages);
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  // --- Per-algorithm implementations: importKey --------------------------

  function importKeyAES(
    format,
    normalizedAlgorithm,
    keyData,
    extractable,
    keyUsages,
    supportedKeyUsages,
  ) {
    if (
      ArrayPrototypeFind(
        keyUsages,
        (u) => !ArrayPrototypeIncludes(supportedKeyUsages, u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    const algorithmName = normalizedAlgorithm.name;
    let data = keyData;

    switch (format) {
      case "raw-secret":
      case "raw": {
        if (
          !ArrayPrototypeIncludes(
            [128, 192, 256],
            TypedArrayPrototypeGetByteLength(keyData) * 8,
          )
        ) {
          throw new DOMException("Invalid key length", "DataError");
        }
        break;
      }
      case "jwk": {
        const jwk = keyData;

        if (jwk.kty !== "oct") {
          throw new DOMException(
            "'kty' property of JsonWebKey must be 'oct'",
            "DataError",
          );
        }

        if (jwk.k === undefined) {
          throw new DOMException(
            "'k' property of JsonWebKey must be present",
            "DataError",
          );
        }

        data = base64urlDecode(jwk.k);

        switch (TypedArrayPrototypeGetByteLength(data) * 8) {
          case 128:
            if (
              jwk.alg !== undefined &&
              jwk.alg !== aesJwkAlg[algorithmName][128]
            ) {
              throw new DOMException(
                `Invalid algorithm: ${jwk.alg}`,
                "DataError",
              );
            }
            break;
          case 192:
            if (
              jwk.alg !== undefined &&
              jwk.alg !== aesJwkAlg[algorithmName][192]
            ) {
              throw new DOMException(
                `Invalid algorithm: ${jwk.alg}`,
                "DataError",
              );
            }
            break;
          case 256:
            if (
              jwk.alg !== undefined &&
              jwk.alg !== aesJwkAlg[algorithmName][256]
            ) {
              throw new DOMException(
                `Invalid algorithm: ${jwk.alg}`,
                "DataError",
              );
            }
            break;
          default:
            throw new DOMException("Invalid key length", "DataError");
        }

        if (
          keyUsages.length > 0 && jwk.use !== undefined && jwk.use !== "enc"
        ) {
          throw new DOMException("Invalid key usage", "DataError");
        }

        if (jwk.key_ops !== undefined) {
          if (
            ArrayPrototypeFind(
              jwk.key_ops,
              (u) => !ArrayPrototypeIncludes(recognisedUsages, u),
            ) !== undefined
          ) {
            throw new DOMException(
              "'key_ops' property of JsonWebKey is invalid",
              "DataError",
            );
          }
          if (
            !ArrayPrototypeEvery(
              keyUsages,
              (u) => ArrayPrototypeIncludes(jwk.key_ops, u),
            )
          ) {
            throw new DOMException(
              "'key_ops' property of JsonWebKey is invalid",
              "DataError",
            );
          }
        }

        if (jwk.ext === false && extractable === true) {
          throw new DOMException(
            "'ext' property of JsonWebKey must not be false if extractable is true",
            "DataError",
          );
        }
        break;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }

    const algorithm = {
      name: algorithmName,
      length: TypedArrayPrototypeGetByteLength(data) * 8,
    };

    return constructKey(
      "secret",
      extractable,
      usageIntersection(keyUsages, recognisedUsages),
      algorithm,
      new Uint8Array(data),
    );
  }

  function importKeyHMAC(
    format,
    normalizedAlgorithm,
    keyData,
    extractable,
    keyUsages,
  ) {
    if (
      ArrayPrototypeFind(
        keyUsages,
        (u) => !ArrayPrototypeIncludes(["sign", "verify"], u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    let hash;
    let data;

    switch (format) {
      case "raw-secret":
      case "raw": {
        data = keyData;
        hash = normalizedAlgorithm.hash;
        break;
      }
      case "jwk": {
        const jwk = keyData;

        if (jwk.kty !== "oct") {
          throw new DOMException(
            "'kty' property of JsonWebKey must be 'oct'",
            "DataError",
          );
        }

        if (jwk.k === undefined) {
          throw new DOMException(
            "'k' property of JsonWebKey must be present",
            "DataError",
          );
        }

        data = base64urlDecode(jwk.k);
        hash = normalizedAlgorithm.hash;

        switch (hash.name) {
          case "SHA-1":
            if (jwk.alg !== undefined && jwk.alg !== "HS1") {
              throw new DOMException(
                "'alg' property of JsonWebKey must be 'HS1'",
                "DataError",
              );
            }
            break;
          case "SHA-256":
            if (jwk.alg !== undefined && jwk.alg !== "HS256") {
              throw new DOMException(
                "'alg' property of JsonWebKey must be 'HS256'",
                "DataError",
              );
            }
            break;
          case "SHA-384":
            if (jwk.alg !== undefined && jwk.alg !== "HS384") {
              throw new DOMException(
                "'alg' property of JsonWebKey must be 'HS384'",
                "DataError",
              );
            }
            break;
          case "SHA-512":
            if (jwk.alg !== undefined && jwk.alg !== "HS512") {
              throw new DOMException(
                "'alg' property of JsonWebKey must be 'HS512'",
                "DataError",
              );
            }
            break;
          default:
            throw new TypeError("Unreachable");
        }

        if (
          keyUsages.length > 0 && jwk.use !== undefined && jwk.use !== "sig"
        ) {
          throw new DOMException(
            "'use' property of JsonWebKey must be 'sig'",
            "DataError",
          );
        }

        if (jwk.key_ops !== undefined) {
          if (
            ArrayPrototypeFind(
              jwk.key_ops,
              (u) => !ArrayPrototypeIncludes(recognisedUsages, u),
            ) !== undefined
          ) {
            throw new DOMException(
              "'key_ops' property of JsonWebKey is invalid",
              "DataError",
            );
          }
          if (
            !ArrayPrototypeEvery(
              keyUsages,
              (u) => ArrayPrototypeIncludes(jwk.key_ops, u),
            )
          ) {
            throw new DOMException(
              "'key_ops' property of JsonWebKey is invalid",
              "DataError",
            );
          }
        }

        if (jwk.ext === false && extractable === true) {
          throw new DOMException(
            "'ext' property of JsonWebKey must not be false if extractable is true",
            "DataError",
          );
        }
        break;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }

    let length = TypedArrayPrototypeGetByteLength(data) * 8;
    if (length === 0) {
      throw new DOMException("Key length is zero", "DataError");
    }
    if (normalizedAlgorithm.length !== undefined) {
      if (
        normalizedAlgorithm.length > length ||
        normalizedAlgorithm.length <= (length - 8)
      ) {
        throw new DOMException("Key length is invalid", "DataError");
      }
      length = normalizedAlgorithm.length;
    }

    const algorithm = {
      name: "HMAC",
      length,
      hash,
    };

    return constructKey(
      "secret",
      extractable,
      usageIntersection(keyUsages, recognisedUsages),
      algorithm,
      new Uint8Array(data),
    );
  }

  function importKeyHKDF(format, keyData, extractable, keyUsages) {
    if (
      ArrayPrototypeFind(
        keyUsages,
        (u) => !ArrayPrototypeIncludes(["deriveBits", "deriveKey"], u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (extractable !== false) {
      throw new DOMException(
        "Key must not be extractable",
        "SyntaxError",
      );
    }

    const algorithm = { name: "HKDF" };
    return constructKey(
      "secret",
      false,
      usageIntersection(keyUsages, recognisedUsages),
      algorithm,
      new Uint8Array(keyData),
    );
  }

  function importKeyPBKDF2(format, keyData, extractable, keyUsages) {
    if (
      ArrayPrototypeFind(
        keyUsages,
        (u) => !ArrayPrototypeIncludes(["deriveBits", "deriveKey"], u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (extractable !== false) {
      throw new DOMException(
        "Key must not be extractable",
        "SyntaxError",
      );
    }

    const algorithm = { name: "PBKDF2" };
    return constructKey(
      "secret",
      false,
      usageIntersection(keyUsages, recognisedUsages),
      algorithm,
      new Uint8Array(keyData),
    );
  }

  function importKeyInner(
    format,
    normalizedAlgorithm,
    keyData,
    extractable,
    keyUsages,
  ) {
    const algorithmName = normalizedAlgorithm.name;

    switch (algorithmName) {
      case "HMAC":
        return importKeyHMAC(
          format,
          normalizedAlgorithm,
          keyData,
          extractable,
          keyUsages,
        );
      case "AES-CTR":
      case "AES-CBC":
      case "AES-GCM":
        return importKeyAES(
          format,
          normalizedAlgorithm,
          keyData,
          extractable,
          keyUsages,
          ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
        );
      case "AES-KW":
        return importKeyAES(
          format,
          normalizedAlgorithm,
          keyData,
          extractable,
          keyUsages,
          ["wrapKey", "unwrapKey"],
        );
      case "HKDF":
        return importKeyHKDF(format, keyData, extractable, keyUsages);
      case "PBKDF2":
        return importKeyPBKDF2(format, keyData, extractable, keyUsages);
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  // --- Per-algorithm implementations: exportKey --------------------------

  function exportKeyAES(format, key) {
    switch (format) {
      case "raw-secret":
      case "raw": {
        const data = key[_keyData];
        const copy = new Uint8Array(TypedArrayPrototypeGetByteLength(data));
        copy.set(data);
        return TypedArrayPrototypeGetBuffer(copy);
      }
      case "jwk": {
        const jwk = { kty: "oct" };

        const data = key[_keyData];
        jwk.k = base64urlEncode(data);

        const algorithm = key[_algorithm];
        switch (algorithm.length) {
          case 128:
            jwk.alg = aesJwkAlg[algorithm.name][128];
            break;
          case 192:
            jwk.alg = aesJwkAlg[algorithm.name][192];
            break;
          case 256:
            jwk.alg = aesJwkAlg[algorithm.name][256];
            break;
          default:
            throw new DOMException(
              `Invalid key length: ${algorithm.length}`,
              "NotSupportedError",
            );
        }

        jwk.key_ops = key.usages;
        jwk.ext = key[_extractable];
        return jwk;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  function exportKeyHMAC(format, key) {
    switch (format) {
      case "raw-secret":
      case "raw": {
        const bits = key[_keyData];
        const copy = new Uint8Array(TypedArrayPrototypeGetByteLength(bits));
        copy.set(bits);
        return TypedArrayPrototypeGetBuffer(copy);
      }
      case "jwk": {
        const jwk = { kty: "oct" };

        const data = key[_keyData];
        jwk.k = base64urlEncode(data);

        const algorithm = key[_algorithm];
        const hash = algorithm.hash;
        switch (hash.name) {
          case "SHA-1":
            jwk.alg = "HS1";
            break;
          case "SHA-256":
            jwk.alg = "HS256";
            break;
          case "SHA-384":
            jwk.alg = "HS384";
            break;
          case "SHA-512":
            jwk.alg = "HS512";
            break;
          default:
            throw new DOMException(
              "Hash algorithm not supported",
              "NotSupportedError",
            );
        }
        jwk.key_ops = key.usages;
        jwk.ext = key[_extractable];
        return jwk;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  // --- Per-algorithm implementations: sign / verify ---------------------

  function signHMAC(key, data) {
    const hashAlgorithm = key[_algorithm].hash.name;
    const keyData = key[_keyData];
    const signature = op_crypto_sign_hmac(keyData, hashAlgorithm, data);
    return TypedArrayPrototypeGetBuffer(signature);
  }

  function verifyHMAC(key, signature, data) {
    const hashAlgorithm = key[_algorithm].hash.name;
    const keyData = key[_keyData];
    const computed = op_crypto_sign_hmac(keyData, hashAlgorithm, data);
    if (
      TypedArrayPrototypeGetByteLength(computed) !==
      TypedArrayPrototypeGetByteLength(signature)
    ) {
      return false;
    }
    const a = new Uint8Array(computed);
    const b = new Uint8Array(signature);
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  // --- Per-algorithm implementations: encrypt / decrypt ------------------

  function encryptAES(normalizedAlgorithm, key, data) {
    const keyData = key[_keyData];

    switch (normalizedAlgorithm.name) {
      case "AES-CBC": {
        normalizedAlgorithm.iv = copyBuffer(normalizedAlgorithm.iv);

        if (TypedArrayPrototypeGetByteLength(normalizedAlgorithm.iv) !== 16) {
          throw new DOMException(
            "Initialization vector must be 16 bytes",
            "OperationError",
          );
        }

        const cipherText = op_crypto_encrypt_aes_cbc(
          keyData,
          normalizedAlgorithm.iv,
          data,
        );
        return TypedArrayPrototypeGetBuffer(cipherText);
      }
      case "AES-CTR": {
        normalizedAlgorithm.counter = copyBuffer(normalizedAlgorithm.counter);

        if (
          TypedArrayPrototypeGetByteLength(normalizedAlgorithm.counter) !== 16
        ) {
          throw new DOMException(
            "Counter vector must be 16 bytes",
            "OperationError",
          );
        }

        if (
          normalizedAlgorithm.length === 0 ||
          normalizedAlgorithm.length > 128
        ) {
          throw new DOMException(
            `Counter length must not be 0 or greater than 128: received ${normalizedAlgorithm.length}`,
            "OperationError",
          );
        }

        const cipherText = op_crypto_encrypt_aes_ctr(
          keyData,
          normalizedAlgorithm.counter,
          normalizedAlgorithm.length,
          data,
        );
        return TypedArrayPrototypeGetBuffer(cipherText);
      }
      case "AES-GCM": {
        normalizedAlgorithm.iv = copyBuffer(normalizedAlgorithm.iv);

        if (
          !ArrayPrototypeIncludes(
            [12, 16],
            TypedArrayPrototypeGetByteLength(normalizedAlgorithm.iv),
          )
        ) {
          throw new DOMException(
            "Initialization vector length not supported",
            "NotSupportedError",
          );
        }

        if (normalizedAlgorithm.tagLength === undefined) {
          normalizedAlgorithm.tagLength = 128;
        } else if (
          !ArrayPrototypeIncludes(
            [32, 64, 96, 104, 112, 120, 128],
            normalizedAlgorithm.tagLength,
          )
        ) {
          throw new DOMException(
            `Invalid tag length: ${normalizedAlgorithm.tagLength}`,
            "OperationError",
          );
        }

        if (normalizedAlgorithm.additionalData) {
          normalizedAlgorithm.additionalData = copyBuffer(
            normalizedAlgorithm.additionalData,
          );
        }

        const cipherText = op_crypto_encrypt_aes_gcm(
          keyData,
          normalizedAlgorithm.iv,
          normalizedAlgorithm.additionalData || null,
          normalizedAlgorithm.tagLength,
          data,
        );
        return TypedArrayPrototypeGetBuffer(cipherText);
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  function decryptAES(normalizedAlgorithm, key, data) {
    const keyData = key[_keyData];

    switch (normalizedAlgorithm.name) {
      case "AES-CBC": {
        normalizedAlgorithm.iv = copyBuffer(normalizedAlgorithm.iv);

        if (TypedArrayPrototypeGetByteLength(normalizedAlgorithm.iv) !== 16) {
          throw new DOMException(
            "Initialization vector must be 16 bytes",
            "OperationError",
          );
        }

        try {
          const plainText = op_crypto_decrypt_aes_cbc(
            keyData,
            normalizedAlgorithm.iv,
            data,
          );
          return TypedArrayPrototypeGetBuffer(plainText);
        } catch (e) {
          throw new DOMException(
            "Decryption failed",
            "OperationError",
          );
        }
      }
      case "AES-CTR": {
        normalizedAlgorithm.counter = copyBuffer(normalizedAlgorithm.counter);

        if (
          TypedArrayPrototypeGetByteLength(normalizedAlgorithm.counter) !== 16
        ) {
          throw new DOMException(
            "Counter vector must be 16 bytes",
            "OperationError",
          );
        }

        if (
          normalizedAlgorithm.length === 0 ||
          normalizedAlgorithm.length > 128
        ) {
          throw new DOMException(
            `Counter length must not be 0 or greater than 128: received ${normalizedAlgorithm.length}`,
            "OperationError",
          );
        }

        const plainText = op_crypto_decrypt_aes_ctr(
          keyData,
          normalizedAlgorithm.counter,
          normalizedAlgorithm.length,
          data,
        );
        return TypedArrayPrototypeGetBuffer(plainText);
      }
      case "AES-GCM": {
        normalizedAlgorithm.iv = copyBuffer(normalizedAlgorithm.iv);

        if (
          !ArrayPrototypeIncludes(
            [12, 16],
            TypedArrayPrototypeGetByteLength(normalizedAlgorithm.iv),
          )
        ) {
          throw new DOMException(
            "Initialization vector length not supported",
            "NotSupportedError",
          );
        }

        if (normalizedAlgorithm.tagLength === undefined) {
          normalizedAlgorithm.tagLength = 128;
        } else if (
          !ArrayPrototypeIncludes(
            [32, 64, 96, 104, 112, 120, 128],
            normalizedAlgorithm.tagLength,
          )
        ) {
          throw new DOMException(
            `Invalid tag length: ${normalizedAlgorithm.tagLength}`,
            "OperationError",
          );
        }

        if (
          TypedArrayPrototypeGetByteLength(data) <
            normalizedAlgorithm.tagLength / 8
        ) {
          throw new DOMException(
            "The provided data is too small",
            "OperationError",
          );
        }

        if (normalizedAlgorithm.additionalData) {
          normalizedAlgorithm.additionalData = copyBuffer(
            normalizedAlgorithm.additionalData,
          );
        }

        try {
          const plainText = op_crypto_decrypt_aes_gcm(
            keyData,
            normalizedAlgorithm.iv,
            normalizedAlgorithm.additionalData || null,
            normalizedAlgorithm.tagLength,
            data,
          );
          return TypedArrayPrototypeGetBuffer(plainText);
        } catch (e) {
          throw new DOMException(
            "Decryption failed",
            "OperationError",
          );
        }
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  // --- SubtleCrypto --------------------------------------------------------

  class SubtleCrypto {
    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      this[webidl.brand] = webidl.brand;
    }

    async digest(algorithm, data) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");

      const prefix = "Failed to execute 'digest' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      data = webidl.converters.BufferSource(data, prefix, "Argument 2");

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "digest");
      data = copyBuffer(data);

      switch (normalizedAlgorithm.name) {
        case "SHA-1":
        case "SHA-256":
        case "SHA-384":
        case "SHA-512":
        case "SHA3-256":
        case "SHA3-384":
        case "SHA3-512": {
          const result = op_crypto_digest(normalizedAlgorithm.name, data);
          return TypedArrayPrototypeGetBuffer(result);
        }
        default:
          throw new DOMException(
            `Unrecognized algorithm name: ${normalizedAlgorithm.name}`,
            "NotSupportedError",
          );
      }
    }

    async encrypt(algorithm, key, data) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'encrypt' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 3, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      key = webidl.converters.CryptoKey(key, prefix, "Argument 2");
      data = webidl.converters.BufferSource(data, prefix, "Argument 3");

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "encrypt");
      data = copyBuffer(data);

      if (normalizedAlgorithm.name !== key[_algorithm].name) {
        throw new DOMException(
          `Encryption algorithm '${normalizedAlgorithm.name}' does not match key algorithm`,
          "InvalidAccessError",
        );
      }

      if (!ArrayPrototypeIncludes(key[_usages], "encrypt")) {
        throw new DOMException(
          "The requested operation is not valid for the provided key",
          "InvalidAccessError",
        );
      }

      switch (normalizedAlgorithm.name) {
        case "AES-CBC":
        case "AES-CTR":
        case "AES-GCM":
          return encryptAES(normalizedAlgorithm, key, data);
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
    }

    async decrypt(algorithm, key, data) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'decrypt' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 3, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      key = webidl.converters.CryptoKey(key, prefix, "Argument 2");
      data = webidl.converters.BufferSource(data, prefix, "Argument 3");

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "decrypt");
      data = copyBuffer(data);

      if (normalizedAlgorithm.name !== key[_algorithm].name) {
        throw new DOMException(
          `Decryption algorithm "${normalizedAlgorithm.name}" does not match key algorithm`,
          "OperationError",
        );
      }

      if (!ArrayPrototypeIncludes(key[_usages], "decrypt")) {
        throw new DOMException(
          "The requested operation is not valid for the provided key",
          "InvalidAccessError",
        );
      }

      switch (normalizedAlgorithm.name) {
        case "AES-CBC":
        case "AES-CTR":
        case "AES-GCM":
          return decryptAES(normalizedAlgorithm, key, data);
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
    }

    async sign(algorithm, key, data) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'sign' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 3, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      key = webidl.converters.CryptoKey(key, prefix, "Argument 2");
      data = webidl.converters.BufferSource(data, prefix, "Argument 3");

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "sign");
      data = copyBuffer(data);

      if (normalizedAlgorithm.name !== key[_algorithm].name) {
        throw new DOMException(
          "Signing algorithm does not match key algorithm",
          "InvalidAccessError",
        );
      }

      if (!ArrayPrototypeIncludes(key[_usages], "sign")) {
        throw new DOMException(
          "The requested operation is not valid for the provided key",
          "InvalidAccessError",
        );
      }

      switch (normalizedAlgorithm.name) {
        case "HMAC":
          return signHMAC(key, data);
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
    }

    async verify(algorithm, key, signature, data) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'verify' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 4, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      key = webidl.converters.CryptoKey(key, prefix, "Argument 2");
      signature = webidl.converters.BufferSource(signature, prefix, "Argument 3");
      data = webidl.converters.BufferSource(data, prefix, "Argument 4");

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "verify");
      signature = copyBuffer(signature);
      data = copyBuffer(data);

      if (normalizedAlgorithm.name !== key[_algorithm].name) {
        throw new DOMException(
          "Verifying algorithm does not match key algorithm",
          "InvalidAccessError",
        );
      }

      if (!ArrayPrototypeIncludes(key[_usages], "verify")) {
        throw new DOMException(
          "The requested operation is not valid for the provided key",
          "InvalidAccessError",
        );
      }

      switch (normalizedAlgorithm.name) {
        case "HMAC":
          return verifyHMAC(key, signature, data);
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
    }

    async generateKey(algorithm, extractable, keyUsages) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'generateKey' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 3, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      extractable = webidl.converters["boolean"](
        extractable,
        prefix,
        "Argument 2",
      );
      keyUsages = webidl.converters["sequence<KeyUsage>"](
        keyUsages,
        prefix,
        "Argument 3",
      );

      const usages = keyUsages;
      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "generateKey");
      const result = await generateKey(normalizedAlgorithm, extractable, usages);

      if (ObjectPrototypeIsPrototypeOf(CryptoKeyPrototype, result)) {
        const type = result[_type];
        if ((type === "secret" || type === "private") && usages.length === 0) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
      }

      return result;
    }

    async importKey(format, keyData, algorithm, extractable, keyUsages) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'importKey' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 4, prefix);
      format = webidl.converters.KeyFormat(format, prefix, "Argument 1");
      keyData = webidl.converters["BufferSource or JsonWebKey"](
        keyData,
        prefix,
        "Argument 2",
      );
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 3",
      );
      extractable = webidl.converters.boolean(extractable, prefix, "Argument 4");
      keyUsages = webidl.converters["sequence<KeyUsage>"](
        keyUsages,
        prefix,
        "Argument 5",
      );

      if (format !== "jwk") {
        if (ArrayBufferIsView(keyData) || isArrayBuffer(keyData)) {
          // Don't copy yet — normalize the algorithm first so that getters
          // on the algorithm object that mutate keyData are observed before
          // the copy (WPT "Key data altered during call" tests).
        } else {
          throw new TypeError("Cannot import key: 'keyData' is a JsonWebKey");
        }
      } else {
        if (ArrayBufferIsView(keyData) || isArrayBuffer(keyData)) {
          throw new TypeError("Cannot import key: 'keyData' is not a JsonWebKey");
        }
      }

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "importKey");

      if (format !== "jwk") {
        if (ArrayBufferIsView(keyData) || isArrayBuffer(keyData)) {
          keyData = copyBuffer(keyData);
        }
      }

      const result = importKeyInner(
        format,
        normalizedAlgorithm,
        keyData,
        extractable,
        keyUsages,
      );

      if (
        ArrayPrototypeIncludes(["private", "secret"], result[_type]) &&
        keyUsages.length === 0
      ) {
        throw new SyntaxError("Invalid key usage");
      }

      return result;
    }

    async exportKey(format, key) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'exportKey' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      format = webidl.converters.KeyFormat(format, prefix, "Argument 1");
      key = webidl.converters.CryptoKey(key, prefix, "Argument 2");

      const algorithmName = key[_algorithm].name;

      let result;

      switch (algorithmName) {
        case "HMAC":
          result = exportKeyHMAC(format, key);
          break;
        case "AES-CTR":
        case "AES-CBC":
        case "AES-GCM":
        case "AES-KW":
          result = exportKeyAES(format, key);
          break;
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }

      if (key[_extractable] === false) {
        throw new DOMException(
          "Key is not extractable",
          "InvalidAccessError",
        );
      }

      return result;
    }

    async deriveBits(algorithm, baseKey, length = null) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'deriveBits' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      baseKey = webidl.converters.CryptoKey(baseKey, prefix, "Argument 2");
      if (length !== null) {
        length = webidl.converters["unsigned long"](length, prefix, "Argument 3");
      }

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "deriveBits");

      if (normalizedAlgorithm.name !== baseKey[_algorithm].name) {
        throw new DOMException("Invalid algorithm name", "InvalidAccessError");
      }

      if (!ArrayPrototypeIncludes(baseKey[_usages], "deriveBits")) {
        throw new DOMException(
          "'baseKey' usages does not contain 'deriveBits'",
          "InvalidAccessError",
        );
      }

      throw new DOMException("Not implemented", "NotSupportedError");
    }

    async deriveKey(
      algorithm,
      baseKey,
      derivedKeyType,
      extractable,
      keyUsages,
    ) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'deriveKey' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 5, prefix);
      algorithm = webidl.converters.AlgorithmIdentifier(
        algorithm,
        prefix,
        "Argument 1",
      );
      baseKey = webidl.converters.CryptoKey(baseKey, prefix, "Argument 2");
      derivedKeyType = webidl.converters.AlgorithmIdentifier(
        derivedKeyType,
        prefix,
        "Argument 3",
      );
      extractable = webidl.converters["boolean"](
        extractable,
        prefix,
        "Argument 4",
      );
      keyUsages = webidl.converters["sequence<KeyUsage>"](
        keyUsages,
        prefix,
        "Argument 5",
      );

      const normalizedAlgorithm = normalizeAlgorithm(algorithm, "deriveBits");
      const normalizedDerivedKeyAlgorithmImport = normalizeAlgorithm(
        derivedKeyType,
        "importKey",
      );
      const normalizedDerivedKeyAlgorithmLength = normalizeAlgorithm(
        derivedKeyType,
        "get key length",
      );

      if (normalizedAlgorithm.name !== baseKey[_algorithm].name) {
        throw new DOMException(
          `Invalid algorithm name: ${normalizedAlgorithm.name}`,
          "InvalidAccessError",
        );
      }

      if (!ArrayPrototypeIncludes(baseKey[_usages], "deriveKey")) {
        throw new DOMException(
          "'baseKey' usages does not contain 'deriveKey'",
          "InvalidAccessError",
        );
      }

      throw new DOMException("Not implemented", "NotSupportedError");
    }

    async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'wrapKey' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 4, prefix);
      format = webidl.converters.KeyFormat(format, prefix, "Argument 1");
      key = webidl.converters.CryptoKey(key, prefix, "Argument 2");
      wrappingKey = webidl.converters.CryptoKey(
        wrappingKey,
        prefix,
        "Argument 3",
      );
      wrapAlgorithm = webidl.converters.AlgorithmIdentifier(
        wrapAlgorithm,
        prefix,
        "Argument 4",
      );

      let normalizedAlgorithm;
      try {
        normalizedAlgorithm = normalizeAlgorithm(wrapAlgorithm, "wrapKey");
      } catch (_) {
        normalizedAlgorithm = normalizeAlgorithm(wrapAlgorithm, "encrypt");
      }

      if (normalizedAlgorithm.name !== wrappingKey[_algorithm].name) {
        throw new DOMException(
          "Wrapping algorithm does not match key algorithm",
          "InvalidAccessError",
        );
      }

      if (!ArrayPrototypeIncludes(wrappingKey[_usages], "wrapKey")) {
        throw new DOMException(
          "The requested operation is not valid for the provided key",
          "InvalidAccessError",
        );
      }

      if (key[_extractable] === false) {
        throw new DOMException(
          "Key is not extractable",
          "InvalidAccessError",
        );
      }

      throw new DOMException("Not implemented", "NotSupportedError");
    }

    async unwrapKey(
      format,
      wrappedKey,
      unwrappingKey,
      unwrapAlgorithm,
      unwrappedKeyAlgorithm,
      extractable,
      keyUsages,
    ) {
      webidl.assertBranded(this, SubtleCryptoPrototype, "SubtleCrypto");
      const prefix = "Failed to execute 'unwrapKey' on 'SubtleCrypto'";
      webidl.requiredArguments(arguments.length, 7, prefix);
      format = webidl.converters.KeyFormat(format, prefix, "Argument 1");
      wrappedKey = webidl.converters.BufferSource(
        wrappedKey,
        prefix,
        "Argument 2",
      );
      unwrappingKey = webidl.converters.CryptoKey(
        unwrappingKey,
        prefix,
        "Argument 3",
      );
      unwrapAlgorithm = webidl.converters.AlgorithmIdentifier(
        unwrapAlgorithm,
        prefix,
        "Argument 4",
      );
      unwrappedKeyAlgorithm = webidl.converters.AlgorithmIdentifier(
        unwrappedKeyAlgorithm,
        prefix,
        "Argument 5",
      );
      extractable = webidl.converters.boolean(extractable, prefix, "Argument 6");
      keyUsages = webidl.converters["sequence<KeyUsage>"](
        keyUsages,
        prefix,
        "Argument 7",
      );

      let normalizedAlgorithm;
      try {
        normalizedAlgorithm = normalizeAlgorithm(unwrapAlgorithm, "unwrapKey");
      } catch (_) {
        normalizedAlgorithm = normalizeAlgorithm(unwrapAlgorithm, "decrypt");
      }

      const normalizedKeyAlgorithm = normalizeAlgorithm(
        unwrappedKeyAlgorithm,
        "importKey",
      );

      if (normalizedAlgorithm.name !== unwrappingKey[_algorithm].name) {
        throw new DOMException(
          "Unwrapping algorithm does not match key algorithm",
          "InvalidAccessError",
        );
      }

      if (!ArrayPrototypeIncludes(unwrappingKey[_usages], "unwrapKey")) {
        throw new DOMException(
          "The requested operation is not valid for the provided key",
          "InvalidAccessError",
        );
      }

      throw new DOMException("Not implemented", "NotSupportedError");
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
  globalThis.crypto = cryptoSingleton;
})(globalThis);