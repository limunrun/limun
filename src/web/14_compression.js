// Copyright 2018-2026 the Limun authors. MIT license.

// `CompressionStream` / `DecompressionStream` — WHATWG Compression Streams
// (https://wicg.github.io/compression/).
// Ports Deno's `ext/web/14_compression.js` to Limun's JS-on-ops model:
//   - `__bootstrap`   → `globalThis.__bootstrap`
//   - `core.ops`      → `globalThis.__limunOps`
//   - `TransformStream` → `globalThis.TransformStream` (installed by
//     `ext:limun/06_streams.js`)
//   - `webidl`        → `globalThis.__bootstrap.webidl`

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_compression_new,
    op_compression_write,
    op_compression_finish,
  } = globalThis.__limunOps;
  const {
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    TypedArrayPrototypeGetByteLength,
    SymbolToStringTag,
  } = primordials;

  const TransformStream = globalThis.TransformStream;

  webidl.converters.CompressionFormat = webidl.createEnumConverter(
    "CompressionFormat",
    [
      "deflate",
      "deflate-raw",
      "gzip",
    ],
  );

  class CompressionStream {
    #transform;

    constructor(format) {
      const prefix = "Failed to construct 'CompressionStream'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      format = webidl.converters.CompressionFormat(format, prefix, "Argument 1");

      const rid = op_compression_new(format, false);

      this.#transform = new TransformStream({
        transform: (chunk, controller) => {
          chunk = webidl.converters.BufferSource(chunk, prefix, "chunk");
          const output = op_compression_write(rid, chunk);
          maybeEnqueue(controller, output);
        },
        flush: (controller) => {
          const output = op_compression_finish(rid, true);
          maybeEnqueue(controller, output);
        },
        cancel: (_reason) => {
          op_compression_finish(rid, false);
        },
      });

      this[webidl.brand] = webidl.brand;
    }

    get readable() {
      webidl.assertBranded(this, CompressionStreamPrototype, "CompressionStream");
      return this.#transform.readable;
    }

    get writable() {
      webidl.assertBranded(this, CompressionStreamPrototype, "CompressionStream");
      return this.#transform.writable;
    }
  }

  ObjectDefineProperty(CompressionStream.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "CompressionStream",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const CompressionStreamPrototype = CompressionStream.prototype;

  class DecompressionStream {
    #transform;

    constructor(format) {
      const prefix = "Failed to construct 'DecompressionStream'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      format = webidl.converters.CompressionFormat(format, prefix, "Argument 1");

      const rid = op_compression_new(format, true);

      this.#transform = new TransformStream({
        transform: (chunk, controller) => {
          chunk = webidl.converters.BufferSource(chunk, prefix, "chunk");
          const output = op_compression_write(rid, chunk);
          maybeEnqueue(controller, output);
        },
        flush: (controller) => {
          const output = op_compression_finish(rid, true);
          maybeEnqueue(controller, output);
        },
        cancel: (_reason) => {
          op_compression_finish(rid, false);
        },
      });

      this[webidl.brand] = webidl.brand;
    }

    get readable() {
      webidl.assertBranded(this, DecompressionStreamPrototype, "DecompressionStream");
      return this.#transform.readable;
    }

    get writable() {
      webidl.assertBranded(this, DecompressionStreamPrototype, "DecompressionStream");
      return this.#transform.writable;
    }
  }

  function maybeEnqueue(controller, output) {
    if (output && TypedArrayPrototypeGetByteLength(output) > 0) {
      controller.enqueue(output);
    }
  }

  ObjectDefineProperty(DecompressionStream.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "DecompressionStream",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const DecompressionStreamPrototype = DecompressionStream.prototype;

  ObjectDefineProperty(globalThis, "CompressionStream", {
    __proto__: null,
    value: CompressionStream,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  ObjectDefineProperty(globalThis, "DecompressionStream", {
    __proto__: null,
    value: DecompressionStream,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);
