# sweetview-platform-input

Job: system-wide mouse and keyboard hooks and the permission model for them.

| Item | What it gives | Windows | macOS, Linux |
|---|---|---|---|
| `MouseHook::install(handler)` | every mouse event on the system (move, left, right, middle, vertical wheel) with screen coordinates, wheel notches and the modifiers held; the handler returns true to swallow it | `WH_MOUSE_LL` on the calling thread | not ported yet: `HookError::Os` |
| `KeyboardHook::install(handler)` | every key event (down, up, repeat) with its DOM code, raw virtual-key code and the modifiers after the event; true swallows it | `WH_KEYBOARD_LL` on the calling thread | not ported yet: `HookError::Os` |
| `permissions::{needed, status, request, ready, set_auto_request, auto_request}` | what a hook needs from the OS and whether the process has it | nothing needed; every permission `NotApplicable` | macOS: Device Control needed, `Missing` until the macOS goal builds the event tap; Linux: as Windows |

Rules the types carry:

- One hook of each kind per process, whichever thread installs it; a second install fails with `HookError::AlreadyInstalled` (`code()` 1, `WEBVIEW_ERROR_DUPLICATE`).
- A hook is not `Send`: it belongs to the thread that installed it, whose message loop delivers its events. Dropping it unhooks it, from inside its own handler too; `remove()` does the same and reports an OS failure.
- The hook procedures find their handlers in thread-local storage; no pointer rides in global state. A handler that panics is caught at the hook procedure and its event goes on.

The tables and decisions that need no OS call (DOM codes, kinds, wheel notches, modifiers, repeat) are in `sweetview-keycodes` and are tested there.

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`. Its tests install both hooks for real and drive them with `SendInput`; they move the pointer a few pixels and put it back, swallow every button press and wheel turn they make, and use only F24 and Shift.
