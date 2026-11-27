//! Custom URL scheme registration for the current user:
//! `HKCU\Software\Classes\<scheme>`, with no administrator rights needed.

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

#[cfg(windows)]
mod imp {
  use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
  use windows_registry::CURRENT_USER;

  use super::{registry_values, scheme_key, Registration};
  use crate::win::{registry_code, set_reg_string};
  use crate::ShellError;

  pub fn register(scheme: &str, registration: &Registration) -> Result<(), ShellError> {
    for (sub_key, value_name, data) in registry_values(scheme, registration) {
      set_reg_string(&sub_key, value_name, &data)?;
    }
    Ok(())
  }

  pub fn unregister(scheme: &str) -> Result<(), ShellError> {
    let root = scheme_key(scheme);
    match CURRENT_USER.remove_tree(&root) {
      Err(e) if e.code() != ERROR_FILE_NOT_FOUND.to_hresult() => {
        Err(ShellError(format!("sweetview: RegDeleteTreeW({root}) failed ({})", registry_code(&e))))
      }
      _ => Ok(()),
    }
  }
}

#[cfg(not(windows))]
mod imp {
  use super::Registration;
  use crate::ShellError;

  /// macOS reads schemes from the bundle's `Info.plist`; nothing is written at run time.
  pub fn register(_scheme: &str, _registration: &Registration) -> Result<(), ShellError> {
    Ok(())
  }

  pub fn unregister(_scheme: &str) -> Result<(), ShellError> {
    Ok(())
  }
}

/// Registers `scheme` for the current user. The scheme is validated and
/// normalised first. Windows writes the registry; elsewhere only the
/// validation runs, as today on macOS.
pub fn register(scheme: &str, registration: &Registration) -> Result<(), ShellError> {
  imp::register(&normalize_scheme(scheme)?, registration)
}

/// Removes the current user's registration of `scheme`. Removing one that is
/// not registered succeeds.
pub fn unregister(scheme: &str) -> Result<(), ShellError> {
  imp::unregister(&normalize_scheme(scheme)?)
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

  #[cfg(windows)]
  mod live {
    use super::super::*;
    use crate::win::test_support::counts;
    use windows_registry::CURRENT_USER;

    /// A `REG_SZ` value under `HKCU\<sub_key>`; `None` names the default value.
    fn read(sub_key: &str, value: Option<&str>) -> Option<String> {
      CURRENT_USER.open(sub_key).ok()?.get_string(value.unwrap_or("")).ok()
    }

    fn unique_scheme() -> String {
      let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
      format!("sweetview-test-{}-{nanos}", std::process::id())
    }

    /// Removes the test's scheme when the test ends, passed or failed.
    struct Cleanup(String);

    impl Drop for Cleanup {
      fn drop(&mut self) {
        unregister(&self.0).expect("unregister the test scheme");
      }
    }

    #[test]
    fn register_writes_the_keys_and_unregister_removes_them() {
      let _serial = crate::serial();
      let scheme = unique_scheme();
      let root = scheme_key(&scheme);
      {
        let _cleanup = Cleanup(scheme.clone());
        // Upper case and spaces are normalised away, as today.
        register(&format!("  {}  ", scheme.to_uppercase()), &Registration::for_executable("Sweetview Test", "C:\\SweetviewTest\\app.exe"))
          .expect("register");
        assert_eq!(read(&root, None).as_deref(), Some("URL:Sweetview Test Protocol"));
        assert_eq!(read(&root, Some("URL Protocol")).as_deref(), Some(""));
        assert_eq!(read(&format!("{root}\\DefaultIcon"), None).as_deref(), Some("C:\\SweetviewTest\\app.exe,0"));
        assert_eq!(read(&format!("{root}\\shell\\open\\command"), None).as_deref(), Some("\"C:\\SweetviewTest\\app.exe\" \"%1\""));
      }
      assert_eq!(read(&root, None), None, "unregister removed the tree");
      unregister(&scheme).expect("unregistering a missing scheme is a no-op");
      assert!(register("123bad scheme!", &Registration::for_executable("x", "y")).unwrap_err().0.contains("invalid URL scheme"));
    }

    #[test]
    fn registering_returns_every_handle() {
      let _serial = crate::serial();
      let scheme = unique_scheme();
      let _cleanup = Cleanup(scheme.clone());
      let registration = Registration::for_executable("Sweetview Test", "C:\\SweetviewTest\\app.exe");
      register(&scheme, &registration).expect("register");
      unregister(&scheme).expect("unregister");
      let before = counts();
      for _ in 0..50 {
        register(&scheme, &registration).expect("register");
        unregister(&scheme).expect("unregister");
      }
      let after = counts();
      assert!(after.2 <= before.2 + 2, "registry keys were closed: {before:?} -> {after:?}");
    }
  }
}
