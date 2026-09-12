//! Credential redaction for logs and error details (TDD §7: "脱敏 URL 中的
//! 凭据"; W10 #9: "秘密不进 argv/日志"). Applied everywhere remote URLs or
//! raw git output reach a log line or a serialized error.

/// Redacts the userinfo of one URL-ish token: `scheme://user:pass@host` keeps
/// the username but masks the password, and for `http(s)` a bare userinfo is
/// treated as a token and masked too (the GitHub PAT pattern). `ssh://git@…`
/// and scp-like remotes carry no secret and pass through untouched.
pub fn redact_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    // A scheme is [a-zA-Z][a-zA-Z0-9+.-]*; bail out when "://" is just text.
    let scheme = &url[..scheme_end];
    if scheme.is_empty()
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return url.to_string();
    }
    let authority_start = scheme_end + 3;
    let authority_end = url[authority_start..]
        .find(['/', '?', '#'])
        .map(|i| authority_start + i)
        .unwrap_or(url.len());
    let authority = &url[authority_start..authority_end];
    let Some(at) = authority.rfind('@') else {
        return url.to_string();
    };
    let userinfo = &authority[..at];
    let host = &authority[at + 1..];
    let masked = if let Some(colon) = userinfo.find(':') {
        format!("{}:***", &userinfo[..colon])
    } else if scheme == "http" || scheme == "https" {
        // Bare userinfo on an HTTP(S) remote is almost always an access token.
        "***".to_string()
    } else {
        userinfo.to_string()
    };
    format!("{}://{}@{}{}", scheme, masked, host, &url[authority_end..])
}

/// Redacts every URL embedded in free-form output (git stderr, error text).
pub fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (token, separator) in split_tokens(text) {
        out.push_str(&redact_url(&token));
        out.push_str(&separator);
    }
    out
}

/// Splits on separators that terminate a URL (whitespace, quotes, brackets)
/// while preserving the separators so output stays byte-faithful apart from
/// the redaction itself. Returns (token, separator) pairs.
fn split_tokens(text: &str) -> Vec<(String, String)> {
    const SEPARATORS: &[char] = &[
        ' ', '\t', '\n', '\r', '"', '\'', '`', '<', '>', '(', ')', '[', ']', '{', '}',
    ];
    let mut parts = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if SEPARATORS.contains(&c) {
            parts.push((std::mem::take(&mut current), c.to_string()));
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        parts.push((current, String::new()));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_password_but_keeps_username() {
        assert_eq!(
            redact_url("https://user:s3cret@github.com/u/r.git"),
            "https://user:***@github.com/u/r.git"
        );
        // Passwords may contain colons; everything after the first is masked.
        assert_eq!(
            redact_url("https://user:pa:ss@host/x"),
            "https://user:***@host/x"
        );
    }

    #[test]
    fn redacts_bare_token_userinfo_on_http_only() {
        assert_eq!(
            redact_url("https://ghp_token123@github.com/u/r.git"),
            "https://***@github.com/u/r.git"
        );
        assert_eq!(
            redact_url("ssh://git@github.com/u/r.git"),
            "ssh://git@github.com/u/r.git",
            "ssh bare userinfo is a username, not a secret"
        );
    }

    #[test]
    fn leaves_urls_without_userinfo_and_scp_remotes_untouched() {
        assert_eq!(
            redact_url("https://github.com/u/r.git"),
            "https://github.com/u/r.git"
        );
        assert_eq!(
            redact_url("git@github.com:u/r.git"),
            "git@github.com:u/r.git"
        );
        assert_eq!(redact_url("/some/local/path"), "/some/local/path");
        assert_eq!(redact_url("look at this://thing"), "look at this://thing");
    }

    #[test]
    fn redacts_every_url_in_free_text() {
        let text = "fatal: unable to access 'https://u:pw@host/a.git': push declined\nsee ssh://git@host/b.git";
        let red = redact_text(text);
        assert!(red.contains("https://u:***@host/a.git"), "{red}");
        assert!(red.contains("ssh://git@host/b.git"), "{red}");
        assert!(!red.contains("pw"), "{red}");
    }
}
