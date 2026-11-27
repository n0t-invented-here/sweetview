// Windows. Starts this demo, then drives its tray icon the way the shell and the
// keyboard would: messages posted to the app's own tray-icon window and popup
// menu, so nothing moves the cursor or presses a key system-wide. Opens the menu,
// dismisses it, checks "Clock in Tooltip", then quits, and writes what it saw.
//
//   bun scripts/tray-drive.ts . bun run app.ts                                   (from source)
//   bun scripts/tray-drive.ts dist dist/menubar-only-windows-x64.exe             (compiled)
//
// DRIVE_LOG names the file the log is written to (default drive-log.txt).
import { FFIType, dlopen, ptr } from "bun:ffi";
const { u64, u32, i32, i64 } = FFIType;
const u = dlopen("user32.dll", {
  FindWindowExW: { args: [u64, u64, FFIType.ptr, FFIType.ptr], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, FFIType.ptr], returns: u32 },
  IsWindowVisible: { args: [u64], returns: i32 },
  PostMessageW: { args: [u64, u32, u64, i64], returns: i32 },
  SendMessageW: { args: [u64, u32, u64, i64], returns: i64 },
  GetMenuItemCount: { args: [u64], returns: i32 },
  GetMenuState: { args: [u64, u32, u32], returns: u32 },
  GetMenuStringW: { args: [u64, u32, FFIType.ptr, i32, u32], returns: i32 },
}).symbols;
const wide = (s: string) => new Uint8Array(Buffer.from(s + "\0", "utf16le"));
const windowsOf = (pid: number, cls: string) => {
  const out: bigint[] = []; const p = new Uint32Array(1); let h = 0n; const c = wide(cls);
  for (;;) { h = u.FindWindowExW(0n, h, c, null); if (!h) break; u.GetWindowThreadProcessId(h, ptr(p)); if (p[0] === pid) out.push(h); }
  return out;
};
const sleep = (ms: number) => Bun.sleep(ms);
async function waitFor<T>(what: string, get: () => T | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = get(); if (v !== undefined) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
const readMenu = (h: bigint) => {
  const n = u.GetMenuItemCount(h); const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const st = u.GetMenuState(h, i, 0x400); const b = new Uint16Array(256); const len = u.GetMenuStringW(h, i, ptr(b), 256, 0x400);
    const label = String.fromCharCode(...b.subarray(0, Math.max(0, len)));
    out.push(st & 0x800 ? "----" : `${label}${st & 8 ? " [checked]" : ""}${st & 3 ? " [disabled]" : ""}`);
  }
  return out;
};
const [cwd, ...cmd] = process.argv.slice(2);
const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };
const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
note(`started: ${cmd.map((c) => c.replace(/^.*[\/]/, "")).join(" ")}`);
try {
  const tray = await waitFor("the tray icon's window", () => windowsOf(child.pid, "tray_icon_app")[0]);
  note("tray icon window found (class tray_icon_app) in the app's process");
  const RBUTTONDOWN = 0x204, RBUTTONUP = 0x205, KEYDOWN = 0x100, DOWN = 0x28, RETURN = 0x0d, ESCAPE = 0x1b;
  const rightClick = () => { u.PostMessageW(tray, 6002, 0n, BigInt(RBUTTONDOWN)); u.PostMessageW(tray, 6002, 0n, BigInt(RBUTTONUP)); };
  const openMenu = async () => { rightClick(); const w = await waitFor("the menu", () => windowsOf(child.pid, "#32768").find((h) => u.IsWindowVisible(h))); await sleep(150); return w; };
  const keys = (w: bigint, ...k: number[]) => k.forEach((key) => u.PostMessageW(w, KEYDOWN, BigInt(key), 1n));
  const closed = () => waitFor("the menu to close", () => (windowsOf(child.pid, "#32768").some((h) => u.IsWindowVisible(h)) ? undefined : true));

  let w = await openMenu();
  note(`right click -> menu: ${JSON.stringify(readMenu(BigInt.asUintN(64, u.SendMessageW(w, 0x1e1, 0n, 0n))))}`);
  keys(w, ESCAPE); await closed(); note("Escape -> menu closed, nothing chosen");
  await sleep(1200);
  w = await openMenu();
  note(`right click again -> menu: ${JSON.stringify(readMenu(BigInt.asUintN(64, u.SendMessageW(w, 0x1e1, 0n, 0n))))}`);
  keys(w, DOWN, DOWN, RETURN); await closed(); note("Down, Down, Return -> chose 'Clock in Tooltip'");
  w = await openMenu();
  note(`right click again -> menu: ${JSON.stringify(readMenu(BigInt.asUintN(64, u.SendMessageW(w, 0x1e1, 0n, 0n))))}`);
  keys(w, DOWN, DOWN, DOWN, RETURN); await closed(); note("Down, Down, Down, Return -> chose 'Quit Menubar Only'");
  const code = await Promise.race([child.exited, sleep(10000).then(() => "still running")]);
  note(`process exit: ${code}`);
  const err = (await new Response(child.stderr).text()).trim();
  note(`stderr: ${err === "" ? "(empty)" : err}`);
} catch (e) {
  note(`FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) { child.kill(); note("killed the app (by its PID)"); }
}
await Bun.write(process.env.DRIVE_LOG ?? "drive-log.txt", log.join("\n") + "\n");
