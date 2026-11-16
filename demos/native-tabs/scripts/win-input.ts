// Real mouse and keyboard input for scripts/win-drive.ts, from a process of
// its own: a drag hands the app's thread to the window manager until the
// button comes up, so the hand that moves the mouse cannot be on that thread.
//
//   bun run scripts/win-input.ts <pid> '<steps as JSON>'
//
// Steps: ["move", x, y] (screen pixels), ["down"], ["up"], ["middle"],
// ["right"], ["key", vk, ...] (a chord: pressed in order, released in
// reverse), ["wait", ms].
//
// This is the whole machine's mouse and keyboard, and other programs are
// running on it. So before every step the foreground window must belong to
// <pid>; when it does not, whatever is held is let go and the script exits
// with 3, having sent nothing to anyone else.

import { FFIType, dlopen } from "bun:ffi";

const { u64, u32, i32, ptr } = FFIType;
const user32 = dlopen("user32.dll", {
  GetForegroundWindow: { args: [], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, ptr], returns: u32 },
  GetCursorPos: { args: [ptr], returns: i32 },
  SetCursorPos: { args: [i32, i32], returns: i32 },
  GetSystemMetrics: { args: [i32], returns: i32 },
  SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: i32 },
  // (DWORD flags, DWORD dx, DWORD dy, DWORD data, ULONG_PTR extra)
  mouse_event: { args: [u32, u32, u32, u32, u64], returns: FFIType.void },
  // (BYTE vk, BYTE scan, DWORD flags, ULONG_PTR extra)
  keybd_event: { args: [FFIType.u8, FFIType.u8, u32, u64], returns: FFIType.void },
}).symbols;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

type Step = ["move", number, number] | ["down"] | ["up"] | ["middle"] | ["right"] | ["key", ...number[]] | ["wait", number];

const pid = Number(process.argv[2]);
const steps = JSON.parse(process.argv[3] ?? "[]") as Step[];
user32.SetProcessDpiAwarenessContext(-4n); // per-monitor: the coordinates are real pixels

const ours = () => {
  const owner = new Uint32Array(1);
  user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), owner);
  return owner[0] === pid;
};

let held = false;
const keysDown: number[] = [];
const letGo = () => {
  if (held) user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n);
  for (const vk of keysDown.reverse()) user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0n);
  held = false;
  keysDown.length = 0;
};

const start = new Int32Array(2);
user32.GetCursorPos(start);
let code = 0;
for (const step of steps) {
  if (step[0] === "wait") {
    await Bun.sleep(step[1]);
    continue;
  }
  if (!ours()) {
    code = 3;
    break;
  }
  switch (step[0]) {
    case "move": {
      // absolute, over the whole desktop, in 0..65535
      const x = Math.round(((step[1] - user32.GetSystemMetrics(SM_XVIRTUALSCREEN)) * 65535) / (user32.GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1));
      const y = Math.round(((step[2] - user32.GetSystemMetrics(SM_YVIRTUALSCREEN)) * 65535) / (user32.GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1));
      user32.mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y, 0, 0n);
      break;
    }
    case "down":
      user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0n);
      held = true;
      break;
    case "up":
      user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n);
      held = false;
      break;
    case "middle":
      user32.mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0n);
      user32.mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0n);
      break;
    case "right":
      user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0n);
      user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0n);
      break;
    case "key": {
      const chord = step.slice(1) as number[];
      for (const vk of chord) {
        user32.keybd_event(vk, 0, 0, 0n);
        keysDown.push(vk);
      }
      for (const vk of chord.toReversed()) user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0n);
      keysDown.length = 0;
      break;
    }
  }
  await Bun.sleep(12); // the system takes each event in before the next
}
letGo();
user32.SetCursorPos(start[0]!, start[1]!); // the cursor back where it was found
process.exit(code);
