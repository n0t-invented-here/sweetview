import { dlopen, FFIType } from "bun:ffi";
const n = require("./spike.node");
const out: Record<string, unknown> = { bun: Bun.version, platform: process.platform };

// ---- Question 1: JS called from native while the JS thread is inside the blocking tao loop
let jsCalls = 0;
let insideLoop = true;
const t0 = performance.now();
let q1: string;
try {
  q1 = n.runBlocking((message: string) => {
    jsCalls++;
    return `pong<${message}> insideLoop=${insideLoop}`;
  });
} catch (e) {
  q1 = "THREW: " + (e as Error).message;
}
insideLoop = false;
out.q1_result = q1;
out.q1_jsCalls = jsCalls;
out.q1_ms = Math.round(performance.now() - t0);

// ---- Question 2: tray events under a timer-pumped loop, with no window
n.initTray();
const { u64, u32, i32, i64, ptr } = FFIType;
const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: [u64, u64, ptr, ptr], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, ptr], returns: u32 },
  PostMessageW: { args: [u64, u32, u64, i64], returns: i32 },
}).symbols;
const wide = (s: string) => new Uint8Array(new Uint16Array([...s].map((c) => c.charCodeAt(0)).concat(0)).buffer);
function trayWindow(): bigint {
  const cls = wide("tray_icon_app");
  const pid = new Uint32Array(1);
  let h = 0n;
  for (let i = 0; i < 500; i++) {
    h = BigInt(user32.FindWindowExW(0n, h, cls, null));
    if (h === 0n) return 0n;
    user32.GetWindowThreadProcessId(h, pid);
    if (pid[0] === process.pid) return h;
  }
  return 0n;
}
const WM_USER_TRAYICON = 6002;
const hwnd = trayWindow();
out.q2_trayWindowFound = hwnd !== 0n;

const events: string[] = [];
let ticks = 0;
let timersFired = 0;
let promisesSettled = 0;
let posted = 0;
const side = setInterval(() => {
  timersFired++;
  Promise.resolve().then(() => promisesSettled++);
}, 10);

const timer = setInterval(() => {
  ticks++;
  try {
    n.pump((text: string) => events.push(text));
  } catch (e) {
    events.push("PUMP THREW: " + (e as Error).message);
  }
  if (hwnd !== 0n && (ticks === 10 || ticks === 30)) {
    // what the shell posts for a left click on the icon, then a right click
    for (const mouse of ticks === 10 ? [0x0201, 0x0202] : [0x0204, 0x0205]) {
      if (user32.PostMessageW(hwnd, WM_USER_TRAYICON, 0n, BigInt(mouse)) !== 0) posted++;
    }
  }
  if (ticks >= 70) {
    clearInterval(timer);
    clearInterval(side);
    out.q2_ticks = ticks;
    out.q2_messagesPosted = posted;
    out.q2_eventsDelivered = events.length;
    out.q2_events = events.map((e) => e.replace(/\s+/g, " ").slice(0, 110));
    out.q2_bunTimersFiredMeanwhile = timersFired;
    out.q2_bunPromisesSettledMeanwhile = promisesSettled;
    n.dropTray();
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
  }
}, 16);
setTimeout(() => {
  console.log(JSON.stringify({ ...out, WATCHDOG: "did not finish in 30s", ticks, events }, null, 1));
  process.exit(3);
}, 30000);
