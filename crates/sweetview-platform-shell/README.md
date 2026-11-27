# sweetview-platform-shell

Job: the shell integrations that are one OS conversation each: clipboard text, URL schemes, single instance, icon refresh.

| Module | What it gives | Windows |
|---|---|---|
| `clipboard` | `read_text`, `write_text`, `clear` | `OpenClipboard` tried 5 times 5 ms apart; a message-only owner window for writes; a read bounded by `GlobalSize` |
| `url_scheme` | `register`, `unregister` of a custom URL scheme for the current user | `HKCU\Software\Classes\<scheme>` with `URL Protocol`, `DefaultIcon`, `shell\open\command` |
| `single_instance` | `acquire`: the primary holds the id; a later launch hands its JSON payload to it | mutex `Local\sweetview.instance.<id>`; message-only window `SweetviewSingleInstanceWindow` titled `sweetview.instance.<id>`; `WM_COPYDATA` tagged `0x53575631`; 10 lookups 25 ms apart; 5000 ms send timeout |
| `icons` | `refresh_shell_icons` | `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH)` |

Names, limits and wire formats are today's TypeScript native layer's, so an application built from that layer and one built from this crate hand off to each other in both directions; an ignored test, `hands_off_to_and_from_the_typescript_implementation`, proves it with `bun` while that layer exists.

Every OS resource has an owning type that releases it on drop: the open clipboard, global memory, its lock and the mutex here; registry keys are `windows-registry`'s `Key` (Microsoft's safe registry API), and the message-only windows are `sweetview-platform-loop`'s `MessageWindow`, each with its window procedure as a closure.

Other platforms: `url_scheme` validates only (macOS reads schemes from the bundle's `Info.plist`), `icons` does nothing, and `clipboard` and `single_instance` report that the platform is not ported yet.

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
