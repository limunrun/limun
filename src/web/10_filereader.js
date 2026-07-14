// Copyright 2018-2026 the Limun authors. MIT license.

// `FileReader` — File API reading
// (https://w3c.github.io/FileAPI/#reading-a-blob).
// Ports Deno's `ext/web/10_filereader.js` to Limun's JS-on-ops model:
//   - `__bootstrap`       → `globalThis.__bootstrap`
//   - `core.ops`          → `globalThis.__limunOps` (only if needed; none are)
//   - `webidl`            → `globalThis.__bootstrap.webidl`
//   - `ProgressEvent`/`EventTarget`/`TextDecoder`/`setTimeout`/`Blob`/`File`
//     are already installed as globals by earlier bootstrap modules.
//   - `parseMimeType`     → `globalThis.__bootstrap.mimeType.parseMimeType`
//   - `forgivingBase64Encode` → `globalThis.__bootstrap.infra.forgivingBase64Encode`

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    ArrayPrototypePush,
    ArrayPrototypeReduce,
    FunctionPrototypeCall,
    MapPrototypeGet,
    MapPrototypeSet,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    SafeMap,
    Symbol,
    SymbolToStringTag,
    TypeError,
    TypedArrayPrototypeSet,
    TypedArrayPrototypeGetBuffer,
    TypedArrayPrototypeGetByteLength,
    TypedArrayPrototypeGetSymbolToStringTag,
    Uint8Array,
  } = primordials;

  const parseMimeType = globalThis.__bootstrap.mimeType.parseMimeType;
  const { forgivingBase64Encode } = globalThis.__bootstrap.infra;

  const state = Symbol("[[state]]");
  const result = Symbol("[[result]]");
  const error = Symbol("[[error]]");
  const aborted = Symbol("[[aborted]]");
  const handlerSymbol = Symbol("eventHandlers");

  class FileReader extends EventTarget {
    [state] = "empty";
    [result] = null;
    [error] = null;
    [aborted] = null;

    #readOperation(blob, readtype) {
      if (this[state] === "loading") {
        throw new DOMException(
          "Invalid FileReader state",
          "InvalidStateError",
        );
      }
      this[state] = "loading";
      this[result] = null;
      this[error] = null;

      const abortedState = this[aborted] = { aborted: false };

      const stream = blob.stream();
      const reader = stream.getReader();
      const chunks = [];
      let chunkPromise = reader.read();
      let isFirstChunk = true;

      (async () => {
        while (!abortedState.aborted) {
          try {
            const chunk = await chunkPromise;
            if (abortedState.aborted) return;

            if (isFirstChunk) {
              setTimeout(() => {
                if (abortedState.aborted) return;
                const ev = new ProgressEvent("loadstart", {});
                this.dispatchEvent(ev);
              });
            }
            isFirstChunk = false;

            if (
              !chunk.done &&
              TypedArrayPrototypeGetSymbolToStringTag(chunk.value) ===
                "Uint8Array"
            ) {
              ArrayPrototypePush(chunks, chunk.value);

              const size = ArrayPrototypeReduce(
                chunks,
                (p, i) => p + TypedArrayPrototypeGetByteLength(i),
                0,
              );
              const ev = new ProgressEvent("progress", {
                loaded: size,
              });
              setTimeout(() => {
                if (abortedState.aborted) return;
                this.dispatchEvent(ev);
              });

              chunkPromise = reader.read();
            } else if (chunk.done === true) {
              setTimeout(() => {
                if (abortedState.aborted) return;

                this[state] = "done";
                const size = ArrayPrototypeReduce(
                  chunks,
                  (p, i) => p + TypedArrayPrototypeGetByteLength(i),
                  0,
                );
                const bytes = new Uint8Array(size);
                let offs = 0;
                for (let i = 0; i < chunks.length; ++i) {
                  const chunk = chunks[i];
                  TypedArrayPrototypeSet(bytes, chunk, offs);
                  offs += TypedArrayPrototypeGetByteLength(chunk);
                }

                switch (readtype.kind) {
                  case "ArrayBuffer": {
                    this[result] = TypedArrayPrototypeGetBuffer(bytes);
                    break;
                  }
                  case "BinaryString": {
                    let s = "";
                    for (let i = 0; i < bytes.length; ++i) {
                      s += String.fromCharCode(bytes[i]);
                    }
                    this[result] = s;
                    break;
                  }
                  case "Text": {
                    let encoding = readtype.encoding;
                    if (encoding === undefined) {
                      const mimeType = parseMimeType(blob.type);
                      if (mimeType) {
                        const charset = MapPrototypeGet(
                          mimeType.parameters,
                          "charset",
                        );
                        if (charset) {
                          encoding = charset;
                        }
                      }
                    }
                    let decoder = undefined;
                    if (encoding === undefined) {
                      if (
                        bytes.length >= 3 && bytes[0] === 0xEF &&
                        bytes[1] === 0xBB && bytes[2] === 0xBF
                      ) {
                        encoding = "utf-8";
                      } else if (
                        bytes.length >= 2 && bytes[0] === 0xFF &&
                        bytes[1] === 0xFE
                      ) {
                        encoding = "utf-16le";
                      } else if (
                        bytes.length >= 2 && bytes[0] === 0xFE &&
                        bytes[1] === 0xFF
                      ) {
                        encoding = "utf-16be";
                      }
                    }
                    if (encoding !== undefined) {
                      try {
                        decoder = new TextDecoder(encoding);
                      } catch {
                        // ignore
                      }
                    }
                    if (decoder === undefined) {
                      decoder = new TextDecoder();
                    }
                    this[result] = decoder.decode(bytes);
                    break;
                  }
                  case "DataUrl": {
                    const mediaType = blob.type || "application/octet-stream";
                    this[result] = `data:${mediaType};base64,${
                      forgivingBase64Encode(bytes)
                    }`;
                    break;
                  }
                }

                {
                  const ev = new ProgressEvent("load", {
                    lengthComputable: true,
                    loaded: size,
                    total: size,
                  });
                  this.dispatchEvent(ev);
                }

                setTimeout(() => {
                  if (abortedState.aborted) return;
                  if (this[state] !== "loading") {
                    const ev = new ProgressEvent("loadend", {
                      lengthComputable: true,
                      loaded: size,
                      total: size,
                    });
                    this.dispatchEvent(ev);
                  }
                });
              });
              break;
            }
          } catch (err) {
            setTimeout(() => {
              if (abortedState.aborted) return;

              this[state] = "done";
              this[error] = err;

              {
                const ev = new ProgressEvent("error", {});
                this.dispatchEvent(ev);
              }

              setTimeout(() => {
                if (abortedState.aborted) return;
                if (this[state] !== "loading") {
                  const ev = new ProgressEvent("loadend", {});
                  this.dispatchEvent(ev);
                }
              });
            });
            break;
          }
        }
      })();
    }

    #getEventHandlerFor(name) {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      const maybeMap = this[handlerSymbol];
      if (!maybeMap) return null;
      return MapPrototypeGet(maybeMap, name)?.handler ?? null;
    }

    #setEventHandlerFor(name, value) {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      if (!this[handlerSymbol]) {
        this[handlerSymbol] = new SafeMap();
      }
      let handlerWrapper = MapPrototypeGet(this[handlerSymbol], name);
      if (handlerWrapper) {
        handlerWrapper.handler = value;
      } else {
        handlerWrapper = makeWrappedHandler(value);
        this.addEventListener(name, handlerWrapper);
      }
      MapPrototypeSet(this[handlerSymbol], name, handlerWrapper);
    }

    constructor() {
      super();
      this[webidl.brand] = webidl.brand;
    }

    get readyState() {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      switch (this[state]) {
        case "empty":
          return FileReader.EMPTY;
        case "loading":
          return FileReader.LOADING;
        case "done":
          return FileReader.DONE;
        default:
          throw new TypeError("Invalid state");
      }
    }

    get result() {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      return this[result];
    }

    get error() {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      return this[error];
    }

    abort() {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      if (
        this[state] === "empty" ||
        this[state] === "done"
      ) {
        this[result] = null;
        return;
      }
      if (this[state] === "loading") {
        this[state] = "done";
        this[result] = null;
      }
      if (this[aborted] !== null) {
        this[aborted].aborted = true;
      }

      const ev = new ProgressEvent("abort", {});
      this.dispatchEvent(ev);

      if (this[state] !== "loading") {
        const ev = new ProgressEvent("loadend", {});
        this.dispatchEvent(ev);
      }
    }

    readAsArrayBuffer(blob) {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      const prefix = "Failed to execute 'readAsArrayBuffer' on 'FileReader'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      this.#readOperation(blob, { kind: "ArrayBuffer" });
    }

    readAsBinaryString(blob) {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      const prefix = "Failed to execute 'readAsBinaryString' on 'FileReader'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      this.#readOperation(blob, { kind: "BinaryString" });
    }

    readAsDataURL(blob) {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      const prefix = "Failed to execute 'readAsDataURL' on 'FileReader'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      this.#readOperation(blob, { kind: "DataUrl" });
    }

    readAsText(blob, encoding = undefined) {
      webidl.assertBranded(this, FileReaderPrototype, "FileReader");
      const prefix = "Failed to execute 'readAsText' on 'FileReader'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      if (encoding !== undefined) {
        encoding = webidl.converters.DOMString(encoding, prefix, "Argument 2");
      }
      this.#readOperation(blob, { kind: "Text", encoding });
    }

    get onerror() {
      return this.#getEventHandlerFor("error");
    }
    set onerror(value) {
      this.#setEventHandlerFor("error", value);
    }

    get onloadstart() {
      return this.#getEventHandlerFor("loadstart");
    }
    set onloadstart(value) {
      this.#setEventHandlerFor("loadstart", value);
    }

    get onload() {
      return this.#getEventHandlerFor("load");
    }
    set onload(value) {
      this.#setEventHandlerFor("load", value);
    }

    get onloadend() {
      return this.#getEventHandlerFor("loadend");
    }
    set onloadend(value) {
      this.#setEventHandlerFor("loadend", value);
    }

    get onprogress() {
      return this.#getEventHandlerFor("progress");
    }
    set onprogress(value) {
      this.#setEventHandlerFor("progress", value);
    }

    get onabort() {
      return this.#getEventHandlerFor("abort");
    }
    set onabort(value) {
      this.#setEventHandlerFor("abort", value);
    }
  }

  ObjectDefineProperty(FileReader.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "FileReader",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const FileReaderPrototype = FileReader.prototype;

  ObjectDefineProperty(FileReader, "EMPTY", {
    __proto__: null,
    writable: false,
    enumerable: true,
    configurable: false,
    value: 0,
  });
  ObjectDefineProperty(FileReader, "LOADING", {
    __proto__: null,
    writable: false,
    enumerable: true,
    configurable: false,
    value: 1,
  });
  ObjectDefineProperty(FileReader, "DONE", {
    __proto__: null,
    writable: false,
    enumerable: true,
    configurable: false,
    value: 2,
  });
  ObjectDefineProperty(FileReader.prototype, "EMPTY", {
    __proto__: null,
    writable: false,
    enumerable: true,
    configurable: false,
    value: 0,
  });
  ObjectDefineProperty(FileReader.prototype, "LOADING", {
    __proto__: null,
    writable: false,
    enumerable: true,
    configurable: false,
    value: 1,
  });
  ObjectDefineProperty(FileReader.prototype, "DONE", {
    __proto__: null,
    writable: false,
    enumerable: true,
    configurable: false,
    value: 2,
  });

  function makeWrappedHandler(handler) {
    function wrappedHandler(evt) {
      if (typeof wrappedHandler.handler !== "function") {
        return;
      }
      return FunctionPrototypeCall(
        wrappedHandler.handler,
        this,
        evt,
      );
    }
    wrappedHandler.handler = handler;
    return wrappedHandler;
  }

  ObjectDefineProperty(globalThis, "FileReader", {
    __proto__: null,
    value: FileReader,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);
