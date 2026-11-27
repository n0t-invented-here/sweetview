// The loop runner shows nothing on screen: no window, no tray. On macOS the
// activation policy is set to prohibited first, so the test process never
// gets a Dock tile from finishLaunching.

import { describe, expect, test } from "bun:test";
import { pumpEvents, quitEventLoop, runEventLoop, setActivationPolicy } from "./event-loop";

const supported = process.platform === "win32" || process.platform === "darwin";

describe("event loop", () => {
  test("intervalMs below 1 or not a number is a RangeError, before the platform is touched", () => {
    expect(() => runEventLoop({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => runEventLoop({ intervalMs: Number.NaN })).toThrow(RangeError);
  });

  test.if(!supported)("an unsupported OS throws synchronously", () => {
    expect(() => pumpEvents()).toThrow(/is not supported/);
    expect(() => runEventLoop()).toThrow(/is not supported/);
    expect(() => setActivationPolicy("accessory")).toThrow(/is not supported/);
  });

  test.if(supported)("pumpEvents with nothing queued returns true", () => {
    setActivationPolicy("prohibited");
    expect(pumpEvents()).toBe(true);
    expect(pumpEvents()).toBe(true); // a second pump reuses the launched app
  });

  test.if(supported)("runEventLoop resolves when quitEventLoop is called; a second loop at the same time throws; quit with no loop is a no-op", async () => {
    setActivationPolicy("prohibited");
    quitEventLoop();
    let settled = false;
    const loop = runEventLoop({ intervalMs: 1 }).then(() => (settled = true));
    await Bun.sleep(10); // a few pumps happen meanwhile
    expect(settled).toBe(false);
    expect(() => runEventLoop()).toThrow(/already running/);
    quitEventLoop();
    await loop;
    expect(settled).toBe(true);
  });
});
