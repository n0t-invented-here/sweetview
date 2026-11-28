// What lies behind the window quit-flash.ts shows, made known (decision D49): a frameless,
// topmost window of a colour no window of the fixture paints (magenta), covering more than the
// fixture's window, in a process of its own, so it stays while the fixture's process ends. The
// fixture's window, topmost too and shown after it, is above it. A read of the screen that shows
// magenta where the fixture's window was shows this window, not the fixture's; one that shows
// any other colour there shows the fixture's. It prints `READY` once it is on the screen and
// runs until its parent ends it (by its process id). It injects no input. The parent is
// src/quit-flash.test.ts.

import { runEventLoop } from "@n1h/sweetview";
import { Screen, Window } from "@n1h/sweetview/native";

/** The backstop's colour, as `#rrggbb`. */
export const BACKSTOP = "#ff00ff";

/** The backstop's rectangle: from (100, 80), 900 by 720 DIPs at the primary display's scale. */
function backstopBounds() {
  const scale = Screen.primary().scale;
  return { x: 100, y: 80, width: Math.round(900 * scale), height: Math.round(720 * scale) };
}

if (import.meta.main) {
  const win = new Window({
    title: "quit-flash backstop",
    frame: false,
    topmost: true,
    noActivate: true,
    hideFromTaskbar: true,
    backgroundColor: BACKSTOP,
    // Wide enough for the fixture's window at any display scale: a tabbed window's minimum size
    // is in DIPs, so it grows with the scale; the watcher checks the window lies inside.
    bounds: backstopBounds(),
  });
  const loop = runEventLoop({ intervalMs: 5 });
  win.show();
  // On the screen, its own opening transition done, before the parent goes on; its rectangle for the watcher.
  setTimeout(() => {
    const b = win.bounds();
    console.log(`READY ${b.x},${b.y},${b.width},${b.height}`);
  }, 500);
  await loop;
}
