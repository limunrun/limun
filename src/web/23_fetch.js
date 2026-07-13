// Copyright 2026 the Limun authors. MIT license.

// `fetch()` — WHATWG Fetch Standard
// (https://fetch.spec.whatwg.org/#fetch-method).
//
// Migrated from Rust (`web::fetch::mod.rs`'s `fetch()` JS-facing half,
// ~200 of its 347 lines) to JS-on-ops. The HTTP transport itself
// (reqwest + tokio + the bridge channel, permission check, abort
// cancellation) stays in Rust as `op_fetch` (`src/web/fetch/mod.rs`,
// registered in `core::ops`) — that's irreducible native work (network
// I/O, async runtime, thread coordination). This module owns every bit
// of *spec* behavior: parsing `input`/`init` into a flat
// method/url/headers/body/signal, and building the `Response` from
// `op_fetch`'s flat result.
//
// `op_fetch(method, url, headerPairs, body, signal)` returns a real
// `Promise`:
//   - Resolves with a *flat* plain object (not a `Response`):
//     `{ status, statusText, headers /* [string, string][] */, body
//     /* Uint8Array */, url /* final, post-redirect */, redirected
//     /* boolean */ }`. `buildResponseFromFlat` below turns that into an
//     actual `Response` via `22_response.js`'s internal
//     `newResponseInstance` factory.
//   - Rejects with whatever Rust decided is the right rejection value:
//     a `TypeError` (invalid URL, permission denied, network failure)
//     or the `AbortSignal`'s abort reason (any value) if cancelled —
//     passed straight through, unwrapped.
//
// Simplifications vs. spec (matches the previous Rust `fetch()`):
//   - `input` may be a `Request` instance or a string; `Request`'s
//     `mode`/`credentials`/`cache`/etc. fields don't exist to lose.
//   - Never rejects on a non-2xx HTTP status (that's `.ok === false`,
//     per spec) — only on a genuine network failure or abort.
//   - See `21_request.js`'s file header for the `init.signal` handling
//     bug fix shared with this module (previously: any `init` object at
//     all cleared an inherited signal, even without a `signal` key).

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ObjectDefineProperty,
    Promise,
    TypeError,
  } = primordials;

  const { op_fetch } = globalThis.__limunOps;
  const { getHeaderList, createHeaders, cloneHeaderPairs, parseHeadersInit } =
    globalThis.__bootstrap.headers;
  const { coerceBodyInit, createBodyState, drainStream } =
    globalThis.__bootstrap.body;
  const { isRequest, peekBodyBytes } = globalThis.__bootstrap.request;
  const { newResponseInstance } = globalThis.__bootstrap.response;

  function buildResponseFromFlat(flat) {
    return newResponseInstance(
      flat.status,
      flat.statusText,
      createHeaders(flat.headers, "response"),
      createBodyState(flat.body),
      flat.url,
      flat.redirected,
      "basic",
    );
  }

  function fetch(input) {
    const argCount = arguments.length;
    const init = argCount > 1 ? arguments[1] : undefined;

    return (async () => {
      if (argCount === 0) {
        throw new TypeError("fetch: 1 argument required, but only 0 present");
      }

      // Resolve `input`: a `Request` instance (clone its fields as the
      // base) or a string (the URL). `init` overrides the base.
      let method = "GET";
      let url = "";
      let headerPairs = [];
      let bodyBytes = null;
      let signal;

      if (
        typeof input === "object" && input !== null && isRequest(input)
      ) {
        method = input.method;
        url = input.url;
        headerPairs = cloneHeaderPairs(getHeaderList(input.headers));
        bodyBytes = await peekBodyBytes(input);
        signal = input.signal;
      }
      if (url === "") {
        url = String(input);
      }

      let normalizedUrl;
      try {
        normalizedUrl = new URL(url).href;
      } catch (e) {
        throw new TypeError(`fetch: invalid URL "${url}": ${e.message}`);
      }

      // `init` overrides (and may supply a `signal`, which wins over
      // any `Request`-inherited signal per spec).
      if (init !== undefined && init !== null) {
        if (init.method !== undefined) {
          method = String(init.method).toUpperCase();
        }
        if (init.headers !== undefined) {
          headerPairs = parseHeadersInit(init.headers);
        }
        if (init.body !== undefined && init.body !== null) {
          const coerced = coerceBodyInit(init.body);
          if (coerced.stream !== null) {
            bodyBytes = await drainStream(coerced.stream);
          } else {
            bodyBytes = coerced.bytes;
          }
          // Set the body-implied content-type unless the caller already
          // supplied one.
          if (coerced.contentType !== null) {
            let hasContentType = false;
            for (let i = 0; i < headerPairs.length; ++i) {
              if (headerPairs[i][0].toLowerCase() === "content-type") {
                hasContentType = true;
                break;
              }
            }
            if (!hasContentType) {
              headerPairs.push(["content-type", coerced.contentType]);
            }
          }
        }
        if (init.signal !== undefined) {
          signal = init.signal === null ? undefined : init.signal;
        }
      }

      // `AbortSignal`: pre-aborted → reject inline with the signal's
      // reason, no op call.
      if (signal !== undefined && signal.aborted) {
        throw signal.reason;
      }

      // Permission check, task spawn, and abort-listener wiring all
      // happen inside `op_fetch` (Rust) — it returns a Promise that
      // settles asynchronously via the event loop's bridge channel.
      const flat = await op_fetch(
        method,
        normalizedUrl,
        headerPairs,
        bodyBytes,
        signal,
      );
      return buildResponseFromFlat(flat);
    })();
  }

  // `fetch` is an ordinary operation (Web IDL §3.7.3 default:
  // enumerable) — verified against Node/Deno/browsers
  // (`Object.keys(globalThis)` includes "fetch" there), unlike the
  // non-enumerable interface objects (`Headers`/`Request`/`Response`).
  ObjectDefineProperty(globalThis, "fetch", {
    __proto__: null,
    value: fetch,
    writable: true,
    configurable: true,
    enumerable: true,
  });
})(globalThis);
