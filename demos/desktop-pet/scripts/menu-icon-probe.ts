// Pops the tray-style menu (the native module's real builder) at a fixed screen
// point so a screenshot can check the item icons, then sits there until the
// menu is dismissed or the process is ended.
//
//   bun scripts/menu-icon-probe.ts [x y]      (default 200 400)

import { dlopen, FFIType } from "bun:ffi";
import { createMessageWindow } from "../../../src/native/win32/message-window";
import { popupMenuAtCursor } from "../../../src/native/win32/menu";
import { petIcon } from "../icon";
import { PETS, petLabel } from "../pets";

const x = Number(process.argv[2] ?? 200);
const y = Number(process.argv[3] ?? 400);
const { SetCursorPos } = dlopen("user32.dll", { SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols;

const win = createMessageWindow(() => undefined);
SetCursorPos(x, y);
console.log(`menu at ${x},${y}`);
const chosen = popupMenuAtCursor(win.hwnd, [
  { label: "Settings…", click: () => console.log("settings") },
  { label: "Pet", icon: petIcon("cat"), submenu: PETS.map((p) => ({ label: petLabel(p), icon: petIcon(p), checked: p === "cat" })) },
  ...PETS.slice(0, 6).map((p) => ({ label: petLabel(p), icon: petIcon(p) })),
  { type: "separator" as const },
  { label: "Quit" },
]);
console.log(`chosen=${chosen}`);
win.destroy();
