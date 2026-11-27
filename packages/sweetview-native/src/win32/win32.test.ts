// Windows checks that show nothing on screen: no tray icon, no visible window.
// What Sweetview did is read back from the OS through test/win32-os.ts. They
// run only on Windows.

import { describe, expect, test } from "bun:test";
import { dotIco } from "../icon";
import type { MenuTemplate } from "../menu";

const probe = () => import("../../test/win32-os");

/** Shows `template` as a popup menu, reads it back from the OS while it is open, and closes it. */
async function popupAndRead(template: MenuTemplate) {
  const { binding } = await import("../binding");
  const { Menu } = await import("../menu");
  const { VK, menuOfWindow, openPopupMenu, ownWindow, pressKeys, readMenu } = await probe();
  type Shown = ReturnType<typeof readMenu>;
  const native = binding();
  const owner = ownWindow();
  let shown: Shown = [];
  const started = Date.now();
  const id = native.scheduleInterval(10, () => {
    const menuWindow = openPopupMenu();
    if (menuWindow !== 0n) {
      native.cancelTimeout(id);
      shown = readMenu(menuOfWindow(menuWindow));
      pressKeys(menuWindow, VK.ESCAPE);
    } else if (Date.now() - started > 5000) native.cancelTimeout(id);
  });
  try {
    Menu.popup(owner.hwnd, template, { x: 160, y: 160 });
  } finally {
    owner.destroy();
  }
  return shown;
}

/** The caption (ICON_SMALL) and taskbar (ICON_BIG) icons the OS holds for a window. */
async function windowIcons(hwnd: bigint): Promise<{ small: bigint; big: bigint }> {
  const { ICON_BIG, ICON_SMALL, WM_GETICON, user32 } = await probe();
  return { small: BigInt.asUintN(64, user32.SendMessageW(hwnd, WM_GETICON, ICON_SMALL, 0n)), big: BigInt.asUintN(64, user32.SendMessageW(hwnd, WM_GETICON, ICON_BIG, 0n)) };
}

const onWindows = process.platform === "win32";

describe.if(onWindows)("win32 OS state", () => {
  test("a generated .ico becomes the window's small and 32px big icon", async () => {
    const { Window } = await import("../window");
    const win = new Window({ title: "win32.test icon" });
    try {
      win.setIcon({ windows: { ico: dotIco({ sizes: [16, 32] }) } });
      const icons = await windowIcons(BigInt(win.handle!));
      expect(icons.small).not.toBe(0n); // 0 would mean the OS took no icon from the .ico
      expect(icons.big).not.toBe(0n);
    } finally {
      win.dispose();
    }
  });

  test("Window.fromHandle onClose swallows WM_CLOSE and the window survives", async () => {
    const { Window } = await import("../window");
    const { ownWindow, user32, WM_CLOSE } = await probe();
    const win = ownWindow();
    const wrapped = Window.fromHandle(win.hwnd);
    let closeRequests = 0;
    const restore = wrapped.onClose(() => closeRequests++);
    user32.SendMessageW(win.hwnd, WM_CLOSE, 0n, 0n);
    expect(closeRequests).toBe(1);
    expect(user32.IsWindow(win.hwnd)).not.toBe(0);
    restore();
    user32.SendMessageW(win.hwnd, WM_CLOSE, 0n, 0n);
    expect(closeRequests).toBe(1); // default chain again (the window's own procedure ignores WM_CLOSE)
    wrapped.dispose();
    win.destroy();
  });

  test("Screen.at: a point on the primary monitor maps to its rect, a point off every monitor to the nearest", async () => {
    const { Screen } = await import("../screen");
    const { SM_CXSCREEN, SM_CYSCREEN, user32 } = await probe();
    const width = user32.GetSystemMetrics(SM_CXSCREEN);
    const height = user32.GetSystemMetrics(SM_CYSCREEN);
    expect(Screen.at({ x: Math.floor(width / 2), y: Math.floor(height / 2) }).bounds).toEqual({ x: 0, y: 0, width, height });
    // Far above every monitor: the nearest one answers, and it is a real monitor.
    const nearest = Screen.at({ x: Math.floor(width / 2), y: -100000 }).bounds;
    expect(nearest.width).toBeGreaterThan(0);
    expect(nearest.height).toBeGreaterThan(0);
  });

  test("discardQuit takes a PostQuitMessage back, after dispatching what was waiting ahead of it", async () => {
    const { discardQuit, pumpEvents } = await import("./event-loop");
    const { ownWindow, user32, WM_APP } = await probe();
    const seen: number[] = [];
    const win = ownWindow((message) => seen.push(message));
    try {
      user32.PostMessageW(win.hwnd, WM_APP + 21, 0n, 0n);
      user32.PostQuitMessage(0);
      discardQuit();
      expect(seen).toContain(WM_APP + 21); // WM_QUIT only comes out once nothing posted is left
      expect(pumpEvents()).toBe(true); // false would be the loop ending
      discardQuit(); // nothing asked for, nothing waiting: returns at once
      expect(pumpEvents()).toBe(true);
    } finally {
      win.destroy();
    }
  });

  test("a literal ampersand in a menu label is doubled, so the OS shows it instead of an access key", async () => {
    const shown = await popupAndRead([{ label: "Fish & Chips" }]);
    expect(shown[0]!.label).toBe("Fish && Chips");
  });
});

describe.if(onWindows)("win32 icons", () => {
  test("a menu icon decodes at the asked size from a larger .ico image (the resample path)", async () => {
    const { binding } = await import("../binding");
    const rgba = binding().decodeIcon({ ico: dotIco({ color: "#ff0000", sizes: [32] }) }, 16)!; // 32 -> 16
    expect(rgba.length).toBe(16 * 16 * 4);
    const centre = (8 * 16 + 8) * 4;
    expect([...rgba.subarray(centre, centre + 4)]).toEqual([255, 0, 0, 255]);
  });

  test("a menu with an icon builds and the bitmap is set on the item", async () => {
    const shown = await popupAndRead([{ label: "With icon", icon: { windows: { ico: dotIco() } } }]);
    expect(shown[0]).toMatchObject({ label: "With icon", hasBitmap: true });
  });

  test("setIcon on an application's own window replaces its icons, and back to the stock icon", async () => {
    const { Window } = await import("../window");
    const { ownWindow } = await probe();
    const own = ownWindow();
    const wrapped = Window.fromHandle(own.hwnd);
    try {
      wrapped.setIcon({ windows: { ico: dotIco() } });
      const first = await windowIcons(own.hwnd);
      expect(first.small).not.toBe(0n);
      expect(first.big).not.toBe(0n);
      wrapped.setIcon({ windows: { ico: dotIco({ color: "#00ff00" }) } }); // frees the first pair
      const second = await windowIcons(own.hwnd);
      expect(second.small).not.toBe(0n);
      expect(second.small).not.toBe(first.small);
      wrapped.setIcon(undefined); // back to stock
      const stock = await windowIcons(own.hwnd);
      expect(stock.small).not.toBe(second.small);
    } finally {
      wrapped.dispose();
      own.destroy();
    }
  });

  test("menus handle submenus, separators, checkmarks, and icons, and each showing frees what it made", async () => {
    const { menuData } = await import("./menu");
    const { guiObjects } = await probe();
    const template: MenuTemplate = [
      { label: "One", checked: true, icon: { windows: { ico: dotIco() } }, click: () => {} },
      { type: "separator" },
      { type: "submenu", label: "Sub", submenu: [{ label: "Child", enabled: false }] },
    ];
    expect(menuData(template).handlers.size).toBe(2);
    const shown = await popupAndRead(template);
    expect(shown[0]).toMatchObject({ label: "One", checked: true, hasBitmap: true });
    expect(shown[1]!.separator).toBe(true);
    expect(shown[2]!.submenu?.[0]).toMatchObject({ label: "Child", disabled: true });
    // Built fresh for each showing and released after it: the process's GDI and USER objects return to where they were.
    const before = guiObjects();
    for (let i = 0; i < 10; i++) await popupAndRead(template);
    const after = guiObjects();
    expect(after.gdi).toBeLessThanOrEqual(before.gdi);
    expect(after.user).toBeLessThanOrEqual(before.user);
  });

  test("Screen.of(hwnd) resolves the monitor hosting an application's own window", async () => {
    const { Screen } = await import("../screen");
    const { ownWindow } = await probe();
    const win = ownWindow();
    try {
      const info = Screen.of(win.hwnd);
      expect(info.bounds.width).toBeGreaterThan(0);
      expect(info.workArea.width).toBeGreaterThan(0);
      expect(info.scale).toBeGreaterThan(0);
    } finally {
      win.destroy();
    }
  });
});
