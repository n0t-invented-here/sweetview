//! The registry data of a custom URL scheme for the current user:
//! `HKCU\Software\Classes\<scheme>`, as today's code writes it.

use crate::ShellError;

/// The registry values written for a scheme, besides the scheme itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
  /// Shown by the shell as `URL:<app_name> Protocol`.
  pub app_name: String,
  /// The `DefaultIcon` value, such as `"<exe>,0"`.
  pub icon_path: String,
  /// The `shell\open\command` value, such as `"<exe>" "%1"`.
  pub command: String,
}

impl Registration {
  /// Today's defaults for an executable: icon `"<exe>,0"` and command
  /// `"\"<exe>\" \"%1\""`.
  pub fn for_executable(app_name: &str, executable_path: &str) -> Self {
    Self {
      app_name: app_name.to_owned(),
      icon_path: format!("{executable_path},0"),
      command: format!("\"{executable_path}\" \"%1\""),
    }
  }
}

/// Today's `validateUrlScheme`: trimmed and lowercased, then it must match
/// `/^[a-z][a-z0-9+.-]*$/i`. Returns the normalised scheme.
pub fn normalize_scheme(scheme: &str) -> Result<String, ShellError> {
  let normalized = scheme.trim_matches(crate::js_whitespace).to_lowercase();
  let mut chars = normalized.chars();
  let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase())
    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'));
  if !valid {
    let quoted = serde_json::to_string(scheme).unwrap_or_else(|_| format!("\"{scheme}\""));
    return Err(ShellError(format!("sweetview: invalid URL scheme {quoted} (must match /^[a-z][a-z0-9+.-]*$/i)")));
  }
  Ok(normalized)
}

/// The key, under `HKEY_CURRENT_USER`, that registers a normalised scheme.
pub fn scheme_key(scheme: &str) -> String {
  format!("Software\\Classes\\{scheme}")
}

/// The four values today's code writes, in its order: `(sub_key, value_name, data)`,
/// where `None` names the key's default value.
pub fn registry_values(scheme: &str, registration: &Registration) -> [(String, Option<&'static str>, String); 4] {
  let root = scheme_key(scheme);
  [
    (root.clone(), None, format!("URL:{} Protocol", registration.app_name)),
    (root.clone(), Some("URL Protocol"), String::new()),
    (format!("{root}\\DefaultIcon"), None, registration.icon_path.clone()),
    (format!("{root}\\shell\\open\\command"), None, registration.command.clone()),
  ]
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn schemes_are_validated_and_normalised_like_todays_code() {
    assert_eq!(normalize_scheme("  My-App+x.y \n").unwrap(), "my-app+x.y");
    assert_eq!(normalize_scheme("\u{212a}it").unwrap(), "kit", "JavaScript lowercases the Kelvin sign to k as well");
    for bad in ["", "1abc", "my app", "my_app", "caf\u{e9}", "a:b", "..\\x"] {
      assert!(normalize_scheme(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
      normalize_scheme("123bad scheme!").unwrap_err().0,
      "sweetview: invalid URL scheme \"123bad scheme!\" (must match /^[a-z][a-z0-9+.-]*$/i)"
    );
  }

  #[test]
  fn registry_layout_is_todays() {
    let registration = Registration::for_executable("Sweetview Test", "C:\\SweetviewTest\\app.exe");
    assert_eq!(registration.icon_path, "C:\\SweetviewTest\\app.exe,0");
    assert_eq!(registration.command, "\"C:\\SweetviewTest\\app.exe\" \"%1\"");
    let values = registry_values("svtest", &registration);
    assert_eq!(values[0], ("Software\\Classes\\svtest".into(), None, "URL:Sweetview Test Protocol".into()));
    assert_eq!(values[1], ("Software\\Classes\\svtest".into(), Some("URL Protocol"), String::new()));
    assert_eq!(values[2], ("Software\\Classes\\svtest\\DefaultIcon".into(), None, "C:\\SweetviewTest\\app.exe,0".into()));
    assert_eq!(values[3], ("Software\\Classes\\svtest\\shell\\open\\command".into(), None, "\"C:\\SweetviewTest\\app.exe\" \"%1\"".into()));
  }
}
