// Copyright 2026 the Limun authors. MIT license.

// Body mixin — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#body-mixin), shared by `Request` and
// `Response` (`ext:limun/21_request.js` / `ext:limun/22_response.js`).
//
// Ports Deno's `ext/fetch/22_body.js`, simplified:
//   - `webidl`                  → `globalThis.__bootstrap.webidl`
//     (shared `ext:limun/00_webidl.js`). The body-mixin callback uses a
//     2-arg `assertBranded` adapter supplied by each consumer class.
//   - `InnerBody` (Deno's class wrapping a `ReadableStream` or a
//     `{ body, consumed }` static record) → a plain internal record
//     (plain object, not a class — there's no public surface):
//       { hasBody, source, bytes, stream, contentType }
//     `source` is `"buffered"` (string/BufferSource/Blob/FormData/
//     URLSearchParams, already serialized to bytes), `"stream"` (a
//     `ReadableStream` body init, kept as-is for true streaming), or
//     `null` (bodyless). `bytes` is the buffered body until first
//     consumed, then `null`. `stream` caches the lazily-built
//     `ReadableStream` (identity stable across `.body` reads, per spec).
//     `contentType` is the content-type implied by the body init
//     (e.g. `"text/plain;charset=UTF-8"` for a string), or `null` — the
//     consumer sets the `content-type` header if not already present.
//   - `staticBodySource`/`staticBodyLength` fast-path recovery (Deno's
//     `WeakMap` round-trip for `new Response(oldResponse.body,
//     oldResponse)` to avoid re-encoding) → dropped (Limun's bodies are
//     either buffered or truly streaming; the fast path has no
//     observable effect beyond perf).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped.
//   - `BodyInit` async-iterable converter (Node `Readable` interop) →
//     dropped (no Node interop in Limun).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayBufferPrototype,
    ArrayBufferPrototypeSlice,
    ArrayPrototypePush,
    DataViewPrototype,
    DataViewPrototypeGetBuffer,
    DataViewPrototypeGetByteOffset,
    DataViewPrototypeGetByteLength,
    JSONParse,
    MathRandom,
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

  // --- Type guards --------------------------------------------------------

  function isArrayBuffer(v) {
    return ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, v);
  }
  function isTypedArray(v) {
    return ObjectPrototypeIsPrototypeOf(TypedArrayPrototype, v);
  }
  function isDataView(v) {
    return ObjectPrototypeIsPrototypeOf(DataViewPrototype, v);
  }

  const BlobPrototype = globalThis.Blob.prototype;
  const FormDataPrototype = globalThis.FormData.prototype;
  const URLSearchParamsPrototype = globalThis.URLSearchParams.prototype;
  const ReadableStreamPrototype = globalThis.ReadableStream.prototype;

  // --- BufferSource → Uint8Array (copied) ---------------------------------

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

  // --- FormData → multipart/form-data bytes --------------------------------

  // RFC 7578 / RFC 2046 §5.1 multipart serialization of a `FormData`.
  // Matches Deno's `formDataToBlob` (ext/fetch/21_formdata.js), producing
  // the same wire format: `--boundary\r\nContent-Disposition: form-data;
  // name="..."\r\n\r\nvalue\r\n` for string entries, and
  // `Content-Type: ...\r\n\r\n` + file bytes for `File` entries. Returns
  // `{ bytes: Uint8Array, contentType: string }`.
  //
  // The `entryList` symbol is module-local to `10_form_data.js`; we
  // iterate via the public `entries()` iterator (a snapshot, per the
  // FormData spec) so we don't need to reach into private fields.
  function formDataToBytes(fd) {
    const boundary = String(
      MathRandom().toString(36).slice(2) + MathRandom().toString(36).slice(2),
    ).replace(/\./g, "").padStart(32, "-").slice(-32);

    const chunks = [];
    const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="`;
    const CRLF = "\r\n";

    for (const [name, value] of fd.entries()) {
      if (typeof value === "string") {
        ArrayPrototypePush(
          chunks,
          prefix + escapeFormField(name) + '"' + CRLF + CRLF +
            value.replace(/\r(?!\n)|(?<!\r)\n/g, CRLF) + CRLF,
        );
      } else {
        ArrayPrototypePush(
          chunks,
          prefix + escapeFormField(name) +
            `"; filename="${escapeFormField(value.name, true)}"` +
            CRLF +
            `Content-Type: ${value.type || "application/octet-stream"}\r\n\r\n`,
        );
        ArrayPrototypePush(chunks, value);
        ArrayPrototypePush(chunks, CRLF);
      }
    }
    ArrayPrototypePush(chunks, `--${boundary}--`);

    const parts = [];
    for (const chunk of chunks) {
      if (typeof chunk === "string") {
        ArrayPrototypePush(parts, textEncoder.encode(chunk));
      } else {
        // Blob/File → read bytes synchronously via the internal _bytes
        // symbol. The `File` extends `Blob`, so `Blob.prototype`'s
        // `_bytes` symbol is on the instance.
        ArrayPrototypePush(parts, new Uint8Array(chunk[_blobBytes]));
      }
    }
    const bytes = concatUint8Arrays(parts);
    return {
      bytes,
      contentType: "multipart/form-data; boundary=" + boundary,
    };
  }

  // The `_bytes` symbol on `Blob`/`File` instances (from `09_blob.js`).
  // Fetched lazily so we don't hardcode the symbol identity at parse time.
  const _blobBytes = (() => {
    const blob = new Blob([]);
    const symbols = Object.getOwnPropertySymbols(blob);
    for (const sym of symbols) {
      if (String(sym) === "Symbol(bytes)") return sym;
    }
    return null;
  })();

  // Escape a form field name/filename per RFC 7578. Replaces `\r\n`
  // (for names) or lone `\r`/`\n` with the CRLF-escaped form, and
  // percent-encodes `"`, `\r`, `\n` per Deno's `escape()` helper.
  function escapeFormField(str, isFilename) {
    if (!isFilename) {
      str = str.replace(/\r\n|\r|\n/g, "\r\n");
    }
    return str.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  }

  // --- Concat helper ------------------------------------------------------

  function concatUint8Arrays(arrays) {
    let total = 0;
    for (let i = 0; i < arrays.length; ++i) {
      total += arrays[i].length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < arrays.length; ++i) {
      const arr = arrays[i];
      if (arr.length > 0) {
        out.set(arr, offset);
        offset += arr.length;
      }
    }
    return out;
  }

  // --- BodyInit coercion --------------------------------------------------

  /** `init.body` / `Response`'s first argument coercion. Returns
   * `{ bytes: Uint8Array | null, contentType: string | null, stream:
   * ReadableStream | null }`. `stream` is non-null only for a
   * `ReadableStream` body (streaming, not buffered). `bytes` is the
   * buffered body for all other types (string, BufferSource, Blob,
   * FormData, URLSearchParams). `contentType` is the content-type
   * implied by the body init, or `null` if none. Returns
   * `{ bytes: null, contentType: null, stream: null }` for
   * `null`/`undefined`. */
  function coerceBodyInit(value) {
    if (value === null || value === undefined) {
      return { bytes: null, contentType: null, stream: null };
    }
    if (typeof value === "string") {
      return {
        bytes: textEncoder.encode(value),
        contentType: "text/plain;charset=UTF-8",
        stream: null,
      };
    }
    // Blob / File
    if (ObjectPrototypeIsPrototypeOf(BlobPrototype, value)) {
      const blobBytes = new Uint8Array(value[_blobBytes]);
      const ct = value.type.length !== 0 ? value.type : null;
      return { bytes: blobBytes, contentType: ct, stream: null };
    }
    // FormData
    if (ObjectPrototypeIsPrototypeOf(FormDataPrototype, value)) {
      const { bytes, contentType } = formDataToBytes(value);
      return { bytes, contentType, stream: null };
    }
    // URLSearchParams
    if (ObjectPrototypeIsPrototypeOf(URLSearchParamsPrototype, value)) {
      return {
        bytes: textEncoder.encode(value.toString()),
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        stream: null,
      };
    }
    // ReadableStream
    if (ObjectPrototypeIsPrototypeOf(ReadableStreamPrototype, value)) {
      if (value.locked) {
        throw new TypeError("ReadableStream is locked");
      }
      return { bytes: null, contentType: null, stream: value };
    }
    // BufferSource (ArrayBuffer / TypedArray / DataView)
    const bsBytes = bufferSourceToBytes(value);
    if (bsBytes !== null) {
      return { bytes: bsBytes, contentType: null, stream: null };
    }
    // Fallback: String() + UTF-8 encode (matches previous behavior)
    return {
      bytes: textEncoder.encode(String(value)),
      contentType: "text/plain;charset=UTF-8",
      stream: null,
    };
  }

  // --- Body state ----------------------------------------------------------

  /** Create a body state from a coercion result (or `null` for bodyless).
   * Also accepts a bare `Uint8Array` (or `null`) for callers that
   * already have buffered bytes (e.g. `Response.json()` and `fetch()`'s
   * flat op result). `hasBody` is fixed at construction. `source` tracks
   * the type: `"buffered"` (bytes in `state.bytes`), `"stream"` (a
   * ReadableStream in `state.stream`), or `null` (bodyless). `consumed`
   * is set when a streaming body is drained, so `bodyDisturbed` can
   * report correctly even after the reader is released. */
  function createBodyState(coerced) {
    if (coerced === null || coerced === undefined) {
      return { hasBody: false, source: null, bytes: null, stream: null, consumed: false };
    }
    if (coerced instanceof Uint8Array) {
      return {
        hasBody: true,
        source: "buffered",
        bytes: coerced,
        stream: null,
        consumed: false,
      };
    }
    if (coerced.stream !== null && coerced.stream !== undefined) {
      return {
        hasBody: true,
        source: "stream",
        bytes: null,
        stream: coerced.stream,
        consumed: false,
      };
    }
    return {
      hasBody: true,
      source: "buffered",
      bytes: coerced.bytes ?? null,
      stream: null,
      consumed: false,
    };
  }

  /** The body is "disturbed" once its bytes were taken by a
   * body-consuming method, or once a reader was acquired on the
   * `.body` stream. A bodyless Request/Response is never disturbed. */
  function bodyDisturbed(state) {
    if (!state.hasBody) return false;
    if (state.consumed) return true;
    if (state.source === "stream") {
      return state.stream.locked;
    }
    if (state.bytes === null) return true;
    if (state.stream !== null && state.stream.locked) return true;
    return false;
  }

  /** Drain a ReadableStream into a concatenated `Uint8Array`. */
  async function drainStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value instanceof Uint8Array) {
        ArrayPrototypePush(chunks, value);
      } else if (typeof value === "string") {
        ArrayPrototypePush(chunks, textEncoder.encode(value));
      } else if (value && typeof value === "object" && "byteLength" in value) {
        ArrayPrototypePush(chunks, new Uint8Array(value));
      }
    }
    return concatUint8Arrays(chunks);
  }

  /** Take the body bytes, or throw `TypeError` if already disturbed.
   * For streaming bodies, async-drain the ReadableStream. A bodyless
   * Request/Response "consumes" as an empty body. */
  async function bodyTake(state) {
    if (!state.hasBody) return new Uint8Array(0);
    if (bodyDisturbed(state)) {
      throw new TypeError("body stream already read");
    }
    if (state.source === "stream") {
      state.consumed = true;
      return drainStream(state.stream);
    }
    const bytes = state.bytes;
    state.bytes = null;
    return bytes;
  }

  /** `clone()` support: throws if disturbed (spec: "If this is
   * disturbed or locked, throw a TypeError"). For buffered → copy
   * bytes. For streaming → `tee()` the ReadableStream, return a new
   * state for one branch and replace `state.stream` with the other. */
  function cloneBodyState(state) {
    if (bodyDisturbed(state)) {
      throw new TypeError("clone: body stream already read");
    }
    if (state.source === "stream") {
      const [branch1, branch2] = state.stream.tee();
      state.stream = branch1;
      return { hasBody: true, source: "stream", bytes: null, stream: branch2, consumed: false };
    }
    return {
      hasBody: state.hasBody,
      source: state.hasBody ? "buffered" : null,
      bytes: state.hasBody ? new Uint8Array(state.bytes) : null,
      stream: null,
      consumed: false,
    };
  }

  /** `.body` getter support. For buffered → lazily builds (and caches)
   * a fixed `ReadableStream` over the bytes. For streaming → returns
   * the stream directly. `null` for a bodyless Request/Response. */
  function bodyGetStream(state) {
    if (!state.hasBody) return null;
    if (state.source === "stream") return state.stream;
    if (state.stream !== null) return state.stream;
    const bytes = state.bytes !== null ? state.bytes : new Uint8Array(0);
    const stream = globalThis.__bootstrap.createFixedReadableStream([bytes]);
    state.stream = stream;
    return stream;
  }

  // --- Body-consuming methods ---------------------------------------------

  async function bodyText(state) {
    const bytes = await bodyTake(state);
    return decodeUtf8(bytes);
  }

  async function bodyJson(state) {
    const bytes = await bodyTake(state);
    return JSONParse(decodeUtf8(bytes));
  }

  async function bodyArrayBuffer(state) {
    const bytes = await bodyTake(state);
    return new Uint8Array(bytes).buffer;
  }

  async function bodyBlob(state, contentType) {
    const bytes = await bodyTake(state);
    return globalThis.__bootstrap.createBlob(bytes, contentType || "");
  }

  /** `textStream()` — returns a `ReadableStream<string>` over the
   * body's decoded UTF-8 text, and marks the body as consumed. Per the
   * Fetch Standard text-stream steps, `bodyUsed` becomes true as soon as
   * the method is called. For a null body, returns an empty stream and
   * does NOT mark `bodyUsed`. For a streaming body, creates a new stream
   * that pulls from the source stream and decodes chunks as UTF-8. */
  function bodyTextStream(state) {
    if (!state.hasBody) {
      return new ReadableStream({ start(controller) { controller.close(); } });
    }
    if (bodyDisturbed(state)) {
      throw new TypeError("body stream already read");
    }
    if (state.source === "stream") {
      state.consumed = true;
      return createTextStreamFromByteStream(state.stream);
    }
    const bytes = state.bytes;
    state.bytes = null;
    const text = bytes.length > 0 ? decodeUtf8(bytes) : "";
    return new ReadableStream({
      start(controller) {
        if (text.length > 0) {
          controller.enqueue(text);
        }
        controller.close();
      },
    });
  }

  /** Create a `ReadableStream<string>` that drains a byte stream and
   * decodes each chunk as UTF-8 with `TextDecoder` in streaming mode. */
  function createTextStreamFromByteStream(byteStream) {
    const reader = byteStream.getReader();
    const decoder = new TextDecoder();
    return new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode(new Uint8Array(0));
          if (tail.length > 0) controller.enqueue(tail);
          controller.close();
          return;
        }
        const chunk = decoder.decode(
          value instanceof Uint8Array ? value : new Uint8Array(value),
          { stream: true },
        );
        if (chunk.length > 0) controller.enqueue(chunk);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
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
      const bytes = await bodyTake(state);
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
      const bytes = await bodyTake(state);
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

  /** Install the body mixin (`body`/`bodyUsed`/`text`/`textStream`/`json`/
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
      textStream: {
        __proto__: null,
        value: function textStream() {
          assertBranded(this, prototype);
          return bodyTextStream(this[stateSymbol]);
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
    drainStream,
    mixinBody,
  };
})(globalThis);