// Copyright 2026 the Limun authors. MIT license.

// `TextEncoder`/`TextDecoder` — WHATWG Encoding Standard
// (https://encoding.spec.whatwg.org/).
//
// Third web API migrated from Rust to JS-on-ops (after base64 and
// DOMException). The spec surface (label fast-path, WebIDL argument
// validation, BOM/fatal/ignoreBOM option parsing, streaming state,
// error-type selection, brand checks) lives here in JS; the flat Rust ops
// (`op_encoding_normalize_label`, `op_encoding_decode_single`,
// `op_encoding_new_decoder`, `op_encoding_decode`,
// `op_encoding_decode_finish`, `op_encoding_encode_into`) in
// `src/core/ops.rs` do the encoding_rs work.
//
// Ports Deno's `ext/web/08_text_encoding.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `webidl.brand` /
//     `webidl.assertBranded` /
//     `webidl.converters.DOMString` → `globalThis.__bootstrap.webidl`
//     (shared `ext:limun/00_webidl.js`).
//   - `webidl.converters.TextDecoderOptions` /
//     `TextDecodeOptions`     → inline dictionary converters (module-
//     local; they delegate to `webidl.converters.boolean` for leaf
//     conversion but keep the spec's simple `{ fatal: false, … }` shape
//     inlined — avoids a dictionary-converter allocation per call).
//   - `webidl.configureInterface` → dropped (only sets a
//     `[Symbol.toStringTag]`; not needed for TextEncoder/TextDecoder per
//     spec — neither interface declares one).
//   - `core.encode`            → `op_encoding_encode_into` with a
//     throwaway large destination (kept simple; the common path is
//     `encode()` which allocates a fresh Uint8Array).
//   - Deno's UTF-8 fast-path ops (`op_encoding_decode_utf8`,
//     `op_encoding_decode_utf8_ascii_only`) → dropped (Limun's
//     `op_encoding_decode_single` is the single decode path; the ASCII
//     fast-path is an optimization that can be re-added later).
//   - `TextDecoderStream`/`TextEncoderStream` → dropped (Limun has no
//     `TransformStream`/`WritableStream` yet — see FINDINGS.md §B).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no Deno-style
//     custom inspect in Limun yet).
//   - `decode(bytes, encoding)` / `BOMSniff` module-internal helpers →
//     dropped (not exported by any current Limun caller; can be re-added
//     when fetch's text() needs them).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_encoding_normalize_label,
    op_encoding_decode_single,
    op_encoding_new_decoder,
    op_encoding_decode,
    op_encoding_decode_finish,
    op_encoding_encode_into,
  } = globalThis.__limunOps;
  const {
    MathTrunc,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    TypedArrayPrototypeGetSymbolToStringTag,
    Uint8Array,
  } = primordials;

  // --- Inline dictionary converters (module-specific composites) --------
  //
  // `TextDecoderOptions` / `TextDecodeOptions` are simple enough that they
  // stay module-local (they delegate to `webidl.converters.*` for the leaf
  // `boolean` conversion, but the spec's "default false, optional key"
  // shape is inlined here rather than built via the full
  // `webidl.createDictionaryConverter` machinery — matches the previous
  // inline impl and avoids a dictionary-converter allocation for the
  // common single-arg case).

  // `webidl.converters.TextDecoderOptions` — inline dictionary converter.
  // Spec: `{ fatal: boolean = false, ignoreBOM: boolean = false }`.
  // Coerces present values to boolean; absent keys default to false.
  function convertTextDecoderOptions(V) {
    const opts = { fatal: false, ignoreBOM: false };
    if (V === undefined || V === null) {
      return opts;
    }
    if (typeof V !== "object") {
      throw new TypeError(
        "Failed to construct 'TextDecoder': Argument 2 is not an object",
      );
    }
    if ("fatal" in V) opts.fatal = Boolean(V.fatal);
    if ("ignoreBOM" in V) opts.ignoreBOM = Boolean(V.ignoreBOM);
    return opts;
  }

  // `webidl.converters.TextDecodeOptions` — inline dictionary converter.
  // Spec: `{ stream: boolean = false }`.
  function convertTextDecodeOptions(V) {
    const opts = { stream: false };
    if (V === undefined || V === null) {
      return opts;
    }
    if (typeof V !== "object") {
      throw new TypeError(
        "Failed to execute 'decode' on 'TextDecoder': Argument 2 is not an object",
      );
    }
    if ("stream" in V) opts.stream = Boolean(V.stream);
    return opts;
  }

  // --- TextDecoder --------------------------------------------------------
  //
  // Private fields (Symbols, not #private — matches Deno's style and the
  // base64/DOMException pattern). `#handle` is the streaming-decoder id
  // returned by `op_encoding_new_decoder` (a Number), or `null` when no
  // streaming run is active.

  const _encoding = Symbol("encoding");
  const _fatal = Symbol("fatal");
  const _ignoreBOM = Symbol("ignoreBOM");
  const _handle = Symbol("handle");

  class TextDecoder {
    [_encoding];
    [_fatal];
    [_ignoreBOM];
    [_handle];

    // https://encoding.spec.whatwg.org/#dom-textdecoder
    constructor(label = "utf-8", options = undefined) {
      const prefix = "Failed to construct 'TextDecoder'";
      label = webidl.converters.DOMString(label);
      const opts = convertTextDecoderOptions(options);

      // Fast path for common UTF-8 labels — skip the Rust op call (matches
      // Deno). `for_label_no_replacement` would return the same result,
      // but avoiding the op boundary is cheaper and the label table is
      // tiny here.
      let encoding;
      if (
        label === "utf-8" || label === "utf8" ||
        label === "unicode-1-1-utf-8" || label === "unicode11utf8"
      ) {
        encoding = "utf-8";
      } else {
        try {
          encoding = op_encoding_normalize_label(label);
        } catch (e) {
          // The op throws a TypeError for unknown/replacement labels; the
          // spec requires a RangeError. Re-throw as RangeError.
          throw new RangeError(
            `TextDecoder: unsupported encoding label "${label}"`,
          );
        }
      }

      this[_encoding] = encoding;
      this[_fatal] = opts.fatal;
      this[_ignoreBOM] = opts.ignoreBOM;
      this[_handle] = null;
      this[webidl.brand] = webidl.brand;
    }

    get encoding() {
      webidl.assertBranded(this, TextDecoderPrototype, "TextDecoder");
      return this[_encoding];
    }

    get fatal() {
      webidl.assertBranded(this, TextDecoderPrototype, "TextDecoder");
      return this[_fatal];
    }

    get ignoreBOM() {
      webidl.assertBranded(this, TextDecoderPrototype, "TextDecoder");
      return this[_ignoreBOM];
    }

    // https://encoding.spec.whatwg.org/#dom-textdecoder-decode
    decode(input = new Uint8Array(), options = undefined) {
      webidl.assertBranded(this, TextDecoderPrototype, "TextDecoder");

      // Normalize `input` to a BufferSource. The spec allows
      // ArrayBufferView or ArrayBuffer. The fast path: a Uint8Array with
      // a non-shared backing buffer skips full validation (matches Deno).
      // Limun has no SharedArrayBuffer, so the SAB check is dropped —
      // every Uint8Array is a regular one.
      if (input !== undefined && input !== null) {
        if (TypedArrayPrototypeGetSymbolToStringTag(input) !== "Uint8Array") {
          // Accept ArrayBufferView (DataView, Int8Array, ...) and
          // ArrayBuffer by wrapping into a Uint8Array view. The op reads
          // bytes through `read_bytes` which handles both.
          if (typeof input !== "object") {
            throw new TypeError(
              "Failed to execute 'decode' on 'TextDecoder': Argument 1 is not a BufferSource",
            );
          }
        }
      } else {
        input = new Uint8Array();
      }

      const { stream } = convertTextDecodeOptions(options);

      // Empty input + streaming → no output, keep the decoder idle.
      if (stream && input.length === 0) {
        return "";
      }

      try {
        // Single-pass fast path: no active streaming run, one-shot decode.
        if (!stream && this[_handle] === null) {
          return op_encoding_decode_single(
            input,
            this[_encoding],
            this[_fatal],
            this[_ignoreBOM],
          );
        }

        // Streaming path: allocate a decoder handle on the first call of
        // a run, then feed each chunk through it.
        if (this[_handle] === null) {
          this[_handle] = op_encoding_new_decoder(
            this[_encoding],
            this[_fatal],
            this[_ignoreBOM],
          );
        }
        return op_encoding_decode(input, this[_handle], stream);
      } catch (e) {
        // A fatal decode error: per the Encoding Standard, a non-EOF
        // (stream=true) fatal error does NOT end the run for iso-2022-jp
        // (the only encoder with "sticky" state — its internal mode
        // persists across errors). For all other encodings the decoder
        // state is inert after a fatal error, so keeping the handle is
        // harmless. We therefore only drop the handle when `stream` is
        // false (finalizing); on a streaming fatal, keep it so the
        // decoder state survives. The `finally` block below handles the
        // `stream=false` case.
        if (!stream && this[_handle] !== null) {
          op_encoding_decode_finish(this[_handle]);
          this[_handle] = null;
        }
        throw e;
      } finally {
        // `{stream: false}` finalizes the run: drop the handle so the
        // next decode() starts fresh.
        if (!stream && this[_handle] !== null) {
          op_encoding_decode_finish(this[_handle]);
          this[_handle] = null;
        }
      }
    }
  }

  const TextDecoderPrototype = TextDecoder.prototype;

  // --- TextEncoder --------------------------------------------------------
  //
  // UTF-8 only per spec. `encode(input)` returns a Uint8Array of the UTF-8
  // bytes; `encodeInto(source, dest)` writes into `dest` and returns
  // `{read, written}`.

  class TextEncoder {
    constructor() {
      this[webidl.brand] = webidl.brand;
    }

    get encoding() {
      webidl.assertBranded(this, TextEncoderPrototype, "TextEncoder");
      return "utf-8";
    }

    // https://encoding.spec.whatwg.org/#dom-textencoder-encode
    //
    // Spec: `encode(input)` with `input` defaulting to `""` (USVString
    // with default value ""). An *omitted* argument OR an explicit
    // `undefined` both trigger the default — so `encode(undefined)` must
    // return the encoding of `""` (empty Uint8Array), NOT the encoding of
    // the literal string `"undefined"`. This is FINDINGS.md bug #2 — the
    // JS layer gets it right because the default parameter kicks in for
    // explicit `undefined` too (ES default-parameter semantics match the
    // WebIDL "default value" semantics here).
    encode(input = "") {
      webidl.assertBranded(this, TextEncoderPrototype, "TextEncoder");
      if (typeof input !== "string") {
        if (input === undefined) {
          input = "";
        } else if (typeof input === "symbol") {
          throw new TypeError("Cannot convert a Symbol value to a string");
        } else {
          input = String(input);
        }
      }
      // Encode by writing into a destination sized to the input's UTF-8
      // byte length. `String` in V8 stores UTF-16; the worst case for
      // UTF-8 of N UTF-16 code units is 3*N bytes (lone surrogates → 3
      // bytes each via WTF-8 replacement). Allocate 4*N to be safe and
      // let the op tell us how much was written, then slice.
      const dest = new Uint8Array(input.length * 4);
      const packed = op_encoding_encode_into(input, dest);
      const read = MathTrunc(packed / 4294967296);
      const written = packed - read * 4294967296;
      return dest.subarray(0, written);
    }

    // https://encoding.spec.whatwg.org/#dom-textencoder-encodeinto
    encodeInto(source, destination) {
      webidl.assertBranded(this, TextEncoderPrototype, "TextEncoder");
      // `source` is USVString — the op replaces lone surrogates with
      // U+FFFD (matching USVString semantics via V8's
      // `WriteFlags::kReplaceInvalidUtf8`). No DOMString conversion here
      // because the op takes a Rust `String` (V8 does the conversion).
      if (typeof source !== "string") {
        if (typeof source === "symbol") {
          throw new TypeError("Cannot convert a Symbol value to a string");
        }
        source = source === undefined ? "" : String(source);
      }
      if (TypedArrayPrototypeGetSymbolToStringTag(destination) !== "Uint8Array") {
        throw new TypeError(
          "Failed to execute 'encodeInto' on 'TextEncoder': Argument 2 is not a Uint8Array",
        );
      }
      const packed = op_encoding_encode_into(source, destination);
      const read = MathTrunc(packed / 4294967296);
      return {
        read,
        written: packed - read * 4294967296,
      };
    }
  }

  const TextEncoderPrototype = TextEncoder.prototype;

  // Install as non-enumerable globals — matches the previous Rust
  // `set_global` (DONT_ENUM) and every other constructible web class:
  // `Object.keys(globalThis)` excludes them (verified against Node/Deno/
  // browsers).
  ObjectDefineProperty(globalThis, "TextDecoder", {
    __proto__: null,
    value: TextDecoder,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  ObjectDefineProperty(globalThis, "TextEncoder", {
    __proto__: null,
    value: TextEncoder,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);