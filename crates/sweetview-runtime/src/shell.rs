//! Telling the desktop shell that program icons changed.

/// Windows: tells the shell that icons changed (`SHChangeNotify` with
/// `SHCNE_ASSOCCHANGED` and `SHCNF_FLUSH`), so Explorer, the taskbar and the
/// Start menu draw a rebuilt program's icon. Changes nothing on the computer.
/// Elsewhere it does nothing. Callable from any thread; it opens no window.
pub fn refresh_shell_icons() {
  sweetview_platform_shell::icons::refresh_shell_icons();
}

#[cfg(test)]
mod tests {
  #[test]
  fn refreshing_returns_on_any_thread() {
    std::thread::spawn(super::refresh_shell_icons).join().expect("thread");
  }
}
