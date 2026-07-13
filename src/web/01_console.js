// Copyright 2018-2026 the Deno authors. MIT license.
// Copyright 2026 the Limun authors. MIT license.

// `console` — WHATWG Console Standard
// (https://console.spec.whatwg.org/). Namespace object installed as a
// non-enumerable own property of `globalThis` (Web IDL §3.7.5).
//
// Full recursive inspector ported from Deno's `ext/web/01_console.js`
// (pure-JS reference). Handles objects, arrays, typed arrays,
// ArrayBuffers, DataViews, Maps, Sets, Dates, RegExps, Errors, Promises,
// WeakMap/WeakSet, boxed primitives, circular refs, `%s`/`%d`/`%i`/`%f`/
// `%o`/`%O`/`%c`/`%%` substitution, `dir`/`group`/`groupCollapsed`/
// `groupEnd`/`table`/`time`/`timeEnd`/`timeLog`/`count`/`countReset`/
// `assert`/`clear`/`trace`. No ANSI colors / CSS (`%c` recognized, arg
// consumed, no styling).
//
// Rewires vs Deno:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `op_print`               → Limun's own `(text: String, is_err: bool)`
//   - `op_now(hrU8)` (buffer)  → `op_now()` (returns f64 ms directly)
//   - `core.isAnyArrayBuffer`/`isArgumentsObject`/... → primordial
//     `ObjectPrototypeIsPrototypeOf(<Type>Prototype, value)` checks
//   - `op_get_constructor_name` → `value.constructor?.name ?? "Object"`
//   - `op_get_non_index_property_names` → `ReflectOwnKeys` + index filter
//   - `op_preview_entries`     → `Array.from(value.entries())` / `Array.from(value)`
//   - `core.getProxyDetails`   → dropped (no unwrap; inspect target directly)
//   - `core.getPromiseDetails` → dropped (Promise inspected as regular object)
//   - `noColorStdout`/`op_console_css_to_ansi`/`parseCss`/`colors`/`styles` →
//     dropped (no color/CSS). `%c` arg consumed, nothing emitted.
//   - `[SymbolFor("Deno.privateCustomInspect")]` / `nodeCustomInspectSymbol` →
//     dropped (no custom inspect in Limun yet).
//   - `core.loadExtScript(...).URLPrototype` → dropped (URL inspected as a
//     regular object via the generic object inspector).
//   - `internals.printChar`/`internals.consoleGroupIndent` → module-local.
//   - `internals.Console` / `internals.inspectArgs` etc. → exposed on
//     `globalThis.__bootstrap` (for MessagePort/future use).
//   - `SharedArrayBuffer` branch → dropped (no SAB in Limun).
//   - node `markNodeModules`/`markCwd`/`pathToFileUrlHref` → dropped.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const { op_print, op_now } = globalThis.__limunOps;
  const {
    AggregateError,
    AggregateErrorPrototype,
    Array,
    ArrayBuffer,
    ArrayBufferPrototype,
    ArrayBufferPrototypeGetByteLength,
    ArrayFrom,
    ArrayIsArray,
    ArrayPrototypeFill,
    ArrayPrototypeFilter,
    ArrayPrototypeFind,
    ArrayPrototypeForEach,
    ArrayPrototypeIncludes,
    ArrayPrototypeIndexOf,
    ArrayPrototypeJoin,
    ArrayPrototypeMap,
    ArrayPrototypePop,
    ArrayPrototypePush,
    ArrayPrototypePushApply,
    ArrayPrototypeReduce,
    ArrayPrototypeSlice,
    ArrayPrototypeSort,
    ArrayPrototypeSplice,
    ArrayPrototypeUnshift,
    BigIntPrototypeValueOf,
    Boolean,
    BooleanPrototype,
    BooleanPrototypeValueOf,
    DataView,
    DataViewPrototype,
    Date,
    DateNow,
    DatePrototype,
    DatePrototypeGetTime,
    DatePrototypeToISOString,
    DatePrototypeToString,
    Error,
    ErrorCaptureStackTrace,
    ErrorPrototype,
    ErrorPrototypeToString,
    Function,
    FunctionPrototype,
    FunctionPrototypeBind,
    FunctionPrototypeCall,
    FunctionPrototypeSymbolHasInstance,
    FunctionPrototypeToString,
    JSONStringify,
    Map,
    MapPrototype,
    MapPrototypeDelete,
    MapPrototypeEntries,
    MapPrototypeForEach,
    MapPrototypeGet,
    MapPrototypeGetSize,
    MapPrototypeHas,
    MapPrototypeSet,
    MathAbs,
    MathFloor,
    MathMax,
    MathMin,
    MathRound,
    MathSqrt,
    Number,
    NumberIsInteger,
    NumberIsNaN,
    NumberParseFloat,
    NumberParseInt,
    NumberPrototype,
    NumberPrototypeToFixed,
    NumberPrototypeToString,
    NumberPrototypeValueOf,
    Object,
    ObjectAssign,
    ObjectCreate,
    ObjectDefineProperty,
    ObjectFreeze,
    ObjectFromEntries,
    ObjectGetOwnPropertyDescriptor,
    ObjectGetOwnPropertyNames,
    ObjectGetOwnPropertySymbols,
    ObjectGetPrototypeOf,
    ObjectHasOwn,
    ObjectIs,
    ObjectKeys,
    ObjectPrototype,
    ObjectPrototypeIsPrototypeOf,
    ObjectPrototypePropertyIsEnumerable,
    ObjectPrototypeToString,
    ObjectSetPrototypeOf,
    ObjectValues,
    Promise,
    PromisePrototype,
    RangeError,
    RangeErrorPrototype,
    ReflectGetOwnPropertyDescriptor,
    ReflectGetPrototypeOf,
    ReflectHas,
    ReflectOwnKeys,
    RegExp,
    RegExpPrototype,
    RegExpPrototypeExec,
    RegExpPrototypeSymbolReplace,
    RegExpPrototypeTest,
    RegExpPrototypeToString,
    SafeArrayIterator,
    SafeMap,
    SafeMapIterator,
    SafeRegExp,
    SafeSet,
    SafeSetIterator,
    SafeStringIterator,
    Set,
    SetPrototype,
    SetPrototypeAdd,
    SetPrototypeGetSize,
    SetPrototypeHas,
    SetPrototypeValues,
    String,
    StringPrototype,
    StringPrototypeCharCodeAt,
    StringPrototypeCodePointAt,
    StringPrototypeEndsWith,
    StringPrototypeIncludes,
    StringPrototypeIndexOf,
    StringPrototypeLastIndexOf,
    StringPrototypeMatch,
    StringPrototypeNormalize,
    StringPrototypePadEnd,
    StringPrototypePadStart,
    StringPrototypeRepeat,
    StringPrototypeReplace,
    StringPrototypeReplaceAll,
    StringPrototypeSlice,
    StringPrototypeSplit,
    StringPrototypeStartsWith,
    StringPrototypeToLowerCase,
    StringPrototypeTrim,
    StringPrototypeValueOf,
    Symbol,
    SymbolFor,
    SymbolHasInstance,
    SymbolIterator,
    SymbolPrototypeGetDescription,
    SymbolPrototypeToString,
    SymbolPrototypeValueOf,
    SymbolToStringTag,
    TypedArray,
    TypedArrayPrototype,
    TypedArrayPrototypeGetBuffer,
    TypedArrayPrototypeGetByteLength,
    TypedArrayPrototypeGetLength,
    TypeError,
    TypeErrorPrototype,
    Uint8Array,
    WeakMap,
    WeakMapPrototype,
    WeakSet,
    WeakSetPrototype,
  } = primordials;

  // --- `op_now` adaptation ------------------------------------------------
  //
  // Deno's pure-JS console calls `op_now(hrU8)` with a `Uint8Array` buffer
  // and unpacks hi-res time. Limun's `op_now()` takes NO buffer and returns
  // an `f64` of milliseconds directly (see `ext:limun/15_performance.js`).
  // Fall back to `Date.now()` if the op is somehow absent (it won't be —
  // it's registered before JS modules evaluate).
  const currentTime = typeof op_now === "function" ? op_now : DateNow;

  // --- No-color stylize ---------------------------------------------------
  //
  // Deno switches `ctx.stylize` between `stylizeNoColor` and a color
  // renderer. Limun has no ANSI colors / CSS, so stylize is always the
  // identity. `%c` is still recognized (arg consumed, nothing emitted).
  function stylizeNoColor(str) {
    return str;
  }

  // Attempt to JSON.stringify, returning "[Circular]" only for circular
  // reference errors (matching Node.js behavior).
  const firstErrorLine = (error) =>
    StringPrototypeSplit(error.message, "\n", 1)[0];
  let CIRCULAR_ERROR_MESSAGE;
  function tryStringify(arg) {
    try {
      return JSONStringify(arg);
    } catch (err) {
      if (!CIRCULAR_ERROR_MESSAGE) {
        try {
          const a = {};
          a.a = a;
          JSONStringify(a);
        } catch (circularError) {
          CIRCULAR_ERROR_MESSAGE = firstErrorLine(circularError);
        }
      }
      if (
        err.name === "TypeError" &&
        firstErrorLine(err) === CIRCULAR_ERROR_MESSAGE
      ) {
        return "[Circular]";
      }
      throw err;
    }
  }

  const kObjectType = 0;
  const kArrayType = 1;
  const kArrayExtrasType = 2;

  // Constants to map the iterator state.
  const kWeak = 0;
  const kIterator = 1;
  const kMapEntries = 2;

  // Escaped control characters (plus the single quote and the backslash).
  // deno-fmt-ignore
  const meta = [
    '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07',
    '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',
    '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17',
    '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F',
    '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',
    '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87',
    '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F',
    '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97',
    '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F',
  ];

  // https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
  const isUndetectableObject = (v) =>
    typeof v === "undefined" && v !== undefined;

  const strEscapeSequencesReplacer = new SafeRegExp(
    "[\x00-\x1f\x27\x5c\x7f-\x9f]",
    "g",
  );

  const keyStrRegExp = new SafeRegExp("^[a-zA-Z_][a-zA-Z_0-9]*$");
  const numberRegExp = new SafeRegExp("^(0|[1-9][0-9]*)$");

  const escapeFn = (str) => meta[StringPrototypeCharCodeAt(str, 0)];

  // --- Type predicates (replacing Deno's `core.isXxx`) -------------------
  //
  // Deno's V8-backed `core.isAnyArrayBuffer`/`isArgumentsObject`/`isMap`/...
  // are replaced with primordial `ObjectPrototypeIsPrototypeOf` checks (and
  // `ObjectPrototypeToString` for Arguments/Module/DataView/TypedArray brand
  // checks that don't have a single prototype to test). No `SharedArrayBuffer`
  // in Limun, so `isAnyArrayBuffer` == `isArrayBuffer`.

  function isArrayBuffer(value) {
    return ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, value);
  }
  function isAnyArrayBuffer(value) {
    return isArrayBuffer(value);
  }
  function isTypedArray(value) {
    const tag = objectToString(value);
    return (
      tag !== "[object DataView]" &&
      ArrayBufferIsViewPrimordial(value) &&
      tag.startsWith("[object ")
    );
  }
  // `ArrayBuffer.isView` via the static (a primordial). Covers typed arrays
  // and DataView; we separate DataView by `ObjectPrototypeToString`.
  function ArrayBufferIsViewPrimordial(value) {
    return typeof value === "object" && value !== null &&
      "buffer" in value &&
      objectToString(value) !== "[object DataView]"
      ? true
      : false;
  }
  function isDataView(value) {
    return objectToString(value) === "[object DataView]";
  }
  function isDate(value) {
    return ObjectPrototypeIsPrototypeOf(DatePrototype, value);
  }
  function isRegExp(value) {
    return ObjectPrototypeIsPrototypeOf(RegExpPrototype, value);
  }
  function isMap(value) {
    return ObjectPrototypeIsPrototypeOf(MapPrototype, value);
  }
  function isSet(value) {
    return ObjectPrototypeIsPrototypeOf(SetPrototype, value);
  }
  function isWeakMap(value) {
    return ObjectPrototypeIsPrototypeOf(WeakMapPrototype, value);
  }
  function isWeakSet(value) {
    return ObjectPrototypeIsPrototypeOf(WeakSetPrototype, value);
  }
  function isPromise(value) {
    return ObjectPrototypeIsPrototypeOf(PromisePrototype, value);
  }
  function isError(value) {
    return ObjectPrototypeIsPrototypeOf(ErrorPrototype, value);
  }
  function isNativeError(value) {
    return isError(value);
  }
  function isBoxedPrimitive(value) {
    return (
      isNumberObject(value) || isStringObject(value) ||
      isBooleanObject(value) || isBigIntObject(value) || isSymbolObject(value)
    );
  }
  function isNumberObject(value) {
    return ObjectPrototypeIsPrototypeOf(NumberPrototype, value);
  }
  function isStringObject(value) {
    return ObjectPrototypeIsPrototypeOf(StringPrototype, value);
  }
  function isBooleanObject(value) {
    return ObjectPrototypeIsPrototypeOf(BooleanPrototype, value);
  }
  function isBigIntObject(value) {
    // `BigInt.prototype` isn't a named primordial slot; reach it via
    // `ObjectGetPrototypeOf(Object(BigInt(0)))`.
    return ObjectPrototypeIsPrototypeOf(BigIntPrototype, value);
  }
  function isSymbolObject(value) {
    return ObjectPrototypeIsPrototypeOf(SymbolPrototype, value);
  }
  function isArgumentsObject(value) {
    return objectToString(value) === "[object Arguments]";
  }
  function isModuleNamespaceObject(value) {
    return objectToString(value) === "[object Module]";
  }
  function isMapIterator(value) {
    return objectToString(value) === "[object Map Iterator]";
  }
  function isSetIterator(value) {
    return objectToString(value) === "[object Set Iterator]";
  }
  function isAsyncFunction(value) {
    return (
      typeof value === "function" &&
      StringPrototypeStartsWith(FunctionPrototypeToString(value), "async")
    );
  }
  function isGeneratorFunction(value) {
    return (
      typeof value === "function" &&
      StringPrototypeStartsWith(FunctionPrototypeToString(value), "function*")
    );
  }

  function objectToString(value) {
    try {
      return ObjectPrototypeToString(value);
    } catch {
      return "";
    }
  }

  // `BigInt.prototype` — not a top-level primordial slot name, reach via the
  // intrinsic. `primordials.BigInt` is the constructor; its `.prototype` is
  // the prototype we need for `isBigIntObject`.
  const BigIntPrototype = BigInt.prototype;

  // --- Deno op replacements (pure-JS) -------------------------------------

  // `op_get_constructor_name(value)` → `value.constructor?.name ?? "Object"`.
  // Use try/catch for proxies that throw on `.constructor` access; an
  // `Object.create(null)` has no `constructor` → "Object".
  function getConstructorNameOp(value) {
    try {
      const ctor = value.constructor;
      if (ctor) {
        const name = ctor.name;
        if (typeof name === "string" && name !== "") {
          return name;
        }
      }
    } catch {
      // proxy trap threw — fall through
    }
    return "Object";
  }

  // `op_get_non_index_property_names(value, filter)` → `ReflectOwnKeys` +
  // filter. `filter` is 0 (all) or 2 (non-numeric-index only, the default
  // `showHidden:false` path). Numeric index = `String(Number(key)) === key`
  // AND `NumberIsInteger(Number(key))` (excludes "1.5", "-0", "01").
  function isNumericIndex(key) {
    if (typeof key !== "string") return false;
    if (!numberRegExp.test(key)) {
      // also accept canonical non-negative integer forms via Number parse
      const n = NumberParseInt(key);
      if (!NumberIsInteger(n) || n < 0) return false;
      return String(n) === key;
    }
    return true;
  }

  function getNonIndexPropertyNames(value, filter) {
    let keys;
    try {
      keys = ReflectOwnKeys(value);
    } catch {
      return [];
    }
    // For arrays, `length` is an own non-enumerable property that the
    // spec/Deno's `op_get_non_index_property_names` treats as part of the
    // array's exotic layout (not a "named" extra property). Exclude it so
    // the inspector doesn't render `[length]: N` alongside the elements.
    const isArray = ArrayIsArray(value);
    if (filter === 0) {
      if (isArray) {
        const out = [];
        for (let i = 0; i < keys.length; i++) {
          if (keys[i] !== "length") {
            ArrayPrototypePush(out, keys[i]);
          }
        }
        return out;
      }
      return keys;
    }
    // filter === 2: exclude numeric indices (array-like index props) and
    // `length` for arrays.
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (isArray && k === "length") continue;
      if (!isNumericIndex(k)) {
        ArrayPrototypePush(out, k);
      }
    }
    return out;
  }

  // `op_preview_entries(value, isKeyValue)` → materialize the entries.
  // For Map/Set iterators and WeakMap/WeakSet (the latter we can't iterate,
  // return `[]`).
  function previewEntries(value, isKeyValue) {
    if (isMap(value)) {
      const out = [];
      MapPrototypeForEach(value, (v, k) => {
        ArrayPrototypePush(out, k, v);
      });
      return [out, true];
    }
    if (isSet(value)) {
      const out = [];
      const iter = SetPrototypeValues(value);
      let next;
      while (!(next = iter.next()).done) {
        ArrayPrototypePush(out, next.value);
      }
      return [out, false];
    }
    if (isMapIterator(value) || isSetIterator(value)) {
      const arr = ArrayFrom(value);
      if (isMapIterator(value)) {
        // Flatten [[k,v],[k,v],...] → [k,v,k,v,...]
        const out = [];
        for (let i = 0; i < arr.length; i++) {
          ArrayPrototypePush(out, arr[i][0], arr[i][1]);
        }
        return [out, true];
      }
      return [arr, false];
    }
    // WeakMap/WeakSet — not iterable. Deno's op returns the live entries
    // via a V8 internal; we can't, so return empty.
    return [[], isKeyValue];
  }

  // --- Inspector (ported from Deno, no-color) -----------------------------

  function formatValue(ctx, value, recurseTimes, typedArray) {
    if (
      typeof value !== "object" &&
      typeof value !== "function" &&
      !isUndetectableObject(value)
    ) {
      return formatPrimitive(ctx.stylize, value, ctx);
    }
    if (value === null) {
      return ctx.stylize("null", "null");
    }

    // No `core.getProxyDetails` in Limun — inspect the value directly.
    // (Proxy traps may fire; this matches Node-without-showProxy behavior
    // when the unwrap isn't available. `showProxy` is always false here.)

    // No Deno `privateCustomInspect` / node `inspect.custom` in Limun.

    if (ArrayPrototypeIncludes(ctx.seen, value)) {
      let index = 1;
      if (ctx.circular === undefined) {
        ctx.circular = new SafeMap();
        MapPrototypeSet(ctx.circular, value, index);
      } else {
        index = MapPrototypeGet(ctx.circular, value);
        if (index === undefined) {
          index = ctx.circular.size + 1;
          MapPrototypeSet(ctx.circular, value, index);
        }
      }
      return ctx.stylize(`[Circular *${index}]`, "special");
    }

    return formatRaw(ctx, value, recurseTimes, typedArray, null);
  }

  function getClassBase(value, constructor, tag) {
    const hasName = ObjectHasOwn(value, "name");
    const name = (hasName && value.name) || "(anonymous)";
    let base = `class ${name}`;
    if (constructor !== "Function" && constructor !== null) {
      base += ` [${constructor}]`;
    }
    if (tag !== "" && constructor !== tag) {
      base += ` [${tag}]`;
    }
    if (constructor !== null) {
      const superName = ObjectGetPrototypeOf(value).name;
      if (superName) {
        base += ` extends ${superName}`;
      }
    } else {
      base += " extends [null prototype]";
    }
    return `[${base}]`;
  }

  const stripCommentsRegExp = new SafeRegExp(
    "(\\/\\/.*?\\n)|(\\/\\*(.|\\n)*?\\*\\/)",
    "g",
  );
  const classRegExp = new SafeRegExp("^(\\s+[^(]*?)\\s*{");

  function getFunctionBase(value, constructor, tag) {
    const stringified = FunctionPrototypeToString(value);
    if (
      StringPrototypeStartsWith(stringified, "class") &&
      StringPrototypeEndsWith(stringified, "}")
    ) {
      const slice = StringPrototypeSlice(stringified, 5, -1);
      const bracketIndex = StringPrototypeIndexOf(slice, "{");
      if (
        bracketIndex !== -1 &&
        (!StringPrototypeIncludes(
            StringPrototypeSlice(slice, 0, bracketIndex),
            "(",
          ) ||
          RegExpPrototypeExec(
            classRegExp,
            RegExpPrototypeSymbolReplace(stripCommentsRegExp, slice),
          ) !== null)
      ) {
        return getClassBase(value, constructor, tag);
      }
    }
    let type = "Function";
    if (isGeneratorFunction(value)) {
      type = `Generator${type}`;
    }
    if (isAsyncFunction(value)) {
      type = `Async${type}`;
    }
    let base = `[${type}`;
    if (constructor === null) {
      base += " (null prototype)";
    }
    if (value.name === "") {
      base += " (anonymous)";
    } else {
      base += `: ${value.name}`;
    }
    base += "]";
    if (constructor !== type && constructor !== null) {
      base += ` ${constructor}`;
    }
    if (tag !== "" && constructor !== tag) {
      base += ` [${tag}]`;
    }
    return base;
  }

  function formatRaw(ctx, value, recurseTimes, typedArray, proxyDetails) {
    let keys;
    let protoProps;
    if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) {
      protoProps = [];
    }

    const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
    if (protoProps !== undefined && protoProps.length === 0) {
      protoProps = undefined;
    }

    let tag;
    if (!proxyDetails) {
      try {
        tag = value[SymbolToStringTag];
      } catch {
        // Symbol.toStringTag getter may throw
      }
    }
    if (typeof tag !== "string") {
      tag = "";
    }
    let base = "";
    let formatter = () => [];
    let braces;
    let noIterator = true;
    let i = 0;
    const filter = ctx.showHidden ? 0 : 2;

    let extrasType = kObjectType;

    if (proxyDetails !== null && ctx.showProxy) {
      return `Proxy ` + formatValue(ctx, proxyDetails, recurseTimes);
    } else {
      if (ReflectHas(value, SymbolIterator) || constructor === null) {
        noIterator = false;
        if (ArrayIsArray(value)) {
          const prefix = (constructor !== "Array" || tag !== "")
            ? getPrefix(constructor, tag, "Array", `(${value.length})`)
            : "";
          keys = getNonIndexPropertyNames(value, filter);
          braces = [`${prefix}[`, "]"];
          if (
            value.length === 0 && keys.length === 0 && protoProps === undefined
          ) {
            return `${braces[0]}]`;
          }
          extrasType = kArrayExtrasType;
          formatter = formatArray;
        } else if (isSet(value)) {
          const size = SetPrototypeGetSize(value);
          const prefix = getPrefix(constructor, tag, "Set", `(${size})`);
          keys = getKeys(value, ctx.showHidden);
          formatter = constructor !== null
            ? FunctionPrototypeBind(formatSet, null, value)
            : FunctionPrototypeBind(formatSet, null, SetPrototypeValues(value));
          if (size === 0 && keys.length === 0 && protoProps === undefined) {
            return `${prefix}{}`;
          }
          braces = [`${prefix}{`, "}"];
        } else if (isMap(value)) {
          const size = MapPrototypeGetSize(value);
          const prefix = getPrefix(constructor, tag, "Map", `(${size})`);
          keys = getKeys(value, ctx.showHidden);
          formatter = constructor !== null
            ? FunctionPrototypeBind(formatMap, null, value)
            : FunctionPrototypeBind(formatMap, null, MapPrototypeEntries(value));
          if (size === 0 && keys.length === 0 && protoProps === undefined) {
            return `${prefix}{}`;
          }
          braces = [`${prefix}{`, "}"];
        } else if (isTypedArray(value)) {
          const typedArr = value;
          keys = getNonIndexPropertyNames(typedArr, filter);
          const fallback = "";
          const size = TypedArrayPrototypeGetLength(typedArr);
          const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
          braces = [`${prefix}[`, "]"];
          if (typedArr.length === 0 && keys.length === 0 && !ctx.showHidden) {
            return `${braces[0]}]`;
          }
          formatter = FunctionPrototypeBind(
            formatTypedArray,
            null,
            typedArr,
            size,
          );
          extrasType = kArrayExtrasType;
        } else if (isMapIterator(value)) {
          keys = getKeys(value, ctx.showHidden);
          braces = getIteratorBraces("Map", tag);
          formatter = FunctionPrototypeBind(formatIterator, null, braces);
        } else if (isSetIterator(value)) {
          keys = getKeys(value, ctx.showHidden);
          braces = getIteratorBraces("Set", tag);
          formatter = FunctionPrototypeBind(formatIterator, null, braces);
        } else {
          noIterator = true;
        }
      }
      if (noIterator) {
        keys = getKeys(value, ctx.showHidden);
        braces = ["{", "}"];
        if (constructor === "Object") {
          if (isArgumentsObject(value)) {
            braces[0] = "[Arguments] {";
          } else if (tag !== "") {
            braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
          }
          if (keys.length === 0 && protoProps === undefined) {
            return `${braces[0]}}`;
          }
        } else if (typeof value === "function") {
          base = getFunctionBase(value, constructor, tag);
          if (keys.length === 0 && protoProps === undefined) {
            return ctx.stylize(base, "special");
          }
        } else if (isRegExp(value)) {
          base = RegExpPrototypeToString(
            constructor !== null ? value : new SafeRegExp(value),
          );
          const prefix = getPrefix(constructor, tag, "RegExp");
          if (prefix !== "RegExp ") {
            base = `${prefix}${base}`;
          }
          if (
            (keys.length === 0 && protoProps === undefined) ||
            (recurseTimes > ctx.depth && ctx.depth !== null)
          ) {
            return ctx.stylize(base, "regexp");
          }
        } else if (isDate(value)) {
          base = NumberIsNaN(DatePrototypeGetTime(value))
            ? DatePrototypeToString(value)
            : DatePrototypeToISOString(value);
          const prefix = getPrefix(constructor, tag, "Date");
          if (prefix !== "Date ") {
            base = `${prefix}${base}`;
          }
          if (keys.length === 0 && protoProps === undefined) {
            return ctx.stylize(base, "date");
          }
        } else if (isError(value) || isNativeError(value)) {
          base = formatError(value, constructor, tag, ctx, keys);
          if (keys.length === 0 && protoProps === undefined) {
            return base;
          }
        } else if (isAnyArrayBuffer(value)) {
          const arrayType = "ArrayBuffer";
          const prefix = getPrefix(constructor, tag, arrayType);
          if (typedArray === undefined) {
            formatter = formatArrayBuffer;
          } else if (keys.length === 0 && protoProps === undefined) {
            return prefix +
              `{ byteLength: ${
                formatNumber(ctx.stylize, ArrayBufferPrototypeGetByteLength(value))
              } }`;
          }
          braces[0] = `${prefix}{`;
          ArrayPrototypeUnshift(keys, "byteLength");
        } else if (isDataView(value)) {
          braces[0] = `${getPrefix(constructor, tag, "DataView")}{`;
          ArrayPrototypeUnshift(keys, "byteLength", "byteOffset", "buffer");
        } else if (isPromise(value)) {
          braces[0] = `${getPrefix(constructor, tag, "Promise")}{`;
          formatter = formatPromise;
        } else if (isWeakSet(value)) {
          braces[0] = `${getPrefix(constructor, tag, "WeakSet")}{`;
          formatter = ctx.showHidden ? formatWeakSet : formatWeakCollection;
        } else if (isWeakMap(value)) {
          braces[0] = `${getPrefix(constructor, tag, "WeakMap")}{`;
          formatter = ctx.showHidden ? formatWeakMap : formatWeakCollection;
        } else if (isModuleNamespaceObject(value)) {
          braces[0] = `${getPrefix(constructor, tag, "Module")}{`;
          formatter = FunctionPrototypeBind(formatNamespaceObject, null, keys);
        } else if (isBoxedPrimitive(value)) {
          base = getBoxedBase(value, ctx, keys, constructor, tag);
          if (keys.length === 0 && protoProps === undefined) {
            return base;
          }
        } else {
          if (keys.length === 0 && protoProps === undefined) {
            return `${getCtxStyle(value, constructor, tag)}{}`;
          }
          braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
        }
      }
    }

    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      let constructorName = StringPrototypeSlice(
        getCtxStyle(value, constructor, tag),
        0,
        -1,
      );
      if (constructor !== null) {
        constructorName = `[${constructorName}]`;
      }
      return ctx.stylize(constructorName, "special");
    }
    recurseTimes += 1;

    ArrayPrototypePush(ctx.seen, value);
    ctx.currentDepth = recurseTimes;
    let output;
    try {
      output = formatter(ctx, value, recurseTimes);
      for (i = 0; i < keys.length; i++) {
        ArrayPrototypePush(
          output,
          formatProperty(ctx, value, recurseTimes, keys[i], extrasType),
        );
      }
      if (protoProps !== undefined) {
        ArrayPrototypePushApply(output, protoProps);
      }
    } catch (error) {
      return ctx.stylize(
        `[Internal Formatting Error] ${error.stack}`,
        "internalError",
      );
    }

    if (ctx.circular !== undefined) {
      const index = MapPrototypeGet(ctx.circular, value);
      if (index !== undefined) {
        const reference = ctx.stylize(`<ref *${index}>`, "special");
        if (ctx.compact !== true) {
          base = base === "" ? reference : `${reference} ${base}`;
        } else {
          braces[0] = `${reference} ${braces[0]}`;
        }
      }
    }
    ArrayPrototypePop(ctx.seen);

    if (ctx.sorted) {
      const comparator = ctx.sorted === true ? undefined : ctx.sorted;
      if (extrasType === kObjectType) {
        output = ArrayPrototypeSort(output, comparator);
      } else if (keys.length > 1) {
        const sorted = ArrayPrototypeSort(
          ArrayPrototypeSlice(output, output.length - keys.length),
          comparator,
        );
        ArrayPrototypeSplice(
          output,
          output.length - keys.length,
          keys.length,
          ...new SafeArrayIterator(sorted),
        );
      }
    }

    const res = reduceToSingleString(
      ctx,
      output,
      base,
      braces,
      extrasType,
      recurseTimes,
      value,
    );
    const budget = ctx.budget[ctx.indentationLvl] || 0;
    const newLength = budget + res.length;
    ctx.budget[ctx.indentationLvl] = newLength;
    if (newLength > 2 ** 27) {
      ctx.depth = -1;
    }
    return res;
  }

  const builtInObjectsRegExp = new SafeRegExp("^[A-Z][a-zA-Z0-9]+$");
  const builtInObjects = new SafeSet(
    ArrayPrototypeFilter(
      ObjectGetOwnPropertyNames(globalThis),
      (e) => RegExpPrototypeTest(builtInObjectsRegExp, e),
    ),
  );

  function addPrototypeProperties(ctx, main, obj, recurseTimes, output) {
    let depth = 0;
    let keys;
    let keySet;
    do {
      if (depth !== 0 || main === obj) {
        obj = ObjectGetPrototypeOf(obj);
        if (obj === null) {
          return;
        }
        const descriptor = ObjectGetOwnPropertyDescriptor(obj, "constructor");
        if (
          descriptor !== undefined &&
          typeof descriptor.value === "function" &&
          SetPrototypeHas(builtInObjects, descriptor.value.name)
        ) {
          return;
        }
      }

      if (depth === 0) {
        keySet = new SafeSet();
      } else {
        ArrayPrototypeForEach(keys, (key) => SetPrototypeAdd(keySet, key));
      }
      keys = ReflectOwnKeys(obj);
      ArrayPrototypePush(ctx.seen, main);
      for (const key of new SafeArrayIterator(keys)) {
        if (
          key === "constructor" ||
          ObjectHasOwn(main, key) ||
          (depth !== 0 && SetPrototypeHas(keySet, key))
        ) {
          continue;
        }
        const desc = ObjectGetOwnPropertyDescriptor(obj, key);
        if (typeof desc.value === "function") {
          continue;
        }
        const value = formatProperty(
          ctx,
          obj,
          recurseTimes,
          key,
          kObjectType,
          desc,
          main,
        );
        ArrayPrototypePush(output, value);
      }
      ArrayPrototypePop(ctx.seen);
    } while (++depth !== 3);
  }

  function isInstanceof(proto, object) {
    try {
      return ObjectPrototypeIsPrototypeOf(proto, object);
    } catch {
      return false;
    }
  }

  const wellKnownPrototypes = new SafeMap()
    .set(Array.prototype, { name: "Array", constructor: Array })
    .set(ArrayBufferPrototype, {
      name: "ArrayBuffer",
      constructor: ArrayBuffer,
    })
    .set(FunctionPrototype, { name: "Function", constructor: Function })
    .set(MapPrototype, { name: "Map", constructor: Map })
    .set(SetPrototype, { name: "Set", constructor: Set })
    .set(ObjectPrototype, { name: "Object", constructor: Object })
    .set(TypedArrayPrototype, { name: "TypedArray", constructor: TypedArray })
    .set(RegExpPrototype, { name: "RegExp", constructor: RegExp })
    .set(DatePrototype, { name: "Date", constructor: Date })
    .set(DataViewPrototype, { name: "DataView", constructor: DataView })
    .set(ErrorPrototype, { name: "Error", constructor: Error })
    .set(AggregateErrorPrototype, {
      name: "AggregateError",
      constructor: AggregateError,
    })
    .set(RangeErrorPrototype, { name: "RangeError", constructor: RangeError })
    .set(TypeErrorPrototype, { name: "TypeError", constructor: TypeError })
    .set(BooleanPrototype, { name: "Boolean", constructor: Boolean })
    .set(NumberPrototype, { name: "Number", constructor: Number })
    .set(StringPrototype, { name: "String", constructor: String })
    .set(PromisePrototype, { name: "Promise", constructor: Promise })
    .set(WeakMapPrototype, { name: "WeakMap", constructor: WeakMap })
    .set(WeakSetPrototype, { name: "WeakSet", constructor: WeakSet });

  function getConstructorName(obj, ctx, recurseTimes, protoProps) {
    let firstProto;
    const tmp = obj;
    while (obj || isUndetectableObject(obj)) {
      const wellKnownPrototypeNameAndConstructor = wellKnownPrototypes.get(obj);
      if (wellKnownPrototypeNameAndConstructor !== undefined) {
        const { name, constructor } = wellKnownPrototypeNameAndConstructor;
        if (FunctionPrototypeSymbolHasInstance(constructor, tmp)) {
          if (protoProps !== undefined && firstProto !== obj) {
            addPrototypeProperties(
              ctx,
              tmp,
              firstProto || tmp,
              recurseTimes,
              protoProps,
            );
          }
          return name;
        }
      }
      let descriptor;
      try {
        descriptor = ObjectGetOwnPropertyDescriptor(obj, "constructor");
      } catch {
        /* this could fail */
      }
      if (
        descriptor !== undefined &&
        typeof descriptor.value === "function" &&
        descriptor.value.name !== "" &&
        isInstanceof(descriptor.value.prototype, tmp)
      ) {
        if (
          protoProps !== undefined &&
          (firstProto !== obj ||
            !SetPrototypeHas(builtInObjects, descriptor.value.name))
        ) {
          addPrototypeProperties(
            ctx,
            tmp,
            firstProto || tmp,
            recurseTimes,
            protoProps,
          );
        }
        return String(descriptor.value.name);
      }

      obj = ObjectGetPrototypeOf(obj);
      if (firstProto === undefined) {
        firstProto = obj;
      }
    }

    if (firstProto === null) {
      return null;
    }

    const res = getConstructorNameOp(tmp);

    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      return `${res} <Complex prototype>`;
    }

    const protoConstr = getConstructorName(
      firstProto,
      ctx,
      recurseTimes + 1,
      protoProps,
    );

    if (protoConstr === null) {
      return `${res} <${
        inspect(firstProto, {
          ...ctx,
          customInspect: false,
          depth: -1,
        })
      }>`;
    }

    return `${res} <${protoConstr}>`;
  }

  const formatPrimitiveRegExp = new SafeRegExp("(?<=\n)");
  function formatPrimitive(fn, value, ctx) {
    if (typeof value === "string") {
      let trailer = "";
      if (value.length > ctx.maxStringLength) {
        const remaining = value.length - ctx.maxStringLength;
        value = StringPrototypeSlice(value, 0, ctx.maxStringLength);
        trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`;
      }
      if (
        ctx.compact !== true &&
        value.length > kMinLineLength &&
        value.length > ctx.breakLength - ctx.indentationLvl - 4
      ) {
        return ArrayPrototypeJoin(
          ArrayPrototypeMap(
            StringPrototypeSplit(value, formatPrimitiveRegExp),
            (line) => fn(quoteString(line, ctx), "string"),
          ),
          ` +\n${StringPrototypeRepeat(" ", ctx.indentationLvl + 2)}`,
        ) + trailer;
      }
      return fn(quoteString(value, ctx), "string") + trailer;
    }
    if (typeof value === "number") {
      return formatNumber(fn, value);
    }
    if (typeof value === "bigint") {
      return formatBigInt(fn, value);
    }
    if (typeof value === "boolean") {
      return fn(`${value}`, "boolean");
    }
    if (typeof value === "undefined") {
      return fn("undefined", "undefined");
    }
    return fn(maybeQuoteSymbol(value, ctx), "symbol");
  }

  function getPrefix(constructor, tag, fallback, size = "") {
    if (constructor === null) {
      if (tag !== "" && fallback !== tag) {
        return `[${fallback}${size}: null prototype] [${tag}] `;
      }
      return `[${fallback}${size}: null prototype] `;
    }
    if (tag !== "" && constructor !== tag) {
      return `${constructor}${size} [${tag}] `;
    }
    return `${constructor}${size} `;
  }

  function formatArray(ctx, value, recurseTimes) {
    const valLen = value.length;
    const len = MathMin(MathMax(0, ctx.maxArrayLength), valLen);

    const remaining = valLen - len;
    const output = [];
    for (let i = 0; i < len; i++) {
      if (!ObjectHasOwn(value, i)) {
        return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
      }
      ArrayPrototypePush(
        output,
        formatProperty(ctx, value, recurseTimes, i, kArrayType),
      );
    }
    if (remaining > 0) {
      ArrayPrototypePush(
        output,
        `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
      );
    }
    return output;
  }

  function getCtxStyle(value, constructor, tag) {
    let fallback = "";
    if (constructor === null) {
      fallback = getConstructorNameOp(value);
      if (fallback === tag) {
        fallback = "Object";
      }
    }
    return getPrefix(constructor, tag, fallback);
  }

  function getKeys(value, showHidden) {
    let keys;
    let symbols;
    try {
      symbols = ObjectGetOwnPropertySymbols(value);
    } catch {
      symbols = [];
    }
    if (showHidden) {
      try {
        keys = ObjectGetOwnPropertyNames(value);
      } catch {
        keys = [];
      }
      if (symbols.length !== 0) {
        ArrayPrototypePushApply(keys, symbols);
      }
    } else {
      try {
        keys = ObjectKeys(value);
      } catch {
        try {
          keys = ObjectGetOwnPropertyNames(value);
        } catch {
          keys = [];
        }
      }
      if (symbols.length !== 0) {
        const filter = (key) => {
          try {
            return ObjectPrototypePropertyIsEnumerable(value, key);
          } catch {
            return false;
          }
        };
        ArrayPrototypePushApply(keys, ArrayPrototypeFilter(symbols, filter));
      }
    }
    if (ObjectPrototypeIsPrototypeOf(ErrorPrototype, value)) {
      keys = ArrayPrototypeFilter(keys, (key) => key !== "cause");
    }
    return keys;
  }

  function formatSet(value, ctx, _ignored, recurseTimes) {
    ctx.indentationLvl += 2;

    const values = [...new SafeSetIterator(value)];
    const valLen = SetPrototypeGetSize(value);
    const len = MathMin(MathMax(0, ctx.iterableLimit), valLen);

    const remaining = valLen - len;
    const output = [];
    for (let i = 0; i < len; i++) {
      ArrayPrototypePush(output, formatValue(ctx, values[i], recurseTimes));
    }
    if (remaining > 0) {
      ArrayPrototypePush(
        output,
        `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
      );
    }

    ctx.indentationLvl -= 2;
    return output;
  }

  function formatMap(value, ctx, _ignored, recurseTimes) {
    ctx.indentationLvl += 2;

    const values = [...new SafeMapIterator(value)];
    const valLen = MapPrototypeGetSize(value);
    const len = MathMin(MathMax(0, ctx.iterableLimit), valLen);

    const remaining = valLen - len;
    const output = [];
    for (let i = 0; i < len; i++) {
      ArrayPrototypePush(
        output,
        `${formatValue(ctx, values[i][0], recurseTimes)} => ${
          formatValue(ctx, values[i][1], recurseTimes)
        }`,
      );
    }
    if (remaining > 0) {
      ArrayPrototypePush(
        output,
        `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
      );
    }

    ctx.indentationLvl -= 2;
    return output;
  }

  function formatTypedArray(value, length, ctx, _ignored, recurseTimes) {
    const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
    const remaining = value.length - maxLength;
    const output = [];
    const elementFormatter = value.length > 0 && typeof value[0] === "number"
      ? formatNumber
      : formatBigInt;
    for (let i = 0; i < maxLength; ++i) {
      output[i] = elementFormatter(ctx.stylize, value[i]);
    }
    if (remaining > 0) {
      output[maxLength] = `... ${remaining} more item${
        remaining > 1 ? "s" : ""
      }`;
    }
    if (ctx.showHidden) {
      ctx.indentationLvl += 2;
      for (
        const key of new SafeArrayIterator([
          "BYTES_PER_ELEMENT",
          "length",
          "byteLength",
          "byteOffset",
          "buffer",
        ])
      ) {
        const str = formatValue(ctx, value[key], recurseTimes, true);
        ArrayPrototypePush(output, `[${key}]: ${str}`);
      }
      ctx.indentationLvl -= 2;
    }
    return output;
  }

  function getIteratorBraces(type, tag) {
    if (tag !== `${type} Iterator`) {
      if (tag !== "") {
        tag += "] [";
      }
      tag += `${type} Iterator`;
    }
    return [`[${tag}] {`, "}"];
  }

  const iteratorRegExp = new SafeRegExp(" Iterator] {$");
  function formatIterator(braces, ctx, value, recurseTimes) {
    const { 0: entries, 1: isKeyValue } = previewEntries(value, true);
    if (isKeyValue) {
      braces[0] = StringPrototypeReplace(
        braces[0],
        iteratorRegExp,
        " Entries] {",
      );
      return formatMapIterInner(ctx, recurseTimes, entries, kMapEntries);
    }
    return formatSetIterInner(ctx, recurseTimes, entries, kIterator);
  }

  function getStackString(ctx, error) {
    let stack;
    try {
      stack = error.stack;
    } catch {
      // If stack is getter that throws, we ignore the error.
    }
    if (stack) {
      if (typeof stack === "string") {
        return stack;
      }
      ArrayPrototypePush(ctx.seen, error);
      ctx.indentationLvl += 4;
      const result = formatValue(ctx, stack);
      ctx.indentationLvl -= 4;
      ArrayPrototypePop(ctx.seen);
      return `${ErrorPrototypeToString(error)}\n    ${result}`;
    }
    return ErrorPrototypeToString(error);
  }

  function improveStack(stack, constructor, name, tag) {
    let len = name.length;

    if (typeof name !== "string") {
      stack = StringPrototypeReplace(
        stack,
        `${name}`,
        `${name} [${
          StringPrototypeSlice(getPrefix(constructor, tag, "Error"), 0, -1)
        }]`,
      );
    }

    if (
      constructor === null ||
      (StringPrototypeEndsWith(name, "Error") &&
        StringPrototypeStartsWith(stack, name) &&
        (stack.length === len || stack[len] === ":" || stack[len] === "\n"))
    ) {
      let fallback = "Error";
      if (constructor === null) {
        const start = RegExpPrototypeExec(
          new SafeRegExp(/^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/),
          stack,
        ) ||
          RegExpPrototypeExec(new SafeRegExp(/^([a-z_A-Z0-9-]*Error)$/), stack);
        fallback = (start?.[1]) || "";
        len = fallback.length;
        fallback ||= "Error";
      }
      const prefix = StringPrototypeSlice(
        getPrefix(constructor, tag, fallback),
        0,
        -1,
      );
      if (name !== prefix) {
        if (StringPrototypeIncludes(prefix, name)) {
          if (len === 0) {
            stack = `${prefix}: ${stack}`;
          } else {
            stack = `${prefix}${StringPrototypeSlice(stack, len)}`;
          }
        } else {
          stack = `${prefix} [${name}]${StringPrototypeSlice(stack, len)}`;
        }
      }
    }
    return stack;
  }

  function getDuplicateErrorFrameRanges(frames) {
    const result = [];
    const lineToPositions = new SafeMap();

    for (let i = 0; i < frames.length; i++) {
      const positions = MapPrototypeGet(lineToPositions, frames[i]);
      if (positions === undefined) {
        MapPrototypeSet(lineToPositions, frames[i], [i]);
      } else {
        positions[positions.length] = i;
      }
    }

    const minimumDuplicateRange = 3;
    if (frames.length - lineToPositions.size <= minimumDuplicateRange) {
      return result;
    }

    for (let i = 0; i < frames.length - minimumDuplicateRange; i++) {
      const positions = MapPrototypeGet(lineToPositions, frames[i]);
      if (positions.length === 1 || positions[positions.length - 1] === i) {
        continue;
      }

      const current = ArrayPrototypeIndexOf(positions, i) + 1;
      if (current === positions.length) {
        continue;
      }

      let range = positions[positions.length - 1] - i;
      if (range < minimumDuplicateRange) {
        continue;
      }
      let extraSteps;
      if (current + 1 < positions.length) {
        let gcdRange = 0;
        for (let j = current; j < positions.length; j++) {
          let distance = positions[j] - i;
          while (distance !== 0) {
            const remainder = gcdRange % distance;
            if (gcdRange !== 0) {
              extraSteps ??= new SafeSet();
              SetPrototypeAdd(extraSteps, gcdRange);
            }
            gcdRange = distance;
            distance = remainder;
          }
          if (gcdRange === 1) break;
        }
        range = gcdRange;
        if (extraSteps) {
          SetPrototypeDelete(extraSteps, range);
          extraSteps = ArrayFrom(extraSteps);
        }
      }
      let maxRange = range;
      let maxDuplicates = 0;

      let duplicateRanges = 0;

      for (let nextStart = i + range;; nextStart += range) {
        let equalFrames = 0;
        for (let j = 0; j < range; j++) {
          if (frames[i + j] !== frames[nextStart + j]) {
            break;
          }
          equalFrames++;
        }
        if (equalFrames !== range) {
          if (!extraSteps?.length) {
            break;
          }
          if (
            duplicateRanges !== 0 &&
            maxRange * maxDuplicates < range * duplicateRanges
          ) {
            maxRange = range;
            maxDuplicates = duplicateRanges;
          }
          range = ArrayPrototypePop(extraSteps);
          nextStart = i;
          duplicateRanges = 0;
          continue;
        }
        duplicateRanges++;
      }

      if (
        maxDuplicates !== 0 &&
        maxRange * maxDuplicates >= range * duplicateRanges
      ) {
        range = maxRange;
        duplicateRanges = maxDuplicates;
      }

      if (duplicateRanges * range >= 3) {
        ArrayPrototypePush(result, i + range, range, duplicateRanges);
        i += range * (duplicateRanges + 1) - 1;
      }
    }

    return result;
  }

  function identicalSequenceRange(a, b) {
    for (let i = 0; i < a.length - 3; i++) {
      const pos = ArrayPrototypeIndexOf(b, a[i]);
      if (pos !== -1) {
        const rest = b.length - pos;
        if (rest > 3) {
          let len = 1;
          const maxLen = MathMin(a.length - i, rest);
          while (maxLen > len && a[i + len] === b[pos + len]) {
            len++;
          }
          if (len > 3) {
            return [len, i];
          }
        }
      }
    }
    return [0, 0];
  }

  function getStackFrames(ctx, err, stack) {
    const frames = StringPrototypeSplit(stack, "\n");

    let cause;
    try {
      ({ cause } = err);
    } catch {
      // If 'cause' is a getter that throws, ignore it.
    }

    if (
      cause != null &&
      (isNativeError(cause) || FunctionPrototypeSymbolHasInstance(Error, cause))
    ) {
      const causeStack = getStackString(ctx, cause);
      const causeStackStart = StringPrototypeIndexOf(causeStack, "\n    at");
      if (causeStackStart !== -1) {
        const causeFrames = StringPrototypeSplit(
          StringPrototypeSlice(causeStack, causeStackStart + 1),
          "\n",
        );
        const { 0: len, 1: offset } = identicalSequenceRange(
          frames,
          causeFrames,
        );
        if (len > 0) {
          const skipped = len - 2;
          const msg =
            `    ... ${skipped} lines matching cause stack trace ...`;
          ArrayPrototypeSplice(
            frames,
            offset + 1,
            skipped,
            ctx.stylize(msg, "undefined"),
          );
        }
      }
    }

    if (frames.length > 10) {
      const ranges = getDuplicateErrorFrameRanges(frames);

      for (let i = ranges.length - 3; i >= 0; i -= 3) {
        const offset = ranges[i];
        const length = ranges[i + 1];
        const duplicateRanges = ranges[i + 2];

        const msg =
          `    ... collapsed ${length * duplicateRanges} duplicate lines ` +
          "matching above " +
          (duplicateRanges > 1
            ? `${length} lines ${duplicateRanges} times...`
            : "lines ...");
        ArrayPrototypeSplice(
          frames,
          offset,
          length * duplicateRanges,
          ctx.stylize(msg, "undefined"),
        );
      }
    }

    return frames;
  }

  function formatError(err, constructor, tag, ctx, keys) {
    let message, name, stack;
    try {
      stack = getStackString(ctx, err);
    } catch {
      return ObjectPrototypeToString(err);
    }

    let messageIsGetterThatThrows = false;
    try {
      message = err.message;
    } catch {
      messageIsGetterThatThrows = true;
    }
    let nameIsGetterThatThrows = false;
    try {
      name = err.name;
    } catch {
      nameIsGetterThatThrows = true;
    }

    if (!ctx.showHidden && keys.length !== 0) {
      const index = ArrayPrototypeIndexOf(keys, "stack");
      if (index !== -1) {
        ArrayPrototypeSplice(keys, index, 1);
      }

      if (!messageIsGetterThatThrows) {
        const index = ArrayPrototypeIndexOf(keys, "message");
        if (
          index !== -1 &&
          (typeof message !== "string" ||
            StringPrototypeIncludes(stack, message))
        ) {
          ArrayPrototypeSplice(keys, index, 1);
        }
      }

      if (!nameIsGetterThatThrows) {
        const index = ArrayPrototypeIndexOf(keys, "name");
        if (
          index !== -1 &&
          (typeof name !== "string" || StringPrototypeIncludes(stack, name))
        ) {
          ArrayPrototypeSplice(keys, index, 1);
        }
      }
    }
    name ??= "Error";

    if (
      ReflectHas(err, "cause") &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, "cause"))
    ) {
      ArrayPrototypePush(keys, "cause");
    }

    try {
      const errors = err.errors;
      if (
        ArrayIsArray(errors) &&
        (keys.length === 0 || !ArrayPrototypeIncludes(keys, "errors"))
      ) {
        ArrayPrototypePush(keys, "errors");
      }
    } catch {
      // If errors is a getter that throws, we ignore the error.
    }

    stack = improveStack(stack, constructor, name, tag);

    let pos = (message && StringPrototypeIndexOf(stack, message)) || -1;
    if (pos !== -1) {
      pos += message.length;
    }
    const stackStart = StringPrototypeIndexOf(stack, "\n    at", pos);
    if (stackStart === -1) {
      stack = `[${stack}]`;
    } else {
      let newStack = StringPrototypeSlice(stack, 0, stackStart);
      const stackFramePart = StringPrototypeSlice(stack, stackStart + 1);
      const lines = getStackFrames(ctx, err, stackFramePart);
      // No color/CSS path — no cwd/node_modules highlighting.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        newStack += `\n${line}`;
      }
      stack = newStack;
    }
    if (ctx.indentationLvl !== 0) {
      const indentation = StringPrototypeRepeat(" ", ctx.indentationLvl);
      stack = StringPrototypeReplaceAll(stack, "\n", `\n${indentation}`);
    }
    return stack;
  }

  const hexSliceLookupTable = (function () {
    const alphabet = "0123456789abcdef";
    const table = [];
    for (let i = 0; i < 16; ++i) {
      const i16 = i * 16;
      for (let j = 0; j < 16; ++j) {
        table[i16 + j] = alphabet[i] + alphabet[j];
      }
    }
    return table;
  })();

  function hexSlice(buf, start, end) {
    const len = TypedArrayPrototypeGetLength(buf);
    if (!start || start < 0) {
      start = 0;
    }
    if (!end || end < 0 || end > len) {
      end = len;
    }
    let out = "";
    for (let i = start; i < end; ++i) {
      out += hexSliceLookupTable[buf[i]];
    }
    return out;
  }

  const arrayBufferRegExp = new SafeRegExp("(.{2})", "g");
  function formatArrayBuffer(ctx, value) {
    let valLen;
    try {
      valLen = ArrayBufferPrototypeGetByteLength(value);
    } catch {
      valLen = 0;
    }
    const len = MathMin(MathMax(0, ctx.maxArrayLength), valLen);
    let buffer;
    try {
      buffer = new Uint8Array(value, 0, len);
    } catch {
      return [ctx.stylize("(detached)", "special")];
    }
    let str = StringPrototypeTrim(
      StringPrototypeReplace(hexSlice(buffer), arrayBufferRegExp, "$1 "),
    );

    const remaining = valLen - len;
    if (remaining > 0) {
      str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
    }
    return [`${ctx.stylize("[Uint8Contents]", "special")}: <${str}>`];
  }

  function formatNumber(fn, value) {
    return fn(ObjectIs(value, -0) ? "-0" : `${value}`, "number");
  }

  // `core.getPromiseDetails` not available in Limun — Promise inspected as
  // `<pending>` (we can't read internal state without the V8 op). This is a
  // documented deviation: Deno shows `<pending>`/`<rejected> ...`/value; we
  // always show `<pending>`.
  function formatPromise(ctx, _value, _recurseTimes) {
    return [ctx.stylize("<pending>", "special")];
  }

  function formatWeakCollection(ctx) {
    return [ctx.stylize("<items unknown>", "special")];
  }

  function formatWeakSet(ctx, value, recurseTimes) {
    const { 0: entries } = previewEntries(value, false);
    return formatSetIterInner(ctx, recurseTimes, entries, kWeak);
  }

  function formatWeakMap(ctx, value, recurseTimes) {
    const { 0: entries } = previewEntries(value, false);
    return formatMapIterInner(ctx, recurseTimes, entries, kWeak);
  }

  function formatProperty(
    ctx,
    value,
    recurseTimes,
    key,
    type,
    desc,
    original = value,
  ) {
    let name, str;
    let extra = " ";
    desc = desc || ObjectGetOwnPropertyDescriptor(value, key) ||
      { value: value[key], enumerable: true };
    if (desc.value !== undefined) {
      const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
      ctx.indentationLvl += diff;
      str = formatValue(ctx, desc.value, recurseTimes);
      if (diff === 3 && ctx.breakLength < getStringWidth(str)) {
        extra = `\n${StringPrototypeRepeat(" ", ctx.indentationLvl)}`;
      }
      ctx.indentationLvl -= diff;
    } else if (desc.get !== undefined) {
      const label = desc.set !== undefined ? "Getter/Setter" : "Getter";
      const s = ctx.stylize;
      const sp = "special";
      if (
        ctx.getters && (ctx.getters === true ||
          (ctx.getters === "get" && desc.set === undefined) ||
          (ctx.getters === "set" && desc.set !== undefined))
      ) {
        try {
          const tmp = FunctionPrototypeCall(desc.get, original);
          ctx.indentationLvl += 2;
          if (tmp === null) {
            str = `${s(`[${label}:`, sp)} ${s("null", "null")}${s("]", sp)}`;
          } else if (typeof tmp === "object") {
            str = `${s(`[${label}]`, sp)} ${
              formatValue(ctx, tmp, recurseTimes)
            }`;
          } else {
            const primitive = formatPrimitive(s, tmp, ctx);
            str = `${s(`[${label}:`, sp)} ${primitive}${s("]", sp)}`;
          }
          ctx.indentationLvl -= 2;
        } catch (err) {
          const message = `<Inspection threw (${err.message})>`;
          str = `${s(`[${label}:`, sp)} ${message}${s("]", sp)}`;
        }
      } else {
        str = ctx.stylize(`[${label}]`, sp);
      }
    } else if (desc.set !== undefined) {
      str = ctx.stylize("[Setter]", "special");
    } else {
      str = ctx.stylize("undefined", "undefined");
    }
    if (type === kArrayType) {
      return str;
    }
    if (typeof key === "symbol") {
      const tmp = RegExpPrototypeSymbolReplace(
        strEscapeSequencesReplacer,
        SymbolPrototypeToString(key),
        escapeFn,
      );
      name = ctx.stylize(tmp, "symbol");
    } else if (RegExpPrototypeTest(keyStrRegExp, key)) {
      name = key === "__proto__" ? "['__proto__']" : ctx.stylize(key, "name");
    } else {
      name = ctx.stylize(quoteString(key, ctx), "string");
    }

    if (desc.enumerable === false) {
      name = `[${name}]`;
    }
    return `${name}:${extra}${str}`;
  }

  function isBelowBreakLength(ctx, output, start, base) {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) {
      return false;
    }
    for (let i = 0; i < output.length; i++) {
      totalLength += output[i].length;
      if (totalLength > ctx.breakLength) {
        return false;
      }
    }
    return base === "" || !StringPrototypeIncludes(base, "\n");
  }

  function formatBigInt(fn, value) {
    return fn(`${value}n`, "bigint");
  }

  function formatNamespaceObject(keys, ctx, value, recurseTimes) {
    const output = [];
    for (let i = 0; i < keys.length; i++) {
      try {
        output[i] = formatProperty(
          ctx,
          value,
          recurseTimes,
          keys[i],
          kObjectType,
        );
      } catch (_err) {
        const tmp = { [keys[i]]: "" };
        output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
        const pos = StringPrototypeLastIndexOf(output[i], " ");
        output[i] = StringPrototypeSlice(output[i], 0, pos + 1) +
          ctx.stylize("<uninitialized>", "special");
      }
    }
    keys.length = 0;
    return output;
  }

  function formatSpecialArray(
    ctx,
    value,
    recurseTimes,
    maxLength,
    output,
    i,
  ) {
    const keys = ObjectKeys(value);
    let index = i;
    for (; i < keys.length && output.length < maxLength; i++) {
      const key = keys[i];
      const tmp = +key;
      if (tmp > 2 ** 32 - 2) {
        break;
      }
      if (`${index}` !== key) {
        if (!RegExpPrototypeTest(numberRegExp, key)) {
          break;
        }
        const emptyItems = tmp - index;
        const ending = emptyItems > 1 ? "s" : "";
        const message = `<${emptyItems} empty item${ending}>`;
        ArrayPrototypePush(output, ctx.stylize(message, "undefined"));
        index = tmp;
        if (output.length === maxLength) {
          break;
        }
      }
      ArrayPrototypePush(
        output,
        formatProperty(ctx, value, recurseTimes, key, kArrayType),
      );
      index++;
    }
    const remaining = value.length - index;
    if (output.length !== maxLength) {
      if (remaining > 0) {
        const ending = remaining > 1 ? "s" : "";
        const message = `<${remaining} empty item${ending}>`;
        ArrayPrototypePush(output, ctx.stylize(message, "undefined"));
      }
    } else if (remaining > 0) {
      ArrayPrototypePush(
        output,
        `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
      );
    }
    return output;
  }

  function getBoxedBase(value, ctx, keys, constructor, tag) {
    let type, primitive;
    if (isNumberObject(value)) {
      type = "Number";
      primitive = NumberPrototypeValueOf(value);
    } else if (isStringObject(value)) {
      type = "String";
      primitive = StringPrototypeValueOf(value);
      ArrayPrototypeSplice(keys, 0, value.length);
    } else if (isBooleanObject(value)) {
      type = "Boolean";
      primitive = BooleanPrototypeValueOf(value);
    } else if (isBigIntObject(value)) {
      type = "BigInt";
      primitive = BigIntPrototypeValueOf(value);
    } else {
      type = "Symbol";
      primitive = SymbolPrototypeValueOf(value);
    }

    let base = `[${type}`;
    if (type !== constructor) {
      if (constructor === null) {
        base += " (null prototype)";
      } else {
        base += ` (${constructor})`;
      }
    }
    base += `: ${formatPrimitive(stylizeNoColor, primitive, ctx)}]`;
    if (tag !== "" && tag !== constructor) {
      base += ` [${tag}]`;
    }
    if (keys.length !== 0 || ctx.stylize === stylizeNoColor) {
      return base;
    }
    return ctx.stylize(base, StringPrototypeToLowerCase(type));
  }

  function reduceToSingleString(
    ctx,
    output,
    base,
    braces,
    extrasType,
    recurseTimes,
    value,
  ) {
    if (ctx.compact !== true) {
      if (typeof ctx.compact === "number" && ctx.compact >= 1) {
        const entries = output.length;
        if (extrasType === kArrayExtrasType && entries > 6) {
          output = groupArrayElements(ctx, output, value);
        }
        if (
          ctx.currentDepth - recurseTimes < ctx.compact &&
          entries === output.length
        ) {
          const start = output.length + ctx.indentationLvl +
            braces[0].length + base.length + 10;
          if (isBelowBreakLength(ctx, output, start, base)) {
            const joinedOutput = ArrayPrototypeJoin(output, ", ");
            if (!StringPrototypeIncludes(joinedOutput, "\n")) {
              return `${base ? `${base} ` : ""}${braces[0]} ${
                joinedOutput
              } ${braces[1]}`;
            }
          }
        }
      }
      const indentation = `\n${StringPrototypeRepeat(" ", ctx.indentationLvl)}`;
      return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ` +
        `${ArrayPrototypeJoin(output, `,${indentation}  `)}${
          ctx.trailingComma ? "," : ""
        }${indentation}${braces[1]}`;
    }
    if (isBelowBreakLength(ctx, output, 0, base)) {
      return `${braces[0]}${base ? ` ${base}` : ""} ${
        ArrayPrototypeJoin(output, ", ")
      } ${braces[1]}`;
    }
    const indentation = StringPrototypeRepeat(" ", ctx.indentationLvl);
    const ln = base === "" && braces[0].length === 1
      ? " "
      : `${base ? ` ${base}` : ""}\n${indentation}  `;
    return `${braces[0]}${ln}${
      ArrayPrototypeJoin(output, `,\n${indentation}  `)
    } ${braces[1]}`;
  }

  function groupArrayElements(ctx, output, value) {
    let totalLength = 0;
    let maxLength = 0;
    let i = 0;
    let outputLength = output.length;
    if (ctx.maxArrayLength < output.length) {
      outputLength--;
    }
    const separatorSpace = 2;
    const dataLen = [];
    for (; i < outputLength; i++) {
      const len = getStringWidth(output[i]);
      dataLen[i] = len;
      totalLength += len + separatorSpace;
      if (maxLength < len) {
        maxLength = len;
      }
    }
    const actualMax = maxLength + separatorSpace;
    if (
      actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
      (totalLength / actualMax > 5 || maxLength <= 6)
    ) {
      const approxCharHeights = 2.5;
      const averageBias = MathSqrt(actualMax - totalLength / output.length);
      const biasedMax = MathMax(actualMax - 3 - averageBias, 1);
      const columns = MathMin(
        MathRound(
          MathSqrt(approxCharHeights * biasedMax * outputLength) /
            biasedMax,
        ),
        MathFloor((ctx.breakLength - ctx.indentationLvl) / actualMax),
        ctx.compact * 4,
        15,
      );
      if (columns <= 1) {
        return output;
      }
      const tmp = [];
      const maxLineLength = [];
      for (let i = 0; i < columns; i++) {
        let lineMaxLength = 0;
        for (let j = i; j < output.length; j += columns) {
          if (dataLen[j] > lineMaxLength) {
            lineMaxLength = dataLen[j];
          }
        }
        lineMaxLength += separatorSpace;
        maxLineLength[i] = lineMaxLength;
      }
      let order = StringPrototypePadStart;
      if (value !== undefined) {
        for (let i = 0; i < output.length; i++) {
          if (typeof value[i] !== "number" && typeof value[i] !== "bigint") {
            order = StringPrototypePadEnd;
            break;
          }
        }
      }
      for (let i = 0; i < outputLength; i += columns) {
        const max = MathMin(i + columns, outputLength);
        let str = "";
        let j = i;
        for (; j < max - 1; j++) {
          const padding = maxLineLength[j - i] + output[j].length -
            dataLen[j];
          str += order(`${output[j]}, `, padding, " ");
        }
        if (order === StringPrototypePadStart) {
          const padding = maxLineLength[j - i] + output[j].length -
            dataLen[j] - separatorSpace;
          str += StringPrototypePadStart(output[j], padding, " ");
        } else {
          str += output[j];
        }
        ArrayPrototypePush(tmp, str);
      }
      if (ctx.maxArrayLength < output.length) {
        ArrayPrototypePush(tmp, output[outputLength]);
      }
      output = tmp;
    }
    return output;
  }

  function formatMapIterInner(ctx, recurseTimes, entries, state) {
    const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
    const len = entries.length / 2;
    const remaining = len - maxArrayLength;
    const maxLength = MathMin(maxArrayLength, len);
    const output = [];
    let i = 0;
    ctx.indentationLvl += 2;
    if (state === kWeak) {
      for (; i < maxLength; i++) {
        const pos = i * 2;
        output[i] = `${formatValue(ctx, entries[pos], recurseTimes)} => ${
          formatValue(ctx, entries[pos + 1], recurseTimes)
        }`;
      }
      if (!ctx.sorted) {
        ArrayPrototypeSort(output);
      }
    } else {
      for (; i < maxLength; i++) {
        const pos = i * 2;
        const res = [
          formatValue(ctx, entries[pos], recurseTimes),
          formatValue(ctx, entries[pos + 1], recurseTimes),
        ];
        output[i] = reduceToSingleString(
          ctx,
          res,
          "",
          ["[", "]"],
          kArrayExtrasType,
          recurseTimes,
        );
      }
    }
    ctx.indentationLvl -= 2;
    if (remaining > 0) {
      ArrayPrototypePush(
        output,
        `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
      );
    }
    return output;
  }

  function formatSetIterInner(ctx, recurseTimes, entries, state) {
    const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
    const maxLength = MathMin(maxArrayLength, entries.length);
    const output = [];
    ctx.indentationLvl += 2;
    for (let i = 0; i < maxLength; i++) {
      output[i] = formatValue(ctx, entries[i], recurseTimes);
    }
    ctx.indentationLvl -= 2;
    if (state === kWeak && !ctx.sorted) {
      ArrayPrototypeSort(output);
    }
    const remaining = entries.length - maxLength;
    if (remaining > 0) {
      ArrayPrototypePush(
        output,
        `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
      );
    }
    return output;
  }

  // --- String width / table (no-color) ------------------------------------
  //
  // No ANSI escapes are ever emitted (no color), so `stripVTControlCharacters`
  // is a no-op identity here; `getStringWidth` reduces to a UTF-16 code unit
  // width estimate (good enough for the box-drawn `console.table` layout).

  function stripVTControlCharacters(str) {
    return str;
  }

  function isFullWidthCodePoint(code) {
    return (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
        (code >= 0x3250 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0xa4c6) ||
        (code >= 0xa960 && code <= 0xa97c) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6b) ||
        (code >= 0xff01 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1b000 && code <= 0x1b001) ||
        (code >= 0x1f200 && code <= 0x1f251) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x20000 && code <= 0x3fffd))
    );
  }

  const isZeroWidthCodePoint = (code) => {
    return code <= 0x1F ||
      (code >= 0x7F && code <= 0x9F) ||
      (code >= 0x300 && code <= 0x36F) ||
      (code >= 0x200B && code <= 0x200F) ||
      (code >= 0x20D0 && code <= 0x20FF) ||
      (code >= 0xFE00 && code <= 0xFE0F) ||
      (code >= 0xFE20 && code <= 0xFE2F) ||
      (code >= 0xE0100 && code <= 0xE01EF);
  };

  function getStringWidth(str, _removeControlChars = true) {
    let width = 0;
    str = StringPrototypeNormalize(str, "NFC");
    for (const char of new SafeStringIterator(str)) {
      const code = StringPrototypeCodePointAt(char, 0);
      if (isFullWidthCodePoint(code)) {
        width += 2;
      } else if (!isZeroWidthCodePoint(code)) {
        width++;
      }
    }
    return width;
  }

  function hasOwnProperty(obj, v) {
    if (obj == null) {
      return false;
    }
    return ObjectHasOwn(obj, v);
  }

  // --- `console.table` (forked from Node's internal/cli_table.js) ---------

  const tableChars = {
    middleMiddle: "\u2500",
    rowMiddle: "\u253c",
    topRight: "\u2510",
    topLeft: "\u250c",
    leftMiddle: "\u251c",
    topMiddle: "\u252c",
    bottomRight: "\u2518",
    bottomLeft: "\u2514",
    bottomMiddle: "\u2534",
    rightMiddle: "\u2524",
    left: "\u2502 ",
    right: " \u2502",
    middle: " \u2502 ",
  };

  function renderRow(row, columnWidths, columnRightAlign) {
    let out = tableChars.left;
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      const len = getStringWidth(cell);
      const padding = StringPrototypeRepeat(" ", columnWidths[i] - len);
      if (columnRightAlign?.[i]) {
        out += `${padding}${cell}`;
      } else {
        out += `${cell}${padding}`;
      }
      if (i !== row.length - 1) {
        out += tableChars.middle;
      }
    }
    out += tableChars.right;
    return out;
  }

  function cliTable(head, columns) {
    const rows = [];
    const columnWidths = ArrayPrototypeMap(head, (h) => getStringWidth(h));
    const longestColumn = ArrayPrototypeReduce(
      columns,
      (n, a) => MathMax(n, a.length),
      0,
    );
    const columnRightAlign = ArrayPrototypeFill(
      new Array(columnWidths.length),
      true,
    );

    for (let i = 0; i < head.length; i++) {
      const column = columns[i];
      for (let j = 0; j < longestColumn; j++) {
        if (rows[j] === undefined) {
          rows[j] = [];
        }
        const value = (rows[j][i] = hasOwnProperty(column, j)
          ? column[j]
          : "");
        const width = columnWidths[i] || 0;
        const counted = getStringWidth(value);
        columnWidths[i] = MathMax(width, counted);
        columnRightAlign[i] &= NumberIsInteger(+value);
      }
    }

    const divider = ArrayPrototypeMap(
      columnWidths,
      (i) => StringPrototypeRepeat(tableChars.middleMiddle, i + 2),
    );

    let result =
      `${tableChars.topLeft}${
        ArrayPrototypeJoin(divider, tableChars.topMiddle)
      }` +
      `${tableChars.topRight}\n${renderRow(head, columnWidths)}\n` +
      `${tableChars.leftMiddle}${
        ArrayPrototypeJoin(divider, tableChars.rowMiddle)
      }` +
      `${tableChars.rightMiddle}\n`;

    for (let i = 0; i < rows.length; ++i) {
      const row = rows[i];
      result += `${renderRow(row, columnWidths, columnRightAlign)}\n`;
    }

    result +=
      `${tableChars.bottomLeft}${
        ArrayPrototypeJoin(divider, tableChars.bottomMiddle)
      }` +
      tableChars.bottomRight;

    return result;
  }

  // --- Inspect options / quoting -----------------------------------------

  const kMinLineLength = 16;

  const denoInspectDefaultOptions = {
    indentationLvl: 0,
    currentDepth: 0,
    stylize: stylizeNoColor,

    showHidden: false,
    depth: 4,
    colors: false,
    showProxy: false,
    breakLength: 80,
    escapeSequences: true,
    compact: 3,
    sorted: false,
    getters: false,

    maxArrayLength: 100,
    maxStringLength: 10000,
    customInspect: true,

    quotes: ['"', "'", "`"],
    iterableLimit: 100,
    trailingComma: false,

    inspect,

    indentLevel: 0,
  };

  function getDefaultInspectOptions() {
    return {
      budget: {},
      seen: [],
      ...denoInspectDefaultOptions,
    };
  }

  const DEFAULT_INDENT = "  ";
  const STR_ABBREVIATE_SIZE = 10000;

  const QUOTE_SYMBOL_REG = new SafeRegExp(/^[a-zA-Z_][a-zA-Z_.0-9]*$/);

  function maybeQuoteSymbol(symbol, ctx) {
    const description = SymbolPrototypeGetDescription(symbol);

    if (description === undefined) {
      return SymbolPrototypeToString(symbol);
    }

    if (RegExpPrototypeTest(QUOTE_SYMBOL_REG, description)) {
      return SymbolPrototypeToString(symbol);
    }

    return `Symbol(${quoteString(description, ctx)})`;
  }

  function quoteString(string, ctx) {
    const quote = ArrayPrototypeFind(
      ctx.quotes,
      (c) => !StringPrototypeIncludes(string, c),
    ) ?? ctx.quotes[0];
    const escapePattern = new SafeRegExp(`(?=[${quote}\\\\])`, "g");
    string = StringPrototypeReplace(string, escapePattern, "\\");
    if (ctx.escapeSequences) {
      string = replaceEscapeSequences(string);
    }
    return `${quote}${string}${quote}`;
  }

  const ESCAPE_PATTERN = new SafeRegExp(/([\b\f\n\r\t\v])/g);
  const ESCAPE_MAP = ObjectFreeze({
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\v": "\\v",
  });

  const ESCAPE_PATTERN2 = new SafeRegExp("[\x00-\x1f\x7f-\x9f]", "g");

  function replaceEscapeSequences(string) {
    return StringPrototypeReplace(
      StringPrototypeReplace(
        string,
        ESCAPE_PATTERN,
        (c) => ESCAPE_MAP[c],
      ),
      ESCAPE_PATTERN2,
      (c) =>
        "\\x" +
        StringPrototypePadStart(
          NumberPrototypeToString(StringPrototypeCharCodeAt(c, 0), 16),
          2,
          "0",
        ),
    );
  }

  function inspectValueWithQuotes(value, ctx) {
    const abbreviateSize = typeof ctx.strAbbreviateSize === "undefined"
      ? STR_ABBREVIATE_SIZE
      : ctx.strAbbreviateSize;
    switch (typeof value) {
      case "string": {
        const trunc = value.length > abbreviateSize
          ? StringPrototypeSlice(value, 0, abbreviateSize) + "..."
          : value;
        return ctx.stylize(quoteString(trunc, ctx), "string");
      }
      default:
        return formatValue(ctx, value, 0);
    }
  }

  // --- `inspectArgs` — %-substitution + recursive inspect ----------------
  //
  // Recognizes `%s`/`%d`/`%i`/`%f`/`%o`/`%O`/`%c`/`%%`. `%c` consumes its
  // arg and emits nothing (no CSS styling). `%j` (JSON) is also recognized
  // (matches Deno/Node).
  function inspectArgs(args, inspectOptions = { __proto__: null }) {
    const ctx = {
      ...getDefaultInspectOptions(),
      colors: false,
      ...inspectOptions,
    };
    if (inspectOptions.iterableLimit !== undefined) {
      ctx.maxArrayLength = inspectOptions.iterableLimit;
    }
    if (inspectOptions.strAbbreviateSize !== undefined) {
      ctx.maxStringLength = inspectOptions.strAbbreviateSize;
    }
    // `colors` is always false in Limun (no ANSI/CSS) — keep `stylize` as
    // the no-color identity regardless of the incoming option.
    ctx.stylize = stylizeNoColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;

    const first = args[0];
    let a = 0;
    let string = "";

    if (typeof first === "string" && args.length > 1) {
      a++;
      let appendedChars = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first[i] == "%") {
          const char = first[++i];
          if (a < args.length) {
            let formattedArg = null;
            if (char == "s") {
              formattedArg = String(args[a++]);
            } else if (ArrayPrototypeIncludes(["d", "i"], char)) {
              const value = args[a++];
              if (typeof value === "symbol") {
                formattedArg = "NaN";
              } else {
                formattedArg = `${NumberParseInt(value)}`;
              }
            } else if (char == "f") {
              const value = args[a++];
              if (typeof value === "symbol") {
                formattedArg = "NaN";
              } else {
                formattedArg = `${NumberParseFloat(value)}`;
              }
            } else if (char == "j") {
              formattedArg = tryStringify(args[a++]);
            } else if (ArrayPrototypeIncludes(["O", "o"], char)) {
              formattedArg = formatValue(ctx, args[a++], 0);
            } else if (char == "c") {
              // CSS styling — no terminal equivalent; consume the arg,
              // emit nothing (matches the previous Rust impl).
              a++;
            }

            if (formattedArg != null) {
              string += StringPrototypeSlice(first, appendedChars, i - 1) +
                formattedArg;
              appendedChars = i + 1;
            }
          }
          if (char == "%") {
            string += StringPrototypeSlice(first, appendedChars, i - 1) + "%";
            appendedChars = i + 1;
          }
        }
      }
      string += StringPrototypeSlice(first, appendedChars);
    }

    for (; a < args.length; a++) {
      if (a > 0) {
        string += " ";
      }
      if (typeof args[a] === "string") {
        string += args[a];
      } else {
        string += formatValue(ctx, args[a], 0);
      }
    }

    if (ctx.indentLevel > 0) {
      const groupIndent = StringPrototypeRepeat(
        DEFAULT_INDENT,
        ctx.indentLevel,
      );
      string = groupIndent +
        StringPrototypeReplaceAll(string, "\n", `\n${groupIndent}`);
    }

    return string;
  }

  // --- `createFilteredInspectProxy` (kept + exposed on `__bootstrap`) -----

  function createFilteredInspectProxy({ object, keys, evaluate }) {
    const cls = class {};
    if (object.constructor?.name) {
      ObjectDefineProperty(cls, "name", {
        __proto__: null,
        value: object.constructor.name,
      });
    }

    const result = new cls();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const descriptor = evaluate
        ? getEvaluatedDescriptor(object, key)
        : (getDescendantPropertyDescriptor(object, key) ??
          getEvaluatedDescriptor(object, key));
      ObjectDefineProperty(result, key, descriptor);
    }
    return result;

    function getDescendantPropertyDescriptor(object, key) {
      let propertyDescriptor = ReflectGetOwnPropertyDescriptor(object, key);
      if (!propertyDescriptor) {
        const prototype = ReflectGetPrototypeOf(object);
        if (prototype) {
          propertyDescriptor = getDescendantPropertyDescriptor(
            prototype,
            key,
          );
        }
      }
      return propertyDescriptor;
    }

    function getEvaluatedDescriptor(object, key) {
      return {
        configurable: true,
        enumerable: true,
        value: object[key],
      };
    }
  }

  // --- `inspect` (public-ish; used by `createFilteredInspectProxy` deps) -

  function inspect(value, inspectOptions = { __proto__: null }) {
    const ctx = {
      ...getDefaultInspectOptions(),
      ...inspectOptions,
    };
    if (inspectOptions.iterableLimit !== undefined) {
      ctx.maxArrayLength = inspectOptions.iterableLimit;
    }
    if (inspectOptions.strAbbreviateSize !== undefined) {
      ctx.maxStringLength = inspectOptions.strAbbreviateSize;
    }
    ctx.stylize = stylizeNoColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
  }

  // --- Per-realm state (module-singleton) --------------------------------

  let groupDepth = 0;
  const groupIndent = "  ";

  const counts = new SafeMap();
  const timers = new SafeMap();

  // --- Output routing -----------------------------------------------------
  //
  // `op_print(text, is_err)` — Limun's op appends a newline on the Rust
  // side, so we do NOT add a trailing `\n` here (matches the previous Rust
  // impl and the existing `op_print` contract). Group indentation prefixes
  // each line.

  function print(text, isErr) {
    if (groupDepth === 0) {
      op_print(text, isErr);
      return;
    }
    const indent = StringPrototypeRepeat(groupIndent, groupDepth);
    const lines = StringPrototypeSplit(String(text), "\n");
    const out = ArrayPrototypeJoin(
      ArrayPrototypeMap(lines, (line) => indent + line),
      "\n",
    );
    op_print(out, isErr);
  }

  function logOut(text) {
    print(text, false);
  }
  function logErr(text) {
    print(text, true);
  }

  // --- Label helper (§1.2/§1.4) -------------------------------------------
  //
  // `optional DOMString label = "default"` — the spec default when no
  // argument is supplied. Coerces via `String(value)` (ToString) for
  // non-string labels; a throwing `toString()` propagates (matches the WPT
  // `console-label-conversion.any.js` expectations).
  function labelArg(args, i) {
    if (args.length > i) {
      return String(args[i]);
    }
    return "default";
  }

  // --- Duration formatting (§1.4) ----------------------------------------

  function formatDuration(ms) {
    if (ms < 1) {
      return NumberPrototypeToFixed(ms, 3);
    } else if (ms < 10) {
      return NumberPrototypeToFixed(ms, 2);
    } else if (ms < 100) {
      return NumberPrototypeToFixed(ms, 1);
    } else {
      return NumberPrototypeToFixed(ms, 0);
    }
  }

  // --- Logging (§1.1) -----------------------------------------------------

  function log(...args) {
    logOut(inspectArgs(args, { indentLevel: groupDepth }));
  }
  function info(...args) {
    logOut(inspectArgs(args, { indentLevel: groupDepth }));
  }
  function debug(...args) {
    logOut(inspectArgs(args, { indentLevel: groupDepth }));
  }
  function warn(...args) {
    logErr(inspectArgs(args, { indentLevel: groupDepth }));
  }
  function error(...args) {
    logErr(inspectArgs(args, { indentLevel: groupDepth }));
  }

  // §1.1.1 assert(condition, ...data)
  function assert(condition, ...data) {
    if (condition) {
      return;
    }
    if (data.length === 0) {
      logErr("Assertion failed");
      return;
    }
    const first = data[0];
    if (typeof first === "string") {
      logErr(
        inspectArgs(
          [`Assertion failed: ${first}`, ...new SafeArrayIterator(data.slice(1))],
          { indentLevel: groupDepth },
        ),
      );
      return;
    }
    logErr(
      inspectArgs(["Assertion failed:", ...new SafeArrayIterator(data)], {
        indentLevel: groupDepth,
      }),
    );
  }

  // §1.1.2 clear()
  function clear() {
    groupDepth = 0;
    op_print("\x1B[2J\x1B[H", false);
  }

  // §1.1.10 dir(item, options) — recursive inspect with the given options.
  function dir(item, options = { __proto__: null }) {
    logOut(
      inspectArgs([item], {
        ...options,
        indentLevel: groupDepth,
      }),
    );
  }

  // §1.1.11 dirxml(...data) — no DOM here, degrades to log().
  function dirxml(...args) {
    logOut(inspectArgs(args, { indentLevel: groupDepth }));
  }

  // --- Counting (§1.2) ----------------------------------------------------

  function count(label) {
    label = labelArg(arguments, 0);
    const n = MapPrototypeHas(counts, label)
      ? MapPrototypeGet(counts, label) + 1
      : 1;
    MapPrototypeSet(counts, label, n);
    logOut(label + ": " + n);
  }

  function countReset(label) {
    label = labelArg(arguments, 0);
    if (MapPrototypeHas(counts, label)) {
      MapPrototypeSet(counts, label, 0);
    } else {
      logErr("Count for '" + label + "' does not exist");
    }
  }

  // --- Grouping (§1.3) ----------------------------------------------------

  function group(...args) {
    if (args.length > 0) {
      logOut(inspectArgs(args, { indentLevel: groupDepth }));
    }
    groupDepth++;
  }
  function groupCollapsed(...args) {
    group(...args);
  }
  function groupEnd() {
    if (groupDepth > 0) {
      groupDepth--;
    }
  }

  // --- Timing (§1.4) ------------------------------------------------------

  function time(label) {
    label = labelArg(arguments, 0);
    if (MapPrototypeHas(timers, label)) {
      logErr("Timer '" + label + "' already exists");
    } else {
      MapPrototypeSet(timers, label, currentTime());
    }
  }

  function timeLog(label, ...data) {
    label = labelArg(arguments, 0);
    if (!MapPrototypeHas(timers, label)) {
      logErr("Timer '" + label + "' does not exist");
      return;
    }
    const start = MapPrototypeGet(timers, label);
    const elapsed = currentTime() - start;
    const rest = ArrayPrototypeSlice(arguments, 1);
    logOut(
      inspectArgs([`${label}: ${formatDuration(elapsed)}ms`, ...rest], {
        indentLevel: groupDepth,
      }),
    );
  }

  function timeEnd(label) {
    label = labelArg(arguments, 0);
    if (!MapPrototypeHas(timers, label)) {
      logErr("Timer '" + label + "' does not exist");
      return;
    }
    const start = MapPrototypeGet(timers, label);
    MapPrototypeDelete(timers, label);
    const elapsed = currentTime() - start;
    logOut(label + ": " + formatDuration(elapsed) + "ms");
  }

  // --- Trace (§1.1.8) -----------------------------------------------------

  function trace(...args) {
    const message = inspectArgs(args, { indentLevel: 0 });
    const err = { name: "Trace", message };
    ErrorCaptureStackTrace(err, trace);
    logErr(err.stack);
  }

  // --- Table (§1.1.7) ----------------------------------------------------

  function table(data, properties) {
    if (properties !== undefined && !ArrayIsArray(properties)) {
      throw new TypeError(
        "The 'properties' argument must be of type Array: " +
          "received type " + typeof properties,
      );
    }

    if (data === null || typeof data !== "object") {
      return log(data);
    }

    const stringifyValue = (value) =>
      inspectValueWithQuotes(value, {
        ...getDefaultInspectOptions(),
        stylize: stylizeNoColor,
        depth: 1,
        compact: true,
        breakLength: Infinity,
      });
    const toTable = (header, body) => log(cliTable(header, body));

    let resultData;
    const isSetObject = isSet(data);
    const isMapObject = isMap(data);
    const isIteratorObject = !isSetObject && !isMapObject &&
      !ArrayIsArray(data) && typeof data[SymbolIterator] === "function";
    const valuesKey = "Values";
    const indexKey = isSetObject || isMapObject || isIteratorObject
      ? "(iter idx)"
      : "(idx)";

    if (isSetObject) {
      resultData = [...new SafeSetIterator(data)];
    } else if (isMapObject) {
      let idx = 0;
      resultData = { __proto__: null };
      MapPrototypeForEach(data, (v, k) => {
        resultData[idx] = { Key: k, Values: v };
        idx++;
      });
    } else if (isIteratorObject) {
      resultData = ArrayFrom(data);
    } else {
      resultData = data;
    }

    const keys = ObjectKeys(resultData);
    const numRows = keys.length;

    const objectValues = properties
      ? ObjectFromEntries(
        ArrayPrototypeMap(
          properties,
          (name) => [name, ArrayPrototypeFill(new Array(numRows), "")],
        ),
      )
      : {};
    const indexKeys = [];
    const values = [];

    let hasPrimitives = false;
    ArrayPrototypeForEach(keys, (k, idx) => {
      const value = resultData[k];
      const primitive = value === null ||
        (typeof value !== "function" && typeof value !== "object");
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        ArrayPrototypePush(values, stringifyValue(value));
      } else {
        const valueObj = value || {};
        const keys = properties || ObjectKeys(valueObj);
        for (let i = 0; i < keys.length; ++i) {
          const k = keys[i];
          if (!primitive && ReflectHas(valueObj, k)) {
            if (!(ReflectHas(objectValues, k))) {
              objectValues[k] = ArrayPrototypeFill(new Array(numRows), "");
            }
            objectValues[k][idx] = stringifyValue(valueObj[k]);
          }
        }
        ArrayPrototypePush(values, "");
      }
      ArrayPrototypePush(indexKeys, k);
    });

    const headerKeys = ObjectKeys(objectValues);
    const bodyValues = ObjectValues(objectValues);
    const headerProps = properties ||
      [
        ...new SafeArrayIterator(headerKeys),
        !isMapObject && hasPrimitives && valuesKey,
      ];
    const header = ArrayPrototypeFilter([
      indexKey,
      ...new SafeArrayIterator(headerProps),
    ], Boolean);
    const body = [indexKeys, ...new SafeArrayIterator(bodyValues), values];

    toTable(header, body);
  }

  // --- Namespace object + install ----------------------------------------
  //
  // Web IDL §3.7.5 + WPT `console-is-a-namespace.any.js`: the namespace
  // object's [[Prototype]] is an empty object (created as if by
  // `ObjectCreate(%ObjectPrototype%)`), whose own [[Prototype]] is
  // `%ObjectPrototype%` — so `Object.getOwnPropertyNames(proto).length === 0`
  // and `Object.getPrototypeOf(proto) === Object.prototype`.
  // `console-namespace-object-class-string.any.js` additionally requires an
  // own, non-enumerable, non-writable, configurable `Symbol.toStringTag`
  // with value `"console"` (on `console` itself, not on the proto).
  const consoleProto = ObjectCreate(ObjectPrototype);
  const console = ObjectCreate(consoleProto, {
    [SymbolToStringTag]: {
      __proto__: null,
      enumerable: false,
      writable: false,
      configurable: true,
      value: "console",
    },
  });

  const methods = {
    assert,
    clear,
    debug,
    error,
    info,
    log,
    table,
    trace,
    warn,
    dir,
    dirxml,
    count,
    countReset,
    group,
    groupCollapsed,
    groupEnd,
    time,
    timeLog,
    timeEnd,
  };
  for (const name of ReflectOwnKeys(methods)) {
    ObjectDefineProperty(console, name, {
      __proto__: null,
      value: methods[name],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  ObjectDefineProperty(globalThis, "console", {
    __proto__: null,
    value: console,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // --- Expose internals on `__bootstrap` (for MessagePort / future use) --

  globalThis.__bootstrap.console = {
    inspect,
    inspectArgs,
    formatValue,
    getDefaultInspectOptions,
    createFilteredInspectProxy,
    stylizeNoColor,
    quoteString,
    getStringWidth,
    stripVTControlCharacters,
  };
})(globalThis);