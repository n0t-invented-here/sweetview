// An application whose start-up failed ends by itself (decision D46): under
// runEventLoop, the loop holds the process only while the application has
// something a person can reach. Each test runs test/fixtures/loop-ends.ts in a
// process of its own, with a WebView2 profile of its own. Nothing here injects
// input.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A fixture still running this long is ended (by its own process id) and its test fails. */
const LIMIT_MS = 15_000;

async function run(mode: string): Promise<{ exitCode: number | null; stdout: string; stderr: string; ms: number }> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-loop-ends-"));
  try {
    const started = Date.now();
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/loop-ends.ts", import.meta.url))], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, SWEETVIEW_LOOP_TEST: mode },
      stdout: "pipe",
      stderr: "pipe",
    });
    let killed = false;
    const limit = setTimeout(() => {
      killed = true;
      process.kill(proc.pid);
    }, LIMIT_MS);
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(limit);
    return { exitCode: killed ? null : exitCode, stdout, stderr, ms: Date.now() - started };
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
}

describe.if(process.platform === "win32")("the pumped loop holds the process only while something can be reached (D46)", () => {
  for (const mode of ["failed-tab", "failed-app", "last-window"]) {
    test(
      `${mode}: with nothing left to reach, the process ends by itself with the code the application set`,
      async () => {
        const result = await run(mode);
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toBe("");
        // The loop ended by itself: the code after it ran.
        expect(result.stdout).toContain("LOOP-RESOLVED");
        expect(result.stdout).not.toContain("STILL");
        if (mode !== "last-window") expect(result.stdout).toContain("CAUGHT ");
        // The window it made was released before the process went.
        if (mode !== "failed-app") expect(result.stdout).toContain('"windowExists":false');
      },
      LIMIT_MS + 5_000,
    );
  }

  for (const mode of ["tray", "visible", "hidden-after", "webview", "hidden-window"]) {
    test(
      `${mode}: the loop keeps the process running`,
      async () => {
        const result = await run(mode);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("STILL");
        expect(result.stdout).toContain("LOOP-RESOLVED");
        expect(result.stdout).toContain('"windowExists":false');
      },
      LIMIT_MS + 5_000,
    );
  }
});
