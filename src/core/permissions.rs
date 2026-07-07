//! Deno-style fs/net allowlists, configured in `./limun.json`'s
//! `permissions` field rather than CLI flags:
//!
//! ```json
//! "permissions": {
//!   "read": ["./examples/", "./limun.json"],
//!   "net": ["esm.sh", "*.jsdelivr.net", "example.com:8080"]
//! }
//! ```
//!
//! Both `read`/`net` may also just be `true` (allow everything) or
//! `false`/omitted (deny everything) instead of a list.
//!
//! Gates the exact same two functions module loading already goes
//! through (`core::io::read_file`/`core::io::fetch`) — see that module's
//! doc comment. This means the entry script + every local/remote module
//! it imports is *also* subject to these rules, same as a future
//! `Limun.fs.*`/JS `fetch()` call would be — one gate, no exceptions.
//!
//! Deliberately simpler than Deno's actual security model: no
//! prompting, no distinguishing "module graph" net access from a
//! runtime `fetch()` call, no CIDR ranges. And unlike Deno (secure by
//! default, opt out via flags), an *absent* `permissions` key here
//! defaults to allow-all — this is a config knob for constraining a
//! deployment, not a zero-trust sandbox by default (that's a larger,
//! separate feature). Once you *do* add a `permissions` key, each
//! sub-domain (`read`/`net`) you don't mention defaults to deny, so it's
//! still "secure once you opt in".

use serde_json::Value;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

#[derive(Clone)]
enum Rule {
    All,
    None,
    List(Vec<String>),
}

struct Permissions {
    read: Rule,
    net: Rule,
}

thread_local! {
    static PERMISSIONS: RefCell<Permissions> = const {
        RefCell::new(Permissions { read: Rule::All, net: Rule::All })
    };
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

    let read = parse_rule(obj.get("read")).map_err(|e| format!("permissions.read: {e}"))?;
    let net = parse_rule(obj.get("net")).map_err(|e| format!("permissions.net: {e}"))?;

    PERMISSIONS.with(|p| *p.borrow_mut() = Permissions { read, net });
    Ok(())
}

fn parse_rule(v: Option<&Value>) -> Result<Rule, String> {
    match v {
        // Mentioned in "permissions" but this sub-domain isn't: deny.
        None => Ok(Rule::None),
        Some(Value::Bool(true)) => Ok(Rule::All),
        Some(Value::Bool(false)) => Ok(Rule::None),
        Some(Value::Array(items)) => {
            let mut list = Vec::with_capacity(items.len());
            for item in items {
                let s = item.as_str().ok_or("entries must be strings")?;
                list.push(s.to_string());
            }
            Ok(Rule::List(list))
        }
        Some(_) => Err("must be `true`, `false`, or an array of strings".to_string()),
    }
}

/// Check whether reading `path` off local disk is permitted.
pub fn check_read(path: &Path) -> Result<(), String> {
    PERMISSIONS.with(|p| match &p.borrow().read {
        Rule::All => Ok(()),
        Rule::None => Err(format!(
            "read access to \"{}\" requires permission (add it to limun.json's permissions.read)",
            path.display()
        )),
        Rule::List(entries) => {
            let target = canonicalize_best_effort(path);
            for entry in entries {
                let entry_path = canonicalize_best_effort(Path::new(entry));
                if target.starts_with(&entry_path) {
                    return Ok(());
                }
            }
            Err(format!(
                "read access to \"{}\" is not permitted (not covered by limun.json's permissions.read)",
                path.display()
            ))
        }
    })
}

/// Check whether a network request to `url` is permitted. Matches
/// against `url`'s host, optionally exact-port-qualified
/// (`"host:port"`) or subdomain-wildcarded (`"*.example.com"`).
pub fn check_net(url: &Url) -> Result<(), String> {
    PERMISSIONS.with(|p| match &p.borrow().net {
        Rule::All => Ok(()),
        Rule::None => Err(format!(
            "network access to \"{url}\" requires permission (add it to limun.json's permissions.net)"
        )),
        Rule::List(entries) => {
            let host = url.host_str().unwrap_or("");
            let port = url.port_or_known_default();
            for entry in entries {
                if let Some((entry_host, entry_port)) = entry.rsplit_once(':') {
                    if entry_host == host && port.map(|p| p.to_string()).as_deref() == Some(entry_port) {
                        return Ok(());
                    }
                } else if entry == host {
                    return Ok(());
                } else if let Some(suffix) = entry.strip_prefix("*.") {
                    if let Some(rest) = host.strip_suffix(suffix) {
                        if rest.ends_with('.') {
                            return Ok(());
                        }
                    }
                }
            }
            Err(format!(
                "network access to \"{url}\" is not permitted (not covered by limun.json's permissions.net)"
            ))
        }
    })
}

fn canonicalize_best_effort(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
