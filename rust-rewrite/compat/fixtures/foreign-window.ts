// `Window.fromHandle` of a window that belongs to another thread (here, another
// process): the wrapper works, and subscribing to its events throws.
//
//   bun foreign-window.ts hold            makes a hidden window, prints its handle,
//                                         and keeps it until stdin closes
//   bun foreign-window.ts observe <hwnd>  wraps it; prints one JSON line

import { Window } from "@n1h/sweetview-native";

const [mode, handle] = process.argv.slice(2);
if (mode === "hold") {
  const win = new Window({ title: "sweetview compat foreign window" });
  console.log(String(win.handle));
  // Keeps the window until the parent closes stdin.
  const reader = Bun.stdin.stream().getReader();
  while (!(await reader.read()).done) {}
  win.dispose();
  process.exit(0);
}

const wrapped = Window.fromHandle(BigInt(handle!));
const report: Record<string, unknown> = { boundsPositive: wrapped.bounds().width > 0 };
for (const event of ["onClose", "onResize", "onMaximizeChange", "onMove", "onFileDrop"] as const) {
  try {
    (wrapped[event] as (fn: () => void) => () => void)(() => {});
    report[event] = "no error";
  } catch (err) {
    report[event] = (err as Error).message;
  }
}
wrapped.dispose();
console.log(JSON.stringify(report));
process.exit(0);
