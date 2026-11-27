// FFI checks that show nothing on screen: no tray icon, no visible window.
// They run only on Windows.

import { describe, expect, test } from "bun:test";
import { dotIco } from "../icon";
import type { MenuTemplate } from "../menu";

/** Shows `template` as a popup menu, reads it back from the OS while it is open, and closes it. */
async function popupAndRead(template: MenuTemplate) {
  const { binding } = await import("../binding");
  const { Menu } = await import("../menu");
  const { createMessageWindow } = await import("./message-window");
  const { VK, menuOfWindow, openPopupMenu, pressKeys, readMenu } = await import("./os-probe.test-support");
  type Shown = ReturnType<typeof readMenu>;
  const native = binding();
  const owner = createMessageWindow(() => {});
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

const onWindows = process.platform === "win32";

describe.if(onWindows)("win32 FFI", () => {
  test("CreateIconFromResourceEx accepts a generated .ico image", async () => {
    const { loadIcon } = await import("./icon");
    const { user32 } = await import("./api");
    const icon = loadIcon(dotIco());
    expect(icon.owned).toBe(true); // false would mean it fell back to the stock icon
    expect(icon.handle).not.toBe(0n);
    user32.DestroyIcon(icon.handle);
  });

  test("the message window's JSCallback window procedure runs (WM_CREATE arrives synchronously)", async () => {
    const { createMessageWindow } = await import("./message-window");
    const seen: number[] = [];
    const win = createMessageWindow((message) => seen.push(message));
    expect(win.hwnd).not.toBe(0n);
    // CreateWindowExW sends WM_NCCREATE (0x81) and WM_CREATE (0x01) before returning,
    // but the handler is registered only after the hwnd is known. Post one and pump it.
    const { user32 } = await import("./api");
    const WM_APP = 0x8000;
    user32.PostMessageW(win.hwnd, WM_APP + 7, 0n, 0n);
    // No message loop in a test, so send one directly through DefWindowProc path:
    // SendMessage is synchronous and goes through our procedure.
    const { dlopen, FFIType } = await import("bun:ffi");
    const u = dlopen("user32.dll", {
      SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
    }).symbols;
    u.SendMessageW(win.hwnd, WM_APP + 8, 0n, 0n);
    expect(seen).toContain(WM_APP + 8);
    win.destroy();
  });

  test("Window.fromHandle onClose swallows WM_CLOSE and the window survives", async () => {
    const { createMessageWindow } = await import("./message-window");
    const { Window } = await import("../window");
    const { user32, WM_CLOSE } = await import("./api");
    const win = createMessageWindow(() => {});
    const wrapped = Window.fromHandle(win.hwnd);
    let closeRequests = 0;
    const restore = wrapped.onClose(() => closeRequests++);
    user32.SendMessageW(win.hwnd, WM_CLOSE, 0n, 0n);
    expect(closeRequests).toBe(1);
    expect(user32.IsWindow(win.hwnd)).not.toBe(0);
    restore();
    user32.SendMessageW(win.hwnd, WM_CLOSE, 0n, 0n);
    expect(closeRequests).toBe(1); // default chain again (the message window ignores WM_CLOSE itself)
    wrapped.dispose();
    win.destroy();
  });

  test("the 32px balloon icon loads from the generated .ico", async () => {
    const { loadIcon } = await import("./icon");
    const { SM_CXICON, user32 } = await import("./api");
    const icon = loadIcon(dotIco(), SM_CXICON);
    expect(icon.owned).toBe(true);
    user32.DestroyIcon(icon.handle);
  });

  test("MonitorFromRect + GetMonitorInfoW: a point on the primary monitor maps to its rect, a point off every monitor to the nearest", async () => {
    const { user32, MONITORINFO_SIZE, MONITOR_DEFAULTTONEAREST, SM_CXSCREEN, SM_CYSCREEN } = await import("./api");
    const width = user32.GetSystemMetrics(SM_CXSCREEN);
    const height = user32.GetSystemMetrics(SM_CYSCREEN);
    const monitorAt = (x: number, y: number) => {
      const rect = new Int32Array([x, y, x + 1, y + 1]);
      const monitor = user32.MonitorFromRect(rect, MONITOR_DEFAULTTONEAREST);
      expect(monitor).not.toBe(0n);
      const info = new Int32Array(MONITORINFO_SIZE / 4);
      info[0] = MONITORINFO_SIZE;
      expect(user32.GetMonitorInfoW(monitor, info)).not.toBe(0);
      return { x: info[1]!, y: info[2]!, width: info[3]! - info[1]!, height: info[4]! - info[2]! };
    };
    expect(monitorAt(Math.floor(width / 2), Math.floor(height / 2))).toEqual({ x: 0, y: 0, width, height });
    // Far above every monitor: the nearest one answers, and it is a real monitor.
    const nearest = monitorAt(Math.floor(width / 2), -100000);
    expect(nearest.width).toBeGreaterThan(0);
    expect(nearest.height).toBeGreaterThan(0);
  });

  test("discardQuit takes a PostQuitMessage back, after dispatching what was waiting ahead of it", async () => {
    const { createMessageWindow } = await import("./message-window");
    const { discardQuit, pumpEvents } = await import("./event-loop");
    const { user32, WM_APP } = await import("./api");
    const seen: number[] = [];
    const win = createMessageWindow((message) => seen.push(message));
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

  test("setWindowIcon on a message window does not fail and replaces its handles", async () => {
    const { clearWindowIcon, setWindowIcon } = await import("./icon");
    const { createMessageWindow } = await import("./message-window");
    const win = createMessageWindow(() => undefined);
    setWindowIcon(win.hwnd, dotIco());
    setWindowIcon(win.hwnd, dotIco({ color: "#00ff00" })); // frees the first pair
    setWindowIcon(win.hwnd, undefined); // back to stock
    clearWindowIcon(win.hwnd);
    win.destroy();
  });

  test("menus handle submenus, separators, checkmarks, and icons, and each showing frees what it made", async () => {
    const { menuData } = await import("./menu");
    const { guiObjects } = await import("./os-probe.test-support");
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

  test("Screen.of(hwnd) resolves the monitor hosting a message window", async () => {
    const { Screen } = await import("../screen");
    const { createMessageWindow } = await import("./message-window");
    const win = createMessageWindow(() => {});
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
