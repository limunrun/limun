// Copyright 2026 the Limun authors. MIT license.

// `DOMException` — Web IDL §3.14
// (https://webidl.spec.whatwg.org/#idl-DOMException).
//
// Second web API migrated from Rust to JS-on-ops (after base64). Unlike
// base64 this module has NO Rust op — DOMException is pure JS: a class
// that uses `ReflectConstruct(Error, [], new.target)` to harvest V8's
// stack + `[[ErrorData]]` slot, stores name/message/code in private
// symbols, and is branded with an inline webidl-style brand symbol. Rust
// callers that need to mint instances (`throw_dom_exception`,
// `AbortSignal`'s default abort reason) call the cached JS constructor
// via `dom_exception::new_instance` — the constructor global is stashed
// in a Rust thread_local after this module evaluates (see
// `dom_exception::cache_ctor`).
//
// Ports Deno's `ext/web/01_dom_exception.js`. Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core`                   → not used (no ops, no hostObjectBrand)
//   - `webidl.brand` /
//     `webidl.assertBranded` /
//     `webidl.converters.DOMString` → `globalThis.__bootstrap.webidl`
//     (the shared `ext:limun/00_webidl.js` module).
//   - `webidl.configureInterface` → dropped (it only sets a `[Symbol.toStringTag]`
//     on the prototype; DOMException has no `[Symbol.toStringTag]` per spec,
//     and Deno's `configureInterface` is a no-op for classes without a
//     declared `toStringTag`).
//   - `core.registerCloneableResource` → dropped (no structured-clone
//     channel in Limun yet).
//   - `QuotaExceededError` subclass → dropped (Web IDL §4.3.1, not part
//     of the base `DOMException` interface Limun exposes today; will be
//     reintroduced when the Storage API lands).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no Deno-style
//     custom inspect in Limun yet).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    Error,
    ErrorPrototype,
    ObjectDefineProperty,
    ObjectCreate,
    ObjectEntries,
    ObjectPrototypeIsPrototypeOf,
    ObjectSetPrototypeOf,
    ReflectConstruct,
    String,
    Symbol,
    TypeError,
  } = primordials;

  // --- Private fields (Symbols, not #private — matches Deno) --------------

  const _name = Symbol("name");
  const _message = Symbol("message");
  const _code = Symbol("code");

  // --- Legacy constants (Web IDL §4.3) ------------------------------------

  const INDEX_SIZE_ERR = 1;
  const DOMSTRING_SIZE_ERR = 2;
  const HIERARCHY_REQUEST_ERR = 3;
  const WRONG_DOCUMENT_ERR = 4;
  const INVALID_CHARACTER_ERR = 5;
  const NO_DATA_ALLOWED_ERR = 6;
  const NO_MODIFICATION_ALLOWED_ERR = 7;
  const NOT_FOUND_ERR = 8;
  const NOT_SUPPORTED_ERR = 9;
  const INUSE_ATTRIBUTE_ERR = 10;
  const INVALID_STATE_ERR = 11;
  const SYNTAX_ERR = 12;
  const INVALID_MODIFICATION_ERR = 13;
  const NAMESPACE_ERR = 14;
  const INVALID_ACCESS_ERR = 15;
  const VALIDATION_ERR = 16;
  const TYPE_MISMATCH_ERR = 17;
  const SECURITY_ERR = 18;
  const NETWORK_ERR = 19;
  const ABORT_ERR = 20;
  const URL_MISMATCH_ERR = 21;
  const QUOTA_EXCEEDED_ERR = 22;
  const TIMEOUT_ERR = 23;
  const INVALID_NODE_TYPE_ERR = 24;
  const DATA_CLONE_ERR = 25;

  // Web IDL §2.8.1 error-names table → legacy numeric `code`. Names not
  // listed (every modern name except the 21 legacy ones) map to 0.
  // `ObjectCreate(null, …)` so user code can't poison the lookup via
  // `Object.prototype` properties.
  const nameToCodeMapping = ObjectCreate(null, {
    IndexSizeError: { value: INDEX_SIZE_ERR },
    HierarchyRequestError: { value: HIERARCHY_REQUEST_ERR },
    WrongDocumentError: { value: WRONG_DOCUMENT_ERR },
    InvalidCharacterError: { value: INVALID_CHARACTER_ERR },
    NoModificationAllowedError: { value: NO_MODIFICATION_ALLOWED_ERR },
    NotFoundError: { value: NOT_FOUND_ERR },
    NotSupportedError: { value: NOT_SUPPORTED_ERR },
    InUseAttributeError: { value: INUSE_ATTRIBUTE_ERR },
    InvalidStateError: { value: INVALID_STATE_ERR },
    SyntaxError: { value: SYNTAX_ERR },
    InvalidModificationError: { value: INVALID_MODIFICATION_ERR },
    NamespaceError: { value: NAMESPACE_ERR },
    InvalidAccessError: { value: INVALID_ACCESS_ERR },
    TypeMismatchError: { value: TYPE_MISMATCH_ERR },
    SecurityError: { value: SECURITY_ERR },
    NetworkError: { value: NETWORK_ERR },
    AbortError: { value: ABORT_ERR },
    URLMismatchError: { value: URL_MISMATCH_ERR },
    QuotaExceededError: { value: QUOTA_EXCEEDED_ERR },
    TimeoutError: { value: TIMEOUT_ERR },
    InvalidNodeTypeError: { value: INVALID_NODE_TYPE_ERR },
    DataCloneError: { value: DATA_CLONE_ERR },
  });

  // --- DOMException class -------------------------------------------------

  // The class body declares `[_message]`/`[_name]`/`[_code]` fields for
  // documentation, but the constructor returns a *different* object (a
  // `ReflectConstruct`'d `Error`) — so those field initializers never run
  // on `this`. The returned `error` has `DOMException.prototype` as its
  // proto (because `ReflectConstruct(Error, [], new.target)` uses
  // `new.target.prototype`, which for a class is the class's own
  // `.prototype`), so the getters below resolve against it and read the
  // symbols that the constructor stashed on `error`.
  class DOMException {
    [_message];
    [_name];
    [_code];

    // https://webidl.spec.whatwg.org/#dom-domexception-domexception
    constructor(message = "", name = "Error") {
      message = webidl.converters.DOMString(message);

      // Run the `Error` constructor with `new.target`'s prototype so the
      // result gets V8's `stack` property and `[[ErrorData]]` internal
      // slot (the latter makes `e instanceof Error` work through the
      // proto chain rather than via a user-field check).
      const error = ReflectConstruct(Error, [], new.target);

      name = webidl.converters.DOMString(name);
      const code = nameToCodeMapping[name] ?? 0;

      error[_message] = message;
      error[_name] = name;
      error[_code] = code;
      error[webidl.brand] = webidl.brand;

      return error;
    }

    get message() {
      webidl.assertBranded(this, DOMExceptionPrototype, "DOMException");
      return this[_message];
    }

    get name() {
      webidl.assertBranded(this, DOMExceptionPrototype, "DOMException");
      return this[_name];
    }

    get code() {
      webidl.assertBranded(this, DOMExceptionPrototype, "DOMException");
      return this[_code];
    }
  }

  // `DOMException.prototype.__proto__ = Error.prototype` — spec says the
  // interface inherits from `Error`, which makes
  // `domException instanceof Error` true and gives it `Error.prototype`'s
  // `toString`.
  ObjectSetPrototypeOf(DOMException.prototype, ErrorPrototype);
  const DOMExceptionPrototype = DOMException.prototype;

  // Legacy `*_ERR` constants on both the constructor and the prototype
  // (`DOMException.INDEX_SIZE_ERR === 1`,
  // `DOMException.prototype.ABORT_ERR === 20`). Enumerable value props —
  // matches Deno and every browser.
  const entries = ObjectEntries({
    INDEX_SIZE_ERR,
    DOMSTRING_SIZE_ERR,
    HIERARCHY_REQUEST_ERR,
    WRONG_DOCUMENT_ERR,
    INVALID_CHARACTER_ERR,
    NO_DATA_ALLOWED_ERR,
    NO_MODIFICATION_ALLOWED_ERR,
    NOT_FOUND_ERR,
    NOT_SUPPORTED_ERR,
    INUSE_ATTRIBUTE_ERR,
    INVALID_STATE_ERR,
    SYNTAX_ERR,
    INVALID_MODIFICATION_ERR,
    NAMESPACE_ERR,
    INVALID_ACCESS_ERR,
    VALIDATION_ERR,
    TYPE_MISMATCH_ERR,
    SECURITY_ERR,
    NETWORK_ERR,
    ABORT_ERR,
    URL_MISMATCH_ERR,
    QUOTA_EXCEEDED_ERR,
    TIMEOUT_ERR,
    INVALID_NODE_TYPE_ERR,
    DATA_CLONE_ERR,
  });
  for (let i = 0; i < entries.length; ++i) {
    const { 0: key, 1: value } = entries[i];
    const desc = { __proto__: null, value, enumerable: true };
    ObjectDefineProperty(DOMException, key, desc);
    ObjectDefineProperty(DOMExceptionPrototype, key, desc);
  }

  // Install as a non-enumerable global — matches the previous Rust
  // `set_global` (DONT_ENUM) and every other constructible web class
  // (`TextEncoder`, `URL`, …): `Object.keys(globalThis)` excludes it.
  ObjectDefineProperty(globalThis, "DOMException", {
    __proto__: null,
    value: DOMException,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);