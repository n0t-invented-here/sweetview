# Unsafe ledger

Rewritten by `bun rust-rewrite/verify.ts <platform> --ledger`. 217 uses in 20 files.

| File | Uses of `unsafe` |
|---|---|
| `crates/sweetview-platform-input/src/windows.rs` | 8 |
| `crates/sweetview-platform-input/tests/windows_hooks.rs` | 7 |
| `crates/sweetview-platform-loop/src/com.rs` | 4 |
| `crates/sweetview-platform-loop/src/windows.rs` | 18 |
| `crates/sweetview-platform-notify/src/windows.rs` | 9 |
| `crates/sweetview-platform-shell/src/clipboard.rs` | 12 |
| `crates/sweetview-platform-shell/src/icons.rs` | 1 |
| `crates/sweetview-platform-shell/src/single_instance.rs` | 10 |
| `crates/sweetview-platform-shell/src/win.rs` | 1 |
| `crates/sweetview-platform-webview/src/windows/environment.rs` | 1 |
| `crates/sweetview-platform-webview/src/windows/handlers.rs` | 12 |
| `crates/sweetview-platform-webview/src/windows/istream.rs` | 11 |
| `crates/sweetview-platform-webview/src/windows/mod.rs` | 43 |
| `crates/sweetview-platform-window/src/metrics.rs` | 1 |
| `crates/sweetview-platform-window/src/popup.rs` | 4 |
| `crates/sweetview-platform-window/src/size_hint.rs` | 1 |
| `crates/sweetview-platform-window/src/tab_frame.rs` | 16 |
| `crates/sweetview-platform-window/src/tab_frame_tests.rs` | 12 |
| `crates/sweetview-platform-window/src/windows.rs` | 37 |
| `crates/sweetview-platform-window/src/windows_tests.rs` | 9 |

## Reasons

How to read this section: each crate, then each file, groups its remaining uses by behaviour. Each group gives the behaviour, the number of uses, the safe API looked for (crate, version, and the docs.rs page or the source file read in the cargo registry), why it does not serve, and the owning type or invariant that contains the use. Every Win32 function in `windows` 0.62.2 is declared `unsafe fn` (read in `windows-0.62.2/src/Windows/Win32/**`, for example `pub unsafe fn GetAsyncKeyState`), and so is every method of a Win32 COM interface in `webview2-com` 0.39.1; only WinRT methods are safe. "No safe wrapper" below means that, and that no crate named in `UNSAFE-POLICY.md` has the behaviour. Test files have one short entry each.

Shared types every platform crate uses, all in `sweetview-platform-loop`: `MessageWindow` (a message-only window with its procedure as a closure), `Poster` (posts to it from any thread, disarmed when it drops), `QueuedMessage` with `next_message`, `wait_message` and `dispatch_waiting` (the pump), `resource_counts` (the process's handle counts) and `testing::assert_gives_back_every_handle` (the policy's check made one way: USER objects, GDI objects and kernel handles each back at their starting value, the loop measured twice with `testing::smallest_growth`). Every handle test of the loop, window and shell crates and of the runtime's windows makes that check, except two that compare with a control run instead and say why where they are (`LoopHost`, DECISIONS D23; the tab-frame popup menu, D20).

## sweetview-platform-loop

### `crates/sweetview-platform-loop/src/windows.rs` (24: 20 source, 4 test)

- **Message-only windows** (8: `GetModuleHandleW` in `this_module`, `RegisterClassExW`, `GetClassInfoExW` in `class_procedure`, `UnregisterClassW` in `unregister_class`, `CreateWindowExW`, `WindowHandle::borrow_raw`, `DestroyWindow`, `DefWindowProcW`). Looked for: `tao` 0.38.0 `WindowBuilder` (https://docs.rs/tao/0.38.0/tao/window/struct.WindowBuilder.html) makes top-level windows only; its own message target is private (`tao-0.38.0/src/platform_impl/windows/event_loop.rs`, `create_event_target_window`). A message posted to a window is what every message loop dispatches, a modal one included (DECISIONS D3). `raw-window-handle` 0.6.2 `WindowHandle::borrow_raw` (https://docs.rs/raw-window-handle/0.6.2/raw_window_handle/struct.WindowHandle.html#method.borrow_raw) is `unsafe` by design. Contained by `MessageWindow`: it owns the window, is not `Send`, and destroys it in `Drop`. The window procedure answers `WM_CLOSE` itself (`DefWindowProcW` would destroy the window), and on `WM_NCDESTROY` from any other destroyer (code of this thread calling `DestroyWindow` on the lent handle) it zeroes the post target and forgets the closure, so the owner then refuses every call (`live_hwnd` is `None`: no post, timer, peek or lent handle) and its `Drop` destroys nothing. The handle is lent only borrowed for `&self` through `HasWindowHandle`, and only while the window exists. The procedure finds its closure in a thread-local table, so no pointer rides in the window. The class is registered with `message_window_proc`; a class of the same name another part of the process registered with another procedure is refused (`GetClassInfoExW`), and the last window of a class unregisters it, under a process-wide lock that every registration, creation and destruction holds.
- **Posting from any thread** (1: `PostMessageW`). Looked for: `tao` `EventLoopProxy::send_event` (https://docs.rs/tao/0.38.0/tao/event_loop/struct.EventLoopProxy.html), which `tao` holds back while its handler runs (D3). Contained by `Poster`: the handle value is non-zero only while the window exists, and the lock is held across the post and across both zeroings (`MessageWindow::drop`, `WM_NCDESTROY`).
- **The pump** (5: one `PeekMessageW` in `peek`, `GetMessageW`, `TranslateMessage`, `DispatchMessageW`, `PostQuitMessage`). Looked for: `tao` 0.38.0 `EventLoopExtRunReturn::run_return` (https://docs.rs/tao/0.38.0/tao/platform/run_return/trait.EventLoopExtRunReturn.html; `tao-0.38.0/src/platform/run_return.rs`) runs `tao`'s own loop and handler only, and `tao` 0.38.0 has no other pump; it has no call to take back a quit, to wait for one message of the thread's queue, or to take one window's due timers. `std` has no message queue. Contained by `QueuedMessage`: only `peek` and `wait_message` make one, from what the OS filled, so translate and dispatch see only OS-queued messages, and `dispatch(self)` consumes it, so a message (which can carry ownership, as `tao`'s boxed cross-thread closures do) is dispatched at most once.
- **Timers** (2: `SetTimer`, `KillTimer`). Looked for: `tao` 0.38.0 `ControlFlow::WaitUntil` (https://docs.rs/tao/0.38.0/tao/event_loop/enum.ControlFlow.html), delivered only through `tao`'s handler and not inside a modal loop (D3); `std` timers have no thread affinity and post nothing to a message loop. Contained by `SignalWindow`, which kills every timer it set in `Drop` before its window goes, and sets or kills one only on a live window (`live_hwnd`).
- **Handle counts** (4: `GetCurrentProcess`, `GetGuiResources` twice, `GetProcessHandleCount`). Looked for: `std::process` (https://doc.rust-lang.org/std/process/index.html) has no handle count, and the `windows` 0.62.2 declarations of all three (`windows-0.62.2/src/Windows/Win32/System/Threading/mod.rs`) are `unsafe fn` with no safe wrapper; `sysinfo` and the other process-statistics crates are not in the policy's list. The pseudo-handle is a constant that needs no closing; the out-parameter is a local.
- Tests (4): `IsWindow` (the window still exists after a posted `WM_CLOSE`), `DestroyWindow` (destroys a window out from under its owner), and `RegisterClassExW` with a `DefWindowProcW` procedure (a class of the same name registered by other code).

### `crates/sweetview-platform-loop/src/com.rs` (4: 2 source, 2 test)

- **The UI thread's STA** (2: `CoInitializeEx`, `CoUninitialize`). Looked for: `windows` 0.62.2 / `windows-core` 0.62.2 have no safe COM initialisation (`windows-core-0.62.2/src`: none); `wry` initialises COM inside `build` only (`wry-0.58.2/src/webview2/mod.rs`). Contained by `ComApartment`: made only after a successful initialise, not `Send`, balanced once in `Drop`.
- Test `entering_twice_and_leaving_is_balanced` (2): makes a thread multi-threaded with `CoInitializeEx` and leaves it with `CoUninitialize`, to prove an STA is then refused.

`loop_host.rs` has none: `LoopHost` keeps a clone of `tao`'s `EventLoopWindowTarget`, which is `Clone` in 0.38.0 (`tao-0.38.0/src/event_loop.rs`, `#[derive(Clone)] pub struct EventLoopWindowTarget`).

## sweetview-platform-input

### `crates/sweetview-platform-input/src/windows.rs` (8)

- **Installing and removing a low-level hook** (3: `GetModuleHandleW`, `SetWindowsHookExW`, one `UnhookWindowsHookEx` in `OwnedHook::unhook`). Looked for: `tao` 0.38.0 `DeviceEvent` (https://docs.rs/tao/0.38.0/tao/event/enum.DeviceEvent.html) is raw input through its own handler and cannot swallow an event; no crate in the policy installs `WH_MOUSE_LL`/`WH_KEYBOARD_LL`; `SetWindowsHookExW` is `unsafe` (proposal, "API references"). Contained by `OwnedHook` (unhooked exactly once, by `remove` or `Drop`), `MouseHook`/`KeyboardHook` (not `Send`, one per process through `ProcessSlot`).
- **The hook procedures' arguments** (3: the `MSLLHOOKSTRUCT` and `KBDLLHOOKSTRUCT` reads from `lParam`, one `CallNextHookEx` in `HookCall::pass_on`). No safe API can read the OS's `lParam`. Invariant: for `code >= 0` the OS passes a valid struct for the call, checked non-null and copied at once; `HookCall` is made only by the two procedures from their own arguments. The handler runs inside `catch_unwind`.
- **Key state** (2: `GetAsyncKeyState`, `MapVirtualKeyW`). Looked for: `tao` `ModifiersState` exists only inside `tao`'s handler, which a hook procedure is not. Both take integers and read no memory of ours.

### `crates/sweetview-platform-input/tests/windows_hooks.rs` (7, test)

Drives the hooks with real input: `SetProcessDpiAwarenessContext` (physical pixels, as the hook's), `SendInput`, `GetSystemMetrics` twice (the primary screen), `GetCursorPos`/`SetCursorPos` (put the pointer back), `GetAsyncKeyState` (keys left up). `tao`'s cursor and monitor reads need an event loop this test does not run, and would set the process's DPI awareness themselves.

## sweetview-platform-notify

### `crates/sweetview-platform-notify/src/windows.rs` (9)

- **The balloon's icon** (4: `GetSystemMetrics`, `CreateIconFromResourceEx`, `LoadIconW`, `DestroyIcon`). Looked for: `tray-icon` 0.27.0 `Icon` (https://docs.rs/tray-icon/0.27.0/tray_icon/struct.Icon.html) and `muda` 0.22.0 `Icon` keep their `HICON` private, and `Shell_NotifyIconW` needs one. Contained by `BalloonIcon`: an icon it made is destroyed in `Drop` after the shell's icon is deleted; the stock icon is shared and never destroyed.
- **The hidden notification-area icon** (2: `Shell_NotifyIconW` add and delete). Looked for: `tray-icon` 0.27.0 `TrayIcon` (https://docs.rs/tray-icon/0.27.0/tray_icon/struct.TrayIcon.html) has no balloon (`NIF_INFO`) call, and the fallback must not need the application's tray. Contained by `NotifyWindow`: every icon is deleted in `Drop` before its `MessageWindow` goes; `NOTIFYICONDATAW` is the `windows` crate's struct, built in the frame.
- **WinRT on this thread** (3: `RoInitialize`, `RoUninitialize`, `CoIncrementMTAUsage`). Looked for: `windows` 0.62.2 activates WinRT types safely but has no safe initialisation. Contained by `RoInit` (not `Send`, balanced in `Drop` on the same thread) and `keep_com_loaded` (once per process, through a `OnceLock`).

The window, its procedure and the posts from WinRT threads are `MessageWindow` and `Poster`; the AUMID key is `windows-registry` 0.6.1 (https://docs.rs/windows-registry/0.6.1/windows_registry/struct.Key.html), so none of them is here.

## sweetview-platform-shell

### `crates/sweetview-platform-shell/src/clipboard.rs` (13: 12 source, 1 test)

- **The open clipboard** (3: `OpenClipboard`, `EmptyClipboard`, `CloseClipboard`) and **its data** (2: `GetClipboardData` in `LockedGlobal::lock`, `SetClipboardData`). Contained by `OpenedClipboard`, which borrows the owner `MessageWindow` for as long as the clipboard is open and closes it in `Drop`; it is not `Send`.
- **Global memory** (7: `GlobalAlloc`, `GlobalFree`, `GlobalLock`, `GlobalSize`, `GlobalUnlock`, the slice over the locked block, the copy into it). Contained by `OwnedGlobal` (freed in `Drop` unless the clipboard took it) and `LockedGlobal` (unlocked in `Drop`; the slice and the copy are bounded by the size read once the block is locked). A lock is made only from what owns the block, borrowed for the lock's whole life (`Block`: the `OwnedGlobal` exclusively, or the open clipboard, from which the lock takes the text block itself), so the block stays allocated while it is locked whatever the caller does.
- Test `a_global_block_not_handed_over_is_freed` (1: `GlobalSize`): the handle counts do not include global memory, so the block's own size is read before and after its owner drops.
- Looked for: `clipboard-win` 5.4.3 (`clipboard-win-5.4.3/src/raw.rs`; https://docs.rs/clipboard-win/5.4.3/clipboard_win/raw/index.html), which `arboard` builds on, wraps exactly these calls safely, but `raw::close` impersonates the anonymous token around `CloseClipboard` and then reverts (`AnonymousTokenImpersonator`), which drops any impersonation the calling thread had, and `raw::size` turns a failed `GlobalLock` into "no data"; both change behaviour. `windows` 0.62.2 WinRT `Windows::ApplicationModel::DataTransfer::Clipboard` is safe but works through OLE delayed rendering and its own ownership and retry rules, which today's 5 tries 5 ms apart on `OpenClipboard` with a message-only owner are not.

### `crates/sweetview-platform-shell/src/single_instance.rs` (9: 6 source, 3 test)

- **Handing the payload to the primary** (4: `FindWindowExW`, `GetWindowThreadProcessId`, `AllowSetForegroundWindow`, `SendMessageTimeoutW`). Looked for: `tao` 0.38.0 (https://docs.rs/tao/0.38.0/tao/) and the other crates the policy names have no message to another process; `std::process` has none; `windows` 0.62.2 declares all four `unsafe fn` (https://docs.rs/windows/0.62.2/windows/Win32/UI/WindowsAndMessaging/fn.SendMessageTimeoutW.html). The primary must be found and reached by today's class, title and `WM_COPYDATA` layout, so a build on the old library and one on this one hand off to each other. The other process's window is validated by the OS on each call, and the payload is a slice this frame owns for the whole send.
- **Reading a handoff** (2: the `COPYDATASTRUCT` deref, the slice over `lpData`). Looked for: `windows` 0.62.2 `COPYDATASTRUCT` (https://docs.rs/windows/0.62.2/windows/Win32/System/DataExchange/struct.COPYDATASTRUCT.html) is the plain struct with a raw `lpData`, and `MessageWindow`'s closure gets `lParam` as an integer; no crate reads another process's `WM_COPYDATA`. The OS's `WM_COPYDATA` contract: valid until the procedure returns; `lParam` checked non-null first; layout from the `windows` crate.
- Test `a_secondary_retries_until_the_primarys_window_is_found` (3: `FindWindowExW`, `SetWindowTextW` twice): hides the primary's window from the lookup by renaming it, then shows it again.

### `crates/sweetview-platform-shell/src/win.rs` (2)

- **The named mutex** (1: `CreateMutexW` in `OwnedHandle::named_mutex`). Looked for: `std` has no named mutex; the name `Local\sweetview.instance.<id>` must be today's for the TypeScript layer to find it. Contained by `OwnedHandle`, released after the window in `SingleInstance`'s field order.
- **Closing a kernel handle** (1: `CloseHandle` in `OwnedHandle::drop`). Looked for: `windows-core` 0.62.2 `Owned<HANDLE>` (https://docs.rs/windows-core/0.62.2/windows_core/struct.Owned.html) closes on drop, but `Owned::new` is `unsafe`, so it moves the use rather than removing it. `OwnedHandle`'s field is private to `win.rs` and its only constructor is the OS call that opens the handle (`named_mutex`), so no other code of the crate can wrap a handle it does not own.

### `crates/sweetview-platform-shell/src/icons.rs` (1)

- **Telling the shell icons changed** (1: `SHChangeNotify`). Looked for: `windows` 0.62.2 `SHChangeNotify` (https://docs.rs/windows/0.62.2/windows/Win32/UI/Shell/fn.SHChangeNotify.html) is `unsafe fn` with no safe wrapper, and neither `tao` 0.38.0, `tray-icon` 0.27.0 nor `muda` 0.22.0 tells the shell anything about file associations. `SHCNE_ASSOCCHANGED` takes no items, so both item pointers are null as documented.

The registry is `windows-registry` 0.6.1, and the message-only windows are `MessageWindow`, so `url_scheme.rs` has none.

## sweetview-platform-webview

All of it reaches WebView2 through the objects `wry` 0.58.2 hands out (`WebViewExtWindows::controller`, `webview`, `environment`; https://docs.rs/wry/0.58.2/wry/trait.WebViewExtWindows.html) and the typed interfaces of `webview2-com` 0.39.1 (https://docs.rs/webview2-com/0.39.1/webview2_com/), policy level 3. Each COM object is held by a COM reference (`Inner`'s fields, a frame's `cast`, the event args WebView2 holds for the handler's call); on a closed webview a call returns an error. `wry` 0.58.2 was read for each behaviour (`wry-0.58.2/src/lib.rs`, `src/webview2/mod.rs`): what it offers is used (`WebView::focus` for focus, `webview_version` for the runtime check); the rest is in "What `wry` lacks" in `SWEETVIEW-RESTART-PROPOSAL.md`.

### `crates/sweetview-platform-webview/src/windows/mod.rs` (43)

- **Keys held** (1: `GetKeyState`). No safe wrapper; takes an integer.
- **Controller and webview settings** (7: `Stop`, `SetDefaultBackgroundColor`, `SetAllowExternalDrop`, `AllowExternalDrop`, `NotifyParentWindowPositionChanged`, `CallDevToolsProtocolMethod`, `Close`). `wry` has no stop, external-drop, devtools-protocol or parent-moved call; its `set_background_color` turns any non-zero alpha into 255 (`webview2/mod.rs`, `set_background_color`) where this crate refuses it; its own drop closes the controller after this crate's teardown needs it closed (`requests.md` order).
- **Request filters and scripts** (5: `AddWebResourceRequestedFilterWithRequestSourceKinds`, `AddWebResourceRequestedFilter`, one `AddScriptToExecuteOnDocumentCreated` in `add_script`, `ExecuteScript`, `RemoveScriptToExecuteOnDocumentCreated`). `wry`'s custom protocols take whole bodies and register their own origins; `with_initialization_script` cannot remove a script; `evaluate_script` is on the `wry::WebView`, which `WebviewExtras` does not hold.
- **Answering a request** (8: `Request`, `Uri`, `Method`, `GetDeferral`, one `CreateWebResourceResponse` in `create_response`, `SHCreateMemStream`, `Complete`, one `SetResponse` in `set_response`). `wry`'s `RequestAsyncResponder::respond` takes the whole body (proposal). `SHCreateMemStream` has no safe wrapper; the body slice is borrowed for the call, which copies it. Contained by `Pending` (the deferral, completed once after removal from the table) and `WebviewExtras::drop` (releases what is still open).
- **Request headers and body** (7: `Headers`, `GetIterator`, `HasCurrentHeader`, `GetCurrentHeader`, `MoveNext`, `Content`, `Seek`). No `wry` API exposes the request object. Out-strings are freed by `take_pwstr`.
- **Dropped files** (5: `TryGetWebMessageAsString`, `AdditionalObjects`, `Count`, `GetValueAtIndex`, `Path`). `wry`'s `with_drag_drop_handler` revokes WebView2's drop targets (DECISIONS D17).
- **Accelerator keys** (3: `KeyEventKind`, `VirtualKey`, `SetHandled`) and **navigation failures** (7: `NavigationId` twice, `Uri`, `IsSuccess`, `WebErrorStatus`, `HttpStatusCode`, `Source`). `wry` has no accelerator or failed-navigation callback (proposal, "API references").

### `crates/sweetview-platform-webview/src/windows/handlers.rs` (12)

- **Event registrations** (12: six `add_*` and their six `remove_*`). `wry`'s handlers are fixed at build time and not these events. Contained by `Registration`: it holds a COM reference to the object it registered on and removes its token there in `Drop`, so no handler outlives its registration.

### `crates/sweetview-platform-webview/src/windows/istream.rs` (11: 5 source, 6 test)

- **The streamed body's `IStream`** (4: the two `pcbread` writes and the slice over `pv` in `Read`, the `STATSTG` write in `Stat`). `wry` has no streamed body; the `windows` crate's `#[implement]` hands the implementation COM's raw out-pointers. The `ISequentialStream`/`IStream` contracts: each pointer is checked non-null and valid for the call, and the slice does not outlive it.
- **Reading a stream** (1: `Read` in `read_into`), used for the request body. The buffer is lent for the call and its length bounds the read.
- Tests (6): `Seek`, `Write`, `Clone`, `Stat` and two `Read`s with a null buffer, called through the COM interface so the vtable is what is tested.

### `crates/sweetview-platform-webview/src/windows/environment.rs` (1)

- **Creating the environment** (1: `CreateCoreWebView2EnvironmentWithOptions`). `wry` creates its own with options that cannot share a profile with today's (D15); `webview2-com` exposes only the raw function. The folder is an `HSTRING` that outlives the call; the handler is a COM object WebView2 holds until it completes. The default folder is `dirs` 7.0.0 `config_dir` (https://docs.rs/dirs/7.0.0/dirs/fn.config_dir.html; `dirs-sys-0.5.0/src/lib.rs`, `known_folder(FOLDERID_RoamingAppData)`), the runtime check `wry::webview_version`, and the STA the loop's `ComApartment`.

`pump.rs` and `tests/teardown.rs` have none: the pump is the loop's `wait_message`, and the teardown test counts through `resource_counts`.

## sweetview-platform-window

`tao` 0.38.0 (https://docs.rs/tao/0.38.0/tao/window/struct.Window.html, `WindowExtWindows`) has an API for most of these on windows it made; this crate serves every window of the thread through `NativeWindow`, an application's own (`ForeignWindow`) included, which `tao` cannot wrap, and DECISIONS D8 and D9 say why even `tao`'s own windows go through it (events held back, `SW_SHOW` activating, style rewrites). Every window function validates its handle and fails on one that is gone.

### `crates/sweetview-platform-window/src/windows.rs` (37)

- **Naming a window** (5: `WindowHandle::borrow_raw`, `IsWindow`, `GetWindowThreadProcessId`, `GetCurrentThreadId`, `PostMessageW`). `raw-window-handle` 0.6.2 `borrow_raw` is `unsafe`. `ForeignWindow` is checked with `IsWindow` when named and again when lent, is not `Send`, and its borrow is tied to `&self`. A handle that crosses to JavaScript is an integer validated once (the design).
- **Reading a window** (7: `IsWindowVisible`, `GetActiveWindow`, one `IsIconic` in `is_iconic`, `IsZoomed`, `GetWindowRect`, one `GetDpiForWindow` in `dpi_of`, `GetWindowLongPtrW`). `tao`'s readers exist only for its own windows. Out-structs are locals.
- **Changing a window** (11: one `SetWindowLongPtrW` in `set_style_of`, which writes `GWL_STYLE` or `GWL_EXSTYLE` only, one `SetWindowPos` in `set_window_pos`, `ShowWindow`, one `SetForegroundWindow` in `set_foreground`, `SetWindowTextW`, `ReleaseCapture` and `SendMessageW` for the frame press in `press_frame` (the caption for `start_os_drag`, any edge for the tab frame), `GetWindow`, one `GetClientRect` in `client_size`, `MoveWindow`, `SetLayeredWindowAttributes`). `tao` sets an outer position and an inner size as two calls, shows with `SW_SHOW`, rewrites the extended style from its own flags, and has no layered attributes (README of this crate).
- **Destroying a `tao` window now** (1: `DestroyWindow` in `destroy_now`): `tao` destroys later, from its own loop; the caller drops the `tao` window next.
- **Window icons** (5: `CreateIconFromResourceEx`, `LoadIconW`, `DestroyIcon`, one `GetSystemMetrics` in `metric`, `SendMessageW` for `WM_SETICON`). `tao` `Window::set_window_icon` takes one RGBA image for both sizes. Contained by `OwnedIcon` (destroyed in `Drop`) and `WindowIcons` (kept until the next icon replaces it).
- **Buttons and work area** (2: `GetAsyncKeyState`, `GetMonitorInfoW`). `tao`'s `MonitorHandle` has no work area; button state outside `tao`'s handler has no API.
- **The subclass** (6: `SetWindowSubclass`, `RemoveWindowSubclass`, one `DefSubclassProc` in `forward`, which the tab frame's procedure also forwards through, `DragQueryFileW` in `Drop_::query`, `DragFinish`, the `STYLESTRUCT` borrow in `style_change`). No crate offers subclassing. Contained by `WindowSubclass` (removed in `Drop` or on `WM_NCDESTROY`; state found by handle in a thread-local table), `Drop_` (the `HDROP` finished once in `Drop`), and `style_change` (the borrow is tied to the procedure's own `lParam`). `subclass_proc` is a safe `extern "system"` function whose body runs inside `catch_unwind`.

### `crates/sweetview-platform-window/src/popup.rs` (4)

- **Showing a `muda` menu for a window** (2: `ScreenToClient`, `ContextMenu::show_context_menu_for_hwnd`). `muda` 0.22.0 `show_context_menu_for_hwnd` is `unsafe` (`muda-0.22.0/src/context_menu.rs:30`; https://docs.rs/muda/0.22.0/muda/trait.ContextMenu.html) and takes a client point. The window is a `ForeignWindow`.
- **A check mark on an icon item** (2: `GetSubMenu`, `SetMenuItemInfoW`). `muda` has no item with both (D14). The menus are `muda`'s, borrowed for the call.

### `crates/sweetview-platform-window/src/metrics.rs` (1)

- **Double-click time** (1: `GetDoubleClickTime`). `tray-icon` 0.27.0 leaves single versus double click to the application; no crate reads it.

### `crates/sweetview-platform-window/src/size_hint.rs` (1)

- **The frame for a client size at a DPI** (1: `AdjustWindowRectExForDpi`). `tao` computes frames only inside its own window creation. The rectangle is a local.

### `crates/sweetview-platform-window/src/windows_tests.rs` (9, test)

`TestWindow`, a plain `STATIC` window an application would hand over (`CreateWindowExW`, `DestroyWindow`, `SendMessageW`), and a shell file drop built as the shell builds one (`GlobalAlloc`, `GlobalLock`, the `DROPFILES` write, the path copy, `GlobalUnlock`, and `GlobalSize` to see that `DragFinish` freed it).

### `crates/sweetview-platform-window/src/tab_frame.rs` (16)

The frame of a tabbed window is a `tao` window without decorations whose caption is drawn by the strip's webview. Its presses, foreground and close go through `windows.rs`'s `press_frame`, `set_foreground`, `forward` and `client_size`, so they are not here.

- **Foreground and close** (2: `GetForegroundWindow`, `SendMessageW` for `WM_CLOSE` in `request_close`, which `send_close_for_tests` also uses). `tao` 0.38.0 has `Window::is_focused` for its own windows only and no synchronous close request (`request_close` returns once the window's close listeners ran). No pointer is passed; the OS validates the handle.
- **The system menu** (4: `GetSystemMenu`, `EnableMenuItem`, `SetMenuDefaultItem`, `TrackPopupMenu` in `track`, which the popup menu also uses). Neither `tao` nor `muda` 0.22.0 reaches a window's own system menu (`muda` builds its own menus); the menu belongs to the window and is not destroyed here.
- **The tab popup menu** (3: `CreatePopupMenu`, one `AppendMenuW`, `DestroyMenu`). Looked for: `muda` 0.22.0 `ContextMenu::show_context_menu_for_hwnd` (https://docs.rs/muda/0.22.0/muda/trait.ContextMenu.html) is itself `unsafe` and reports the chosen item through `MenuEvent`, not as `TrackPopupMenu`'s `TPM_RETURNCMD` result the caller waits for. Contained by `OwnedMenu`: not `Send`, destroyed in `Drop`; the item text is a NUL-terminated buffer alive for the call.
- **The backdrop** (4: `CreateSolidBrush`, `DeleteObject`, `InvalidateRect`, one `FillRect` for both areas). Looked for: `tao` 0.38.0 `Window::set_background_color` (https://docs.rs/tao/0.38.0/tao/window/struct.Window.html#method.set_background_color; `tao-0.38.0/src/platform_impl/windows/window.rs`) paints one colour and the frame needs two (the strip's and the page's); `Window::request_redraw` is `RedrawWindow(.., RDW_INTERNALPAINT)`, which does not erase the background, hence `InvalidateRect` with erase. Contained by `OwnedBrush` (deleted in `Drop`, never selected into a device context) and `Brushes`; the device context is the one `WM_ERASEBKGND` passes, valid for the message.
- **The frame's own procedure** (2: `SetWindowSubclass`, `RemoveWindowSubclass`). Looked for: `tao` 0.38.0 `EventLoopBuilderExtWindows::with_msg_hook` (`tao-0.38.0/src/platform/windows.rs`; called from the loop's `GetMessage` in `platform_impl/windows/event_loop.rs`) sees queued messages only, and `WM_ERASEBKGND` and `WM_DPICHANGED` are sent ones. Contained by `FrameMessages`: removed in `Drop` or on `WM_NCDESTROY`, state found by handle in a thread-local table and checked to be the same frame before it is forgotten; `frame_proc` is a safe `extern "system"` function whose body runs inside `catch_unwind`.
- **The suggested rectangle of a DPI change** (1: the `RECT` read from `lParam` in `WM_DPICHANGED`). No API reads the OS's `lParam`; the OS passes a `RECT` it owns for the message, checked non-null and copied at once. `tao` applies its own size instead of the suggested one.

### `crates/sweetview-platform-window/src/tab_frame_tests.rs` (12, test)

Reads what the frame erased into a bitmap of the test's own (`GetDC`, `CreateCompatibleDC`, `CreateCompatibleBitmap`, `SelectObject` twice, `SendMessageW` for `WM_ERASEBKGND`, one `GetPixel`, `DeleteObject`, `DeleteDC`, `ReleaseDC`), and sends a `WM_DPICHANGED` with a `RECT` and reads the window's rectangle back (`SendMessageW`, `GetWindowRect`). The window is `windows_tests.rs`'s `TestWindow`.
