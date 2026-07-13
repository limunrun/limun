// Copyright 2018-2026 the Deno authors. MIT license.

// `alert`/`confirm`/`prompt` — WHATWG HTML user-prompt globals
// (https://html.spec.whatwg.org/multipage/window-object.html#user-prompts).
//
// Fifth web API migrated from Rust to JS-on-ops (after base64,
// DOMException, TextEncoding, console, timers, performance). The spec
// surface (argument coercion, default values, TTY gating, return
// shaping) lives here in JS; the flat Rust ops (`op_prompt_alert`,
// `op_prompt_confirm`, `op_prompt_prompt`, `op_prompt_is_tty`) in
// `core::ops` do the irreducible native work (stderr write, stdin
// read_line, TTY check).
//
// Ports Deno's `runtime/js/41_prompt.js`. Rewires vs Deno:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `core.print(text, is_err)` → `op_print` for the prompt write (Deno
//     uses `core.print(msg, false)` — stderr=false there, but Deno's
//     `core.print` routes to stderr when `is_err=true`; Limun's ops write
//     to stderr directly inside the prompt ops, so the JS layer doesn't
//     call `op_print` at all for prompts — the prompt ops own the write).
//   - Deno's `readLineFromStdinSync` (byte-at-a-time stdin read through
//     `ext:deno_io/12_io.js`) → Rust `read_line` inside the ops. Limun has
//     no resource-table-based stdin API to expose to JS yet, so the
//     line-reading stays in Rust — this is the irreducible native work.
//   - Deno's `op_read_line_prompt(message, default)` (a single combined
//     op) → three separate ops `op_prompt_alert`/`op_prompt_confirm`/
//     `op_prompt_prompt`, each owning its own prompt-format + read
//     cycle. Keeps the Rust ops flat and self-contained (one op per
//     function, no shared prompt-formatting logic between Rust and JS).
//
// Dropped vs Deno (Limun doesn't model these):
//   - `stdin.isTerminal()` per-call check → cached at module load via
//     `op_prompt_is_tty()` (the answer is stable for the process lifetime;
//     the previous Rust code checked `stdin().is_terminal()` at each call
//     but the value never changes, so caching is equivalent).
//
// Deviations from the previous Rust `web::prompt` (behavior preserved):
//   - `alert(message = "")`        — default is "" (Rust used "" too; Deno
//     uses "Alert" — we keep the Rust/previous behavior, not Deno's).
//   - `confirm(message = "")`      — default is "" (Rust used "" too; Deno
//     uses "Confirm" — we keep the previous behavior).
//   - `prompt(message = "", defaultValue = "")` — both default to "";
//     Deno defaults `message` to "Prompt" and `defaultValue` to undefined
//     (→ "" via `??=`). We keep the previous Rust behavior: both default
//     to "". When `message` is "", the prompt writes just "" + " " (a
//     single space) to stderr — matching the previous Rust format
//     `"{} "`, not Deno's empty-string-→-"" optimization.
//
// Non-TTY stdin behavior (matches previous Rust, matches Deno):
//   - `alert`  → no-op (returns undefined).
//   - `confirm` → returns false.
//   - `prompt` → returns null.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    op_prompt_alert,
    op_prompt_confirm,
    op_prompt_prompt,
    op_prompt_is_tty,
  } = globalThis.__limunOps;
  const {
    String,
    TypeError,
  } = primordials;

  // Cache the TTY check once — the answer is stable for the process
  // lifetime (stdin doesn't flip between TTY and non-TTY). The previous
  // Rust code checked `stdin().is_terminal()` at each call; caching is
  // equivalent and avoids a syscall per prompt.
  const isTty = op_prompt_is_tty();

  // `alert(message = "") -> undefined`
  //
  // Coerces `message` to a string (Web IDL DOMString conversion: symbols
  // throw, everything else → `String(message)`). Non-TTY stdin → no-op.
  // The op writes `message + " [Enter] "` to stderr and blocks for one
  // line of stdin.
  function alert(message = "") {
    message = convertDOMString(message);
    if (!isTty) {
      return;
    }
    op_prompt_alert(message);
  }

  // `confirm(message = "") -> boolean`
  //
  // Coerces `message` to a string. Non-TTY stdin → returns false. The op
  // writes `message + " [y/N] "` to stderr, reads one line, returns true
  // only if the trimmed answer is exactly `y` or `Y`.
  function confirm(message = "") {
    message = convertDOMString(message);
    if (!isTty) {
      return false;
    }
    return op_prompt_confirm(message);
  }

  // `prompt(message = "", defaultValue = "") -> string | null`
  //
  // Coerces both `message` and `defaultValue` to strings. Non-TTY stdin →
  // returns null. The op writes `message + " "` to stderr (a single
  // trailing space — matches the previous Rust format `"{} "`), reads one
  // line. Empty input + `defaultValue` given → returns `defaultValue`;
  // otherwise returns the trimmed input; EOF → null.
  function prompt(message = "", defaultValue = "") {
    message = convertDOMString(message);
    defaultValue = convertDOMString(defaultValue);
    if (!isTty) {
      return null;
    }
    const formattedMessage = `${message} `;
    return op_prompt_prompt(formattedMessage, defaultValue);
  }

  // `webidl.converters.DOMString(V)` — same inline as base64/02_timers.
  // Strings pass through; symbols throw; everything else → `String(V)`.
  function convertDOMString(V) {
    if (typeof V === "string") {
      return V;
    }
    if (typeof V === "symbol") {
      throw new TypeError("Cannot convert a Symbol value to a string");
    }
    return String(V);
  }

  // Install as enumerable globals (matches previous Rust `set_fn` —
  // plain `set`, writable/configurable/enumerable; matches every other
  // engine: Node, Deno, browsers — `Object.keys(globalThis)` includes
  // `alert`/`confirm`/`prompt`).
  const alertKey = "alert";
  const confirmKey = "confirm";
  const promptKey = "prompt";
  globalThis[alertKey] = alert;
  globalThis[confirmKey] = confirm;
  globalThis[promptKey] = prompt;
})(globalThis);