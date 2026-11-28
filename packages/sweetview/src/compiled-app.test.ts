// A whole application compiled to one executable, as an application ships it: the web-app demo
// built by its own recipe (`just demos web-app compile-win`, from the repository root), the executable
// copied alone into a new empty folder under the system temp directory, started from there, its
// window read from the OS, and the process ended. `rust-rewrite/PORT-STATUS.md` section 3 row "A
// whole application compiled to one executable".

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const onWindows = process.platform === "win32";
const repo = fileURLToPath(new URL("../../..", import.meta.url));

/** The title of each visible top-level window of process `pid`. */
async function visibleWindowsOf(pid: number): Promise<string[]> {
  const { user32 } = await import("../../sweetview-native/test/win32-os");
  const { ptr } = await import("bun:ffi");
  const owner = new Uint32Array(1);
  const text = new Uint16Array(256);
  const titles: string[] = [];
  let after = 0n;
  for (let i = 0; i < 20_000; i++) {
    after = user32.FindWindowExW(0n, after, null, null);
    if (after === 0n) break;
    user32.GetWindowThreadProcessId(after, ptr(owner));
    if (owner[0] !== pid || user32.IsWindowVisible(after) === 0) continue;
    const length = user32.GetWindowTextW(after, ptr(text), text.length);
    titles.push(String.fromCharCode(...text.subarray(0, length)));
  }
  return titles;
}

describe.if(onWindows)("a compiled application (win32, live)", () => {
  test("the web-app demo's compile recipe gives one executable that, copied alone into an empty folder and started there, shows its window", async () => {
    const built = spawnSync("just", ["demos", "web-app", "compile-win"], { cwd: repo, encoding: "utf8", timeout: 600_000 });
    expect({ status: built.status, error: built.error?.message }).toEqual({ status: 0, error: undefined });
    const folder = mkdtempSync(join(tmpdir(), "sweetview-compiled-"));
    const exe = join(folder, "web-app-windows-x64.exe");
    copyFileSync(join(repo, "demos/web-app/dist/web-app-windows-x64.exe"), exe);
    expect(readdirSync(folder)).toEqual(["web-app-windows-x64.exe"]);
    // Nothing of this checkout reaches it: no binding path, and the folder is its working directory.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.SWEETVIEW_NATIVE_PATH;
    const app = Bun.spawn([exe], { cwd: folder, env, stdout: "ignore", stderr: "pipe" });
    try {
      let titles: string[] = [];
      for (const end = performance.now() + 30_000; performance.now() < end && !titles.includes("Web App"); await Bun.sleep(250)) {
        titles = await visibleWindowsOf(app.pid);
      }
      expect({ titles, exited: app.exitCode }).toEqual({ titles: expect.arrayContaining(["Web App"]), exited: null });
    } finally {
      app.kill();
      await Promise.race([app.exited, Bun.sleep(10_000)]);
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {}
    }
  }, 700_000);
});
