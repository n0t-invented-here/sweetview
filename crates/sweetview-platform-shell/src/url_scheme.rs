//! Custom URL scheme registration for the current user:
//! `HKCU\Software\Classes\<scheme>`, with no administrator rights needed.

use crate::ShellError;

// The registry data, built without an OS call, in `sweetview-shell-data`.
pub use sweetview_shell_data::url_scheme::{normalize_scheme, registry_values, scheme_key, Registration};

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
  #[cfg(windows)]
  mod live {
    use super::super::*;
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
      sweetview_platform_loop::testing::assert_gives_back_every_handle(50, || {
        register(&scheme, &registration).expect("register");
        unregister(&scheme).expect("unregister");
      });
    }
  }
}
