// The tray, popup menus, the folder dialog and icon decoding, through the native
// binding, driven the way the shell and the user would: most input is a message
// posted to one of this process's own windows (the tray icon's window, the popup
// menu, the dialog). Three things use the shared desktop, each only when it is
// free and putting back what it moved: the right-button test injects a right
// click over this process's own popup menu; the tray-alignment test places the
// cursor; and the shell reader (`trayFromShell`) opens the notification area's
// overflow flyout with a click. When the desktop is not free they ask again, and then fail saying so.
// Nothing presses a key system-wide.

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
  buttonsDown,
  chooseMenuItem,
  hInstance,
  wide,
  chooseInFolderDialog,
  cursor,
  guiObjects,
  injectCursorMove,
  injectRightButton,
  menuItemId,
  menuItemRect,
  trayFromShell,
  type ShellIcon,
  user32,
  windowAt,
  doubleClickTime,
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
  registeredMessage,
  windowRect,
  type MenuEntry,
} from "../../test/win32-os";
import { DesktopNotOurs } from "../../test/desktop";
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

/** What the shell answered about an icon: found with its name and pixel, or not found. */
type ShellRead = Exclude<ShellIcon, { skip: string }>;

/**
 * `trayFromShell`, asked again (with a pause, pumping) while the answer is not yet the expected
 * one: Explorer applies a change to an icon on its own thread, after `Shell_NotifyIconW` returns,
 * and its flyout takes a moment to close before it can be opened again.
 */
async function shellIcon(tooltip: string, found = true): Promise<ShellRead> {
  let last: ShellRead | undefined;
  let reason = "";
  let reads = 0;
  let refusals = 0;
  // A reading the shared desktop refused (its mouse in use, another window over the icon) is asked
  // again, and a test whose reading never happened fails saying so: it is never a pass.
  while (reads < 4 && refusals < 6) {
    if (reads + refusals > 0) await pumpFor(800);
    const answer = await trayFromShell(tooltip);
    if ("skip" in answer) {
      refusals++;
      reason = answer.skip;
      continue;
    }
    reads++;
    last = answer;
    if (answer.found === found) return answer;
  }
  if (last) return last;
  throw new DesktopNotOurs(`not run: the shell's reading of the notification icon: ${reason}, after ${refusals} attempts (the desktop is shared with other sessions)`);
}

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
    const owner = ownWindow();
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

  test("at the cursor when no point is given", () => {
    const owner = ownWindow();
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

  test("letting go of the right button over an item chooses it (real input over the menu's own window)", () => {
    const native = binding();
    const owner = ownWindow();
    const saved = cursor();
    const desk = Screen.bounds();
    const area = Screen.primary().workArea;
    let skipped = "";
    let clicked = "";
    let target = { x: 0, y: 0 };
    // The right button is let go on every path: straight after the press, by a watchdog that fires
    // inside the menu's modal loop, and in `finally`. `pressed` stays true until a release was accepted.
    let pressed = false;
    const release = () => {
      for (let attempt = 0; pressed && attempt < 3; attempt++) if (injectRightButton(false)) pressed = false;
    };
    let watchdog = 0;
    try {
      for (let attempt = 1; ; attempt++) {
        skipped = "";
        clicked = "";
        whenMenuOpens((menuWindow) => {
          // The second item's middle, on this process's own menu window, read from the OS.
          const item = menuItemRect(menuOfWindow(menuWindow), 1);
          target = { x: (item.left + item.right) >> 1, y: (item.top + item.bottom) >> 1 };
          if (buttonsDown()) skipped = "a mouse button was already down on the shared desktop";
          else {
            injectCursorMove(target.x, target.y, desk);
            if (windowAt(target.x, target.y) !== menuWindow) skipped = "another window is over the menu on the shared desktop";
          }
          if (skipped) {
            endMenu();
            return;
          }
          watchdog = native.scheduleTimeout(1500, release);
          // Pressed and let go over the item: with TPM_RIGHTBUTTON the release chooses it.
          pressed = true;
          injectRightButton(true);
          release();
        });
        const chosen = Menu.popup(
          owner.hwnd,
          [
            { label: "One", click: () => (clicked = "one") },
            { label: "Two", click: () => (clicked = "two") },
            { label: "Three", click: () => (clicked = "three") },
          ],
          { x: area.x + 80, y: area.y + 80 },
        );
        if (!skipped) {
          expect({ chosen, clicked }).toEqual({ chosen: true, clicked: "two" });
          break;
        }
        // The desktop was not this test's: asked again, and a choice never made is a failure, not a pass.
        if (attempt === 5) throw new DesktopNotOurs(`not run: the right-button choice: ${skipped}, after ${attempt} attempts (the desktop is shared with other sessions)`);
        Bun.sleepSync(400);
      }
    } finally {
      release();
      if (watchdog !== 0) native.cancelTimeout(watchdog);
      user32.SetCursorPos(saved.x, saved.y);
      owner.destroy();
    }
  });

  test("popupMenuAtCursor opens the menu above the cursor (its bottom-left corner there), where a menu at a point opens below it", async () => {
    const owner = ownWindow();
    const saved = cursor();
    const area = Screen.primary().workArea;
    // The middle of the primary screen's work area: room above and below, so the OS moves neither menu.
    const point = { x: area.x + (area.width >> 1), y: area.y + (area.height >> 1) };
    try {
      let above = { left: 0, top: 0, right: 0, bottom: 0 };
      let at = { x: 0, y: 0 };
      for (let attempt = 1; ; attempt++) {
        user32.SetCursorPos(point.x, point.y);
        whenMenuOpens((menuWindow) => {
          above = windowRect(menuWindow);
          at = cursor();
          pressKeys(menuWindow, VK.ESCAPE);
        });
        expect(popupMenuAtCursor(owner.hwnd, [{ label: "One" }, { label: "Two" }, { label: "Three" }])).toBe(false);
        if (at.x === point.x && at.y === point.y) break;
        // Another session moved the cursor while the menu opened: asked again, and never a pass.
        if (attempt === 5) throw new DesktopNotOurs(`not run: the menu's place at the cursor: the cursor was moved on the shared desktop (${JSON.stringify(at)}), after ${attempt} attempts (the desktop is shared with other sessions)`);
        await pumpFor(400);
      }
      expect({ left: above.left, bottom: above.bottom }).toEqual({ left: point.x, bottom: point.y });
      expect(above.top).toBeLessThan(point.y);

      let below = { left: 0, top: 0, right: 0, bottom: 0 };
      whenMenuOpens((menuWindow) => {
        below = windowRect(menuWindow);
        pressKeys(menuWindow, VK.ESCAPE);
      });
      expect(Menu.popup(owner.hwnd, [{ label: "One" }, { label: "Two" }, { label: "Three" }], point)).toBe(false);
      expect({ left: below.left, top: below.top }).toEqual({ left: point.x, top: point.y });
      expect(below.bottom).toBeGreaterThan(point.y);
    } finally {
      user32.SetCursorPos(saved.x, saved.y);
      owner.destroy();
    }
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

  test("buildMenu hands the application a menu for its own TrackPopupMenu: ids count from 1 in template order, a key chooses, destroyMenu frees it", () => {
    const owner = ownWindow();
    const icon = { windows: { ico: dotIco(RED) } };
    let clicked = "";
    const template: MenuTemplate = [
      { label: "A & B", click: () => (clicked = "a") },
      {
        label: "Sub",
        submenu: [
          { label: "B", click: () => (clicked = "b") },
          { label: "C", checked: true, icon, click: () => (clicked = "c") },
        ],
      },
      { type: "separator" },
      { label: "D", enabled: false, click: () => (clicked = "d") },
    ];
    try {
      const built = buildMenu(template);
      expect(typeof built.hmenu).toBe("bigint");
      expect(user32.IsMenu(built.hmenu)).not.toBe(0);
      expect([...built.commands.keys()]).toEqual([1, 2, 3, 4]);
      expect(built.bitmaps).toEqual([]);
      // The menu as the OS holds it, and the command id of each item.
      const shown = readMenu(built.hmenu);
      expect(shown.map((e) => e.label)).toEqual(["A && B", "Sub", "", "D"]);
      expect(shown[1]!.submenu?.[1]).toMatchObject({ label: "C", checked: true, hasBitmap: true });
      expect(shown[3]).toMatchObject({ disabled: true });
      const sub = user32.GetSubMenu(built.hmenu, 1);
      expect([menuItemId(built.hmenu, 0), menuItemId(sub, 0), menuItemId(sub, 1), menuItemId(built.hmenu, 3)]).toEqual([1, 2, 3, 4]);

      // The application tracks it itself; Down, Down, Right, Down, Return chooses "C" in the submenu.
      whenMenuOpens((menuWindow) => pressKeys(menuWindow, VK.DOWN, VK.DOWN, VK.RIGHT, VK.DOWN, VK.RETURN));
      const TPM_RETURNCMD = 0x0100;
      const TPM_RIGHTBUTTON = 0x0002;
      const id = user32.TrackPopupMenu(built.hmenu, TPM_RETURNCMD | TPM_RIGHTBUTTON, 150, 150, 0, owner.hwnd, null);
      expect(id).toBe(3);
      built.commands.get(id)?.();
      expect(clicked).toBe("c");

      destroyMenu(built);
      expect(user32.IsMenu(built.hmenu)).toBe(0);
      expect(user32.IsMenu(sub)).toBe(0);
      destroyMenu(built); // twice is safe

      // Building and freeing gives every GDI and USER object back (the item bitmaps included).
      destroyMenu(buildMenu(template));
      const before = guiObjects();
      for (let i = 0; i < 30; i++) destroyMenu(buildMenu(template));
      const after = guiObjects();
      expect(after.gdi).toBeLessThanOrEqual(before.gdi);
      expect(after.user).toBeLessThanOrEqual(before.user);
    } finally {
      owner.destroy();
    }
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
  test("a window Sweetview did not make keeps the OS's own system menu: one of another process shows none, one of this thread offers Size and Maximize as its styles say and keeps its own disabled Close", async () => {
    // Review round 2, findings 1 and 4. Class: every window kind Window#showSystemMenu can be
    // given that Sweetview did not make (another process's, this thread's own with each of
    // WS_THICKFRAME and WS_MAXIMIZEBOX), each adopted by Window.fromHandle, which registers it.
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
      expect(states(wrapped[0]!)).toEqual(["off", "on", "on", "on", "off", "-", "on"]);
      expect(states(wrapped[1]!)).toEqual(["off", "on", "off", "on", "on", "-", "on"]);
      expect(states(wrapped[2]!)).toEqual(["off", "on", "on", "on", "on", "-", "off"]);
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

  test("making and disposing trays and their menus returns every GDI and USER object", async () => {
    const { guiObjects } = await import("../../test/win32-os");
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

  test("a tray with no icon shows the stock icon, and the public Tray works the same", async () => {
    const tooltip = unique("tray");
    const tray = new Tray({ tooltip });
    try {
      expect(currentTray()?.windowHandle()).not.toBe(0n);
      // What Explorer shows for the icon: its tooltip, and the stock icon's image.
      const stock = await shellIcon(tooltip);
      expect(stock).toMatchObject({ found: true });
      if (!stock.found) return;
      expect(stock.name.endsWith(tooltip)).toBe(true);

      // setIcon and setTooltip reach the shell: the new tooltip, and a green image where the stock icon was.
      const changed = unique("tooltip");
      tray.setIcon({ windows: { ico: dotIco({ color: "#00ff00", sizes: [16, 20, 24, 32, 40, 48] }) } });
      tray.setTooltip(changed);
      let green = await shellIcon(changed);
      expect(green).toMatchObject({ found: true });
      if (!green.found) return;
      expect(green.name.endsWith(changed)).toBe(true);
      for (let attempt = 0; attempt < 3 && green.found && green.pixel[1] < 200; attempt++) {
        await pumpFor(800);
        const again = await shellIcon(changed);
        if (!("found" in again) || !again.found) break;
        green = again;
      }
      const [r, g, b] = green.pixel;
      expect(g > 200 && r < 60 && b < 60).toBe(true);
      expect(green.pixel).not.toEqual(stock.pixel);
      expect((await shellIcon(tooltip, false)) as { found?: boolean }).toMatchObject({ found: false }); // the old tooltip is gone

      // Back to the stock icon: the shell shows the first image again.
      tray.setIcon({});
      const near = (pixel: number[]) => pixel.every((channel, i) => Math.abs(channel - stock.pixel[i]!) <= 8);
      let back = await shellIcon(changed);
      for (let attempt = 0; attempt < 3 && "found" in back && back.found && !near(back.pixel); attempt++) {
        await pumpFor(800);
        back = await shellIcon(changed);
      }
      expect(back).toMatchObject({ found: true });
      if (!back.found) return;
      back.pixel.forEach((channel, i) => expect(Math.abs(channel - stock.pixel[i]!)).toBeLessThanOrEqual(8));
    } finally {
      tray.dispose();
      tray.dispose();
    }
  }, 120_000);

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
      const long = unique("tooltip ").padEnd(200, "x");
      tray.setTooltip(long); // longer than the shell keeps: truncated, not refused
      // The shell shows the first 127 characters (NOTIFYICONDATAW's szTip holds 128 with its NUL).
      const shown = await shellIcon(long.slice(0, 127));
      expect(shown).toMatchObject({ found: true });

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
  }, 60_000);

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
