// Pops the tray-style menu (the native module's real builder) at a fixed screen
// point so a screenshot can check the item icons, then sits there until the
// menu is dismissed or the process is ended. The cursor is not moved.
//
//   bun scripts/menu-icon-probe.ts [x y]      (default 200 400)

import { Menu } from "@n1h/sweetview-native";
import { createMessageWindow } from "@n1h/sweetview-native/win32/message-window";
import { petIcon } from "../icon";
import { PETS, petLabel } from "../pets";

const x = Number(process.argv[2] ?? 200);
const y = Number(process.argv[3] ?? 400);

const win = createMessageWindow(() => undefined);
console.log(`menu at ${x},${y}`);
const chosen = Menu.popup(
  win.hwnd,
  [
    { label: "Settings…", click: () => console.log("settings") },
    { label: "Pet", icon: petIcon("cat"), submenu: PETS.map((p) => ({ label: petLabel(p), icon: petIcon(p), checked: p === "cat" })) },
    ...PETS.slice(0, 6).map((p) => ({ label: petLabel(p), icon: petIcon(p) })),
    { type: "separator" as const },
    { label: "Quit" },
  ],
  { x, y },
);
console.log(`chosen=${chosen}`);
win.destroy();
