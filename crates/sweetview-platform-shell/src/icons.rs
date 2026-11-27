//! Telling the shell that icons changed.

/// Tells the shell that icons changed, so Explorer, the taskbar and the Start
/// menu draw a rebuilt program's icon instead of the one they kept from the
/// file that was at that path before. It is the call an installer makes
/// (`SHChangeNotify` with `SHCNE_ASSOCCHANGED` and `SHCNF_FLUSH`) and changes
/// nothing on the computer. Elsewhere it does nothing: macOS reads the icon
/// from the `.app` bundle.
pub fn refresh_shell_icons() {
  #[cfg(windows)]
  {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_FLUSH};
    // SAFETY: SHCNE_ASSOCCHANGED takes no items, so both item pointers are null, as its
    // documentation requires; the flags are passed by value.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH, None, None) };
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn refreshing_returns() {
    #[cfg(windows)]
    let _serial = crate::serial();
    // SHCNF_FLUSH waits until the shell has processed the notification; it
    // has no result to observe beyond returning.
    super::refresh_shell_icons();
  }
}
