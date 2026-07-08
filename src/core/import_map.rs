//! Reads ./limun.json's import map — the WHATWG HTML import map shape:
//! `imports`, `scopes`, and `integrity`
//! (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap).
//!
//! Base URL for resolving relative map values is the current working
//! directory (limun.json's own directory), as a `file://` URL — this is
//! also why every module specifier in this runtime is a `url::Url`: local
//! and remote imports resolve through the exact same relative-URL-joining
//! logic (see `core::resolver`).
//!
//! `integrity` is parsed and stored as a per-resolved-URL map of SRI
//! strings (`sha256-<base64>`). Enforcement happens in `core::module`
//! after the module body is fetched — see `integrity_for`.

use crate::core::state::IMPORT_MAP;
use serde_json::Value;
use std::collections::HashMap;
use std::{env, fs};
use url::Url;

/// A "module specifier map": key text -> resolved URL, or `None` if the key
/// is explicitly mapped to `null` (spec-legal way to block a specifier).
pub type SpecifierMap = HashMap<String, Option<Url>>;

/// Resolved-URL -> SRI integrity string (`sha256-<base64>`). Looked up by
/// `core::module` after a fetch to verify the body's SHA-256.
pub type IntegrityMap = HashMap<Url, String>;

pub struct ImportMap {
    pub imports: SpecifierMap,
    /// (scope URL, its specifier map), pre-sorted most-specific (longest)
    /// scope URL first, per spec's scope-matching order.
    pub scopes: Vec<(Url, SpecifierMap)>,
    /// Per-resolved-URL integrity hashes (from the top-level `integrity`
    /// block). Only sha256 entries are honored; other algorithms are
    /// ignored with no error (see `core::module::verify_integrity`).
    pub integrity: IntegrityMap,
}

pub fn load_import_map() -> Result<(), String> {
    let path = std::path::PathBuf::from("limun.json");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(()), // no limun.json: fine, no map
    };

    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !json.is_object() {
        return Err("limun.json must be a JSON object".to_string());
    }

    let cwd = env::current_dir().map_err(|e| e.to_string())?;
    let base = Url::from_directory_path(&cwd)
        .map_err(|_| "cannot form a base URL from the current directory".to_string())?;

    let imports = match json.get("imports") {
        Some(v) => parse_specifier_map(v, &base).map_err(|e| format!("imports: {e}"))?,
        None => SpecifierMap::new(),
    };

    let mut scopes: Vec<(Url, SpecifierMap)> = Vec::new();
    if let Some(v) = json.get("scopes") {
        let obj = v.as_object().ok_or("\"scopes\" must be an object")?;
        for (scope_key, map_value) in obj {
            let scope_url = base
                .join(scope_key)
                .map_err(|e| format!("scopes[\"{scope_key}\"]: invalid scope URL: {e}"))?;
            let map = parse_specifier_map(map_value, &base)
                .map_err(|e| format!("scopes[\"{scope_key}\"]: {e}"))?;
            scopes.push((scope_url, map));
        }
    }
    // Most specific (longest) scope URL matches first.
    scopes.sort_by(|(a, _), (b, _)| b.as_str().len().cmp(&a.as_str().len()));

    // `integrity` is an object whose keys are module specifiers (bare
    // names, URL-like strings, or prefix keys ending in '/') and whose
    // values are SRI strings ("sha256-<base64>"). We resolve each key
    // the same way `imports` keys resolve (against `base`), then key
    // the integrity map by the *resolved URL* — that's the identity
    // `core::module` has in hand when it fetches a body.
    let mut integrity: IntegrityMap = IntegrityMap::new();
    if let Some(v) = json.get("integrity") {
        let obj = v.as_object().ok_or("\"integrity\" must be an object")?;
        for (key, value) in obj {
            let sri = value
                .as_str()
                .ok_or_else(|| format!("integrity[\"{key}\"]: must be a string"))?
                .to_string();
            // Resolve the integrity key the same way a specifier key
            // resolves: URL-like keys join against `base`; bare names are
            // looked up in the already-parsed `imports` so the integrity
            // entry tracks the same resolved URL the import map dispatches
            // to. Prefix keys (ending in '/') resolve to their prefix
            // base URL; `integrity_for` does prefix matching for those.
            let resolved = if key.ends_with('/') {
                resolve_map_value(key, &base).or_else(|| base.join(key).ok())
            } else if let Some(opt_url) = imports.get(key) {
                opt_url.clone()
            } else {
                resolve_map_value(key, &base)
            };
            if let Some(url) = resolved {
                integrity.insert(url, sri);
            }
            // A key that resolves to None (e.g. a bare name mapped to
            // null) has no URL to attach an integrity hash to — skip it.
        }
    }

    IMPORT_MAP.with(|m| {
        *m.borrow_mut() = Some(ImportMap {
            imports,
            scopes,
            integrity,
        })
    });
    Ok(())
}

fn parse_specifier_map(value: &Value, base: &Url) -> Result<SpecifierMap, String> {
    let obj = value.as_object().ok_or("must be an object")?;
    let mut map = SpecifierMap::new();
    for (key, target) in obj {
        if key.is_empty() {
            return Err("keys must not be empty".to_string());
        }
        let resolved = match target {
            Value::Null => None,
            Value::String(s) => {
                let url = resolve_map_value(s, base)
                    .ok_or_else(|| format!("[\"{key}\"]: invalid URL \"{s}\""))?;
                if key.ends_with('/') && !url.as_str().ends_with('/') {
                    return Err(format!(
                        "[\"{key}\"]: a key ending in \"/\" must map to a value ending in \"/\""
                    ));
                }
                Some(url)
            }
            _ => return Err(format!("[\"{key}\"] must be a string or null")),
        };
        map.insert(key.clone(), resolved);
    }
    Ok(map)
}

fn resolve_map_value(value: &str, base: &Url) -> Option<Url> {
    if value.starts_with("./") || value.starts_with("../") || value.starts_with('/') {
        base.join(value).ok()
    } else {
        Url::parse(value).ok()
    }
}

/// Look up the SRI integrity string for a fetched module URL in the parsed
/// import map. Returns the first matching entry: exact-URL match first, then
/// the longest prefix key (a URL stored under a key ending in `/`). `None`
/// if no integrity was declared for this URL (the common case — integrity
/// is opt-in per entry).
pub fn integrity_for(url: &Url) -> Option<String> {
    IMPORT_MAP.with(|m| {
        let map = m.borrow();
        let map = map.as_ref()?;
        if let Some(sri) = map.integrity.get(url) {
            return Some(sri.clone());
        }
        // Prefix match: longest stored prefix-URL whose string form is a
        // prefix of `url`. Mirrors the import map's own prefix-key rule.
        map.integrity
            .iter()
            .filter(|(k, _)| k.as_str().ends_with('/') && url.as_str().starts_with(k.as_str()))
            .max_by_key(|(k, _)| k.as_str().len())
            .map(|(_, v)| v.clone())
    })
}
