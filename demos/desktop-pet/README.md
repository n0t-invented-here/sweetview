# desktop-pet

A desktop pet: one of 24 animals from the Cube Pets pack, rendered with [Babylon.js](https://www.babylonjs.com/) in a borderless, see-through, always-on-top window.
It walks along the bottom edge of the monitor, over the taskbar or Dock, and can be picked up with the mouse.

It runs on Windows, with WebView2 in a popup window, and on macOS, with WKWebView in a borderless, non-opaque window.
It uses the webview library from the npm package `@n1h/sweetview-webview-bun`.

## What it does

| Feature | Behaviour |
|---|---|
| Animals | 24, picked at random at each launch. The tray's `Pet` submenu and the settings window switch the animal while running. |
| Moods | `idle`, `walk`, `run` and `dance` for every animal. `eat` is a pecking animation, so only the chick, the parrot and the penguin play it. |
| Edges | A walking or running pet turns around at the left and right edges of its monitor. |
| Pick up and drop | A press on the model picks it up. A press on a transparent spot does nothing. The pet plays its negative gesture while carried and falling, falls to the bottom edge when released, and plays its positive gesture on landing. |
| Several monitors | A pet dropped on another monitor lands on that monitor's bottom edge and walks there from then on. |
| Click-through | Clicks on the transparent parts of the window reach whatever is underneath. The cursor turns into a hand only over the model. With click-through off, the whole window takes clicks. |
| Focus | The pet window never takes focus and has no taskbar button, no Dock icon and no app-switcher entry. |
| Tray menu | `Settings…`, `Pet` (the 24 animals with their pictures), `Click through`, `Bring to front`, `Quit Pet`. Windows: a left click on the icon opens the settings window, a right click opens the menu. macOS: any click opens the menu. |
| Icons | The tray icon and the `Pet` item show the current animal. On Windows the settings window's icon does too. The executable and the `.app` bundle show the cat. The pictures are the pack's 64x64 previews, cropped to the animal. |
| Settings window | Opened from `Settings…`. It edits the animal and the three settings below. Every change applies at once and is saved. |
| Settings window frame | Frameless and see-through. The page draws the card, the title bar, the minimise, maximise and close buttons and eight resize handles. Dragging the title bar hands the move to the OS. Close hides the window. `PET_OS_FRAME=1` uses a dark OS frame instead. |
| Saved files | `settings.json` and `pet.log`, in `%APPDATA%\sweetview-pet\` on Windows and `~/Library/Application Support/sweetview-pet/` on macOS. |
| Fault reporting | Each fault is one timestamped line in `pet.log`. Faults are an error in the page (WebGL refused, a model that would not load, a failed start, an uncaught exception) and an uncaught exception on the UI thread, which also ends the app. The first fault is also shown as a notification. A tray icon with no pet beside it has its cause in `pet.log`. |

### Settings

| Setting | Range | Default | Effect |
|---|---|---|---|
| `bottom` | -2000 to 4000, whole numbers | 0 | Height of the pet above the bottom edge of the display, in CSS pixels, so the same visual distance on every monitor. Negative sinks it below the edge. |
| `scale` | 0.25 to 8, two decimals | 1 | Size of the model. The window and the click-through regions scale with it. |
| `clickThrough` | on, off | on | Clicks beside the pet reach the window underneath. Also toggled by the tray's `Click through` item. |

The animal is not saved. Out-of-range values in `settings.json` are clamped on load and on every change.

### Environment variables

| Variable | Effect |
|---|---|
| `WEBVIEW_DEBUG=1` | Devtools. The page prints its frame rate and the click-through accuracy to stdout every 2 seconds. |
| `PET=<name>` | Launches with that animal. Names are the entries of `PETS` in `pets.ts`, for example `cat`. |
| `PET_SETTINGS=1` | Opens the settings window at launch. |
| `PET_STILL=1` | Holds the rest pose and never changes mood, for testing click-through against a known picture. |
| `PET_OS_FRAME=1` | Hosts the settings page in a dark OS frame instead of the page-drawn one. |

## Files

| File | Role |
|---|---|
| `app.ts` | UI thread: the pet window, the settings window, their two webview apps, the tray, notifications, the settings file, `pet.log`, and every UI-thread method both pages call. |
| `app-worker.ts` | Worker entry. Hosts the service from `service.ts`. |
| `service.ts` | The contract between page, worker and UI thread: methods, events, types. The worker half picks the next mood. |
| `settings.ts` | The settings type, defaults, ranges, and `sanitize`, which clamps. |
| `pets.ts` | The 24 animals, their menu labels, their asset paths, and which are birds. |
| `pet-models.ts` | One file import per model and the shared texture, so `bun build --compile` embeds them. |
| `pet-previews.ts` | One file import per preview picture, for the icons. |
| `icon.ts` | The icons, made from the previews: the current animal for the tray and menu, the cat for the executable and the bundle. |
| `file-imports.d.ts` | Types for `.glb` and `.png` file imports. |
| `frontend/main.ts` | The pet page: the Babylon.js scene, the moods, falling, dragging, window positioning and click-through regions. |
| `frontend/config.ts` | `WINDOW_SIZE`: the window edge at scale 1, 192 window units. |
| `frontend/main.css` | The pet page's style. |
| `settings/main.tsx` | Settings page entry: the Mantine provider and the dark theme. |
| `settings/App.tsx` | The settings form: animal, bottom, scale, click-through. |
| `settings/Chrome.tsx` | The page-drawn window frame. |
| `settings/main.css` | The settings page's style. |
| `service.test.ts`, `settings.test.ts` | Tests for mood picking and for `sanitize`. |
| `scripts/write-icons.ts` | Writes `build/app.ico` and `build/AppIcon.icns`. Run by `just icons`. |
| `scripts/shot.ps1` | Windows. Screenshots the window and its surroundings: `-Title Pet -Out build/pet.png [-Margin 40]`. |
| `scripts/probe.ps1` | Windows. Real input: reports which window the OS hands a click to at solid and transparent spots, then drags the pet and reports where it landed. |
| `scripts/flicker.ps1` | Windows. Captures the window many times in a row and reports frame-to-frame change, so a blank or dropped frame shows as a spike. |
| `scripts/settings-probe.ps1` | Windows. Clicks the settings window's click-through switch twice and reports the settings file and the pet window's corners after each click. Run the app with `PET_SETTINGS=1`. |
| `scripts/menu-icon-probe.ts` | Windows. Opens the tray menu with every animal's icon at a screen point, for a screenshot. |
| `assets/kenney-cube-pets/` | The models, the shared texture, the previews and the pack's `License.txt`. |

## Recipes

Run `just <recipe>` in this folder or `just demos desktop-pet <recipe>` from the repo root.
The recipes need Bun, `just` and `pwsh`, which is the recipe shell on every OS.
No C++ toolchain is needed: `@n1h/sweetview-webview-bun` ships the webview library built.

| Recipe | Does | Output | Platform |
|---|---|---|---|
| `install` | `bun install` at the repo root. | `node_modules/` | any |
| `frontend` | Bundles and minifies the pet page (Babylon.js and the glTF loader included, about 3.8 MB) and the settings page (React and Mantine). | `build/frontend/`, `build/settings/` | any |
| `app` | `frontend`, then runs `app.ts` uncompiled. | none | Windows, macOS |
| `icons` | Writes the cat icon files. | `build/app.ico`, `build/AppIcon.icns` | any |
| `compile-win` | `frontend` and `icons`, then `bun build --compile` with the page, the worker, the models and the webview library embedded and no console window. | `dist/desktop-pet-windows-x64.exe` | any host. The file icon is embedded only on a Windows host; elsewhere the exe has the stock icon. |
| `compile-mac` | `frontend`, then `bun build --compile` for Apple silicon with the same files embedded. | `dist/desktop-pet-macos-arm64` | any host |
| `mac-app` | `icons`, then wraps the macOS binary in a bundle named `Pet` with the bundle id from the justfile and `AppIcon.icns`. | `dist/Pet.app` | any host. Needs `dist/desktop-pet-macos-arm64` from `compile-mac`. |
| `compile` | `frontend`, `compile-win`, `compile-mac`, `mac-app`. | `build/`, `dist/` | any host |
| `clean` | Removes `build/` and `dist/`. | none | any |

A change to the webview library reaches the pet through a new `@n1h/sweetview-webview-bun` release and a bump of that dependency.
[`webview/README.md`](../../webview/README.md) describes the release steps.
The icon limits of each build host are in the platforms table of [`README.md`](../../README.md#platforms).

## How it works

The worker picks the next mood at random, weighted per animal, when the page asks and every 9 seconds.
The page plays the matching animation, runs walking, falling and dragging, and calls `pet.move` with the window's new top-left on every frame the position changes.
`pet.move`, `pet.resize`, `screen.area` and `screen.at` are UI-thread methods in `app.ts` that act on the window directly ([`app.md`](../../docs/app.md#uimethods)).
Both pages share one method table and both receive the `settings.changed` and `pet.select` events, so the tray, the settings window and the pet agree.

Twenty times a second the page sends `hit.regions`: the convex hull of each mesh's projected bounding box.
Outside every hull the window passes clicks through at once.
Inside one, the native side sends `hit.probe`, the page answers with a triangle pick in `hit.answer`, and the window follows.
[`createHitRelay`](../../docs/native.md#createhitrelay) keeps the regions, the pending probe and the on/off switch.

The pet window is [`createOverlayWindow`](../../docs/native.md#createoverlaywindow) with `transparent: true`, created before the webview and passed to [`createWebviewApp`](../../docs/app.md#createwebviewapp) with the page and the models as assets.
The settings window is a second overlay and a second `createWebviewApp` with no worker; its frame uses [`windowChromeMethods`, `windowChromeControls` and `resizeHandles`](../../docs/window-chrome.md).
The settings file is a [`createSettingsStore`](../../docs/settings-store.md) store.
Serving the pages and the see-through background need `webview_set_asset` and `webview_set_background_color` ([`webview-library.md`](../../docs/webview-library.md)).

## macOS

- Window units are points. The page's scale is 1 and the canvas renders at the display's pixel ratio.
- The pet window sits at the status window level, above the Dock, on every Space.
- The app is an accessory app: no Dock icon, no Cmd+Tab entry. The menu bar item opens its menu on any click.
- Notifications need a bundle id, so the first-fault notification shows only when the app runs from `Pet.app`.
- Confirmed on a Mac: the transparent pet window with click-through, the menu bar item with its menu and icons, and the settings window.
- `Pet.app` is unsigned. On a Mac that calls a copied bundle damaged, these commands remove the quarantine flag, restore the executable bit and add an ad-hoc signature:

```bash
xattr -dr com.apple.quarantine "Pet.app" && chmod +x "Pet.app/Contents/MacOS/"* && codesign --sign - --force --deep "Pet.app"
```

## Assets

The animals are [Cube Pets by Kenney](https://kenney.nl/assets/cube-pets), CC0.
The pack's licence file is `assets/kenney-cube-pets/License.txt`.
