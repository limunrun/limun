//! Internal ESM modules — embedded at compile time, loaded by specifier.
//!
//! Internal modules live under the `ext:limun/` specifier scheme (analogous
//! to Deno's `ext:deno_web/…`). They are *trusted* — built into the binary
//! via `include_str!`, ungated by the permission system, and always
//! available.
//!
//! Note: `resolve_module_callback`/`dynamic_import_callback` recognize an
//! `ext:limun/…` specifier only when the referrer is itself an internal
//! module (its URL starts with `ext:limun/`). User/remote modules cannot
//! `import "ext:limun/…"` — the resolution throws a TypeError. This
//! prevents user code from reaching into internal APIs directly.
//!
//! The registry is a static `&[(specifier, source)]` slice built at compile
//! time. `resolve_specifier` + `source_for` are the two entry points the
//! module-resolution callbacks in `core::module` use; they bypass
//! `core::io` and `core::permissions` on purpose (see the invariant
//! documented in `core::io` — `ext:` is a fourth, deliberately-ungated
//! scheme alongside `data:`).
//!
//! Snapshotting compiled modules into the V8 snapshot is a later
//! optimization; for now every internal module is compiled on first import
//! like any other JS module and deduplicated through the normal
//! `state::REGISTRY` (keyed on a synthetic `ext:` URL).

use url::Url;

/// The internal-module scheme. Specifiers look like
/// `ext:limun/00_primordials.js`.
pub const SCHEME: &str = "ext";

/// The "extension" (namespace) under the scheme. `ext:limun/<path>`.
const NAMESPACE: &str = "limun";

/// One embedded internal module: its specifier and source text.
///
/// The source is `include_str!`'d at compile time — no IO at runtime.
pub struct InternalModule {
    pub specifier: &'static str,
    pub source: &'static str,
}

/// The static registry of every internal module, in evaluation order.
///
/// Order matters for bootstrap (see `core::mod::execute`): primordials must
/// run before anything that uses them. The registry order is the bootstrap
/// order; `bootstrap` evaluates them in this sequence.
pub static REGISTRY: &[InternalModule] = &[
    InternalModule {
        specifier: "ext:limun/00_primordials.js",
        source: include_str!("00_primordials.js"),
    },
    InternalModule {
        specifier: "ext:limun/00_webidl.js",
        source: include_str!("../web/00_webidl.js"),
    },
    InternalModule {
        specifier: "ext:limun/01_dom_exception.js",
        source: include_str!("../web/01_dom_exception.js"),
    },
    InternalModule {
        specifier: "ext:limun/00_url.js",
        source: include_str!("../web/00_url.js"),
    },
    InternalModule {
        specifier: "ext:limun/01_console.js",
        source: include_str!("../web/01_console.js"),
    },
    InternalModule {
        specifier: "ext:limun/02_timers.js",
        source: include_str!("../web/02_timers.js"),
    },
    InternalModule {
        specifier: "ext:limun/02_event.js",
        source: include_str!("../web/02_event.js"),
    },
    InternalModule {
        specifier: "ext:limun/02_structured_clone.js",
        source: include_str!("../web/02_structured_clone.js"),
    },
    InternalModule {
        specifier: "ext:limun/13_message_port.js",
        source: include_str!("../web/13_message_port.js"),
    },
    InternalModule {
        specifier: "ext:limun/03_crypto.js",
        source: include_str!("../web/03_crypto.js"),
    },
    InternalModule {
        specifier: "ext:limun/05_base64.js",
        source: include_str!("../web/05_base64.js"),
    },
    InternalModule {
        specifier: "ext:limun/08_text_encoding.js",
        source: include_str!("../web/08_text_encoding.js"),
    },
    InternalModule {
        specifier: "ext:limun/06_streams.js",
        source: include_str!("../web/06_streams.js"),
    },
    InternalModule {
        specifier: "ext:limun/09_blob.js",
        source: include_str!("../web/09_blob.js"),
    },
    InternalModule {
        specifier: "ext:limun/10_form_data.js",
        source: include_str!("../web/10_form_data.js"),
    },
    InternalModule {
        specifier: "ext:limun/15_performance.js",
        source: include_str!("../web/15_performance.js"),
    },
    InternalModule {
        specifier: "ext:limun/19_body.js",
        source: include_str!("../web/19_body.js"),
    },
    InternalModule {
        specifier: "ext:limun/20_headers.js",
        source: include_str!("../web/20_headers.js"),
    },
    InternalModule {
        specifier: "ext:limun/21_request.js",
        source: include_str!("../web/21_request.js"),
    },
    InternalModule {
        specifier: "ext:limun/22_response.js",
        source: include_str!("../web/22_response.js"),
    },
    InternalModule {
        specifier: "ext:limun/23_fetch.js",
        source: include_str!("../web/23_fetch.js"),
    },
    InternalModule {
        specifier: "ext:limun/41_prompt.js",
        source: include_str!("../web/41_prompt.js"),
    },
    InternalModule {
        specifier: "ext:limun/99_test.js",
        source: include_str!("99_test.js"),
    },
];

/// Is `specifier` an internal module specifier?
///
/// Recognizes `ext:limun/<path>`. Other `ext:` namespaces (future) would
/// be added here. Returns `false` for anything that isn't `ext:` at all —
/// the caller uses this to short-circuit before the normal URL/permission
/// path.
pub fn is_internal(specifier: &str) -> bool {
    specifier.starts_with(&format!("{SCHEME}:{NAMESPACE}/"))
        || specifier == format!("{SCHEME}:{NAMESPACE}")
}

/// Look up the source text for an internal specifier. Returns `None` for
/// an `ext:limun/…` specifier that isn't in the registry (a typo, or a
/// not-yet-ported module).
pub fn source_for(specifier: &str) -> Option<&'static str> {
    REGISTRY
        .iter()
        .find(|m| m.specifier == specifier)
        .map(|m| m.source)
}

/// Turn an internal specifier into a synthetic `Url` for the dedup
/// registry. `url::Url` accepts opaque schemes, so `ext:limun/…` parses
/// fine and round-trips through `as_str()` losslessly.
///
/// Used as the `REGISTRY` cache key so internal modules dedup with each
/// other and with any dynamic `import("ext:limun/…")` (though only
/// internal code can issue those — see `is_internal`).
pub fn specifier_url(specifier: &str) -> Option<Url> {
    Url::parse(specifier).ok()
}

/// Iterate the registry in bootstrap order. `bootstrap` uses this to
/// evaluate primordials → infra modules before user code.
pub fn iter() -> impl Iterator<Item = &'static InternalModule> {
    REGISTRY.iter()
}