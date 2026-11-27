# sweetview-keycodes

Job: the tables that turn an OS key or mouse message into the values applications see.

| Item | What it is | Ported from (C++ fork, `core/include/webview/detail/`) |
|---|---|---|
| `dom_code_from_windows_scan`, `dom_code_from_mac_keycode`, `UNIDENTIFIED` | a physical key to its DOM `KeyboardEvent.code` name; `"Unidentified"` for a key without one | `key_codes.hh` |
| `MouseEventKind`, `KeyEventKind`, `modifier` | the numbers of the C API's `webview_mouse_event_t`, `webview_key_event_t`, `webview_modifier_t`, which are the bindings' `MouseEvent`, `KeyEvent` and `Modifier` | `types.h` |
| `KeysDown` | which keys a keyboard hook has seen go down and not yet up | `keyboard_hook.hh` |
| `win` | the Windows hooks' decisions: message to kind, wheel notches, the scan code a key is named by, the made-up Shifts, modifiers now and after a key, down, up and repeat | `mouse_hook.hh`, `keyboard_hook.hh`, `input_hooks.hh` |
| `mac` | the macOS hooks' decisions: event type to kind, modifiers from flags, a modifier's flags-changed as down or up | `mouse_hook.hh`, `keyboard_hook.hh`, `input_hooks.hh` |

An OS answer a decision needs (the asynchronous key state, `MapVirtualKeyW`, an event field) comes in as a closure, so everything here runs as plain tests on every platform. `sweetview-platform-input` makes the OS calls.

`unsafe` is forbidden in this crate.
