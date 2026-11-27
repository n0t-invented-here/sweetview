// A colour key, `#rrggbb`, becomes the window's COLORREF (0x00bbggrr); the
// parsing lives in the Rust logic crate (`sweetview-window-logic`, `color`),
// and this reads the result back from a real layered window.

import { describe, expect, test } from "bun:test";
import { Window } from "../window";

const onWindows = process.platform === "win32";

/** GetLayeredWindowAttributes: the colour key, alpha and flags of a layered window. */
async function layeredAttributes(hwnd: bigint): Promise<{ key: number; alpha: number; flags: number }> {
  const { layeredAttributes: read } = await import("../../test/win32-os");
  const attributes = read(hwnd);
  expect(attributes).not.toBeNull();
  return attributes!;
}

/**
 * test/fixtures/overlay-taskbar.ts in a process of its own, started hidden (`windowsHide`). Another
 * session's topmost window can sit over the same point, so a run whose overlay was not found there
 * is run again, up to three runs. A session with no taskbar to cover records `skipped` with the
 * reason, and the test is skipped (computed before the test, so the runner shows a skip).
 */
async function runTaskbarFixture() {
  const { fileURLToPath } = await import("node:url");
  const fixture = fileURLToPath(new URL("../../test/fixtures/overlay-taskbar.ts", import.meta.url));
  let run: { r: Record<string, unknown>; exitCode: number | null } | undefined;
  for (let attempt = 0; attempt < 3 && (run === undefined || (run.r.skipped === undefined && run.r.overlayAtPoint !== true)); attempt++) {
    const proc = Bun.spawn([process.execPath, fixture], { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`overlay-taskbar gave no result (exit ${exitCode})\n${stdout}\n${stderr}`);
    run = { r: JSON.parse(line.slice("RESULT ".length)), exitCode };
  }
  if (run!.r.skipped !== undefined) console.warn(`overlay.test: the taskbar overlay test is skipped: ${run!.r.skipped}`);
  return run!;
}
const taskbarRun = onWindows ? await runTaskbarFixture() : undefined;

describe.if(onWindows)("colorKey", () => {
  test("swaps #rrggbb into COLORREF 0x00bbggrr", async () => {
    for (const [colorKey, colorref] of [["#ff00ff", 0x00ff00ff], ["#112233", 0x00332211], ["00ff00", 0x0000ff00]] as const) {
      const win = new Window({ title: `overlay.test ${colorKey}`, frame: false, colorKey });
      try {
        const { key, flags } = await layeredAttributes(BigInt(win.handle!));
        expect(key).toBe(colorref);
        expect(flags & 0x1).toBe(0x1); // LWA_COLORKEY
      } finally {
        win.dispose();
      }
    }
  });

  test("rejects anything else", () => {
    expect(() => new Window({ colorKey: "#fff" })).toThrow("sweetview: color key must be #rrggbb, got #fff");
    expect(() => new Window({ colorKey: "magenta" })).toThrow("sweetview: color key must be #rrggbb, got magenta");
  });

  test.skipIf(taskbarRun?.r.skipped !== undefined)("a topmost overlay, the first Sweetview window of a process started hidden, is shown above the taskbar: WindowFromPoint inside the taskbar returns it, and the taskbar once it is hidden", () => {
    const { r, exitCode } = taskbarRun!;
    expect(exitCode).toBe(0);
    expect(r.rootBefore).toBe(true);
    // No window of this process existed before the first Sweetview window; with it comes the
    // event loop's own hidden window, so the overlay is not the process's only top-level window.
    expect(r.ownWindowsBeforeFirstSweetviewWindow).toEqual([]);
    expect((r.ownWindowsWithIt as unknown[]).length).toBeGreaterThan(1);
    expect(r).toMatchObject({ visible: true, topmostBit: true, overlayAtPoint: true, taskbarAtPointAfterHide: true });
  }, 60_000);

  test("opacity sets the layered alpha, alone or with a colour key", async () => {
    const win = new Window({ title: "overlay.test opacity", frame: false, opacity: 0.5, colorKey: "#010203" });
    try {
      const { key, alpha, flags } = await layeredAttributes(BigInt(win.handle!));
      expect(alpha).toBe(128);
      expect(key).toBe(0x00030201);
      expect(flags).toBe(0x1 | 0x2); // LWA_COLORKEY | LWA_ALPHA
    } finally {
      win.dispose();
    }
  });
});
