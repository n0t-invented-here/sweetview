# Files that import `bun:ffi` on `v1-rust-rewrite`

Generated with `git grep -l 'bun:ffi' -- packages demos`. This is the work list: the goal ends when none of these imports remain outside `rust-rewrite/ffi-allowlist.txt`.

| File | Lines | Platform | `new JSCallback` | `dlopen(` |
|---|---|---|---|---|
| `demos/desktop-pet/scripts/menu-icon-probe.ts` | 28 | both | 0 | 1 |
| `demos/native-tabs/scripts/mac-capture.ts` | 50 | macOS | 0 | 3 |
| `demos/native-tabs/scripts/win-capture.ts` | 105 | Windows | 0 | 2 |
| `demos/native-tabs/scripts/win-input.ts` | 119 | Windows | 0 | 1 |
| `demos/web-app/packages/web-app-frontend/src/WatchCard.tsx` | 196 | both | 0 | 0 |
| `packages/sweetview-build/src/build.ts` | 229 | both | 0 | 1 |
| `packages/sweetview-native/src/darwin/activation.test.ts` | 98 | macOS | 0 | 1 |
| `packages/sweetview-native/src/darwin/activation.ts` | 199 | macOS | 1 | 1 |
| `packages/sweetview-native/src/darwin/core-foundation.ts` | 29 | macOS | 0 | 2 |
| `packages/sweetview-native/src/darwin/event-loop.ts` | 104 | macOS | 0 | 1 |
| `packages/sweetview-native/src/darwin/folder-picker.ts` | 29 | macOS | 0 | 0 |
| `packages/sweetview-native/src/darwin/notifier.ts` | 242 | macOS | 0 | 0 |
| `packages/sweetview-native/src/darwin/objc.ts` | 280 | macOS | 3 | 5 |
| `packages/sweetview-native/src/darwin/window.ts` | 1073 | macOS | 5 | 0 |
| `packages/sweetview-native/src/types.ts` | 17 | both | 0 | 0 |
| `packages/sweetview-native/src/win32/activation.test.ts` | 177 | Windows | 0 | 0 |
| `packages/sweetview-native/src/win32/activation.ts` | 232 | Windows | 1 | 0 |
| `packages/sweetview-native/src/win32/api.ts` | 311 | Windows | 0 | 9 |
| `packages/sweetview-native/src/win32/clipboard.ts` | 77 | Windows | 0 | 0 |
| `packages/sweetview-native/src/win32/folder-picker.ts` | 123 | Windows | 0 | 0 |
| `packages/sweetview-native/src/win32/icon.ts` | 93 | Windows | 0 | 0 |
| `packages/sweetview-native/src/win32/message-window.ts` | 79 | Windows | 1 | 0 |
| `packages/sweetview-native/src/win32/notifier.test.ts` | 167 | Windows | 0 | 0 |
| `packages/sweetview-native/src/win32/screen.ts` | 131 | Windows | 1 | 0 |
| `packages/sweetview-native/src/win32/tab-window.ts` | 608 | Windows | 1 | 2 |
| `packages/sweetview-native/src/win32/win32.test.ts` | 215 | Windows | 0 | 1 |
| `packages/sweetview-native/src/win32/window.test.ts` | 420 | Windows | 0 | 1 |
| `packages/sweetview-native/src/win32/window.ts` | 1034 | Windows | 4 | 0 |
| `packages/sweetview-native/src/win32/winrt-toast.ts` | 398 | Windows | 0 | 2 |
| `packages/sweetview-settings/src/app-identity.ts` | 78 | both | 0 | 0 |
| `packages/sweetview/src/app.test.ts` | 587 | both | 2 | 4 |
| `packages/sweetview/src/app.ts` | 1056 | both | 3 | 0 |
| `packages/sweetview/src/index.ts` | 47 | both | 0 | 0 |
| `packages/sweetview/src/tabs/darwin-webview.ts` | 298 | macOS | 3 | 2 |
| `packages/sweetview/src/tabs/win-webview2.ts` | 415 | Windows | 4 | 1 |
| `packages/sweetview/src/webview-lib.ts` | 252 | both | 0 | 8 |
| `packages/sweetview/src/worker.ts` | 294 | both | 0 | 0 |
| `packages/sweetview/test/fixtures/webview-file-drop.darwin.ts` | 160 | macOS | 2 | 2 |
