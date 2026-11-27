// The tray, popup menus, the folder dialog and icon decoding, through the native
// binding, driven the way the shell and the user would: every input is a message
// posted to one of this process's own windows (the tray icon's window, the popup
// menu, the dialog). Nothing moves the cursor or presses a key system-wide.

import { describe, expect, test } from "bun:test";
import { binding } from "../binding";
import { dotIco, dotPng } from "../icon";
import { Menu, type MenuTemplate } from "../menu";
import { Tray } from "../tray";
import { createMessageWindow } from "./message-window";
import {
  TRAY,
  VK,
  WM_CLOSE,
  chooseInFolderDialog,
  cursor,
  doubleClickTime,
  endMenu,
  isWindow,
  menuOfWindow,
  openPopupMenu,
  ownWindows,
  ownerOf,
  post,
  postTrayMouse,
  pressKeys,
  readMenu,
  registeredMessage,
  windowRect,
  type MenuEntry,
} from "./os-probe.test-support";
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
 * Runs `step` from inside the popup menu's own modal loop once a popup menu of
 * this process is open, on a native interval (which the menu loop dispatches).
 * A menu still open 3 s later is closed, so a failing test never leaves one up.
 */
function whenMenuOpens(step: (menuWindow: bigint) => void): void {
  const native = binding();
  const started = Date.now();
  const id = native.scheduleInterval(10, () => {
    const menuWindow = openPopupMenu();
    if (menuWindow !== 0n) {
      native.cancelTimeout(id);
      native.scheduleTimeout(3000, () => void (openPopupMenu() !== 0n && endMenu()));
      step(menuWindow);
    } else if (Date.now() - started > 5000) {
      native.cancelTimeout(id);
    }
  });
}

const RED = { color: "#ff0000" };

describe.if(onWindows)("icon decoding (binding)", () => {
  const pixel = (rgba: Uint8Array, size: number) => [...rgba.subarray(((size >> 1) * size + (size >> 1)) * 4, ((size >> 1) * size + (size >> 1)) * 4 + 4)];

  test("each size comes from its own image of the .ico, or the next larger one resampled", () => {
    const red = dotIco({ color: "#ff0000", sizes: [16] });
    const green = dotIco({ color: "#00ff00", sizes: [24] });
    const blue = dotIco({ color: "#0000ff", sizes: [32] });
    for (const [ico, size, rgb] of [
      [red, 16, [255, 0, 0]],
      [green, 20, [0, 255, 0]],
      [green, 24, [0, 255, 0]],
      [blue, 16, [0, 0, 255]],
      [blue, 32, [0, 0, 255]],
      [blue, 48, [0, 0, 255]],
    ] as const) {
      const rgba = binding().decodeIcon({ ico }, size)!;
      expect(rgba.length).toBe(size * size * 4);
      expect(pixel(rgba, size)).toEqual([...rgb, 255]);
    }
  });

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

  test("at a point: check marks, icons, submenus, separators and disabled items are on the real menu, and the chosen item runs", () => {
    const owner = createMessageWindow(() => {});
    try {
      let shown: MenuEntry[] = [];
      let at = { left: 0, top: 0 };
      let clicked = "";
      whenMenuOpens((menuWindow) => {
        shown = readMenu(menuOfWindow(menuWindow));
        at = windowRect(menuWindow);
        // The first Down selects the first item, the second the next; Return chooses it.
        pressKeys(menuWindow, VK.DOWN, VK.DOWN, VK.RETURN);
      });
      const template: MenuTemplate = [
        { label: "Fish & Chips", checked: true, click: () => (clicked = "fish") },
        { label: "With icon", icon, click: () => (clicked = "icon") },
        { type: "separator" },
        {
          label: "Sub",
          submenu: [
            { label: "Child", enabled: false },
            { label: "Checked with icon", checked: true, icon },
          ],
        },
        { label: "Off", enabled: false },
      ];
      const chosen = Menu.popup(owner.hwnd, template, { x: 120, y: 140 });
      expect(chosen).toBe(true);
      expect(clicked).toBe("icon");
      expect({ left: at.left, top: at.top }).toEqual({ left: 120, top: 140 });
      expect(shown.map((e) => e.label)).toEqual(["Fish && Chips", "With icon", "", "Sub", "Off"]);
      expect(shown[0]).toMatchObject({ checked: true, disabled: false, hasBitmap: false });
      expect(shown[1]).toMatchObject({ checked: false, disabled: false, hasBitmap: true });
      expect(shown[2]!.separator).toBe(true);
      expect(shown[3]!.submenu?.map((e) => e.label)).toEqual(["Child", "Checked with icon"]);
      expect(shown[3]!.submenu?.[0]).toMatchObject({ disabled: true });
      expect(shown[3]!.submenu?.[1]).toMatchObject({ checked: true, hasBitmap: true, disabled: false });
      expect(shown[4]).toMatchObject({ disabled: true });
    } finally {
      owner.destroy();
    }
  });

  test("an item in a submenu is chosen; a dismissed menu chooses nothing; the function form is called on each open", () => {
    const owner = createMessageWindow(() => {});
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

  test("at the cursor when no point is given", () => {
    const owner = createMessageWindow(() => {});
    try {
      let rect = { left: 0, top: 0, right: 0, bottom: 0 };
      let at = { x: 0, y: 0 };
      whenMenuOpens((menuWindow) => {
        rect = windowRect(menuWindow);
        at = cursor();
        pressKeys(menuWindow, VK.ESCAPE);
      });
      expect(Menu.popup(owner.hwnd, [{ label: "Here" }])).toBe(false);
      // The menu's corner is at the cursor; near a screen edge the OS flips it to the other side,
      // where its far edge (one past its last pixel) lands one pixel past the cursor.
      const near = (a: number, b: number) => Math.abs(a - b) <= 1;
      expect(near(rect.left, at.x) || near(rect.right, at.x)).toBe(true);
      expect(near(rect.top, at.y) || near(rect.bottom, at.y)).toBe(true);
    } finally {
      owner.destroy();
    }
  });

  test("an empty menu shows nothing, and a null owner throws as before", () => {
    expect(Menu.popup(1n, [])).toBe(false);
    expect(() => Menu.popup(null, [{ label: "x" }])).toThrow("sweetview: window handle is NULL");
  });
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

  test("making and disposing trays and their menus returns every GDI and USER object", async () => {
    const { guiObjects } = await import("./os-probe.test-support");
    const icon = { windows: { ico: dotIco({ sizes: [16, 32] }) } };
    const round = async () => {
      let opened = 0;
      const menu = () => {
        opened++;
        return [{ label: "One", icon }, { label: "Two", checked: true, icon }];
      };
      const tray = createTray({ tooltip: unique("tray"), icon, menu });
      whenMenuOpens((menuWindow) => pressKeys(menuWindow, VK.ESCAPE));
      postTrayMouse(tray.windowHandle(), TRAY.RBUTTONUP);
      await pumpUntil(() => opened === 1 && openPopupMenu() === 0n, 5000);
      expect(opened).toBe(1);
      tray.dispose();
    };
    await round(); // one-time costs (window classes, the stock cursor) are paid first
    const before = guiObjects();
    for (let i = 0; i < 20; i++) await round();
    // Each showing armed a 3 s safety timer (whenMenuOpens), and a timer is a USER object until it fires.
    await pumpFor(3300);
    const after = guiObjects();
    expect(after.gdi).toBeLessThanOrEqual(before.gdi);
    expect(after.user).toBeLessThanOrEqual(before.user);
  }, 60_000);

  test("a tray with no icon shows the stock icon, and the public Tray works the same", () => {
    const tray = new Tray({ tooltip: unique("tray") });
    expect(currentTray()?.windowHandle()).not.toBe(0n);
    tray.dispose();
    tray.dispose();
  });

  test("a left click is a click once the double-click time has passed; a double click is a double click and no click", async () => {
    const seen: string[] = [];
    const tray = createTray({ tooltip: unique("tray"), onClick: () => seen.push("click"), onDoubleClick: () => seen.push("double") });
    try {
      const hwnd = tray.windowHandle();
      const interval = doubleClickTime();
      postTrayMouse(hwnd, TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
      await pumpFor(Math.floor(interval / 2));
      expect(seen).toEqual([]); // still waiting for a second click
      await pumpUntil(() => seen.length > 0, interval + 2000);
      expect(seen).toEqual(["click"]);

      seen.length = 0;
      postTrayMouse(hwnd, TRAY.LBUTTONDOWN, TRAY.LBUTTONUP, TRAY.LBUTTONDBLCLK, TRAY.LBUTTONUP);
      await pumpFor(interval + 300);
      expect(seen).toEqual(["double"]);
    } finally {
      tray.dispose();
    }
  }, 20_000);

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

  test("setIcon, setTooltip and setMenu take effect; a removed menu opens nothing", async () => {
    let opened = 0;
    const tray = createTray({ tooltip: unique("tray") });
    try {
      tray.setIcon({ windows: { ico: dotIco({ color: "#00ff00", sizes: [16, 32] }) } });
      expect(currentTray()?.iconBytes()).toBeDefined();
      tray.setIcon({}); // back to the stock icon
      expect(currentTray()?.iconBytes()).toBeUndefined();
      expect(() => tray.setIcon({ windows: { ico: new Uint8Array([0, 1]) } })).toThrow("sweetview: the tray icon could not be decoded");
      tray.setTooltip(unique("tooltip ").padEnd(200, "x")); // longer than the shell keeps: truncated, not refused

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
  }, 20_000);

  test("the icon is re-added when the taskbar is recreated (the registered TaskbarCreated message, as Explorer broadcasts it)", async () => {
    // Restarting Explorer is not safe on a shared desktop; its broadcast is posted to the tray's window instead.
    let clicks = 0;
    const tray = createTray({ tooltip: unique("tray"), onDoubleClick: () => clicks++ });
    try {
      const hwnd = tray.windowHandle();
      expect(post(hwnd, registeredMessage("TaskbarCreated"))).toBe(true);
      await pumpFor(100);
      // tray-icon delivers a click only while the shell knows the icon (it asks the shell for the icon's rectangle).
      postTrayMouse(hwnd, TRAY.LBUTTONDBLCLK);
      await pumpUntil(() => clicks === 1);
      expect(clicks).toBe(1);
    } finally {
      tray.dispose();
    }
  }, 20_000);
});

describe.if(onWindows)("pickFolder (binding: rfd)", () => {
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
    const owner = createMessageWindow(() => {});
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
