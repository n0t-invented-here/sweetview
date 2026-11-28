# Overlays and hit regions

An overlay is a frameless, transparent, usually topmost window drawn over the
desktop: a desktop pet, a HUD, a floating widget. Transparency makes it look
shaped, but by default every pixel of its rectangle still takes clicks,
including the transparent ones. This page covers the tools that let clicks
fall through to whatever is behind the window. Part of the
[native module](../native.md); window basics are in
[Windows and screens](windows.md).

- [A minimal overlay](#a-minimal-overlay)
- [setClickThrough](#setclickthrough)
- [setHitRegions](#sethitregions)
- [HitRelay: exact shapes from the page](#hitrelay-exact-shapes-from-the-page)
- [Geometry helpers](#geometry-helpers)
- [colorKey vs transparent](#colorkey-vs-transparent)
- [Tabbed windows](#tabbed-windows)

## A minimal overlay

A frameless overlay has no close button and no taskbar entry, so this one
gets a tray icon whose Quit ends the loop.

```ts
import { Tray, Window, quitEventLoop, runEventLoop } from "@n1h/sweetview/native";

const overlay = new Window({
  frame: false,
  transparent: true,
  topmost: true,
  hideFromTaskbar: true,
  bounds: { x: 100, y: 100, width: 300, height: 300 },
});
// Only the 200 x 200 square in the middle takes clicks.
overlay.setHitRegions([[
  { x: 50, y: 50 }, { x: 250, y: 50 }, { x: 250, y: 250 }, { x: 50, y: 250 },
]]);
overlay.show();

new Tray({ tooltip: "Overlay", menu: [{ label: "Quit", click: () => quitEventLoop() }] });
await runEventLoop(); // after Quit the script ends; Sweetview removes the tray and the overlay
```

## setClickThrough

`setClickThrough(true)` makes the whole window ignore the mouse: every click,
hover and wheel event goes to the window underneath. `setClickThrough(false)`
restores normal hit testing. Either call clears any hit regions and stops
hit-region polling, so the two features never fight. Use it for a
display-only overlay, or as a "lock" toggle.

## setHitRegions

```ts
setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void
```

`setHitRegions` makes only the given polygons take clicks; outside every
polygon, clicks fall through. Polygons are in window-local units: physical
pixels on Windows and points on macOS, measured from the window's top-left
corner. Multiply page CSS pixels by `win.scale()` to convert. A polygon is
any simple polygon, either winding; a rectangle is four points.

| Argument | Effect |
|---|---|
| `[]` | No region takes clicks: the whole window is click-through, and polling keeps running so a later call can bring regions back. |
| `[poly, ...]` | Only those polygons take clicks. |
| `null` | Normal hit testing again; polling stops. |

How it works: neither OS can make a window take clicks in an arbitrary,
changing shape cheaply, so Sweetview polls. Every 10 ms it reads the cursor
position and switches the window's click-through state depending on whether
the cursor is inside a polygon. While any mouse button is held the state
freezes, so a drag that starts on the shape and leaves it keeps going.

The timers differ per platform:

- Windows: one `SetTimer` per `HWND`. It is killed by `setHitRegions(null)`,
  `setClickThrough`, `hide()` and `dispose()`, and restarts when a hidden
  window with regions is shown again.
- macOS: one shared 10 ms `NSTimer` serves every window with regions. It is
  invalidated and released as soon as no window has regions left, or the
  last one is disposed.

### Refining polygons

Polygons are coarse: a convex hull around a 3D model takes clicks in the gaps
between its arms. `refine` adds per-pixel or per-triangle precision:

```ts
type HitRefiner = (local: Point, answer: (solid: boolean) => void) => void;
```

When the cursor enters a polygon, the window starts taking clicks at once
(so a fast click is never lost) and calls `refine(localPoint, answer)`.
Whoever knows the exact shape, usually the page doing a raycast or an alpha
test, calls `answer(solid)`, and the window switches to click-through if the
point is not solid. `refine` can answer asynchronously; replies that arrive
after the cursor has moved on to a newer question are ignored. A `refine`
that never answers leaves plain polygon precision.

## HitRelay: exact shapes from the page

```ts
import { HitRelay, unpackRegions } from "@n1h/sweetview/native";
```

In a webview overlay, the page knows the shape, while the window lives on the
UI thread. `HitRelay` connects the two over IPC:

1. The page sends its polygons, flattened, through a UI-thread method.
2. When the cursor enters one, the relay sends the page a probe event
   `{ id, x, y }`.
3. The page answers through another UI-thread method with `{ id, solid }`.

Only the reply to the latest probe is applied; older replies are dropped,
which keeps a slow page from flipping the window back to a stale state.

The protocol, in a file both sides import:

```ts
// protocol.ts
export type Methods = {
  "window.scale": [void, number];
  "hit.regions": [number[], void];
  "hit.answer": [{ id: number; solid: boolean }, void];
};
export type Events = { "hit.probe": { id: number; x: number; y: number } };
```

The UI thread:

```ts
// host.ts
import { WebView } from "@n1h/sweetview";
import { HitRelay, Tray, Window, unpackRegions } from "@n1h/sweetview/native";
import type { Events, Methods } from "./protocol";
import page from "./pet.html";

const win = new Window({
  frame: false,
  transparent: true,
  topmost: true,
  hideFromTaskbar: true,
  bounds: { x: 100, y: 100, width: 200, height: 200 },
});
let view: WebView<Methods, Events> | undefined;
const relay = new HitRelay(win, (probe) => view?.emit("hit.probe", probe));

view = await WebView.attach<Methods, Events>(win, {
  page,
  uiMethods: {
    "window.scale": () => win.scale(),
    "hit.regions": (flat) => relay.setRegions(unpackRegions(flat)),
    "hit.answer": relay.answer,
  },
});

// The overlay has no close button: Quit ends run().
new Tray({ tooltip: "Pet", menu: [{ label: "Quit", click: () => view?.quit() }] });
win.show();
view.run(); // blocks until quit(); then the webview, the tray and the window are released
```

The page, `pet.html`, is minimal: a `#pet` element and the script.

```html
<!-- pet.html -->
<!doctype html>
<html>
  <body style="margin:0;background:transparent">
    <div id="pet" style="position:absolute;left:40px;top:40px;width:120px;height:120px;background:#f90"></div>
    <script type="module" src="./pet.ts"></script>
  </body>
</html>
```

Its script uses the browser-safe import path that loads no `bun:ffi`:

```ts
// pet.ts, loaded by pet.html
import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import { flattenRegions, type HitPolygon } from "@n1h/sweetview/native/hit-regions";
import type { Events, Methods } from "./protocol";

const bridge = createBridge<Methods, Events>(webviewTransport());

// Picking code: the pet is solid wherever the point is inside #pet's box.
// Swap in a raycast or a canvas alpha test for non-rectangular shapes.
const isSolidAt = (x: number, y: number): boolean => {
  const r = document.getElementById("pet")!.getBoundingClientRect();
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
};

const scale = await bridge.rpc("window.scale"); // a uiMethod returning win.scale()

const sendRegions = (cssPolygons: HitPolygon[]) =>
  bridge.rpc("hit.regions", flattenRegions(cssPolygons.map((p) => p.map(({ x, y }) => ({ x: x * scale, y: y * scale })))));

bridge.on("hit.probe", ({ id, x, y }) => {
  void bridge.rpc("hit.answer", { id, solid: isSolidAt(x / scale, y / scale) });
});

// Publish the first regions after the probe listener is installed, so the
// first probe they trigger already has a handler.
const box = document.getElementById("pet")!.getBoundingClientRect();
await sendRegions([[
  { x: box.left, y: box.top },
  { x: box.right, y: box.top },
  { x: box.right, y: box.bottom },
  { x: box.left, y: box.bottom },
]]);
```

The page works in CSS pixels and the window in window units, so the page
multiplies by `win.scale()` (fetched once through the `"window.scale"`
UI-thread method) on the way out and divides on the way back. Call
`sendRegions` again whenever the shape moves or changes. The `isSolidAt`
above is a bounding-box test; replace it with a raycast or a canvas alpha
test when the shape is not a rectangle.

| Member | Meaning |
|---|---|
| `new HitRelay(window, probe)` / `createHitRelay(window, probe)` | `window` is anything with `setHitRegions`; `probe(question)` sends `{ id, x, y }` to the page. |
| `setRegions(polygons)` | Stores the page's latest polygons and applies them when enabled. |
| `answer({ id, solid })` | The page's reply. An arrow property, so pass it straight into `uiMethods`. |
| `setEnabled(on)`, `isEnabled()` | Off makes the whole window take clicks again (`setHitRegions(null)`), whatever the regions say. Default on. |
| `apply()` | Sends the current state to the window again. |

## Geometry helpers

These are pure TypeScript, exported from `@n1h/sweetview/native` and from
`@n1h/sweetview/native/hit-regions`, which imports types only and is safe in
a page bundle.

| Function | Does |
|---|---|
| `flattenRegions(polygons)` | `HitPolygon[]` to one flat `number[]`: per polygon a point count, then x, y pairs. Its JSON is a fraction of the size of an array of point objects, which matters when a page sends regions every frame. |
| `unpackRegions(flat)` | The inverse, for the UI-thread method that receives them. |
| `convexHull(points)` | Andrew's monotone chain hull, counter-clockwise, without duplicates. Fewer than three distinct points come back as they are. Project a mesh's bounding-box corners and hull them for a cheap silhouette. |
| `packRegions(polygons)` | An `Int32Array` per polygon of `[count, minX, minY, maxX, maxY, x0, y0, ...]`, coordinates rounded. Polygons with fewer than three points are dropped. |
| `hitRegions(packed, x, y)` | Whether the point is inside any packed polygon: bounding box first, then even-odd ray casting. Allocation-free; hundreds of polygons cost microseconds. |

`HitPolygon` is `Point[]`; `HitProbe` is `Point & { id: number }`.

## colorKey vs transparent

There are two ways to get a non-rectangular window:

| | `transparent: true` | `colorKey: "#rrggbb"` |
|---|---|---|
| Platforms | Windows and macOS | Windows only |
| Mechanism | per-pixel alpha compositing | `WS_EX_LAYERED` with `SetLayeredWindowAttributes(LWA_COLORKEY)` |
| Edges | anti-aliased, semi-transparent pixels blend | 1-bit: a pixel of exactly that color is fully transparent, everything else fully opaque |
| Clicks on transparent pixels | still taken; add hit regions | fall through automatically |

`colorKey` punches out every pixel of one exact color, and Windows routes
clicks on punched-out pixels to the window behind with no polling. The price
is hard, aliased edges, and any anti-aliased fringe of that color shows as a
halo. macOS has no color-key windows; there `colorKey` logs
`sweetview: colorKey is Windows-only; use transparent on macOS` and is
ignored. For one code path on both platforms, use `transparent: true` with a
transparent page background and hit regions.

## Tabbed windows

`setClickThrough` and `setHitRegions` do nothing on a tabbed window
(`tabs: true`), and `transparent` and `colorKey` do not apply to one. A
tabbed window is OS-framed chrome: on Windows a framed window whose title bar
is a tab strip, on macOS an AppKit tab group made of several `NSWindow`s that
AppKit moves and swaps itself. Making parts of that click-through would make
the tab strip and the OS frame unreachable, and on macOS there is no single
native window to apply it to. For an overlay next to a tabbed app, create a
separate non-tabbed `Window` with `frame: false` and `transparent: true`.
