//! What a window's system menu offers, and the commands it carries, decided
//! from the window's state. The platform crate shows the menu and carries out
//! the command chosen.

/// What a window's system menu offers, from the window's state as whoever
/// owns it knows it: a frameless Sweetview window is maximised by its own
/// work-area toggle, which the OS knows nothing of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemMenuState {
  pub maximized: bool,
  pub minimized: bool,
  /// The window can be sized: Size is offered while it is neither maximised nor minimised.
  pub can_size: bool,
  /// The window can be maximised: Maximize is offered while it is not maximised.
  pub can_maximize: bool,
}

/// A command chosen from a system menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemCommand {
  Restore,
  Move,
  Size,
  Minimize,
  Maximize,
  Close,
  /// A command another program added to the menu, by its id.
  Other(u32),
}

/// The ids of the system menu's commands (`SC_*` of `WinUser.h`).
pub mod ids {
  pub const SC_SIZE: u32 = 0xF000;
  pub const SC_MOVE: u32 = 0xF010;
  pub const SC_MINIMIZE: u32 = 0xF020;
  pub const SC_MAXIMIZE: u32 = 0xF030;
  pub const SC_CLOSE: u32 = 0xF060;
  pub const SC_RESTORE: u32 = 0xF120;
}

impl SystemCommand {
  /// The command a menu item's id names.
  pub fn from_id(id: u32) -> Self {
    use ids::*;
    match id {
      SC_RESTORE => Self::Restore,
      SC_MOVE => Self::Move,
      SC_SIZE => Self::Size,
      SC_MINIMIZE => Self::Minimize,
      SC_MAXIMIZE => Self::Maximize,
      SC_CLOSE => Self::Close,
      other => Self::Other(other),
    }
  }

  /// The menu item id of the command.
  pub fn id(self) -> u32 {
    use ids::*;
    match self {
      Self::Restore => SC_RESTORE,
      Self::Move => SC_MOVE,
      Self::Size => SC_SIZE,
      Self::Minimize => SC_MINIMIZE,
      Self::Maximize => SC_MAXIMIZE,
      Self::Close => SC_CLOSE,
      Self::Other(id) => id,
    }
  }
}

/// Which of the system menu's commands `state` offers, by command. Close is
/// not among them: it is left as the window's owner set it.
pub fn system_menu_items(state: SystemMenuState) -> [(SystemCommand, bool); 5] {
  let normal = !state.maximized && !state.minimized;
  [
    (SystemCommand::Restore, state.maximized || state.minimized),
    (SystemCommand::Move, normal),
    (SystemCommand::Size, normal && state.can_size),
    (SystemCommand::Minimize, !state.minimized),
    (SystemCommand::Maximize, !state.maximized && state.can_maximize),
  ]
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ids_and_commands_map_both_ways() {
    for command in [SystemCommand::Restore, SystemCommand::Move, SystemCommand::Size, SystemCommand::Minimize, SystemCommand::Maximize, SystemCommand::Close, SystemCommand::Other(0x1234)] {
      assert_eq!(SystemCommand::from_id(command.id()), command);
    }
  }

  #[test]
  fn the_state_decides_what_is_offered() {
    let offered = |maximized, minimized, can_size, can_maximize| {
      system_menu_items(SystemMenuState { maximized, minimized, can_size, can_maximize }).map(|(_, enabled)| enabled)
    };
    // Restore, Move, Size, Minimize, Maximize.
    assert_eq!(offered(false, false, true, true), [false, true, true, true, true]);
    assert_eq!(offered(true, false, true, true), [true, false, false, true, false]);
    assert_eq!(offered(false, true, true, true), [true, false, false, false, true]);
    assert_eq!(offered(false, false, false, false), [false, true, false, true, false]);
  }
}
