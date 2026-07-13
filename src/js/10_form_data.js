// Copyright 2026 the Limun authors. MIT license.

// `FormData` — XMLHttpRequest Standard
// (https://xhr.spec.whatwg.org/#interface-formdata).
//
// Migrated from Rust (`web::form_data.rs`, 431 lines) to JS-on-ops.
// Entries are a plain JS array of `{ name, value }` where `value` is a
// `USVString` or a `File` (the spec's `FormDataEntryValue`). The
// "create an entry" steps (a `Blob` value becomes a `File` named
// `"blob"`; a `File` value keeps its name/lastModified unless a
// `filename` argument overrides) are inlined into `append`/`set` —
// same as Deno's `createEntry` helper.
//
// The `multipart/form-data` and `application/x-www-form-urlencoded`
// parsers (used by `Response.formData()` / `Request.formData()`, still
// Rust in `web/fetch/{response,request}.rs`) move here too: they build
// `File`/string entries through the cached `__bootstrap.createFile`
// factory from `09_blob.js`, so they need the `File` class — which is
// why Blob/File landed first. The Rust fetch bridge calls
// `__bootstrap.createFormData` (empty) and the JS parsers
// (`appendUrlEncoded` / `parseMultipart`) via the cached globals.
//
// Ports Deno's `ext/fetch/21_formdata.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps` (unused — no op)
//   - `core.encode` / `core.decode` → cached `TextEncoder`/`TextDecoder`
//   - `webidl.brand` /
//     `webidl.assertBranded`  → inline equivalents (same pattern as
//     `09_blob.js`).
//   - `webidl.converters.*`    → inline converters.
//   - `webidl.mixinPairIterable` → inline iterator wiring (`entries`/
//     `keys`/`values`/`[Symbol.iterator]`/`forEach`), same shape as the
//     previous Rust impl (a snapshot of the entry list, iterated by
//     V8's built-in `Array Iterator`).
//   - `webidl.configureInterface` → dropped (sets a `[Symbol.toStringTag]`;
//     set inline instead).
//   - `MultipartParser` (Deno's state-machine class) → a byte-offset
//     scan, matching the previous Rust impl's delimiter-split approach
//     (simpler, already passing the smoke suite). `Content-Disposition`
//     parsing handles both quoted and unquoted `name`/`filename`.
//   - `formDataToBlob` / `escape` → dropped (not in the smoke suite; the
//     `Request` body construction path that would use it isn't wired
//     up yet — Limun's fetch builds bodies from `string`/`BufferSource`,
//     not from `FormData`).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no Deno-style
//     custom inspect in Limun yet).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayPrototypePush,
    ArrayPrototypeSplice,
    DateNow,
    FunctionPrototypeCall,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    SafeRegExp,
    StringPrototypeCharCodeAt,
    StringPrototypeIndexOf,
    StringPrototypeSlice,
    StringPrototypeSplit,
    StringPrototypeTrim,
    Symbol,
    SymbolIterator,
    SymbolToStringTag,
    TypeError,
    TypedArrayPrototypeSubarray,
    Uint8Array,
  } = primordials;
  // Pull the prototypes off the installed globals (they're installed by
  // `09_blob.js`, which runs before this module).
  const BlobPrototype = globalThis.Blob.prototype;
  const FilePrototype = globalThis.File.prototype;

  const { op_encoding_decode_single } = globalThis.__limunOps;
  const textEncoder = new TextEncoder();

  // --- Inline WebIDL (minimal, pilot-scoped) -----------------------------

  const brand = Symbol("[[webidl.brand]]");

  function assertBranded(self, prototype) {
    if (
      !ObjectPrototypeIsPrototypeOf(prototype, self) || self[brand] !== brand
    ) {
      throw new TypeError("Illegal invocation");
    }
  }

  // `webidl.converters.USVString(V)` — ToString then UTF-8 round-trip
  // (replaces unpaired surrogates with U+FFFD). The result is a JS
  // string; we don't return the bytes here (unlike Blob's BlobPart path)
  // — FormData stores `USVString` values as JS strings.
  function convertUSVString(V) {
    const bytes = textEncoder.encode(String(V));
    return op_encoding_decode_single(bytes, "utf-8", false, false);
  }

  function requiredArguments(length, required, prefix) {
    if (length < required) {
      throw new TypeError(
        `${prefix}: ${required} argument${required === 1 ? "" : "s"} required, but only ${length} present`,
      );
    }
  }

  // --- Private fields ----------------------------------------------------

  const entryList = Symbol("entry list");

  // --- createEntry (spec "create an entry" steps) -----------------------

  // `value` is already a `USVString` or a `Blob`/`File`. If it's a `Blob`
  // but not a `File`, wrap it in a `File` named "blob" (spec default
  // filename). If it's a `File` and `filename` was supplied, wrap it in
  // a new `File` with the supplied name (preserving `type` and
  // `lastModified`). Matches Deno's `createEntry` shape.
  function createEntry(name, value, filename) {
    if (
      ObjectPrototypeIsPrototypeOf(BlobPrototype, value) &&
      !ObjectPrototypeIsPrototypeOf(FilePrototype, value)
    ) {
      value = new File([value], "blob", { type: value.type });
    }
    if (
      ObjectPrototypeIsPrototypeOf(FilePrototype, value) &&
      filename !== undefined
    ) {
      value = new File([value], filename, {
        type: value.type,
        lastModified: value.lastModified,
      });
    }
    return { name, value };
  }

  // --- FormData class ----------------------------------------------------

  class FormData {
    [entryList] = [];

    // Spec's optional `HTMLFormElement` arg isn't supported (no DOM) —
    // args are silently ignored, matching the previous Rust behavior.
    constructor() {
      this[brand] = brand;
    }

    append(name, valueOrBlobValue, filename) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'append' on 'FormData'";
      requiredArguments(arguments.length, 2, prefix);

      name = convertUSVString(name);
      if (ObjectPrototypeIsPrototypeOf(BlobPrototype, valueOrBlobValue)) {
        if (filename !== undefined) {
          filename = convertUSVString(filename);
        }
      } else {
        valueOrBlobValue = convertUSVString(valueOrBlobValue);
      }

      const entry = createEntry(name, valueOrBlobValue, filename);
      ArrayPrototypePush(this[entryList], entry);
    }

    delete(name) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'delete' on 'FormData'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);

      const list = this[entryList];
      let writeIdx = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].name !== name) {
          list[writeIdx++] = list[i];
        }
      }
      if (writeIdx !== list.length) {
        ArrayPrototypeSplice(list, writeIdx);
      }
    }

    get(name) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'get' on 'FormData'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);

      const entries = this[entryList];
      for (let i = 0; i < entries.length; ++i) {
        if (entries[i].name === name) return entries[i].value;
      }
      return null;
    }

    getAll(name) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'getAll' on 'FormData'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);

      const returnList = [];
      const entries = this[entryList];
      for (let i = 0; i < entries.length; ++i) {
        if (entries[i].name === name) {
          ArrayPrototypePush(returnList, entries[i].value);
        }
      }
      return returnList;
    }

    has(name) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'has' on 'FormData'";
      requiredArguments(arguments.length, 1, prefix);
      name = convertUSVString(name);

      const entries = this[entryList];
      for (let i = 0; i < entries.length; ++i) {
        if (entries[i].name === name) return true;
      }
      return false;
    }

    set(name, valueOrBlobValue, filename) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'set' on 'FormData'";
      requiredArguments(arguments.length, 2, prefix);

      name = convertUSVString(name);
      if (ObjectPrototypeIsPrototypeOf(BlobPrototype, valueOrBlobValue)) {
        if (filename !== undefined) {
          filename = convertUSVString(filename);
        }
      } else {
        valueOrBlobValue = convertUSVString(valueOrBlobValue);
      }

      const entry = createEntry(name, valueOrBlobValue, filename);

      const list = this[entryList];
      let writeIdx = 0;
      let added = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i].name === name) {
          if (!added) {
            list[writeIdx++] = entry;
            added = true;
          }
        } else {
          list[writeIdx++] = list[i];
        }
      }
      if (!added) {
        ArrayPrototypePush(list, entry);
      } else if (writeIdx !== list.length) {
        ArrayPrototypeSplice(list, writeIdx);
      }
    }

    // `forEach(callback, thisArg)` — snapshot the entry list, call
    // `callback(value, key, this)` for each entry.
    forEach(callback, thisArg) {
      assertBranded(this, FormDataPrototype);
      const prefix = "Failed to execute 'forEach' on 'FormData'";
      requiredArguments(arguments.length, 1, prefix);
      if (typeof callback !== "function") {
        throw new TypeError(`${prefix}: callback must be a function`);
      }

      const list = this[entryList];
      for (let i = 0; i < list.length; ++i) {
        const entry = list[i];
        const { value, name } = entry;
        FunctionPrototypeCall(callback, thisArg, value, name, this);
      }
    }

    entries() {
      assertBranded(this, FormDataPrototype);
      return pairIterator(this[entryList], "entries");
    }

    keys() {
      assertBranded(this, FormDataPrototype);
      return pairIterator(this[entryList], "keys");
    }

    values() {
      assertBranded(this, FormDataPrototype);
      return pairIterator(this[entryList], "values");
    }
  }

  // `entries()`/`keys()`/`values()`/`[Symbol.iterator]` all return a
  // real `Array Iterator` over a snapshot of the entry list — V8's
  // built-in iterator gives the correct `{value, done}`/`.next()` shape
  // for free (same approach as the previous Rust impl, which used
  // `native::array_iterator`). `entries` is the default iterator per
  // spec (`webidl.mixinPairIterable` wires `Symbol.iterator` to it).
  function pairIterator(list, mode) {
    const snapshot = [];
    for (let i = 0; i < list.length; ++i) {
      const entry = list[i];
      if (mode === "keys") {
        ArrayPrototypePush(snapshot, entry.name);
      } else if (mode === "values") {
        ArrayPrototypePush(snapshot, entry.value);
      } else {
        ArrayPrototypePush(snapshot, [entry.name, entry.value]);
      }
    }
    return snapshot[SymbolIterator]();
  }
  // `Symbol.iterator` → `entries()` (spec default for pair iterables).
  ObjectDefineProperty(FormData.prototype, SymbolIterator, {
    __proto__: null,
    value: FormData.prototype.entries,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  ObjectDefineProperty(FormData.prototype, SymbolToStringTag, {
    __proto__: null,
    value: "FormData",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  const FormDataPrototype = FormData.prototype;

  // --- application/x-www-form-urlencoded parser -------------------------

  // Parse `bytes` as `application/x-www-form-urlencoded` and append each
  // `(name, value)` pair to `fd` as a `USVString` entry. Used by the
  // Rust fetch bridge (`Response.formData()` / `Request.formData()`).
  // Decoded with the standard's `application/x-www-form-urlencoded`
  // parser (replace `+` with space, percent-decode). `url` crate's
  // `form_urlencoded::parse` was the previous Rust path; here it's a
  // minimal JS port (the standard's decoder is small).
  function appendUrlEncoded(fd, bytes) {
    const pairs = decodeFormUrlencoded(bytes);
    for (let i = 0; i < pairs.length; ++i) {
      const { 0: name, 1: value } = pairs[i];
      // `name`/`value` are already USVStrings (decoded as UTF-8 with
      // invalid bytes → U+FFFD, matching the standard). Store as a
      // string entry directly, skipping `createEntry` (no Blob/File
      // path) — matches the previous Rust `FormDataEntry::Text`.
      ArrayPrototypePush(fd[entryList], { name, value });
    }
  }

  // `application/x-www-form-urlencoded` parser (WHATWG URL Standard
  // §5.2). Splits on `&`, then `=`, percent-decodes both sides as
  // UTF-8 (invalid bytes → U+FFFD, per the standard's "serializer"
  // note). A pair without `=` becomes `("value", "")`.
  function decodeFormUrlencoded(bytes) {
    const text = op_encoding_decode_single(bytes, "utf-8", false, false);
    const out = [];
    if (text === "") return out;
    const pairs = StringPrototypeSplit(text, "&");
    for (let i = 0; i < pairs.length; ++i) {
      const pair = pairs[i];
      if (pair === "") continue;
      const eq = StringPrototypeIndexOf(pair, "=");
      let name, value;
      if (eq < 0) {
        name = pair;
        value = "";
      } else {
        name = StringPrototypeSlice(pair, 0, eq);
        value = StringPrototypeSlice(pair, eq + 1);
      }
      out.push([percentDecode(name), percentDecode(value)]);
    }
    return out;
  }

  const PLUS_PATTERN = new SafeRegExp(/\+/g);
  const HEX = "0123456789ABCDEFabcdef";

  // `application/x-www-form-urlencoded` percent-decode: replace `+`
  // with space, then percent-decode the rest. Decode bytes as UTF-8
  // (invalid bytes → U+FFFD per the standard).
  function percentDecode(s) {
    s = s.replace(PLUS_PATTERN, " ");
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = StringPrototypeCharCodeAt(s, i);
      if (c === 0x25) { // %
        const hi = StringPrototypeCharCodeAt(s, i + 1);
        const lo = StringPrototypeCharCodeAt(s, i + 2);
        if (hi !== undefined && lo !== undefined && isHex(hi) && isHex(lo)) {
          out.push(hexVal(hi) * 16 + hexVal(lo));
          i += 3;
          continue;
        }
      }
      out.push(c);
      i += 1;
    }
    return op_encoding_decode_single(new Uint8Array(out), "utf-8", false, false);
  }

  function isHex(c) {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) ||
      (c >= 0x61 && c <= 0x66);
  }
  function hexVal(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
    return c - 0x61 + 10;
  }

  // --- multipart/form-data parser ---------------------------------------

  // Parse `bytes` as `multipart/form-data` with the given `boundary`
  // and append each part to `fd`. Returns `null` on success, or an
  // error string on a malformed body (the Rust fetch bridge then
  // rejects the `formData()` promise with a `TypeError`). Matches the
  // previous Rust impl's grammar (RFC 7578 / RFC 2046 §5.1):
  //
  //   --boundary CRLF (part-headers CRLF CRLF part-body CRLF)* --boundary-- 
  //
  // A part's `Content-Disposition: form-data; name="…"[; filename="…"]`
  // names it; a `filename` (even empty) makes it a `File` entry,
  // otherwise it's a text entry decoded as UTF-8. `Content-Type`
  // supplies the file's type. `name`/`filename` are decoded as
  // Latin-1→UTF-8 (the Fetch Standard's "mistakenly decoded as
  // Latin-1" rule — matches Deno's `decodeLatin1StringAsUtf8`).
  function parseMultipart(fd, bytes, boundary) {
    const delim = textEncoder.encode(`--${boundary}`);
    const len = delim.length;

    const positions = [];
    let i = 0;
    while (i + len <= bytes.length) {
      let match = true;
      for (let j = 0; j < len; ++j) {
        if (bytes[i + j] !== delim[j]) { match = false; break; }
      }
      if (match) {
        positions.push(i);
        i += len;
      } else {
        i += 1;
      }
    }
    if (positions.length === 0) {
      return "multipart body has no boundary delimiter";
    }

    for (let w = 0; w + 1 < positions.length; ++w) {
      const start = positions[w] + len;
      const end = positions[w + 1];
      let section = TypedArrayPrototypeSubarray(bytes, start, end);
      // Strip leading CRLF.
      if (section.length >= 2 && section[0] === 0x0D && section[1] === 0x0A) {
        section = TypedArrayPrototypeSubarray(section, 2);
      }
      // Strip trailing CRLF (if present before the next delimiter).
      if (section.length >= 2 &&
          section[section.length - 2] === 0x0D &&
          section[section.length - 1] === 0x0A) {
        section = TypedArrayPrototypeSubarray(section, 0, section.length - 2);
      }

      // Find the header/body separator (`\r\n\r\n`).
      const sep = findBytes(section, [0x0D, 0x0A, 0x0D, 0x0A]);
      if (sep < 0) {
        return "multipart part has no header/body separator";
      }
      const headerBytes = TypedArrayPrototypeSubarray(section, 0, sep);
      const body = TypedArrayPrototypeSubarray(section, sep + 4);

      const headersText = op_encoding_decode_single(headerBytes, "utf-8", false, false);
      let name = null;
      let filename = null;
      let contentType = "";
      const lines = StringPrototypeSplit(headersText, "\r\n");
      for (let li = 0; li < lines.length; ++li) {
        const line = lines[li];
        const colon = StringPrototypeIndexOf(line, ":");
        if (colon < 0) continue;
        const key = StringPrototypeTrim(StringPrototypeSlice(line, 0, colon));
        const value = StringPrototypeTrim(StringPrototypeSlice(line, colon + 1));
        if (key.toLowerCase() === "content-disposition") {
          name = param(value, "name");
          filename = param(value, "filename");
        } else if (key.toLowerCase() === "content-type") {
          contentType = value;
        }
      }

      if (name === null) {
        return "multipart part is missing a Content-Disposition name";
      }
      const nameDecoded = decodeLatin1AsUtf8(name);
      if (filename !== null) {
        const filenameDecoded = decodeLatin1AsUtf8(filename);
        const file = globalThis.__bootstrap.createFile(
          new Uint8Array(body),
          contentType.toLowerCase(),
          filenameDecoded,
          DateNow(),
        );
        ArrayPrototypePush(fd[entryList], { name: nameDecoded, value: file });
      } else {
        const text = op_encoding_decode_single(body, "utf-8", false, false);
        ArrayPrototypePush(fd[entryList], { name: nameDecoded, value: text });
      }
    }
    return null;
  }

  // Extract a `; key="value"` (or `; key=value`) parameter from a
  // header value. Returns `null` if not present.
  function param(headerValue, key) {
    const parts = StringPrototypeSplit(headerValue, ";");
    for (let i = 1; i < parts.length; ++i) {
      const part = StringPrototypeTrim(parts[i]);
      const eq = StringPrototypeIndexOf(part, "=");
      if (eq < 0) continue;
      const k = StringPrototypeTrim(StringPrototypeSlice(part, 0, eq));
      if (k.toLowerCase() !== key) continue;
      let v = StringPrototypeTrim(StringPrototypeSlice(part, eq + 1));
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
        v = StringPrototypeSlice(v, 1, v.length - 1);
      }
      return v;
    }
    return null;
  }

  function findBytes(bytes, needle) {
    const n = needle.length;
    for (let i = 0; i + n <= bytes.length; ++i) {
      let ok = true;
      for (let j = 0; j < n; ++j) {
        if (bytes[i + j] !== needle[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  // Decode a Latin-1 string (each char's code unit as a byte) as UTF-8
  // — the Fetch Standard's "mistakenly decoded as Latin-1" rule for
  // multipart `name`/`filename`. Matches Deno's
  // `decodeLatin1StringAsUtf8`.
  function decodeLatin1AsUtf8(s) {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; ++i) {
      bytes[i] = StringPrototypeCharCodeAt(s, i) & 0xFF;
    }
    return op_encoding_decode_single(bytes, "utf-8", false, false);
  }

  // --- Rust bridge: createFormData / parsers ----------------------------

  // `createFormData()` — mint an empty `FormData` from Rust (used by
  // `Response.formData()` / `Request.formData()`).
  function createFormData() {
    return new FormData();
  }

  // --- Install as non-enumerable global ---------------------------------

  ObjectDefineProperty(globalThis, "FormData", {
    __proto__: null,
    value: FormData,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // Stash the factory + parsers on `__bootstrap` for the Rust fetch
  // bridge.
  globalThis.__bootstrap.createFormData = createFormData;
  globalThis.__bootstrap.formDataAppendUrlEncoded = appendUrlEncoded;
  globalThis.__bootstrap.formDataParseMultipart = parseMultipart;
})(globalThis);