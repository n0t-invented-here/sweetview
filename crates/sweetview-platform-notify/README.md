# sweetview-platform-notify

Job: desktop notifications with a click that comes back.

| Type | What it gives |
|---|---|
| `Notifier` | shows a notification and calls `on_click(id, data_json)` on its own thread, from that thread's message loop, when the user clicks it |
| `toast_xml` | the toast's XML and its escaping, the AUMID rules and registry path: pure logic |
| `ico` | the `.ico` directory reader the balloon icon uses: pure logic |

On Windows the notification is a WinRT toast (`ToastNotificationManager`, `ToastNotification`, `XmlDocument` and `TypedEventHandler` from the `windows` crate), attributed to an AUMID registered under `HKCU\Software\Classes\AppUserModelId\<appId>`. When WinRT cannot start, the AUMID cannot be registered, or a toast fails, the notification is a balloon on a hidden notification-area icon of the notifier's own, whether or not a tray icon exists. The toast handlers run on WinRT threads and only post a message to the notifier's message-only window, so clicks and the fallback run on the notifier's thread.

The notifier's window is `sweetview-platform-loop`'s `MessageWindow`, and the toast handlers post through its `Poster`, which fails harmlessly once the window is gone. The AUMID key is written with `windows-registry`, Microsoft's safe registry API.

Names and behaviour are today's TypeScript notifier's: the toast XML, the AUMID key and `DisplayName` rule, cookies from 1, balloon uIDs from 10000, `WM_APP + 2` for balloon events and `WM_APP + 3` for toast events.

Test hooks on `Notifier` (`force_path`, `show`, `simulate_toast_event`, `simulate_balloon_event`, `pending_toasts`, `pending_balloons`, `toasts_available`) and `live_toast_handlers()` let a test prove the paths without a person clicking.

Other platforms get a stand-in whose `Notifier::new` reports that the platform is not ported yet.

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
