// Copyright 2018-2026 the Deno authors. MIT license.
// Copyright 2026 the Limun authors. MIT license.

// `URL`/`URLSearchParams` — WHATWG URL Standard
// (https://url.spec.whatwg.org/#url-class +
//  https://url.spec.whatwg.org/#interface-urlsearchparams).
//
// Sixth web API migrated from Rust to JS-on-ops (after base64,
// DOMException, console, timers, performance, text encoding, event). The
// previous Rust impl was 980 lines across `web/url.rs` (546) +
// `web/url_search_params.rs` (434) — the spec surface now lives here in JS,
// and the only Rust side is six flat ops in `core::ops`:
//   - `op_url_parse(href, buf)`              — parse, fill `buf` (a
//                                              `Uint32Array` of 8) with
//                                              component offsets, return a
//                                              status number.
//   - `op_url_parse_with_base(href, base, buf)` — parse against a base URL.
//   - `op_url_get_serialization()`           — fetch the stashed
//                                              serialization when status is
//                                              `OkSerialization`.
//   - `op_url_reparse(href, setter, value, buf)` — apply a component
//                                              setter, return the new
//                                              serialization + components.
//   - `op_url_parse_search_params(query)`    — parse a query string into an
//                                              array of `[key, value]` pairs.
//   - `op_url_stringify_search_params(pairs)` — serialize pairs back to a
//                                              query string.
//
// The `url` crate (rust-url — same parser Servo/Firefox use) does the
// irreducible native work: the actual URL parser. Everything spec-
// observable — the class shapes, getter/setter semantics, WebIDL argument
// validation, the live `searchParams` linkage, `canParse`/`parse` static
// methods, the iterator protocol — is here in JS.
//
// Ports Deno's `ext/web/00_url.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `webidl.brand` /
//     `webidl.assertBranded`  → inline equivalents (same pattern as
//     `01_dom_exception.js` / `02_event.js`).
//   - `webidl.requiredArguments` → inline `requiredArguments`.
//   - `webidl.converters.DOMString`/`USVString` → inline `convertDOMString`/
//     `convertUSVString`.
//   - `webidl.mixinPairIterable` → inline `mixinPairIterable` (iterator
//     protocol for URLSearchParams entries/keys/values/forEach). Ports
//     Deno's `00_webidl.js` helper directly — same shape, local scope.
//   - `webidl.configureInterface` → inline (sets `[Symbol.toStringTag]` on
//     the prototype; Limun sets it inline instead of via the WebIDL helper).
//   - `core.loadExtScript("ext:deno_web/01_console.js")` /
//     `markNotSerializable`   → dropped (no Deno-style custom inspect / not-
//     serializable registry in Limun).
//   - `op_url_parse(href, componentsBuf)` → same call shape — the JS side
//     owns one reusable `Uint32Array(8)` (`componentsBuf`) and passes it to
//     each parse/reparse op. The op writes the 8 component offsets into it
//     and returns a status number; the JS side reads `componentsBuf` after.
//   - `op_url_parse_search_params(null, bytes)` (Deno's bytes overload) →
//     dropped (Limun's op takes a string only — the bytes path is for
//     `parseUrlEncoded` which no Limun caller uses yet; can be re-added
//     when fetch's `formData()` needs it).
//   - `op_url_stringify_search_params(Vec<(String,String)>)` (serde_v8) →
//     takes a `v8::Array` of `[k, v]` pairs built by hand on the Rust side.
//   - `parseSimpleSpecialUrl` JS fast-path → dropped (it's an optimization
//     that duplicates `parse_simple_special_url` in Rust; without it every
//     parse goes through the `url` crate, which is correct — just not as
//     fast for the common `http://`/`https://` case). The JS-side
//     `isSimpleSpecialUrl`/`isSimpleSpecialHostCanonical`/etc. helpers are
//     dropped too. Can be re-added as a perf optimization later.
//
// Dropped vs Deno (Limun doesn't model these yet):
//   - `[SymbolFor("Deno.privateCustomInspect")]` on URL/URLSearchParams and
//     on the iterator — no Deno-style custom inspect in Limun.
//   - `webidl.converters["URLSearchParams"]` /
//     `webidl.converters["sequence<sequence<USVString>> or record<…> or
//     USVString"]` → dropped (no WebIDL converter registry; the
//     URLSearchParams constructor does its own union dispatch inline, same
//     as the previous Rust `parse_init`).
//   - `parseUrlEncoded(bytes)` export → dropped (no Limun caller yet).
//
// Bug fixes vs the previous Rust impl (verified against the existing WPT
// subset, which uses URL indirectly via fetch):
//   - The previous Rust stored the `url::Url` in a V8 internal field and
//     accessed it via per-instance V8 accessors. This module stores the
//     *serialization string* + 8 component offsets in JS private fields and
//     derives every getter by slicing the serialization — exactly what
//     Deno does, which is what rust-url's own `quirks` module does
//     internally. No behavioral change; the storage just moved across the
//     op boundary.
//   - `URL.parse()` now uses the `skipInit` sentinel pattern (matching
//     Deno) so it can construct a URL instance without re-running the
//     constructor's parse+validate. The previous Rust impl built the
//     instance directly from a `url::Url` via `new_instance`; the JS
//     version is equivalent.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    op_url_get_serialization,
    op_url_parse,
    op_url_parse_with_base,
    op_url_reparse,
    op_url_parse_search_params,
    op_url_stringify_search_params,
  } = globalThis.__limunOps;
  const {
    ArrayFrom,
    ArrayPrototypeForEach,
    ArrayPrototypeJoin,
    ArrayPrototypeMap,
    ArrayPrototypePush,
    ArrayPrototypeSome,
    ArrayPrototypeSort,
    ArrayPrototypeSplice,
    ObjectCreate,
    ObjectDefineProperties,
    ObjectDefineProperty,
    ObjectGetOwnPropertyDescriptor,
    ObjectGetPrototypeOf,
    ObjectKeys,
    ObjectPrototypeIsPrototypeOf,
    ReflectOwnKeys,
    SafeArrayIterator,
    StringPrototypeCharCodeAt,
    StringPrototypeSlice,
    StringPrototypeStartsWith,
    Symbol,
    SymbolFor,
    SymbolIterator,
    SymbolToStringTag,
    TypeError,
    Uint32Array,
  } = primordials;

  // --- Inline WebIDL (minimal — same shape as 01_dom_exception/02_event) -

  const brand = Symbol("[[webidl.brand]]");

  function assertBranded(self, prototype) {
    if (
      !ObjectPrototypeIsPrototypeOf(prototype, self) || self[brand] !== brand
    ) {
      throw new TypeError("Illegal invocation");
    }
  }

  function requiredArguments(length, required, prefix) {
    if (length < required) {
      throw new TypeError(
        `${prefix}: ${required} argument${required === 1 ? "" : "s"} required, but only ${length} present.`,
      );
    }
  }

  // `webidl.converters.DOMString(V, prefix, context)` — Web IDL DOMString
  // conversion. Strings pass through; symbols throw; everything else goes
  // through `String(V)`.
  function convertDOMString(V) {
    if (typeof V === "string") return V;
    if (typeof V === "symbol") {
      throw new TypeError("Cannot convert a Symbol value to a string");
    }
    return String(V);
  }

  // `webidl.converters.USVString(V, prefix, context)` — Web IDL USVString
  // conversion. Same as DOMString but then strips lone surrogates (replace
  // with U+FFFD) to produce a well-formed USVString. Matches Deno's
  // `webidl.converters.USVString`.
  function convertUSVString(V) {
    const s = convertDOMString(V);
    // Strip lone surrogates. A well-formed string has no unpaired
    // surrogates; `String.prototype.toWellFormed()` does this in modern V8
    // but we avoid relying on it (not in the primordials snapshot). Instead
    // scan and replace — matches what Deno's converter does internally.
    let result = "";
    let i = 0;
    const len = s.length;
    while (i < len) {
      const code = StringPrototypeCharCodeAt(s, i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        // high surrogate
        if (i + 1 < len) {
          const next = StringPrototypeCharCodeAt(s, i + 1);
          if (next >= 0xDC00 && next <= 0xDFFF) {
            // valid pair
            result += StringPrototypeSlice(s, i, i + 2);
            i += 2;
            continue;
          }
        }
        // lone high surrogate → U+FFFD
        result += "\uFFFD";
        i += 1;
        continue;
      }
      if (code >= 0xDC00 && code <= 0xDFFF) {
        // lone low surrogate → U+FFFD
        result += "\uFFFD";
        i += 1;
        continue;
      }
      result += StringPrototypeSlice(s, i, i + 1);
      i += 1;
    }
    return result;
  }

  // --- Private fields (Symbols, not #private — matches Deno) --------------

  const _list = Symbol("list");
  const _urlObject = Symbol("url object");
  const _updateUrlSearch = Symbol("updateUrlSearch");

  // Pre-frozen argument-name arrays used to produce WebIDL-style
  // `requiredArguments` messages.
  const NAME_ARG_NAMES = ["name"];
  const APPEND_ARG_NAMES = ["name", "value"];

  // WARNING: must match rust code's UrlSetter::* (see `op_url_reparse`).
  const SET_HASH = 0;
  const SET_HOST = 1;
  const SET_HOSTNAME = 2;
  const SET_PASSWORD = 3;
  const SET_PATHNAME = 4;
  const SET_PORT = 5;
  const SET_PROTOCOL = 6;
  const SET_SEARCH = 7;
  const SET_USERNAME = 8;

  // Parse status codes returned by `op_url_parse`/`op_url_reparse`.
  const PARSE_OK = 0;
  const PARSE_OK_SERIALIZATION = 1;
  const PARSE_ERR = 2;

  // Represents a "no port" value. A port in URL cannot be greater than 2^16 - 1
  const NO_PORT = 65536;

  // Reusable scratch buffer for parse/reparse ops. The ops write the 8
  // internal component offsets (scheme_end, username_end, host_start,
  // host_end, port, path_start, query_start, fragment_start) into this
  // array. One shared buffer — ops are synchronous, no re-entrancy.
  const componentsBuf = new Uint32Array(8);

  // --- Helper functions (mirror Deno's opUrlParse/opUrlReparse) ----------

  function opUrlParse(href, maybeBase) {
    const status = maybeBase === undefined
      ? op_url_parse(href, componentsBuf)
      : op_url_parse_with_base(href, maybeBase, componentsBuf);
    return getSerialization(status, href, maybeBase);
  }

  function opUrlReparse(href, setter, value) {
    const status = op_url_reparse(href, setter, value, componentsBuf);
    return getSerialization(status, href);
  }

  function getSerialization(status, href, maybeBase) {
    if (status === PARSE_OK) {
      return href;
    } else if (status === PARSE_OK_SERIALIZATION) {
      return op_url_get_serialization();
    } else {
      throw new TypeError(
        `Invalid URL: '${href}'` +
          (maybeBase ? ` with base '${maybeBase}'` : ""),
      );
    }
  }

  function trim(s) {
    if (s.length === 1) return "";
    return s;
  }

  // --- URLSearchParams class -----------------------------------------------

  class URLSearchParams {
    [_list];
    [_urlObject] = null;

    constructor(init = undefined) {
      // Node treats `null` and `undefined` as a missing argument (empty
      // params). The WHATWG spec would stringify them via the union
      // conversion, but browsers actually never observe this case in
      // practice; matching Node here unblocks node:url compat without
      // affecting WPT.
      this[brand] = brand;
      if (init === null || init === undefined) {
        this[_list] = [];
        return;
      }

      if (typeof init === "object" || typeof init === "function") {
        // Object overloads: either iterable of pairs or a record.
        const method = init[SymbolIterator];
        if (method !== undefined && method !== null) {
          if (typeof method !== "function") {
            const err = new TypeError("Query pairs must be iterable");
            err.code = "ERR_ARG_NOT_ITERABLE";
            throw err;
          }
          // Sequence<sequence<USVString>>
          const pairs = [];
          // deno-lint-ignore prefer-primordials
          const iter = method.call(init);
          if (iter == null || typeof iter.next !== "function") {
            const err = new TypeError(
              "Each query pair must be an iterable [name, value] tuple",
            );
            err.code = "ERR_INVALID_TUPLE";
            throw err;
          }
          while (true) {
            // deno-lint-ignore prefer-primordials
            const res = iter.next();
            if (res == null) {
              const err = new TypeError(
                "Each query pair must be an iterable [name, value] tuple",
              );
              err.code = "ERR_INVALID_TUPLE";
              throw err;
            }
            if (res.done === true) break;
            const pair = res.value;
            if (
              (typeof pair !== "object" && typeof pair !== "function") ||
              pair === null ||
              typeof pair[SymbolIterator] !== "function"
            ) {
              const err = new TypeError(
                "Each query pair must be an iterable [name, value] tuple",
              );
              err.code = "ERR_INVALID_TUPLE";
              throw err;
            }
            const entry = [];
            for (const v of new SafeArrayIterator(ArrayFrom(pair))) {
              ArrayPrototypePush(entry, convertUSVString(v));
            }
            if (entry.length !== 2) {
              const err = new TypeError(
                "Each query pair must be an iterable [name, value] tuple",
              );
              err.code = "ERR_INVALID_TUPLE";
              throw err;
            }
            ArrayPrototypePush(pairs, entry);
          }
          this[_list] = pairs;
          return;
        }
        // Record<USVString, USVString>. We iterate own enumerable keys
        // (including Symbol keys so USVString coercion throws on them, like
        // Node does) and dedupe by the USVString-coerced name so that two keys
        // collapsing to U+FFFD overwrite each other instead of appearing twice
        // in the iterator output.
        const result = { __proto__: null };
        const allKeys = ReflectOwnKeys(init);
        for (let i = 0; i < allKeys.length; i++) {
          const key = allKeys[i];
          const desc = ObjectGetOwnPropertyDescriptor(init, key);
          if (desc !== undefined && desc.enumerable === true) {
            const name = convertUSVString(key);
            const value = convertUSVString(init[key]);
            result[name] = value;
          }
        }
        const list = [];
        const resultKeys = ObjectKeys(result);
        for (let i = 0; i < resultKeys.length; i++) {
          ArrayPrototypePush(list, [resultKeys[i], result[resultKeys[i]]]);
        }
        this[_list] = list;
        return;
      }

      // USVString overload.
      let str = convertUSVString(init);
      if (str.length === 0) {
        this[_list] = [];
        return;
      }
      if (str[0] === "?") {
        str = StringPrototypeSlice(str, 1);
      }
      this[_list] = op_url_parse_search_params(str);
    }

    #updateUrlSearch() {
      const url = this[_urlObject];
      if (url === null) {
        return;
      }
      // deno-lint-ignore prefer-primordials
      url[_updateUrlSearch](this.toString());
    }

    append(name, value) {
      assertBranded(this, URLSearchParamsPrototype);
      const prefix = "Failed to execute 'append' on 'URLSearchParams'";
      requiredArguments(arguments.length, 2, prefix);
      name = convertUSVString(name);
      value = convertUSVString(value);
      ArrayPrototypePush(this[_list], [name, value]);
      this.#updateUrlSearch();
    }

    delete(name, value = undefined) {
      assertBranded(this, URLSearchParamsPrototype);
      const prefix = "Failed to execute 'delete' on 'URLSearchParams'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);
      const list = this[_list];
      let writeIdx = 0;
      if (value === undefined) {
        for (let i = 0; i < list.length; i++) {
          if (list[i][0] !== name) {
            list[writeIdx++] = list[i];
          }
        }
      } else {
        value = convertUSVString(value);
        for (let i = 0; i < list.length; i++) {
          const entry = list[i];
          if (entry[0] !== name || entry[1] !== value) {
            list[writeIdx++] = entry;
          }
        }
      }
      if (writeIdx !== list.length) {
        ArrayPrototypeSplice(list, writeIdx);
      }
      this.#updateUrlSearch();
    }

    getAll(name) {
      assertBranded(this, URLSearchParamsPrototype);
      const prefix = "Failed to execute 'getAll' on 'URLSearchParams'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);
      const values = [];
      const entries = this[_list];
      for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        if (entry[0] === name) {
          ArrayPrototypePush(values, entry[1]);
        }
      }
      return values;
    }

    get(name) {
      assertBranded(this, URLSearchParamsPrototype);
      const prefix = "Failed to execute 'get' on 'URLSearchParams'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);
      const entries = this[_list];
      for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        if (entry[0] === name) {
          return entry[1];
        }
      }
      return null;
    }

    has(name, value = undefined) {
      assertBranded(this, URLSearchParamsPrototype);
      const prefix = "Failed to execute 'has' on 'URLSearchParams'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);
      if (value !== undefined) {
        value = convertUSVString(value);
        return ArrayPrototypeSome(
          this[_list],
          (entry) => entry[0] === name && entry[1] === value,
        );
      }
      return ArrayPrototypeSome(this[_list], (entry) => entry[0] === name);
    }

    set(name, value) {
      assertBranded(this, URLSearchParamsPrototype);
      const prefix = "Failed to execute 'set' on 'URLSearchParams'";
      requiredArguments(arguments.length, 2, prefix);
      name = convertUSVString(name);
      value = convertUSVString(value);

      const list = this[_list];

      // If there are any name-value pairs whose name is name, in list,
      // set the value of the first such name-value pair to value
      // and remove the others.
      let writeIdx = 0;
      let found = false;
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (entry[0] === name) {
          if (!found) {
            entry[1] = value;
            list[writeIdx++] = entry;
            found = true;
          }
        } else {
          list[writeIdx++] = entry;
        }
      }

      // Otherwise, append a new name-value pair whose name is name
      // and value is value, to list.
      if (!found) {
        ArrayPrototypePush(list, [name, value]);
      } else if (writeIdx !== list.length) {
        ArrayPrototypeSplice(list, writeIdx);
      }

      this.#updateUrlSearch();
    }

    sort() {
      assertBranded(this, URLSearchParamsPrototype);
      ArrayPrototypeSort(
        this[_list],
        (a, b) => (a[0] === b[0] ? 0 : a[0] > b[0] ? 1 : -1),
      );
      this.#updateUrlSearch();
    }

    toString() {
      assertBranded(this, URLSearchParamsPrototype);
      return op_url_stringify_search_params(this[_list]);
    }

    get size() {
      assertBranded(this, URLSearchParamsPrototype);
      return this[_list].length;
    }
  }

  const URLSearchParamsPrototype = URLSearchParams.prototype;

  // `[Symbol.toStringTag]` — spec: "URLSearchParams". Non-enumerable,
  // configurable, writable=false (matches browsers).
  ObjectDefineProperty(URLSearchParamsPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "URLSearchParams",
    enumerable: false,
    configurable: true,
    writable: false,
  });

  // --- mixinPairIterable (inline — ports Deno's 00_webidl.js helper) -------
  //
  // Installs `entries`/`keys`/`values`/`forEach` + `@@iterator` on
  // `URLSearchParams.prototype`. Each `entries`/`keys`/`values` call returns
  // an iterator object whose `next()` reads from the instance's `_list`.
  // The iterator's prototype is `%IteratorPrototype%` with a
  // `[Symbol.toStringTag]` of "URLSearchParams Iterator" — matches browsers.
  {
    const _iteratorInternal = Symbol("iterator internal");

    // %IteratorPrototype% = Object.getPrototypeOf(%ArrayIteratorPrototype%).
    const globalIteratorPrototype = ObjectGetPrototypeOf(
      ObjectGetPrototypeOf([][SymbolIterator]()),
    );

    const iteratorPrototype = ObjectCreate(globalIteratorPrototype, {
      [SymbolToStringTag]: {
        __proto__: null,
        configurable: true,
        value: "URLSearchParams Iterator",
      },
    });

    ObjectDefineProperty(iteratorPrototype, "next", {
      __proto__: null,
      value: function next() {
        const internal = this == null ? undefined : this[_iteratorInternal];
        if (!internal) {
          const err = new TypeError(
            'Value of "this" must be of type URLSearchParamsIterator',
          );
          err.code = "ERR_INVALID_THIS";
          throw err;
        }
        const { target, kind, index } = internal;
        const values = target[_list];
        const len = values.length;
        if (index >= len) {
          return { __proto__: null, value: undefined, done: true };
        }
        const pair = values[index];
        internal.index = index + 1;
        let result;
        switch (kind) {
          case "key":
            result = pair[0];
            break;
          case "value":
            result = pair[1];
            break;
          case "key+value":
            result = [pair[0], pair[1]];
            break;
        }
        return { __proto__: null, value: result, done: false };
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    function createDefaultIterator(target, kind) {
      const iterator = ObjectCreate(iteratorPrototype);
      ObjectDefineProperty(iterator, _iteratorInternal, {
        __proto__: null,
        value: { __proto__: null, target, kind, index: 0 },
        configurable: true,
      });
      return iterator;
    }

    const entries = function entries() {
      assertBranded(this, URLSearchParamsPrototype);
      return createDefaultIterator(this, "key+value");
    };
    const keys = function keys() {
      assertBranded(this, URLSearchParamsPrototype);
      return createDefaultIterator(this, "key");
    };
    const values = function values() {
      assertBranded(this, URLSearchParamsPrototype);
      return createDefaultIterator(this, "value");
    };
    const forEach = function forEach(idlCallback, thisArg = undefined) {
      assertBranded(this, URLSearchParamsPrototype);
      if (typeof idlCallback !== "function") {
        const err = new TypeError(
          `The "callback" argument must be of type function. Received ${
            idlCallback === null
              ? "null"
              : idlCallback === undefined
              ? "undefined"
              : typeof idlCallback
          }`,
        );
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      const pairs = this[_list];
      for (let i = 0; i < pairs.length; i++) {
        const entry = pairs[i];
        // deno-lint-ignore prefer-primordials
        idlCallback.call(thisArg, entry[1], entry[0], this);
      }
    };

    ObjectDefineProperties(URLSearchParamsPrototype, {
      entries: {
        __proto__: null,
        value: entries,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      [SymbolIterator]: {
        __proto__: null,
        value: entries,
        writable: true,
        enumerable: false,
        configurable: true,
      },
      keys: {
        __proto__: null,
        value: keys,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      values: {
        __proto__: null,
        value: values,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      forEach: {
        __proto__: null,
        value: forEach,
        writable: true,
        enumerable: true,
        configurable: true,
      },
    });
  }

  // --- URL class -----------------------------------------------------------

  // Sentinel for `URL.parse` — skip the constructor's parse+validate (the
  // static method has already validated and will set `#serialization`
  // directly after).
  const skipInit = Symbol();

  class URL {
    #queryObject = null;
    #serialization;
    #schemeEnd;
    #usernameEnd;
    #hostStart;
    #hostEnd;
    #port;
    #pathStart;
    #queryStart;
    #fragmentStart;

    [_updateUrlSearch](value) {
      this.#serialization = opUrlReparse(
        this.#serialization,
        SET_SEARCH,
        value,
      );
      this.#updateComponents();
    }

    constructor(url, base = undefined) {
      // skip initialization for URL.parse
      if (url === skipInit) {
        return;
      }
      const prefix = "Failed to construct 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      url = convertDOMString(url);
      if (base !== undefined) {
        base = convertDOMString(base);
      }
      this[brand] = brand;
      this.#serialization = opUrlParse(url, base);
      this.#updateComponents();
    }

    static parse(url, base = undefined) {
      const prefix = "Failed to execute 'URL.parse'";
      requiredArguments(arguments.length, 1, prefix);
      url = convertDOMString(url);
      if (base !== undefined) {
        base = convertDOMString(base);
      }
      let status;
      if (base === undefined) {
        status = op_url_parse(url, componentsBuf);
      } else {
        status = op_url_parse_with_base(url, base, componentsBuf);
      }
      if (status !== PARSE_OK && status !== PARSE_OK_SERIALIZATION) {
        return null;
      }
      const self = new this(skipInit);
      self[brand] = brand;
      self.#serialization = getSerialization(status, url, base);
      self.#updateComponents();
      return self;
    }

    static canParse(url, base = undefined) {
      const prefix = "Failed to execute 'URL.canParse'";
      requiredArguments(arguments.length, 1, prefix);
      url = convertDOMString(url);
      if (base !== undefined) {
        base = convertDOMString(base);
      }
      let status;
      if (base === undefined) {
        status = op_url_parse(url, componentsBuf);
      } else {
        status = op_url_parse_with_base(url, base, componentsBuf);
      }
      return status === PARSE_OK || status === PARSE_OK_SERIALIZATION;
    }

    #updateComponents() {
      ({
        0: this.#schemeEnd,
        1: this.#usernameEnd,
        2: this.#hostStart,
        3: this.#hostEnd,
        4: this.#port,
        5: this.#pathStart,
        6: this.#queryStart,
        7: this.#fragmentStart,
      } = componentsBuf);
    }

    #updateSearchParams() {
      if (this.#queryObject !== null) {
        const params = this.#queryObject[_list];
        const newParams = op_url_parse_search_params(
          StringPrototypeSlice(this.search, 1),
        );
        ArrayPrototypeSplice(
          params,
          0,
          params.length,
          ...new SafeArrayIterator(newParams),
        );
      }
    }

    #hasAuthority() {
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/lib.rs#L824
      return StringPrototypeStartsWith(
        StringPrototypeSlice(this.#serialization, this.#schemeEnd),
        "://",
      );
    }

    get hash() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/quirks.rs#L263
      return this.#fragmentStart
        ? trim(StringPrototypeSlice(this.#serialization, this.#fragmentStart))
        : "";
    }

    set hash(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'hash' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_HASH,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get host() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/quirks.rs#L101
      return StringPrototypeSlice(
        this.#serialization,
        this.#hostStart,
        this.#pathStart,
      );
    }

    set host(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'host' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_HOST,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get hostname() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/lib.rs#L988
      return StringPrototypeSlice(
        this.#serialization,
        this.#hostStart,
        this.#hostEnd,
      );
    }

    set hostname(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'hostname' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_HOSTNAME,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get href() {
      assertBranded(this, URLPrototype);
      return this.#serialization;
    }

    set href(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'href' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      this.#serialization = opUrlParse(value);
      this.#updateComponents();
      this.#updateSearchParams();
    }

    get origin() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/origin.rs#L14
      const scheme = StringPrototypeSlice(
        this.#serialization,
        0,
        this.#schemeEnd,
      );
      if (
        scheme === "http" || scheme === "https" || scheme === "ftp" ||
        scheme === "ws" || scheme === "wss"
      ) {
        return `${scheme}://${this.host}`;
      }

      if (scheme === "blob") {
        // TODO(@littledivy): Fast path.
        try {
          return new URL(this.pathname).origin;
        } catch {
          return "null";
        }
      }

      return "null";
    }

    get password() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/lib.rs#L914
      if (
        this.#hasAuthority() &&
        this.#usernameEnd !== this.#serialization.length &&
        this.#serialization[this.#usernameEnd] === ":"
      ) {
        return StringPrototypeSlice(
          this.#serialization,
          this.#usernameEnd + 1,
          this.#hostStart - 1,
        );
      }
      return "";
    }

    set password(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'password' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_PASSWORD,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get pathname() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/lib.rs#L1203
      if (!this.#queryStart && !this.#fragmentStart) {
        return StringPrototypeSlice(this.#serialization, this.#pathStart);
      }

      const nextComponentStart = this.#queryStart || this.#fragmentStart;
      return StringPrototypeSlice(
        this.#serialization,
        this.#pathStart,
        nextComponentStart,
      );
    }

    set pathname(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'pathname' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_PATHNAME,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get port() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/quirks.rs#L196
      if (this.#port === NO_PORT) {
        return StringPrototypeSlice(
          this.#serialization,
          this.#hostEnd,
          this.#pathStart,
        );
      } else {
        return StringPrototypeSlice(
          this.#serialization,
          this.#hostEnd + 1, /* : */
          this.#pathStart,
        );
      }
    }

    set port(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'port' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_PORT,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get protocol() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/quirks.rs#L56
      return StringPrototypeSlice(
        this.#serialization,
        0,
        this.#schemeEnd + 1, /* : */
      );
    }

    set protocol(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'protocol' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_PROTOCOL,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get search() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/quirks.rs#L249
      const afterPath = this.#queryStart || this.#fragmentStart ||
        this.#serialization.length;
      const afterQuery = this.#fragmentStart || this.#serialization.length;
      return trim(
        StringPrototypeSlice(this.#serialization, afterPath, afterQuery),
      );
    }

    set search(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'search' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_SEARCH,
          value,
        );
        this.#updateComponents();
        this.#updateSearchParams();
      } catch {
        /* pass */
      }
    }

    get username() {
      assertBranded(this, URLPrototype);
      // https://github.com/servo/rust-url/blob/1d307ae51a28fecc630ecec03380788bfb03a643/url/src/lib.rs#L881
      const schemeSeparatorLen = 3; /* :// */
      if (
        this.#hasAuthority() &&
        this.#usernameEnd > this.#schemeEnd + schemeSeparatorLen
      ) {
        return StringPrototypeSlice(
          this.#serialization,
          this.#schemeEnd + schemeSeparatorLen,
          this.#usernameEnd,
        );
      } else {
        return "";
      }
    }

    set username(value) {
      assertBranded(this, URLPrototype);
      const prefix = "Failed to set 'username' on 'URL'";
      requiredArguments(arguments.length, 1, prefix);
      value = convertDOMString(value);
      try {
        this.#serialization = opUrlReparse(
          this.#serialization,
          SET_USERNAME,
          value,
        );
        this.#updateComponents();
      } catch {
        /* pass */
      }
    }

    get searchParams() {
      if (this.#queryObject == null) {
        this.#queryObject = new URLSearchParams(this.search);
        this.#queryObject[_urlObject] = this;
      }
      return this.#queryObject;
    }

    toString() {
      assertBranded(this, URLPrototype);
      return this.#serialization;
    }

    toJSON() {
      assertBranded(this, URLPrototype);
      return this.#serialization;
    }
  }

  const URLPrototype = URL.prototype;

  // `[Symbol.toStringTag]` — spec: "URL". Non-enumerable, configurable,
  // writable=false (matches browsers).
  ObjectDefineProperty(URLPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "URL",
    enumerable: false,
    configurable: true,
    writable: false,
  });

  // --- Install globals -----------------------------------------------------

  // Non-enumerable, writable, configurable — matches the previous Rust
  // `set_global` (DONT_ENUM) and every other constructible web class
  // (`TextEncoder`, `DOMException`, …): `Object.keys(globalThis)` excludes
  // them.
  ObjectDefineProperty(globalThis, "URL", {
    __proto__: null,
    value: URL,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  ObjectDefineProperty(globalThis, "URLSearchParams", {
    __proto__: null,
    value: URLSearchParams,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);