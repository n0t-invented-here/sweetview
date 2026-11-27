// Checklist item W3.5: the bindings' examples/input-hooks.ts, brought over
// unchanged as examples/input-hooks.ts (its `../src/index` import names this
// package's index from there too), runs against this package: it starts,
// installs both hooks, shows its window, and exits when the window is closed.
// The window is closed by posting WM_CLOSE to it, found by title and process.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as probe from "../test/fixtures/win32-probe";

test.if(process.platform === "win32")("W3.5 examples/input-hooks.ts starts, shows its window and exits when the window is closed", async () => {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-example-"));
  const example = fileURLToPath(new URL("../examples/input-hooks.ts", import.meta.url));
  const proc = Bun.spawn([process.execPath, example], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let hwnd: bigint | null = null;
    for (const deadline = Date.now() + 20_000; hwnd === null && Date.now() < deadline; ) {
      await Bun.sleep(100);
      hwnd = probe.topLevelWindowOf(proc.pid, "Input hooks");
    }
    expect(hwnd).not.toBeNull();
    // Shown, and given the page time to load.
    await Bun.sleep(1_500);
    expect(probe.isVisible(hwnd)).toBe(true);
    expect(probe.windowText(hwnd)).toBe("Input hooks");
    expect(probe.postMessage(hwnd, probe.WM_CLOSE)).toBe(true);
    const exit = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "still running" as const)]);
    if (exit === "still running") proc.kill();
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    console.log(`exit: ${exit}\nstdout: ${stdout.trim() || "(empty)"}\nstderr: ${stderr.trim() || "(empty)"}`);
    expect(exit).toBe(0);
    // The hooks installed: the example logs a warning when they do not.
    expect(stderr).not.toContain("input hooks off");
    expect(probe.isWindow(hwnd)).toBe(false);
  } finally {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
}, 60_000);
