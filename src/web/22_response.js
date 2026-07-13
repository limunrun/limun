// Copyright 2026 the Limun authors. MIT license.

// `Response` — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#response-class).
//
// Migrated from Rust (`web::fetch::response.rs`, 745 lines) to
// JS-on-ops. Pure JS glue over `Headers` (`20_headers.js`) and the
// shared body mixin (`19_body.js`); no op needed directly here.
//
// Simplifications vs. spec (matches the previous Rust impl exactly):
// body is always fully buffered up front, so
// `.text()`/`.json()`/`.arrayBuffer()`/`.blob()`/`.formData()` resolve
// as soon as they're called. `.type` is always `"basic"` (or `"error"`
// for `Response.error()`) — no CORS here, so `"cors"`/`"opaque"` never
// arise. Redirects are followed transparently by the underlying HTTP
// client (`op_fetch`, Rust); `.redirected`/`.url` are handed over
// pre-computed from the flat op result (`23_fetch.js`) rather than
// derived from a stored pre-redirect URL — a user-constructed
// `Response` simply has `url: ""`, `redirected: false`.
//
// Ports Deno's `ext/fetch/23_response.js`, simplified (no CORS
// filtering, no stream body) to match the previous Rust surface:
//   - `webidl.brand`/`assertBranded`  → `globalThis.__bootstrap.webidl`
//     (shared `ext:limun/00_webidl.js`). The body-mixin callback uses a
//     2-arg adapter that wraps `webidl.assertBranded` with
//     `interfaceName: "Response"`.
//   - `webidl.converters.*`           → inline/`Number()`/`String()` coercion.
//   - Body mixin                      → `19_body.js`'s `mixinBody`.
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    ArrayPrototypeConcat,
    ArrayPrototypeSome,
    JSONStringify,
    MathTrunc,
    ObjectCreate,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    Symbol,
    SymbolToStringTag,
    TypeError,
    RangeError,
  } = primordials;

  const { createHeaders, getHeaderList, cloneHeaderPairs, parseHeadersInit } =
    globalThis.__bootstrap.headers;
  const { coerceBodyInit, createBodyState, cloneBodyState, mixinBody } =
    globalThis.__bootstrap.body;

  const textEncoder = new TextEncoder();

  // --- Private fields ------------------------------------------------------

  const _status = Symbol("status");
  const _statusText = Symbol("status text");
  const _headers = Symbol("headers");
  const _bodyState = Symbol("body state");
  const _url = Symbol("url");
  const _redirected = Symbol("redirected");
  const _type = Symbol("type");

  // --- Response class --------------------------------------------------------

  class Response {
    constructor(body = null, init = undefined) {
      const prefix = "Failed to construct 'Response'";
      const hasBody = body !== undefined && body !== null;
      const bodyBytes = hasBody ? coerceBodyInit(body) : null;

      let status = 200;
      let statusText = "";
      let headerPairs = [];

      if (init !== undefined && init !== null) {
        if (init.status !== undefined) {
          // Spec: status is in [200, 599]; anything else (including
          // NaN) is a RangeError.
          const raw = Number(init.status);
          if (!(raw >= 200 && raw <= 599)) {
            throw new RangeError(
              `${prefix}: status must be in the range 200 to 599`,
            );
          }
          status = MathTrunc(raw);
        }
        if (init.statusText !== undefined) {
          statusText = String(init.statusText);
        }
        if (init.headers !== undefined) {
          headerPairs = parseHeadersInit(init.headers);
        }
      }

      // Spec: a null-body status (204/205/304) with a non-null body is
      // a TypeError.
      if (hasBody && (status === 204 || status === 205 || status === 304)) {
        throw new TypeError(
          `${prefix}: Response with null body status cannot have body`,
        );
      }

      this[webidl.brand] = webidl.brand;
      this[_status] = status;
      this[_statusText] = statusText;
      this[_headers] = createHeaders(headerPairs);
      this[_bodyState] = createBodyState(bodyBytes);
      this[_url] = "";
      this[_redirected] = false;
      this[_type] = "basic";
    }

    get status() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      return this[_status];
    }

    get statusText() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      return this[_statusText];
    }

    get ok() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      const s = this[_status];
      return s >= 200 && s < 300;
    }

    get headers() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      return this[_headers];
    }

    get url() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      return this[_url];
    }

    get redirected() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      return this[_redirected];
    }

    get type() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      return this[_type];
    }

    clone() {
      webidl.assertBranded(this, ResponsePrototype, "Response");
      // Spec: "If this is disturbed or locked, throw a TypeError" —
      // checked (and throws) before anything else is touched. A
      // null-body response is neither, and clones fine.
      const clonedBody = cloneBodyState(this[_bodyState]);
      const clonedHeaders = createHeaders(
        cloneHeaderPairs(getHeaderList(this[_headers])),
      );
      return newResponseInstance(
        this[_status],
        this[_statusText],
        clonedHeaders,
        clonedBody,
        this[_url],
        this[_redirected],
        this[_type],
      );
    }

    /** `Response.json(data, init?)` — static convenience constructor. */
    static json(data, init = undefined) {
      const prefix = "Failed to execute 'json' on 'Response'";
      let jsonStr;
      try {
        jsonStr = JSONStringify(data);
      } catch {
        jsonStr = undefined;
      }
      if (jsonStr === undefined) {
        throw new TypeError(`${prefix}: value could not be serialized`);
      }
      const bodyBytes = textEncoder.encode(jsonStr);

      let headerPairs = [["content-type", "application/json"]];
      let status = 200;
      let statusText = "";

      if (init !== undefined && init !== null) {
        if (init.status !== undefined) {
          status = MathTrunc(Number(init.status));
        }
        if (init.statusText !== undefined) {
          statusText = String(init.statusText);
        }
        if (init.headers !== undefined) {
          // A user-supplied `content-type` *replaces* the default
          // `application/json` rather than appearing alongside it
          // (the spec sets content-type only if the header list
          // doesn't already contain one).
          const user = parseHeadersInit(init.headers);
          if (ArrayPrototypeSome(user, (pair) => pair[0] === "content-type")) {
            headerPairs = [];
          }
          headerPairs = ArrayPrototypeConcat(headerPairs, user);
        }
      }

      return newResponseInstance(
        status,
        statusText,
        createHeaders(headerPairs),
        createBodyState(bodyBytes),
        "",
        false,
        "basic",
      );
    }

    /** `Response.error()` — a network-error response: status 0, empty
     * body, `type === "error"`. Per spec its headers list is empty and
     * immutable; immutability isn't enforced (no header guards — see
     * `20_headers.js`), an observable-only-on-mutation simplification. */
    static error() {
      return newResponseInstance(
        0,
        "",
        createHeaders([]),
        createBodyState(null),
        "",
        false,
        "error",
      );
    }

    /** `Response.redirect(url, status = 302)` — a redirect response
     * with the `Location` header set to `url` (serialized/validated)
     * and the given redirect status. `status` must be one of
     * 301/302/303/307/308, else a `RangeError` (per spec). */
    static redirect(url, status = 302) {
      const prefix = "Failed to execute 'redirect' on 'Response'";
      let location;
      try {
        location = new URL(url).href;
      } catch (e) {
        throw new TypeError(
          `${prefix}: invalid URL ${JSONStringify(String(url))}: ${e.message}`,
        );
      }
      status = MathTrunc(Number(status));
      if (
        status !== 301 && status !== 302 && status !== 303 &&
        status !== 307 && status !== 308
      ) {
        throw new RangeError(
          `${prefix}: status must be one of 301, 302, 303, 307, 308`,
        );
      }
      return newResponseInstance(
        status,
        reasonPhrase(status),
        createHeaders([["location", location]]),
        createBodyState(null),
        "",
        false,
        "basic",
      );
    }
  }

  /** Canonical HTTP reason phrase for the redirect status codes. */
  function reasonPhrase(status) {
    switch (status) {
      case 301:
        return "Moved Permanently";
      case 302:
        return "Found";
      case 303:
        return "See Other";
      case 307:
        return "Temporary Redirect";
      case 308:
        return "Permanent Redirect";
      default:
        return "";
    }
  }

  ObjectDefineProperty(Response.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "Response",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const ResponsePrototype = Response.prototype;

  // `mixinBody` (19_body.js) calls `assertBranded(this, prototype)` with
  // two args; `webidl.assertBranded` takes an optional 3rd `interfaceName`
  // (undefined → "Illegal invocation"). Bind it so the body mixin's
  // 2-arg call site gets the spec-correct message for `Response`.
  function assertBranded(self, prototype) {
    return webidl.assertBranded(self, prototype, "Response");
  }

  mixinBody(
    ResponsePrototype,
    _bodyState,
    (self) => self[_headers].get("content-type"),
    assertBranded,
  );

  /** Build a `Response` instance directly from already-computed parts,
   * bypassing the public constructor (used by `clone()` and by
   * `fetch()`, `23_fetch.js`, to build a `Response` from the flat
   * `op_fetch` result). */
  function newResponseInstance(
    status,
    statusText,
    headers,
    bodyState,
    url,
    redirected,
    type,
  ) {
    const r = ObjectCreate(ResponsePrototype);
    r[webidl.brand] = webidl.brand;
    r[_status] = status;
    r[_statusText] = statusText;
    r[_headers] = headers;
    r[_bodyState] = bodyState;
    r[_url] = url;
    r[_redirected] = redirected;
    r[_type] = type;
    return r;
  }

  // --- Install as non-enumerable global -----------------------------------

  ObjectDefineProperty(globalThis, "Response", {
    __proto__: null,
    value: Response,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // --- Internal export (consumed by 23_fetch.js) --------------------------

  globalThis.__bootstrap.response = { newResponseInstance };
})(globalThis);
