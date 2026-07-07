//! Single choke-point for actual bytes off disk / off the network.
//!
//! Module loading (`file:`/`https:` specifiers) routes through this, and so
//! does the `fetch()` global (see `web::fetch`) — one permission gate
//! (`core::permissions`) protects imports and `fetch` alike instead of two
//! separately-guarded call sites. `Limun.fs.*`, if/when it exists, should
//! route through here too.

use crate::core::permissions;
use std::path::Path;

/// Read a local file's contents as UTF-8 text.
pub fn read_file(path: &Path) -> Result<String, String> {
    permissions::check_read(path)?;
    std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// Fetch a remote URL's body as UTF-8 text (blocking).
pub fn fetch(url: &url::Url) -> Result<String, String> {
    permissions::check_net(url)?;
    let mut response = ureq::get(url.as_str())
        .call()
        .map_err(|e| format!("cannot fetch {url}: {e}"))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("cannot read response body from {url}: {e}"))
}

/// Full HTTP request/response (status, headers, raw bytes) — used by the
/// `fetch()` global (`web::fetch`), which needs more than module loading's
/// plain-text shortcut above. Same permission gate.
pub struct RawResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub fn fetch_full(
    method: &str,
    url: &url::Url,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> Result<RawResponse, String> {
    permissions::check_net(url)?;

    let method: ureq::http::Method = method
        .parse()
        .map_err(|_| format!("invalid HTTP method \"{method}\""))?;

    let mut builder = ureq::http::Request::builder().method(method).uri(url.as_str());
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let request = builder
        .body(body.unwrap_or_default())
        .map_err(|e| format!("cannot build request to {url}: {e}"))?;

    // Per WHATWG Fetch, `fetch()` only rejects on a genuine network
    // failure — a 404/500/etc. still resolves normally (with `.ok ===
    // false`). ureq's default agent treats non-2xx as `Err` instead, so
    // build one with that off.
    let config = ureq::Agent::config_builder().http_status_as_error(false).build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent.run(request).map_err(|e| format!("cannot fetch {url}: {e}"))?;

    let status = response.status().as_u16();
    let status_text = response.status().canonical_reason().unwrap_or("").to_string();
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.as_str().to_string(), v.to_string()))
        })
        .collect();

    let body_bytes = response
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("cannot read response body from {url}: {e}"))?;

    Ok(RawResponse {
        status,
        status_text,
        headers: response_headers,
        body: body_bytes,
    })
}

/// Decode a `data:` URL's body as UTF-8 text (RFC 2397 / WHATWG Fetch's
/// "data: URL processor" — media type + optional `;base64`). No fs/net
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
