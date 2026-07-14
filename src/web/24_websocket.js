// Copyright 2026 the Limun authors. MIT license.

// `WebSocket` — WHATWG WebSocket Standard
// (https://websockets.spec.whatwg.org/).
//
// The spec surface (class shape, URL parsing, protocol validation,
// readyState, event handlers, send/close) lives here in JS. The
// irreducible native work — the TCP/TLS WebSocket transport
// (`tokio-tungstenite`) — lives behind Rust ops registered in
// `core::ops` as `op_ws_*`.
//
// Architecture (Limun's JS-on-ops model):
//   - `op_ws_create(url, protocols)` → Promise<{ rid, protocol,
//     extensions }>. Spawns a tokio task that connects + completes the
//     opening handshake. The JS side awaits this; on success it sets
//     readyState=OPEN, dispatches "open", and starts the event loop.
//   - `op_ws_next_event(rid)` → Promise<number>. Awaits the next
//     WebSocket event. Kind: 0=text, 1=binary, 2=pong, 3=error,
//     >=1000=close (the kind IS the close code).
//   - `op_ws_get_buffer(rid)` → Uint8Array (binary payload from the
//     last event).
//   - `op_ws_get_buffer_as_string(rid)` → string (text payload).
//   - `op_ws_get_error(rid)` → string (error message or close reason).
//   - `op_ws_send_text(rid, string)` → void.
//   - `op_ws_send_binary(rid, Uint8Array)` → void.
//   - `op_ws_close(rid, code, reason)` → Promise (sends close frame).
//   - `op_ws_get_buffered_amount(rid)` → number.
//
// Ports Deno's `ext/websocket/01_websocket.js`, adapted to Limun's
// flat-op model:
//   - `core.ops` → `globalThis.__limunOps`
//   - `core.loadExtScript(...)` → `globalThis.__bootstrap.*`
//   - `op_ws_send_binary_ab` → merged into `op_ws_send_binary` (accepts
//     any ArrayBufferView or ArrayBuffer)
//   - `op_ws_check_permission_and_cancel_handle` → permission check
//     done in JS via `permissions::check` (the op_ws_create Rust side
//     also checks, as the gate)
//   - `core.tryClose(rid)` → no resource table; the Rust side drops
//     the WebSocket when close completes
//   - Inspector instrumentation → dropped (no DevTools protocol)
//   - `getLocationHref()` → `globalThis.location?.href` (may be
//     undefined — the WPT runner sets a shim `location`)
//   - `Blob` send path → handled in JS (read blob → ArrayBuffer →
//     `op_ws_send_binary`)
//   - Server-side WebSocket (`SERVER` role, `upgradeWebSocket`) →
//     dropped (Limun has no HTTP server)

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    op_ws_create,
    op_ws_next_event,
    op_ws_get_buffer,
    op_ws_get_buffer_as_string,
    op_ws_get_error,
    op_ws_send_text,
    op_ws_send_binary,
    op_ws_close,
    op_ws_get_buffered_amount,
  } = globalThis.__limunOps;
  const {
    ArrayIsArray,
    ArrayPrototypeJoin,
    ArrayPrototypeMap,
    ArrayPrototypePush,
    ArrayPrototypeShift,
    ArrayBufferIsView,
    ObjectDefineProperties,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    PromisePrototypeCatch,
    PromisePrototypeThen,
    RegExpPrototypeExec,
    SafeSet,
    SetPrototypeGetSize,
    String,
    StringPrototypeEndsWith,
    StringPrototypeToLowerCase,
    SymbolToStringTag,
    TypeError,
  } = primordials;
  const { defineEventHandler, setIsTrusted } = globalThis.__bootstrap.event;
  const MessageEvent = globalThis.MessageEvent;
  const ErrorEvent = globalThis.ErrorEvent;
  const infra = globalThis.__bootstrap.infra;
  const { HTTP_TOKEN_CODE_POINT_RE } = infra;

  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;

  const _readyState = Symbol("[[readyState]]");
  const _url = Symbol("[[url]]");
  const _rid = Symbol("[[rid]]");
  const _extensions = Symbol("[[extensions]]");
  const _protocol = Symbol("[[protocol]]");
  const _binaryType = Symbol("[[binaryType]]");
  const _sendQueue = Symbol("[[sendQueue]]");
  const _eventLoop = Symbol("[[eventLoop]]");
  const _queueSend = Symbol("[[queueSend]]");

  function getLocationHref() {
    try {
      return globalThis.location?.href;
    } catch {
      return undefined;
    }
  }

  const BlobPrototype = globalThis.Blob?.prototype;

  webidl.converters["WebSocketSend"] = (V, prefix, context, opts) => {
    if (BlobPrototype && ObjectPrototypeIsPrototypeOf(BlobPrototype, V)) {
      return V;
    }
    if (typeof V === "object" && V !== null) {
      if (V instanceof ArrayBuffer) {
        return V;
      }
      if (ArrayBufferIsView(V)) {
        return V;
      }
    }
    return webidl.converters.USVString(V, prefix, context, opts);
  };

  class WebSocket extends EventTarget {
    constructor(url, initOrProtocols) {
      super();
      this[webidl.brand] = webidl.brand;
      this[_rid] = undefined;
      this[_readyState] = CONNECTING;
      this[_extensions] = "";
      this[_protocol] = "";
      this[_url] = "";
      this[_binaryType] = "blob";
      this[_sendQueue] = [];

      const prefix = "Failed to construct 'WebSocket'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      url = webidl.converters.USVString(url, prefix, "Argument 1");

      if (initOrProtocols !== undefined && initOrProtocols !== null) {
        if (typeof initOrProtocols === "string") {
          initOrProtocols = [initOrProtocols];
        } else if (
          typeof initOrProtocols === "object" &&
          initOrProtocols[Symbol.iterator] !== undefined &&
          !ArrayIsArray(initOrProtocols)
        ) {
          // It's a WebSocketInit-like object with `protocols`
        } else if (ArrayIsArray(initOrProtocols)) {
          // Already an array
        } else if (typeof initOrProtocols === "object") {
          const proto = initOrProtocols.protocols;
          if (proto !== undefined) {
            if (typeof proto === "string") {
              initOrProtocols = [proto];
            } else {
              initOrProtocols = proto;
            }
          } else {
            initOrProtocols = [];
          }
        }
      } else {
        initOrProtocols = [];
      }

      let wsURL;
      try {
        const base = getLocationHref();
        wsURL = base
          ? new URL(url, base)
          : new URL(url);
      } catch (e) {
        throw new DOMException(e.message, "SyntaxError");
      }

      if (wsURL.protocol === "http:") {
        wsURL.protocol = "ws:";
      } else if (wsURL.protocol === "https:") {
        wsURL.protocol = "wss:";
      }

      if (wsURL.protocol !== "ws:" && wsURL.protocol !== "wss:") {
        throw new DOMException(
          `Only ws & wss schemes are allowed in a WebSocket URL: received ${wsURL.protocol}`,
          "SyntaxError",
        );
      }

      if (wsURL.hash !== "" || StringPrototypeEndsWith(wsURL.href, "#")) {
        throw new DOMException(
          "Fragments are not allowed in a WebSocket URL",
          "SyntaxError",
        );
      }

      this[_url] = wsURL.href;

      const protocols = initOrProtocols;

      if (
        protocols.length !==
          SetPrototypeGetSize(
            new SafeSet(
              ArrayPrototypeMap(protocols, (p) => StringPrototypeToLowerCase(p)),
            ),
          )
      ) {
        throw new DOMException(
          "Cannot supply the same protocol multiple times",
          "SyntaxError",
        );
      }

      if (
        ArrayPrototypeJoin(
          ArrayPrototypeMap(
            protocols,
            (p) =>
              RegExpPrototypeExec(HTTP_TOKEN_CODE_POINT_RE, p) === null
                ? "1"
                : "0",
          ),
          "",
        ) !== "0".repeat(protocols.length)
      ) {
        throw new DOMException(
          "Invalid protocol value",
          "SyntaxError",
        );
      }

      PromisePrototypeThen(
        op_ws_create(
          wsURL.href,
          ArrayPrototypeJoin(protocols, ", "),
        ),
        (create) => {
          if (this[_readyState] === CLOSING) {
            this[_readyState] = CLOSED;
            const errEvent = new ErrorEvent("error");
            this.dispatchEvent(errEvent);
            const event = new CloseEvent("close");
            this.dispatchEvent(event);
            return;
          }
          this[_rid] = create.rid;
          this[_extensions] = create.extensions;
          this[_protocol] = create.protocol;
          this[_readyState] = OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this[_eventLoop]();
        },
        (err) => {
          this[_readyState] = CLOSED;
          const errorEv = new ErrorEvent("error", {
            error: err,
            message: err?.message ?? String(err),
          });
          this.dispatchEvent(errorEv);
          const closeEv = new CloseEvent("close");
          this.dispatchEvent(closeEv);
        },
      );
    }

    get readyState() {
      webidl.assertBranded(this, WebSocketPrototype);
      return this[_readyState];
    }

    get CONNECTING() {
      webidl.assertBranded(this, WebSocketPrototype);
      return CONNECTING;
    }
    get OPEN() {
      webidl.assertBranded(this, WebSocketPrototype);
      return OPEN;
    }
    get CLOSING() {
      webidl.assertBranded(this, WebSocketPrototype);
      return CLOSING;
    }
    get CLOSED() {
      webidl.assertBranded(this, WebSocketPrototype);
      return CLOSED;
    }

    get extensions() {
      webidl.assertBranded(this, WebSocketPrototype);
      return this[_extensions];
    }

    get protocol() {
      webidl.assertBranded(this, WebSocketPrototype);
      return this[_protocol];
    }

    get url() {
      webidl.assertBranded(this, WebSocketPrototype);
      return this[_url];
    }

    get binaryType() {
      webidl.assertBranded(this, WebSocketPrototype);
      return this[_binaryType];
    }

    set binaryType(value) {
      webidl.assertBranded(this, WebSocketPrototype);
      value = webidl.converters.DOMString(
        value,
        "Failed to set 'binaryType' on 'WebSocket'",
      );
      if (value === "blob" || value === "arraybuffer") {
        this[_binaryType] = value;
      }
    }

    get bufferedAmount() {
      webidl.assertBranded(this, WebSocketPrototype);
      if (this[_readyState] === OPEN && this[_rid] !== undefined) {
        return op_ws_get_buffered_amount(this[_rid]);
      }
      return 0;
    }

    send(data) {
      webidl.assertBranded(this, WebSocketPrototype);
      const prefix = "Failed to execute 'send' on 'WebSocket'";

      webidl.requiredArguments(arguments.length, 1, prefix);
      data = webidl.converters.WebSocketSend(data, prefix, "Argument 1");

      if (this[_readyState] === CONNECTING) {
        throw new DOMException("'readyState' not OPEN", "InvalidStateError");
      }

      if (this[_readyState] !== OPEN) {
        return;
      }

      if (this[_sendQueue].length === 0) {
        if (ArrayBufferIsView(data) || data instanceof ArrayBuffer) {
          op_ws_send_binary(this[_rid], data);
        } else {
          if (
            BlobPrototype && ObjectPrototypeIsPrototypeOf(BlobPrototype, data)
          ) {
            this[_queueSend](data);
          } else {
            op_ws_send_text(this[_rid], String(data));
          }
        }
      } else {
        this[_queueSend](data);
      }
    }

    close(code = undefined, reason = undefined) {
      webidl.assertBranded(this, WebSocketPrototype);
      const prefix = "Failed to execute 'close' on 'WebSocket'";

      if (code !== undefined) {
        code = webidl.converters["unsigned short"](code, prefix, "Argument 1", {
          clamp: true,
        });
      }

      if (reason !== undefined) {
        reason = webidl.converters.USVString(reason, prefix, "Argument 2");
      }

      if (code !== undefined && !(code === 1000 || (3000 <= code && code < 5000))) {
        throw new DOMException(
          `The close code must be either 1000 or in the range of 3000 to 4999: received ${code}`,
          "InvalidAccessError",
        );
      }

      if (reason !== undefined && new TextEncoder().encode(reason).length > 123) {
        throw new DOMException(
          "The close reason may not be longer than 123 bytes",
          "SyntaxError",
        );
      }

      if (this[_readyState] === CONNECTING) {
        this[_readyState] = CLOSING;
      } else if (this[_readyState] === OPEN) {
        this[_readyState] = CLOSING;
        PromisePrototypeCatch(
          op_ws_close(this[_rid], code, reason),
          (err) => {
            this[_readyState] = CLOSED;
            const errorEv = new ErrorEvent("error", {
              error: err,
              message: err?.message ?? String(err),
            });
            this.dispatchEvent(errorEv);
            const closeEv = new CloseEvent("close");
            this.dispatchEvent(closeEv);
          },
        );
      }
    }

    async [_eventLoop]() {
      const rid = this[_rid];
      while (this[_readyState] !== CLOSED) {
        let kind;
        try {
          kind = await op_ws_next_event(rid);
        } catch {
          this[_readyState] = CLOSED;
          const errorEv = new ErrorEvent("error");
          this.dispatchEvent(errorEv);
          const closeEv = new CloseEvent("close");
          this.dispatchEvent(closeEv);
          break;
        }

        if (kind === undefined) {
          this[_readyState] = CLOSED;
          const closeEv = new CloseEvent("close");
          this.dispatchEvent(closeEv);
          break;
        }

        switch (kind) {
          case 0: {
            const data = op_ws_get_buffer_as_string(rid);
            if (data === undefined) break;
            const event = new MessageEvent("message", {
              data,
              origin: this[_url],
            });
            setIsTrusted(event, true);
            this.dispatchEvent(event);
            break;
          }
          case 1: {
            const d = op_ws_get_buffer(rid);
            if (d === undefined) break;
            const buffer = d.buffer;
            let data;
            if (this[_binaryType] === "blob") {
            const Blob = globalThis.Blob;
            if (Blob) {
              data = new Blob([buffer]);
            } else {
                data = buffer;
              }
            } else {
              data = buffer;
            }
            const event = new MessageEvent("message", {
              data,
              origin: this[_url],
            });
            setIsTrusted(event, true);
            this.dispatchEvent(event);
            break;
          }
          case 2: {
            break;
          }
          case 3: {
            this[_readyState] = CLOSED;
            const message = op_ws_get_error(rid);
            const error = new Error(message);
            const errorEv = new ErrorEvent("error", {
              error,
              message,
            });
            this.dispatchEvent(errorEv);
            const closeEv = new CloseEvent("close");
            this.dispatchEvent(closeEv);
            break;
          }
          default: {
            const closeCode = kind;
            const closeReason = closeCode == 1005
              ? ""
              : op_ws_get_error(rid);
            const prevState = this[_readyState];
            this[_readyState] = CLOSED;
            if (prevState === OPEN) {
              try {
                await op_ws_close(rid, closeCode, closeReason);
              } catch {
                // ignore
              }
            }
            const event = new CloseEvent("close", {
              wasClean: true,
              code: closeCode,
              reason: closeReason,
            });
            this.dispatchEvent(event);
            break;
          }
        }
      }
    }

    async [_queueSend](data) {
      const queue = this[_sendQueue];
      ArrayPrototypePush(queue, data);

      if (queue.length > 1) return;

      while (queue.length > 0) {
        const item = queue[0];
        if (ArrayBufferIsView(item) || item instanceof ArrayBuffer) {
          op_ws_send_binary(this[_rid], item);
        } else {
          const BlobProto = BlobPrototype;
          if (BlobProto && ObjectPrototypeIsPrototypeOf(BlobProto, item)) {
            const ab = await item.slice().arrayBuffer();
            op_ws_send_binary(this[_rid], ab);
          } else {
            op_ws_send_text(this[_rid], String(item));
          }
        }
        ArrayPrototypeShift(queue);
      }
    }
  }

  class CloseEvent extends Event {
    constructor(type, eventInitDict = { __proto__: null }) {
      super(type, eventInitDict);
      this.wasClean = eventInitDict?.wasClean ?? false;
      this.code = eventInitDict?.code ?? 0;
      this.reason = eventInitDict?.reason ?? "";
    }
  }

  ObjectDefineProperty(CloseEvent.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "CloseEvent",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  ObjectDefineProperties(WebSocket, {
    CONNECTING: {
      __proto__: null,
      value: CONNECTING,
    },
    OPEN: {
      __proto__: null,
      value: OPEN,
    },
    CLOSING: {
      __proto__: null,
      value: CLOSING,
    },
    CLOSED: {
      __proto__: null,
      value: CLOSED,
    },
  });

  const WebSocketPrototype = WebSocket.prototype;
  ObjectDefineProperty(WebSocketPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "WebSocket",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  defineEventHandler(WebSocket.prototype, "message");
  defineEventHandler(WebSocket.prototype, "error");
  defineEventHandler(WebSocket.prototype, "close");
  defineEventHandler(WebSocket.prototype, "open");

  function installGlobal(name, ctor) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: ctor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("WebSocket", WebSocket);
  installGlobal("CloseEvent", CloseEvent);
})(globalThis);