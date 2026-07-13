//! URL-based file system library — the permission gate for the whole project
//! and the single place synchronous / module-loading byte IO happens.
//!
//! Every operation works on [`Url`]s, not bare paths. The scheme is the
//! mechanism gate: `file:` reads from disk, `http:`/`https:` fetches over the
//! network, `data:` decodes inline. The caller never picks a handler — they
//! hand the IO layer a URL and it dispatches on scheme internally. Adding a new
//! scheme is one place, not scattered across the codebase.
//!
//! ## The one invariant
//!
//! Every permission decision in the project is made by [`permissions::check`],
//! reached through this module. There is *exactly one* check. A second,
//! "mirrored" check living somewhere else is a bug, not a feature — two checks
//! drift, and the stale one becomes the hole.
//!
//! - **Synchronous and module-loading IO** reads its bytes here. V8's static-
//!   import resolution callback has to return a compiled module synchronously,
//!   so module loading is a blocking path (see *Sync vs async*).
//! - **`fetch()`** owns its async transport (`reqwest` + tokio, in
//!   [`crate::web::fetch`]) because it predates the async surface here — but it
//!   must take its permission decision from this same gate ([`permissions::check`]),
//!   not a copy of it. Folding its transport onto [`read_async`] /
//!   [`open_async`] is the eventual goal; the gate is what's shared today.
//! - **`data:`** is the sole ungated case: no IO happens, the bytes are in the
//!   specifier itself, and the importing code was already granted.
//!
//! Because a grant is matched against the URL, `file:` paths are
//! **canonicalized before both the permission check and the fs operation** (see
//! [`canonical_file`]). A symlink or `..` can't grant-match one path and then
//! touch a different target — the check and the operation always see the same
//! real path.
//!
//! ## Streaming
//!
//! [`open`] returns a [`Reader`] that implements [`std::io::Read`], so callers
//! can read chunk-by-chunk for large files/streams. `file:` reads are backed
//! by `std::fs::File`; `http:`/`https:` by `ureq::BodyReader<'static>` (an
//! owned streaming reader that decompresses and decodes per the response
//! headers); `data:` by an in-memory cursor over the decoded bytes. The
//! convenience wrappers [`read`] and [`read_to_string`] buffer the full body
//! — handy for module loading, which needs the whole source text anyway.
//!
//! ## Sync vs async
//!
//! The primary surface here is **synchronous** (blocking), forced on us by V8:
//! the static-import module-resolution callback must return a compiled module
//! synchronously, so module loading is a blocking path. For the future
//! `Limun.fs.*` async surface, async variants ([`read_async`], [`open_async`])
//! use `reqwest` for `http:`/`https:` and `tokio::fs` for `file:`. Both the
//! sync and async paths call the *same* [`permissions::check`] — the async
//! variants are a different transport, never a different gate. (See *The one
//! invariant* for where `fetch()` fits.)
//!
//! ## Writing
//!
//! Only `file:` URLs are writable. Writing to `http:`/`https:` is not a file
//! system operation (use `fetch()` with a state-changing method instead) and
//! writing to `data:` is a category error (the bytes are the URL). Both are
//! rejected with a clear, scheme-specific error before any permission check.
//!
//! ## Resolving
//!
//! [`resolve`] turns a specifier + referrer URL pair into an absolute URL.
//! Relative specifiers (`./x`, `../x`, `/x`) resolve against the referrer;
//! because the project base (cwd) is itself a `file:` URL, a leading `/`
//! resolves to the root of that `file:` URL — the user never has to spell out
//! `file:` themselves. The result is always an absolute URL (the scheme is
//! part of the access model, see [`IO.md`](../../../IO.md)).

use crate::core::permissions::{self, Mode};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use url::Url;

// Re-export the permissions `Mode` so callers that route through `io` don't
// have to separately depend on `core::permissions` just to name a mode.
#[allow(unused_imports)]
pub use crate::core::permissions::Mode as IoMode;

// =========================================================================
// Reader — a scheme-dispatched streaming reader over a URL
// =========================================================================

/// A streaming reader over a URL. Implements [`std::io::Read`] so callers can
/// `read_to_end`, `read_to_string`, or pull fixed-size chunks for large
/// files/streams.
///
/// Built by [`open`], which runs the permission check and dispatches on the
/// URL scheme. The three variants correspond to the three supported sources:
///
/// | Variant    | Scheme          | Backed by                          |
/// |-----------|-----------------|------------------------------------|
/// | `File`    | `file:`         | `std::fs::File`                     |
/// | `Http`    | `http:`/`https:`| `ureq::BodyReader<'static>` (owned)|
/// | `Data`    | `data:`         | `std::io::Cursor<Vec<u8>>`          |
///
/// `data:` URLs need no permission check (no IO happens), so `open` skips it
/// for them.
pub enum Reader {
    File(fs::File),
    Http(ureq::BodyReader<'static>),
    Data(io::Cursor<Vec<u8>>),
}

impl Read for Reader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Reader::File(f) => f.read(buf),
            Reader::Http(r) => r.read(buf),
            Reader::Data(c) => c.read(buf),
        }
    }
}

impl Reader {
    /// Read the entire body to a `Vec<u8>`. Convenience for
    /// `read_to_end` — this is what module loading uses (it needs the full
    /// source text before compiling).
    pub fn read_to_end_vec(mut self) -> Result<Vec<u8>, String> {
        let mut buf = Vec::new();
        self.read_to_end(&mut buf)
            .map_err(|e| format!("cannot read body: {e}"))?;
        Ok(buf)
    }

    /// Read the entire body as UTF-8 text. Returns an error if the bytes
    /// aren't valid UTF-8 (unlike `String::from_utf8_lossy`, this is strict —
    /// module loading has to produce source text, and silently replacing
    /// bytes would hide real corruption).
    pub fn read_to_end_string(self) -> Result<String, String> {
        let bytes = self.read_to_end_vec()?;
        String::from_utf8(bytes).map_err(|e| format!("body is not valid UTF-8: {e}"))
    }
}

// =========================================================================
// open / read / read_to_string — the primary read surface
// =========================================================================

/// Open a streaming reader over `url`. Runs the permission check (except for
/// `data:` URLs) and dispatches on scheme. See [`Reader`] for the per-scheme
/// backends.
///
/// For `http:`/`https:`, a non-2xx response is an error (we have no "Response
/// with `.ok === false`" representation at this layer — that's a `fetch()`
/// concept). The body is streamed: `ureq` returns an owned
/// [`ureq::BodyReader<'static>`] that decompresses gzip/brotli and decodes
/// the declared charset per the response headers.
pub fn open(url: &Url) -> Result<Reader, String> {
    match url.scheme() {
        "file" => {
            let (curl, path) = canonical_file(url)?;
            permissions::check(&curl, Mode::Read)?;
            let file = fs::File::open(&path)
                .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
            Ok(Reader::File(file))
        }
        "http" | "https" => {
            permissions::check(url, Mode::Read)?;
            let response = ureq::get(url.as_str())
                .call()
                .map_err(|e| format!("cannot fetch {url}: {e}"))?;
            // Don't rely on ureq's implicit status-as-error config: gate on
            // the status ourselves so `open` matches the async path's
            // behavior (and the doc's "non-2xx is an error" promise) even if
            // that config is ever flipped.
            let status = response.status();
            if !status.is_success() {
                return Err(format!("cannot fetch {url}: HTTP {}", status.as_u16()));
            }
            let reader = response.into_body().into_reader();
            Ok(Reader::Http(reader))
        }
        "data" => {
            // No permission check: the bytes are embedded in the specifier
            // itself (no IO happens, and the importing code was itself
            // already granted).
            let bytes = decode_data_url_bytes(url)?;
            Ok(Reader::Data(io::Cursor::new(bytes)))
        }
        scheme => Err(format!(
            "unsupported scheme \"{scheme}:\" (only file/http/https/data are supported)"
        )),
    }
}

/// Read the entire body at `url` into bytes. Convenience over [`open`] +
/// [`Reader::read_to_end_vec`]. Runs the permission check (except for
/// `data:`).
#[allow(dead_code)]
pub fn read(url: &Url) -> Result<Vec<u8>, String> {
    open(url)?.read_to_end_vec()
}

/// Read the entire body at `url` as UTF-8 text. Convenience over [`open`] +
/// [`Reader::read_to_end_string`]. Runs the permission check (except for
/// `data:`). This is what module loading uses.
pub fn read_to_string(url: &Url) -> Result<String, String> {
    open(url)?.read_to_end_string()
}

// =========================================================================
// stat / list_dir — filesystem metadata
// =========================================================================

/// Filesystem metadata for a URL. Only meaningful for `file:` URLs —
/// `http:`/`https:` have no stat (HTTP headers are a different model, handled
/// by `fetch()`), and `data:` URLs have no backing file at all.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Stat {
    /// `true` if this is a directory, `false` if a regular file. Symlinks are
    /// followed (canonicalized) before statting, matching the permission
    /// check's behavior — so a symlink to a file reports `is_dir == false`.
    pub is_dir: bool,
    /// `true` if this is a regular file (not a directory, not a symlink-after-
    /// canonicalization). Inverted from `is_dir` for readability.
    pub is_file: bool,
    /// Size in bytes. For directories this is the filesystem-reported size
    /// (typically the inode size, not the sum of entries — matches
    /// `std::fs::Metadata::len`).
    pub size: u64,
    /// Last modification time, if available.
    pub modified: Option<SystemTime>,
}

/// Stat a URL. Only `file:` URLs are supported — `http:`/`https:` return an
/// error (use `fetch()` for HTTP; headers are a different model), and
/// `data:` returns an error (no backing file).
///
/// The path is canonicalized before the check *and* the stat (via
/// [`canonical_file`]), so the permission decision and the metadata read act
/// on the same real target — a symlink/`..` can't sidestep a grant.
#[allow(dead_code)]
pub fn stat(url: &Url) -> Result<Stat, String> {
    let (curl, path) = canonical_file(url)?;
    permissions::check(&curl, Mode::Read)?;
    let meta = fs::metadata(&path).map_err(|e| format!("cannot stat {url}: {e}"))?;
    Ok(Stat {
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        size: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// A directory entry — one item inside a `file:` directory URL.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DirEntry {
    /// The entry name (basename, no path separators).
    pub name: String,
    /// Full URL of the entry — `file:` joined with the directory URL.
    pub url: Url,
    /// `true` if this entry is itself a directory.
    pub is_dir: bool,
}

/// List the entries in a directory URL. Only `file:` URLs are supported.
/// The permission check runs on the directory URL before reading it.
///
/// The returned entries are unsorted; callers that need a stable order
/// should sort by `name`. Each entry's `url` is a fully-formed `file:` URL,
/// so it can be passed directly to [`read`], [`open`], [`stat`], etc.
#[allow(dead_code)]
pub fn list_dir(url: &Url) -> Result<Vec<DirEntry>, String> {
    let (curl, path) = canonical_file(url)?;
    permissions::check(&curl, Mode::Read)?;
    let dir = fs::read_dir(&path).map_err(|e| format!("cannot read dir {url}: {e}"))?;
    let mut entries = Vec::new();
    for entry in dir {
        let entry = entry.map_err(|e| format!("cannot read dir entry in {url}: {e}"))?;
        let file_type = entry.file_type();
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_url = Url::from_file_path(&entry.path())
            .map_err(|_| format!("cannot form a file: URL for {}", entry.path().display()))?;
        entries.push(DirEntry {
            name,
            url: entry_url,
            is_dir: file_type.map(|t| t.is_dir()).unwrap_or(false),
        });
    }
    Ok(entries)
}

// =========================================================================
// write — file: only
// =========================================================================

/// Write `bytes` to `url`. Only `file:` URLs are writable — `http:`/`https:`
/// are not a file system operation (use `fetch()` with a state-changing
/// method) and `data:` is a category error (the bytes are the URL). Each
/// non-`file:` scheme is rejected with its own message, before any permission
/// check.
///
/// It creates or truncates the target (`std::fs::write` semantics). This is
/// **not** an atomic replace — there is no temp-file + rename and no fsync, so
/// a crash or a concurrent reader mid-write can observe a truncated file. If a
/// caller needs atomicity, write to a temp path and rename.
#[allow(dead_code)]
pub fn write_file(url: &Url, bytes: &[u8]) -> Result<(), String> {
    match url.scheme() {
        "file" => {}
        "http" | "https" => {
            return Err(format!(
                "cannot write to \"{url}\": http(s) is not a file system operation \
                 — use fetch() with a state-changing method"
            ));
        }
        "data" => {
            return Err(format!(
                "cannot write to \"{url}\": a data: URL *is* its bytes, there is \
                 nothing to write to"
            ));
        }
        scheme => {
            return Err(format!(
                "cannot write to \"{url}\": only file: URLs are writable (scheme is \"{scheme}:\")"
            ));
        }
    }
    let (curl, path) = canonical_file(url)?;
    permissions::check(&curl, Mode::Write)?;
    fs::write(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

// =========================================================================
// resolve — specifier -> absolute URL
// =========================================================================

/// Resolve `specifier` against `referrer` into an absolute URL. Relative
/// specifiers (`./x`, `../x`, `/x`) resolve against the referrer; because the
/// project base (cwd) is itself a `file:` URL, a leading `/` resolves to the
/// root of that `file:` URL — the user never has to spell out `file:`
/// themselves. Absolute specifiers (already a URL) are parsed as-is.
///
/// This is the URL resolution primitive — it does *not* consult the import
/// map (that's [`crate::core::resolver::resolve_specifier`], which layers
/// import-map lookup on top of this kind of URL resolution). Use this when you
/// want plain URL resolution without import-map remapping.
#[allow(dead_code)]
pub fn resolve(specifier: &str, referrer: &Url) -> Result<Url, String> {
    if specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/') {
        referrer
            .join(specifier)
            .map_err(|e| format!("cannot resolve \"{specifier}\" against {referrer}: {e}"))
    } else {
        Url::parse(specifier)
            .map_err(|e| format!("cannot resolve \"{specifier}\": {e}"))
    }
}

// =========================================================================
// async variants — for the future Limun.fs.* surface
// =========================================================================

/// Async read: the entire body at `url` as bytes. Uses `reqwest` for
/// `http:`/`https:` and `tokio::fs` for `file:` so the V8 thread isn't
/// blocked. Permission checks run synchronously before spawning (a denied URL
/// errors immediately, no task spawned).
///
/// `data:` URLs decode inline (no IO, no await).
#[allow(dead_code)]
pub async fn read_async(url: &Url) -> Result<Vec<u8>, String> {
    match url.scheme() {
        "file" => {
            let (curl, path) = canonical_file(url)?;
            permissions::check(&curl, Mode::Read)?;
            tokio::fs::read(&path)
                .await
                .map_err(|e| format!("cannot read {}: {e}", path.display()))
        }
        "http" | "https" => {
            permissions::check(url, Mode::Read)?;
            let client = reqwest::Client::new();
            let resp = client
                .get(url.clone())
                .send()
                .await
                .map_err(|e| format!("cannot fetch {url}: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("cannot fetch {url}: HTTP {}", resp.status()));
            }
            resp.bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(|e| format!("cannot read body from {url}: {e}"))
        }
        "data" => decode_data_url_bytes(url),
        scheme => Err(format!(
            "unsupported scheme \"{scheme}:\" (only file/http/https/data are supported)"
        )),
    }
}

/// Async open: returns a `tokio::fs::File` for `file:` URLs. `http:`/`https:`
/// is not streamed here yet — [`read_async`] covers the network case by
/// buffering the whole body; a streaming async reader over `reqwest` is the
/// thin wrapper to add when the async FS surface actually lands (and when
/// `fetch()`'s transport folds onto this module).
#[allow(dead_code)]
pub async fn open_async(url: &Url) -> Result<tokio::fs::File, String> {
    if url.scheme() != "file" {
        return Err(format!(
            "open_async: only file: is supported (scheme is \"{}:\")",
            url.scheme()
        ));
    }
    let (curl, path) = canonical_file(url)?;
    permissions::check(&curl, Mode::Read)?;
    tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("cannot open {}: {e}", path.display()))
}

// =========================================================================
// internal helpers
// =========================================================================

/// Decode a `data:` URL's body to bytes (RFC 2397 / WHATWG Fetch's "data: URL
/// processor" — media type + optional `;base64`). No permission concern: the
/// bytes are embedded in the specifier itself, so unlike `file:`/`http:` this
/// never needs a permission gate.
fn decode_data_url_bytes(url: &Url) -> Result<Vec<u8>, String> {
    let data_url =
        data_url::DataUrl::process(url.as_str()).map_err(|e| format!("invalid data: URL: {e:?}"))?;
    let (body, _fragment) = data_url
        .decode_to_vec()
        .map_err(|e| format!("cannot decode data: URL: {e:?}"))?;
    Ok(body)
}

/// Resolve a `file:` URL to its canonical `(URL, path)` pair, so the
/// permission check and the actual fs op both act on the *real* target. A
/// symlink or `..` can't grant-match one path and then touch another: we
/// canonicalize first, rebuild the `file:` URL from the canonical path, and
/// hand *that* URL to [`permissions::check`]. Shared by every `file:` entry
/// point ([`open`], [`stat`], [`list_dir`], [`write_file`], the async
/// variants) so they all have identical posture.
///
/// Non-`file:` schemes are a caller error here.
fn canonical_file(url: &Url) -> Result<(Url, PathBuf), String> {
    if url.scheme() != "file" {
        return Err(format!("expected a file: URL, got \"{}:\"", url.scheme()));
    }
    let raw = url
        .to_file_path()
        .map_err(|_| format!("invalid file URL: {url}"))?;
    let canon = canonicalize_target(&raw);
    let curl = Url::from_file_path(&canon)
        .map_err(|_| format!("cannot form a file: URL for {}", canon.display()))?;
    Ok((curl, canon))
}

/// Canonicalize an existing path outright. For a not-yet-existing target
/// (e.g. `write_file` creating a new file), canonicalize the *parent* and
/// rejoin the final component — so even a path that doesn't exist yet is
/// grant-matched by its real location instead of a symlinked alias. Falls back
/// to [`absolutize`] only if even the parent can't be resolved.
fn canonicalize_target(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(cp) = fs::canonicalize(parent) {
            return cp.join(name);
        }
    }
    absolutize(path)
}

/// Canonicalize a path if possible; otherwise make it absolute against the
/// current directory (a nonexistent path with a nonexistent parent can still
/// be denied/granted correctly). Last-resort fallback for
/// [`canonicalize_target`]; mirrors the helper in `permissions.rs` — kept
/// local so this module doesn't reach into `permissions`' internals.
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