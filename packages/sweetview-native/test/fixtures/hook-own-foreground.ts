// A keyboard hook must see keys typed while one of this process's own windows is in front.
// (`tao` registers its windows for raw keyboard input unless told not to, and Windows does not
// call a process's own low-level keyboard hook while a window of that process, registered for
// raw input, holds the foreground: the runtime turns that registration off.)
//
// Run in a process of its own. It shows a window, takes the foreground, injects F24 down and up
// with SendInput, and reports what the hook saw; then it hands the foreground to the taskbar and
// injects again, as the control. Usage: bun hook-own-foreground.ts window|webview

import { binding } from "../../src/binding";
import { installKeyboardHook, KeyEvent, SizeHint, Webview, Window } from "../../src/index";
import { takeForeground } from "./win32-probe";
import { FFIType, dlopen, ptr } from "bun:ffi";

const mode = process.argv[2] ?? "window";
const native = binding();
const user32 = dlopen("user32.dll", {
  SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
}).symbols;
const foregroundWindow = (): bigint => user32.GetForegroundWindow();
const wide = (s: string) => new Uint8Array(Buffer.from(s + "\0", "utf16le"));
const VK_F24 = 0x87;
const key = (up: boolean) => {
  const input = new Uint8Array(40); // INPUT, x64: type, then KEYBDINPUT at 8 (wVk, wScan, dwFlags at 12)
  const view = new DataView(input.buffer);
  view.setUint32(0, 1, true); // INPUT_KEYBOARD
  view.setUint16(8, VK_F24, true);
  view.setUint32(12, up ? 0x0002 : 0, true); // KEYEVENTF_KEYUP
  user32.SendInput(1, ptr(input), 40);
};

let handle: bigint;
let run: () => void;
let stop: () => void;
if (mode === "webview") {
  const webview = new Webview(false, { width: 420, height: 300, hint: SizeHint.NONE });
  webview.title = "hook-own-foreground";
  webview.setHTML("<!doctype html><p>hook-own-foreground</p>");
  handle = BigInt(webview.unsafeWindowHandle as number);
  run = () => webview.run();
  stop = () => webview.destroy();
} else {
  const win = new Window({ title: "hook-own-foreground", bounds: { x: 220, y: 220, width: 420, height: 300 } });
  win.show();
  handle = BigInt(win.handle!);
  run = () => native.runLoop();
  stop = () => {
    win.dispose();
    native.quitLoop();
  };
}

const seen: string[] = [];
const hook = installKeyboardHook((m) => {
  if (m.raw === VK_F24) seen.push(m.event === KeyEvent.Down ? "down" : m.event === KeyEvent.Up ? "up" : "repeat");
  return true; // swallowed, so F24 reaches nothing else on the desktop
});
const result: Record<string, unknown> = {};
let before = 0;
let ours = false;
const steps: (() => void)[] = [
  () => {},
  () => void takeForeground(handle),
  () => void takeForeground(handle),
  () => {
    before = seen.length;
    ours = foregroundWindow() === handle;
    key(false);
    key(true);
  },
  () => (result.inFront = { foregroundIsOurs: ours, saw: seen.slice(before) }),
  () => void user32.SetForegroundWindow(user32.FindWindowW(ptr(wide("Shell_TrayWnd")), null)),
  () => {
    before = seen.length;
    ours = foregroundWindow() === handle;
    key(false);
    key(true);
  },
  () => (result.behind = { foregroundIsOurs: ours, saw: seen.slice(before) }),
  () => {
    hook.dispose();
    console.log(`RESULT ${JSON.stringify(result)}`);
    stop();
  },
];
// One step per tick; native intervals fire inside the blocking loop.
native.scheduleInterval(350, () => steps.shift()?.());
// The limit: whatever happens, the hook goes and the process ends.
native.scheduleTimeout(20_000, () => {
  hook.dispose();
  console.log(`RESULT ${JSON.stringify({ ...result, limit: true })}`);
  process.exit(1);
});
run();
process.exit(0);
