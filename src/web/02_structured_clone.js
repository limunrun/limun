// Copyright 2026 the Limun authors. MIT license.

// `structuredClone` global — WHATWG HTML "StructuredSerializeForTransfer"
// (no transferables) exposed as the `structuredClone(value)` global.
// Backed by the Rust op `op_structured_clone` (V8 `ValueSerializer` →
// `ValueDeserializer` round-trip), with JS-side fast paths for
// `ArrayBuffer` / typed-array / `DataView` (slice-clone — avoids the
// serialize overhead for the common buffer-only case).
//
// Ports Deno's `ext/web/02_structured_clone.js` (148 lines). Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.isArrayBuffer`     → in-module `isArrayBuffer` (primordials
//                                 `ObjectPrototypeIsPrototypeOf` check —
//                                 same shape as `06_streams.js`'s helper)
//   - `core.structuredClone`   → `globalThis.__limunOps.op_structured_clone`
//   - `core.loadExtScript(...) → direct `globalThis.DOMException` (already
//                                 installed by `01_dom_exception.js`)
//   - `primordials`            → `globalThis.__bootstrap.primordials`
//
// The JS wrapper catches a TypeError from `op_structured_clone` (V8's
// DataCloneError shape) and rethrows as `new DOMException(msg,
// "DataCloneError")` — matches the spec's "DataCloneError" DOMException
// requirement (V8's `ValueSerializer` throws a bare TypeError via
// `throw_data_clone_error`; the JS layer wraps it).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const { op_structured_clone, op_serialize, op_deserialize } =
    globalThis.__limunOps;
  const {
    ArrayBuffer,
    ArrayBufferPrototypeGetByteLength,
    ArrayBufferPrototypeSlice,
    ArrayBufferIsView,
    ArrayPrototypePush,
    DataView,
    DataViewPrototypeGetBuffer,
    DataViewPrototypeGetByteLength,
    DataViewPrototypeGetByteOffset,
    ObjectPrototypeIsPrototypeOf,
    SafeWeakMap,
    TypedArrayPrototypeGetBuffer,
    TypedArrayPrototypeGetByteOffset,
    TypedArrayPrototypeGetLength,
    TypedArrayPrototypeGetSymbolToStringTag,
    TypeErrorPrototype,
    WeakMapPrototypeSet,
    Int8Array,
    Int16Array,
    Int32Array,
    BigInt64Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    BigUint64Array,
    Float32Array,
    Float64Array,
  } = primordials;

  function isArrayBuffer(value) {
    return value !== null && typeof value === "object" &&
      ObjectPrototypeIsPrototypeOf(ArrayBuffer.prototype, value);
  }

  const objectCloneMemo = new SafeWeakMap();

  function cloneArrayBuffer(
    srcBuffer,
    srcByteOffset,
    srcLength,
    _cloneConstructor,
  ) {
    return ArrayBufferPrototypeSlice(
      srcBuffer,
      srcByteOffset,
      srcByteOffset + srcLength,
    );
  }

  // `structuredClone(value, options?)` — the WHATWG/HTML `structuredClone`
  // global. Supports an optional `{ transfer: [...] }` second arg for
  // transferring ArrayBuffers (detaches the originals, the clone gets
  // fresh buffers with the same contents). When `transfer` is empty or
  // absent, the fast path uses `op_structured_clone` (serialize→deserialize
  // round-trip) with JS-side buffer fast paths (slice-clone — avoids the
  // serialize overhead for the common buffer-only case).
  //
  // On serialize error (V8's `ValueSerializer` throws a TypeError via
  // `throw_data_clone_error`), wraps to `DOMException("DataCloneError")`.
  function structuredClone(value, options) {
    // Fast path for primitives that StructuredSerialize returns by
    // reference: null, undefined, boolean, number, string, bigint.
    // Symbols fall through to the slow path which throws DataCloneError.
    if (arguments.length >= 1 && options === undefined) {
      if (value === null) return value;
      const t = typeof value;
      if (t !== "object" && t !== "function" && t !== "symbol") {
        return value;
      }
    }

    // Transfer path: if `options.transfer` is non-empty, use
    // `op_serialize`/`op_deserialize` with the transferred ArrayBuffers.
    if (options !== undefined && options !== null) {
      const transfer = options.transfer;
      if (transfer && transfer.length > 0) {
        return structuredCloneWithTransfer(value, transfer);
      }
    }

    // No-transferables fast path.
    if (isArrayBuffer(value)) {
      const cloned = cloneArrayBuffer(
        value,
        0,
        ArrayBufferPrototypeGetByteLength(value),
        ArrayBuffer,
      );
      WeakMapPrototypeSet(objectCloneMemo, value, cloned);
      return cloned;
    }

    if (ArrayBufferIsView(value)) {
      const tag = TypedArrayPrototypeGetSymbolToStringTag(value);
      // DataView
      if (tag === undefined) {
        return new DataView(
          structuredClone(DataViewPrototypeGetBuffer(value)),
          DataViewPrototypeGetByteOffset(value),
          DataViewPrototypeGetByteLength(value),
        );
      }
      // TypedArray
      let Constructor;
      switch (tag) {
        case "Int8Array":
          Constructor = Int8Array;
          break;
        case "Int16Array":
          Constructor = Int16Array;
          break;
        case "Int32Array":
          Constructor = Int32Array;
          break;
        case "BigInt64Array":
          Constructor = BigInt64Array;
          break;
        case "Uint8Array":
          Constructor = Uint8Array;
          break;
        case "Uint8ClampedArray":
          Constructor = Uint8ClampedArray;
          break;
        case "Uint16Array":
          Constructor = Uint16Array;
          break;
        case "Uint32Array":
          Constructor = Uint32Array;
          break;
        case "BigUint64Array":
          Constructor = BigUint64Array;
          break;
        case "Float32Array":
          Constructor = Float32Array;
          break;
        case "Float64Array":
          Constructor = Float64Array;
          break;
        default:
          // Unknown typed-array tag — fall through to the serializer.
          break;
      }
      if (Constructor) {
        return new Constructor(
          structuredClone(TypedArrayPrototypeGetBuffer(value)),
          TypedArrayPrototypeGetByteOffset(value),
          TypedArrayPrototypeGetLength(value),
        );
      }
    }

    try {
      return op_structured_clone(value);
    } catch (e) {
      if (ObjectPrototypeIsPrototypeOf(TypeErrorPrototype, e)) {
        throw new DOMException(e.message, "DataCloneError");
      }
      throw e;
    }
  }

  // `structuredCloneWithTransfer(value, transfer)` — the transfer path.
  // Collects the ArrayBuffers in `transfer`, calls `op_serialize` (which
  // detaches the originals and stashes their backing stores), then
  // `op_deserialize` (which mints fresh ArrayBuffers from the stashed
  // backing stores). The fresh buffers replace the originals in the
  // cloned value. Matches the spec: transferred ArrayBuffers are
  // detached in the original and appear as fresh buffers in the clone.
  function structuredCloneWithTransfer(value, transfer) {
    const transferredArrayBuffers = [];
    for (let i = 0; i < transfer.length; i++) {
      const t = transfer[i];
      if (isArrayBuffer(t)) {
        ArrayPrototypePush(transferredArrayBuffers, t);
      }
    }
    const serializeErrorCb = (err) => {
      throw new DOMException(`${err}`, "DataCloneError");
    };
    let serialized;
    try {
      serialized = op_serialize(
        value,
        [],
        transferredArrayBuffers,
        serializeErrorCb,
      );
    } catch (e) {
      if (ObjectPrototypeIsPrototypeOf(TypeErrorPrototype, e)) {
        throw new DOMException(e.message, "DataCloneError");
      }
      throw e;
    }
    // `op_deserialize` mints fresh ArrayBuffers from the stashed backing
    // stores and writes them back into `transferredArrayBuffers` slots.
    return op_deserialize(serialized, undefined, transferredArrayBuffers);
  }

  // Expose on `__bootstrap` so `13_message_port.js` and `06_streams.js`
  // can reach the fast-path version (which avoids the op round-trip for
  // buffers — important for streams `tee`).
  globalThis.__bootstrap.structuredClone = structuredClone;

  // Install as a non-enumerable global (matches `DOMException` /
  // `EventTarget` — Web IDL §3.7.5; browsers expose `structuredClone`
  // as a non-enumerable own property of the global).
  Object.defineProperty(globalThis, "structuredClone", {
    __proto__: null,
    value: structuredClone,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);