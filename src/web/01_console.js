// Copyright 2026 the Limun authors. MIT license.

// `console` — WHATWG Console Standard
// (https://console.spec.whatwg.org/). Namespace object installed as a
// non-enumerable own property of `globalThis` (Web IDL §3.7.5).
//
// Fourth web API migrated from Rust to JS-on-ops (after base64,
// DOMException, and TextEncoding). The spec surface (ToString
// conversion, %-substitution, group indentation, table layout,
// timer/count state, assert condition check, trace stack capture) lives
// here in JS; the flat Rust op `op_print` (registered in `core::ops`) is
// the irreducible stdout/stderr write — the only native work.
//
// Ports Deno's `ext/web/01_console.js` in *shape*, not in full: Deno's
// console is built on a complete recursive inspector
// (`op_console_inspect` et al.). Limun's current console is deliberately
// simpler (flat ToString, no recursive/colorized inspector — per TODO.md
// "Known limitations"), matching the previous Rust impl. This module
// keeps that simplicity. Rewires vs Deno:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `op_print`               → `op_print` (Limun's own — same name, same
//     shape: `(text: String, is_err: bool) -> void`).
//   - Deno's `inspect`/`format` engine → flat `ToString` via
//     `String(value)` (the previous Rust impl used V8's `ToString`, which
//     is exactly `String(value)` for our purposes; symbols throw, which
//     the spec's ToString also does, so we let it throw — matches the
//     Rust path that returned `"<unprintable>"` only on internal failure).
//   - `noColorStdout`/`noColorStderr` → dropped (no CSS styling → no
//     color decision; `%c` is recognized and its argument consumed per
//     spec, but no styling is applied, same as the previous Rust impl).
//   - `[SymbolFor("Deno.privateCustomInspect")]` → dropped (no Deno-style
//     custom inspect in Limun yet).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const { op_print } = globalThis.__limunOps;
  const {
    ArrayIsArray,
    ArrayPrototypeJoin,
    ArrayPrototypeMap,
    ArrayPrototypePush,
    Error,
    MapPrototypeDelete,
    MapPrototypeGet,
    MapPrototypeHas,
    MapPrototypeSet,
    MathFloor,
    Number,
    NumberPrototypeToFixed,
    ObjectDefineProperty,
    ReflectOwnKeys,
    SafeMap,
    StringPrototypeIndexOf,
    StringPrototypeRepeat,
    StringPrototypeSlice,
    StringPrototypeSplit,
  } = primordials;

  // --- Per-realm state (module-singleton) --------------------------------
  //
  // The previous Rust impl kept these in `thread_local!`s. In JS they're
  // module-singleton closures — one per realm (one realm per process in
  // Limun today; the closure model scales to per-realm when multiple
  // contexts land, since each context evaluates its own copy of this
  // module).

  // §1.3 group nesting depth — indents all subsequent output by
  // `groupIndent` × depth.
  let groupDepth = 0;
  const groupIndent = "  "; // two spaces, matches the Rust impl

  // §1.2 per-label counters.
  const counts = new SafeMap();

  // §1.4 per-label timer start times (ms, via `Date.now`). The previous
  // Rust impl used `Instant::now()` (monotonic); `Date.now()` is
  // wall-clock. The WPT suite has no console.time WPT yet, so this is an
  // acceptable minor regression — a future switch to `performance.now()`
  // is a one-line change.
  const timers = new SafeMap();

  // --- Stringification ----------------------------------------------------
  //
  // §2.1 "Printer" step: convert a value to a string for output. Matches
  // the previous Rust `stringify`: V8's `ToString` (which is what
  // `String(value)` does in JS). Symbols throw `TypeError` here — the
  // spec's ToString would too; the Rust path returned the V8 string or
  // `"<unprintable>"` on internal failure, so we mirror that fallback.
  function stringify(value) {
    try {
      return String(value);
    } catch {
      return "<unprintable>";
    }
  }

  // --- Output routing -----------------------------------------------------
  //
  // `print(text, isErr)` — apply current group indentation to each line
  // and write via `op_print`. The previous Rust `print_indented` split
  // on `\n` and prefixed each line with the indent; we do the same.
  function print(text, isErr) {
    // Fast path: no indentation, single op call.
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

  // --- Formatter (§2.2) ---------------------------------------------------
  //
  // `formatArgs(args, skip)` — if exactly one arg (after `skip`), print
  // it unformatted (spec: no substitution with no "rest"). Otherwise, if
  // the first arg is a string, walk it for %s/%d/%i/%f/%o/%O/%c
  // specifiers, consuming subsequent args positionally, then space-join
  // anything left over. If no specifier was consumed, fall back to
  // space-joining all args (matches the Rust `consumed_any` check).
  // Returns a string.
  function formatArgs(args, skip) {
    const len = args.length;
    if (len <= skip) {
      return "";
    }
    if (len === skip + 1) {
      return stringify(args[skip]);
    }
    const first = args[skip];
    if (typeof first !== "string") {
      return joinAll(args, skip);
    }
    const template = first;
    let out = "";
    let i = 0;
    let nextArg = skip + 1;
    let consumedAny = false;
    while (i < template.length) {
      const c = template.charCodeAt(i);
      if (c !== 0x25 /* % */) {
        out += template[i];
        i++;
        continue;
      }
      const next = template[i + 1];
      if (next === "%") {
        out += "%";
        i += 2;
        continue;
      }
      if (
        (next === "s" || next === "d" || next === "i" || next === "f" ||
          next === "o" || next === "O" || next === "c") &&
        nextArg < len
      ) {
        const value = args[nextArg];
        nextArg++;
        consumedAny = true;
        if (next === "s") {
          out += stringify(value);
        } else if (next === "d" || next === "i") {
          out += typeof value === "symbol"
            ? "NaN"
            : String(MathFloor(Number(value)) | 0);
        } else if (next === "f") {
          out += typeof value === "symbol" ? "NaN" : String(Number(value));
        } else if (next === "o" || next === "O") {
          out += stringify(value);
        }
        // `%c`: CSS styling — no terminal equivalent, consume the arg,
        // emit nothing (matches the previous Rust impl).
        i += 2;
        continue;
      }
      // Not a recognized specifier or no arg left: emit `%` literally.
      out += "%";
      i++;
    }
    if (!consumedAny) {
      return joinAll(args, skip);
    }
    for (let j = nextArg; j < len; j++) {
      out += " " + stringify(args[j]);
    }
    return out;
  }

  function joinAll(args, skip) {
    const len = args.length;
    const parts = [];
    for (let i = skip; i < len; i++) {
      ArrayPrototypePush(parts, stringify(args[i]));
    }
    return ArrayPrototypeJoin(parts, " ");
  }

  // --- Label helper (§1.2/§1.4) -------------------------------------------
  //
  // `optional DOMString label = "default"` — the spec default when no
  // argument is supplied. Coerces via `stringify` (ToString) for
  // non-string labels, matching the Rust `label_arg`.
  function labelArg(args, i) {
    if (args.length > i) {
      return stringify(args[i]);
    }
    return "default";
  }

  // --- Duration formatting (§1.4) ----------------------------------------
  //
  // `{:.3}ms` — three-decimal milliseconds. Matches the Rust
  // `format_duration`.
  function formatDuration(ms) {
    return NumberPrototypeToFixed(ms, 3) + "ms";
  }

  // --- Logging (§1.1) -----------------------------------------------------

  function log(...args) {
    logOut(formatArgs(args, 0));
  }
  function info(...args) {
    logOut(formatArgs(args, 0));
  }
  function debug(...args) {
    logOut(formatArgs(args, 0));
  }
  function warn(...args) {
    logErr(formatArgs(args, 0));
  }
  function error(...args) {
    logErr(formatArgs(args, 0));
  }

  // §1.1.1 assert(condition, ...data) — logs only when condition is
  // falsy. If the first data arg is a string, prepend "Assertion failed:
  // " to it (matches the Rust impl); otherwise just "Assertion failed"
  // + space-joined data.
  function assert(condition, ...data) {
    if (condition) {
      return;
    }
    const firstIsString = data.length > 0 && typeof data[0] === "string";
    let text;
    let dataStart;
    if (firstIsString) {
      text = "Assertion failed: " + data[0];
      dataStart = 1;
    } else {
      text = "Assertion failed";
      dataStart = 0;
    }
    for (let i = dataStart; i < data.length; i++) {
      text += " " + stringify(data[i]);
    }
    logErr(text);
  }

  // §1.1.2 clear() — resets group nesting and emits the ANSI clear-screen
  // sequence (no-op on a non-terminal stdout; never an error).
  function clear() {
    groupDepth = 0;
    op_print("\x1B[2J\x1B[H", false);
  }

  // §1.1.10 dir(item, options) — simplified to plain stringification.
  function dir(item) {
    logOut(item === undefined ? "undefined" : stringify(item));
  }

  // §1.1.11 dirxml(...data) — no DOM here, degrades to log().
  function dirxml(...args) {
    logOut(formatArgs(args, 0));
  }

  // --- Counting (§1.2) ----------------------------------------------------

  // §1.2.1 count(label = "default")
  function count(label) {
    label = labelArg(arguments, 0);
    const n = MapPrototypeHas(counts, label)
      ? MapPrototypeGet(counts, label) + 1
      : 1;
    MapPrototypeSet(counts, label, n);
    logOut(label + ": " + n);
  }

  // §1.2.2 countReset(label = "default")
  function countReset(label) {
    label = labelArg(arguments, 0);
    if (MapPrototypeHas(counts, label)) {
      MapPrototypeSet(counts, label, 0);
    } else {
      logErr("Count for '" + label + "' does not exist");
    }
  }

  // --- Grouping (§1.3) ----------------------------------------------------
  //
  // "Collapsed" is a UI-only distinction; on a plain text stream it
  // behaves the same as group().

  function group(...args) {
    const label = args.length > 0 ? formatArgs(args, 0) : "console.group";
    logOut(label);
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

  // §1.4.1 time(label = "default")
  function time(label) {
    label = labelArg(arguments, 0);
    if (MapPrototypeHas(timers, label)) {
      logErr("Timer '" + label + "' already exists");
    } else {
      MapPrototypeSet(timers, label, Date.now());
    }
  }

  // §1.4.2 timeLog(label = "default", ...data)
  function timeLog(label, ...data) {
    label = labelArg(arguments, 0);
    if (!MapPrototypeHas(timers, label)) {
      logErr("Timer '" + label + "' does not exist");
      return;
    }
    const start = MapPrototypeGet(timers, label);
    const elapsed = Date.now() - start;
    let text = label + ": " + formatDuration(elapsed);
    for (let i = 1; i < arguments.length; i++) {
      text += " " + stringify(arguments[i]);
    }
    logOut(text);
  }

  // §1.4.3 timeEnd(label = "default")
  function timeEnd(label) {
    label = labelArg(arguments, 0);
    if (!MapPrototypeHas(timers, label)) {
      logErr("Timer '" + label + "' does not exist");
      return;
    }
    const start = MapPrototypeGet(timers, label);
    MapPrototypeDelete(timers, label);
    const elapsed = Date.now() - start;
    logOut(label + ": " + formatDuration(elapsed));
  }

  // --- Trace (§1.1.8) -----------------------------------------------------
  //
  // §1.1.8 trace(...data) — a captured stack trace. The Rust impl used
  // `v8::StackTrace::current_stack_trace`; in JS we use `new Error().stack`,
  // which V8 populates with a `formatStackTrace`-style string. We prepend
  // "Trace" or "Trace: <label>".
  function trace(...args) {
    const label = formatArgs(args, 0);
    let text = label.length === 0 ? "Trace" : "Trace: " + label;
    const err = new Error();
    const stack = err.stack;
    if (stack !== undefined) {
      // V8's `Error.stack` includes the "Error\n" prefix line followed by
      // "    at ..." frames. Drop the first line and append the rest.
      const nl = StringPrototypeIndexOf(stack, "\n");
      const frames = nl === -1 ? stack : StringPrototypeSlice(stack, nl + 1);
      if (frames.length > 0) {
        text += "\n" + frames;
      }
    }
    logErr(text);
  }

  // --- Table (§1.1.7) ----------------------------------------------------
  //
  // §1.1.7 table(tabularData, properties) — array of objects → aligned
  // box-drawn table; anything else falls back to a plain log per spec.
  // Matches the previous Rust `print_table` layout (box-drawing chars,
  // `(index)` leftmost column, centered cells).
  function table(tabularData, properties) {
    if (tabularData === undefined) {
      logOut("undefined");
      return;
    }
    if (!ArrayIsArray(tabularData)) {
      logOut(stringify(tabularData));
      return;
    }

    const columns = [];
    const rows = [];
    for (let i = 0; i < tabularData.length; i++) {
      const item = tabularData[i];
      const row = {};
      if (typeof item === "object" && item !== null && typeof item !== "function") {
        const keys = ReflectOwnKeys(item);
        for (let k = 0; k < keys.length; k++) {
          const key = keys[k];
          const keyStr = String(key);
          if (!arrayIncludes(columns, keyStr)) {
            ArrayPrototypePush(columns, keyStr);
          }
          row[keyStr] = stringify(item[key]);
        }
      } else {
        const col = "Values";
        if (!arrayIncludes(columns, col)) {
          ArrayPrototypePush(columns, col);
        }
        row[col] = stringify(item);
      }
      ArrayPrototypePush(rows, row);
    }

    printTable(columns, rows);
  }

  // `Array.prototype.includes` (uninlined to a local helper to keep the
  // hot loop readable; uses the primordial-free `indexOf` via `===` scan).
  function arrayIncludes(arr, value) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === value) return true;
    }
    return false;
  }

  function printTable(columns, rows) {
    const indexHeader = "(index)";
    const widths = [indexHeader.length];
    for (let ci = 0; ci < columns.length; ci++) {
      ArrayPrototypePush(widths, columns[ci].length);
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idxStr = String(i);
      if (idxStr.length > widths[0]) widths[0] = idxStr.length;
      for (let ci = 0; ci < columns.length; ci++) {
        const cell = row[columns[ci]];
        const cellLen = cell !== undefined ? cell.length : 0;
        if (cellLen > widths[ci + 1]) widths[ci + 1] = cellLen;
      }
    }

    function border(l, m, r) {
      let s = l;
      for (let i = 0; i < widths.length; i++) {
        for (let j = 0; j < widths[i] + 2; j++) s += "─";
        s += i + 1 === widths.length ? r : m;
      }
      return s;
    }

    function rowLine(cells) {
      let s = "│";
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const w = widths[i];
        const pad = w - cell.length;
        const left = MathFloor(pad / 2);
        const right = pad - left;
        s += " ";
        for (let k = 0; k < left; k++) s += " ";
        s += cell;
        for (let k = 0; k < right; k++) s += " ";
        s += " │";
      }
      return s;
    }

    const indent = StringPrototypeRepeat(groupIndent, groupDepth);
    const header = [indexHeader];
    for (let ci = 0; ci < columns.length; ci++) {
      ArrayPrototypePush(header, columns[ci]);
    }
    let out =
      indent + border("┌", "┬", "┐") + "\n" +
      indent + rowLine(header) + "\n" +
      indent + border("├", "┼", "┤") + "\n";
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = [String(i)];
      for (let ci = 0; ci < columns.length; ci++) {
        const v = row[columns[ci]];
        ArrayPrototypePush(cells, v !== undefined ? v : "");
      }
      out += indent + rowLine(cells) + "\n";
    }
    out += indent + border("└", "┴", "┘");
    // Single op_print with the whole table (newlines embedded) — the
    // `print` helper would re-indent every line, but the table already
    // has its own per-line indent prefix, so bypass it.
    op_print(out, false);
  }

  // --- Namespace object + install ----------------------------------------
  //
  // Web IDL §3.7.5: a namespace object is non-enumerable, configurable,
  // writable as a global. Matches the previous Rust `set_global`
  // (DONT_ENUM) and every other engine (`Object.keys(globalThis)`
  // excludes `console`).
  const console = {};
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
})(globalThis);