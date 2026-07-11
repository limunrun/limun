//! Single choke-point for actual bytes off disk / off the network.
//!
//! Module loading (`file:`/`https:` specifiers) routes through this, and so
//! does the `fetch()` global (see `web::fetch`) — one permission gate
//! (`core::permissions`) protects imports and `fetch` alike instead of two
//! separately-guarded call sites. The scheme in the URL is the mechanism
//! gate — `"file://**"` in the io allowlist covers disk, `"https://**"`
//! covers network. No separate kill switches.

use crate::core::permissions::{self, Mode};
use std::path::Path;

/// Read a local file's contents as UTF-8 text.
pub fn read_file(path: &Path) -> Result<String, String> {
    permissions::check_file(path, Mode::Read)?;
    std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// Fetch a remote URL's body as UTF-8 text (blocking).
pub fn fetch(url: &url::Url) -> Result<String, String> {
    permissions::check(url, Mode::Read)?;
    let mut response = ureq::get(url.as_str())
        .call()
        .map_err(|e| format!("cannot fetch {url}: {e}"))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("cannot read response body from {url}: {e}"))
}

/// Decode a `data:` URL's body as UTF-8 text (RFC 2397 / WHATWG Fetch's
/// "data: URL processor" — media type + optional `;base64`). No io
/// permission concern here (the bytes are already embedded in the
/// specifier itself), so unlike `read_file`/`fetch` this never needs a
/// permission gate.
pub fn decode_data_url(url: &url::Url) -> Result<String, String> {
    let data_url =
        data_url::DataUrl::process(url.as_str()).map_err(|e| format!("invalid data: URL: {e:?}"))?;
    let (body, _fragment) = data_url
        .decode_to_vec()
        .map_err(|e| format!("cannot decode data: URL: {e:?}"))?;
    String::from_utf8(body).map_err(|e| format!("data: URL is not valid UTF-8: {e}"))
}