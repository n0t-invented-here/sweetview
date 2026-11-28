// An application's last line is its loop: nothing after it is required, and nothing it made is
// taken from it while its process runs (decision D36). Each test runs a fixture in a process of its
// own, with a WebView2 profile and a throwaway app id of its own:
//
// - test/fixtures/app-exit.ts, once per way of ending: the process must end by itself with the
//   exit code the application set, within a few seconds of quitting, with no line on stderr from
//   Sweetview or WebView2, and what it made must be gone before the process went (the fixture
//   reads that back from the OS in an `exit` listener that runs after Sweetview's release). A
//   toast shown at Quit must still be in the notification centre afterwards, read from a second
//   process; one its notifier disposed by hand must not.
// - test/fixtures/app-loops.ts: a blocking run() inside the pumped loop, and two blocking runs one
//   after the other, keep what the application made before them.
//
// Nothing here injects input. The app ids' registry entries and notifications are removed after.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Before = { trayHeld: boolean; balloonHeld: boolean; notifierWindows: number; lockWindows: number; primary: boolean; windows: boolean };
type Gone = {
  trayHeld: boolean;
  trayWindow: boolean;
  balloonHeld: boolean;
  notifierWindows: number;
  lockWindows: number;
  windows: [boolean, boolean];
  mouseHookRemove: number;
};
type ExitResult = { mode: string; code: number; before: Before; toastPendingAtQuit: number | null; after: Gone };

/** A fixture that has not exited this long after it quit is ended (by its own process id) and the test fails. */
const EXIT_LIMIT_MS = 5_000;
const LIVE_TEST_MS = 60_000;

const appIds: string[] = [];
const newAppId = (kind: string) => {
  const id = `Sweetview.${kind}Test.${crypto.randomUUID()}`;
  appIds.push(id);
  return id;
};

/** Windows PowerShell, for the WinRT notification history PowerShell 7 cannot load. */
async function windowsPowerShell(script: string): Promise<string> {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

const LOAD_TOASTS = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;";

/** How many of `appId`'s notifications the notification centre holds, read from a process of its own. */
async function notificationsHeld(appId: string): Promise<number> {
  const out = await windowsPowerShell(`${LOAD_TOASTS} $n = 0; foreach ($t in [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${appId}')) { $n++ }; $n`);
  return Number(out.split(/\r?\n/).at(-1));
}

afterAll(async () => {
  for (const appId of appIds) {
    await windowsPowerShell(`${LOAD_TOASTS} try { [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('${appId}') } catch {}`);
    for (const key of [`HKCU\\Software\\Classes\\AppUserModelId\\${appId}`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId}`]) {
      // Exit code 1: the key was not there, which is the state wanted.
      await Bun.spawn(["reg", "delete", key, "/f"], { stdout: "ignore", stderr: "ignore" }).exited;
    }
  }
});

type Run = { exitCode: number | null; afterQuitMs: number | null; stdout: string; stderr: string };

/**
 * Runs `fixture` with `env`; `onLine` sees each stdout line as it comes. A run that has not
 * printed QUIT (or the marker `quitLine`) within 30 s, or has not exited `EXIT_LIMIT_MS` after
 * it, is ended by its own process id.
 */
async function runFixture(fixture: string, env: Record<string, string>, onLine: (line: string) => void = () => {}, quitLine = "QUIT"): Promise<Run> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-app-exit-"));
  try {
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL(`../test/fixtures/${fixture}`, import.meta.url))], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    let quitAt: number | undefined;
    let killed = false;
    let limit: Timer | undefined;
    const kill = () => {
      killed = true;
      process.kill(proc.pid);
    };
    const startLimit = setTimeout(kill, 30_000);
    const reading = (async () => {
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      let pending = "";
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const text = decoder.decode(read.value, { stream: true });
        stdout += text;
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          onLine(line);
          if (quitAt === undefined && line === quitLine) {
            quitAt = Date.now();
            clearTimeout(startLimit);
            limit = setTimeout(kill, quitLine === "QUIT" ? EXIT_LIMIT_MS : 30_000);
          }
        }
      }
    })();
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), reading]);
    const exitedAt = Date.now();
    clearTimeout(startLimit);
    clearTimeout(limit);
    return { exitCode: killed ? null : exitCode, afterQuitMs: quitAt === undefined ? null : exitedAt - quitAt, stdout, stderr };
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

const resultOf = <R>(stdout: string): R | undefined => {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  return line ? (JSON.parse(line.slice("RESULT ".length)) as R) : undefined;
};

async function runApp(mode: string) {
  const appId = newAppId("AppExit");
  const run = await runFixture("app-exit.ts", { SWEETVIEW_EXIT_TEST: mode, SWEETVIEW_EXIT_APP_ID: appId });
  return { ...run, appId, result: resultOf<ExitResult>(run.stdout) };
}

/** Everything the fixture made was there before the end, and gone before the process went. */
function expectReleased(result: ExitResult | undefined) {
  expect(result).toBeDefined();
  expect(result!.before).toMatchObject({ trayHeld: true, balloonHeld: true, notifierWindows: 2, lockWindows: 1, primary: true, windows: true });
  expect(result!.after).toEqual({
    trayHeld: false,
    trayWindow: false,
    balloonHeld: false,
    notifierWindows: 0,
    lockWindows: 0,
    windows: [false, false],
    // WEBVIEW_ERROR_NOT_FOUND: the mouse hook had been removed already.
    mouseHookRemove: 2,
  });
}

/** The toast shown at Quit, still pending then, is in the notification centre after the process ended. */
async function expectToastLeftForTheUser(run: { appId: string; result: ExitResult | undefined }) {
  expect(run.result!.toastPendingAtQuit).toBe(1);
  let held = 0;
  for (let attempt = 0; attempt < 30 && held === 0; attempt++) {
    held = await notificationsHeld(run.appId);
    if (held === 0) await Bun.sleep(100);
  }
  expect(held).toBe(1);
}

/** stderr with the lines a run is expected to print taken out. */
const unexpected = (stderr: string, expected: RegExp[] = []) =>
  stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !expected.some((re) => re.test(line)))
    .join("\n");

describe.if(process.platform === "win32")("an application with nothing after its loop", () => {
  test("quits from inside the blocking run(): ends by itself with code 0, everything gone, its last toast left in the notification centre", async () => {
    const run = await runApp("blocking");
    expect(run.exitCode).toBe(0);
    expect(run.afterQuitMs).not.toBeNull();
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(run.result!.code).toBe(0);
    expect(unexpected(run.stderr)).toBe("");
    await expectToastLeftForTheUser(run);
  }, LIVE_TEST_MS);

  test("quits the pumped loop with a worker alive and its script ends: code 0, everything gone, the toast left", async () => {
    const run = await runApp("pumped");
    expect(run.exitCode).toBe(0);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(unexpected(run.stderr)).toBe("");
    await expectToastLeftForTheUser(run);
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

  test("process.exit(7) from inside the blocking run() exits with code 7, everything gone, the toast left", async () => {
    const run = await runApp("exit");
    expect(run.exitCode).toBe(7);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(run.result!.code).toBe(7);
    expect(unexpected(run.stderr)).toBe("");
    await expectToastLeftForTheUser(run);
  }, LIVE_TEST_MS);

  test("process.exit(7) under the pumped loop exits with code 7, everything gone, the toast left", async () => {
    const run = await runApp("exit-pumped");
    expect(run.exitCode).toBe(7);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(unexpected(run.stderr)).toBe("");
    await expectToastLeftForTheUser(run);
  }, LIVE_TEST_MS);

  test("disposed by hand before Quit (tray, notifiers, second window, lock, hook): code 0, nothing logged, the same state, the toast withdrawn", async () => {
    const run = await runApp("disposed");
    expect(run.exitCode).toBe(0);
    expect(run.afterQuitMs!).toBeLessThan(EXIT_LIMIT_MS);
    expectReleased(run.result);
    expect(unexpected(run.stderr)).toBe("");
    // dispose() withdraws what is still showing, as it always did on Windows.
    expect(run.result!.toastPendingAtQuit).toBe(1);
    await Bun.sleep(1000);
    expect(await notificationsHeld(run.appId)).toBe(0);
  }, LIVE_TEST_MS);
});

// The notifier is read by what it reports itself (its window, a balloon accepted, a click that comes
// back), not by whether the shell still holds its balloon's icon, which the shell may end at any
// time (D20). That the icon is gone is read at the end only.
type Outer = { trayHeld: boolean; trayWindow: boolean; notifierWindow: boolean; notifierShows: boolean; notifierAnswers?: boolean; lockWindows: number };
type AtExit = Omit<Outer, "notifierAnswers"> & { balloonHeld: boolean };

describe.if(process.platform === "win32")("nothing is taken from an application while its process runs", () => {
  test("a blocking run() inside runEventLoop() keeps the outer tray, notifier, window and webview", async () => {
    const run = await runFixture("app-loops.ts", { SWEETVIEW_LOOPS_TEST: "nested" });
    expect(run.exitCode).toBe(0);
    expect(unexpected(run.stderr)).toBe("");
    const result = resultOf<{ afterInnerRun: Outer & { outerWindow: boolean; outerWebview: boolean; innerWebview: boolean; innerWindow: boolean }; atExit: AtExit }>(run.stdout);
    expect(result?.afterInnerRun).toEqual({
      trayHeld: true,
      trayWindow: true,
      notifierWindow: true,
      notifierShows: true,
      notifierAnswers: true,
      lockWindows: 0,
      outerWindow: true,
      outerWebview: true,
      // What run() always did when it returns: its own webview is torn down. Its window stays.
      innerWebview: false,
      innerWindow: true,
    });
    expect(result?.atExit).toMatchObject({ trayHeld: false, trayWindow: false, notifierWindow: false, balloonHeld: false, notifierShows: false });
  }, LIVE_TEST_MS);

  test("a tray, a notifier and a single-instance lock made before a first blocking run() still work during a second one", async () => {
    const appId = newAppId("AppLoops");
    let second: Promise<string> | undefined;
    const launch = () => {
      // A second launch of the same application, in a process of its own: the lock turns it away
      // and hands its arguments to the running instance, whose second run() is in progress.
      const script = `import { singleInstance } from "@n1h/sweetview";
        const lock = await singleInstance({ appId: ${JSON.stringify(appId)}, args: ["app-loops", "second-launch"] });
        console.log(JSON.stringify({ isPrimary: lock.isPrimary, handedOff: lock.handedOff }));`;
      const proc = Bun.spawn([process.execPath, "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "inherit" });
      return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out]) => out.trim());
    };
    const run = await runFixture("app-loops.ts", { SWEETVIEW_LOOPS_TEST: "two-runs", SWEETVIEW_LOOPS_APP_ID: appId }, (line) => {
      if (line === "SECOND_RUN") second = launch();
    }, "SECOND_RUN");
    expect(run.exitCode).toBe(0);
    expect(unexpected(run.stderr)).toBe("");
    expect(second).toBeDefined();
    expect(JSON.parse(await second!)).toEqual({ isPrimary: false, handedOff: true });
    const result = resultOf<{ primary: boolean; afterFirstRun: Outer; duringSecondRun: Outer & { secondInstances: string[] }; atExit: AtExit }>(run.stdout);
    expect(result?.primary).toBe(true);
    const kept = { trayHeld: true, trayWindow: true, notifierWindow: true, notifierShows: true, notifierAnswers: true, lockWindows: 1 };
    expect(result?.afterFirstRun).toEqual(kept);
    expect(result?.duringSecondRun).toEqual({ ...kept, secondInstances: ["second-launch"] });
    expect(result?.atExit).toMatchObject({ trayHeld: false, trayWindow: false, notifierWindow: false, balloonHeld: false, lockWindows: 0 });
  }, LIVE_TEST_MS);
});
