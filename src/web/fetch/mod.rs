//! `fetch()` — WHATWG Fetch Standard
//! (https://fetch.spec.whatwg.org/#fetch-method). Routes through
//! `core::io::fetch_full`, the same fs/net permission choke point module
//! loading uses (see `core::io`'s doc comment) — a restrictive
//! `permissions.net` in `limun.json` blocks `fetch()` exactly like it
//! blocks an `https:` import.
//!
//! Simplifications vs. spec:
//!   - Blocking/synchronous network I/O (no async I/O anywhere in this
//!     runtime yet — same simplification dynamic `import()` already
//!     makes) — the promise `fetch()` returns is always already
//!     settled by the time it's returned.
//!   - No `Request` class/overload — `input` must be a string (or
//!     anything that stringifies to a URL, e.g. a `URL` instance, since
//!     that just goes through ordinary `ToString`). Documented gap, same
//!     style as `Request` being unimplemented elsewhere.
//!   - No `AbortSignal`/`credentials`/`mode`/`redirect` options.
//!   - `fetch()` only rejects on a genuine network failure, never on a
//!     non-2xx HTTP status (that's `.ok === false`, per spec) — see
//!     `core::io::fetch_full`'s `http_status_as_error(false)`.

pub mod headers;
pub mod response;

use crate::core::io;
use crate::web::native;

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    headers::install(scope, global);
    response::install(scope, global);

    let key = v8::String::new(scope, "fetch").unwrap();
    let func = v8::Function::new(scope, fetch).unwrap();
    global.set(scope, key.into(), func.into());
}

fn fetch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    if args.length() == 0 {
        reject_type_error(scope, resolver, "fetch: 1 argument required, but only 0 present");
        return;
    }

    // `input` must be a string, or anything `ToString`-coercible to one
    // (e.g. a `URL` instance — its own `toString()` returns `href`).
    let url_str = args.get(0).to_rust_string_lossy(scope);
    let url = match url::Url::parse(&url_str) {
        Ok(u) => u,
        Err(e) => {
            reject_type_error(scope, resolver, &format!("fetch: invalid URL \"{url_str}\": {e}"));
            return;
        }
    };

    let mut method = "GET".to_string();
    let mut header_pairs = Vec::new();
    let mut body: Option<Vec<u8>> = None;

    if args.length() > 1 {
        if let Ok(init) = <v8::Local<v8::Object>>::try_from(args.get(1)) {
            let method_key = v8::String::new(scope, "method").unwrap();
            if let Some(v) = init.get(scope, method_key.into()) {
                if !v.is_undefined() {
                    method = v.to_rust_string_lossy(scope).to_uppercase();
                }
            }
            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(v) = init.get(scope, headers_key.into()) {
                if !v.is_undefined() {
                    header_pairs = headers::parse_value(scope, v);
                }
            }
            let body_key = v8::String::new(scope, "body").unwrap();
            if let Some(v) = init.get(scope, body_key.into()) {
                if !v.is_undefined() && !v.is_null() {
                    body = Some(
                        native::read_buffer_source(v).unwrap_or_else(|| v.to_rust_string_lossy(scope).into_bytes()),
                    );
                }
            }
        }
    }

    match io::fetch_full(&method, &url, &header_pairs, body) {
        Ok(response) => {
            let instance = response::new_instance(
                scope,
                response.status,
                response.status_text,
                response.headers,
                response.body,
                url_str,
            );
            resolver.resolve(scope, instance.into());
        }
        Err(message) => {
            let msg = v8::String::new(scope, &format!("fetch failed: {message}")).unwrap();
            let exception = v8::Exception::type_error(scope, msg);
            resolver.reject(scope, exception);
        }
    }
}

fn reject_type_error(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::type_error(scope, msg);
    resolver.reject(scope, exception);
}
