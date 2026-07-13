// Copyright 2026 the Limun authors. MIT license.

// Body mixin — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#body-mixin), shared by `Request` and
// `Response` (`ext:limun/21_request.js` / `ext:limun/22_response.js`).
//
// Simplified vs. spec (matches the previous Rust `web::fetch::{request,
// response}.rs`, ported here rather than reimplemented from scratch):
// bodies are fully buffered up front (no incremental streaming), so
// `.text()`/`.json()`/`.arrayBuffer()`/`.blob()`/`.formData()` all
// resolve as soon as they're called — no actual I/O wait. `.body` is a
// one-chunk `ReadableStream` built lazily via the cached
// `__bootstrap.createFixedReadableStream` factory (`06_streams.js`).
//
// A body's state is a plain internal record (not a class — there's no
// public surface of its own, only `Request`/`Response` reach into it via
// their own private symbol):
//
//   { hasBody: boolean, bytes: Uint8Array | null, stream: ReadableStream | null }
//
// `hasBody` is fixed at construction (a bodyless `Response`/`Request`
// never gains one). `bytes` is the buffered body until first consumed
// (by a body-consuming method, or by acquiring a reader on `.stream`),
// then `null` — this is exactly what `bodyUsed` reports. `stream` caches
// the lazily-built `ReadableStream` (identity stable across `.body`
// reads, per spec).
//
// Deviation from Deno's `22_body.js`: no lazy/streaming `InnerBody`,
// no `staticBodySource`/`staticBodyLength` fast-path recovery, no
// `ReadableStream`/async-iterable/`URLSearchParams` body sources (fetch
// bodies here are `string | BufferSource` only — see `coerceBodyInit`).
// This matches the current Rust surface exactly; true streaming is a
// perf optimization, not a spec-correctness one (see `TODO.md`).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayBufferPrototype,
    ArrayBufferPrototypeSlice,
    DataViewPrototype,
    DataViewPrototypeGetBuffer,
    DataViewPrototypeGetByteOffset,
    DataViewPrototypeGetByteLength,
    JSONParse,
    ObjectDefineProperties,
    ObjectPrototypeIsPrototypeOf,
    TypedArrayPrototype,
    TypedArrayPrototypeGetBuffer,
    TypedArrayPrototypeGetByteOffset,
    TypedArrayPrototypeGetByteLength,
    TypeError,
    Uint8Array,
  } = primordials;

  const { op_encoding_decode_single } = globalThis.__limunOps;

  const textEncoder = new TextEncoder();

  function decodeUtf8(bytes) {
    return op_encoding_decode_single(bytes, "utf-8", false, false);
  }

  // --- BodyInit coercion (string | BufferSource) --------------------------

  function isArrayBuffer(v) {
    return ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, v);
  }
  function isTypedArray(v) {
    return ObjectPrototypeIsPrototypeOf(TypedArrayPrototype, v);
  }
  function isDataView(v) {
    return ObjectPrototypeIsPrototypeOf(DataViewPrototype, v);
  }

  /** `BufferSource` (`ArrayBuffer` or a view) → a copied `Uint8Array`, or
   * `null` if `value` isn't one. */
  function bufferSourceToBytes(value) {
    if (typeof value !== "object" || value === null) return null;
    if (isArrayBuffer(value)) {
      return new Uint8Array(ArrayBufferPrototypeSlice(value, 0));
    }
    if (isTypedArray(value)) {
      const view = new Uint8Array(
        TypedArrayPrototypeGetBuffer(value),
        TypedArrayPrototypeGetByteOffset(value),
        TypedArrayPrototypeGetByteLength(value),
      );
      return new Uint8Array(view);
    }
    if (isDataView(value)) {
      const view = new Uint8Array(
        DataViewPrototypeGetBuffer(value),
        DataViewPrototypeGetByteOffset(value),
        DataViewPrototypeGetByteLength(value),
      );
      return new Uint8Array(view);
    }
    return null;
  }

  /** `init.body` / `Response`'s first argument coercion. Matches the
   * previous Rust `native::read_buffer_source` fallback: a
   * `BufferSource` is copied byte-for-byte; anything else is
   * `String()`-coerced then UTF-8 encoded (matches
   * `to_rust_string_lossy` + `.into_bytes()`). Real spec `BodyInit`
   * also accepts `Blob`/`FormData`/`ReadableStream`/`URLSearchParams` —
   * not supported here (matches the current Rust surface; `TODO.md`).
   */
  function coerceBodyInit(value) {
    if (typeof value === "string") {
      return textEncoder.encode(value);
    }
    const bytes = bufferSourceToBytes(value);
    if (bytes !== null) return bytes;
    return textEncoder.encode(String(value));
  }

  // --- Body state ----------------------------------------------------------

  /** `bytesOrNull`: the buffered body, or `null` for a bodyless
   * Request/Response. `hasBody` is derived once here and never changes. */
  function createBodyState(bytesOrNull) {
    return {
      hasBody: bytesOrNull !== null && bytesOrNull !== undefined,
      bytes: bytesOrNull ?? null,
      stream: null,
    };
  }

  /** The body is "disturbed" once its bytes were taken by a
   * body-consuming method, or once a reader was acquired on the
   * `.body` stream. A bodyless Request/Response is never disturbed. */
  function bodyDisturbed(state) {
    if (!state.hasBody) return false;
    if (state.bytes === null) return true;
    if (state.stream !== null && state.stream.locked) return true;
    return false;
  }

  /** Take the buffered bytes, or throw `TypeError` if already
   * disturbed. A bodyless Request/Response "consumes" as an empty
   * body and never becomes disturbed (matches `new Response().text()`
   * resolving with `""`). */
  function bodyTake(state) {
    if (!state.hasBody) return new Uint8Array(0);
    if (bodyDisturbed(state)) {
      throw new TypeError("body stream already read");
    }
    const bytes = state.bytes;
    state.bytes = null;
    return bytes;
  }

  /** `clone()` support: throws if disturbed (spec: "If this is
   * disturbed or locked, throw a TypeError"), otherwise a fresh state
   * with an independent copy of the bytes. */
  function cloneBodyState(state) {
    if (bodyDisturbed(state)) {
      throw new TypeError("clone: body stream already read");
    }
    return {
      hasBody: state.hasBody,
      bytes: state.hasBody ? new Uint8Array(state.bytes) : null,
      stream: null,
    };
  }

  /** `.body` getter support — lazily builds (and caches) a fixed
   * `ReadableStream` over the buffered bytes. `null` for a bodyless
   * Request/Response. Building it after the body was consumed yields
   * an already-closed (empty) stream, matching the previous Rust
   * behavior (it clones whatever's left, defaulting to empty). */
  function bodyGetStream(state) {
    if (!state.hasBody) return null;
    if (state.stream !== null) return state.stream;
    const bytes = state.bytes !== null ? state.bytes : new Uint8Array(0);
    const stream = globalThis.__bootstrap.createFixedReadableStream([bytes]);
    state.stream = stream;
    return stream;
  }

  // --- Body-consuming methods ----------------------------------------------

  async function bodyText(state) {
    const bytes = bodyTake(state);
    return decodeUtf8(bytes);
  }

  async function bodyJson(state) {
    const bytes = bodyTake(state);
    return JSONParse(decodeUtf8(bytes));
  }

  async function bodyArrayBuffer(state) {
    const bytes = bodyTake(state);
    return new Uint8Array(bytes).buffer;
  }

  async function bodyBlob(state, contentType) {
    const bytes = bodyTake(state);
    return new Blob([bytes], { type: contentType || "" });
  }

  /** The `boundary`/other `; key=value` parameter of a content-type
   * header value, unwrapping an optional quoted-string form
   * (`boundary="----abc"`). `null` if absent or empty. */
  function getContentTypeParam(contentType, key) {
    const parts = contentType.split(";");
    for (let i = 1; i < parts.length; ++i) {
      const part = parts[i].trim();
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      if (k.toLowerCase() !== key) continue;
      let v = part.slice(eq + 1).trim();
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
        v = v.slice(1, -1);
      }
      if (v === "") return null;
      return v;
    }
    return null;
  }

  function getMimeEssence(contentType) {
    return contentType.split(";")[0].trim().toLowerCase();
  }

  /** `formData()` — parses `application/x-www-form-urlencoded` or
   * `multipart/form-data` (the latter needs a `boundary` parameter).
   * Any other content-type rejects with a `TypeError`, per spec.
   * Boundary absence is checked *before* consuming the body (matches
   * the previous Rust order — a malformed request doesn't mark
   * `bodyUsed`). */
  async function bodyFormData(state, contentType) {
    const ct = contentType || "";
    const mime = getMimeEssence(ct);
    if (mime === "application/x-www-form-urlencoded") {
      const bytes = bodyTake(state);
      const fd = globalThis.__bootstrap.createFormData();
      globalThis.__bootstrap.formDataAppendUrlEncoded(fd, bytes);
      return fd;
    }
    if (mime === "multipart/form-data") {
      const boundary = getContentTypeParam(ct, "boundary");
      if (boundary === null) {
        throw new TypeError(
          "formData: multipart/form-data content-type has no boundary parameter",
        );
      }
      const bytes = bodyTake(state);
      const fd = globalThis.__bootstrap.createFormData();
      const err = globalThis.__bootstrap.formDataParseMultipart(
        fd,
        bytes,
        boundary,
      );
      if (err !== null) {
        throw new TypeError(`formData: ${err}`);
      }
      return fd;
    }
    throw new TypeError(
      "formData: content-type is neither application/x-www-form-urlencoded nor multipart/form-data",
    );
  }

  // --- Mixin installer -----------------------------------------------------

  /** Install the body mixin (`body`/`bodyUsed`/`text`/`json`/
   * `arrayBuffer`/`blob`/`formData`) onto `prototype`. `stateSymbol` is
   * the class's private symbol holding its body state record.
   * `getContentType(self)` returns the instance's `content-type` header
   * value (or `null`) for `blob()`/`formData()`. `assertBranded` is the
   * caller's own brand-check function (each class keeps its own brand
   * symbol — see `09_blob.js`). */
  function mixinBody(prototype, stateSymbol, getContentType, assertBranded) {
    ObjectDefineProperties(prototype, {
      body: {
        __proto__: null,
        get() {
          assertBranded(this, prototype);
          return bodyGetStream(this[stateSymbol]);
        },
        enumerable: true,
        configurable: true,
      },
      bodyUsed: {
        __proto__: null,
        get() {
          assertBranded(this, prototype);
          return bodyDisturbed(this[stateSymbol]);
        },
        enumerable: true,
        configurable: true,
      },
      arrayBuffer: {
        __proto__: null,
        value: function arrayBuffer() {
          assertBranded(this, prototype);
          return bodyArrayBuffer(this[stateSymbol]);
        },
        writable: true,
        enumerable: true,
        configurable: true,
      },
      blob: {
        __proto__: null,
        value: function blob() {
          assertBranded(this, prototype);
          return bodyBlob(this[stateSymbol], getContentType(this));
        },
        writable: true,
        enumerable: true,
        configurable: true,
      },
      formData: {
        __proto__: null,
        value: function formData() {
          assertBranded(this, prototype);
          return bodyFormData(this[stateSymbol], getContentType(this));
        },
        writable: true,
        enumerable: true,
        configurable: true,
      },
      json: {
        __proto__: null,
        value: function json() {
          assertBranded(this, prototype);
          return bodyJson(this[stateSymbol]);
        },
        writable: true,
        enumerable: true,
        configurable: true,
      },
      text: {
        __proto__: null,
        value: function text() {
          assertBranded(this, prototype);
          return bodyText(this[stateSymbol]);
        },
        writable: true,
        enumerable: true,
        configurable: true,
      },
    });
  }

  // --- Export (internal — consumed by 21_request.js / 22_response.js) ----

  globalThis.__bootstrap.body = {
    coerceBodyInit,
    createBodyState,
    cloneBodyState,
    bodyDisturbed,
    bodyTake,
    mixinBody,
  };
})(globalThis);
