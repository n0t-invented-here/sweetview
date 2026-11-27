// Pops the tray-style menu (the native module's real builder) at a fixed screen
// point so a screenshot can check the item icons, then sits there until the
// menu is dismissed or the process is ended. The cursor is not moved.
//
//   bun scripts/menu-icon-probe.ts [x y]      (default 200 400)

import { Menu, Window } from "@n1h/sweetview-native";
import { petIcon } from "../icon";
import { PETS, petLabel } from "../pets";

const x = Number(process.argv[2] ?? 200);
const y = Number(process.argv[3] ?? 400);

// A hidden window of this process owns the menu, as the tray's own window does.
const win = new Window({ title: "menu-icon-probe", hideFromTaskbar: true });
console.log(`menu at ${x},${y}`);
const chosen = Menu.popup(
  win,
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
win.dispose();
