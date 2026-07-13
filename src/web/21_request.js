// Copyright 2026 the Limun authors. MIT license.

// `Request` — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#request-class).
//
// Migrated from Rust (`web::fetch::request.rs`, 494 lines) to
// JS-on-ops. No op needed directly (the body mixin's ops — text
// decoding — live in `19_body.js`); this module is pure JS glue over
// `Headers` (`20_headers.js`) and the shared body mixin.
//
// Simplifications vs. spec (matches the previous Rust impl): the body
// is buffered rather than streamed, so `.body` is a one-chunk
// `ReadableStream` over the bytes (see `19_body.js`).
// `mode`/`credentials`/`cache`/`redirect`/`referrer`/`referrerPolicy`/
// `integrity`/`duplex`/`keepalive` are omitted (the underlying HTTP
// client handles them implicitly or they have no observable effect
// here). `signal` is stored as the raw `AbortSignal` object (or
// `undefined`) — `fetch()` reads it back and threads it through its own
// abort wiring.
//
// Deviation from the previous Rust behavior (a bug fix made during the
// migration, not a regression): the old Rust constructor unconditionally
// cleared any signal inherited from an `input` `Request` whenever an
// `init` object was passed at all — even one with no `signal` key —
// because `v8::Object::get` always returns `Some(undefined)` for an
// absent property, and the code treated "returned a nullish value" the
// same as "explicitly set to null/undefined". Here, `init.signal` is
// only consulted when the key is actually present
// (`init.signal !== undefined`); an `init` without a `signal` key
// leaves an inherited signal alone. Same fix applied to `fetch()`
// (`23_fetch.js`), which had the identical quirk.
//
// Ports Deno's `ext/fetch/23_request.js`, simplified (no streaming body,
// no CORS mode/credentials, no `mode` field) to match the previous Rust
// surface:
//   - `webidl.brand`/`assertBranded`  → inline (09_blob.js pattern).
//   - `webidl.converters.*`           → inline/`String()` coercion.
//   - Body mixin                      → `19_body.js`'s `mixinBody`.
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ObjectCreate,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    Symbol,
    SymbolToStringTag,
    TypeError,
    Uint8Array,
  } = primordials;

  const { createHeaders, getHeaderList, cloneHeaderPairs, parseHeadersInit } =
    globalThis.__bootstrap.headers;
  const { coerceBodyInit, createBodyState, cloneBodyState, mixinBody } =
    globalThis.__bootstrap.body;

  // --- Inline WebIDL (minimal, pilot-scoped) -----------------------------

  const brand = Symbol("[[webidl.brand]]");

  function assertBranded(self, prototype) {
    if (
      !ObjectPrototypeIsPrototypeOf(prototype, self) || self[brand] !== brand
    ) {
      throw new TypeError("Illegal invocation");
    }
  }

  // --- Private fields ------------------------------------------------------

  const _method = Symbol("method");
  const _url = Symbol("url");
  const _headers = Symbol("headers");
  const _bodyState = Symbol("body state");
  const _signal = Symbol("signal");

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
      let bodyBytes = null;
      let signal;

      // `input` is a `Request` OR a string. If `Request`, clone its
      // fields (the base); `init` (if present) overrides them.
      if (
        typeof input === "object" && input !== null &&
        ObjectPrototypeIsPrototypeOf(RequestPrototype, input)
      ) {
        method = input[_method];
        url = input[_url];
        headerPairs = cloneHeaderPairs(getHeaderList(input[_headers]));
        // Body is cloned (spec: clone transfers the body; we have no
        // stream, so a byte-clone is the equivalent). If the source's
        // body was already consumed, this silently yields a bodyless
        // request — matches the previous Rust behavior exactly (it
        // clones whatever's left in the `Option<Vec<u8>>`, and a
        // consumed body is `None`).
        const srcBody = input[_bodyState];
        bodyBytes = srcBody.bytes !== null ? new Uint8Array(srcBody.bytes) : null;
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
          bodyBytes = coerceBodyInit(init.body);
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
      if (bodyBytes !== null && (method === "GET" || method === "HEAD")) {
        throw new TypeError(
          `${prefix}: Request with GET/HEAD method cannot have body`,
        );
      }

      this[brand] = brand;
      this[_method] = method;
      this[_url] = url;
      this[_headers] = createHeaders(headerPairs);
      this[_bodyState] = createBodyState(bodyBytes);
      this[_signal] = signal;
    }

    get method() {
      assertBranded(this, RequestPrototype);
      return this[_method];
    }

    get url() {
      assertBranded(this, RequestPrototype);
      return this[_url];
    }

    get headers() {
      assertBranded(this, RequestPrototype);
      return this[_headers];
    }

    get signal() {
      assertBranded(this, RequestPrototype);
      return this[_signal];
    }

    clone() {
      assertBranded(this, RequestPrototype);
      // Spec: "If this is disturbed or locked, throw a TypeError" —
      // checked (and throws) before anything else is touched.
      const clonedBody = cloneBodyState(this[_bodyState]);
      const clonedHeaders = createHeaders(
        cloneHeaderPairs(getHeaderList(this[_headers])),
      );
      return newRequestInstance(
        this[_method],
        this[_url],
        clonedHeaders,
        clonedBody,
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

  mixinBody(
    RequestPrototype,
    _bodyState,
    (self) => self[_headers].get("content-type"),
    assertBranded,
  );

  /** Build a `Request` instance directly from already-validated parts,
   * bypassing the public constructor's URL/GET-HEAD validation (used
   * by `clone()`). */
  function newRequestInstance(method, url, headers, bodyState, signal) {
    const r = ObjectCreate(RequestPrototype);
    r[brand] = brand;
    r[_method] = method;
    r[_url] = url;
    r[_headers] = headers;
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
    /** Non-destructive peek at a `Request`'s raw buffered body bytes
     * (a copy) — `null` if it never had one, or its body was already
     * consumed. Used by `fetch()` to read the body of a `Request`
     * `input` without marking it as used (matches the previous Rust
     * `fetch()`, which cloned the state rather than consuming it). */
    peekBodyBytes: (request) => {
      const state = request[_bodyState];
      return state.bytes !== null ? new Uint8Array(state.bytes) : null;
    },
  };
})(globalThis);
