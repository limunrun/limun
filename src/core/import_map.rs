//! Read ./limun.json (optional). Import map root = its directory (= CWD).

use crate::core::state::IMPORT_MAP;
use std::collections::HashMap;
use std::path::PathBuf;
use std::{env, fs};

pub fn load_import_map() -> Result<(), String> {
    let path = PathBuf::from("limun.json");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(()), // no limun.json: fine, no map
    };

    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let mut imports = HashMap::new();
    if let Some(obj) = json.get("imports").and_then(|v| v.as_object()) {
        for (key, value) in obj {
            let Some(target) = value.as_str() else {
                return Err(format!("imports[\"{key}\"] must be a string"));
            };
            imports.insert(key.clone(), target.to_string());
        }
    }

    let root = env::current_dir().map_err(|e| e.to_string())?;
    IMPORT_MAP.with(|m| *m.borrow_mut() = Some((root, imports)));
    Ok(())
}