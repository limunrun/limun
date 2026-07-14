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
    op_crypto_generate_rsa_key,
    op_crypto_import_rsa_pkcs8,
    op_crypto_import_rsa_spki,
    op_crypto_export_rsa_pkcs8,
    op_crypto_export_rsa_spki,
    op_crypto_import_rsa_jwk,
    op_crypto_export_rsa_jwk,
    op_crypto_sign_rsa,
    op_crypto_verify_rsa,
    op_crypto_encrypt_rsa_oaep,
    op_crypto_decrypt_rsa_oaep,
    op_crypto_generate_ec_keypair,
    op_crypto_import_ec_raw,
    op_crypto_import_ec_pkcs8,
    op_crypto_import_ec_spki,
    op_crypto_export_ec_raw,
    op_crypto_export_ec_pkcs8,
    op_crypto_export_ec_spki,
    op_crypto_ec_public_from_private,
    op_crypto_import_ec_jwk_private,
    op_crypto_sign_ecdsa,
    op_crypto_verify_ecdsa,
    op_crypto_derive_bits_ecdh,
    op_crypto_generate_ed25519_keypair,
    op_crypto_import_spki_ed25519,
    op_crypto_import_pkcs8_ed25519,
    op_crypto_export_spki_ed25519,
    op_crypto_export_pkcs8_ed25519,
    op_crypto_jwk_x_ed25519,
    op_crypto_sign_ed25519,
    op_crypto_verify_ed25519,
    op_crypto_generate_x25519_keypair,
    op_crypto_import_spki_x25519,
    op_crypto_import_pkcs8_x25519,
    op_crypto_export_spki_x25519,
    op_crypto_export_pkcs8_x25519,
    op_crypto_x25519_public_key,
    op_crypto_derive_bits_x25519,
    op_crypto_derive_bits_hkdf,
    op_crypto_derive_bits_pbkdf2,
    op_crypto_wrap_key_aes_kw,
    op_crypto_unwrap_key_aes_kw,
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
      "Ed25519": null,
      "X25519": null,
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
      "Ed25519": null,
      "HMAC": null,
    },
    "verify": {
      "RSASSA-PKCS1-v1_5": null,
      "RSA-PSS": "RsaPssParams",
      "ECDSA": "EcdsaParams",
      "Ed25519": null,
      "HMAC": null,
    },
    "importKey": {
      "RSASSA-PKCS1-v1_5": "RsaHashedImportParams",
      "RSA-PSS": "RsaHashedImportParams",
      "RSA-OAEP": "RsaHashedImportParams",
      "ECDSA": "EcKeyImportParams",
      "ECDH": "EcKeyImportParams",
      "Ed25519": null,
      "X25519": null,
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
      "X25519": "EcdhKeyDeriveParams",
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

  const rsaJwkAlg = {
    "RSASSA-PKCS1-v1_5": {
      "SHA-1": "RS1",
      "SHA-256": "RS256",
      "SHA-384": "RS384",
      "SHA-512": "RS512",
    },
    "RSA-PSS": {
      "SHA-1": "PS1",
      "SHA-256": "PS256",
      "SHA-384": "PS384",
      "SHA-512": "PS512",
    },
    "RSA-OAEP": {
      "SHA-1": "RSA-OAEP",
      "SHA-256": "RSA-OAEP-256",
      "SHA-384": "RSA-OAEP-384",
      "SHA-512": "RSA-OAEP-512",
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
  const _publicKey = Symbol("publicKey");

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

  const dictEcdhKeyDeriveParams = [
    ...new SafeArrayIterator(dictAlgorithm),
    {
      key: "public",
      converter: webidl.converters.CryptoKey,
      required: true,
    },
  ];

  webidl.converters.EcdhKeyDeriveParams = webidl.createDictionaryConverter(
    "EcdhKeyDeriveParams",
    dictEcdhKeyDeriveParams,
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

  function generateKeyRSA(normalizedAlgorithm, extractable, usages, type) {
    const algorithmName = normalizedAlgorithm.name;
    const validUsages = algorithmName === "RSA-OAEP"
      ? ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
      : ["sign", "verify"];
    if (
      ArrayPrototypeFind(
        usages,
        (u) => !ArrayPrototypeIncludes(validUsages, u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (type === "private") {
      const keyPair = op_crypto_generate_rsa_key(
        normalizedAlgorithm.modulusLength,
        new Uint8Array(normalizedAlgorithm.publicExponent),
      );
      const algorithm = {
        name: normalizedAlgorithm.name,
        modulusLength: normalizedAlgorithm.modulusLength,
        publicExponent: new Uint8Array(normalizedAlgorithm.publicExponent),
        hash: { name: normalizedAlgorithm.hash.name },
      };
      const privateUsages = algorithmName === "RSA-OAEP"
        ? ["decrypt", "unwrapKey"]
        : ["sign"];
      const publicUsages = algorithmName === "RSA-OAEP"
        ? ["encrypt", "wrapKey"]
        : ["verify"];
      const privateKey = constructKey(
        "private",
        extractable,
        usageIntersection(usages, privateUsages),
        algorithm,
        new Uint8Array(keyPair.privateKey),
      );
      const publicKey = constructKey(
        "public",
        true,
        usageIntersection(usages, publicUsages),
        algorithm,
        new Uint8Array(keyPair.publicKey),
      );
      return { privateKey, publicKey };
    }

    throw new DOMException("Not implemented", "NotSupportedError");
  }

  function generateKeyEC(normalizedAlgorithm, extractable, usages, type) {
    const isECDSA = normalizedAlgorithm.name === "ECDSA";
    const validUsages = isECDSA
      ? ["sign", "verify"]
      : ["deriveBits", "deriveKey"];
    if (
      ArrayPrototypeFind(
        usages,
        (u) => !ArrayPrototypeIncludes(validUsages, u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (type === "private") {
      const keyPair = op_crypto_generate_ec_keypair(normalizedAlgorithm.namedCurve);
      const algorithm = {
        name: normalizedAlgorithm.name,
        namedCurve: normalizedAlgorithm.namedCurve,
      };
      const privateUsages = isECDSA ? ["sign"] : ["deriveBits", "deriveKey"];
      const publicUsages = isECDSA ? ["verify"] : [];
      const privateKey = constructKey(
        "private",
        extractable,
        usageIntersection(usages, privateUsages),
        algorithm,
        new Uint8Array(keyPair.privateKey),
      );
      const publicKey = constructKey(
        "public",
        true,
        usageIntersection(usages, publicUsages),
        algorithm,
        new Uint8Array(keyPair.publicKey),
      );
      return { privateKey, publicKey };
    }

    throw new DOMException("Not implemented", "NotSupportedError");
  }

  function generateKeyEd25519(_normalizedAlgorithm, extractable, usages, type) {
    const validUsages = ["sign", "verify"];
    if (
      ArrayPrototypeFind(
        usages,
        (u) => !ArrayPrototypeIncludes(validUsages, u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (type === "private") {
      const keyPair = op_crypto_generate_ed25519_keypair();
      const algorithm = { name: "Ed25519" };
      const privateKey = constructKey(
        "private",
        extractable,
        usageIntersection(usages, ["sign"]),
        algorithm,
        new Uint8Array(keyPair.privateKey),
      );
      const publicKey = constructKey(
        "public",
        true,
        usageIntersection(usages, ["verify"]),
        algorithm,
        new Uint8Array(keyPair.publicKey),
      );
      return { privateKey, publicKey };
    }

    throw new DOMException("Not implemented", "NotSupportedError");
  }

  function generateKeyX25519(_normalizedAlgorithm, extractable, usages, type) {
    const validUsages = ["deriveBits", "deriveKey"];
    if (
      ArrayPrototypeFind(
        usages,
        (u) => !ArrayPrototypeIncludes(validUsages, u),
      ) !== undefined
    ) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }

    if (type === "private") {
      const keyPair = op_crypto_generate_x25519_keypair();
      const algorithm = { name: "X25519" };
      const privateKey = constructKey(
        "private",
        extractable,
        usageIntersection(usages, ["deriveBits", "deriveKey"]),
        algorithm,
        new Uint8Array(keyPair.privateKey),
      );
      const publicKey = constructKey(
        "public",
        true,
        [],
        algorithm,
        new Uint8Array(keyPair.publicKey),
      );
      return { privateKey, publicKey };
    }

    throw new DOMException("Not implemented", "NotSupportedError");
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
      case "RSASSA-PKCS1-v1_5":
      case "RSA-PSS":
      case "RSA-OAEP":
        return generateKeyRSA(normalizedAlgorithm, extractable, usages, "private");
      case "ECDSA":
      case "ECDH":
        return generateKeyEC(normalizedAlgorithm, extractable, usages, "private");
      case "Ed25519":
        return generateKeyEd25519(normalizedAlgorithm, extractable, usages, "private");
      case "X25519":
        return generateKeyX25519(normalizedAlgorithm, extractable, usages, "private");
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

  function importKeyRSA(
    format,
    normalizedAlgorithm,
    keyData,
    extractable,
    keyUsages,
  ) {
    const algorithmName = normalizedAlgorithm.name;
    const hash = normalizedAlgorithm.hash;
    const supportedPrivateUsages = algorithmName === "RSA-OAEP"
      ? ["decrypt", "unwrapKey"]
      : ["sign"];
    const supportedPublicUsages = algorithmName === "RSA-OAEP"
      ? ["encrypt", "wrapKey"]
      : ["verify"];

    let key;
    let type;

    switch (format) {
      case "pkcs8": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        let data;
        try {
          data = op_crypto_import_rsa_pkcs8(new Uint8Array(keyData));
        } catch (e) {
          if (e instanceof DOMException) throw e;
          throw new DOMException(e.message, "DataError");
        }
        key = constructKey(
          "private",
          extractable,
          usageIntersection(keyUsages, recognisedUsages),
          {
            name: algorithmName,
            modulusLength: data.modulusLength,
            publicExponent: new Uint8Array(data.publicExponent),
            hash: { name: hash.name },
          },
          new Uint8Array(data.rawData),
        );
        type = "private";
        break;
      }
      case "spki": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        let data;
        try {
          data = op_crypto_import_rsa_spki(new Uint8Array(keyData));
        } catch (e) {
          if (e instanceof DOMException) throw e;
          throw new DOMException(e.message, "DataError");
        }
        key = constructKey(
          "public",
          extractable,
          usageIntersection(keyUsages, recognisedUsages),
          {
            name: algorithmName,
            modulusLength: data.modulusLength,
            publicExponent: new Uint8Array(data.publicExponent),
            hash: { name: hash.name },
          },
          new Uint8Array(data.rawData),
        );
        type = "public";
        break;
      }
      case "jwk": {
        const jwk = keyData;

        if (jwk.kty !== "RSA") {
          throw new DOMException(
            "'kty' property of JsonWebKey must be 'RSA'",
            "DataError",
          );
        }

        const isPrivate = jwk.d !== undefined;

        if (isPrivate) {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }
        } else {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }
        }

        const hashName = hash.name;
        const expectedAlg = rsaJwkAlg[algorithmName][hashName];
        if (jwk.alg !== undefined && jwk.alg !== expectedAlg) {
          throw new DOMException(
            `'alg' property of JsonWebKey must be '${expectedAlg}'`,
            "DataError",
          );
        }

        if (isPrivate) {
          if (jwk.n === undefined || jwk.e === undefined || jwk.d === undefined) {
            throw new DOMException(
              "JWK must contain 'n', 'e', and 'd' for private key",
              "DataError",
            );
          }
        } else {
          if (jwk.n === undefined || jwk.e === undefined) {
            throw new DOMException(
              "JWK must contain 'n' and 'e' for public key",
              "DataError",
            );
          }
        }

        if (
          keyUsages.length > 0 && jwk.use !== undefined &&
          !(
            (algorithmName === "RSA-OAEP" && jwk.use === "enc") ||
            (algorithmName !== "RSA-OAEP" && jwk.use === "sig")
          )
        ) {
          throw new DOMException(
            "'use' property of JsonWebKey is invalid",
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

        let data;
        try {
          data = op_crypto_import_rsa_jwk(jwk);
        } catch (e) {
          if (e instanceof DOMException) throw e;
          throw new DOMException(e.message, "DataError");
        }

        key = constructKey(
          data.keyType,
          extractable,
          usageIntersection(keyUsages, recognisedUsages),
          {
            name: algorithmName,
            modulusLength: data.modulusLength,
            publicExponent: new Uint8Array(data.publicExponent),
            hash: { name: hash.name },
          },
          new Uint8Array(data.rawData),
        );
        type = data.keyType;
        break;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }

    if (type === "private" && keyUsages.length === 0) {
      throw new DOMException("Invalid key usage", "SyntaxError");
    }
    return key;
  }

  function importKeyEC(
    format,
    normalizedAlgorithm,
    keyData,
    extractable,
    keyUsages,
  ) {
    const algorithmName = normalizedAlgorithm.name;
    const namedCurve = normalizedAlgorithm.namedCurve;
    const supportedPrivateUsages = algorithmName === "ECDSA"
      ? ["sign"]
      : ["deriveBits", "deriveKey"];
    const supportedPublicUsages = algorithmName === "ECDSA"
      ? ["verify"]
      : [];

    let keyDataBytes;
    let type;
    let publicKeyData;

    switch (format) {
      case "raw": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        try {
          keyDataBytes = op_crypto_import_ec_raw(
            namedCurve,
            new Uint8Array(keyData),
          );
        } catch (e) {
          if (e instanceof DOMException) throw e;
          throw new DOMException(e.message, "DataError");
        }
        type = "public";
        break;
      }
      case "pkcs8": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        try {
          keyDataBytes = op_crypto_import_ec_pkcs8(
            namedCurve,
            new Uint8Array(keyData),
          );
        } catch (e) {
          if (e instanceof DOMException) throw e;
          throw new DOMException(e.message, "DataError");
        }
        type = "private";
        break;
      }
      case "spki": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        try {
          keyDataBytes = op_crypto_import_ec_spki(
            namedCurve,
            new Uint8Array(keyData),
          );
        } catch (e) {
          if (e instanceof DOMException) throw e;
          throw new DOMException(e.message, "DataError");
        }
        type = "public";
        break;
      }
      case "jwk": {
        const jwk = keyData;
        if (jwk.kty !== "EC") {
          throw new DOMException(
            "'kty' property of JsonWebKey must be 'EC'",
            "DataError",
          );
        }
        if (jwk.crv !== namedCurve) {
          throw new DOMException(
            "'crv' property of JsonWebKey must match curve",
            "DataError",
          );
        }

        if (jwk.d !== undefined) {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }

          if (jwk.x === undefined) {
            throw new DOMException(
              "'x' property of JsonWebKey is required for private key",
              "DataError",
            );
          }
          if (jwk.y === undefined) {
            throw new DOMException(
              "'y' property of JsonWebKey is required for private key",
              "DataError",
            );
          }

          const x = base64urlDecode(jwk.x);
          const y = base64urlDecode(jwk.y);
          const coordLen = namedCurve === "P-256"
            ? 32
            : namedCurve === "P-384"
            ? 48
            : 66;
          if (x.byteLength !== coordLen || y.byteLength !== coordLen) {
            throw new DOMException(
              "Bad key length",
              "DataError",
            );
          }

          if (
            keyUsages.length > 0 && jwk.use !== undefined &&
            jwk.use !== "sig" && jwk.use !== "enc"
          ) {
            throw new DOMException(
              "'use' property of JsonWebKey is invalid",
              "DataError",
            );
          }

          if (jwk.ext === false && extractable === true) {
            throw new DOMException(
              "'ext' property of JsonWebKey must not be false if extractable is true",
              "DataError",
            );
          }

          const d = base64urlDecode(jwk.d);
          let privBytes;
          try {
            privBytes = op_crypto_import_ec_jwk_private(namedCurve, d);
          } catch (e) {
            if (e instanceof DOMException) throw e;
            throw new DOMException(e.message, "DataError");
          }
          keyDataBytes = privBytes;
          type = "private";
          const pubBytes = op_crypto_ec_public_from_private(namedCurve, keyDataBytes);
          publicKeyData = pubBytes;
        } else {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }
          if (jwk.x === undefined || jwk.y === undefined) {
            throw new DOMException(
              "JWK must contain 'x' and 'y' for public key",
              "DataError",
            );
          }
          const x = base64urlDecode(jwk.x);
          const y = base64urlDecode(jwk.y);
          const rawLen = x.byteLength + y.byteLength + 1;
          const raw = new Uint8Array(rawLen);
          raw[0] = 0x04;
          raw.set(x, 1);
          raw.set(y, 1 + x.byteLength);
          try {
            keyDataBytes = op_crypto_import_ec_raw(namedCurve, raw);
          } catch (e) {
            if (e instanceof DOMException) throw e;
            throw new DOMException(e.message, "DataError");
          }
          type = "public";
        }
        break;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }

    const algorithm = {
      name: algorithmName,
      namedCurve: namedCurve,
    };
    const key = constructKey(
      type,
      extractable,
      usageIntersection(keyUsages, recognisedUsages),
      algorithm,
      new Uint8Array(keyDataBytes),
    );
    if (type === "private" && publicKeyData !== undefined) {
      key[_publicKey] = constructKey(
        "public",
        true,
        [],
        algorithm,
        new Uint8Array(publicKeyData),
      );
    }
    return key;
  }

  function importKeyEd25519(
    format,
    keyData,
    extractable,
    keyUsages,
  ) {
    const supportedPrivateUsages = ["sign"];
    const supportedPublicUsages = ["verify"];
    let keyDataBytes;
    let type;

    switch (format) {
      case "raw": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        keyDataBytes = new Uint8Array(keyData);
        if (keyDataBytes.byteLength !== 32) {
          throw new DOMException("Invalid key length", "DataError");
        }
        type = "public";
        break;
      }
      case "pkcs8": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        const out = new Uint8Array(32);
        if (!op_crypto_import_pkcs8_ed25519(new Uint8Array(keyData), out)) {
          throw new DOMException("Invalid Ed25519 key", "DataError");
        }
        keyDataBytes = out;
        type = "private";
        break;
      }
      case "spki": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        const out = new Uint8Array(32);
        if (!op_crypto_import_spki_ed25519(new Uint8Array(keyData), out)) {
          throw new DOMException("Invalid Ed25519 key", "DataError");
        }
        keyDataBytes = out;
        type = "public";
        break;
      }
      case "jwk": {
        const jwk = keyData;
        if (jwk.kty !== "OKP") {
          throw new DOMException(
            "'kty' property of JsonWebKey must be 'OKP'",
            "DataError",
          );
        }
        if (jwk.crv !== "Ed25519") {
          throw new DOMException(
            "'crv' property of JsonWebKey must be 'Ed25519'",
            "DataError",
          );
        }
        if (jwk.ext !== undefined && jwk.ext === false && extractable) {
          throw new DOMException("Invalid key extractability", "DataError");
        }
        if (jwk.d !== undefined) {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }
          keyDataBytes = base64urlDecode(jwk.d);
          type = "private";
        } else {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPublicUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }
          if (jwk.x === undefined) {
            throw new DOMException(
              "JWK must contain 'x' for public key",
              "DataError",
            );
          }
          keyDataBytes = base64urlDecode(jwk.x);
          type = "public";
        }
        if (keyDataBytes.byteLength !== 32) {
          throw new DOMException("Invalid key length", "DataError");
        }
        break;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }

    return constructKey(
      type,
      extractable,
      usageIntersection(keyUsages, recognisedUsages),
      { name: "Ed25519" },
      new Uint8Array(keyDataBytes),
    );
  }

  function importKeyX25519(
    format,
    keyData,
    extractable,
    keyUsages,
  ) {
    const supportedPrivateUsages = ["deriveBits", "deriveKey"];
    let keyDataBytes;
    let type;

    switch (format) {
      case "raw": {
        keyDataBytes = new Uint8Array(keyData);
        if (keyDataBytes.byteLength !== 32) {
          throw new DOMException("Invalid key length", "DataError");
        }
        type = "public";
        break;
      }
      case "pkcs8": {
        if (
          ArrayPrototypeFind(
            keyUsages,
            (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
          ) !== undefined
        ) {
          throw new DOMException("Invalid key usage", "SyntaxError");
        }
        const out = new Uint8Array(32);
        if (!op_crypto_import_pkcs8_x25519(new Uint8Array(keyData), out)) {
          throw new DOMException("Invalid X25519 key", "DataError");
        }
        keyDataBytes = out;
        type = "private";
        break;
      }
      case "spki": {
        const out = new Uint8Array(32);
        if (!op_crypto_import_spki_x25519(new Uint8Array(keyData), out)) {
          throw new DOMException("Invalid X25519 key", "DataError");
        }
        keyDataBytes = out;
        type = "public";
        break;
      }
      case "jwk": {
        const jwk = keyData;
        if (jwk.kty !== "OKP") {
          throw new DOMException(
            "'kty' property of JsonWebKey must be 'OKP'",
            "DataError",
          );
        }
        if (jwk.crv !== "X25519") {
          throw new DOMException(
            "'crv' property of JsonWebKey must be 'X25519'",
            "DataError",
          );
        }
        if (jwk.ext !== undefined && jwk.ext === false && extractable) {
          throw new DOMException("Invalid key extractability", "DataError");
        }
        if (jwk.d !== undefined) {
          if (
            ArrayPrototypeFind(
              keyUsages,
              (u) => !ArrayPrototypeIncludes(supportedPrivateUsages, u),
            ) !== undefined
          ) {
            throw new DOMException("Invalid key usage", "SyntaxError");
          }
          keyDataBytes = base64urlDecode(jwk.d);
          type = "private";
        } else {
          if (jwk.x === undefined) {
            throw new DOMException(
              "JWK must contain 'x' for public key",
              "DataError",
            );
          }
          keyDataBytes = base64urlDecode(jwk.x);
          type = "public";
        }
        if (keyDataBytes.byteLength !== 32) {
          throw new DOMException("Invalid key length", "DataError");
        }
        break;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }

    return constructKey(
      type,
      extractable,
      usageIntersection(keyUsages, recognisedUsages),
      { name: "X25519" },
      new Uint8Array(keyDataBytes),
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
      case "RSASSA-PKCS1-v1_5":
      case "RSA-PSS":
      case "RSA-OAEP":
        return importKeyRSA(
          format,
          normalizedAlgorithm,
          keyData,
          extractable,
          keyUsages,
        );
      case "ECDSA":
      case "ECDH":
        return importKeyEC(
          format,
          normalizedAlgorithm,
          keyData,
          extractable,
          keyUsages,
        );
      case "Ed25519":
        return importKeyEd25519(format, keyData, extractable, keyUsages);
      case "X25519":
        return importKeyX25519(format, keyData, extractable, keyUsages);
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

  function exportKeyRSA(format, key) {
    const keyData = key[_keyData];
    const type = key[_type];

    switch (format) {
      case "pkcs8": {
        if (type !== "private") {
          throw new DOMException(
            "Invalid key type for pkcs8 export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_rsa_pkcs8(keyData),
        );
      }
      case "spki": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for spki export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_rsa_spki(keyData),
        );
      }
      case "jwk": {
        const algorithmName = key[_algorithm].name;
        const hashName = key[_algorithm].hash.name;
        const jwk = op_crypto_export_rsa_jwk(keyData, type);
        jwk.kty = "RSA";
        jwk.alg = rsaJwkAlg[algorithmName][hashName];
        jwk.key_ops = key.usages;
        jwk.ext = key[_extractable];
        return jwk;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  function exportKeyEC(format, key) {
    const keyData = key[_keyData];
    const type = key[_type];
    const namedCurve = key[_algorithm].namedCurve;

    switch (format) {
      case "raw": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for raw export",
            "InvalidAccessError",
          );
        }
        const copy = new Uint8Array(TypedArrayPrototypeGetByteLength(keyData));
        copy.set(keyData);
        return TypedArrayPrototypeGetBuffer(copy);
      }
      case "pkcs8": {
        if (type !== "private") {
          throw new DOMException(
            "Invalid key type for pkcs8 export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_ec_pkcs8(namedCurve, keyData),
        );
      }
      case "spki": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for spki export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_ec_spki(namedCurve, keyData),
        );
      }
      case "jwk": {
        const jwk = { kty: "EC" };
        jwk.crv = namedCurve;
        if (type === "private") {
          jwk.d = base64urlEncode(keyData);
          let pub = key[_publicKey] !== undefined
            ? key[_publicKey][_keyData]
            : op_crypto_ec_public_from_private(namedCurve, keyData);
          jwk.x = base64urlEncode(pub.slice(1, 1 + pub.byteLength / 2));
          jwk.y = base64urlEncode(pub.slice(1 + pub.byteLength / 2));
        } else {
          jwk.x = base64urlEncode(keyData.slice(1, 1 + keyData.byteLength / 2));
          jwk.y = base64urlEncode(keyData.slice(1 + keyData.byteLength / 2));
        }
        jwk.key_ops = key.usages;
        jwk.ext = key[_extractable];
        return jwk;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  function exportKeyEd25519(format, key) {
    const keyData = key[_keyData];
    const type = key[_type];

    switch (format) {
      case "raw": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for raw export",
            "InvalidAccessError",
          );
        }
        const copy = new Uint8Array(TypedArrayPrototypeGetByteLength(keyData));
        copy.set(keyData);
        return TypedArrayPrototypeGetBuffer(copy);
      }
      case "pkcs8": {
        if (type !== "private") {
          throw new DOMException(
            "Invalid key type for pkcs8 export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_pkcs8_ed25519(keyData),
        );
      }
      case "spki": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for spki export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_spki_ed25519(keyData),
        );
      }
      case "jwk": {
        const jwk = { kty: "OKP", crv: "Ed25519" };
        if (type === "private") {
          jwk.d = base64urlEncode(keyData);
          jwk.x = op_crypto_jwk_x_ed25519(keyData);
        } else {
          jwk.x = base64urlEncode(keyData);
        }
        jwk.key_ops = key.usages;
        jwk.ext = key[_extractable];
        return jwk;
      }
      default:
        throw new DOMException("Not implemented", "NotSupportedError");
    }
  }

  function exportKeyX25519(format, key) {
    const keyData = key[_keyData];
    const type = key[_type];

    switch (format) {
      case "raw": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for raw export",
            "InvalidAccessError",
          );
        }
        const copy = new Uint8Array(TypedArrayPrototypeGetByteLength(keyData));
        copy.set(keyData);
        return TypedArrayPrototypeGetBuffer(copy);
      }
      case "pkcs8": {
        if (type !== "private") {
          throw new DOMException(
            "Invalid key type for pkcs8 export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_pkcs8_x25519(keyData),
        );
      }
      case "spki": {
        if (type !== "public") {
          throw new DOMException(
            "Invalid key type for spki export",
            "InvalidAccessError",
          );
        }
        return TypedArrayPrototypeGetBuffer(
          op_crypto_export_spki_x25519(keyData),
        );
      }
      case "jwk": {
        const jwk = { kty: "OKP", crv: "X25519" };
        if (type === "private") {
          jwk.d = base64urlEncode(keyData);
          jwk.x = base64urlEncode(op_crypto_x25519_public_key(keyData));
        } else {
          jwk.x = base64urlEncode(keyData);
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

  function signRSA(key, data, algorithm) {
    const keyData = key[_keyData];
    const hashName = key[_algorithm].hash.name;
    const saltLength = algorithm.name === "RSA-PSS"
      ? algorithm.saltLength
      : 0;
    return TypedArrayPrototypeGetBuffer(
      op_crypto_sign_rsa(
        keyData,
        algorithm.name,
        hashName,
        saltLength,
        data,
      ),
    );
  }

  function verifyRSA(key, signature, data, algorithm) {
    const keyData = key[_keyData];
    const hashName = key[_algorithm].hash.name;
    const saltLength = algorithm.name === "RSA-PSS"
      ? algorithm.saltLength
      : 0;
    return op_crypto_verify_rsa(
      keyData,
      algorithm.name,
      hashName,
      saltLength,
      signature,
      data,
    );
  }

  function signECDSA(key, data, algorithm) {
    const keyData = key[_keyData];
    const hashName = algorithm.hash.name;
    const namedCurve = key[_algorithm].namedCurve;
    return TypedArrayPrototypeGetBuffer(
      op_crypto_sign_ecdsa(namedCurve, hashName, keyData, data),
    );
  }

  function verifyECDSA(key, signature, data, algorithm) {
    const keyData = key[_keyData];
    const hashName = algorithm.hash.name;
    const namedCurve = key[_algorithm].namedCurve;
    return op_crypto_verify_ecdsa(namedCurve, hashName, keyData, signature, data);
  }

  function signEd25519(key, data) {
    const keyData = key[_keyData];
    const out = new Uint8Array(64);
    if (!op_crypto_sign_ed25519(keyData, data, out)) {
      throw new DOMException("Ed25519 sign failed", "OperationError");
    }
    return TypedArrayPrototypeGetBuffer(out);
  }

  function verifyEd25519(key, signature, data) {
    const keyData = key[_keyData];
    return op_crypto_verify_ed25519(keyData, data, signature);
  }

  function encryptRSAOAEP(normalizedAlgorithm, key, data) {
    const keyData = key[_keyData];
    const label = normalizedAlgorithm.label !== undefined
      ? copyBuffer(normalizedAlgorithm.label)
      : null;
    const hashName = key[_algorithm].hash.name;
    try {
      return TypedArrayPrototypeGetBuffer(
        op_crypto_encrypt_rsa_oaep(keyData, hashName, label, data),
      );
    } catch (e) {
      throw new DOMException(e.message, "OperationError");
    }
  }

  function decryptRSAOAEP(normalizedAlgorithm, key, data) {
    const keyData = key[_keyData];
    const label = normalizedAlgorithm.label !== undefined
      ? copyBuffer(normalizedAlgorithm.label)
      : null;
    const hashName = key[_algorithm].hash.name;
    try {
      return TypedArrayPrototypeGetBuffer(
        op_crypto_decrypt_rsa_oaep(keyData, hashName, label, data),
      );
    } catch (e) {
      throw new DOMException(e.message, "OperationError");
    }
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

  // --- Per-algorithm implementations: derive bits / wrap key ---------------

  function deriveBitsECDH(normalizedAlgorithm, baseKey, length) {
    if (baseKey[_type] !== "private") {
      throw new DOMException("Invalid key type", "InvalidAccessError");
    }
    const publicKey = normalizedAlgorithm.public;
    if (publicKey[_type] !== "public") {
      throw new DOMException("Invalid key type", "InvalidAccessError");
    }
    if (publicKey[_algorithm].name !== baseKey[_algorithm].name) {
      throw new DOMException("Algorithm mismatch", "InvalidAccessError");
    }
    if (
      publicKey[_algorithm].namedCurve !== baseKey[_algorithm].namedCurve
    ) {
      throw new DOMException("'namedCurve' mismatch", "InvalidAccessError");
    }
    const namedCurve = baseKey[_algorithm].namedCurve;
    const result = op_crypto_derive_bits_ecdh(
      namedCurve,
      baseKey[_keyData],
      publicKey[_keyData],
      length ?? 0,
    );
    if (length === null) {
      return TypedArrayPrototypeGetBuffer(result);
    }
    if (TypedArrayPrototypeGetByteLength(result) * 8 < length) {
      throw new DOMException("Invalid length", "OperationError");
    }
    return ArrayBufferPrototypeSlice(
      TypedArrayPrototypeGetBuffer(result),
      0,
      MathCeil(length / 8),
    );
  }

  function deriveBitsX25519(normalizedAlgorithm, baseKey, length) {
    if (baseKey[_type] !== "private") {
      throw new DOMException("Invalid key type", "InvalidAccessError");
    }
    const publicKey = normalizedAlgorithm.public;
    if (publicKey[_type] !== "public") {
      throw new DOMException("Invalid key type", "InvalidAccessError");
    }
    if (publicKey[_algorithm].name !== baseKey[_algorithm].name) {
      throw new DOMException("Algorithm mismatch", "InvalidAccessError");
    }
    const secret = new Uint8Array(32);
    if (!op_crypto_derive_bits_x25519(
      baseKey[_keyData],
      publicKey[_keyData],
      secret,
    )) {
      throw new DOMException("Invalid key", "OperationError");
    }
    if (length === null) {
      return TypedArrayPrototypeGetBuffer(secret);
    }
    if (TypedArrayPrototypeGetByteLength(secret) * 8 < length) {
      throw new DOMException("Invalid length", "OperationError");
    }
    return ArrayBufferPrototypeSlice(
      TypedArrayPrototypeGetBuffer(secret),
      0,
      MathCeil(length / 8),
    );
  }

  function deriveBitsHKDF(normalizedAlgorithm, baseKey, length) {
    if (length === null || length % 8 !== 0) {
      throw new DOMException("Invalid length", "OperationError");
    }
    const salt = copyBuffer(normalizedAlgorithm.salt);
    const info = copyBuffer(normalizedAlgorithm.info);
    return TypedArrayPrototypeGetBuffer(
      op_crypto_derive_bits_hkdf(
        normalizedAlgorithm.hash.name,
        baseKey[_keyData],
        salt,
        info,
        length / 8,
      ),
    );
  }

  function deriveBitsPBKDF2(normalizedAlgorithm, baseKey, length) {
    if (length === null || length % 8 !== 0) {
      throw new DOMException("Invalid length", "OperationError");
    }
    if (normalizedAlgorithm.iterations === 0) {
      throw new DOMException(
        "iterations must not be zero",
        "OperationError",
      );
    }
    const salt = copyBuffer(normalizedAlgorithm.salt);
    return TypedArrayPrototypeGetBuffer(
      op_crypto_derive_bits_pbkdf2(
        normalizedAlgorithm.hash.name,
        baseKey[_keyData],
        salt,
        normalizedAlgorithm.iterations,
        length / 8,
      ),
    );
  }

  async function wrapKeyInner(format, key, wrappingKey, normalizedAlgorithm) {
    const exportedKey = await this.exportKey(format, key);
    let bytes;
    if (format !== "jwk") {
      bytes = new Uint8Array(exportedKey);
    } else {
      const jwk = JSONStringify(exportedKey);
      bytes = new Uint8Array(jwk.length);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = StringPrototypeCharCodeAt(jwk, i);
      }
    }

    if (supportedAlgorithms["wrapKey"][normalizedAlgorithm.name] !== undefined) {
      switch (normalizedAlgorithm.name) {
        case "AES-KW": {
          return TypedArrayPrototypeGetBuffer(
            op_crypto_wrap_key_aes_kw(wrappingKey[_keyData], bytes),
          );
        }
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
    } else if (
      supportedAlgorithms["encrypt"][normalizedAlgorithm.name] !== undefined
    ) {
      const encryptKey = constructKey(
        wrappingKey[_type],
        wrappingKey[_extractable],
        ["encrypt"],
        wrappingKey[_algorithm],
        wrappingKey[_keyData],
      );
      return await this.encrypt(normalizedAlgorithm, encryptKey, bytes);
    } else {
      throw new DOMException(
        "Algorithm not supported",
        "NotSupportedError",
      );
    }
  }

  async function unwrapKeyInner(
    format,
    wrappedKey,
    unwrappingKey,
    normalizedAlgorithm,
    normalizedKeyAlgorithm,
    extractable,
    keyUsages,
  ) {
    let key;
    if (
      supportedAlgorithms["unwrapKey"][normalizedAlgorithm.name] !== undefined
    ) {
      switch (normalizedAlgorithm.name) {
        case "AES-KW": {
          key = TypedArrayPrototypeGetBuffer(
            op_crypto_unwrap_key_aes_kw(unwrappingKey[_keyData], wrappedKey),
          );
          break;
        }
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
    } else if (
      supportedAlgorithms["decrypt"][normalizedAlgorithm.name] !== undefined
    ) {
      const decryptKey = constructKey(
        unwrappingKey[_type],
        unwrappingKey[_extractable],
        ["decrypt"],
        unwrappingKey[_algorithm],
        unwrappingKey[_keyData],
      );
      key = await this.decrypt(normalizedAlgorithm, decryptKey, wrappedKey);
    } else {
      throw new DOMException(
        "Algorithm not supported",
        "NotSupportedError",
      );
    }

    let bytes;
    if (format !== "jwk") {
      bytes = key;
    } else {
      const k = new Uint8Array(key);
      let str = "";
      for (let i = 0; i < k.length; i++) {
        str += StringFromCharCode(k[i]);
      }
      bytes = JSONParse(str);
    }

    return await this.importKey(
      format,
      bytes,
      normalizedKeyAlgorithm,
      extractable,
      keyUsages,
    );
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
        case "RSA-OAEP":
          return encryptRSAOAEP(normalizedAlgorithm, key, data);
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
        case "RSA-OAEP":
          return decryptRSAOAEP(normalizedAlgorithm, key, data);
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
        case "RSASSA-PKCS1-v1_5":
        case "RSA-PSS":
          return signRSA(key, data, normalizedAlgorithm);
        case "ECDSA":
          return signECDSA(key, data, normalizedAlgorithm);
        case "Ed25519":
          return signEd25519(key, data);
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
        case "RSASSA-PKCS1-v1_5":
        case "RSA-PSS":
          return verifyRSA(key, signature, data, normalizedAlgorithm);
        case "ECDSA":
          return verifyECDSA(key, signature, data, normalizedAlgorithm);
        case "Ed25519":
          return verifyEd25519(key, signature, data);
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
      } else if (result.privateKey !== undefined && result.publicKey !== undefined) {
        if (usages.length === 0) {
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
        case "RSASSA-PKCS1-v1_5":
        case "RSA-PSS":
        case "RSA-OAEP":
          result = exportKeyRSA(format, key);
          break;
        case "ECDSA":
        case "ECDH":
          result = exportKeyEC(format, key);
          break;
        case "Ed25519":
          result = exportKeyEd25519(format, key);
          break;
        case "X25519":
          result = exportKeyX25519(format, key);
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

      switch (normalizedAlgorithm.name) {
        case "ECDH":
          return deriveBitsECDH(normalizedAlgorithm, baseKey, length);
        case "X25519":
          return deriveBitsX25519(normalizedAlgorithm, baseKey, length);
        case "HKDF":
          return deriveBitsHKDF(normalizedAlgorithm, baseKey, length);
        case "PBKDF2":
          return deriveBitsPBKDF2(normalizedAlgorithm, baseKey, length);
        default:
          throw new DOMException("Not implemented", "NotSupportedError");
      }
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

      const length = getKeyLength(normalizedDerivedKeyAlgorithmLength);
      const secret = await this.deriveBits(
        normalizedAlgorithm,
        baseKey,
        length,
      );

      const result = await this.importKey(
        "raw",
        secret,
        normalizedDerivedKeyAlgorithmImport,
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

      return await wrapKeyInner.call(
        this,
        format,
        key,
        wrappingKey,
        normalizedAlgorithm,
      );
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

      return await unwrapKeyInner.call(
        this,
        format,
        copyBuffer(wrappedKey),
        unwrappingKey,
        normalizedAlgorithm,
        normalizedKeyAlgorithm,
        extractable,
        keyUsages,
      );
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