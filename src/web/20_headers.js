// Copyright 2026 the Limun authors. MIT license.

// `Headers` — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#headers-class).
//
// Migrated from Rust (`web::fetch::headers.rs`, 334 lines) to JS-on-ops.
// No op needed at all — every operation here is pure JS (array
// filter/push/splice), which is why this module doesn't touch
// `__limunOps`.
//
// Simplified vs. spec (matches the previous Rust impl exactly — see
// `TODO.md`'s "No header-guard / forbidden-header enforcement" note,
// an intentional decision, not an oversight): names are lowercased on
// the way in and there's no HTTP-token/value validation, no guard
// enforcement (`immutable`/`request`/`response` guards aren't tracked
// at all — a CLI runtime has no privilege boundary to protect), no
// `ByteString` WebIDL conversion (plain `String()` coercion instead).
// Duplicate names are kept in the backing list (`append`) and combined
// on the way out: `get(name)` joins every matching value with `", "`,
// and iteration yields one entry per name sorted lexicographically —
// except `set-cookie`, which is never combined (`getSetCookie()` is the
// dedicated escape hatch).
//
// Ports Deno's `ext/fetch/20_headers.js`, simplified to match the
// existing Rust behavior rather than full spec strictness:
//   - `__bootstrap` / `core.ops`   → not used (pure JS, no op).
//   - `webidl.brand` /
//     `webidl.assertBranded` /
//     `webidl.requiredArguments` → `globalThis.__bootstrap.webidl`
//     (shared `ext:limun/00_webidl.js`).
//   - `webidl.converters.*`        → dropped; plain `String()` coercion.
//   - `webidl.mixinPairIterable`   → inline iterator wiring, `10_form_data.js`-style
//     (a snapshot array's own `[Symbol.iterator]()` — correct `{value,
//     done}` shape for free).
//   - guard (`_guard`, `_headerListGetter`/`_headerGet`/`_headerTarget`
//     lazy-header-list machinery) → dropped (no guard enforcement, no
//     lazy target — the backing list is always a plain owned array).
//   - `checkHeaderNameForHttpTokenCodePoint` / `checkForInvalidValueChars`
//     → dropped (matches the previous Rust: no validation at all).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no
//     Deno-style custom inspect in Limun yet).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    ArrayIsArray,
    ArrayPrototypeIncludes,
    ArrayPrototypePush,
    ArrayPrototypeSort,
    ArrayPrototypeSplice,
    FunctionPrototypeCall,
    ObjectHasOwn,
    ObjectPrototypeIsPrototypeOf,
    StringPrototypeToLowerCase,
    Symbol,
    SymbolIterator,
    SymbolToStringTag,
    ObjectDefineProperty,
    TypeError,
  } = primordials;

  // --- Private fields ------------------------------------------------------

  // `[string, string][]`, name already lowercased. `append` always
  // pushes a new entry (values are never combined at storage time);
  // `get`/iteration combine on read (see `sortedAndCombined`).
  const _list = Symbol("header list");

  // --- HeadersInit parsing -------------------------------------------------

  /** Parse anything spec-legal as a `HeadersInit`: a sequence of
   * `[name, value]` pairs (a real `Array`), a record (plain object),
   * or another `Headers` instance. Shared with `Request`/`Response`'s
   * `headers` init option and `fetch()`'s `init.headers`. Matches the
   * previous Rust `parse_value`: only true JS Arrays take the sequence
   * path (no general-iterable support), and record keys are read via
   * `for...in` + own-property check (skips inherited enumerable keys). */
  function parseHeadersInit(value) {
    if (value === undefined || value === null) return [];
    if (ArrayIsArray(value)) {
      const pairs = [];
      for (let i = 0; i < value.length; ++i) {
        const entry = value[i];
        const k = entry?.[0];
        const v = entry?.[1];
        ArrayPrototypePush(pairs, [
          StringPrototypeToLowerCase(String(k)),
          String(v),
        ]);
      }
      return pairs;
    }
    if (typeof value === "object") {
      if (ObjectPrototypeIsPrototypeOf(HeadersPrototype, value)) {
        return cloneHeaderPairs(value[_list]);
      }
      const pairs = [];
      for (const key in value) {
        if (!ObjectHasOwn(value, key)) continue;
        ArrayPrototypePush(pairs, [
          StringPrototypeToLowerCase(String(key)),
          String(value[key]),
        ]);
      }
      return pairs;
    }
    return [];
  }

  /** Deep-copy a `[name, value][]` list (each pair is its own array —
   * copy those too so mutating the clone never aliases the source). */
  function cloneHeaderPairs(list) {
    const out = [];
    for (let i = 0; i < list.length; ++i) {
      ArrayPrototypePush(out, [list[i][0], list[i][1]]);
    }
    return out;
  }

  /** The spec's "sort and combine" for iteration: entries sorted by
   * name, with same-named values joined by `", "` — except
   * `set-cookie`, whose values are each emitted as their own entry. */
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

    /** @param {HeadersInit} [init] */
    constructor(init = undefined) {
      this[webidl.brand] = webidl.brand;
      this[_list] = parseHeadersInit(init);
    }

    append(name, value) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'append' on 'Headers'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      name = StringPrototypeToLowerCase(String(name));
      value = String(value);
      ArrayPrototypePush(this[_list], [name, value]);
    }

    delete(name) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'delete' on 'Headers'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      name = StringPrototypeToLowerCase(String(name));
      const list = this[_list];
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i][0] !== name) list[w++] = list[i];
      }
      if (w !== list.length) ArrayPrototypeSplice(list, w);
    }

    /** `get(name)` — the *combined* value: every entry with this name,
     * in insertion order, joined with `", "`. `null` if there are none. */
    get(name) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'get' on 'Headers'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      name = StringPrototypeToLowerCase(String(name));
      const list = this[_list];
      let combined = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i][0] === name) {
          combined = combined === null
            ? list[i][1]
            : combined + ", " + list[i][1];
        }
      }
      return combined;
    }

    /** `getSetCookie()` — every `set-cookie` value, in insertion
     * order, as an array. The one header that must never be combined. */
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
      name = StringPrototypeToLowerCase(String(name));
      const list = this[_list];
      for (let i = 0; i < list.length; i++) {
        if (list[i][0] === name) return true;
      }
      return false;
    }

    set(name, value) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'set' on 'Headers'";
      webidl.requiredArguments(arguments.length, 2, prefix);
      name = StringPrototypeToLowerCase(String(name));
      value = String(value);
      const list = this[_list];
      let w = 0;
      let added = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i][0] === name) {
          if (!added) {
            list[w++] = [name, value];
            added = true;
          }
        } else {
          list[w++] = list[i];
        }
      }
      if (!added) {
        ArrayPrototypePush(list, [name, value]);
      } else if (w !== list.length) {
        ArrayPrototypeSplice(list, w);
      }
    }

    forEach(callback, thisArg) {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      const prefix = "Failed to execute 'forEach' on 'Headers'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      if (typeof callback !== "function") {
        throw new TypeError(`${prefix}: callback must be a function`);
      }
      const pairs = sortedAndCombined(this[_list]);
      for (let i = 0; i < pairs.length; ++i) {
        FunctionPrototypeCall(callback, thisArg, pairs[i][1], pairs[i][0], this);
      }
    }

    entries() {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      return pairIterator(this[_list], "entries");
    }

    keys() {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      return pairIterator(this[_list], "keys");
    }

    values() {
      webidl.assertBranded(this, HeadersPrototype, "Headers");
      return pairIterator(this[_list], "values");
    }
  }

  /** `entries()`/`keys()`/`values()`/`[Symbol.iterator]` all return a
   * real `Array Iterator` over a snapshot built from the sorted +
   * combined view — same approach as `10_form_data.js`'s
   * `pairIterator`. */
  function pairIterator(list, mode) {
    const pairs = sortedAndCombined(list);
    const snapshot = [];
    for (let i = 0; i < pairs.length; ++i) {
      if (mode === "keys") {
        ArrayPrototypePush(snapshot, pairs[i][0]);
      } else if (mode === "values") {
        ArrayPrototypePush(snapshot, pairs[i][1]);
      } else {
        ArrayPrototypePush(snapshot, pairs[i]);
      }
    }
    return snapshot[SymbolIterator]();
  }

  ObjectDefineProperty(Headers.prototype, SymbolIterator, {
    __proto__: null,
    value: Headers.prototype.entries,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  ObjectDefineProperty(Headers.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "Headers",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const HeadersPrototype = Headers.prototype;

  // --- Internal factories (consumed by 21_request.js / 22_response.js /
  // 23_fetch.js) ------------------------------------------------------------

  /** Build a `Headers` instance directly from an already-normalized
   * `[name, value][]` list (skips `parseHeadersInit`). Used to mint
   * headers for a `Request`/`Response`/`fetch()` result without
   * round-tripping through `HeadersInit` conversion. */
  function createHeaders(pairs) {
    const h = new Headers();
    h[_list] = pairs;
    return h;
  }

  /** Read the backing `[name, value][]` list out of a `Headers`
   * instance (used for cloning and for building an outgoing `fetch()`
   * request from a `Headers`/`Request`). */
  function getHeaderList(headers) {
    return headers[_list];
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
    cloneHeaderPairs,
    parseHeadersInit,
  };
})(globalThis);
