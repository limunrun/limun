// Copyright 2026 the Limun authors. MIT license.

// `BroadcastChannel` — WHATWG HTML "BroadcastChannel" interface.
// https://html.spec.whatwg.org/#broadcastchannel
//
// Limun is SINGLE-REALM (one V8 context, no Workers, no cross-process
// messaging). The transport is therefore **JS-only in-process pub/sub**,
// NOT Deno's `op_broadcast_*` cross-VM machinery. Each
// `BroadcastChannel` registers itself in a global channel list;
// `postMessage` clones the message via `structuredClone` and dispatches
// a `MessageEvent` to every matching, non-closed channel (except the
// sender) via `queueMicrotask`.
//
// Ports Deno's `ext/web/01_broadcast_channel.js`, heavily adapted:
//   - Dropped: `op_broadcast_*` ops, cross-VM `rid`, `recv()` loop,
//     SharedArrayBuffer out-of-band transfer, `refBroadcastChannel`
//     ref-counting, `core.unrefOpPromise`/`refOpPromise`.
//   - `op_broadcast_serialize`/`op_broadcast_deserialize` →
//     `structuredClone` (already available via `op_structured_clone`).
//   - `defer` → `queueMicrotask` (same semantics — deferred microtask
//     execution).
//   - `core.loadExtScript(...)` → `globalThis.__bootstrap.*` (Limun's
//     cross-module pattern).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const structuredClone = globalThis.__bootstrap.structuredClone;
  const {
    ArrayPrototypeIndexOf,
    ArrayPrototypePush,
    ArrayPrototypeSlice,
    ArrayPrototypeSplice,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    queueMicrotask,
    SymbolToStringTag,
    TypeError,
  } = primordials;
  const { defineEventHandler, setIsTrusted } = globalThis.__bootstrap.event;
  const { MessageEventPrototype } = globalThis.__bootstrap.messagePort;

  const _name = Symbol("[[name]]");
  const _closed = Symbol("[[closed]]");

  const channels = [];

  function getOrigin() {
    try {
      return globalThis.location?.origin ?? "";
    } catch {
      return "";
    }
  }

  function dispatch(source, name, data) {
    const snapshot = ArrayPrototypeSlice(channels);
    for (let i = 0; i < snapshot.length; ++i) {
      const channel = snapshot[i];
      if (channel === source) continue;
      if (channel[_name] !== name) continue;
      if (channel[_closed]) continue;

      let messageData;
      try {
        messageData = structuredClone(data);
      } catch (err) {
        const event = new MessageEvent("messageerror", {
          data: err,
          origin: getOrigin(),
        });
        setIsTrusted(event, true);
        channel.dispatchEvent(event);
        continue;
      }

      const go = () => {
        if (channel[_closed]) return;
        const event = new MessageEvent("message", {
          data: messageData,
          origin: getOrigin(),
        });
        setIsTrusted(event, true);
        channel.dispatchEvent(event);
      };
      queueMicrotask(go);
    }
  }

  class BroadcastChannel extends EventTarget {
    [_name];
    [_closed] = false;

    get name() {
      webidl.assertBranded(this, BroadcastChannelPrototype);
      return this[_name];
    }

    constructor(name) {
      super();

      const prefix = "Failed to construct 'BroadcastChannel'";
      webidl.requiredArguments(arguments.length, 1, prefix);

      this[_name] = webidl.converters.DOMString(name, prefix, "Argument 1");
      this[webidl.brand] = webidl.brand;

      ArrayPrototypePush(channels, this);
    }

    postMessage(message) {
      webidl.assertBranded(this, BroadcastChannelPrototype);

      const prefix = "Failed to execute 'postMessage' on 'BroadcastChannel'";
      webidl.requiredArguments(arguments.length, 1, prefix);

      if (this[_closed]) {
        throw new DOMException("Already closed", "InvalidStateError");
      }

      if (typeof message === "function" || typeof message === "symbol") {
        throw new DOMException("Uncloneable value", "DataCloneError");
      }

      try {
        structuredClone(message);
      } catch (err) {
        if (err?.name === "DataCloneError") throw err;
        throw new DOMException(
          err?.message ?? "Uncloneable value",
          "DataCloneError",
        );
      }

      dispatch(this, this[_name], message);
    }

    close() {
      webidl.assertBranded(this, BroadcastChannelPrototype);
      this[_closed] = true;

      const index = ArrayPrototypeIndexOf(channels, this);
      if (index === -1) return;

      ArrayPrototypeSplice(channels, index, 1);
    }
  }

  const BroadcastChannelPrototype = BroadcastChannel.prototype;
  ObjectDefineProperty(BroadcastChannelPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "BroadcastChannel",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  defineEventHandler(BroadcastChannel.prototype, "message");
  defineEventHandler(BroadcastChannel.prototype, "messageerror");

  function installGlobal(name, ctor) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: ctor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("BroadcastChannel", BroadcastChannel);
})(globalThis);