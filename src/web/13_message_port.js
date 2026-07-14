// Copyright 2026 the Limun authors. MIT license.

// `MessageChannel` / `MessagePort` / `MessageEvent` — WHATWG HTML "Communication
// channels" (§9.5) + "Ports and messages" (§9.6).
// https://html.spec.whatwg.org/#message-channels
//
// Limun is SINGLE-REALM (one V8 context, no Workers, no cross-process
// messaging — see MISSION.md "One realm"). The transport is therefore
// **JS-side queues + microtask delivery**, NOT Deno's `op_message_port_*`
// resource/rid machinery. Each `MessagePort` has an internal message
// queue (Array). `postMessage(data, transfer)`:
//   1. Validates the transfer list (no self-transfer, no duplicate
//      ports/buffers, no detached ports).
//   2. Serializes `data` via `op_serialize` (with host objects + the
//      transferred ArrayBuffers), producing a `Uint8Array` of wire bytes
//      + a `transferredArrayBuffers` array whose slots now hold the
//      transfer indices (ArrayBuffers were detached on the serialize
//      side). MessagePorts in the transfer list are handled via the
//      host-object brand symbol (set per-instance) — the serializer
//      calls the brand's value to get a payload, the deserializer
//      reconstructs.
//   3. For each transferred MessagePort in `transfer`: disentangles the
//      port (marks it transferred/closed on the sender side, clears its
//      entanglement slot) and records the partner so the receiver
//      re-entangles a fresh port with that partner.
//   4. Enqueues the message envelope on the entangled counterpart's
//      queue, and schedules a microtask to deliver.
//   5. The microtask drains the queue: for each message, calls
//      `op_deserialize` (with the host objects + the transferred
//      ArrayBuffers, which mint fresh buffers for the indices),
//      reconstructs transferred MessagePorts, and dispatches a
//      `MessageEvent` on the port.
//
// `MessagePort` transfer: the brand symbol `Symbol.for("limun.hostObject")`
// (set on each MessagePort instance) marks the port as a host object for
// V8's `ValueSerializer`. When the serializer hits a MessagePort, it calls
// the brand's value (a function) to get the serialization payload — a
// plain object `{ kind: "MessagePort", id }`. The deserialize side
// (`op_deserialize`'s `read_host_object`) wraps the payload in a shell;
// the post-deserialize pass in JS walks the result for these shells and
// swaps them for real MessagePort instances entangled with the original's
// partner (recorded in the message envelope's `partnerPorts` sideband).
//
// Ports Deno's `ext/web/13_message_port.js` (1149 lines), heavily adapted:
//   - Dropped: `op_message_port_*` ops, resource/rid model, `core.close`,
//     `core.refOpPromise`/`unrefOpPromise`, `core.tryClose`,
//     `core.registerTransferableResource`/`Transferable`/`*TransferSteps`,
//     `core.getCloneableDeserializers`/`deserializers` map,
//     `InterruptedPrototype`, `setEventTargetData`,
//     `nodeWorkerThreadCloseCb`/`nodeWorkerThreadCloseCbInvoked`,
//     `refMessagePort`/`unrefParentPort`/`refedMessagePortsCount`,
//     `_MessagePortBase` ref-count override, `ref()`/`unref()`/`hasRef()`
//     (Node.js worker_threads API — not web standard), the
//     `kNotSerializable`/`markNotSerializable`/`kUncloneable`/
//     `markAsUncloneable`/`isUncloneable` machinery, the primitive
//     fast-path (`fastSerialize`/`fastDeserialize`), the lazy
//     `getMessagePortPrototype` cycle (MessageEvent is defined here, no
//     cycle), `[SymbolFor("Deno.privateCustomInspect")]` blocks.
//   - `MessageEvent` is defined HERE (Deno has it in `02_event.js`).
//   - `webidl.converters.StructuredSerializeOptions` defined here (Deno
//     has it here too).
//   - `core.hostObjectBrand` → `Symbol.for("limun.hostObject")` (the same
//     symbol the Rust `SerializeDeserialize` delegate uses for its
//     `is_host_object` check).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_serialize,
    op_deserialize,
  } = globalThis.__limunOps;
  const {
    ArrayPrototypeFilter,
    ArrayPrototypeIncludes,
    ArrayPrototypePush,
    ArrayPrototypeSlice,
    ObjectDefineProperty,
    ObjectFreeze,
    ObjectPrototypeIsPrototypeOf,
    queueMicrotask,
    SafeSet,
    SymbolFor,
    SymbolIterator,
    SymbolToStringTag,
    TypeError,
  } = primordials;

  // Pull `defineEventHandler` from `02_event.js`'s `__bootstrap.event`
  // surface (added there so this module can install `onmessage` /
  // `onmessageerror` handler attributes on `MessagePort.prototype`).
  const { defineEventHandler } = globalThis.__bootstrap.event;
  // `setIsTrusted` — mark internally-dispatched MessageEvents as trusted.
  const { setIsTrusted } = globalThis.__bootstrap.event;

  // The host-object brand symbol — must match the Rust
  // `SerializeDeserialize` delegate's `HOST_OBJECT_SYMBOL_KEY`
  // (`"limun.hostObject"`). Set on each `MessagePort` instance as a
  // function that returns the serialization payload; the serializer
  // calls it via `write_host_object`.
  const hostObjectBrand = SymbolFor("limun.hostObject");

  function isArrayBuffer(value) {
    return value !== null && typeof value === "object" &&
      ObjectPrototypeIsPrototypeOf(ArrayBuffer.prototype, value);
  }

  // --- MessageEvent --------------------------------------------------------

  class MessageEvent extends Event {
    #source = null;

    get source() {
      return this.#source;
    }

    constructor(type, eventInitDict) {
      super(type, {
        bubbles: eventInitDict?.bubbles ?? false,
        cancelable: eventInitDict?.cancelable ?? false,
        composed: eventInitDict?.composed ?? false,
      });

      this.data = eventInitDict?.data ?? null;
      const ports = eventInitDict?.ports;
      if (ports == null) {
        // `ports` is a FrozenArray<MessagePort> per the HTML spec, so the
        // exposed array must be read-only.
        this.ports = ObjectFreeze([]);
      } else {
        if (
          ports === null || typeof ports !== "object" ||
          ports[SymbolIterator] === undefined
        ) {
          throw new TypeError(
            `MessageEvent constructor: eventInitDict.ports is not iterable.`,
          );
        }
        const arr = [];
        let i = 0;
        for (const p of ports) {
          if (
            p === null || typeof p !== "object" ||
            !ObjectPrototypeIsPrototypeOf(MessagePortPrototype, p)
          ) {
            throw new TypeError(
              `MessageEvent constructor: Expected eventInitDict.ports[${i}] to be an instance of MessagePort.`,
            );
          }
          arr[i++] = p;
        }
        this.ports = ObjectFreeze(arr);
      }
      this.origin = eventInitDict?.origin === undefined
        ? ""
        : `${eventInitDict.origin}`;
      this.lastEventId = eventInitDict?.lastEventId === undefined
        ? ""
        : `${eventInitDict.lastEventId}`;
      const source = eventInitDict?.source;
      if (source != null) {
        this.#source = source;
      } else {
        this.#source = null;
      }
    }
  }

  ObjectDefineProperty(MessageEvent.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "MessageEvent",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  const MessageEventPrototype = MessageEvent.prototype;

  // --- MessagePort (single-realm) -----------------------------------------
  //
  // Each `MessagePort` has:
  //   - `[_entangled]` — the counterpart `MessagePort` (or `null` if
  //     closed/transferred). Messages posted on one port are enqueued on
  //     its `[_entangled]` counterpart's `[_queue]`.
  //   - `[_queue]` — Array of message envelopes waiting to be delivered.
  //     Drained on `start()` / `onmessage` set.
  //   - `[_enabled]` — `true` once `start()` has been called (or
  //     `onmessage` set, which implies `start()`). Messages queued before
  //     `start()` are buffered and delivered when `start()` runs.
  //   - `[_dispatchScheduled]` — `true` if a microtask is already
  //     pending to drain the queue (avoids duplicate microtasks).
  //   - `[_closed]` — `true` after `close()` or after the port was
  //     transferred. `postMessage` on a closed port silently returns.

  const _entangled = Symbol("[[entangled]]");
  const _queue = Symbol("[[queue]]");
  const _enabled = Symbol("[[enabled]]");
  const _dispatchScheduled = Symbol("[[dispatchScheduled]]");
  const _closed = Symbol("[[closed]]");
  const _portId = Symbol("[[portId]]");
  // `[_pendingPartner]` — when a port's entangled partner is transferred
  // away, the partner's `[_entangled]` is set to `null` and this port's
  // `[_pendingPartner]` is set to `true`. Messages posted to this port
  // while `[_entangled] === null && [_pendingPartner]` are buffered on
  // THIS port's `[_pendingQueue]` (separate from the regular `[_queue]`,
  // which holds messages destined for THIS port). When the receiver
  // creates a fresh port and entangles it with this port, the
  // `[_pendingQueue]` is flushed to the new counterpart's `[_queue]`.
  const _pendingPartner = Symbol("[[pendingPartner]]");
  const _pendingQueue = Symbol("[[pendingQueue]]");

  // Monotonic port id — used as the entanglement identifier in the
  // serialization payload (informational — single-realm uses the
  // `partnerPorts` sideband to find the partner, but the id is in the
  // wire bytes for debugging/future cross-realm use).
  let nextPortId = 1;

  // `illegalConstructorKey` — `MessagePort`'s constructor throws unless
  // called with this private symbol (so `new MessagePort()` from user
  // code throws, but `createMessagePort` can mint instances internally).
  // Matches `02_event.js`'s `AbortSignal` pattern.
  const illegalConstructorKey = Symbol("illegalConstructorKey");

  class MessagePort extends EventTarget {
    [_entangled] = null;
    [_queue];
    [_enabled] = false;
    [_dispatchScheduled] = false;
    [_closed] = false;
    [_portId];
    [_pendingPartner] = false;
    [_pendingQueue];

    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      super();
    }

    postMessage(message, transferOrOptions = { __proto__: null }) {
      webidl.assertBranded(this, MessagePortPrototype);
      const prefix = "Failed to execute 'postMessage' on 'MessagePort'";
      webidl.requiredArguments(arguments.length, 1, prefix);

      // Normalize the second arg: either a sequence (legacy) or a
      // `StructuredSerializeOptions` dictionary (`{ transfer }`).
      let transfer;
      if (
        transferOrOptions === undefined || transferOrOptions === null ||
        arguments.length <= 1
      ) {
        transfer = [];
      } else if (
        typeof transferOrOptions === "object" &&
        transferOrOptions[SymbolIterator] !== undefined
      ) {
        transfer = ArrayPrototypeSlice(transferOrOptions);
      } else {
        const options = webidl.converters.StructuredSerializeOptions(
          transferOrOptions,
          prefix,
          "Argument 2",
        );
        transfer = options.transfer;
      }

      // Validate transfer list BEFORE the closed-port early return so
      // calls like `port.postMessage(null, [alreadyDetachedPort])` raise
      // the same DataCloneError regardless of whether `this` was already
      // closed (matches Node/WPT behavior).
      if (ArrayPrototypeIncludes(transfer, this)) {
        throw new DOMException(
          "Transfer list contains source port",
          "DataCloneError",
        );
      }
      if (transfer.length > 0) {
        const seenPorts = new SafeSet();
        const seenBuffers = new SafeSet();
        for (let i = 0; i < transfer.length; i++) {
          const t = transfer[i];
          if (ObjectPrototypeIsPrototypeOf(MessagePortPrototype, t)) {
            if (t[_closed]) {
              throw new DOMException(
                "MessagePort in transfer list is already detached",
                "DataCloneError",
              );
            }
            if (seenPorts.has(t)) {
              throw new DOMException(
                "Transfer list contains duplicate MessagePort",
                "DataCloneError",
              );
            }
            seenPorts.add(t);
          } else if (isArrayBuffer(t)) {
            if (seenBuffers.has(t)) {
              throw new DOMException(
                "Transfer list contains duplicate ArrayBuffer",
                "DataCloneError",
              );
            }
            seenBuffers.add(t);
          }
        }
      }

      if (this[_closed]) return;

      // Record partner ports for transferred MessagePorts BEFORE
      // serializing. The serializer will call each transferred port's
      // brand function (which returns `{ kind: "MessagePort", id }`); the
      // deserialize side wraps the payload in a shell, and the
      // post-deserialize pass here swaps shells for fresh ports
      // entangled with the recorded partners.
      const partnerPorts = [];
      for (let i = 0; i < transfer.length; i++) {
        const t = transfer[i];
        if (ObjectPrototypeIsPrototypeOf(MessagePortPrototype, t)) {
          const partner = t[_entangled];
          const pendingMessages = t[_queue];
          t[_queue] = [];
          partnerPorts.push({ transferredPort: t, partner, pendingMessages });
          // Disentangle the transferred port on the sender side — it's
          // now "neutered" (closed for posting). The partner stays live
          // and will be re-entangled with the fresh port the receiver
          // creates.
          t[_entangled] = null;
          t[_closed] = true;
          // Mark the partner as "pending re-entanglement" — messages
          // posted to it before the receiver re-entangles are buffered
          // on the partner's own queue. When the fresh port is created
          // on the receiver, it entangles with the partner and flushes
          // the buffered messages.
          if (partner !== null) {
            partner[_entangled] = null;
            partner[_pendingPartner] = true;
          }
        }
      }

      const envelope = serializeJsMessageData(message, transfer);
      envelope.partnerPorts = partnerPorts;

      // Enqueue on the entangled counterpart's queue. If the
      // counterpart is null (partner was transferred away, pending
      // re-entanglement), buffer on THIS port's pending queue — the
      // fresh port on the receiver will flush it when it entangles.
      const target = this[_entangled];
      if (target === null) {
        if (this[_closed]) return;
        if (this[_pendingPartner]) {
          ArrayPrototypePush(this[_pendingQueue], envelope);
        }
        return;
      }
      if (target[_closed]) return;
      ArrayPrototypePush(target[_queue], envelope);
      if (target[_enabled]) {
        scheduleDispatch(target);
      }
    }

    start() {
      webidl.assertBranded(this, MessagePortPrototype);
      if (this[_enabled]) return;
      this[_enabled] = true;
      if (this[_queue].length > 0) {
        scheduleDispatch(this);
      }
    }

    close() {
      webidl.assertBranded(this, MessagePortPrototype);
      if (this[_closed]) return;
      this[_closed] = true;
      // Disentangle this port from its partner. The partner is still
      // open and can be transferred to another channel (spec: closing
      // one port doesn't close the entangled port — it just severs the
      // link). The partner's `[_entangled]` is cleared so messages
      // posted to it go nowhere (the link is gone), but the partner
      // itself is NOT closed (it can still be transferred, which
      // re-entangles it with a fresh port on the receiver).
      const partner = this[_entangled];
      if (partner !== null) {
        partner[_entangled] = null;
        this[_entangled] = null;
      }
      // Drop any queued messages — the port is closed.
      this[_queue].length = 0;
    }
  }

  ObjectDefineProperty(MessagePort.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "MessagePort",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  const MessagePortPrototype = MessagePort.prototype;

  // `onmessage` implies `start()` (spec: setting `onmessage` starts
  // message delivery). `defineEventHandler`'s third arg is a callback
  // invoked when the handler is first set — we use it to call `start()`.
  defineEventHandler(MessagePort.prototype, "message", function (self) {
    self.start();
  });
  defineEventHandler(MessagePort.prototype, "messageerror");

  // --- MessageChannel ------------------------------------------------------

  class MessageChannel {
    #port1;
    #port2;

    constructor() {
      this[webidl.brand] = webidl.brand;
      const port1 = createMessagePort();
      const port2 = createMessagePort();
      port1[_entangled] = port2;
      port2[_entangled] = port1;
      this.#port1 = port1;
      this.#port2 = port2;
    }

    get port1() {
      webidl.assertBranded(this, MessageChannelPrototype);
      return this.#port1;
    }

    get port2() {
      webidl.assertBranded(this, MessageChannelPrototype);
      return this.#port2;
    }
  }

  ObjectDefineProperty(MessageChannel.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "MessageChannel",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  const MessageChannelPrototype = MessageChannel.prototype;

  // --- StructuredSerializeOptions dictionary ------------------------------

  webidl.converters.StructuredSerializeOptions = webidl.createDictionaryConverter(
    "StructuredSerializeOptions",
    [
      {
        key: "transfer",
        converter: webidl.converters["sequence<object>"],
        get defaultValue() {
          return [];
        },
      },
    ],
  );

  // --- Port factory (sets the host-object brand) -------------------------
  //
  // Called to mint a new MessagePort instance (bypasses the
  // `illegalConstructor` guard — internal use only). Sets the
  // host-object brand symbol to a function returning the serialization
  // payload `{ kind: "MessagePort", id }`. The Rust `write_host_object`
  // calls this function when the serializer encounters the port.

  function createMessagePort() {
    const port = new MessagePort(illegalConstructorKey);
    port[_queue] = [];
    port[_pendingQueue] = [];
    port[_portId] = nextPortId++;
    // Brand: the serializer calls this function to get the payload.
    const id = port[_portId];
    const brandFn = function () {
      return { kind: "MessagePort", id };
    };
    ObjectDefineProperty(port, hostObjectBrand, {
      __proto__: null,
      value: brandFn,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return port;
  }

  // --- Serialize / deserialize (single-realm) ----------------------------

  const serializeErrorCb = (err) => {
    throw new DOMException(`${err}`, "DataCloneError");
  };

  // `serializeJsMessageData(data, transferables)` — serialize `data` for
  // single-realm delivery. Returns an envelope `{ data, transferables,
  // partnerPorts }` (the last is filled in by `postMessage`).
  //
  // `data` is a `Uint8Array` of wire bytes. `transferables` is the
  // `transferredArrayBuffers` array (ArrayBuffers to transfer — slots
  // hold the ArrayBuffers on input, the transfer indices on output).
  function serializeJsMessageData(data, transferables) {
    const transferredArrayBuffers = [];
    for (let i = 0; i < transferables.length; i++) {
      const t = transferables[i];
      if (isArrayBuffer(t)) {
        ArrayPrototypePush(transferredArrayBuffers, t);
      }
      // MessagePorts in the transfer list go through the brand-symbol
      // path (the serializer calls the brand's value to get the
      // payload). They don't need to be in `hostObjects`.
    }

    const options = {
      hostObjects: [],
      transferredArrayBuffers,
    };

    // `op_serialize(value, hostObjects, transferredArrayBuffers,
    // errorCallback)` — pass the host objects array (empty — transferred
    // ports come through the brand-symbol path, not the index path), the
    // transferred ArrayBuffers, and the error callback.
    const serializedData = op_serialize(
      data,
      options.hostObjects,
      options.transferredArrayBuffers,
      serializeErrorCb,
    );

    return {
      data: serializedData,
      transferables: transferredArrayBuffers,
      partnerPorts: [],
    };
  }

  // `deserializeJsMessageData(envelope)` — the inverse. Returns
  // `[data, transferables]` where `transferables` is an array of
  // reconstructed transferables (fresh ArrayBuffers for transferred
  // ArrayBuffers, fresh MessagePorts for transferred ports).
  function deserializeJsMessageData(envelope) {
    const transferredArrayBuffers = envelope.transferables;
    const partnerPorts = envelope.partnerPorts || [];

    // `op_deserialize` mints fresh ArrayBuffers for each index in
    // `transferredArrayBuffers` and writes them back into the same
    // slots. Transferred ports come through the brand path, not the
    // `hostObjects` index path — pass `undefined` so the op uses no
    // host objects.
    const data = op_deserialize(
      envelope.data,
      undefined,
      transferredArrayBuffers,
    );

    // Build the transferables array: fresh ArrayBuffers (from the
    // slots) + fresh MessagePorts (one per partner-port entry).
    const transferables = [];
    for (let i = 0; i < transferredArrayBuffers.length; i++) {
      ArrayPrototypePush(transferables, transferredArrayBuffers[i]);
    }
    for (let i = 0; i < partnerPorts.length; i++) {
      const { partner, pendingMessages } = partnerPorts[i];
      const newPort = createMessagePort();
      // Re-entangle the fresh port with the partner. The partner's
      // `[_entangled]` was cleared on the sender side (postMessage's
      // transfer handling); wire it to the fresh port now. The partner
      // may have buffered messages on its own queue (posted after the
      // transfer but before the receiver re-entangled) — flush them to
      // the new port's queue.
      newPort[_entangled] = partner;
      if (partner !== null) {
        partner[_entangled] = newPort;
        partner[_pendingPartner] = false;
        // Flush buffered messages from the partner's pending queue to
        // the new port's delivery queue.
        while (partner[_pendingQueue].length > 0) {
          const msg = partner[_pendingQueue].shift();
          ArrayPrototypePush(newPort[_queue], msg);
        }
      }
      for (let j = 0; j < pendingMessages.length; j++) {
        ArrayPrototypePush(newPort[_queue], pendingMessages[j]);
      }
      if (newPort[_enabled] && newPort[_queue].length > 0) {
        scheduleDispatch(newPort);
      }
      ArrayPrototypePush(transferables, newPort);
    }

    // Walk the deserialized `data` graph for host-object shells (the
    // Rust `read_host_object` wrapped brand-tagged payloads in
    // `{ [hostObjectBrand]: true, __limunHostObjectPayload: <value> }`
    // shells). Replace each shell with the corresponding fresh
    // MessagePort. The shells appear in the order V8's serializer wrote
    // them — the same order the transfer list was processed — so match
    // by index into `partnerPorts`.
    let shellIdx = 0;
    function replaceShells(value) {
      if (value === null || typeof value !== "object") return value;
      // Shell check: has the brand symbol set to `true` (the Rust
      // `read_host_object` sets it).
      if (value[hostObjectBrand] === true) {
        if (shellIdx < partnerPorts.length) {
          const { partner, pendingMessages } = partnerPorts[shellIdx];
          shellIdx++;
          const newPort = createMessagePort();
          newPort[_entangled] = partner;
          if (partner !== null) {
            partner[_entangled] = newPort;
            partner[_pendingPartner] = false;
            // Flush buffered messages.
            while (partner[_pendingQueue].length > 0) {
              const msg = partner[_pendingQueue].shift();
              ArrayPrototypePush(newPort[_queue], msg);
            }
          }
          for (let j = 0; j < pendingMessages.length; j++) {
            ArrayPrototypePush(newPort[_queue], pendingMessages[j]);
          }
          if (newPort[_enabled] && newPort[_queue].length > 0) {
            scheduleDispatch(newPort);
          }
          return newPort;
        }
      }
      // Recurse into arrays and plain objects.
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          value[i] = replaceShells(value[i]);
        }
      } else if (Object.getPrototypeOf(value) === Object.prototype) {
        for (const k in value) {
          value[k] = replaceShells(value[k]);
        }
      }
      return value;
    }
    if (partnerPorts.length > 0) {
      replaceShells(data);
    }

    return [data, transferables];
  }

  // --- Dispatch -----------------------------------------------------------
  //
  // Schedule a microtask to drain `port`'s queue. Idempotent — if a
  // dispatch is already scheduled, no-op.

  function scheduleDispatch(port) {
    if (port[_dispatchScheduled]) return;
    port[_dispatchScheduled] = true;
    queueMicrotask(() => {
      port[_dispatchScheduled] = false;
      drainQueue(port);
    });
  }

  function drainQueue(port) {
    while (port[_enabled] && !port[_closed]) {
      const envelope = port[_queue].shift();
      if (envelope === undefined) break;
      let data, transferables;
      try {
        const result = deserializeJsMessageData(envelope);
        data = result[0];
        transferables = result[1];
      } catch (err) {
        const event = new MessageEvent("messageerror", { data: err });
        setIsTrusted(event, true);
        port.dispatchEvent(event);
        continue;
      }
      const event = new MessageEvent("message", {
        data,
        ports: transferables.length === 0
          ? undefined
          : ArrayPrototypeFilter(
            transferables,
            (t) => ObjectPrototypeIsPrototypeOf(MessagePortPrototype, t),
          ),
      });
      setIsTrusted(event, true);
      port.dispatchEvent(event);
    }
  }

  // --- Install as non-enumerable globals ----------------------------------

  function installGlobal(name, ctor) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: ctor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("MessageChannel", MessageChannel);
  installGlobal("MessagePort", MessagePort);
  installGlobal("MessageEvent", MessageEvent);

  // Expose the internal surface for other modules (e.g. a future
  // `02_event.js` lazy-load cycle — none today).
  globalThis.__bootstrap.messagePort = {
    MessagePortPrototype,
    MessageEventPrototype,
    deserializeJsMessageData,
  };
})(globalThis);