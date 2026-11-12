# webview

This folder is for working on the webview library itself.
The apps take the library from the npm package `@n1h/sweetview-webview-bun`; nothing here is needed to build or run them, and no library binary is kept in this repo.
The recipes clone the two forks into `webview-bun/`, which is git-ignored, and build, update and push them.

## Forks

| Repo | URL | Branch | Contents |
|---|---|---|---|
| webview | https://github.com/n0t-invented-here/sweetview-webview | `sweetview` | The C library at upstream `f1a9d6b`, plus `webview_set_background_color` and `webview_set_asset` in the C API. |
| webview-bun | https://github.com/n0t-invented-here/sweetview-webview-bun | `sweetview` | The Bun bindings, with the `webview` submodule pointing at the fork above. Its `build/` holds the built library for each platform. Published as `@n1h/sweetview-webview-bun`. |

The clone is `webview-bun/`, with the submodule at `webview-bun/webview/`.
`clone` uses the SSH URL of webview-bun, so it needs an SSH key the remote accepts.
Both repos are checked out on their branches, so commits can be made and pushed from them.
What the two C API additions do is in [`docs/webview-library.md`](../docs/webview-library.md).

## Recipes

Run `just webview <recipe>` from the repo root or `just <recipe>` in this folder.

| Recipe | Does | Skipped or refused when |
|---|---|---|
| `status` | Prints, for both repos, the branch, commit, ahead and behind counts against origin, changed files, and a shallow-clone note. Then whether webview-bun's submodule pointer matches the webview checkout, and whether the built library is current, stale or from uncommitted changes. | Not cloned: prints how to clone. |
| `clone` | Full clone of webview-bun on `sweetview` with its submodule, then puts the submodule on `sweetview`. Says when the submodule's branch is ahead of the commit webview-bun records. | Skipped when the clone exists. |
| `update` | Runs `clone`, fetches both repos, unshallows a shallow clone, and fast-forwards each. | Per repo, left alone and reported: fetch fails (offline), detached, changed files, no upstream, diverged from origin. Never resets. |
| `build` | Runs `clone`, builds the library for this OS into `webview-bun/webview/build/core/Release/`, stamps it with the webview commit in a `.commit` file beside it, and restores the fork's tracked binaries under `webview-bun/build/` that the macOS build overwrites. | Skipped when the stamp matches a clean checkout; with uncommitted changes it builds every time. Refused on any OS other than Windows and macOS. |
| `lib` | `update`, then `build`. | As `update` and `build`. |
| `push` | Pushes webview's branch, then webview-bun's, so webview-bun never points at an unpushed commit. Says when webview-bun still records an older webview commit. Uncommitted changes stay behind. | Refused when not cloned, when a repo is detached, or when a repo is behind origin. Skips a repo with nothing to push. |
| `clean` | Removes `webview-bun/`, with the build and any uncommitted changes. `clone` or `lib` brings it back. | Refused when either repo has unpushed commits. |

The built file is `webview.dll` on Windows and `libwebview.dylib` on macOS.

## Prerequisites

- All: `just`, git, `pwsh`, Bun.
- Windows build: Visual Studio 2022 Build Tools with the C++ workload, CMake, ninja. `build` finds Visual Studio with `vswhere`, enters its dev shell inside `pwsh`, and runs CMake with the Ninja Multi-Config generator. No `cmd` or `.bat` file is involved. CMake fetches the WebView2 SDK headers it needs.
- macOS build: the Xcode command line tools, CMake, ninja (`brew install cmake ninja`). `build` runs the fork's `bun scripts/build.ts`.

## Changing the library

1. Run `just webview status` to see where both repos stand, and `just webview update` when behind.
2. Edit in `webview-bun/webview/`. The two additions live in `core/include/webview/`: `api.h`, `c_api_impl.hh`, `detail/engine_base.hh` (the asset table), `detail/backends/win32_edge.hh`, `detail/backends/cocoa_webkit.hh`, and `detail/platform/windows/webview2/loader.hh` (an extra WebView2 interface ID).
3. Run `just webview build`. It builds the uncommitted tree.
4. Run an app against the build: set `WEBVIEW_PATH` to `webview-bun/webview/build/core/Release/webview.dll` or `libwebview.dylib` and run the app uncompiled, for example `just demos desktop-pet app`. The library is then loaded from that file instead of the npm package.
5. Commit in `webview-bun/webview/`, then commit the new submodule pointer in `webview-bun/` (`git add webview`). `status` says when the pointer is behind the checkout.
6. Run `just webview push`. It pushes webview first, then webview-bun.
7. In a checkout of the fork, run `just build` on each OS whose library changed. `webview-bun/` is such a checkout; the fork has its own justfile. `just build` there builds the library for that OS and copies it into the fork's `build/`, the folder the npm package ships. Commit those files in the fork and publish a new `@n1h/sweetview-webview-bun`.
8. In this repo, bump `@n1h/sweetview-webview-bun` to the new version in the root `package.json` (`peerDependencies` and `devDependencies`) and in `demos/desktop-pet/package.json`, `demos/web-app/package.json` and `demos/menubar-notify/package.json`, run `bun install`, and commit.
