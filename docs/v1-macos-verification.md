# Sweetview 1.0.0 verification on macOS and Linux

Use `v1-drafting` in `n0t-invented-here/sweetview` and
`n0t-invented-here/sweetview-webview-bun`. The latter pins the matching C++
revision from `n0t-invented-here/sweetview-webview` through its `webview`
submodule. Place the two working repositories side by side for these commands.

## 0. Build and test the native library

Install Bun 1.4.2+, PowerShell 7 (`pwsh`), `just`, CMake and Ninja. On macOS
also install Xcode Command Line Tools with `xcode-select --install`. On Linux
x64 install Clang, `pkg-config`, GTK 4 and WebKitGTK 6.0 development headers
(for example, `clang pkg-config libgtk-4-dev libwebkitgtk-6.0-dev` on Debian
or Ubuntu).

From the bindings repository:

```bash
git switch v1-drafting
git pull --ff-only
git submodule update --init --recursive
bun install
just build
```

Confirm the build reports the expected native binary, then export its path
in the same shell before running the tests:

```bash
# macOS
export WEBVIEW_PATH="$PWD/build/libwebview.dylib"
test -f "$WEBVIEW_PATH"
nm -gU "$WEBVIEW_PATH" | grep -E 'webview_(set_request_handler|complete_request|set_allow_external_drop)$'

# Linux x64 (use these commands in place of the macOS commands)
export WEBVIEW_PATH="$PWD/build/libwebview-x64.so"
test -f "$WEBVIEW_PATH"
nm -D --defined-only "$WEBVIEW_PATH" | grep -E 'webview_(set_request_handler|complete_request|set_allow_external_drop)$'
```

Check that all three symbols appear. Run the bindings tests from that same folder:

```bash
bun test
bun test test/request-handler.test.ts
cd ../sweetview
```

Run the macOS live tests from an interactive desktop session. Confirm the
request test serves static assets, dynamic HTML, a POST body and an image,
and that the frames origin is isolated. Linux verifies the library exports.
The bindings' desktop request probe skips there because the GTK backend
does not serve the custom origins.

## 1. Automated test suite and build

Run from the repository root:

```bash
git fetch origin
git switch v1-drafting
git pull --ff-only
bun install
just check
```

Expected:

- `tsc --noEmit` exits 0 across `packages/` and `demos/`.
- On macOS, the codesigning tests in `packages/sweetview-build/src/build.test.ts`
  and the `CFMessagePort` handoff test run. Linux skips desktop-only
  cases and runs the portable tests.

Then compile all demos and sign the `.app` bundles natively on macOS:

```bash
just compile
just pack
```

On macOS, confirm the demo `.app` bundles are signed. Linux builds unsigned
bundles for the target platform. Confirm dry-run packs for all six packages.

## 2. Automated native-tabs drive script

Run this on macOS in a desktop session. Linux has no Sweetview native
window backend and skips this GUI driver.

```bash
just demos native-tabs drive
```

Expected:

- Every check line prints `ok` and ends with `PASS`:
  - Window stays hidden until `app.window.show()`, then becomes visible.
  - Renaming tab 1 leaves tab 2's title independent.
  - Responder-chain `newWindowForTab:` (the AppKit `+` / `Cmd+T` action) opens a 3rd tab.
  - Unreachable site tab (`http://127.0.0.1:1`) triggers the load-error fallback without crashing.
  - `app.window.setBounds(...)` fires `app.window.onResize`.
  - `moveToNewWindow()` isolates the tab into a 1-tab window group and `mergeAllWindows()` recombines all tabs into one group.
  - Closing every tab down to 0 exits the event loop cleanly without crashes or use-after-free.
- `demos/native-tabs/build/drive/tabs-initial.png` is written via `captureWindow`. Visually inspect it to confirm the native AppKit tab bar renders cleanly.

## 3. Targeted macOS v1 audit regression checks

Run a short inline Bun script (or interactive check) for each macOS audit fix:

### 3.1 Window outer-frame bounds, flags on framed windows, and `startResize` (Audit 2.3)

```bash
bun -e '
import { Window, Screen, runEventLoop, quitEventLoop } from "@n1h/sweetview/native";

const want = { x: 180, y: 160, width: 520, height: 380 };
const framed = new Window({ title: "Bounds Check", bounds: want, frame: true, topmost: true, opacity: 0.9 });
const b1 = framed.bounds();
console.log("framed bounds:", b1);
if (Math.abs(b1.width - want.width) > 2 || Math.abs(b1.height - want.height) > 2) {
  throw new Error(`framed outer bounds mismatch: got ${JSON.stringify(b1)}, expected ${JSON.stringify(want)}`);
}
framed.setBounds({ x: 200, y: 180, width: 560, height: 400 });
const b2 = framed.bounds();
console.log("after setBounds:", b2);
console.log("screens:", Screen.all().length, "primary:", Screen.primary(), "of(framed):", Screen.of(framed), "cursor:", Screen.cursor());
framed.show();
setTimeout(() => { framed.dispose(); quitEventLoop(); }, 500);
await runEventLoop();
'
```

Also verify a frameless `Window({ frame: false })` stays borderless (`styleMask === 0`) after `WebView.attach` (our `sweetview-webview` fork patches `webview_set_size` to be a no-op for caller-provided `NSWindow`s):

```bash
bun -e '
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { sel, sendInt } from "./packages/sweetview-native/src/darwin/objc";

const frameless = new Window({ frame: false, transparent: true, bounds: { x: 200, y: 200, width: 320, height: 240 } });
const view = await WebView.attach(frameless, { url: "about:blank" });
const mask = BigInt(sendInt(BigInt(frameless.handle as bigint), sel("styleMask")) ?? 0);
console.log("frameless styleMask after attach:", mask, "bounds:", frameless.bounds());
if (mask !== 0n) throw new Error(`expected borderless styleMask 0n, got ${mask}`);
view.dispose();
frameless.dispose();
'
```

Also launch `demos/desktop-pet` with the settings window open and test dragging its frameless resize handles on macOS:

```bash
PET_SETTINGS=1 just demos desktop-pet app
```

Verify:

- Dragging any edge or corner of the frameless Settings window resizes it smoothly (`startResize` 10 ms loop, Audit 2.3).
- Clicking the Settings close button hides the window without quitting the pet.
- Hovering around the pet clicks through transparent space and captures clicks over the 3D model.
- Toggling `Click through` off in the tray menu disables the 10 ms `NSTimer` (Audit 2.7: CPU usage drops to near 0% in Activity Monitor when click-through is off).

### 3.2 `Window.onClose` interception on `Cmd+W`, red close button, and frameless windows (Audit 2.9 & 2.1)

```bash
bun -e '
import { Window, runEventLoop, quitEventLoop } from "@n1h/sweetview/native";

let intercepted = 0;
const w1 = new Window({ title: "Close Intercept", frame: true, bounds: { x: 150, y: 150, width: 420, height: 260 } });
w1.onClose(() => { intercepted++; w1.hide(); });
const w2 = new Window({ title: "Frameless Intercept", frame: false, bounds: { x: 600, y: 150, width: 320, height: 220 } });
w2.onClose(() => { intercepted++; w2.hide(); });
const w3 = new Window({ title: "Auto Dispose", frame: true, bounds: { x: 150, y: 450, width: 320, height: 200 } });
w1.show(); w2.show(); w3.show();
console.log("Press Cmd+W or click red close on Close Intercept (should hide, not quit), then close Auto Dispose (should close without quitting). Ctrl+C to finish.");
process.on("SIGINT", () => { w1.dispose(); w2.dispose(); w3.dispose(); quitEventLoop(); });
await runEventLoop();
console.log("intercepted count:", intercepted);
'
```

Verify:

- Clicking the red close button OR pressing `Cmd+W` on `Close Intercept` increments `intercepted` and hides the window without crashing or ending the loop.
- Closing `Auto Dispose` (no `onClose` listener) closes and disposes that window while keeping the event loop alive.
- Double-calling `dispose()` is a safe no-op.

### 3.3 `Menu.popup` native context menu (Audit 2.10)

```bash
bun -e '
import { Window, Menu, runEventLoop, quitEventLoop } from "@n1h/sweetview/native";

const w = new Window({ title: "Menu Test", bounds: { x: 200, y: 200, width: 400, height: 300 } });
w.show();
setTimeout(() => {
  const picked = Menu.popup(w, [
    { label: "Pick Me", click: () => console.log("clicked Pick Me") },
    { type: "separator" },
    { label: "Disabled", enabled: false },
  ]);
  console.log("picked:", picked);
  w.dispose();
  quitEventLoop();
}, 300);
await runEventLoop();
'
```

Verify a native macOS context menu pops up at the cursor, clicking `Pick Me` logs `clicked Pick Me` and `picked: true`, and pressing `Esc` logs `picked: false`.

### 3.4 Eager `UNUserNotificationCenter` delegate and ObjC target reuse (Audit 2.5)

1. Run `just demos menubar-notify open` (launches signed `dist/Menubar Notify.app`).
2. Grant notification permission when prompted.
3. Click **Notify in 5 Seconds**, then quit the app before 5 seconds or let it fire and click the notification banner:
   - Clicking a notification while running brings the History window to front and logs the clicked `id` and `data`.
   - Clicking a delivered notification from Notification Center when the app is closed launches `Menubar Notify.app` and delivers the click via the eagerly registered delegate (before any new `notify()` call).
4. Verify repeated `new Notifier()`, `new Tray()`, and `setAppMenu()` calls do not crash or leak dynamic ObjC classes:

```bash
bun -e '
import { Notifier, Tray, setAppMenu } from "@n1h/sweetview/native";
for (let i = 0; i < 20; i++) {
  const n = new Notifier({ onClick: () => {} });
  n.dispose();
  const t = new Tray({ tooltip: `t-${i}` });
  t.dispose();
  setAppMenu({ appName: "Test", aboutText: `v${i}` });
}
console.log("20 cycles OK");
'
```

### 3.5 Remaining demos smoke test

Launch and exercise each compiled `.app` bundle on macOS:

- `open "demos/web-app/dist/Web App.app"` — verify window renders, IPC counter/notes work, tray menu toggles visibility, and `Cmd+Q` / Quit menu exits cleanly.
- `open "demos/menubar-only/dist/Menubar Only.app"` — verify status bar item appears with no Dock icon, tooltip updates every second, and Quit exits cleanly.
- `open "demos/desktop-pet/dist/Pet.app"` — verify transparent 3D pet walks above the Dock, click-through works, Settings window opens/resizes, and Quit exits cleanly.

## 4. macOS activation, startup and request routes

With the rebuilt `WEBVIEW_PATH` still set, run:

```bash
bun test packages/sweetview-native/src/darwin/activation.test.ts
bun test packages/sweetview/src/app.test.ts -t 'desktop startup & deferred RPC'
bun test packages/sweetview/src/request-handler.test.ts
```

Confirm the child launch reaches the primary through `CFMessagePort`. The
startup tests exercise the `NSTimer` watchdog under both event-loop modes,
the page ready handshake and `deferredUiMethods` without RPC reentry. The
request tests should load worker HTML and an image, echo a POST, verify a 20 KiB response
with a 4 KiB ring, and block access to iframe DOM at
`webview-frames://localhost`.

For a Finder and Launch Services probe, save the following as
`v1-native-probe.ts` in the Sweetview repository root:

```ts
import {
  Clipboard, Window, closeToTrayOnLastWindow, defineAppIdentity, onOpenUrl,
  runEventLoop, signalReady, singleInstance,
} from "@n1h/sweetview/native";

const identity = defineAppIdentity({
  appId: "dev.sweetview.v1-native-probe",
  appName: "Sweetview Native Probe",
  urlSchemes: ["sweetview-v1-probe"],
});
onOpenUrl((url) => console.log("open URL", url));
const lock = await singleInstance({ identity, onSecondInstance: (event) => console.log("handoff", event) });
if (!lock.isPrimary) process.exit(lock.handedOff ? 0 : 1);

const text = "Sweetview clipboard 🐈";
Clipboard.writeText(text);
if (Clipboard.readText() !== text) throw new Error("Clipboard round-trip failed");
Clipboard.clear();
if (Clipboard.readText() !== null) throw new Error("Clipboard clear failed");
console.log("clipboard OK");

const primary = new Window({ title: "Drop Finder files here", bounds: { x: 180, y: 180, width: 450, height: 320 } });
const secondary = new Window({ title: "Close this first", bounds: { x: 650, y: 180, width: 300, height: 240 } });
primary.onFileDrop((paths) => console.log("Finder paths", paths));
closeToTrayOnLastWindow(primary, () => console.log("last window hidden", Window.visibleWindows().length));
closeToTrayOnLastWindow(secondary);
primary.show();
secondary.show();
signalReady();
await runEventLoop();
lock.dispose();
```

Compile and bundle it from the repository root. This probe replaces the
clipboard contents while running.

```bash
mkdir -p v1-native-probe-build
bun build --compile v1-native-probe.ts --outfile v1-native-probe-build/probe
bun packages/sweetview-build/src/make-app.ts --name "Sweetview Native Probe" \
  --bundle-id dev.sweetview.v1-native-probe --url-scheme sweetview-v1-probe \
  --binary v1-native-probe-build/probe --out v1-native-probe-build
app="v1-native-probe-build/Sweetview Native Probe.app"
open "$app"
```

Quit the first instance after Launch Services registers the bundle. Run
`"$app/Contents/MacOS/probe"` in one terminal to see its logs. In a second
terminal call `open 'sweetview-v1-probe://verify/apple-event'` and confirm
the primary prints `open URL`. Launch the bundle executable directly again
with `'sweetview-v1-probe://verify/second-instance'` and confirm the primary
logs both the handoff and the URL while the secondary exits.

Drag multiple files with spaces or Unicode names from Finder onto the primary
window. Confirm logged paths name real files, including when Finder supplies
a file-reference URL. Close the secondary window first. It should disappear
without a hide callback. Close the primary. It should hide and log
`last window hidden 0`, with the process still running. Quit the probe after
recording the results.

### Drop over WKWebView

Use the native-only Finder drop above as a baseline. With the rebuilt
`WEBVIEW_PATH` set, save this as `v1-webview-drop-probe.ts` in the repository
root and run `bun run v1-webview-drop-probe.ts`:

```ts
import { createApp } from "@n1h/sweetview";

const app = await createApp({
  title: "WKWebView file drop probe",
  assets: {
    "index.html": new Blob([`<!doctype html>
      <p>Drop a Finder file in this page</p>
      <output id="result">Waiting for a page drop</output>
      <script>
        window.addEventListener("dragover", (event) => event.preventDefault());
        window.addEventListener("drop", (event) => {
          event.preventDefault();
          const names = Array.from(event.dataTransfer.files, (file) => file.name);
          document.getElementById("result").textContent = "Page drop: " + names.join(", ");
        });
      </script>`], { type: "text/html" }),
  },
});

app.window.onFileDrop((paths) => console.log("Native window drop", paths));
app.window.show();
await app.run();
```

Drag the same files from Finder onto the middle of the rendered page, where
WKWebView covers the window. Record whether the page shows `Page drop`,
the terminal prints `Native window drop`, both occur, or neither occurs.
Check any native paths against the baseline. `Window.onFileDrop` observes
the `NSWindow` drag destination, and WKWebView has its own drop target.
`allowExternalDrop: false` controls WebView2 on Windows and has no effect
on this macOS probe.
