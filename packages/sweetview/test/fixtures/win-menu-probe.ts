// Probe for win-tabs.ts: waits for a popup menu of process <pid> to open,
// reports its items, then works it from outside, as nothing on the menu's
// own thread can while the menu's modal loop runs: with "pick:<n>" it selects
// item n and presses Enter, with "pick-id:<id>" the item whose command id is
// <id> (the system menu's SC_ values), with "close" it cancels it. Keys are
// posted to the menu window only; nothing reaches the keyboard or another
// program.
//
//   bun win-menu-probe.ts <pid> <pick:n|pick-id:id|close>
//
// Prints one line: {"items":[{"label","enabled","id","default"}...]} or {"error"}.

import { FFIType, dlopen, ptr } from "bun:ffi";

const { u64, u32, i32 } = FFIType;
const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: [u64, u64, FFIType.ptr, u64], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, FFIType.ptr], returns: u32 },
  SendMessageW: { args: [u64, u32, u64, FFIType.i64], returns: FFIType.i64 },
  PostMessageW: { args: [u64, u32, u64, FFIType.i64], returns: i32 },
  GetMenuItemCount: { args: [u64], returns: i32 },
  GetMenuStringW: { args: [u64, u32, FFIType.ptr, i32, u32], returns: i32 },
  GetMenuState: { args: [u64, u32, u32], returns: u32 },
  GetMenuItemID: { args: [u64, i32], returns: u32 },
}).symbols;

const MN_GETHMENU = 0x01e1;
const MF_BYPOSITION = 0x400;
const MF_GRAYED = 0x1;
const MF_SEPARATOR = 0x800;
const MF_DEFAULT = 0x1000;
const WM_KEYDOWN = 0x0100;
const WM_CANCELMODE = 0x001f;
const MN_SELECTITEM = 0x01e5;
const VK_RETURN = 0x0d;

const pid = Number(process.argv[2]);
const action = process.argv[3] ?? "close";
const menuClass = Buffer.from("#32768\0", "utf16le");

function findMenu(): bigint {
  for (let after = 0n; ; ) {
    const hwnd = user32.FindWindowExW(0n, after, ptr(menuClass), 0n);
    if (hwnd === 0n) return 0n;
    const owner = new Uint32Array(1);
    user32.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] === pid) return hwnd;
    after = hwnd;
  }
}

let menuWindow = 0n;
for (const end = Date.now() + 5000; Date.now() < end && menuWindow === 0n; await Bun.sleep(25)) menuWindow = findMenu();
if (menuWindow === 0n) {
  console.log(JSON.stringify({ error: "no menu opened" }));
  process.exit(1);
}
await Bun.sleep(100);
const menu = BigInt(user32.SendMessageW(menuWindow, MN_GETHMENU, 0n, 0n));
const items: { label: string; enabled: boolean; separator: boolean; id: number; isDefault: boolean }[] = [];
for (let i = 0; i < user32.GetMenuItemCount(menu); i++) {
  const text = Buffer.alloc(512);
  const length = user32.GetMenuStringW(menu, i, ptr(text), 256, MF_BYPOSITION);
  const state = user32.GetMenuState(menu, i, MF_BYPOSITION);
  items.push({
    label: text.toString("utf16le", 0, length * 2),
    enabled: (state & MF_GRAYED) === 0,
    separator: (state & MF_SEPARATOR) !== 0,
    id: user32.GetMenuItemID(menu, i),
    isDefault: (state & MF_DEFAULT) !== 0,
  });
}
const position = action.startsWith("pick-id:")
  ? items.findIndex((item) => !item.separator && item.id === Number(action.slice(8)))
  : action.startsWith("pick:")
    ? Number(action.slice(5))
    : -1;
if (position >= 0) {
  // The menu's own message selects the item by position (the cursor may be hot-tracking
  // another), and Enter chooses the selected item.
  user32.SendMessageW(menuWindow, MN_SELECTITEM, BigInt(position), 0n);
  await Bun.sleep(60);
  user32.PostMessageW(menuWindow, WM_KEYDOWN, BigInt(VK_RETURN), 0n);
} else {
  // "close", or a pick-id that names no item: cancel the menu.
  user32.PostMessageW(menuWindow, WM_KEYDOWN, 0x1bn, 0n); // Escape
  await Bun.sleep(60);
  if (findMenu() !== 0n) user32.PostMessageW(menuWindow, WM_CANCELMODE, 0n, 0n);
}
console.log(
  JSON.stringify({
    items: items.map(({ label, enabled, separator, id, isDefault }) => (separator ? { separator } : { label, enabled, id, default: isDefault })),
    ...(action.startsWith("pick") && position < 0 ? { error: `no item for ${action}` } : {}),
  }),
);
