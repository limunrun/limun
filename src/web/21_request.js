// Copyright 2026 the Limun authors. MIT license.

// `Request` — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#request-class).
//
// Migrated from Rust (`web::fetch::request.rs`, 494 lines) to
// JS-on-ops. No op needed directly (the body mixin's ops — text
// decoding — live in `19_body.js`); this module is pure JS glue over
// `Headers` (`20_headers.js`) and the shared body mixin.
//
// Ports Deno's `ext/fetch/23_request.js`, simplified (no CORS mode/
// credentials, no `mode` field) to match the previous Rust surface:
//   - `webidl.brand`/`assertBranded`  → `globalThis.__bootstrap.webidl`
//     (shared `ext:limun/00_webidl.js`). The body-mixin callback uses a
//     2-arg adapter that wraps `webidl.assertBranded` with
//     `interfaceName: "Request"`.
//   - `webidl.converters.*`           → inline/`String()` coercion.
//   - Body mixin                      → `19_body.js`'s `mixinBody`.
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped.
//
// Body sources: `Request` now supports the full BodyInit union
// (string, BufferSource, Blob, File, FormData, URLSearchParams,
// ReadableStream). The body's implied `content-type` (if any) is set
// on the instance's `Headers` unless the caller already supplied one
// (per the Fetch Standard Request constructor).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    ObjectCreate,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    SafeSet,
    Symbol,
    SymbolToStringTag,
    TypeError,
    Uint8Array,
  } = primordials;

  const { createHeaders, getHeaderList, cloneHeaderPairs, parseHeadersInit,
    guardFromHeaders,
  } = globalThis.__bootstrap.headers;
  const {
    coerceBodyInit,
    createBodyState,
    cloneBodyState,
    drainStream,
    mixinBody,
  } = globalThis.__bootstrap.body;

  // --- Private fields ------------------------------------------------------

  const _method = Symbol("method");
  const _url = Symbol("url");
  const _headers = Symbol("headers");
  const _bodyState = Symbol("body state");
  const _signal = Symbol("signal");
  const _mode = Symbol("mode");

  const REQUEST_MODE = new SafeSet([
    "cors",
    "no-cors",
    "same-origin",
    "navigate",
  ]);

  function convertRequestMode(V, prefix, context) {
    const S = String(V);
    if (!REQUEST_MODE.has(S)) {
      throw new TypeError(
        `${prefix ? prefix + ": " : ""}${context ? context + " " : ""}` +
          `Value '${S}' is not a valid RequestMode value`,
      );
    }
    return S;
  }

  // --- Request class -------------------------------------------------------

  class Request {
    constructor(input, init = undefined) {
      const prefix = "Failed to construct 'Request'";
      if (arguments.length < 1) {
        throw new TypeError(
          `${prefix}: 1 argument required, but only 0 present`,
        );
      }

      let method = "GET";
      let url = "";
      let headerPairs = [];
      let bodyState = createBodyState(null);
      let bodyContentType = null;
      let signal;
      let mode = "cors";
      let inputIsRequest = false;

      // `input` is a `Request` OR a string. If `Request`, clone its
      // fields (the base); `init` (if present) overrides them.
      if (
        typeof input === "object" && input !== null &&
        ObjectPrototypeIsPrototypeOf(RequestPrototype, input)
      ) {
        inputIsRequest = true;
        method = input[_method];
        url = input[_url];
        mode = input[_mode];
        headerPairs = cloneHeaderPairs(getHeaderList(input[_headers]));
        // Spec: clone the input's body. `cloneBodyState` throws if the
        // body is disturbed or locked; for a streaming body it tees the
        // stream.
        bodyState = cloneBodyState(input[_bodyState]);
        signal = input[_signal];
      }
      if (url === "") {
        url = String(input);
      }

      // `init` overrides.
      if (init !== undefined && init !== null) {
        if (init.method !== undefined) {
          method = String(init.method).toUpperCase();
        }
        if (init.headers !== undefined) {
          headerPairs = parseHeadersInit(init.headers);
        }
        if (init.body !== undefined && init.body !== null) {
          const coerced = coerceBodyInit(init.body);
          bodyState = createBodyState(coerced);
          bodyContentType = coerced.contentType;
        }
        if (init.mode !== undefined) {
          mode = convertRequestMode(init.mode, prefix, "mode");
          if (mode === "navigate") {
            throw new TypeError(
              `${prefix}: mode cannot be "navigate"`,
            );
          }
        }
        // See the file header comment: only touch `signal` when the
        // key is actually present (fixes a quirk in the previous Rust
        // impl where any `init` object at all cleared an inherited
        // signal).
        if (init.signal !== undefined) {
          signal = init.signal === null ? undefined : init.signal;
        }
      }

      // Spec: "If parsedURL is failure, throw a TypeError." There's no
      // document base URL in a CLI runtime, so relative specifiers
      // can't be resolved and are a failure here.
      try {
        void new URL(url);
      } catch {
        throw new TypeError(`${prefix}: invalid URL "${url}"`);
      }
      // Spec: "If init.body is non-null and request's method is GET or
      // HEAD, throw a TypeError."
      if (bodyState.hasBody && (method === "GET" || method === "HEAD")) {
        throw new TypeError(
          `${prefix}: Request with GET/HEAD method cannot have body`,
        );
      }

      this[webidl.brand] = webidl.brand;
      this[_method] = method;
      this[_url] = url;
      this[_mode] = mode;
      const guard = mode === "no-cors" ? "request-no-cors" : "request";
      this[_headers] = createHeaders(headerPairs, guard);
      // If the body init implies a content-type and the caller did not
      // already supply one, append it (per Fetch Standard Request
      // constructor).
      if (bodyContentType !== null && !this[_headers].has("content-type")) {
        this[_headers].append("content-type", bodyContentType);
      }
      this[_bodyState] = bodyState;
      this[_signal] = signal;
    }

    get method() {
      webidl.assertBranded(this, RequestPrototype, "Request");
      return this[_method];
    }

    get url() {
      webidl.assertBranded(this, RequestPrototype, "Request");
      return this[_url];
    }

    get headers() {
      webidl.assertBranded(this, RequestPrototype, "Request");
      return this[_headers];
    }

    get mode() {
      webidl.assertBranded(this, RequestPrototype, "Request");
      return this[_mode];
    }

    get signal() {
      webidl.assertBranded(this, RequestPrototype, "Request");
      return this[_signal];
    }

    clone() {
      webidl.assertBranded(this, RequestPrototype, "Request");
      // Spec: "If this is disturbed or locked, throw a TypeError" —
      // checked (and throws) before anything else is touched.
      const clonedBody = cloneBodyState(this[_bodyState]);
      const clonedHeaders = createHeaders(
        cloneHeaderPairs(getHeaderList(this[_headers])),
        guardFromHeaders(this[_headers]),
      );
      return newRequestInstance(
        this[_method],
        this[_url],
        clonedHeaders,
        clonedBody,
        this[_mode],
        this[_signal],
      );
    }
  }

  ObjectDefineProperty(Request.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "Request",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const RequestPrototype = Request.prototype;

  // `mixinBody` (19_body.js) calls `assertBranded(this, prototype)` with
  // two args; `webidl.assertBranded` takes an optional 3rd `interfaceName`
  // (undefined → "Illegal invocation"). Bind it so the body mixin's
  // 2-arg call site gets the spec-correct message for `Request`.
  function assertBranded(self, prototype) {
    return webidl.assertBranded(self, prototype, "Request");
  }

  mixinBody(
    RequestPrototype,
    _bodyState,
    (self) => self[_headers].get("content-type"),
    assertBranded,
  );

  /** Build a `Request` instance directly from already-validated parts,
   * bypassing the public constructor's URL/GET-HEAD validation (used
   * by `clone()`). */
  function newRequestInstance(method, url, headers, bodyState, mode, signal) {
    const r = ObjectCreate(RequestPrototype);
    r[webidl.brand] = webidl.brand;
    r[_method] = method;
    r[_url] = url;
    r[_headers] = headers;
    r[_mode] = mode;
    r[_bodyState] = bodyState;
    r[_signal] = signal;
    return r;
  }

  // --- Install as non-enumerable global -----------------------------------

  ObjectDefineProperty(globalThis, "Request", {
    __proto__: null,
    value: Request,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // --- Internal export (consumed by 23_fetch.js) --------------------------

  globalThis.__bootstrap.request = {
    isRequest: (v) => ObjectPrototypeIsPrototypeOf(RequestPrototype, v),
    /** Peek at a `Request`'s body bytes without marking a buffered
     * body as used. For a streaming body, the stream is drained (and
     * the body becomes used). Returns a `Uint8Array` (possibly empty)
     * or `null` if the Request has no body. */
    peekBodyBytes: async (request) => {
      const state = request[_bodyState];
      if (!state.hasBody) return new Uint8Array(0);
      if (state.source === "stream") {
        state.consumed = true;
        return drainStream(state.stream);
      }
      return state.bytes !== null ? new Uint8Array(state.bytes) : new Uint8Array(0);
    },
  };
})(globalThis);
