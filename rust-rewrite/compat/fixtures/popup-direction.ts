// The menu direction rows (`popupMenu`, `popupMenuAtCursor` and `showTabPopupMenu` of Part B, which
// 0.x applications reach through Part A's file-path rows), in their 1.0 form, run for real:
// `Menu.popup(owner, menu, at)` opens the menu below the point (or the cursor), its top-left corner
// there, and `Menu.popup(owner, menu, at, { above: true })` above it, its bottom-left corner there, as
// a tray menu opens. What each call asks the binding for is read by wrapping the binding's
// `popupMenu` (point and `above` flag); where the OS puts each menu is read from the open menu's
// window at a fixed point in the middle of the work area, so the cursor (which other sessions may be
// moving) plays no part. Each menu is closed with EndMenu from inside its modal loop; no input is
// injected. Prints one JSON line.

import { Menu, Screen, Window } from "@n1h/sweetview-native";
import { binding } from "../../../packages/sweetview-native/src/binding";
import { endMenu, openPopupMenu, windowRect } from "../../../packages/sweetview-native/test/win32-os";

type Rect = { left: number; top: number; right: number; bottom: number };
type Asked = { at: { x: number; y: number } | null; above: boolean };

const native = binding() as unknown as Record<string, unknown> & {
  popupMenu: (owner: bigint, data: unknown[], at: { x: number; y: number } | null, above: boolean) => number | null;
  scheduleInterval(ms: number, fn: () => void): number;
  cancelTimeout(id: number): void;
};
const realPopup = native.popupMenu;
const asked: Asked[] = [];
native.popupMenu = (owner, data, at, above) => {
  asked.push({ at: at ?? null, above: above === true });
  return realPopup.call(native, owner, data, at, above);
};

/** Calls `open`, reads the menu's window rectangle once it is shown, and closes it. */
function measure(open: () => unknown): Rect | null {
  let rect: Rect | null = null;
  const started = Date.now();
  const id = native.scheduleInterval(10, () => {
    const menuWindow = openPopupMenu();
    if (menuWindow !== 0n) {
      native.cancelTimeout(id);
      rect = windowRect(menuWindow);
      endMenu();
    } else if (Date.now() - started > 5000) {
      native.cancelTimeout(id);
    }
  });
  open();
  native.cancelTimeout(id);
  return rect;
}

const MENU = [{ label: "One" }, { label: "Two" }, { label: "Three" }];
const area = Screen.primary().workArea;
// The middle of the primary work area: room above and below, so the OS moves neither menu.
const point = { x: area.x + (area.width >> 1), y: area.y + (area.height >> 1) };
const owner = new Window({ title: "sweetview compat popup direction", noActivate: true });
const report: Record<string, unknown> = {};

// What each call asks for.
asked.length = 0;
measure(() => Menu.popup(owner, MENU));
report.menuPopupAtCursorAsks = asked[0];
asked.length = 0;
measure(() => Menu.popup(owner, MENU, point));
report.menuPopupAtPointAsks = asked[0]?.above === false && asked[0]?.at?.x === point.x && asked[0]?.at?.y === point.y;
asked.length = 0;
measure(() => Menu.popup(owner, MENU, undefined, { above: true }));
report.menuPopupAboveAtCursorAsks = asked[0];
asked.length = 0;
measure(() => Menu.popup(owner, MENU, point, { above: true }));
report.menuPopupAboveAtPointAsks = asked[0]?.above === true && asked[0]?.at?.x === point.x && asked[0]?.at?.y === point.y;

// Where the OS puts each at the same point.
const below = measure(() => Menu.popup(owner, MENU, point));
report.menuPopupOpensDownward = below !== null && below.left === point.x && below.top === point.y && below.bottom > point.y;
const publicAbove = measure(() => Menu.popup(owner, MENU, point, { above: true }));
report.menuPopupAboveOpensUpward = publicAbove !== null && publicAbove.left === point.x && publicAbove.bottom === point.y && publicAbove.top < point.y;

native.popupMenu = realPopup;
owner.dispose();
console.log(JSON.stringify(report));
process.exit(0);
