// The TypeScript layer of the tray, popup menus, the system menu, the folder dialog and icon
// decoding, through the native binding: the templates' clicks and function forms, `buildMenu`'s
// numbering, the current tray, the option mapping, a handler's exception. What the OS shows and
// does (the real menus read back, their places, the right button, the tray's clicks, menus and
// handles, Explorer's reading of the icon) is proven in Rust: `crates/sweetview-runtime/src/
// menu_tray_os_tests.rs` and `icon.rs`. The system menu and the folder dialog are still proven
// here. Input is a message posted to one of this process's own windows.

import { afterEach, describe, expect, test } from "bun:test";
import { binding } from "../binding";
import { dotIco, dotPng } from "../icon";
import { Menu, type MenuTemplate } from "../menu";
import { Tray } from "../tray";
import { Screen } from "../screen";
import { Window } from "../window";
import {
  TRAY,
  VK,
  WM_CLOSE,
  chooseMenuItem,
  hInstance,
  wide,
  chooseInFolderDialog,
  user32,
  endMenu,
  isWindow,
  menuOfWindow,
  openPopupMenu,
  ownWindows,
  ownWindow,
  ownerOf,
  post,
  postTrayMouse,
  pressKeys,
  readMenu,
  windowRect,
  type MenuEntry,
} from "../../test/win32-os";
import { buildMenu, destroyMenu } from "./menu";
import { windowMenu } from "./tab-window";
import { createTray, currentTray } from "./tray";

const onWindows = process.platform === "win32";
let serial = 0;
const unique = (what: string) => `sweetview-test ${what} ${process.pid}-${++serial}`;

/** Pumps the OS loop until `done()` or the deadline. */
async function pumpUntil(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    binding().pumpEvents();
    await Bun.sleep(5);
  }
}

/** Pumps for `ms` milliseconds. */
async function pumpFor(ms: number): Promise<void> {
  const until = Date.now() + ms;
  await pumpUntil(() => Date.now() >= until, ms + 100);
}

/**
 * Menu watchers still armed. Each is cancelled when its test ends: a watcher whose menu never
 * opened would otherwise stay armed for five seconds and work the next test's menu.
 */
const menuWatchers = new Set<() => void>();
afterEach(() => {
  for (const cancel of [...menuWatchers]) cancel();
});

/**
 * Runs `step` from inside the popup menu's own modal loop once a popup menu of
 * this process is open, on a native interval (which the menu loop dispatches).
 * A menu still open 3 s later is closed, so a failing test never leaves one up.
 * The watcher, and its closer, are disarmed when its test ends; the watcher also after five seconds.
 */
function whenMenuOpens(step: (menuWindow: bigint) => void): void {
  const native = binding();
  const started = Date.now();
  // The 3 s closer is kept with the watcher, so the test's end disarms it too: one left behind
  // would end whichever menu is open when it fires, the next test's included (review G10).
  let closer: number | undefined;
  const cancel = () => {
    native.cancelTimeout(id);
    if (closer !== undefined) native.cancelTimeout(closer);
    menuWatchers.delete(cancel);
  };
  const id = native.scheduleInterval(10, () => {
    const menuWindow = openPopupMenu();
    if (menuWindow !== 0n) {
      native.cancelTimeout(id);
      closer = native.scheduleTimeout(3000, () => {
        closer = undefined;
        menuWatchers.delete(cancel);
        void (openPopupMenu() !== 0n && endMenu());
      });
      step(menuWindow);
    } else if (Date.now() - started > 5000) {
      cancel();
    }
  });
  menuWatchers.add(cancel);
}

const RED = { color: "#ff0000" };

describe.if(onWindows)("icon decoding (binding)", () => {
  const pixel = (rgba: Uint8Array, size: number) => [...rgba.subarray(((size >> 1) * size + (size >> 1)) * 4, ((size >> 1) * size + (size >> 1)) * 4 + 4)];

  test("a multi-size .ico picks the exact size at each of 16, 20, 24 and 32 px", () => {
    // One file, one colour per size: the colour read back names the image used.
    const sizes = [16, 20, 24, 32];
    const colours = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
    const { encodeIco, renderDot } = require("../icon") as typeof import("../icon");
    const ico = encodeIco(new Map(sizes.map((s, i) => [s, renderDot(s, { color: colours[i] })])));
    const expected = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];
    sizes.forEach((size, i) => expect(pixel(binding().decodeIcon({ ico }, size)!, size)).toEqual([...expected[i]!, 255]));
  });

  test("a PNG decodes at the asked size, an icon with nothing for Windows gives null, garbage throws with the reason", () => {
    const rgba = binding().decodeIcon({ png: dotPng(64, RED) }, 16)!;
    expect(pixel(rgba, 16)).toEqual([255, 0, 0, 255]);
    expect(binding().decodeIcon({ symbol: "gearshape" }, 16)).toBeNull();
    expect(() => binding().decodeIcon({ ico: new Uint8Array([1, 2, 3]) }, 16)).toThrow("sweetview: not a .ico file");
  });
});

describe.if(onWindows)("Menu.popup (binding: muda)", () => {
  const icon = { windows: { ico: dotIco(RED) } };

  test("an item in a submenu is chosen; a dismissed menu chooses nothing; the function form is called on each open", () => {
    const owner = ownWindow();
    try {
      let built = 0;
      let clicked = "";
      const menu = (): MenuTemplate => {
        built++;
        return [
          { label: `Open #${built}`, click: () => (clicked = "open") },
          { label: "More", submenu: [{ label: "Deep", click: () => (clicked = "deep") }] },
        ];
      };
      let labels: string[] = [];
      whenMenuOpens((menuWindow) => {
        labels = readMenu(menuOfWindow(menuWindow)).map((e) => e.label);
        pressKeys(menuWindow, VK.DOWN, VK.DOWN, VK.RIGHT, VK.RETURN);
      });
      expect(Menu.popup(owner.hwnd, menu, { x: 200, y: 200 })).toBe(true);
      expect(clicked).toBe("deep");
      expect(labels[0]).toBe("Open #1");

      clicked = "";
      whenMenuOpens((menuWindow) => {
        labels = readMenu(menuOfWindow(menuWindow)).map((e) => e.label);
        pressKeys(menuWindow, VK.ESCAPE);
      });
      expect(Menu.popup(owner.hwnd, menu, { x: 200, y: 200 })).toBe(false);
      expect(clicked).toBe("");
      expect(labels[0]).toBe("Open #2");
      expect(openPopupMenu()).toBe(0n);
    } finally {
      owner.destroy();
    }
  });

  test("an empty menu shows nothing, and a null owner throws as before", () => {
    expect(Menu.popup(1n, [])).toBe(false);
    expect(() => Menu.popup(null, [{ label: "x" }])).toThrow("sweetview: window handle is NULL");
  });

  test("Menu.popup with { above: true } puts the menu's bottom-left corner at the point; without the option (or with above: false), its top-left", () => {
    const owner = ownWindow();
    const area = Screen.primary().workArea;
    // The middle of the primary screen's work area: room above and below, so the OS moves neither menu.
    const point = { x: area.x + (area.width >> 1), y: area.y + (area.height >> 1) };
    const items: MenuTemplate = [{ label: "One" }, { label: "Two" }, { label: "Three" }];
    const placed = (open: () => boolean) => {
      let rect = { left: 0, top: 0, right: 0, bottom: 0 };
      whenMenuOpens((menuWindow) => {
        rect = windowRect(menuWindow);
        pressKeys(menuWindow, VK.ESCAPE);
      });
      expect(open()).toBe(false);
      return rect;
    };
    try {
      const above = placed(() => Menu.popup(owner.hwnd, items, point, { above: true }));
      expect({ left: above.left, bottom: above.bottom }).toEqual({ left: point.x, bottom: point.y });
      expect(above.top).toBeLessThan(point.y);
      for (const options of [undefined, {}, { above: false }]) {
        const below = placed(() => Menu.popup(owner.hwnd, items, point, options));
        expect({ options, left: below.left, top: below.top }).toEqual({ options, left: point.x, top: point.y });
        expect(below.bottom).toBeGreaterThan(point.y);
      }
    } finally {
      owner.destroy();
    }
  });

  test("buildMenu numbers the template's items from 1 in order, runs an item's click by its number, and destroyMenu frees it, twice safely", () => {
    let clicked = "";
    const template: MenuTemplate = [
      { label: "A & B", click: () => (clicked = "a") },
      { label: "Sub", submenu: [{ label: "B", click: () => (clicked = "b") }, { label: "C", checked: true, icon: { windows: { ico: dotIco(RED) } }, click: () => (clicked = "c") }] },
      { type: "separator" },
      { label: "D", enabled: false, click: () => (clicked = "d") },
    ];
    const built = buildMenu(template);
    expect(typeof built.hmenu).toBe("bigint");
    expect(user32.IsMenu(built.hmenu)).not.toBe(0);
    expect([...built.commands.keys()]).toEqual([1, 2, 3, 4]);
    expect(built.bitmaps).toEqual([]);
    built.commands.get(3)?.();
    expect(clicked).toBe("c");
    destroyMenu(built);
    expect(user32.IsMenu(built.hmenu)).toBe(0);
    destroyMenu(built); // twice is safe
  });

  test("windowMenu shows the system menu of an ordinary framed Window, read from a second process, and choosing Minimize minimises it", async () => {
    const area = Screen.primary().workArea;
    const win = new Window({ title: unique("system menu"), bounds: { x: area.x + 60, y: area.y + 60, width: 420, height: 300 }, noActivate: true });
    try {
      win.show();
      const hwnd = BigInt(win.handle!);
      expect(user32.IsIconic(hwnd)).toBe(0);
      // A second process reads the menu while this thread is inside its modal loop, then selects
      // the fourth item (Minimize) and presses Enter on the menu window.
      const probe = new URL("../../../sweetview/test/fixtures/win-menu-probe.ts", import.meta.url);
      const child = Bun.spawn([process.execPath, require("node:url").fileURLToPath(probe), String(process.pid), "pick:3"], { stdout: "pipe", stderr: "pipe" });
      windowMenu(hwnd);
      await child.exited;
      const report = JSON.parse((await new Response(child.stdout).text()).trim()) as { items?: { label?: string; enabled?: boolean; separator?: boolean }[]; error?: string };
      expect(report.error).toBeUndefined();
      // Restore, Move, Size, Minimize, Maximize, a separator, Close: Restore is greyed while the window is not maximised.
      expect(report.items?.map((item) => (item.separator ? "-" : item.enabled))).toEqual([false, true, true, true, true, "-", true]);
      await pumpUntil(() => user32.IsIconic(hwnd) !== 0, 3000);
      expect(user32.IsIconic(hwnd)).not.toBe(0);

      // A value that names no window shows nothing and throws nothing.
      windowMenu(0x7fff_fff0n);
      expect(openPopupMenu()).toBe(0n);
    } finally {
      win.dispose();
    }
  }, 30_000);
});

describe.if(onWindows)("Window#showSystemMenu", () => {
  test("a window Sweetview did not make gets the system menu the tag's windowMenu(hwnd) gave it: one of another process shows none; one of this thread, whatever its styles, has its items from IsZoomed and keeps its own disabled Close", async () => {
    // Review round 3, measure A. The tag's windowMenu(hwnd) (win32/tab-window.ts, lines 589 to 608)
    // enabled Restore when IsZoomed, Move, Size and Maximize when not, Minimize always, left Close
    // alone, made Close the default item and posted the chosen command. Every window Sweetview did not
    // make (another process's; this thread's own with WS_THICKFRAME, with WS_MAXIMIZEBOX, with both
    // and a disabled Close), each wrapped by Window.fromHandle, gets exactly that.
    const states = (win: Window): string[] => {
      let read: string[] = [];
      whenMenuOpens((menuWindow) => {
        read = readMenu(menuOfWindow(menuWindow)).map((e) => (e.separator ? "-" : e.disabled ? "off" : "on"));
        pressKeys(menuWindow, VK.ESCAPE);
      });
      win.showSystemMenu();
      return read;
    };
    // Another process's window: the menu is not shown (it was not before Window.fromHandle registered it either).
    const holder = Bun.spawn([process.execPath, require("node:url").fileURLToPath(new URL("../../../../rust-rewrite/compat/fixtures/foreign-window.ts", import.meta.url)), "hold"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      let text = "";
      while (!/\r?\n/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      const foreign = Window.fromHandle(BigInt(text.trim()));
      let opened = false;
      whenMenuOpens((menuWindow) => {
        opened = true;
        pressKeys(menuWindow, VK.ESCAPE);
      });
      foreign.showSystemMenu();
      await pumpFor(300);
      expect(opened).toBe(false);
      foreign.dispose();
      // Its watcher saw no menu and is still armed: disarmed, so the next menus are read by their own.
      for (const cancel of [...menuWatchers]) cancel();
    } finally {
      holder.stdin.end();
      await Promise.race([holder.exited, Bun.sleep(10_000)]);
    }

    // This thread's own windows, by their styles: sizable but not maximisable, and the other way round.
    const WS_CAPTION = 0x00c00000;
    const WS_SYSMENU = 0x00080000;
    const WS_THICKFRAME = 0x00040000;
    const WS_MINIMIZEBOX = 0x00020000;
    const WS_MAXIMIZEBOX = 0x00010000;
    const WS_VISIBLE = 0x10000000;
    const MF_GRAYED = 0x1;
    const SC_CLOSE = 0xf060;
    const make = (style: number) => {
      const hwnd = user32.CreateWindowExW(0, wide("STATIC"), wide(unique("own system menu")), WS_VISIBLE | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | style, 200, 200, 320, 200, 0n, 0n, hInstance(), null);
      expect(hwnd).not.toBe(0n);
      return hwnd;
    };
    const sizable = make(WS_THICKFRAME);
    const maximisable = make(WS_MAXIMIZEBOX);
    const noClose = make(WS_THICKFRAME | WS_MAXIMIZEBOX);
    user32.EnableMenuItem(user32.GetSystemMenu(noClose, 0), SC_CLOSE, MF_GRAYED);
    const wrapped = [sizable, maximisable, noClose].map((h) => Window.fromHandle(h));
    try {
      // Restore, Move, Size, Minimize, Maximize, a separator, Close.
      expect(states(wrapped[0]!)).toEqual(["off", "on", "on", "on", "on", "-", "on"]);
      expect(states(wrapped[1]!)).toEqual(["off", "on", "on", "on", "on", "-", "on"]);
      expect(states(wrapped[2]!)).toEqual(["off", "on", "on", "on", "on", "-", "off"]);
      // Maximised: Restore only, as IsZoomed says.
      user32.SendMessageW(sizable, 0x0112, 0xf030n, 0n); // WM_SYSCOMMAND, SC_MAXIMIZE
      expect(states(wrapped[0]!)).toEqual(["on", "off", "off", "on", "off", "-", "on"]);
    } finally {
      for (const w of wrapped) w.dispose();
      for (const h of [sizable, maximisable, noClose]) user32.DestroyWindow(h);
    }
  }, 40_000);

  test("a command chosen from the system menu means what its label says, whatever changed while the menu was open", async () => {
    // Review round 2, finding 4. Class: Maximize and Restore, chosen after the window was maximised
    // or restored by another call while the menu tracked (the menu loop runs page calls and timers),
    // for a frameless window (Sweetview's toggle) and a framed one (the OS's).
    const area = Screen.primary().workArea;
    const at = { x: area.x + 110, y: area.y + 110, width: 400, height: 280 };
    // Opens the menu, runs `meanwhile` from inside its loop, then chooses the item at `position`.
    const chooseAfter = (win: Window, meanwhile: () => void, position: number) => {
      whenMenuOpens((menuWindow) => {
        meanwhile();
        chooseMenuItem(menuWindow, position);
      });
      win.showSystemMenu();
    };
    for (const frame of [false, true]) {
      const win = new Window({ title: unique(`menu label ${frame}`), frame, resizable: true, noActivate: true, bounds: at });
      try {
        win.show();
        // Maximize, chosen after another call maximised the window: it stays maximised.
        chooseAfter(win, () => win.toggleMaximize(), 4);
        await pumpFor(200);
        expect({ frame, maximized: win.isMaximized() }).toEqual({ frame, maximized: true });
        // Restore, chosen after another call restored it: it stays restored.
        chooseAfter(win, () => win.toggleMaximize(), 0);
        await pumpFor(200);
        expect({ frame, maximized: win.isMaximized(), bounds: win.bounds() }).toEqual({ frame, maximized: false, bounds: at });
        // Review round 2, M2: Maximize chosen on a minimised window maximises it (a frameless one
        // through its toggle, never the OS's maximise behind it), and its next toggle restores it.
        win.minimize();
        chooseAfter(win, () => {}, 4);
        await pumpFor(300);
        expect({ frame, minimized: win.isMinimized(), maximized: win.isMaximized() }).toEqual({ frame, minimized: false, maximized: true });
        win.toggleMaximize();
        await pumpFor(200);
        expect({ frame, maximized: win.isMaximized(), bounds: win.bounds() }).toEqual({ frame, maximized: false, bounds: at });
        // M3: minimised while the menu is open, then Maximize. The OS may cancel a menu whose owner
        // it minimises (no command comes back); when the command does come back the window is
        // maximised from where it was, never with its iconic bounds kept to go back to.
        chooseAfter(win, () => win.minimize(), 4);
        await pumpFor(300);
        if (win.isMinimized()) win.show();
        if (win.isMaximized()) win.toggleMaximize();
        await pumpFor(200);
        expect({ frame, maximized: win.isMaximized(), bounds: win.bounds() }).toEqual({ frame, maximized: false, bounds: at });
      } finally {
        win.dispose();
      }
    }
    // Round 3, measure B: liveness is checked after every step that can run application code. Maximize
    // on a minimised frameless window un-minimises it first, which runs its resize listeners; one
    // that disposes the window there leaves nothing for the toggle to do.
    const undone = new Window({ title: unique("menu disposed on restore"), frame: false, noActivate: true, bounds: at });
    undone.show();
    undone.minimize();
    undone.onResize(() => undone.dispose());
    expect(() => chooseAfter(undone, () => {}, 4)).not.toThrow();
    await pumpFor(200);
    expect(undone.isMaximized()).toBe(false);
    // M3: disposed while the menu is open, then a command: nothing more happens, nothing throws.
    const gone = new Window({ title: unique("menu disposed"), frame: false, noActivate: true, bounds: at });
    gone.show();
    expect(() => chooseAfter(gone, () => gone.dispose(), 4)).not.toThrow();
    await pumpFor(200);
    expect(gone.isMaximized()).toBe(false);
  }, 60_000);

  test("follows Sweetview's own state: a frameless window maximises and restores through its work-area toggle, a minimised window can be restored, a window that cannot be sized offers no Size or Maximize", async () => {
    // Review finding 2 and N1. The items, in order: Restore, Move, Size, Minimize, Maximize, a separator, Close.
    const area = Screen.primary().workArea;
    const at = { x: area.x + 90, y: area.y + 90, width: 420, height: 300 };
    const states = (win: Window): string[] => {
      let read: string[] = [];
      whenMenuOpens((menuWindow) => {
        read = readMenu(menuOfWindow(menuWindow)).map((e) => (e.separator ? "-" : e.disabled ? "off" : "on"));
        pressKeys(menuWindow, VK.ESCAPE);
      });
      win.showSystemMenu();
      return read;
    };
    const choose = (win: Window, position: number) => {
      whenMenuOpens((menuWindow) => chooseMenuItem(menuWindow, position));
      win.showSystemMenu();
    };
    const frameless = new Window({ title: unique("frameless system menu"), frame: false, noActivate: true, bounds: at });
    const framed = new Window({ title: unique("framed system menu"), noActivate: true, bounds: at });
    const fixed = new Window({ title: unique("fixed system menu"), resizable: false, noActivate: true, bounds: at });
    const fixedTabs = new Window({ tabs: true, resizable: false, noActivate: true });
    try {
      const seen: boolean[] = [];
      frameless.onMaximizeChange((m) => seen.push(m));
      frameless.show();
      // (a) Not maximised: Maximize is Sweetview's work-area toggle; a frameless window is not resizable by default.
      expect(states(frameless)).toEqual(["off", "on", "off", "on", "on", "-", "on"]);
      choose(frameless, 4);
      await pumpUntil(() => frameless.isMaximized(), 2000);
      expect({ maximized: frameless.isMaximized(), bounds: frameless.bounds(), seen }).toEqual({ maximized: true, bounds: Screen.of(frameless).workArea, seen: [true] });
      // (b) Maximised: Restore only, no Move or Size; Restore gives back the bounds it had.
      expect(states(frameless)).toEqual(["on", "off", "off", "on", "off", "-", "on"]);
      choose(frameless, 0);
      await pumpUntil(() => !frameless.isMaximized(), 2000);
      expect({ maximized: frameless.isMaximized(), bounds: frameless.bounds(), seen }).toEqual({ maximized: false, bounds: at, seen: [true, false] });
      // The next toggle saves the right bounds: there and back.
      frameless.toggleMaximize();
      frameless.toggleMaximize();
      expect(frameless.bounds()).toEqual(at);

      // A minimised window: Restore is enabled and restores it.
      framed.show();
      framed.minimize();
      expect(states(framed)[0]).toBe("on");
      choose(framed, 0);
      await pumpUntil(() => !framed.isMinimized(), 2000);
      expect(framed.isMinimized()).toBe(false);

      // (c) Framed or tabbed, resizable: false: no Size, no Maximize.
      fixed.show();
      expect(states(fixed)).toEqual(["off", "on", "off", "on", "off", "-", "on"]);
      fixedTabs.show();
      expect(states(fixedTabs)).toEqual(["off", "on", "off", "on", "off", "-", "on"]);
    } finally {
      fixedTabs.dispose();
      fixed.dispose();
      framed.dispose();
      frameless.dispose();
    }
  }, 30_000);

  test("shows the window's system menu, read from a second process, and choosing Minimize minimises it", async () => {
    const area = Screen.primary().workArea;
    const win = new Window({ title: unique("public system menu"), bounds: { x: area.x + 80, y: area.y + 80, width: 420, height: 300 }, noActivate: true });
    try {
      win.show();
      expect(win.isMinimized()).toBe(false);
      // As for windowMenu above: a second process reads the menu while this thread is inside its
      // modal loop, then selects the fourth item (Minimize) and presses Enter on the menu window.
      const probe = new URL("../../../sweetview/test/fixtures/win-menu-probe.ts", import.meta.url);
      const child = Bun.spawn([process.execPath, require("node:url").fileURLToPath(probe), String(process.pid), "pick:3"], { stdout: "pipe", stderr: "pipe" });
      win.showSystemMenu();
      await child.exited;
      const report = JSON.parse((await new Response(child.stdout).text()).trim()) as { items?: { label?: string; enabled?: boolean; separator?: boolean }[]; error?: string };
      expect(report.error).toBeUndefined();
      expect(report.items?.map((item) => (item.separator ? "-" : item.enabled))).toEqual([false, true, true, true, true, "-", true]);
      await pumpUntil(() => win.isMinimized(), 3000);
      expect(win.isMinimized()).toBe(true);
      win.dispose();
      win.showSystemMenu(); // a disposed window shows nothing
      expect(openPopupMenu()).toBe(0n);
    } finally {
      win.dispose();
    }
  }, 30_000);
});

describe.if(onWindows)("Tray (binding: tray-icon)", () => {
  test("a tray is made with its own window and disposed, twice safely", () => {
    const tray = createTray({ tooltip: unique("tray"), icon: { windows: { ico: dotIco() } } });
    const hwnd = tray.windowHandle();
    expect(hwnd).not.toBe(0n);
    expect(isWindow(hwnd)).toBe(true);
    expect(currentTray()).toBe(tray);
    tray.dispose();
    tray.dispose();
    expect(isWindow(hwnd)).toBe(false);
    expect(tray.windowHandle()).toBe(0n);
    expect(currentTray()).toBeUndefined();
  });

  test("the public Tray is the current tray, and its setIcon and setTooltip reach the binding", () => {
    const tray = new Tray({ tooltip: unique("tray") });
    try {
      expect(currentTray()?.windowHandle()).not.toBe(0n);
      tray.setIcon({ windows: { ico: dotIco({ color: "#00ff00", sizes: [16, 32] }) } });
      expect(currentTray()?.iconBytes()).toBeDefined();
      tray.setTooltip(unique("tooltip"));
      tray.setIcon({});
      expect(currentTray()?.iconBytes()).toBeUndefined();
    } finally {
      tray.dispose();
      tray.dispose();
    }
  });

  test("a handler that throws is logged with today's message, and a handler may dispose the tray", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    let disposedFromHandler = false;
    const tray = createTray({
      tooltip: unique("tray"),
      onDoubleClick: () => {
        tray.dispose();
        disposedFromHandler = true;
        throw new Error("boom");
      },
    });
    try {
      postTrayMouse(tray.windowHandle(), TRAY.LBUTTONDBLCLK);
      await pumpUntil(() => disposedFromHandler);
    } finally {
      console.error = original;
      tray.dispose();
    }
    expect(disposedFromHandler).toBe(true);
    expect(errors[0]?.[0]).toBe("sweetview: message window handler threw:");
    expect(String(errors[0]?.[1])).toContain("boom");
  }, 20_000);

  test("a right click opens the menu built from the function form; dismissed it chooses nothing, chosen it runs the item", async () => {
    let opened = 0;
    let clicked = "";
    let shown: MenuEntry[] = [];
    const tray = createTray({
      tooltip: unique("tray"),
      menu: () => {
        opened++;
        return [
          { label: `Status ${opened}`, enabled: false },
          { label: "Pause", checked: opened > 1, click: () => (clicked = "pause") },
          { type: "separator" },
          { label: "Quit", click: () => (clicked = "quit") },
        ];
      },
    });
    try {
      const hwnd = tray.windowHandle();
      whenMenuOpens((menuWindow) => {
        shown = readMenu(menuOfWindow(menuWindow));
        endMenu(); // dismissed, as by a click elsewhere
      });
      postTrayMouse(hwnd, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
      await pumpUntil(() => opened === 1 && openPopupMenu() === 0n && shown.length > 0);
      expect(shown.map((e) => e.label)).toEqual(["Status 1", "Pause", "", "Quit"]);
      expect(shown[1]!.checked).toBe(false);
      expect(clicked).toBe("");

      whenMenuOpens((menuWindow) => {
        shown = readMenu(menuOfWindow(menuWindow));
        pressKeys(menuWindow, VK.DOWN, VK.DOWN, VK.RETURN); // the keyboard stops on the disabled first item too
      });
      postTrayMouse(hwnd, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
      await pumpUntil(() => clicked !== "");
      expect(opened).toBe(2);
      expect(shown[0]!.label).toBe("Status 2");
      expect(shown[1]!.checked).toBe(true);
      expect(clicked).toBe("pause");
    } finally {
      tray.dispose();
    }
  }, 20_000);

  test("a bad icon throws with the reason; setMenu gives the tray a menu function and setMenu(undefined) takes it away", async () => {
    let opened = 0;
    const tray = createTray({ tooltip: unique("tray") });
    try {
      expect(() => tray.setIcon({ windows: { ico: new Uint8Array([0, 1]) } })).toThrow("sweetview: the tray icon could not be decoded");
      // No menu yet: a right click opens nothing.
      postTrayMouse(tray.windowHandle(), TRAY.RBUTTONUP);
      await pumpFor(200);
      expect(opened).toBe(0);
      tray.setMenu(() => {
        opened++;
        return [{ label: "Only" }];
      });
      whenMenuOpens((menuWindow) => pressKeys(menuWindow, VK.ESCAPE));
      postTrayMouse(tray.windowHandle(), TRAY.RBUTTONUP);
      await pumpUntil(() => opened === 1 && openPopupMenu() === 0n);
      expect(opened).toBe(1);
      tray.setMenu(undefined);
      postTrayMouse(tray.windowHandle(), TRAY.RBUTTONUP);
      await pumpFor(200);
      expect(opened).toBe(1);
    } finally {
      tray.dispose();
    }
  }, 30_000);

});

describe.if(onWindows)("pickFolder (binding)", () => {
  /**
   * Runs `step` on the folder dialog titled `title` from inside the dialog's own loop, every
   * 20 ms until it returns true. A dialog still up after 10 s is closed, so a failing test never leaves one open.
   */
  function whenDialogOpens(title: string, step: (dialog: bigint) => boolean): void {
    const native = binding();
    const started = Date.now();
    const id = native.scheduleInterval(20, () => {
      const dialog = ownWindows("#32770", title)[0] ?? 0n;
      if (dialog !== 0n && step(dialog)) {
        native.cancelTimeout(id);
        native.scheduleTimeout(10_000, () => void ownWindows("#32770", title).forEach((left) => post(left, WM_CLOSE)));
      } else if (Date.now() - started > 10_000) {
        native.cancelTimeout(id);
        if (dialog !== 0n) post(dialog, WM_CLOSE);
      }
    });
  }

  test("cancelled with no loop running (the timer-pumped mode) returns null", () => {
    const { pickFolder } = require("../folder-picker") as typeof import("../folder-picker");
    const title = unique("folder");
    let found = false;
    whenDialogOpens(title, (dialog) => {
      found = true;
      return post(dialog, WM_CLOSE);
    });
    expect(pickFolder(null, title)).toBeNull();
    expect(found).toBe(true);
  }, 20_000);

  test("cancelled from inside the blocking loop returns null, and the loop goes on", () => {
    const { pickFolder } = require("../folder-picker") as typeof import("../folder-picker");
    const native = binding();
    const title = unique("folder");
    let result: string | null | undefined;
    let blocking = false;
    whenDialogOpens(title, (dialog) => post(dialog, WM_CLOSE));
    native.scheduleTimeout(5, () => {
      blocking = native.isLoopBlocking();
      result = pickFolder(null, title);
      native.quitLoop();
    });
    native.runLoop();
    expect(blocking).toBe(true);
    expect(result).toBeNull();
  }, 20_000);

  test("returns the chosen folder, with the dialog owned by the given window", () => {
    const { pickFolder } = require("../folder-picker") as typeof import("../folder-picker");
    const owner = ownWindow();
    const folder = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "sweetview-pick-"));
    const cwd = process.cwd();
    try {
      const title = unique("folder");
      let owned = 0n;
      let typed = false;
      whenDialogOpens(title, (dialog) => {
        owned = ownerOf(dialog);
        typed = chooseInFolderDialog(dialog, folder);
        return typed;
      });
      const picked = pickFolder(owner.hwnd, title);
      expect(typed).toBe(true);
      expect(owned).toBe(owner.hwnd);
      expect(picked?.toLowerCase()).toBe(require("node:fs").realpathSync.native(folder).toLowerCase());
      expect(process.cwd()).toBe(cwd);
    } finally {
      owner.destroy();
      require("node:fs").rmSync(folder, { recursive: true, force: true });
    }
  }, 20_000);
});

describe.if(onWindows)("app-wide settings (binding)", () => {
  test("setAppMenu, setAppIcon and setActivationPolicy are accepted and change nothing on Windows", async () => {
    const { setAppMenu } = await import("../app-menu");
    const { setAppIcon } = await import("../app-icon");
    const { setActivationPolicy } = await import("../event-loop");
    const before = ownWindows("#32768").length;
    setAppMenu({ appName: unique("app"), aboutText: "About" });
    setAppIcon({ windows: { ico: dotIco() } });
    setAppIcon({});
    for (const policy of ["regular", "accessory", "prohibited"] as const) setActivationPolicy(policy);
    expect(ownWindows("#32768").length).toBe(before);
    expect(() => binding().setActivationPolicy("sideways" as never)).toThrow('sweetview: unknown activation policy "sideways"');
  });
});
