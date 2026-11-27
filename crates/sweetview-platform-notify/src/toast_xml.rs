//! The text a toast is made of and the registry path that identifies it: pure
//! logic, the same on every platform.

/// The AUMID used when the options name none.
pub const DEFAULT_APP_ID: &str = "Sweetview.DesktopApp";

/// Characters XML 1.0 cannot carry. A Rust string has no lone surrogates, which
/// is the other case today's code replaces.
fn unrepresentable(c: char) -> bool {
  matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}')
}

/// Text made safe for XML content and attribute values: unrepresentable
/// characters become U+FFFD, then `& < > " '` become entities.
pub fn xml_text(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  for c in value.chars() {
    match c {
      _ if unrepresentable(c) => out.push('\u{fffd}'),
      '&' => out.push_str("&amp;"),
      '<' => out.push_str("&lt;"),
      '>' => out.push_str("&gt;"),
      '"' => out.push_str("&quot;"),
      '\'' => out.push_str("&apos;"),
      _ => out.push(c),
    }
  }
  out
}

/// The toast XML today's code builds: a `ToastGeneric` binding with the title
/// and body, `<audio silent="true"/>` when silent, and the id as `launch`, in
/// which tab, line feed and carriage return are written as character references
/// so attribute normalisation keeps them.
pub fn toast_xml(id: &str, title: &str, body: &str, silent: bool) -> String {
  let mut launch = String::new();
  for c in xml_text(id).chars() {
    match c {
      '\t' => launch.push_str("&#9;"),
      '\n' => launch.push_str("&#10;"),
      '\r' => launch.push_str("&#13;"),
      _ => launch.push(c),
    }
  }
  let audio = if silent { "<audio silent=\"true\"/>" } else { "" };
  format!(
    "<toast launch=\"{launch}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{audio}</toast>",
    xml_text(title),
    xml_text(body)
  )
}

/// The AUMID a notifier uses: the given one, else [`DEFAULT_APP_ID`].
pub fn app_id(app_id: Option<&str>) -> &str {
  app_id.unwrap_or(DEFAULT_APP_ID)
}

/// The `DisplayName` written for a new registration: the app name, else the
/// app id when one was given, else `Sweetview`.
pub fn display_name<'a>(app_id: Option<&'a str>, app_name: Option<&'a str>) -> &'a str {
  app_name.or(app_id).unwrap_or("Sweetview")
}

/// Checks an AUMID the way today's code does: 1 to 128 UTF-16 units, with no
/// backslash, whitespace or NUL.
pub fn validate_app_id(app_id: &str) -> Result<(), crate::NotifyError> {
  let units = app_id.encode_utf16().count();
  if units == 0 || units > 128 || app_id.chars().any(|c| c == '\\' || c == '\0' || js_whitespace(c)) {
    return Err(crate::NotifyError("sweetview: invalid Windows toast appId".into()));
  }
  Ok(())
}

/// JavaScript's `\s`, which today's check uses. It differs from Unicode
/// `White_Space` in two characters: it has U+FEFF and lacks U+0085.
fn js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
  )
}

/// The registry key, under `HKEY_CURRENT_USER`, that registers an AUMID.
pub fn app_id_key(app_id: &str) -> String {
  format!("Software\\Classes\\AppUserModelId\\{app_id}")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn toast_xml_escapes_like_todays_code() {
    // The exact string `notifier.test.ts` asserts.
    assert_eq!(
      toast_xml("first<&>\"", "<Title> & \"quotes\"", "It\u{2019}s <body> & 'more'", true),
      "<toast launch=\"first&lt;&amp;&gt;&quot;\"><visual><binding template=\"ToastGeneric\">\
       <text>&lt;Title&gt; &amp; &quot;quotes&quot;</text><text>It\u{2019}s &lt;body&gt; &amp; &apos;more&apos;</text>\
       </binding></visual><audio silent=\"true\"/></toast>"
    );
    assert!(!toast_xml("audible", "Sound on", "", false).contains("<audio"));
  }

  #[test]
  fn unrepresentable_characters_become_replacement_characters() {
    assert_eq!(xml_text("a\u{0}b\u{8}c\u{b}d\u{c}e\u{1f}f\u{fffe}g\u{ffff}"), "a\u{fffd}b\u{fffd}c\u{fffd}d\u{fffd}e\u{fffd}f\u{fffd}g\u{fffd}");
    // Tab, line feed and carriage return are legal XML text and stay.
    assert_eq!(xml_text("\t\n\r"), "\t\n\r");
  }

  #[test]
  fn launch_keeps_whitespace_as_character_references() {
    let xml = toast_xml("a\tb\nc\rd", "t", "line\nbreak", false);
    assert!(xml.starts_with("<toast launch=\"a&#9;b&#10;c&#13;d\">"), "{xml}");
    assert!(xml.contains("<text>line\nbreak</text>"), "{xml}");
  }

  #[test]
  fn identity_defaults_follow_todays_rules() {
    assert_eq!(app_id(None), "Sweetview.DesktopApp");
    assert_eq!(app_id(Some("My.App")), "My.App");
    assert_eq!(display_name(None, None), "Sweetview");
    assert_eq!(display_name(Some("My.App"), None), "My.App");
    assert_eq!(display_name(Some("My.App"), Some("My App")), "My App");
    assert_eq!(display_name(None, Some("My App")), "My App");
    assert_eq!(app_id_key("My.App"), "Software\\Classes\\AppUserModelId\\My.App");
  }

  #[test]
  fn app_id_validation_matches_todays_rules() {
    assert!(validate_app_id("Sweetview.DesktopApp").is_ok());
    assert!(validate_app_id(&"a".repeat(128)).is_ok());
    assert!(validate_app_id("a\u{85}b").is_ok(), "U+0085 is not \\s in JavaScript");
    for bad in ["", "a b", "a\\b", "a\0b", "a\tb", "a\u{3000}b", "a\u{feff}b"] {
      assert_eq!(validate_app_id(bad).unwrap_err().0, "sweetview: invalid Windows toast appId", "{bad:?}");
    }
    assert!(validate_app_id(&"a".repeat(129)).is_err());
    // The limit counts UTF-16 units, as JavaScript's `length` does.
    assert!(validate_app_id(&"\u{1f600}".repeat(64)).is_ok());
    assert!(validate_app_id(&"\u{1f600}".repeat(65)).is_err());
  }
}
