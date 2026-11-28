// The TypeScript layer of the tray, popup menus, the system menu, the folder dialog and icon
// decoding, through the native binding: the templates' clicks and function forms, `buildMenu`'s
// numbering, the current tray, the option mapping, a handler's exception. What the OS shows and
// does (the real menus read back, their places, the right button, the tray's clicks, menus and
// handles, Explorer's reading of the icon) is proven in Rust: `crates/sweetview-runtime/src/
// menu_tray_os_tests.rs` and `icon.rs`, the folder dialog too. The system menu is still proven
// here where a second process reads it. Input is a message posted to one of this process's own windows.

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
  chooseMenuItem,
  user32,
  endMenu,
  menuOfWindow,
  openPopupMenu,
  ownWindows,
  ownWindow,
  postTrayMouse,
  pressKeys,
  readMenu,
  windowRect,
  type MenuEntry,
} from "../../test/win32-os";
import { buildMenu, destroyMenu, popupMenuAtCursor } from "./menu";
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
  // Which image each size decodes from, a PNG at the asked size, and an icon with nothing for
  // Windows decoding to nothing are proven in Rust (crates/sweetview-runtime/src/icon.rs). Here: what
  // the boundary converts, the RGBA bytes as a Uint8Array, nothing as null, and the error thrown.
  test("decodeIcon gives the RGBA bytes at the asked size, null for an icon with nothing for Windows, and throws with the reason", () => {
    const rgba = binding().decodeIcon({ png: dotPng(64, RED) }, 16)!;
    expect(rgba).toBeInstanceOf(Uint8Array);
    expect(rgba.length).toBe(16 * 16 * 4);
    const centre = (8 * 16 + 8) * 4;
    expect([...rgba.subarray(centre, centre + 4)]).toEqual([255, 0, 0, 255]);
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

  test("popupMenuAtCursor asks the binding for the menu at the cursor, opening above it (where the OS puts it is proven in Rust: menu_tray_os_tests.rs)", () => {
    const native = binding() as unknown as { popupMenu: (owner: bigint, data: unknown[], at: unknown, above: boolean) => number | null };
    const real = native.popupMenu;
    const asked: { at: unknown; above: boolean }[] = [];
    native.popupMenu = (_owner, _data, at, above) => {
      asked.push({ at, above });
      return null;
    };
    try {
      expect(popupMenuAtCursor(1n, [{ label: "One" }])).toBe(false);
      expect(popupMenuAtCursor(1n, [])).toBe(false); // an empty menu asks nothing
    } finally {
      native.popupMenu = real;
    }
    expect(asked).toEqual([{ at: null, above: true }]);
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
  // A window Sweetview did not make (another process's; this thread's own, by their styles, a
  // greyed Close kept, maximised): proven in Rust, menu_tray_os_tests.rs
  // a_window_sweetview_did_not_make_gets_the_tags_system_menu_and_one_of_another_process_none.
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
  // Its own window, gone once disposed: proven in Rust (menu_tray_os_tests.rs).
  test("a tray is the current tray until disposed, twice safely, and then has no window handle", () => {
    const tray = createTray({ tooltip: unique("tray"), icon: { windows: { ico: dotIco() } } });
    expect(tray.windowHandle()).not.toBe(0n);
    expect(currentTray()).toBe(tray);
    tray.dispose();
    tray.dispose();
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

// pickFolder (cancelled in either loop mode, and the folder chosen, owned by the given window):
// proven in Rust, menu_tray_os_tests.rs
// the_folder_dialog_gives_nothing_when_cancelled_in_either_loop_mode_and_the_folder_chosen_in_it.

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
