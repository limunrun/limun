// Copyright 2026 the Limun authors. MIT license.

// `Blob` / `File` — File API
// (https://w3c.github.io/FileAPI/#blob-section,
//  https://w3c.github.io/FileAPI/#file-section).
//
// Migrated from Rust (`web::blob.rs`, 430 lines) to JS-on-ops. The
// previous Rust impl already kept the whole body in one `Vec<u8>` and
// resolved `text()`/`arrayBuffer()`/`stream()` synchronously, so there
// is no native work left that a JS class can't do: state is a pair of
// private symbols (`_bytes`/`_type`), and `stream()` builds a fixed
// `ReadableStream` via the cached `__bootstrap.createFixedReadableStream`
// factory from `06_streams.js`. `text()` decodes through the flat
// `op_encoding_decode_single` op (UTF-8, BOM-removed — matches the
// Encoding Standard `UTF-8 decode`); `arrayBuffer()` copies the bytes
// into a fresh `ArrayBuffer` (Blob is immutable, so a snapshot is
// returned, not a view into a potentially-shared backing buffer).
//
// Rust callers that need to mint a `Blob`/`File` without round-tripping
// bytes through a JS `BlobPart[]` (`Response.blob()`, `Request.blob()`,
// and the FormData multipart parser) call the cached
// `__bootstrap.createBlob`/`createFile` factories, which construct an
// instance with empty parts and then overwrite the `_bytes` symbol
// directly — same shape as Deno's `blob[_parts] = …; blob[_size] = …`.
// The Rust bridge (`web::blob.rs`, now reduced to a thin cache of those
// two globals) calls them after bootstrap.
//
// Ports Deno's `ext/web/09_file.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps` (only
//     `op_encoding_decode_single` is used)
//   - `core.encode`            → cached `TextEncoder` (`ext:limun/08_text_encoding.js`)
//   - `webidl.brand` /
//     `webidl.assertBranded`  → inline equivalents (same pattern as
//     `01_dom_exception.js`).
//   - `webidl.converters.*`    → inline converters (no full WebIDL module
//     yet — same approach as base64/DOMException/streams).
//   - `webidl.configureInterface` → dropped (only sets a
//     `[Symbol.toStringTag]`; set inline instead).
//   - `BlobReference` / `op_blob_*` / file-backed blob store /
//     `URL.createObjectURL` / structured-clone registration → dropped
//     (Limun has no blob store, no object URLs, no structured-clone
//     channel yet; bodies are buffered in JS `Uint8Array`s, same as the
//     previous Rust `Vec<u8>`).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no Deno-style
//     custom inspect in Limun yet).
//   - `Blob.bytes()` → dropped (not in the smoke suite; trivial to add
//     later — it's `arrayBuffer()` returning a `Uint8Array` instead of
//     an `ArrayBuffer`).
//   - `endings: "native"` line-ending transcoding → dropped (the previous
//     Rust impl already ignored it; "transparent" is the default and
//     the only behavior Limun supports, matching the prior Rust surface).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayBufferPrototypeSlice,
    DateNow,
    DataViewPrototypeGetBuffer,
    DataViewPrototypeGetByteOffset,
    DataViewPrototypeGetByteLength,
    MathFloor,
    MathMax,
    MathMin,
    NumberIsFinite,
    NumberIsNaN,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    SafeRegExp,
    StringPrototypeToLowerCase,
    Symbol,
    SymbolIterator,
    SymbolToStringTag,
    TypeError,
    TypedArrayPrototypeSet,
    TypedArrayPrototypeGetByteLength,
    TypedArrayPrototypeSubarray,
    Uint8Array,
  } = primordials;
  const {
    TypedArrayPrototypeGetBuffer,
    TypedArrayPrototypeGetByteOffset,
  } = primordials;
  const {
    TypedArrayPrototype,
    ArrayBufferPrototype,
    DataViewPrototype,
  } = primordials;
  const { ArrayPrototypePush, RegExpPrototypeTest } = primordials;

  const { op_encoding_decode_single } = globalThis.__limunOps;

  // Cached TextEncoder — used for `USVString` BlobParts. `TextEncoder` is
  // installed by `ext:limun/08_text_encoding.js`, which runs before this
  // module in the bootstrap order.
  const textEncoder = new TextEncoder();

  // --- Inline WebIDL (minimal, pilot-scoped) -----------------------------

  // Brand symbol — same shape as `01_dom_exception.js`. Set on every
  // instance in the constructor; checked by the getters/methods via
  // `assertBranded` so a plain `{}` with the prototype welded on (or an
  // object from another class) fails the brand check and throws
  // `TypeError: Illegal invocation`.
  const brand = Symbol("[[webidl.brand]]");

  function assertBranded(self, prototype) {
    if (
      !ObjectPrototypeIsPrototypeOf(prototype, self) || self[brand] !== brand
    ) {
      throw new TypeError("Illegal invocation");
    }
  }

  // `webidl.converters.USVString(V)` — ToString then UTF-8 encode (which
  // replaces unpaired surrogates with U+FFFD). Done implicitly by
  // `TextEncoder.prototype.encode`.
  function convertUSVString(V) {
    return textEncoder.encode(String(V));
  }

  // --- Type guards (primordial-based, tamper-resistant) ------------------

  function isArrayBuffer(V) {
    return ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, V);
  }
  function isTypedArray(V) {
    return ObjectPrototypeIsPrototypeOf(TypedArrayPrototype, V);
  }
  function isDataView(V) {
    return ObjectPrototypeIsPrototypeOf(DataViewPrototype, V);
  }

  // --- Private fields ----------------------------------------------------

  const _bytes = Symbol("bytes");
  const _type = Symbol("type");
  const _name = Symbol("name");
  const _lastModified = Symbol("lastModified");

  // --- Blob options / type normalization ---------------------------------

  // `[Clamp] long long` conversion (WebIDL §3.2.7): ToNumber, NaN→0,
  // then round to the nearest integer, choosing the **even** integer
  // when halfway. Range clamp to ±2^63 is a no-op for Blob sizes (any
  // realistic size is well within range), so only the rounding is
  // applied here. Matches the FileAPI `slice` parameter type
  // (`[Clamp] long long start/end`) — WPT `Blob-slice.any.js` "Test
  // double start/end values" verifies the round-half-to-even behavior
  // (0.5→0, 1.5→2, 2.5→2, 3.5→4).
  function clampLongLong(V) {
    let x = Number(V);
    if (NumberIsNaN(x)) return 0;
    if (x === 0 || !NumberIsFinite(x)) return x | 0;
    // Round half to even: add 0.5, floor, then if the original was
    // exactly halfway and the result is odd, subtract 1.
    const rounded = MathFloor(x + 0.5);
    if (x - MathFloor(x) === 0.5 && (rounded & 1) === 1) {
      return rounded - 1;
    }
    return rounded;
  }

  // Spec: `type` is normalized by lowercasing, and must be a sequence of
  // code points in the range U+0020..U+007E; otherwise it's set to "".
  const NORMALIZE_PATTERN = new SafeRegExp(/^[\x20-\x7E]*$/);
  function normalizeType(str) {
    const normalizedType = RegExpPrototypeTest(NORMALIZE_PATTERN, str)
      ? str
      : "";
    return StringPrototypeToLowerCase(normalizedType);
  }

  // --- BlobPart / sequence<BlobPart> converters --------------------------

  // `BlobPart = (ArrayBuffer or ArrayBufferView) or Blob or USVString`.
  // Returns a `Uint8Array` (a snapshot — Blob is immutable, so each
  // part is copied; a later mutation of the source must not leak in).
  function convertBlobPart(V) {
    if (typeof V === "object" && V !== null) {
      if (ObjectPrototypeIsPrototypeOf(BlobPrototype, V)) {
        // Blob bytes are already an immutable snapshot — reuse directly.
        return V[_bytes];
      }
      if (isArrayBuffer(V)) {
        // `new Uint8Array(arrayBuffer)` is a view; copy via `slice` first
        // so the Blob doesn't alias a buffer the caller might mutate.
        return new Uint8Array(ArrayBufferPrototypeSlice(V, 0));
      }
      if (isTypedArray(V)) {
        // Copy the view's *bytes* (not its elements — a `Uint16Array`
        // of length 1 has 2 bytes; `new Uint8Array(uint16Array)` would
        // truncate element-by-element into a 1-byte Uint8Array, which
        // is wrong for BlobPart). Construct from the underlying buffer
        // + byteOffset + byteLength so a subarray's bytes are copied
        // correctly. The view aliases the source buffer, so copy via
        // `TypedArrayPrototypeSet` into a fresh `Uint8Array` (Blob is
        // immutable; a later mutation of the source must not leak in).
        const view = new Uint8Array(
          TypedArrayPrototypeGetBuffer(V),
          TypedArrayPrototypeGetByteOffset(V),
          TypedArrayPrototypeGetByteLength(V),
        );
        return new Uint8Array(view);
      }
      if (isDataView(V)) {
        const view = new Uint8Array(
          DataViewPrototypeGetBuffer(V),
          DataViewPrototypeGetByteOffset(V),
          DataViewPrototypeGetByteLength(V),
        );
        return new Uint8Array(view);
      }
    }
    return convertUSVString(V);
  }

  // `sequence<BlobPart>`: undefined → empty (default value); null or a
  // non-object (string, number, boolean, bigint, symbol) → TypeError
  // (matches WPT `Blob-constructor.any.js` "blobParts not an object" —
  // primitives are rejected even if their prototype has `@@iterator`,
  // and `null` is rejected — only `undefined` is treated as the
  // default empty sequence). An object without a callable `@@iterator`
  // (Date/RegExp/`{}`) → `for...of` throws TypeError ("not iterable")
  // — no explicit pre-check, so `Symbol.iterator` is read exactly once
  // (WPT verifies the getter-call count in "Getters and value
  // conversions should happen in order until an exception is thrown").
  function convertBlobParts(blobParts) {
    if (blobParts === undefined) return [];
    if (typeof blobParts !== "object" || blobParts === null) {
      throw new TypeError(
        "Failed to construct 'Blob': blobParts is not an object",
      );
    }
    const chunks = [];
    for (const part of blobParts) {
      ArrayPrototypePush(chunks, convertBlobPart(part));
    }
    return chunks;
  }

  // Concatenate an array of `Uint8Array` chunks into one `Uint8Array`.
  function concatBytes(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; ++i) {
      total += TypedArrayPrototypeGetByteLength(chunks[i]);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; ++i) {
      const chunk = chunks[i];
      const len = TypedArrayPrototypeGetByteLength(chunk);
      if (len > 0) {
        TypedArrayPrototypeSet(out, chunk, offset);
        offset += len;
      }
    }
    return out;
  }

  // --- Blob class --------------------------------------------------------

  class Blob {
    [_type] = "";
    [_bytes];

    constructor(blobParts = [], options = undefined) {
      const prefix = "Failed to construct 'Blob'";
      // Argument validation order matters per WPT
      // (`Blob-constructor.any.js` "options properties should be
      // accessed in lexicographic order"): `endings` before `type`, and
      // a throwing `blobParts` getter must run before the `options`
      // getters ("Arguments should be evaluated from left to right").
      const chunks = convertBlobParts(blobParts);

      let type = "";
      if (options != null) {
        if (typeof options !== "object" && typeof options !== "function") {
          throw new TypeError(
            `${prefix}: options is not an object`,
          );
        }
        // `endings` is recognized but ignored (matches prior Rust
        // behavior — Limun has no line-ending transcoding). Still
        // convert it with `String()` so the spec's lexicographic
        // property-access order is observable (WPT verifies the
        // getter/toString call order) and so a throwing `endings`
        // getter/toString propagates per spec.
        void String(options.endings);
        const typeV = options.type;
        if (typeV !== undefined) {
          type = String(typeV);
        }
      }

      this[brand] = brand;
      this[_bytes] = concatBytes(chunks);
      this[_type] = normalizeType(type);
    }

    get size() {
      assertBranded(this, BlobPrototype);
      return TypedArrayPrototypeGetByteLength(this[_bytes]);
    }

    get type() {
      assertBranded(this, BlobPrototype);
      return this[_type];
    }

    // `slice(start?, end?, contentType?)` — spec: `start`/`end` are
    // `[Clamp] long long` (WebIDL round-half-to-even, then clamp to
    // ±2^63 — the range clamp is a no-op for Blob sizes, so only the
    // rounding matters here). Negative `start`/`end` are offsets from
    // the end; clamped to [0, size]; if start > end after clamping,
    // they're swapped. The new Blob's `type` is `contentType`
    // (normalized) or `""`.
    slice(start, end, contentType) {
      assertBranded(this, BlobPrototype);
      const size = TypedArrayPrototypeGetByteLength(this[_bytes]);

      let relativeStart;
      if (start === undefined) {
        relativeStart = 0;
      } else {
        start = clampLongLong(start);
        if (start < 0) {
          relativeStart = MathMax(size + start, 0);
        } else {
          relativeStart = MathMin(start, size);
        }
      }
      let relativeEnd;
      if (end === undefined) {
        relativeEnd = size;
      } else {
        end = clampLongLong(end);
        if (end < 0) {
          relativeEnd = MathMax(size + end, 0);
        } else {
          relativeEnd = MathMin(end, size);
        }
      }
      const span = MathMax(relativeEnd - relativeStart, 0);

      let relativeContentType;
      if (contentType === undefined) {
        relativeContentType = "";
      } else {
        relativeContentType = normalizeType(String(contentType));
      }

      const blob = new Blob([], { type: relativeContentType });
      blob[_bytes] = TypedArrayPrototypeSubarray(
        this[_bytes],
        relativeStart,
        relativeStart + span,
      );
      return blob;
    }

    // `text()` — decode `_bytes` as UTF-8. The Encoding Standard's
    // `UTF-8 decode` removes a leading BOM, matching `TextDecoder`'s
    // default; `op_encoding_decode_single(_, _, false, false)`
    // requests `fatal: false, ignore_bom: false` → BOM-removed, lossy
    // (invalid bytes replaced, not thrown).
    async text() {
      assertBranded(this, BlobPrototype);
      return op_encoding_decode_single(this[_bytes], "utf-8", false, false);
    }

    // `arrayBuffer()` — a fresh `ArrayBuffer` snapshot of `_bytes`.
    // `new Uint8Array(this[_bytes])` copies into a new backing buffer
    // (Blob is immutable, so a snapshot, not a view, is returned).
    async arrayBuffer() {
      assertBranded(this, BlobPrototype);
      const copy = new Uint8Array(this[_bytes]);
      return copy.buffer;
    }

    // `bytes()` — a fresh `Uint8Array` snapshot of `_bytes` (File API
    // rev 2024: `bytes()` is the byte-returning twin of
    // `arrayBuffer()`). Same copy as `arrayBuffer()` but returns the
    // view directly instead of its backing buffer.
    async bytes() {
      assertBranded(this, BlobPrototype);
      return new Uint8Array(this[_bytes]);
    }

    // `stream()` — a fixed (fully-buffered) `ReadableStream` yielding
    // the whole body as one `Uint8Array` chunk, then closed. Built by
    // the cached `__bootstrap.createFixedReadableStream` factory from
    // `06_streams.js` — the same path Rust callers
    // (`Response.body`/`Request.body`) take.
    stream() {
      assertBranded(this, BlobPrototype);
      return globalThis.__bootstrap.createFixedReadableStream([this[_bytes]]);
    }
  }

  ObjectDefineProperty(Blob.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "Blob",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const BlobPrototype = Blob.prototype;

  // --- File class --------------------------------------------------------

  class File extends Blob {
    [_name];
    [_lastModified];

    constructor(fileBits = [], fileName = "", options = undefined) {
      const prefix = "Failed to construct 'File'";
      if (arguments.length < 2) {
        throw new TypeError(
          `${prefix}: 2 arguments required, but fewer present`,
        );
      }
      super(fileBits, options);
      this[_name] = String(fileName);
      if (options == null || options.lastModified === undefined) {
        this[_lastModified] = DateNow();
      } else {
        this[_lastModified] = Number(options.lastModified);
      }
    }

    get name() {
      assertBranded(this, FilePrototype);
      return this[_name];
    }

    get lastModified() {
      assertBranded(this, FilePrototype);
      return this[_lastModified];
    }
  }

  ObjectDefineProperty(File.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "File",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const FilePrototype = File.prototype;

  // --- Rust bridge: createBlob / createFile ------------------------------

  // `createBlob(bytes, type)` — mint a `Blob` from a `Uint8Array` and a
  // type string without round-tripping the bytes through a JS
  // `BlobPart[]`. Used by the Rust bridge (`web::blob.rs`) for
  // `Response.blob()` / `Request.blob()`. The constructor is called
  // with empty parts (so no `BlobPart` conversion runs), then `_bytes`
  // is overwritten directly — same shape as Deno's
  // `blob[_parts] = …; blob[_size] = …`.
  function createBlob(bytes, type) {
    const blob = new Blob([], { type });
    blob[_bytes] = bytes;
    return blob;
  }

  // `createFile(bytes, type, name, lastModified)` — mint a `File` from
  // a `Uint8Array` and metadata. Used by the FormData multipart parser
  // (which builds `File` entries from part bodies) and by the Rust
  // bridge (`web::blob.rs`) for any future Rust caller that needs a
  // `File`.
  function createFile(bytes, type, name, lastModified) {
    const file = new File([], name, { type, lastModified });
    file[_bytes] = bytes;
    return file;
  }

  // --- Install as non-enumerable globals --------------------------------

  function installGlobal(name, ctor) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: ctor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("Blob", Blob);
  installGlobal("File", File);

  // Stash the factories on `__bootstrap` so the Rust bridge can call
  // them after caching the function globals.
  globalThis.__bootstrap.createBlob = createBlob;
  globalThis.__bootstrap.createFile = createFile;
})(globalThis);