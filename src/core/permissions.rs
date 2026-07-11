//! Unified IO permissions, configured in `./limun.json`'s `permissions`
//! field. Everything that does IO is a URL — a local file is a `file:`
//! URL, a remote module or `fetch()` target is an `https:` URL — so one
//! pattern list covers all of it:
//!
//! ```json
//! "permissions": {
//!   "io": {
//!     "default": true,
//!     "https://evil.com/": { "read": false, "write": false },
//!     "file://**": { "read": true }
//!   },
//!   "legacy": false
//! }
//! ```
//!
//! ## `io` — the allowlist
//!
//! Keys are URL patterns (plus the special `"default"` key). Keys without
//! `://` are file-path patterns, resolved against the current directory
//! into `file:` URLs. The scheme in the pattern is the mechanism gate —
//! `"file://**"` allows all disk IO, `"https://**"` allows all network IO.
//! No separate kill switches needed; the pattern says what it says.
//!
//! Values are `true` (read+write), `false` (grants nothing — placeholder),
//! or `{ read?, write? }`.
//!
//! Pattern syntax, matched against the *serialized* URL (lowercase
//! scheme/host, default ports omitted):
//! - `*`  — any run of characters except `/`
//! - `?`  — any single character except `/`
//! - `**` — any run of characters, `/` included
//! - a trailing `/` is prefix-match sugar (equivalent to appending `**`)
//!
//! ## `default` — the fallback grant
//!
//! The special `"default"` key sets the grant for URLs that don't match any
//! explicit pattern. It defaults to `false` (deny unmatched — whitelist
//! mode). Set `"default": true` for blacklist mode: everything allowed
//! except what you explicitly deny.
//!
//! Missing `read`/`write` fields in a pattern entry inherit from `default`
//! — so `"https://api.example.com/": {}` with `"default": true` grants both
//! read and write, while with `"default": false` (or absent) it grants
//! neither.
//!
//! Grants are union-only and order-independent: an operation is allowed
//! iff *some* matching entry grants its mode (including inherited fields).
//! No entry ever vetoes another — an explicit `false` only means "this
//! entry doesn't grant"; it doesn't override a grant from another matching
//! entry.
//!
//! ## `legacy` — capability opt-in
//!
//! Boolean (default `false`) gating the future `Limun.legacy.nodejs.*` surface.
//!
//! ## Defaults
//!
//! No `limun.json` / no `permissions` key: allow-all (this is a config
//! knob for constraining a deployment, not a zero-trust sandbox by
//! default). Once a `permissions` key exists: an omitted `io` denies all
//! IO, and `legacy` stays off.
//!
//! The entry script is exempt from the `io` list (the user invoked it
//! explicitly — it would be absurd to deny the very thing you asked to
//! run). Everything else, including modules imported by the entry script,
//! is subject to the `io` list.
//!
//! `data:` module specifiers are ungated: the bytes are embedded in the
//! specifier itself (no IO happens, and the importing code was itself
//! already granted), so the `io` list doesn't apply to them.
//!
//! There is deliberately no interactive prompting: prompting halts the
//! program until a human finds the terminal. Anything not granted by
//! `limun.json` is rejected, immediately and loudly.
//!
//! The old `permissions.read` / `permissions.net` array form is gone;
//! its presence is a hard startup error pointing here.

use serde_json::Value;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

/// What the operation does to the target. Reads: loading a module,
/// GET/HEAD/OPTIONS requests, reading a file. Writes: state-changing
/// request methods (POST/PUT/DELETE/...), writing a file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Read,
    Write,
}

struct IoEntry {
    /// Normalized pattern: file-path keys converted to `file:` URL
    /// patterns, trailing-`/` sugar expanded to `**`.
    pattern: String,
    /// `None` = inherit from default.
    read: Option<bool>,
    /// `None` = inherit from default.
    write: Option<bool>,
}

struct Permissions {
    /// `None` = no `permissions` key at all: allow everything.
    /// `Some(entries)` = allowlist (possibly empty + default).
    io: Option<(Vec<IoEntry>, bool)>,
    legacy: bool,
}

thread_local! {
    static PERMISSIONS: RefCell<Permissions> = const {
        RefCell::new(Permissions {
            io: None,
            legacy: true, // allow-all default; flips to opt-in once a `permissions` key exists
        })
    };
    /// The entry script's URL — exempt from the `io` list (the user
    /// invoked it explicitly). Everything else, including modules it
    /// imports, is subject to the allowlist.
    static ENTRY_URL: RefCell<Option<Url>> = const { RefCell::new(None) };
}

/// Record the entry script's URL (called once from `main` before
/// execution). See `ENTRY_URL`.
pub fn set_entry(url: Url) {
    ENTRY_URL.with(|e| *e.borrow_mut() = Some(url));
}

pub fn load() -> Result<(), String> {
    let text = match fs::read_to_string("limun.json") {
        Ok(t) => t,
        Err(_) => return Ok(()), // no limun.json at all: allow-all (default)
    };
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let Some(perm) = json.get("permissions") else {
        return Ok(()); // no "permissions" key: allow-all (default)
    };
    let obj = perm.as_object().ok_or("\"permissions\" must be an object")?;

    // Old schema is a hard error, not a silent legacy path.
    if obj.contains_key("read") {
        return Err(
            "permissions.read is gone — the read/net array form was replaced by the \
             unified permissions.io pattern map (see src/core/permissions.rs)"
                .to_string(),
        );
    }
    if matches!(obj.get("net"), Some(Value::Array(_))) {
        return Err(
            "permissions.net is gone — host allowlists moved to the unified \
             permissions.io pattern map. Use \"https://**\" or similar instead \
             (see src/core/permissions.rs)"
                .to_string(),
        );
    }
    if obj.contains_key("import") || obj.contains_key("fs") {
        return Err(
            "permissions.import / permissions.fs are gone — the scheme in the io \
             pattern is the gate (e.g. \"file://**\" for disk, \"https://**\" for \
             network). See src/core/permissions.rs"
                .to_string(),
        );
    }

    for key in obj.keys() {
        if !matches!(key.as_str(), "io" | "legacy") {
            return Err(format!(
                "permissions.{key} is not a thing (known: io, legacy)"
            ));
        }
    }

    let io = match obj.get("io") {
        // `permissions` exists but `io` doesn't: deny all IO (default false).
        None => (Vec::new(), false),
        Some(v) => parse_io(v).map_err(|e| format!("permissions.io: {e}"))?,
    };
    let legacy =
        parse_switch(obj.get("legacy"), false).map_err(|e| format!("permissions.legacy: {e}"))?;

    PERMISSIONS.with(|p| {
        *p.borrow_mut() = Permissions {
            io: Some(io),
            legacy,
        }
    });
    Ok(())
}

fn parse_switch(v: Option<&Value>, default: bool) -> Result<bool, String> {
    match v {
        None => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err("must be a boolean".to_string()),
    }
}

fn parse_io(v: &Value) -> Result<(Vec<IoEntry>, bool), String> {
    let obj = v
        .as_object()
        .ok_or("must be an object mapping URL/path patterns to grants")?;

    // Extract the special "default" key before pattern parsing.
    let mut default = false;
    let mut entries = Vec::with_capacity(obj.len().saturating_sub(1));
    for (key, value) in obj {
        if key == "default" {
            default = match value {
                Value::Bool(b) => *b,
                Value::Object(grant) => {
                    for k in grant.keys() {
                        if !matches!(k.as_str(), "read" | "write") {
                            return Err(format!("\"default\": unknown grant field \"{k}\""));
                        }
                    }
                    let field = |name: &str| -> Result<bool, String> {
                        match grant.get(name) {
                            None => Ok(false),
                            Some(Value::Bool(b)) => Ok(*b),
                            Some(_) => Err(format!("\"default\": \"{name}\" must be a boolean")),
                        }
                    };
                    field("read")? || field("write")?
                }
                _ => return Err("\"default\": must be `true`, `false`, or { read?, write? }".to_string()),
            };
            continue;
        }

        let (read, write) = match value {
            Value::Bool(true) => (Some(true), Some(true)),
            Value::Bool(false) => (Some(false), Some(false)),
            Value::Object(grant) => {
                for k in grant.keys() {
                    if !matches!(k.as_str(), "read" | "write") {
                        return Err(format!("\"{key}\": unknown grant field \"{k}\""));
                    }
                }
                let field = |name: &str| -> Result<Option<bool>, String> {
                    match grant.get(name) {
                        None => Ok(None),
                        Some(Value::Bool(b)) => Ok(Some(*b)),
                        Some(_) => Err(format!("\"{key}\": \"{name}\" must be a boolean")),
                    }
                };
                (field("read")?, field("write")?)
            }
            _ => {
                return Err(format!(
                    "\"{key}\": must be `true`, `false`, or {{ read?, write? }}"
                ));
            }
        };
        entries.push(IoEntry {
            pattern: normalize_pattern(key),
            read,
            write,
        });
    }
    Ok((entries, default))
}

/// Check whether a `mode` operation on `url` is permitted.
///
/// Semantics:
/// 1. If any matching pattern explicitly sets this mode to `false` → deny.
///    (Explicit deny wins — makes blacklist mode work with `default: true`.)
/// 2. If any matching pattern explicitly sets this mode to `true` → allow.
/// 3. If no matching pattern explicitly sets this mode → fall back to `default`.
pub fn check(url: &Url, mode: Mode) -> Result<(), String> {
    PERMISSIONS.with(|p| {
        let perms = p.borrow();

        // The entry script is exempt from the io list.
        let is_entry = ENTRY_URL.with(|e| e.borrow().as_ref() == Some(url));
        if is_entry {
            return Ok(());
        }

        let Some((entries, default)) = &perms.io else {
            return Ok(()); // no `permissions` key: allow-all
        };
        let target = url.as_str();

        let mut explicit = false;
        for entry in entries {
            if glob_match(&entry.pattern, target) {
                let field = match mode {
                    Mode::Read => &entry.read,
                    Mode::Write => &entry.write,
                };
                if let Some(value) = field {
                    if !value {
                        // Explicit deny wins.
                        let verb = match mode {
                            Mode::Read => "read",
                            Mode::Write => "write",
                        };
                        return Err(format!(
                            "{verb} access to \"{target}\" is denied by \
                             limun.json's permissions.io"
                        ));
                    }
                    explicit = true;
                }
            }
        }
        if explicit {
            return Ok(()); // matched, at least one explicitly granted, none denied.
        }
        // No explicit setting — fall back to default.
        if *default {
            Ok(())
        } else {
            let verb = match mode {
                Mode::Read => "read",
                Mode::Write => "write",
            };
            Err(format!(
                "{verb} access to \"{target}\" is not permitted (no matching grant in \
                 limun.json's permissions.io)"
            ))
        }
    })
}

/// Convenience: check a local-disk operation by `Path` (converted to a
/// canonical `file:` URL first, so symlinks/`..` can't sidestep grants).
pub fn check_file(path: &Path, mode: Mode) -> Result<(), String> {
    let abs = absolutize(path);
    let url = Url::from_file_path(&abs)
        .map_err(|_| format!("cannot form a file: URL from \"{}\"", abs.display()))?;
    check(&url, mode)
}

/// Check whether the (future) `Limun.legacy.nodejs.*` surface may be used.
/// No call site yet — the gate exists so `Limun.legacy.nodejs` lands pre-gated.
#[allow(dead_code)]
pub fn check_legacy() -> Result<(), String> {
    PERMISSIONS.with(|p| {
        if p.borrow().legacy {
            Ok(())
        } else {
            Err("Limun.legacy.nodejs requires permission (set limun.json's permissions.legacy to true)"
                .to_string())
        }
    })
}

/// Turn a raw `io` key into a matchable pattern over serialized URLs.
/// Keys containing `://` are already URL patterns; anything else is a
/// file-path pattern, absolutized against the current directory. A
/// trailing `/` becomes `/**` (prefix-match sugar).
fn normalize_pattern(raw: &str) -> String {
    let mut pattern = if raw.contains("://") {
        raw.to_string()
    } else {
        path_pattern_to_url(raw)
    };
    if pattern.ends_with('/') {
        pattern.push_str("**");
    }
    pattern
}

/// Convert a file-path pattern to a `file:` URL pattern. The literal
/// directory prefix (everything before the first glob character, up to
/// its last `/`) is canonicalized so patterns and (canonicalized)
/// targets agree on symlinks and `..`; the glob tail is appended as-is.
fn path_pattern_to_url(raw: &str) -> String {
    let glob_at = raw.find(['*', '?']).unwrap_or(raw.len());
    let (literal, glob) = raw.split_at(glob_at);
    let (dir, rest) = match literal.rfind('/') {
        Some(i) => (&literal[..=i], &literal[i + 1..]),
        None => ("./", literal),
    };
    let dir_abs = absolutize(Path::new(dir));
    let mut pattern = match Url::from_directory_path(&dir_abs) {
        Ok(u) => u.to_string(),
        Err(()) => format!("file://{}/", dir_abs.display()),
    };
    pattern.push_str(rest);
    pattern.push_str(glob);
    pattern
}

/// Canonicalize if possible; otherwise make absolute against the current
/// directory (a nonexistent path can still be denied/granted correctly).
fn absolutize(path: &Path) -> PathBuf {
    match fs::canonicalize(path) {
        Ok(p) => p,
        Err(_) => {
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(path))
                    .unwrap_or_else(|_| path.to_path_buf())
            }
        }
    }
}

/// Minimal glob matcher: `*` = any run except `/`, `?` = one char except
/// `/`, `**` = any run including `/`. Byte-wise (URLs are ASCII-serialized;
/// multi-byte UTF-8 never contains ASCII bytes, so `*`/`**` runs stay
/// correct and `?` simply won't match a non-ASCII char — fine for config).
fn glob_match(pattern: &str, text: &str) -> bool {
    matches_bytes(pattern.as_bytes(), text.as_bytes())
}

fn matches_bytes(p: &[u8], t: &[u8]) -> bool {
    let Some(&head) = p.first() else {
        return t.is_empty();
    };
    match head {
        b'*' => {
            if p.get(1) == Some(&b'*') {
                // `**`: consume any run, `/` included.
                (0..=t.len()).any(|i| matches_bytes(&p[2..], &t[i..]))
            } else {
                // `*`: consume any run that contains no `/`.
                (0..=t.len())
                    .take_while(|&i| i == 0 || t[i - 1] != b'/')
                    .any(|i| matches_bytes(&p[1..], &t[i..]))
            }
        }
        b'?' => !t.is_empty() && t[0] != b'/' && matches_bytes(&p[1..], &t[1..]),
        c => t.first() == Some(&c) && matches_bytes(&p[1..], &t[1..]),
    }
}