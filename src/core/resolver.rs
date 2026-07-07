//! Specifier -> absolute file path. Fail-loud: anything we don't support yet
//! errors with a message that says so, never silently misresolves.

use crate::core::state::IMPORT_MAP;
use std::path::{Path, PathBuf};
use std::fs;

pub fn resolve_specifier(specifier: &str, referrer_dir: &Path) -> Result<PathBuf, String> {
    // Not-yet-supported schemes: refuse loudly.
    if specifier.contains("://")
    {
        return Err(format!(
            "cannot resolve \"{specifier}\": only file imports are supported for now"
        ));
    }

    let candidate: PathBuf = IMPORT_MAP
        .with(|m| {
            let map = m.borrow();
            if let Some((root, imports)) = map.as_ref() {
                // 1. Exact match.
                if let Some(target) = imports.get(specifier) {
                    return Ok(join_map_target(root, target));
                }
                // 2. Longest prefix match on keys ending with '/' (web import maps).
                let mut best: Option<(&String, &String)> = None;
                for (key, target) in imports.iter() {
                    if key.ends_with('/') && specifier.starts_with(key.as_str()) {
                        if best.map_or(true, |(bk, _)| key.len() > bk.len()) {
                            best = Some((key, target));
                        }
                    }
                }
                if let Some((key, target)) = best {
                    let rest = &specifier[key.len()..];
                    let mut base = join_map_target(root, target);
                    base.push(rest);
                    return Ok(base);
                }
            }
            Err(())
        })
        .or_else(|_: ()| -> Result<PathBuf, String> {
            // 3. Plain path resolution.
            if specifier.starts_with("./") || specifier.starts_with("../") {
                Ok(referrer_dir.join(specifier))
            } else if specifier.starts_with('/') {
                Ok(PathBuf::from(specifier))
            } else {
                Err(format!(
                    "cannot resolve bare specifier \"{specifier}\": not in limun.json imports"
                ))
            }
        })?;

    fs::canonicalize(&candidate).map_err(|e| {
        format!(
            "cannot resolve \"{specifier}\" -> {}: {e}",
            candidate.display()
        )
    })
}

fn join_map_target(root: &Path, target: &str) -> PathBuf {
    if let Some(stripped) = target.strip_prefix("./") {
        root.join(stripped)
    } else if target.starts_with('/') {
        PathBuf::from(target)
    } else {
        root.join(target)
    }
}