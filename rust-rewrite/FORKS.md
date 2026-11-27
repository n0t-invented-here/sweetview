# Forks

Two crates are forked so this project can add what they lack. Each fork lives under the same owner as this repository and is cloned beside it: `<repositories root>/<provider>/n0t-invented-here/<repo>`.

| Fork | Upstream | Base | Work branch |
|---|---|---|---|
| `n0t-invented-here/wry` | `tauri-apps/wry` | the commit that released version 0.58.2 | `sweetview` |
| `n0t-invented-here/tray-icon` | `tauri-apps/tray-icon` | the commit that released version 0.27.0 | `sweetview` |

`tao`, `muda` and `rfd` are used as published. A fork of one of them is made only when a checklist item cannot be met without it, and is then added to this table with its reason in `rust-rewrite/DECISIONS.md`.

## How the workspace uses them

The Cargo workspace depends on each fork as a git dependency pinned to a commit of its `sweetview` branch (`rev = "..."`). A fork change is committed and pushed to the fork first; then the pinned commit here moves. No path dependency and no machine-local path is committed.

## Additions

`SWEETVIEW-RESTART-PROPOSAL.md`, section "Fork additions, located", names the file and function for each.

`wry`:

1. Windows: streamed response bodies for custom protocols.
2. macOS: streamed response bodies for custom protocols.
3. macOS: drag routing for drags from other applications.
4. macOS: page messages accepted from the top-level document only.
5. macOS: a navigation-failed event.

`tray-icon`:

1. Windows: balloon notifications on the tray icon, with the click event.

Each addition is written in the style of the code around it, with its own test, so it can be offered upstream. Offering it upstream is an owner action.

## When a fork is missing

Run `git ls-remote` against each fork's URL (this repository's `origin` URL with the repository name replaced). A fork that does not answer is an input only the owner can supply: record it in `rust-rewrite/BLOCKED.md` and stop under R9.
