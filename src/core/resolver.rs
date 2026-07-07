//! Specifier -> URL. Every module has a URL identity (`file://` local,
//! `https://`/`http://` remote) so relative resolution is one code path for
//! both — see `core::import_map` for why. Fail-loud: anything we don't
//! support yet errors with a message that says so, never silently
//! misresolves.
//!
//! Implements the WHATWG HTML "resolve a module specifier" + "resolve an
//! imports match" algorithms
//! (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap):
//! a specifier that's URL-like (absolute, or starts with `/`/`./`/`../`) is
//! resolved to a URL first; then *both* URL-like and bare specifiers are
//! looked up in the import map (scopes, most specific first, then the
//! top-level `imports`) — this is what lets an import map remap an absolute
//! URL, not just a bare name. If nothing matches, a resolved URL-like
//! specifier is used as-is; a bare specifier with no match is a hard error.

use crate::core::import_map::SpecifierMap;
use crate::core::state::IMPORT_MAP;
use url::Url;

pub fn resolve_specifier(specifier: &str, referrer: &Url) -> Result<Url, String> {
    let as_url = resolve_url_like(specifier, referrer);

    // Import maps can remap either a bare specifier ("lodash") or the
    // string form of an already-resolved URL — see spec note above.
    let lookup_key: &str = as_url.as_ref().map_or(specifier, |u| u.as_str());

    if let Some(result) = IMPORT_MAP.with(|m| {
        m.borrow()
            .as_ref()
            .and_then(|map| resolve_via_map(lookup_key, referrer, map))
    }) {
        return result;
    }

    as_url.ok_or_else(|| {
        format!("cannot resolve bare specifier \"{specifier}\": not in limun.json imports")
    })
}

/// "Is `specifier` URL-like, and if so, what URL does it resolve to."
fn resolve_url_like(specifier: &str, referrer: &Url) -> Option<Url> {
    if specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/') {
        referrer.join(specifier).ok()
    } else {
        Url::parse(specifier).ok()
    }
}

fn resolve_via_map(
    key: &str,
    referrer: &Url,
    map: &crate::core::import_map::ImportMap,
) -> Option<Result<Url, String>> {
    // Scopes, most specific (longest) matching prefix first.
    for (scope_url, scoped_map) in &map.scopes {
        if referrer.as_str().starts_with(scope_url.as_str()) {
            if let Some(result) = resolve_imports_match(key, scoped_map) {
                return Some(result);
            }
        }
    }
    resolve_imports_match(key, &map.imports)
}

fn resolve_imports_match(specifier: &str, map: &SpecifierMap) -> Option<Result<Url, String>> {
    // 1. Exact match.
    if let Some(value) = map.get(specifier) {
        return Some(blocked_or(specifier, value.clone()));
    }

    // 2. Longest prefix match on keys ending with '/' (web import maps).
    let mut best: Option<(&str, &Option<Url>)> = None;
    for (key, value) in map.iter() {
        if key.ends_with('/') && specifier.starts_with(key.as_str()) {
            if best.is_none_or(|(bk, _)| key.len() > bk.len()) {
                best = Some((key, value));
            }
        }
    }
    let (key, value) = best?;
    let Some(base) = value else {
        return Some(blocked_or(specifier, None));
    };

    let rest = &specifier[key.len()..];
    let joined = match base.join(rest) {
        Ok(u) => u,
        Err(e) => return Some(Err(format!("cannot resolve \"{specifier}\": {e}"))),
    };
    // Spec guard: a prefix-mapped specifier must not backtrack above its
    // mapped base (e.g. "shapes/../../etc/passwd" escaping "shapes/").
    if !joined.as_str().starts_with(base.as_str()) {
        return Some(Err(format!(
            "cannot resolve \"{specifier}\": backtracks above its mapped prefix \"{key}\""
        )));
    }
    Some(Ok(joined))
}

fn blocked_or(specifier: &str, value: Option<Url>) -> Result<Url, String> {
    value.ok_or_else(|| format!("\"{specifier}\" is blocked (mapped to null in limun.json)"))
}
