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
//! `integrity` is accepted (so a spec-valid import map isn't rejected) but
//! not yet enforced — checksum verification is a separate, larger feature
//! (see MISSION.md's `#sha256`/lock-file roadmap).

use crate::core::state::IMPORT_MAP;
use serde_json::Value;
use std::collections::HashMap;
use std::{env, fs};
use url::Url;

/// A "module specifier map": key text -> resolved URL, or `None` if the key
/// is explicitly mapped to `null` (spec-legal way to block a specifier).
pub type SpecifierMap = HashMap<String, Option<Url>>;

pub struct ImportMap {
    pub imports: SpecifierMap,
    /// (scope URL, its specifier map), pre-sorted most-specific (longest)
    /// scope URL first, per spec's scope-matching order.
    pub scopes: Vec<(Url, SpecifierMap)>,
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

    // Not enforced yet — just validated so a spec-shaped map isn't rejected.
    if let Some(v) = json.get("integrity") {
        if !v.is_object() {
            return Err("\"integrity\" must be an object".to_string());
        }
    }

    IMPORT_MAP.with(|m| *m.borrow_mut() = Some(ImportMap { imports, scopes }));
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
