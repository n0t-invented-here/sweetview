// The new form of every docs/upgrading.md row that says "declare your own
// table": an application's own `bun:ffi` table, opened and called from a Bun
// timer while Sweetview's event loop runs (`runEventLoop`). Each library named
// on the command line is opened with one harmless function of its own.
// Prints one JSON line: { inLoop, calls: { "<lib>": "ok" | "<what failed>" } }.

import { FFIType, dlopen } from "bun:ffi";
import { quitEventLoop, runEventLoop } from "@n1h/sweetview-native";

type Probe = { symbols: Parameters<typeof dlopen>[1]; call(lib: { symbols: Record<string, (...args: never[]) => unknown> }): boolean };

const out = new Int32Array(1);
const PROBES: Record<string, Probe> = {
  "user32.dll": { symbols: { GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 } }, call: (l) => (l.symbols.GetSystemMetrics as (i: number) => number)(0) > 0 },
  "kernel32.dll": { symbols: { GetCurrentThreadId: { args: [], returns: FFIType.u32 } }, call: (l) => (l.symbols.GetCurrentThreadId as () => number)() > 0 },
  "comctl32.dll": { symbols: { GetMUILanguage: { args: [], returns: FFIType.u16 } }, call: (l) => (l.symbols.GetMUILanguage as () => number)() >= 0 },
  "ole32.dll": { symbols: { CoGetCurrentProcess: { args: [], returns: FFIType.u32 } }, call: (l) => (l.symbols.CoGetCurrentProcess as () => number)() > 0 },
  "shcore.dll": { symbols: { GetScaleFactorForDevice: { args: [FFIType.i32], returns: FFIType.i32 } }, call: (l) => (l.symbols.GetScaleFactorForDevice as (d: number) => number)(0) >= 100 },
  "dwmapi.dll": { symbols: { DwmIsCompositionEnabled: { args: [FFIType.ptr], returns: FFIType.i32 } }, call: (l) => (l.symbols.DwmIsCompositionEnabled as (p: Int32Array) => number)(out) === 0 },
  "advapi32.dll": {
    symbols: { GetUserNameW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } },
    call: (l) => (l.symbols.GetUserNameW as (b: Uint16Array, n: Uint32Array) => number)(new Uint16Array(257), new Uint32Array([257])) !== 0,
  },
  "gdi32.dll": { symbols: { GetStockObject: { args: [FFIType.i32], returns: FFIType.u64 } }, call: (l) => (l.symbols.GetStockObject as (i: number) => bigint)(0) !== 0n },
  "shell32.dll": { symbols: { IsUserAnAdmin: { args: [], returns: FFIType.i32 } }, call: (l) => typeof (l.symbols.IsUserAnAdmin as () => number)() === "number" },
};

const calls: Record<string, string> = {};
let inLoop = false;
const loop = runEventLoop({ intervalMs: 5 });
setTimeout(() => {
  inLoop = true;
  for (const name of process.argv.slice(2)) {
    const probe = PROBES[name];
    if (!probe) {
      calls[name] = "no probe for this library in fixtures/own-ffi.ts";
      continue;
    }
    try {
      const lib = dlopen(name, probe.symbols);
      calls[name] = probe.call(lib as never) ? "ok" : "the call returned an unexpected value";
      lib.close();
    } catch (err) {
      calls[name] = (err as Error).message;
    }
  }
  quitEventLoop();
}, 50);
await loop;
console.log(JSON.stringify({ inLoop, calls }));
