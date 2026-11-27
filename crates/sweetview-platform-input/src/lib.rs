//! System-wide mouse and keyboard hooks and the permission model for them.
//!
//! * [`MouseHook`] and [`KeyboardHook`]: one of each per process, installed on
//!   the calling (UI) thread, whose message loop delivers their events. Each
//!   event goes to the handler, which returns true to swallow it. Dropping the
//!   hook removes it, from inside its own handler too.
//! * [`permissions`]: what each hook needs from the OS, whether the process
//!   has it, and whether a failed install asks for it.
//!
//! The values events carry (kinds, modifier bits, DOM key codes) come from
//! `sweetview-keycodes`.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

mod events;
pub mod permissions;

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

pub use events::{HookError, KeyEvent, MouseEvent};
pub use platform::{KeyboardHook, MouseHook};
pub use sweetview_keycodes::{modifier, KeyEventKind, MouseEventKind, UNIDENTIFIED};
