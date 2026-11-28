// The watchdog of timers-in-tray-menu.ts, on a thread of its own: a popup menu of the fixture's
// process still open 1.5 s after the fixture armed it is closed with Escape and counted, so a
// menu whose loop delivers no timer ends the round instead of holding the fixture.

import { VK, openPopupMenu, pressKeys } from "../win32-os";

declare const self: Worker;

self.onmessage = (event: MessageEvent<SharedArrayBuffer>) => {
  const flag = new Int32Array(event.data);
  setInterval(() => {
    const armedAt = Atomics.load(flag, 0);
    if (armedAt === 0 || (Date.now() & 0x3fffffff) - armedAt < 1500) return;
    const menu = openPopupMenu();
    if (menu === 0n) return;
    Atomics.add(flag, 1, 1);
    Atomics.store(flag, 0, 0);
    pressKeys(menu, VK.ESCAPE);
  }, 50);
};
