// An application's last line is its loop: nothing after it is required (decision D36). Each
// test runs test/fixtures/app-exit.ts in a process of its own, with a WebView2 profile of its
// own, and checks that the process ends by itself with the exit code the application set,
// within a few seconds of quitting, without a line on stderr Sweetview or WebView2 wrote, and
// that what it made was gone before the process went: the fixture reads that back from the OS
// in an `exit` listener that runs after Sweetview's release. Nothing here injects input.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Gone = {
  trayHeld: boolean;
  trayWindow: boolean;
  balloonHeld: boolean;
  notifierWindows: number;
  windows: [boolean, boolean];
  mouseHookRemove: number;
};
type Result = { mode: string; code: number; before: { trayHeld: boolean; balloonHeld: boolean; notifierWindows: number; windows: boolean }; after: Gone };

/** A fixture that has not exited this long after it quit is ended (by its own process id) and the test fails. */
const EXIT_LIMIT_MS = 5_000;

async function runApp(mode: string): Promise<{ exitCode: number | null; afterQuitMs: number | null; result: Result | undefined; stderr: string; stdout: string }> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-app-exit-"));
  try {
    const fixture = fileURLToPath(new URL("../test/fixtures/app-exit.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, fixture], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, SWEETVIEW_EXIT_TEST: mode },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    let quitAt: number | undefined;
    let killed = false;
    let limit: Timer | undefined;
    // Before it quits, the fixture waits for WebView2; only the time after it quit is measured.
    const startLimit = setTimeout(() => {
      killed = true;
      process.kill(proc.pid);
    }, 30_000);
    const reading = (async () => {
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        stdout += decoder.decode(read.value, { stream: true });
        if (quitAt === undefined && /^QUIT$/m.test(stdout)) {
          quitAt = Date.now();
          clearTimeout(startLimit);
          limit = setTimeout(() => {
            killed = true;
            process.kill(proc.pid);
          }, EXIT_LIMIT_MS);
        }
      }
    })();
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), reading]);
    const exitedAt = Date.now();
    clearTimeout(startLimit);
    clearTimeout(limit);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    return {
      exitCode: killed ? null : exitCode,
      afterQuitMs: quitAt === undefined ? null : exitedAt - quitAt,
      result: line ? (JSON.parse(line.slice("RESULT ".length)) as Result) : undefined,
      stderr,
      stdout,
    };
  } finally {
    // WebView2's processes can hold the profile for a moment after the fixture's exit.
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

/** Everything the fixture made was there before the end, and gone before the process went. */
function expectReleased(result: Result | undefined) {
  expect(result).toBeDefined();
  expect(result!.before).toMatchObject({ trayHeld: true, balloonHeld: true, notifierWindows: 2, windows: true });
  expect(result!.after).toEqual({
    trayHeld: false,
    trayWindow: false,
    balloonHeld: false,
    notifierWindows: 0,
    windows: [false, false],
    // WEBVIEW_ERROR_NOT_FOUND: the mouse hook had been removed already.
    mouseHookRemove: 2,
  });
}

/** stderr with the lines a run is expected to print taken out. */
const unexpected = (stderr: string, expected: RegExp[] = []) =>
  stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !expected.some((re) => re.test(line)))
    .join("\n");

const LIVE_TEST_MS = 60_000;

describe.if(process.platform === "win32")("an application with nothing after its loop", () => {
  test("quits from inside the blocking run(): ends by itself with code 0, its tray, notifiers, windows and hook gone", async () => {
    const run = await runApp("blocking");
    expect(run.exitCode).toBe(0);
    expect(run.afterQuitMs).not.toBeNull();
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(run.result!.code).toBe(0);
    expect(unexpected(run.stderr)).toBe("");
  }, LIVE_TEST_MS);

  test("quits the pumped loop with a worker alive and its script ends: ends by itself with code 0, everything gone", async () => {
    const run = await runApp("pumped");
    expect(run.exitCode).toBe(0);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(unexpected(run.stderr)).toBe("");
  }, LIVE_TEST_MS);

  test("a script that throws with everything alive exits with code 1 and no other output, everything gone", async () => {
    const run = await runApp("throw");
    expect(run.exitCode).toBe(1);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    // Bun's own report of the uncaught error: the source excerpt, the message, its stack and Bun's version.
    expect(run.stderr).toContain("app-exit: the script threw");
    expect(unexpected(run.stderr, [/^\s*\d+ \|/, /^\s*\^\s*$/, /^error: app-exit: the script threw/, /^\s+at /, /^Bun v/])).toBe("");
  }, LIVE_TEST_MS);

  test("process.exit(7) from inside the blocking run() exits with code 7, everything gone", async () => {
    const run = await runApp("exit");
    expect(run.exitCode).toBe(7);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(run.result!.code).toBe(7);
    expect(unexpected(run.stderr)).toBe("");
  }, LIVE_TEST_MS);

  test("process.exit(7) under the pumped loop exits with code 7, everything gone", async () => {
    const run = await runApp("exit-pumped");
    expect(run.exitCode).toBe(7);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(unexpected(run.stderr)).toBe("");
  }, LIVE_TEST_MS);
});
