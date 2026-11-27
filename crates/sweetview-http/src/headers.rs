//! Request headers to JSON, response headers from JSON, and the reason phrase
//! for a status. Ported from `http_request.hh`.

/// One header as `(name, value)`. A list of them keeps repeated names in order.
pub type Header = (String, String);

/// The request headers handed to the request handler: a JSON array of
/// `[name, value]` string pairs, so repeated headers survive.
pub fn headers_to_json(headers: &[Header]) -> String {
    let pairs: Vec<[&str; 2]> = headers.iter().map(|(n, v)| [n.as_str(), v.as_str()]).collect();
    // Serialising a vector of string pairs cannot fail.
    serde_json::to_string(&pairs).unwrap_or_else(|_| String::from("[]"))
}

/// RFC 9110 5.6.2: a `tchar`, one character of a token.
pub fn is_tchar(c: u8) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
}

/// RFC 9110 5.1: a field name is a token, one or more `tchar`.
pub fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(is_tchar)
}

/// RFC 9110 5.5: a field value never holds CR, LF or NUL, and no other control
/// character except horizontal tab. Bytes from 0x80 up (UTF-8, obs-text) pass.
pub fn is_valid_header_value(value: &str) -> bool {
    value.bytes().all(|c| !((c < 0x20 && c != b'\t') || c == 0x7F))
}

/// `"Name: value\r\n"` per header, the form `CreateWebResourceResponse` takes.
pub fn header_lines(headers: &[Header]) -> String {
    let mut lines = String::new();
    for (name, value) in headers {
        lines.push_str(name);
        lines.push_str(": ");
        lines.push_str(value);
        lines.push_str("\r\n");
    }
    lines
}

/// Parses response headers: a JSON object `{"Name": "value"}` or a JSON array
/// of pairs `[["Name", "value"], ...]`. `None` when the text is not exactly
/// that under the strict rules below; empty text (or only whitespace) is no
/// headers.
///
/// - The JSON grammar (RFC 8259) is followed to the letter: literals end where
///   the grammar says, strings hold no raw control characters, every `\u`
///   escape is a whole code point (no lone surrogates), and the text is valid
///   UTF-8.
/// - U+0000 is refused, raw or escaped, since names and values become C strings.
/// - Values may be strings, numbers (kept as their literal text), booleans, or
///   `null`, which drops the header.
/// - Every name must be an RFC 9110 token and every value free of CR, LF, NUL
///   and other control characters but tab; one bad header fails the whole parse,
///   so nothing can be injected.
///
/// The reader is written out rather than taken from `serde_json` because the
/// rules are stricter than JSON's and the result must keep repeated names, key
/// order, and the literal text of numbers (`1.50` stays `1.50`).
pub fn headers_from_json(json: &str) -> Option<Vec<Header>> {
    headers_from_json_bytes(json.as_bytes())
}

/// [`headers_from_json`] over raw bytes, which may be invalid UTF-8 (refused).
pub fn headers_from_json_bytes(json: &[u8]) -> Option<Vec<Header>> {
    let mut reader = Reader { s: json, pos: 0 };
    let mut out = Vec::new();
    reader.read(&mut out).then_some(out)
}

struct Reader<'a> {
    s: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.pos).copied()
    }

    fn read(&mut self, out: &mut Vec<Header>) -> bool {
        self.skip_ws();
        let ok = match self.peek() {
            None => return true, // empty input means no headers
            Some(b'{') => self.read_object(out),
            Some(b'[') => self.read_array(out),
            Some(_) => false,
        };
        if !ok {
            return false;
        }
        self.skip_ws();
        self.pos == self.s.len()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn consume(&mut self, c: u8) -> bool {
        self.skip_ws();
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn read_hex4(&mut self) -> Option<u32> {
        let digits = self.s.get(self.pos..self.pos + 4)?;
        let mut cp = 0u32;
        for &c in digits {
            cp = (cp << 4) | char::from(c).to_digit(16)?;
        }
        self.pos += 4;
        Some(cp)
    }

    /// Copies one raw UTF-8 sequence starting at `pos` (its lead byte already
    /// known to be 0x80 or above), refusing overlong forms, surrogates, and
    /// anything above U+10FFFF.
    fn read_utf8_sequence(&mut self, out: &mut Vec<u8>) -> bool {
        let lead = self.s[self.pos];
        let (len, mut cp, min) = match lead {
            0xC2..=0xDF => (2, u32::from(lead & 0x1F), 0x80),
            0xE0..=0xEF => (3, u32::from(lead & 0x0F), 0x800),
            0xF0..=0xF4 => (4, u32::from(lead & 0x07), 0x10000),
            _ => return false,
        };
        let Some(seq) = self.s.get(self.pos..self.pos + len) else {
            return false;
        };
        for &c in &seq[1..] {
            if c & 0xC0 != 0x80 {
                return false;
            }
            cp = (cp << 6) | u32::from(c & 0x3F);
        }
        if cp < min || cp > 0x10FFFF || (0xD800..=0xDFFF).contains(&cp) {
            return false;
        }
        out.extend_from_slice(seq);
        self.pos += len;
        true
    }

    fn read_string(&mut self) -> Option<String> {
        self.skip_ws();
        if self.peek() != Some(b'"') {
            return None;
        }
        self.pos += 1;
        let mut out = Vec::new();
        while let Some(c) = self.peek() {
            if c == b'"' {
                self.pos += 1;
                // Every byte appended was checked UTF-8 or an encoded code point.
                return String::from_utf8(out).ok();
            }
            if c < 0x20 {
                return None; // raw control characters, NUL included
            }
            if c >= 0x80 {
                if !self.read_utf8_sequence(&mut out) {
                    return None;
                }
                continue;
            }
            self.pos += 1;
            if c != b'\\' {
                out.push(c);
                continue;
            }
            let e = self.peek()?;
            self.pos += 1;
            match e {
                b'"' => out.push(b'"'),
                b'\\' => out.push(b'\\'),
                b'/' => out.push(b'/'),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0C),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'u' => {
                    let mut cp = self.read_hex4()?;
                    if cp == 0 {
                        return None; // U+0000 would cut the C string short
                    }
                    if (0xDC00..=0xDFFF).contains(&cp) {
                        return None; // a low surrogate with no high one before it
                    }
                    if (0xD800..=0xDBFF).contains(&cp) {
                        // A high surrogate must be followed at once by a low one.
                        if self.s.get(self.pos..self.pos + 2) != Some(b"\\u".as_slice()) {
                            return None;
                        }
                        self.pos += 2;
                        let lo = self.read_hex4()?;
                        if !(0xDC00..=0xDFFF).contains(&lo) {
                            return None;
                        }
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    let ch = char::from_u32(cp)?;
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                _ => return None,
            }
        }
        None
    }

    fn read_digits(&mut self) -> bool {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos > start
    }

    /// RFC 8259 6: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`
    fn read_number(&mut self) -> Option<String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek()? {
            b'0' => self.pos += 1,
            _ => {
                if !self.read_digits() {
                    return None;
                }
            }
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !self.read_digits() {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !self.read_digits() {
                return None;
            }
        }
        // ASCII only: every byte taken matched one of the patterns above.
        String::from_utf8(self.s[start..self.pos].to_vec()).ok()
    }

    fn read_literal(&mut self, word: &[u8]) -> bool {
        if self.s.get(self.pos..self.pos + word.len()) == Some(word) {
            self.pos += word.len();
            true
        } else {
            false
        }
    }

    /// A string, or the literal text of a number / true / false; `null` is
    /// `Some(None)`. Whatever follows is left to the caller, which accepts only
    /// `,` or the closing bracket, so `trueish` or `12abc` fail there.
    fn read_value(&mut self) -> Option<Option<String>> {
        self.skip_ws();
        match self.peek()? {
            b'"' => self.read_string().map(Some),
            b'-' | b'0'..=b'9' => self.read_number().map(Some),
            _ if self.read_literal(b"true") => Some(Some("true".into())),
            _ if self.read_literal(b"false") => Some(Some("false".into())),
            _ if self.read_literal(b"null") => Some(None),
            _ => None,
        }
    }

    fn keep_header(out: &mut Vec<Header>, name: String, value: Option<String>) -> bool {
        if !is_valid_header_name(&name) {
            return false;
        }
        let Some(value) = value else {
            return true; // null drops the header
        };
        if !is_valid_header_value(&value) {
            return false;
        }
        out.push((name, value));
        true
    }

    fn read_object(&mut self, out: &mut Vec<Header>) -> bool {
        if !self.consume(b'{') {
            return false;
        }
        if self.consume(b'}') {
            return true;
        }
        loop {
            let Some(name) = self.read_string() else { return false };
            if !self.consume(b':') {
                return false;
            }
            let Some(value) = self.read_value() else { return false };
            if !Self::keep_header(out, name, value) {
                return false;
            }
            if self.consume(b',') {
                continue;
            }
            return self.consume(b'}');
        }
    }

    fn read_array(&mut self, out: &mut Vec<Header>) -> bool {
        if !self.consume(b'[') {
            return false;
        }
        if self.consume(b']') {
            return true;
        }
        loop {
            if !self.consume(b'[') {
                return false;
            }
            let Some(name) = self.read_string() else { return false };
            if !self.consume(b',') {
                return false;
            }
            let Some(value) = self.read_value() else { return false };
            if !self.consume(b']') || !Self::keep_header(out, name, value) {
                return false;
            }
            if self.consume(b',') {
                continue;
            }
            return self.consume(b']');
        }
    }
}

/// The reason phrase for a status, as the response line carries it.
pub fn reason_phrase(status: i32) -> &'static str {
    if let Some(phrase) = exact_reason_phrase(status) {
        return phrase;
    }
    match status {
        200..=299 => "OK",
        300..=399 => "Redirect",
        400..=499 => "Client Error",
        500..=599 => "Server Error",
        _ => "Unknown",
    }
}

fn exact_reason_phrase(status: i32) -> Option<&'static str> {
    Some(match status {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Content Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Option<Vec<Header>> {
        headers_from_json(s)
    }

    fn parse_bytes(s: &[u8]) -> Option<Vec<Header>> {
        headers_from_json_bytes(s)
    }

    fn h(n: &str, v: &str) -> Header {
        (n.into(), v.into())
    }

    // C++: "Ensure that JSON escaping works" (json_escape, as used by
    // http_headers_to_json), checked through the request-header encoding.
    #[test]
    fn json_escaping_of_request_headers() {
        let one = |v: &str| headers_to_json(&[h("X", v)]);
        assert_eq!(one("hello"), r#"[["X","hello"]]"#);
        assert_eq!(one(""), r#"[["X",""]]"#);
        assert_eq!(one("\""), r#"[["X","\""]]"#);
        assert_eq!(one("\\"), r#"[["X","\\"]]"#);
        assert_eq!(one("\u{8}\u{c}\n\r\t"), r#"[["X","\b\f\n\r\t"]]"#);
        assert_eq!(one("\0\u{1f}"), r#"[["X","\u0000\u001f"]]"#);
        // ASCII printable characters (even DEL) are not escaped.
        assert_eq!(one("\x20\x7e\x7f"), "[[\"X\",\"\x20\x7e\x7f\"]]");
        assert_eq!(one("\u{2328}"), "[[\"X\",\"\u{2328}\"]]");
        assert_eq!(one("フーバー"), "[[\"X\",\"フーバー\"]]");
        assert_eq!(one(r#"alert("gotcha")"#), r#"[["X","alert(\"gotcha\")"]]"#);
    }

    // C++: "Request handler: headers to and from JSON"
    #[test]
    fn headers_to_and_from_json() {
        assert_eq!(headers_to_json(&[]), "[]");
        assert_eq!(
            headers_to_json(&[h("X-A", "1"), h("X-B", "say \"hi\"")]),
            r#"[["X-A","1"],["X-B","say \"hi\""]]"#
        );

        let got = parse(r#"{"Content-Type": "text/plain", "X-N": 5, "X-Gone": null}"#).unwrap();
        assert_eq!(got, vec![h("Content-Type", "text/plain"), h("X-N", "5")]);

        let got = parse(r#"[["Set-Cookie","a=1"], ["Set-Cookie","b=2"]]"#).unwrap();
        assert_eq!(got, vec![h("Set-Cookie", "a=1"), h("Set-Cookie", "b=2")]);

        assert!(parse(r#"{"X-Evil": "a\r\nSet-Cookie: pwned=1"}"#).is_none());
        assert!(parse(r#"{"X\nY": "z"}"#).is_none());
        assert!(parse(r#"{"X-Bell": "a\u0007b"}"#).is_none());
        assert_eq!(parse(r#"{"X-Tab": "a\tb"}"#).unwrap(), vec![h("X-Tab", "a\tb")]);

        // A failed parse returns nothing at all (the C++ leaves `out` untouched).
        assert!(parse(r#"{"X-A": "1", "Bad Name": "2"}"#).is_none());

        assert_eq!(parse(r#"{"X-U": "é😀"}"#).unwrap()[0].1, "\u{e9}\u{1F600}");
        assert_eq!(parse_bytes(b"{\"X-U\": \"\xc3\xa9\"}").unwrap()[0].1, "\u{e9}");
    }

    // C++: "Request handler: strict response header JSON"
    #[test]
    fn strict_response_header_json() {
        for bad in [
            r#"{"X-Example":trueish}"#,
            r#"{"X-Example":nullx}"#,
            r#"{"X-Example":falsey}"#,
            r#"{"X-Example":tru}"#,
            r#"{"X-Example":12abc}"#,
            r#"{"X-Example":01}"#,
            r#"{"X-Example":1.}"#,
            r#"{"X-Example":+1}"#,
            r#"{"X-Example":1e}"#,
            r#"{"X-Example":undefined}"#,
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }
        let got = parse(r#"{"X-T": true, "X-F": false, "X-N": -1.5e+3, "X-Z": 0}"#).unwrap();
        let values: Vec<&str> = got.iter().map(|(_, v)| v.as_str()).collect();
        assert_eq!(values, ["true", "false", "-1.5e+3", "0"]);

        // Raw control characters inside a string, NUL included.
        assert!(parse("{\"X-A\": \"a\tb\"}").is_none());
        assert!(parse("{\"X-A\": \"a\nb\"}").is_none());
        assert!(parse("{\"X-A\": \"a\0b\"}").is_none());
        assert!(parse("{\"X-\0A\": \"b\"}").is_none());

        // U+0000 escaped would still cut a C string short.
        assert!(parse(r#"{"X-A": "a\u0000b"}"#).is_none());
        assert!(parse(r#"{"X-\u0000": "b"}"#).is_none());

        // Lone or unmatched UTF-16 surrogates.
        for bad in [
            r#"{"X-A": "\ud83d"}"#,
            r#"{"X-A": "\ud83dx"}"#,
            r#"{"X-A": "\ude00"}"#,
            r#"{"X-A": "\ud83dA"}"#,
            r#"{"X-A": "\ud83d\ud83d"}"#,
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }

        // Raw bytes must be valid UTF-8.
        for bad in [
            b"{\"X-A\": \"\x80\"}".as_slice(),
            b"{\"X-A\": \"\xc0\xaf\"}",
            b"{\"X-A\": \"\xed\xa0\x80\"}",
            b"{\"X-A\": \"\xe2\x82\"}",
            b"{\"X-A\": \"\xf4\x90\x80\x80\"}",
        ] {
            assert!(parse_bytes(bad).is_none(), "{bad:?}");
        }

        // Header names are RFC 9110 tokens.
        for bad in [
            r#"{"": "a"}"#,
            r#"{"Bad Name": "a"}"#,
            r#"{"X-A:": "a"}"#,
            "{\"X(A)\": \"a\"}",
            r#"{"X-é": "a"}"#,
            r#"[["Bad Name", "a"]]"#,
            r#"{"Bad Name": null}"#,
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }
        assert_eq!(parse(r#"{"X-Ok_1.2!#$%&'*+^`|~": "a"}"#).unwrap().len(), 1);

        // Empty input is no headers; anything else is an error.
        assert_eq!(parse("").unwrap(), vec![]);
        assert_eq!(parse("  {}  ").unwrap(), vec![]);
        assert_eq!(parse("[]").unwrap(), vec![]);
        for bad in ["\"text\"", "{\"a\":", "[[\"a\"]]", "{} trailing"] {
            assert!(parse(bad).is_none(), "{bad}");
        }

        assert_eq!(reason_phrase(200), "OK");
        assert_eq!(reason_phrase(404), "Not Found");
        assert_eq!(reason_phrase(299), "OK");
    }

    #[test]
    fn reason_phrase_falls_back_by_class() {
        assert_eq!(reason_phrase(399), "Redirect");
        assert_eq!(reason_phrase(499), "Client Error");
        assert_eq!(reason_phrase(599), "Server Error");
        assert_eq!(reason_phrase(99), "Unknown");
        assert_eq!(reason_phrase(600), "Unknown");
    }

    #[test]
    fn header_lines_are_crlf_terminated() {
        assert_eq!(header_lines(&[]), "");
        assert_eq!(
            header_lines(&[h("A", "1"), h("Set-Cookie", "a=1"), h("Set-Cookie", "b=2")]),
            "A: 1\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n"
        );
    }

    #[test]
    fn value_rules() {
        assert!(is_valid_header_value(""));
        assert!(is_valid_header_value("text/plain;\tcharset=utf-8"));
        assert!(is_valid_header_value("é"));
        assert!(!is_valid_header_value("a\x7f"));
        assert!(!is_valid_header_value("a\0"));
        assert!(!is_valid_header_name(""));
        assert!(!is_valid_header_name("a b"));
    }
}
