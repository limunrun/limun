//! Unified IO permissions, configured in `./limun.json`'s `permissions`
//! field. Everything that does IO is a URL — a local file is a `file:`
//! URL, a remote module or `fetch()` target is an `https:` URL — so one
//! pattern list covers all of it:
//!
//! ```json
//! "permissions": {
//!   "io": {
//!     "./": { "read": true },
//!     "https://esm.sh/": true,
//!     "https://api.example.com:8080/v*/": { "read": true, "write": true }
//!   },
//!   "import": true,
//!   "net": true,
//!   "fs": true,
//!   "legacy": false
//! }
//! ```
//!
//! ## `io` — the actual allowlist
//!
//! Keys are URL patterns; keys without `://` are file-path patterns,
//! resolved against the current directory into `file:` URLs. Values are
//! `true` (read+write), `false` (grants nothing — placeholder), or
//! `{ read?, write? }` (missing fields grant nothing).
//!
//! Pattern syntax, matched against the *serialized* URL (lowercase
//! scheme/host, default ports omitted):
//! - `*`  — any run of characters except `/`
//! - `?`  — any single character except `/`
//! - `**` — any run of characters, `/` included
//! - a trailing `/` is prefix-match sugar (equivalent to appending `**`)
//!
//! Grants are union-only and order-independent: an operation is allowed
//! iff *some* matching entry grants its mode. No entry ever vetoes
//! another — deny is simply the default for anything unmatched.
//!
//! ## `import` / `net` / `fs` — mechanism kill switches
//!
//! Plain booleans (default `true`) that close a whole mechanism
//! regardless of `io` grants: `import` gates module loading (static and
//! dynamic, local and remote — the entry script itself is exempt, since
//! the user invoked it), `net` gates the `fetch()` global (and future
//! network APIs), `fs` gates future `Limun.fs` / File System API
//! surface. An operation must pass both its mechanism switch *and* the
//! `io` list.
//!
//! ## `legacy` — capability opt-in
//!
//! Boolean (default `false`) gating the future `Limun.legacy.*` surface.
//!
//! ## Defaults
//!
//! No `limun.json` / no `permissions` key: allow-all (this is a config
//! knob for constraining a deployment, not a zero-trust sandbox by
//! default). Once a `permissions` key exists: an omitted `io` denies all
//! IO, omitted switches stay open (`io` is the boundary; the switches
//! only ever narrow), and `legacy` stays off.
//!
//! `data:` module specifiers are ungated: the bytes are embedded in the
//! specifier itself (no IO happens, and the importing code was itself
//! already granted), so neither the `import` switch nor the `io` list
//! applies to them.
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

/// Which runtime mechanism is performing the IO. Each has its own
/// boolean kill switch; all share the one `io` pattern list.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mechanism {
    /// Module loading — static or dynamic `import`, local or remote.
    Import,
    /// The `fetch()` global (and future network APIs).
    Net,
    /// Future `Limun.fs` / File System API surface. No call site yet —
    /// the gate exists so fs surface lands pre-gated, not retrofitted.
    #[allow(dead_code)]
    Fs,
}

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
    read: bool,
    write: bool,
}

struct Permissions {
    /// `None` = no `permissions` key at all: allow everything.
    /// `Some(entries)` = allowlist (possibly empty = deny all IO).
    io: Option<Vec<IoEntry>>,
    import_enabled: bool,
    net_enabled: bool,
    fs_enabled: bool,
    legacy: bool,
}

thread_local! {
    static PERMISSIONS: RefCell<Permissions> = const {
        RefCell::new(Permissions {
            io: None,
            import_enabled: true,
            net_enabled: true,
            fs_enabled: true,
            legacy: true, // allow-all default; flips to opt-in once a `permissions` key exists
        })
    };
    /// The entry script's URL — exempt from the `import` kill switch
    /// (the user invoked it), still subject to the `io` list.
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
            "permissions.net is a boolean kill switch now — host allowlists moved to \
             the unified permissions.io pattern map (see src/core/permissions.rs)"
                .to_string(),
        );
    }

    for key in obj.keys() {
        if !matches!(key.as_str(), "io" | "import" | "net" | "fs" | "legacy") {
            return Err(format!(
                "permissions.{key} is not a thing (known: io, import, net, fs, legacy)"
            ));
        }
    }

    let io = match obj.get("io") {
        // `permissions` exists but `io` doesn't: deny all IO.
        None => Vec::new(),
        Some(v) => parse_io(v).map_err(|e| format!("permissions.io: {e}"))?,
    };
    let import_enabled = parse_switch(obj.get("import"), true)
        .map_err(|e| format!("permissions.import: {e}"))?;
    let net_enabled =
        parse_switch(obj.get("net"), true).map_err(|e| format!("permissions.net: {e}"))?;
    let fs_enabled =
        parse_switch(obj.get("fs"), true).map_err(|e| format!("permissions.fs: {e}"))?;
    let legacy =
        parse_switch(obj.get("legacy"), false).map_err(|e| format!("permissions.legacy: {e}"))?;

    PERMISSIONS.with(|p| {
        *p.borrow_mut() = Permissions {
            io: Some(io),
            import_enabled,
            net_enabled,
            fs_enabled,
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

fn parse_io(v: &Value) -> Result<Vec<IoEntry>, String> {
    let obj = v
        .as_object()
        .ok_or("must be an object mapping URL/path patterns to grants")?;
    let mut entries = Vec::with_capacity(obj.len());
    for (key, value) in obj {
        let (read, write) = match value {
            Value::Bool(true) => (true, true),
            Value::Bool(false) => (false, false), // grants nothing; placeholder
            Value::Object(grant) => {
                for k in grant.keys() {
                    if !matches!(k.as_str(), "read" | "write") {
                        return Err(format!("\"{key}\": unknown grant field \"{k}\""));
                    }
                }
                let field = |name: &str| -> Result<bool, String> {
                    match grant.get(name) {
                        None => Ok(false),
                        Some(Value::Bool(b)) => Ok(*b),
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
    Ok(entries)
}

/// Check whether `mechanism` may perform a `mode` operation on `url`.
pub fn check(mechanism: Mechanism, url: &Url, mode: Mode) -> Result<(), String> {
    PERMISSIONS.with(|p| {
        let perms = p.borrow();

        let (enabled, switch_name) = match mechanism {
            Mechanism::Import => (perms.import_enabled, "import"),
            Mechanism::Net => (perms.net_enabled, "net"),
            Mechanism::Fs => (perms.fs_enabled, "fs"),
        };
        let is_entry = mechanism == Mechanism::Import
            && ENTRY_URL.with(|e| e.borrow().as_ref() == Some(url));
        if !enabled && !is_entry {
            return Err(format!(
                "{switch_name} is disabled (limun.json's permissions.{switch_name} is false)"
            ));
        }

        let Some(entries) = &perms.io else {
            return Ok(()); // no `permissions` key: allow-all
        };
        let target = url.as_str();
        for entry in entries {
            let granted = match mode {
                Mode::Read => entry.read,
                Mode::Write => entry.write,
            };
            if granted && glob_match(&entry.pattern, target) {
                return Ok(());
            }
        }
        let verb = match mode {
            Mode::Read => "read",
            Mode::Write => "write",
        };
        Err(format!(
            "{verb} access to \"{target}\" is not permitted (no matching grant in \
             limun.json's permissions.io)"
        ))
    })
}

/// Convenience: check a local-disk operation by `Path` (converted to a
/// canonical `file:` URL first, so symlinks/`..` can't sidestep grants).
pub fn check_file(mechanism: Mechanism, path: &Path, mode: Mode) -> Result<(), String> {
    let abs = absolutize(path);
    let url = Url::from_file_path(&abs)
        .map_err(|_| format!("cannot form a file: URL from \"{}\"", abs.display()))?;
    check(mechanism, &url, mode)
}

/// Check whether the (future) `Limun.legacy.*` surface may be used.
/// No call site yet — the gate exists so `Limun.legacy` lands pre-gated.
#[allow(dead_code)]
pub fn check_legacy() -> Result<(), String> {
    PERMISSIONS.with(|p| {
        if p.borrow().legacy {
            Ok(())
        } else {
            Err("Limun.legacy requires permission (set limun.json's permissions.legacy to true)"
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
