// Copyright 2026 the Limun authors. MIT license.

// `Headers` — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#headers-class).
//
// Migrated from Rust (`web::fetch::headers.rs`) to JS-on-ops. Full guard
// enforcement and HTTP-token/value validation per spec, ported from Deno's
// `ext/fetch/20_headers.js` with the Limun bootstrap/primordials wiring.
//
// Rewired vs. Deno:
//   - `__bootstrap` / `core`              → `globalThis.__bootstrap`.
//   - `webidl` / `primordials`            → `globalThis.__bootstrap.webidl` /
//                                          `globalThis.__bootstrap.primordials`.
//   - `core.loadExtScript("ext:deno_web/00_infra.js")` helpers → inlined
//     below (`httpTrim`, token regex, safelisted-header checks).
//   - `HeadersInit` converter               → added to shared webidl module
//     (`src/web/00_webidl.js`) so the constructor uses the same overload
//     resolution as Deno/Node/browsers.
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    ArrayIsArray,
    ArrayPrototypeIncludes,
    ArrayPrototypeJoin,
    ArrayPrototypePush,
    ArrayPrototypeSort,
    ArrayPrototypeSplice,
    FunctionPrototypeCall,
    ObjectHasOwn,
    ObjectPrototypeIsPrototypeOf,
    RegExpPrototypeTest,
    SafeRegExp,
    String,
    StringPrototypeCharCodeAt,
    StringPrototypeMatch,
    StringPrototypeToLowerCase,
    StringPrototypeTrim,
    Symbol,
    SymbolIterator,
    SymbolToStringTag,
    ObjectDefineProperty,
    TypeError,
  } = primordials;

  // --- Private fields ------------------------------------------------------

  const _list = Symbol("header list");
  const _guard = Symbol("guard");
  const _iterableHeaders = Symbol("iterable headers");
  const _iterableHeadersCache = Symbol("iterable headers cache");

  // --- Infra helpers (ported from ext:deno_web/00_infra.js) ----------------

  const HTTP_TOKEN_CODE_POINT_RE = new SafeRegExp(
    "^[\\u0021\\u0023-\\u0025\\u0026\\u0027\\u002a\\u002b\\u002d-\\u002e\\u005e-\\u0060\\u007c\\u007e0-9A-Za-z]+$",
  );
  const HTTP_BETWEEN_WHITESPACE_RE = new SafeRegExp(
    "^[\\t\\n\\r ]*(.*?)[\\t\\n\\r ]*$",
    "s",
  );

  function httpTrim(s) {
    const m = StringPrototypeMatch(s, HTTP_BETWEEN_WHITESPACE_RE);
    return m ? m[1] : "";
  }

  function normalizeHeaderValue(value) {
    return httpTrim(value);
  }

  function checkHeaderNameForHttpTokenCodePoint(name) {
    return RegExpPrototypeTest(HTTP_TOKEN_CODE_POINT_RE, name);
  }

  function checkForInvalidValueChars(value) {
    for (let i = 0; i < value.length; i++) {
      const c = StringPrototypeCharCodeAt(value, i);
      if (c === 0x0a || c === 0x0d || c === 0x00) {
        return false;
      }
    }
    return true;
  }

  // --- Forbidden / no-cors header helpers ----------------------------------

  const FORBIDDEN_REQUEST_NAMES = [
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
  ];

  const FORBIDDEN_METHOD_NAMES = [
    "x-http-method",
    "x-http-method-override",
    "x-method-override",
  ];

  function isForbiddenMethod(method) {
    const lower = StringPrototypeToLowerCase(StringPrototypeTrim(method));
    return lower === "connect" || lower === "trace" || lower === "track";
  }

  function getDecodeSplitHeader(value) {
    const values = [];
    let temporaryValue = "";
    let position = 0;
    while (position < value.length) {
      let c = value[position];
      while (position < value.length && c !== "\u0022" && c !== "\u002C") {
        temporaryValue += c;
        position++;
        c = value[position];
      }
      if (position < value.length && c === "\u0022") {
        position++;
        while (position < value.length && value[position] !== "\u0022") {
          temporaryValue += value[position];
          position++;
        }
        if (position < value.length) position++;
        if (position < value.length) continue;
      }
      temporaryValue = StringPrototypeTrim(temporaryValue);
      ArrayPrototypePush(values, temporaryValue);
      temporaryValue = "";
      if (position >= value.length) break;
      // Current char is comma.
      position++;
    }
    return values;
  }

  function isForbiddenRequestHeader(name, value) {
    const lowerName = StringPrototypeToLowerCase(name);
    if (ArrayPrototypeIncludes(FORBIDDEN_REQUEST_NAMES, lowerName)) {
      return true;
    }
    if (
      lowerName.startsWith("proxy-") || lowerName.startsWith("sec-")
    ) {
      return true;
    }
    if (ArrayPrototypeIncludes(FORBIDDEN_METHOD_NAMES, lowerName)) {
      const methods = getDecodeSplitHeader(value);
      for (let i = 0; i < methods.length; i++) {
        if (isForbiddenMethod(methods[i])) return true;
      }
    }
    return false;
  }

  function isForbiddenResponseHeaderName(name) {
    const lowerName = StringPrototypeToLowerCase(name);
    return lowerName === "set-cookie" || lowerName === "set-cookie2";
  }

  function isCorsUnsafeRequestHeaderByte(byte) {
    return (byte < 0x20 && byte !== 0x09) ||
      byte === 0x22 || byte === 0x28 || byte === 0x29 || byte === 0x3A ||
      byte === 0x3C || byte === 0x3E || byte === 0x3F || byte === 0x40 ||
      byte === 0x5B || byte === 0x5C || byte === 0x5D || byte === 0x7B ||
      byte === 0x7D || byte === 0x7F;
  }

  function isNoCorsSafelistedRequestHeaderName(name) {
    const lowerName = StringPrototypeToLowerCase(name);
    return lowerName === "accept" || lowerName === "accept-language" ||
      lowerName === "content-language" || lowerName === "content-type";
  }

  function isPrivilegedNoCorsRequestHeaderName(name) {
    return StringPrototypeToLowerCase(name) === "range";
  }

  function parseSingleRangeHeaderValue(value) {
    // allowWhitespace is false for no-CORS safelisting.
    let position = 0;
    if (value.substring(0, 5) !== "bytes") return null;
    position = 5;
    if (value[position] !== "\u003D") return null;
    position++;
    let rangeStart = "";
    while (position < value.length) {
      const c = value[position];
      const code = StringPrototypeCharCodeAt(c, 0);
      if (code >= 0x30 && code <= 0x39) {
        rangeStart += c;
        position++;
      } else break;
    }
    const rangeStartValue = rangeStart === "" ? null : Number(rangeStart);
    if (value[position] !== "\u002D") return null;
    position++;
    let rangeEnd = "";
    while (position < value.length) {
      const c = value[position];
      const code = StringPrototypeCharCodeAt(c, 0);
      if (code >= 0x30 && code <= 0x39) {
        rangeEnd += c;
        position++;
      } else break;
    }
    const rangeEndValue = rangeEnd === "" ? null : Number(rangeEnd);
    if (position !== value.length) return null;
    if (rangeStartValue === null && rangeEndValue === null) return null;
    if (
      rangeStartValue !== null && rangeEndValue !== null &&
      rangeStartValue > rangeEndValue
    ) {
      return null;
    }
    return [rangeStartValue, rangeEndValue];
  }

  function isNoCorsSafelistedRequestHeader(name, value) {
    if (value.length > 128) return false;
    const lowerName = StringPrototypeToLowerCase(name);
    switch (lowerName) {
      case "accept": {
        for (let i = 0; i < value.length; i++) {
          if (isCorsUnsafeRequestHeaderByte(StringPrototypeCharCodeAt(value, i))) {
            return false;
          }
        }
        return true;
      }
      case "accept-language":
      case "content-language": {
        for (let i = 0; i < value.length; i++) {
          const byte = StringPrototypeCharCodeAt(value, i);
          if (
            (byte >= 0x30 && byte <= 0x39) ||
            (byte >= 0x41 && byte <= 0x5A) ||
            (byte >= 0x61 && byte <= 0x7A) ||
            byte === 0x20 || byte === 0x2A || byte === 0x2C ||
            byte === 0x2D || byte === 0x2E || byte === 0x3B || byte === 0x3D
          ) {
            continue;
          }
          return false;
        }
        return true;
      }
      case "content-type": {
        for (let i = 0; i < value.length; i++) {
          if (isCorsUnsafeRequestHeaderByte(StringPrototypeCharCodeAt(value, i))) {
            return false;
          }
        }
        const essence = StringPrototypeToLowerCase(
          StringPrototypeTrim(value.split(";")[0]),
        );
        return essence === "application/x-www-form-urlencoded" ||
          essence === "multipart/form-data" ||
          essence === "text/plain";
      }
      case "range": {
        const rangeValue = parseSingleRangeHeaderValue(value);
        return rangeValue !== null && rangeValue[0] !== null;
      }
      default:
        return false;
    }
  }

  // --- Validation / append logic -------------------------------------------

  function validateHeader(name, value, guard) {
    if (!checkHeaderNameForHttpTokenCodePoint(name)) {
      throw new TypeError(`Invalid header name: "${name}"`);
    }
    if (!checkForInvalidValueChars(value)) {
      throw new TypeError(`Invalid header value: "${value}"`);
    }
    if (guard === "immutable") {
      throw new TypeError("Cannot change headers: headers are immutable");
    }
    if (guard === "request" && isForbiddenRequestHeader(name, value)) {
      return false;
    }
    if (guard === "response" && isForbiddenResponseHeaderName(name)) {
      return false;
    }
    return true;
  }

  function appendHeader(headers, name, value) {
    value = normalizeHeaderValue(value);
    if (!validateHeader(name, value, headers[_guard])) return;
    if (headers[_guard] === "request-no-cors") {
      const existing = getHeader(headers[_list], name);
      const temporaryValue = existing === null
        ? value
        : existing + "\x2C\x20" + value;
      if (!isNoCorsSafelistedRequestHeader(name, temporaryValue)) {
        return;
      }
    }
    ArrayPrototypePush(headers[_list], [StringPrototypeToLowerCase(name), value]);
    headers[_iterableHeadersCache] = undefined;
  }

  function setHeader(headers, name, value) {
    value = normalizeHeaderValue(value);
    if (!validateHeader(name, value, headers[_guard])) return;
    if (headers[_guard] === "request-no-cors" &&
      !isNoCorsSafelistedRequestHeader(name, value)) {
      return;
    }
    const list = headers[_list];
    const lowerName = StringPrototypeToLowerCase(name);
    let w = 0;
    let added = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i][0] === lowerName) {
        if (!added) {
          list[w++] = [lowerName, value];
          added = true;
        }
      } else {
        list[w++] = list[i];
      }
    }
    if (!added) {
      ArrayPrototypePush(list, [lowerName, value]);
    } else if (w !== list.length) {
      ArrayPrototypeSplice(list, w);
    }
    headers[_iterableHeadersCache] = undefined;
  }

  function deleteHeader(headers, name) {
    if (!checkHeaderNameForHttpTokenCodePoint(name)) {
      throw new TypeError(`Invalid header name: "${name}"`);
    }
    if (headers[_guard] === "immutable") {
      throw new TypeError("Cannot change headers: headers are immutable");
    }
    if (headers[_guard] === "request-no-cors" &&
      !isNoCorsSafelistedRequestHeaderName(name) &&
      !isPrivilegedNoCorsRequestHeaderName(name)) {
      return;
    }
    const lowerName = StringPrototypeToLowerCase(name);
    const list = headers[_list];
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i][0] !== lowerName) list[w++] = list[i];
    }
    if (w !== list.length) {
      ArrayPrototypeSplice(list, w);
      headers[_iterableHeadersCache] = undefined;
    }
  }

  function getHeader(list, name) {
    const lowerName = StringPrototypeToLowerCase(name);
    let value = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i][0] === lowerName) {
        value = value === null ? list[i][1] : value + ", " + list[i][1];
      }
    }
    return value;
  }

  // --- HeadersInit parsing -------------------------------------------------

  function fillHeaders(headers, object) {
    if (ArrayIsArray(object)) {
      for (let i = 0; i < object.length; ++i) {
        const header = object[i];
        if (header.length !== 2) {
          throw new TypeError(
            `Invalid header: length must be 2, but is ${header.length}`,
          );
        }
        appendHeader(headers, header[0], header[1]);
      }
    } else {
      for (const key in object) {
        if (!ObjectHasOwn(object, key)) continue;
        appendHeader(headers, key, object[key]);
      }
    }
  }

  function parseHeadersInit(value) {
    if (value === undefined || value === null) return [];
    const init = webidl.converters["HeadersInit"](
      value,
      "Failed to execute 'parseHeadersInit'",
      "Argument 1",
    );
    const out = [];
    if (ArrayIsArray(init)) {
      for (let i = 0; i < init.length; ++i) {
        const header = init[i];
        if (header.length !== 2) {
          throw new TypeError(
            `Invalid header: length must be 2, but is ${header.length}`,
          );
        }
        ArrayPrototypePush(out, [
          StringPrototypeToLowerCase(header[0]),
          normalizeHeaderValue(header[1]),
        ]);
      }
    } else {
      for (const key in init) {
        if (!ObjectHasOwn(init, key)) continue;
        ArrayPrototypePush(out, [
          StringPrototypeToLowerCase(key),
          normalizeHeaderValue(init[key]),
        ]);
      }
    }
    return out;
  }

  function cloneHeaderPairs(list) {
    const out = [];
    for (let i = 0; i < list.length; ++i) {
      ArrayPrototypePush(out, [list[i][0], list[i][1]]);
    }
    return out;
  }

  function sortedAndCombined(list) {
    const names = [];
    for (let i = 0; i < list.length; ++i) {
      const n = list[i][0];
      if (!ArrayPrototypeIncludes(names, n)) {
        ArrayPrototypePush(names, n);
      }
    }
    ArrayPrototypeSort(names);

    const out = [];
    for (let ni = 0; ni < names.length; ++ni) {
      const name = names[ni];
      if (name === "set-cookie") {
        for (let i = 0; i < list.length; ++i) {
          if (list[i][0] === "set-cookie") {
            ArrayPrototypePush(out, [name, list[i][1]]);
          }
        }
      } else {
        let combined = null;
        for (let i = 0; i < list.length; ++i) {
          if (list[i][0] === name) {
            combined = combined === null
              ? list[i][1]
              : combined + ", " + list[i][1];
          }
        }
        ArrayPrototypePush(out, [name, combined]);
      }
    }
    return out;
  }

  // --- Headers class -------------------------------------------------------

  class Headers {
    [_list] = [];
    [_guard] = "none";
    [_iterableHeadersCache] = undefined;

    get [_iterableHeaders]() {
      const list = this[_list];
      if (
        this[_guard] === "immutable" &&
        this[_iterableHeadersCache] !== undefined
      ) {
        return this[_iterableHeadersCache];
      }
      const seenHeaders = { __proto__: null };
      const entries = [];
      for (let i = 0; i < list.length; ++i) {
        const entry = list[i];
        const name = entry[0];
        const value = entry[1];
        if (name === "set-cookie") {
          ArrayPrototypePush(entries, [name, value]);
        } else {
          const seenHeaderIndex = seenHeaders[name];
          if (seenHeaderIndex !== undefined) {
            const entryValue = entries[seenHeaderIndex][1];
            entries[seenHeaderIndex][1] = entryValue.length > 0
              ? entryValue + "\x2C\x20" + value
              : value;
          } else {
            seenHeaders[name] = entries.length;
            ArrayPrototypePush(entries, [name, value]);
          }
        }
      }
      ArrayPrototypeSort(
        entries,
        (a, b) => {
          const akey = a[0];
          const bkey = b[0];
          if (akey > bkey) return 1;
          if (akey < bkey) return -1;
          return 0;
        },
      );
      this[_iterableHeadersCache] = entries;
      return entries;
    }

    /** @param {HeadersInit} [init] */
    constructor(init = undefined) {
      if (init === webidl.brand) {
        this[webidl.brand] = webidl.brand;
        return;
      }
      const prefix = "Failed to construct 'Headers'";
      this[webidl.brand] = webidl.brand;
      if (init !== undefined) {
        init = webidl.converters["HeadersInit"](init, prefix, "Argument 1");
        fillHeaders(this, init);
      }
    }

    append(name, value) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'append' on 'Headers'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      name = webidl.converters["ByteString"](name, prefix, "Argument 1");
      value = webidl.converters["ByteString"](value, prefix, "Argument 2");
      appendHeader(this, name, value);
    }

    delete(name) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'delete' on 'Headers'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      name = webidl.converters["ByteString"](name, prefix, "Argument 1");
      deleteHeader(this, name);
    }

    get(name) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'get' on 'Headers'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      name = webidl.converters["ByteString"](name, prefix, "Argument 1");
      if (!checkHeaderNameForHttpTokenCodePoint(name)) {
        throw new TypeError(`Invalid header name: "${name}"`);
      }
      return getHeader(this[_list], name);
    }

    getSetCookie() {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const list = this[_list];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i][0] === "set-cookie") ArrayPrototypePush(out, list[i][1]);
      }
      return out;
    }

    has(name) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'has' on 'Headers'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      name = webidl.converters["ByteString"](name, prefix, "Argument 1");
      if (!checkHeaderNameForHttpTokenCodePoint(name)) {
        throw new TypeError(`Invalid header name: "${name}"`);
      }
      const lowerName = StringPrototypeToLowerCase(name);
      const list = this[_list];
      for (let i = 0; i < list.length; i++) {
        if (list[i][0] === lowerName) return true;
      }
      return false;
    }

    set(name, value) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'set' on 'Headers'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      name = webidl.converters["ByteString"](name, prefix, "Argument 1");
      value = webidl.converters["ByteString"](value, prefix, "Argument 2");
      setHeader(this, name, value);
    }
  }

  ObjectDefineProperty(Headers.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "Headers",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const HeadersPrototype = Headers.prototype;

  webidl.mixinPairIterable("Headers", Headers, _iterableHeaders, 0, 1);

  // WebIDL `HeadersInit` union: `sequence<sequence<ByteString>>` or
  // `record<ByteString, ByteString>` (a `Headers` instance is iterable, so it
  // is handled by the sequence branch). The sequence branch is tried first so
  // that overload resolution probes `Symbol.iterator` before the record
  // branch probes `ownKeys`, matching the proxy-trap order asserted by WPT.
  webidl.converters["HeadersInit"] = function (V, prefix, context, opts) {
    try {
      return webidl.converters["sequence<sequence<ByteString>>"](
        V,
        prefix,
        context,
        opts,
      );
    } catch {
      return webidl.converters["record<ByteString, ByteString>"](
        V,
        prefix,
        context,
        opts,
      );
    }
  };

  // --- Internal factories --------------------------------------------------

  function createHeaders(pairs, guard = "none") {
    const h = new Headers(webidl.brand);
    h[_list] = pairs;
    h[_guard] = guard;
    return h;
  }

  function getHeaderList(headers) {
    return headers[_list];
  }

  function guardFromHeaders(headers) {
    return headers[_guard];
  }

  // --- Install as non-enumerable global -----------------------------------

  ObjectDefineProperty(globalThis, "Headers", {
    __proto__: null,
    value: Headers,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  globalThis.__bootstrap.headers = {
    createHeaders,
    getHeaderList,
    guardFromHeaders,
    cloneHeaderPairs,
    parseHeadersInit,
  };
})(globalThis);
