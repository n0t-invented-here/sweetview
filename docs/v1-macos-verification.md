# Sweetview v1.0 macOS Verification Guide

This guide lists the exact commands and runtime checks to run on an Apple Silicon macOS host for branch `v1-drafting`. All Windows-side unit tests, TypeScript checks, cross-platform builds, and Windows GUI probes have already passed; this guide verifies the macOS AppKit / WKWebView / `UNUserNotificationCenter` runtime paths.

## 1. Automated test suite and build

Run from the repository root:

```bash
git fetch origin
git checkout v1-drafting
git pull --ff-only
bun install
just check
```

Expected:

- `tsc --noEmit` exits 0 across `src/` and `demos/`.
- `bun test` passes **including** the 2 macOS codesigning tests in `src/build.test.ts` (which are skipped on Windows).

Then compile all demos and sign the `.app` bundles natively on macOS:

```bash
just compile
```

Expected: `dist/` contains signed bundles `demos/web-app/dist/Web App.app`, `demos/desktop-pet/dist/Pet.app`, `demos/menubar-only/dist/Menubar Only.app`, and `demos/menubar-notify/dist/Menubar Notify.app`.

## 2. Automated native-tabs drive script

Run the macOS UI driver against the migrated `demos/native-tabs/app.ts` (which now uses built-in `createApp({ tabs: true })`, `WebView.openTab`, and `src/tabs/darwin-tabs.ts`):

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
import { sel, sendInt } from "./src/native/darwin/objc";

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
