// Copyright 2026 the Limun authors. MIT license.

// `ReadableStream` / `ReadableStreamDefaultReader` /
// `ReadableStreamDefaultController` — WHATWG Streams Standard
// (https://streams.spec.whatwg.org/).
//
// Migrated from Rust (`web::streams.rs`, 746 lines) to JS-on-ops. The
// previous Rust impl was already in-memory queue management with no
// syscalls or native I/O, so this module has NO Rust op — the spec
// surface (state machine, queue, read requests, lock, cancel, async
// iteration) lives entirely in JS, using primordials. Rust callers that
// need to mint streams (`Response.body`, `Request.body`, `Blob.stream()`)
// call the JS constructor through the cached global via the Rust bridge
// `streams::new_fixed_stream` (same pattern as `DOMException`'s
// `new_instance`).
//
// Start-only subset (per TODO.md known limitation): the constructor
// accepts `(underlyingSource, strategy)` but only `start` is honored —
// `pull`/`cancel`/`type`/`strategy`/backpressure/highWaterMark are not
// implemented. Enough for `Response.body` (a fully-buffered one-shot
// stream) and a basic user-facing push source. `TextDecoderStream`/
// `TextEncoderStream` will build on this in a follow-up.
//
// Ports Deno's `ext/web/06_streams.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps` (unused here — no op)
//   - `webidl.brand` /
//     `webidl.assertBranded`  → inline equivalents (same pattern as
//     `01_dom_exception.js`).
//   - `webidl.converters.*`    → inline converters (no full WebIDL module
//     yet — same approach as base64/DOMException).
//   - `webidl.requiredArguments` → inline `requiredArguments`.
//   - `webidl.configureInterface` → dropped (only sets
//     `[Symbol.toStringTag]`; Limun sets the tag inline).
//   - `core.hostObjectBrand`   → dropped (no host-object branding in Limun).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no Deno-style
//     custom inspect in Limun yet).
//   - `Deferred`/`Queue`/`dequeueValue`/`enqueueValueWithSize`/`resetQueue`/
//     `extractHighWaterMark`/`extractSizeAlgorithm` → simplified inline
//     (the start-only subset doesn't need per-chunk size accounting or
//     backpressure; chunks are stored in a plain array, served FIFO).
//   - `ReadableStreamDefaultReadRequest` class → inlined object literal
//     (one allocation per `read()` is fine for the start-only subset; the
//     class-based fast path in Deno is a hot-loop optimization that
//     matters for `pull`-driven streams, which Limun doesn't have).
//   - Sync fast path in `read()`/`values().next()` → kept (mirrors Deno:
//     if the queue is non-empty and the stream is readable, dequeue
//     synchronously and return a resolved promise, skipping the
//     Deferred + ReadRequest allocation).
//   - BYOB/byte streams/`tee`/`pipeTo`/`pipeThrough`/
//     `WritableStream`/`TransformStream`/`QueuingStrategy` classes →
//     dropped (out of scope for the start-only subset; will land with
//     the full Streams Standard port).
//   - `_detached`/`_resourceBacking`/`_isClosedPromise` → `_detached`
//     kept (set when a stream is transferred; Limun has no structured
//     clone/transfer yet, so it's always false). `_resourceBacking`
//     dropped (no resource-rid-backed streams). `_isClosedPromise`
//     dropped (no `WritableStream` sink that awaits it; the reader's
//     `_closedPromise` covers the observable surface).
//   - `readableStreamAsyncIteratorPrototype` → kept, simplified (the
//     `_iteratorNext` chaining for in-flight reads is retained so
//     results are delivered in call order per the WebIDL default async
//     iterator; the sync fast path is kept too).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayPrototypeShift,
    ObjectDefineProperty,
    ObjectCreate,
    ObjectPrototypeIsPrototypeOf,
    Promise,
    PromisePrototypeThen,
    PromiseResolve,
    PromiseReject,
    Symbol,
    SymbolAsyncIterator,
    TypeError,
  } = primordials;

  // --- Inline WebIDL (minimal, pilot-scoped) ------------------------------

  // `webidl.brand` — a Symbol used as a brand marker. Set on every
  // stream/reader/controller instance in the constructor; checked by the
  // getters/methods via `assertBranded` so a plain `{}` with a prototype
  // welded on (or an object from a different class) fails the brand
  // check and throws `TypeError: Illegal invocation`.
  const brand = Symbol("[[webidl.brand]]");

  // `webidl.assertBranded(self, prototype)` — throw `TypeError` if `self`
  // isn't branded or isn't proto-chained to `prototype`.
  function assertBranded(self, prototype) {
    if (
      !ObjectPrototypeIsPrototypeOf(prototype, self) || self[brand] !== brand
    ) {
      throw new TypeError("Illegal invocation");
    }
  }

  // `webidl.requiredArguments(length, required, prefix)` — throw a
  // `TypeError` if fewer than `required` arguments were passed.
  function requiredArguments(length, required, prefix) {
    if (length < required) {
      throw new TypeError(`${prefix}: ${required} argument${required > 1 ? "s" : ""} required, but only ${length} present`);
    }
  }

  // `webidl.converters.object(V, prefix, context)` — throw if not an
  // object; otherwise return as-is.
  function convertObject(V, prefix, context) {
    if (typeof V !== "object" || V === null) {
      throw new TypeError(`${prefix}: ${context} is not an object`);
    }
    return V;
  }

  // `webidl.converters.any(V)` — identity (no conversion).
  function convertAny(V) {
    return V;
  }

  // --- Private fields (Symbols, not #private — matches Deno) -------------

  // Stream slots.
  const _state = Symbol("[[state]]");
  const _reader = Symbol("[[reader]]");
  const _storedError = Symbol("[[storedError]]");
  const _disturbed = Symbol("[[disturbed]]");
  const _detached = Symbol("[[Detached]]");
  const _controller = Symbol("[[controller]]");

  // Controller slots.
  const _stream = Symbol("[[stream]]");
  const _queue = Symbol("[[queue]]"); // plain Array, served FIFO via shift()
  const _closeRequested = Symbol("[[closeRequested]]");
  const _started = Symbol("[[started]]");
  const _underlyingSource = Symbol("[[underlyingSource]]");
  const _underlyingSourceDict = Symbol("[[underlyingSourceDict]]");

  // Reader slots.
  const _closedPromise = Symbol("[[closedPromise]]");
  const _readRequests = Symbol("[[readRequests]]"); // plain Array, FIFO

  // Async iterator slots.
  const _preventCancel = Symbol("[[preventCancel]]");
  const _iteratorNext = Symbol("[[iteratorNext]]");
  const _iteratorFinished = Symbol("[[iteratorFinished]]");

  // --- Deferred (simplified — no LazyDeferred, no state field) ----------

  // A one-shot resolve/reject pair. Deno's `Deferred` guards against
  // double-settle; we skip that (the spec algorithms only settle once).
  class Deferred {
    #promise;
    #resolve;
    #reject;
    constructor() {
      this.#promise = new Promise((resolve, reject) => {
        this.#resolve = resolve;
        this.#reject = reject;
      });
    }
    get promise() {
      return this.#promise;
    }
    resolve(value) {
      this.#resolve(value);
    }
    reject(reason) {
      this.#reject(reason);
    }
  }

  // --- Small helpers ------------------------------------------------------

  function noop() {}

  function isReadableStreamLocked(stream) {
    return stream[_reader] !== undefined;
  }

  function isReadableStreamDefaultReader(value) {
    return !(
      typeof value !== "object" || value === null || !value[_readRequests]
    );
  }

  // Mark a promise as handled so a momentary unhandled-rejection doesn't
  // trip a debugger's "pause on uncaught exceptions". V8 has no direct
  // `setPromiseIsHandledToTrue`; a no-op `.then` reaction does the same
  // (the rejection is then observed by the reaction, not the
  // unhandled-rejection tracker).
  function setPromiseIsHandledToTrue(promise) {
    PromisePrototypeThen(promise, noop, noop);
  }

  // --- Stream state machine ----------------------------------------------

  // `initializeReadableStream(stream)` — set the fresh stream's slots.
  function initializeReadableStream(stream) {
    stream[_state] = "readable";
    stream[_reader] = undefined;
    stream[_storedError] = undefined;
    stream[_disturbed] = false;
  }

  // `readableStreamClose(stream)` — transition to "closed", resolve any
  // pending read requests with `{ done: true, value: undefined }` and the
  // reader's closed promise.
  function readableStreamClose(stream) {
    stream[_state] = "closed";
    const reader = stream[_reader];
    if (reader === undefined) {
      return;
    }
    // Resolve pending reads with { done: true }.
    const readRequests = reader[_readRequests];
    while (readRequests.length !== 0) {
      const readRequest = ArrayPrototypeShift(readRequests);
      readRequest.closeSteps();
    }
    reader[_closedPromise].resolve(undefined);
  }

  // `readableStreamError(stream, e)` — transition to "errored", reject
  // pending reads and the reader's closed promise.
  function readableStreamError(stream, e) {
    stream[_state] = "errored";
    stream[_storedError] = e;
    const reader = stream[_reader];
    if (reader === undefined) {
      return;
    }
    const closedPromise = reader[_closedPromise];
    closedPromise.reject(e);
    setPromiseIsHandledToTrue(closedPromise.promise);
    if (isReadableStreamDefaultReader(reader)) {
      const readRequests = reader[_readRequests];
      while (readRequests.length !== 0) {
        const readRequest = ArrayPrototypeShift(readRequests);
        readRequest.errorSteps(e);
      }
    }
  }

  // `readableStreamCancel(stream, reason)` — close the stream and return
  // a resolved promise (start-only: the cancel algorithm is a no-op).
  function readableStreamCancel(stream, reason) {
    stream[_disturbed] = true;
    const state = stream[_state];
    if (state === "closed") {
      return PromiseResolve(undefined);
    }
    if (state === "errored") {
      return PromiseReject(stream[_storedError]);
    }
    readableStreamClose(stream);
    return PromiseResolve(undefined);
  }

  // `readableStreamAddReadRequest(stream, readRequest)` — park a pending
  // read on the reader's queue (state must be "readable").
  function readableStreamAddReadRequest(stream, readRequest) {
    stream[_reader][_readRequests].push(readRequest);
  }

  // `readableStreamFulfillReadRequest(stream, chunk, done)` — resolve the
  // oldest pending read request.
  function readableStreamFulfillReadRequest(stream, chunk, done) {
    const reader = stream[_reader];
    const readRequest = ArrayPrototypeShift(reader[_readRequests]);
    if (done) {
      readRequest.closeSteps();
    } else {
      readRequest.chunkSteps(chunk);
    }
  }

  // `readableStreamGetNumReadRequests(stream)` — count of pending reads.
  function readableStreamGetNumReadRequests(stream) {
    return stream[_reader][_readRequests].length;
  }

  // --- Controller ---------------------------------------------------------

  function readableStreamDefaultControllerCanCloseOrEnqueue(controller) {
    const state = controller[_stream][_state];
    return controller[_closeRequested] === false && state === "readable";
  }

  function readableStreamDefaultControllerClose(controller) {
    if (readableStreamDefaultControllerCanCloseOrEnqueue(controller) === false) {
      return;
    }
    controller[_closeRequested] = true;
    if (controller[_queue].length === 0) {
      readableStreamClose(controller[_stream]);
    }
  }

  function readableStreamDefaultControllerEnqueue(controller, chunk) {
    if (readableStreamDefaultControllerCanCloseOrEnqueue(controller) === false) {
      return;
    }
    const stream = controller[_stream];
    // If a reader is waiting, hand the chunk straight to the oldest read
    // request (FIFO) instead of queueing then immediately dequeuing.
    if (
      isReadableStreamLocked(stream) &&
      readableStreamGetNumReadRequests(stream) > 0
    ) {
      readableStreamFulfillReadRequest(stream, chunk, false);
      return;
    }
    controller[_queue].push(chunk);
  }

  function readableStreamDefaultControllerError(controller, e) {
    const stream = controller[_stream];
    if (stream[_state] !== "readable") {
      return;
    }
    controller[_queue].length = 0;
    readableStreamError(stream, e);
  }

  function readableStreamDefaultControllerGetDesiredSize(controller) {
    const state = controller[_stream][_state];
    if (state === "errored") {
      return null;
    }
    if (state === "closed") {
      return 0;
    }
    // Start-only: no backpressure. Desired size is reported as 1 when
    // readable (any positive number suffices — the pull algorithm is a
    // no-op, so this value is never consulted to drive pulls).
    return 1;
  }

  // `_releaseSteps` — a no-op for the default controller (BYOB controllers
  // override it; Limun has no BYOB).
  function readableStreamDefaultControllerReleaseSteps() {
    return;
  }

  // `setUpReadableStreamDefaultControllerFromUnderlyingSource` — build a
  // controller, call `underlyingSource.start(controller)` synchronously
  // (start-only: pull/cancel algorithms are no-ops).
  function setUpReadableStreamDefaultControllerFromUnderlyingSource(
    stream,
    underlyingSource,
    underlyingSourceDict,
  ) {
    const controller = new ReadableStreamDefaultController(brand);
    controller[_stream] = stream;
    controller[_queue] = [];
    controller[_closeRequested] = false;
    controller[_started] = false;
    controller[_underlyingSource] = underlyingSource;
    controller[_underlyingSourceDict] = underlyingSourceDict;
    stream[_controller] = controller;

    if (underlyingSourceDict.start !== undefined) {
      try {
        underlyingSourceDict.start.call(underlyingSource, controller);
      } catch (e) {
        readableStreamDefaultControllerError(controller, e);
        return;
      }
    }
    controller[_started] = true;
  }

  // --- Reader -------------------------------------------------------------

  function readableStreamReaderGenericInitialize(reader, stream) {
    reader[_stream] = stream;
    stream[_reader] = reader;
    const state = stream[_state];
    if (state === "readable") {
      reader[_closedPromise] = new Deferred();
    } else if (state === "closed") {
      reader[_closedPromise] = new Deferred();
      reader[_closedPromise].resolve(undefined);
    } else {
      reader[_closedPromise] = new Deferred();
      reader[_closedPromise].reject(stream[_storedError]);
      setPromiseIsHandledToTrue(reader[_closedPromise].promise);
    }
  }

  function readableStreamReaderGenericRelease(reader) {
    const stream = reader[_stream];
    if (stream[_state] !== "readable") {
      reader[_closedPromise] = new Deferred();
    }
    setPromiseIsHandledToTrue(reader[_closedPromise].promise);
    reader[_closedPromise].reject(
      new TypeError(
        "Reader was released and can no longer be used to monitor the stream's closedness.",
      ),
    );
    readableStreamDefaultControllerReleaseSteps();
    stream[_reader] = undefined;
    reader[_stream] = undefined;
  }

  function readableStreamDefaultReaderErrorReadRequests(reader, e) {
    const readRequests = reader[_readRequests];
    while (readRequests.length !== 0) {
      const readRequest = ArrayPrototypeShift(readRequests);
      readRequest.errorSteps(e);
    }
  }

  function readableStreamDefaultReaderRelease(reader) {
    readableStreamReaderGenericRelease(reader);
    const e = new TypeError("The reader was released.");
    readableStreamDefaultReaderErrorReadRequests(reader, e);
  }

  // `readableStreamDefaultReaderRead(reader, readRequest)` — the core
  // read algorithm. Sync fast path: stream readable, queue non-empty →
  // dequeue and call `chunkSteps` synchronously.
  function readableStreamDefaultReaderRead(reader, readRequest) {
    const stream = reader[_stream];
    stream[_disturbed] = true;
    const state = stream[_state];
    if (state === "closed") {
      readRequest.closeSteps();
    } else if (state === "errored") {
      readRequest.errorSteps(stream[_storedError]);
    } else {
      // readable
      const controller = stream[_controller];
      if (controller[_queue].length !== 0) {
        const chunk = ArrayPrototypeShift(controller[_queue]);
        if (controller[_closeRequested] && controller[_queue].length === 0) {
          readableStreamClose(stream);
        }
        readRequest.chunkSteps(chunk);
      } else {
        readableStreamAddReadRequest(stream, readRequest);
      }
    }
  }

  function readableStreamReaderGenericCancel(reader, reason) {
    const stream = reader[_stream];
    return readableStreamCancel(stream, reason);
  }

  // --- ReadableStream class ----------------------------------------------

  class ReadableStream {
    [_state];
    [_reader];
    [_storedError];
    [_disturbed];
    [_detached];
    [_controller];

    constructor(underlyingSource = undefined, strategy = undefined) {
      if (underlyingSource === brand) {
        this[brand] = brand;
        return;
      }
      const prefix = "Failed to construct 'ReadableStream'";
      underlyingSource = underlyingSource !== undefined
        ? convertObject(underlyingSource, prefix, "Argument 1")
        : null;
      // `strategy` is accepted but ignored (start-only: no
      // backpressure, no size algorithm, no highWaterMark).
      this[brand] = brand;
      initializeReadableStream(this);
      this[_detached] = false;
      const underlyingSourceDict = underlyingSource !== null
        ? underlyingSource
        : {};
      // Reject `type: "bytes"` — Limun has no `ReadableByteStreamController`.
      if (underlyingSourceDict.type === "bytes") {
        throw new TypeError(
          `${prefix}: "bytes" underlying source is not supported`,
        );
      }
      setUpReadableStreamDefaultControllerFromUnderlyingSource(
        this,
        underlyingSource,
        underlyingSourceDict,
      );
    }

    get locked() {
      assertBranded(this, ReadableStreamPrototype);
      return isReadableStreamLocked(this);
    }

    cancel(reason = undefined) {
      try {
        assertBranded(this, ReadableStreamPrototype);
        if (reason !== undefined) {
          reason = convertAny(reason);
        }
      } catch (err) {
        return PromiseReject(err);
      }
      if (isReadableStreamLocked(this)) {
        return PromiseReject(
          new TypeError("Cannot cancel a locked ReadableStream."),
        );
      }
      return readableStreamCancel(this, reason);
    }

    getReader(options = undefined) {
      assertBranded(this, ReadableStreamPrototype);
      const prefix = "Failed to execute 'getReader' on 'ReadableStream'";
      if (options !== undefined) {
        options = convertObject(options, prefix, "Argument 1");
        if (options.mode !== undefined) {
          if (options.mode === "byob") {
            throw new TypeError(
              `${prefix}: BYOB mode is not supported`,
            );
          }
          throw new TypeError(`${prefix}: unsupported mode "${options.mode}"`);
        }
      }
      return acquireReadableStreamDefaultReader(this);
    }

    values(options = undefined) {
      assertBranded(this, ReadableStreamPrototype);
      let preventCancel = false;
      if (options !== undefined) {
        options = convertObject(
          options,
          "Failed to execute 'values' on 'ReadableStream'",
          "Argument 1",
        );
        preventCancel = Boolean(options.preventCancel);
      }
      const iterator = ObjectCreate(readableStreamAsyncIteratorPrototype);
      const reader = acquireReadableStreamDefaultReader(this);
      iterator[_reader] = reader;
      iterator[_preventCancel] = preventCancel;
      return iterator;
    }
  }
  const ReadableStreamPrototype = ReadableStream.prototype;

  // `for await (const chunk of stream)` — same operation as `values()`.
  ObjectDefineProperty(ReadableStreamPrototype, SymbolAsyncIterator, {
    __proto__: null,
    value: ReadableStream.prototype.values,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  function acquireReadableStreamDefaultReader(stream) {
    const reader = new ReadableStreamDefaultReader(brand);
    if (isReadableStreamLocked(stream)) {
      throw new TypeError("ReadableStream is locked");
    }
    readableStreamReaderGenericInitialize(reader, stream);
    reader[_readRequests] = [];
    return reader;
  }

  // --- ReadableStreamDefaultReader class ---------------------------------

  class ReadableStreamDefaultReader {
    [_stream];
    [_closedPromise];
    [_readRequests];

    constructor(stream = undefined) {
      if (stream === brand) {
        this[brand] = brand;
        return;
      }
      const prefix = "Failed to construct 'ReadableStreamDefaultReader'";
      requiredArguments(arguments.length, 1, prefix);
      stream = convertObject(stream, prefix, "Argument 1");
      // Caller (acquireReadableStreamDefaultReader) handles the lock
      // transition; a direct `new ReadableStreamDefaultReader(stream)`
      // checks it here too, matching the spec.
      this[brand] = brand;
      if (isReadableStreamLocked(stream)) {
        throw new TypeError("ReadableStream is locked");
      }
      readableStreamReaderGenericInitialize(this, stream);
      this[_readRequests] = [];
    }

    get closed() {
      try {
        assertBranded(this, ReadableStreamDefaultReaderPrototype);
      } catch (err) {
        return PromiseReject(err);
      }
      return this[_closedPromise].promise;
    }

    read() {
      try {
        assertBranded(this, ReadableStreamDefaultReaderPrototype);
      } catch (err) {
        return PromiseReject(err);
      }
      const stream = this[_stream];
      if (stream === undefined) {
        return PromiseReject(
          new TypeError("Reader has no associated stream."),
        );
      }
      // Sync fast path: stream readable, queue non-empty → dequeue and
      // return a resolved promise, skipping the Deferred + ReadRequest
      // allocation.
      if (stream[_state] === "readable") {
        const controller = stream[_controller];
        if (controller[_queue].length !== 0) {
          stream[_disturbed] = true;
          const chunk = ArrayPrototypeShift(controller[_queue]);
          if (controller[_closeRequested] && controller[_queue].length === 0) {
            readableStreamClose(stream);
          }
          return PromiseResolve({ value: chunk, done: false });
        }
      }
      const promise = new Deferred();
      readableStreamDefaultReaderRead(
        this,
        new ReadableStreamDefaultReadRequest(promise),
      );
      return promise.promise;
    }

    releaseLock() {
      assertBranded(this, ReadableStreamDefaultReaderPrototype);
      if (this[_stream] === undefined) {
        return;
      }
      readableStreamDefaultReaderRelease(this);
    }

    cancel(reason = undefined) {
      try {
        assertBranded(this, ReadableStreamDefaultReaderPrototype);
        if (reason !== undefined) {
          reason = convertAny(reason);
        }
      } catch (err) {
        return PromiseReject(err);
      }
      if (this[_stream] === undefined) {
        return PromiseReject(
          new TypeError("Reader has no associated stream."),
        );
      }
      return readableStreamReaderGenericCancel(this, reason);
    }
  }
  const ReadableStreamDefaultReaderPrototype =
    ReadableStreamDefaultReader.prototype;

  // A `ReadRequest` backed by a `Deferred` — one allocation per `read()`.
  // Deno uses a class to avoid four closure allocations per read; the
  // start-only subset doesn't have a hot read loop (the stream is
  // fully-buffered), so a plain object literal is fine.
  class ReadableStreamDefaultReadRequest {
    #promise;
    constructor(promise) {
      this.#promise = promise;
    }
    chunkSteps(chunk) {
      this.#promise.resolve({ value: chunk, done: false });
    }
    closeSteps() {
      this.#promise.resolve({ value: undefined, done: true });
    }
    errorSteps(e) {
      this.#promise.reject(e);
    }
  }

  // --- ReadableStreamDefaultController class -----------------------------

  class ReadableStreamDefaultController {
    [_stream];
    [_queue];
    [_closeRequested];
    [_started];
    [_underlyingSource];
    [_underlyingSourceDict];

    constructor(brandArg = undefined) {
      if (brandArg !== brand) {
        throw new TypeError("Illegal constructor");
      }
      this[brand] = brand;
    }

    get desiredSize() {
      assertBranded(this, ReadableStreamDefaultControllerPrototype);
      return readableStreamDefaultControllerGetDesiredSize(this);
    }

    close() {
      assertBranded(this, ReadableStreamDefaultControllerPrototype);
      if (readableStreamDefaultControllerCanCloseOrEnqueue(this) === false) {
        throw new TypeError("The stream controller cannot close or enqueue");
      }
      readableStreamDefaultControllerClose(this);
    }

    enqueue(chunk = undefined) {
      assertBranded(this, ReadableStreamDefaultControllerPrototype);
      if (chunk !== undefined) {
        chunk = convertAny(chunk);
      }
      if (readableStreamDefaultControllerCanCloseOrEnqueue(this) === false) {
        throw new TypeError("The stream controller cannot close or enqueue");
      }
      readableStreamDefaultControllerEnqueue(this, chunk);
    }

    error(e = undefined) {
      assertBranded(this, ReadableStreamDefaultControllerPrototype);
      if (e !== undefined) {
        e = convertAny(e);
      }
      readableStreamDefaultControllerError(this, e);
    }
  }
  const ReadableStreamDefaultControllerPrototype =
    ReadableStreamDefaultController.prototype;

  // --- Async iterator -----------------------------------------------------

  // The WebIDL default async iterator: `next()` reads the next chunk,
  // `return()` cancels (unless `preventCancel`) and releases. An
  // in-flight read is chained so results are delivered in call order.
  function readableStreamAsyncIteratorNextSteps(reader) {
    if (reader[_iteratorFinished]) {
      return PromiseResolve({ value: undefined, done: true });
    }
    const promise = new Deferred();
    readableStreamDefaultReaderRead(
      reader,
      new ReadableStreamDefaultReadRequest(promise),
    );
    return promise.promise;
  }

  const readableStreamAsyncIteratorPrototype = ObjectCreate(null, {
    next: {
      __proto__: null,
      value: function next() {
        const reader = this[_reader];
        // Chain after an in-flight read so results are delivered in call
        // order (WebIDL default async iterator).
        const ongoing = reader[_iteratorNext];
        if (ongoing) {
          return reader[_iteratorNext] = PromisePrototypeThen(
            ongoing,
            () => readableStreamAsyncIteratorNextSteps(reader),
            () => readableStreamAsyncIteratorNextSteps(reader),
          );
        }
        // Sync fast path: nothing in flight, stream readable, queue
        // non-empty → dequeue synchronously, return a resolved promise.
        const stream = reader[_stream];
        if (stream !== undefined && stream[_state] === "readable") {
          const controller = stream[_controller];
          if (controller[_queue].length !== 0) {
            stream[_disturbed] = true;
            const chunk = ArrayPrototypeShift(controller[_queue]);
            if (
              controller[_closeRequested] && controller[_queue].length === 0
            ) {
              readableStreamClose(stream);
            }
            return PromiseResolve({ value: chunk, done: false });
          }
        }
        return reader[_iteratorNext] = readableStreamAsyncIteratorNextSteps(
          reader,
        );
      },
      writable: true,
      configurable: true,
      enumerable: true,
    },
    return: {
      __proto__: null,
      value: function _return(arg) {
        const reader = this[_reader];
        const returnSteps = () => {
          if (reader[_iteratorFinished]) {
            return PromiseResolve({ value: arg, done: true });
          }
          reader[_iteratorFinished] = true;
          if (reader[_stream] === undefined) {
            return PromiseResolve({ value: undefined, done: true });
          }
          if (this[_preventCancel] === false) {
            const result = readableStreamReaderGenericCancel(reader, arg);
            readableStreamDefaultReaderRelease(reader);
            return result;
          }
          readableStreamDefaultReaderRelease(reader);
          return PromiseResolve({ value: undefined, done: true });
        };
        reader[_iteratorNext] = reader[_iteratorNext]
          ? PromisePrototypeThen(reader[_iteratorNext], returnSteps, returnSteps)
          : returnSteps();
        return PromisePrototypeThen(
          reader[_iteratorNext],
          () => ({ value: arg, done: true }),
        );
      },
      writable: true,
      configurable: true,
      enumerable: true,
    },
    [SymbolAsyncIterator]: {
      __proto__: null,
      value: function asyncIterator() {
        return this;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    },
  });

  // --- Rust bridge: create a fixed (fully-buffered) stream ---------------

  // `createFixedReadableStream(chunks)` — build a `ReadableStream` whose
  // chunks are pre-populated and which is already closed. Used by Rust
  // callers (`Response.body`, `Request.body`, `Blob.stream()`) through the
  // cached `streams::new_fixed_stream` bridge. `chunks` is an Array of
  // `Uint8Array` (empty chunks are dropped — an empty body must read as
  // `{ done: true }` straight away, not deliver a zero-length chunk
  // first, matching browsers).
  //
  // Installed on `globalThis.__bootstrap` (not a global — internal
  // surface) so the Rust bridge can call it after caching the function
  // global.
  function createFixedReadableStream(chunks) {
    const stream = new ReadableStream(brand);
    initializeReadableStream(stream);
    stream[_detached] = false;
    const controller = new ReadableStreamDefaultController(brand);
    controller[_stream] = stream;
    controller[_queue] = [];
    controller[_closeRequested] = true;
    controller[_started] = true;
    controller[_underlyingSource] = undefined;
    controller[_underlyingSourceDict] = undefined;
    stream[_controller] = controller;
    // Pre-populate the queue (drop empty chunks).
    for (let i = 0; i < chunks.length; ++i) {
      const chunk = chunks[i];
      if (chunk.byteLength !== 0) {
        controller[_queue].push(chunk);
      }
    }
    // If all chunks were empty (or there were none), close now; otherwise
    // the last `read()` dequeues the final chunk and closes the stream
    // because `_closeRequested` is true and the queue is then empty.
    if (controller[_queue].length === 0) {
      readableStreamClose(stream);
    }
    return stream;
  }

  // --- Install as non-enumerable globals ---------------------------------

  function installGlobal(name, ctor) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: ctor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("ReadableStream", ReadableStream);
  installGlobal("ReadableStreamDefaultReader", ReadableStreamDefaultReader);
  // `ReadableStreamDefaultController` is exposed by `start(controller)`,
  // not a public constructor (the constructor throws). Install it on
  // `globalThis` for `instanceof` parity, non-enumerable.
  installGlobal(
    "ReadableStreamDefaultController",
    ReadableStreamDefaultController,
  );

  // Rust bridge: stash the fixed-stream factory on `__bootstrap` so
  // `streams::new_fixed_stream` can call it after caching the function.
  globalThis.__bootstrap.createFixedReadableStream = createFixedReadableStream;
})(globalThis);