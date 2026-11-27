# Forks

One crate is forked so this project can add what it lacks: `wry`. The fork lives under the same owner as this repository and is cloned beside it: `<repositories root>/<provider>/n0t-invented-here/wry`.

| Fork | Upstream | Base | Work branch |
|---|---|---|---|
| `n0t-invented-here/wry` | `tauri-apps/wry` | the commit that released version 0.58.2 | `sweetview` |

`tao`, `muda`, `tray-icon` and `rfd` are used as published. A fork of one of them is made only when a checklist item cannot be met without it, and is then added to this table with its reason in `rust-rewrite/DECISIONS.md`.

## Why `tray-icon` is not forked

`SWEETVIEW-RESTART-PROPOSAL.md` was first written against `main`, where a notification on Windows was a balloon on the tray's own icon, and it planned a `tray-icon` fork for that. On this branch the notifier no longer uses the tray: `packages/sweetview-native/src/win32/notifier.ts` shows WinRT toasts and falls back to a balloon on a hidden notification icon of its own (`NIM_ADD` with `NIS_HIDDEN` on the notifier's message window, one icon per notification, removed on click, timeout or hide). That fallback is this project's code in the platform crate, on `Shell_NotifyIconW`. It needs nothing from the tray, except the tray's current icon bytes for the balloon's picture.

## How the workspace uses the fork

The Cargo workspace depends on the fork as a git dependency pinned to a commit of its `sweetview` branch (`rev = "..."`). A fork change is committed and pushed to the fork first; then the pinned commit here moves. No path dependency and no machine-local path is committed.

## Additions to `wry`

`SWEETVIEW-RESTART-PROPOSAL.md`, section "Fork additions, located", names the file and function for each.

1. Windows: streamed response bodies for custom protocols.
2. macOS: streamed response bodies for custom protocols.
3. macOS: drag routing for drags from other applications.
4. macOS: page messages accepted from the top-level document only.
5. macOS: a navigation-failed event.

The Windows goal writes addition 1. The macOS goal writes 2 to 5. Each is written in the style of the code around it, with its own test, so it can be offered upstream. Offering it upstream is an owner action.

## When the fork is missing

Run `git ls-remote` against the fork's URL (this repository's `origin` URL with the repository name replaced by `wry`). If it does not answer, do every checklist group that does not need it, with the published `wry` 0.58.2 in its place: groups W0, W1, W3, W4, W5, W6, W8 and the transports group need no fork change. Streaming (W2.5) is the one Windows item that does. Record the missing fork in `rust-rewrite/OWNER-ACTIONS.md` and at the top of the session's report; the goal is not complete until W2.5 is ticked.
