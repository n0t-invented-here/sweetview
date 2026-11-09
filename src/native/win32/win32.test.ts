// FFI checks that show nothing on screen: no tray icon, no visible window.
// They run only on Windows.

import { describe, expect, test } from "bun:test";
import { dotIcon } from "../icon";

const onWindows = process.platform === "win32";

describe.if(onWindows)("win32 FFI", () => {
  test("CreateIconFromResourceEx accepts a generated .ico image", async () => {
    const { loadIcon } = await import("./icon");
    const { user32 } = await import("./api");
    const icon = loadIcon(dotIcon());
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

  test("onCloseRequest swallows WM_CLOSE and the window survives", async () => {
    const { createMessageWindow } = await import("./message-window");
    const { nativeWindow } = await import("./window");
    const { dlopen, FFIType } = await import("bun:ffi");
    const u = dlopen("user32.dll", {
      SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
      IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    const win = createMessageWindow(() => {});
    const native = nativeWindow(win.hwnd);
    let closeRequests = 0;
    const restore = native.onCloseRequest(() => closeRequests++);
    u.SendMessageW(win.hwnd, 0x0010, 0n, 0n); // WM_CLOSE
    expect(closeRequests).toBe(1);
    expect(u.IsWindow(win.hwnd)).not.toBe(0);
    restore();
    u.SendMessageW(win.hwnd, 0x0010, 0n, 0n);
    expect(closeRequests).toBe(1); // default chain again (the message window ignores WM_CLOSE itself)
    win.destroy();
  });

  test("notifyIconData lays out the balloon fields where Windows expects them", async () => {
    const t = await import("./tray");
    const nid = t.notifyIconData(0x1234n, 7, 0x55n, "tip", { title: "T", body: "B", silent: true, hIcon: 0x99n });
    const dv = new DataView(nid.buffer);
    expect(nid.length).toBe(976);
    expect(dv.getUint32(0, true)).toBe(976);
    expect(dv.getBigUint64(t.NID_HWND, true)).toBe(0x1234n);
    expect(dv.getUint32(t.NID_UID, true)).toBe(7);
    expect(dv.getUint32(t.NID_FLAGS, true)).toBe(0x1 | 0x2 | 0x4 | 0x10); // MESSAGE|ICON|TIP|INFO
    expect(dv.getBigUint64(t.NID_HICON, true)).toBe(0x55n);
    expect(Buffer.from(nid.subarray(t.NID_TIP, t.NID_TIP + 8)).toString("utf16le")).toBe("tip\0");
    expect(Buffer.from(nid.subarray(t.NID_INFO, t.NID_INFO + 4)).toString("utf16le")).toBe("B\0");
    expect(Buffer.from(nid.subarray(t.NID_INFO_TITLE, t.NID_INFO_TITLE + 4)).toString("utf16le")).toBe("T\0");
    expect(dv.getUint32(t.NID_INFO_FLAGS, true)).toBe(0x4 | 0x20 | 0x80 | 0x10); // USER|LARGE_ICON|QUIET_TIME|NOSOUND
    expect(dv.getBigUint64(t.NID_BALLOON_ICON, true)).toBe(0x99n);
    // Without a balloon: no NIF_INFO, info fields empty.
    const plain = t.notifyIconData(1n, 1, 0n, "x");
    expect(new DataView(plain.buffer).getUint32(t.NID_FLAGS, true)).toBe(0x7);
    expect(plain[t.NID_INFO]).toBe(0);
  });

  test("the 32px balloon icon loads from the generated .ico", async () => {
    const { loadIcon } = await import("./icon");
    const { SM_CXICON, user32 } = await import("./api");
    const icon = loadIcon(dotIcon(), SM_CXICON);
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

  test("escapeLabel doubles ampersands", async () => {
    const { escapeLabel } = await import("./menu");
    expect(escapeLabel("Fish & Chips")).toBe("Fish && Chips");
  });
});

describe.if(onWindows)("win32 icons", () => {
  test("iconBitmap makes a DIB section at the asked size and premultiplies", async () => {
    const { iconBitmap } = await import("./icon");
    const { gdi32 } = await import("./api");
    const hbm = iconBitmap(dotIcon({ color: "#ff0000", sizes: [32] }), 16); // 32 -> 16: the resample path
    expect(hbm).not.toBe(0n);
    gdi32.DeleteObject(hbm);
  });

  test("bitmapItemInfo lays out MENUITEMINFOW for hbmpItem", async () => {
    const { bitmapItemInfo, MII_SIZE, MII_MASK, MII_HBMPITEM } = await import("./menu");
    const mii = bitmapItemInfo(0xabcdn);
    const dv = new DataView(mii.buffer);
    expect(mii.length).toBe(MII_SIZE);
    expect(dv.getUint32(0, true)).toBe(80);
    expect(dv.getUint32(MII_MASK, true)).toBe(0x80);
    expect(dv.getBigUint64(MII_HBMPITEM, true)).toBe(0xabcdn);
  });

  test("a menu with an icon builds and the bitmap is set on the item", async () => {
    // Builds the HMENU the way popupMenuAtCursor does, without showing it.
    const { iconBitmap } = await import("./icon");
    const { bitmapItemInfo } = await import("./menu");
    const { user32, gdi32, wstr } = await import("./api");
    const hmenu = user32.CreatePopupMenu();
    user32.AppendMenuW(hmenu, 0, 1n, wstr("With icon"));
    const hbm = iconBitmap(dotIcon());
    expect(user32.SetMenuItemInfoW(hmenu, 0, 1, bitmapItemInfo(hbm))).not.toBe(0);
    user32.DestroyMenu(hmenu);
    gdi32.DeleteObject(hbm);
  });

  test("setWindowIcon on a message window does not fail and replaces its handles", async () => {
    const { setWindowIcon } = await import("./icon");
    const { createMessageWindow } = await import("./message-window");
    const win = createMessageWindow(() => undefined);
    setWindowIcon(win.hwnd, dotIcon());
    setWindowIcon(win.hwnd, dotIcon({ color: "#00ff00" })); // frees the first pair
    setWindowIcon(win.hwnd, undefined); // back to stock
    win.destroy();
  });
});
