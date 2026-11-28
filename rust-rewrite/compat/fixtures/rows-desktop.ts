// R2: runs the guide rows whose runners (row-runners.ts) need the desktop: a
// window, a webview, the tray, the clipboard, an input hook, a dialog or the
// event loop. A process of its own on a WebView2 profile of its own, started
// by upgrade-guide.test.ts with a JSON file of jobs (argv[2]). Every call has
// a limit; every window, webview, hook and registration it makes is removed
// before it exits; the clicks it injects land on a window of its own, and
// every button or key it sends down is let go on every way out. Prints `RESULT <json>`: per job key,
// "ok", "ok: <note>" or "error: <why>".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNERS, scratch, type DesktopCtx } from "./row-runners";
import { Window, installKeyboardHook, installMouseHook, quitEventLoop, runEventLoop } from "@n1h/sweetview-native";
import { RawWebview as Webview } from "@n1h/sweetview";
import { scheduleNativeTimeout } from "../../../packages/sweetview-native/src/internal";

type Job = { key: string; target: string; name: string; spec: string };
const jobs: Job[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const results: Record<string, string> = {};
const say = (line: string) => process.stderr.write(`${line}\n`);

const os = await import("../../../packages/sweetview-native/test/win32-os");
const work = scratch();
const loop = runEventLoop({ intervalMs: 5 });
let loopTicked = false;
scheduleNativeTimeout(10, () => (loopTicked = true));
const finish = (code: number) => {
  console.log(`RESULT ${JSON.stringify(results)}`);
  process.exit(code);
};
// The whole run's limit: a native timeout, so it fires inside a modal loop too.
scheduleNativeTimeout(240_000, () => {
  releaseInput();
  os.endMenu();
  results["(run)"] = "error: the run passed its limit";
  finish(1);
});

const until = async (condition: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (condition()) return true;
  return condition();
};

// ---- what one runner made, removed after it -----------------------------------------------------------------
let made: { windows: Window[]; views: Webview[] } = { windows: [], views: [] };
const cleanUp = () => {
  for (const view of made.views) {
    try {
      if (view.unsafeHandle !== null) view.destroy();
    } catch {}
  }
  for (const win of made.windows) {
    try {
      win.dispose();
    } catch {}
  }
  made = { windows: [], views: [] };
};

const answers = new Map<number, (value: string) => void>();
let asked = 0;

// ---- the app the page rows run in, made once ---------------------------------------------------------------------
let page: Promise<{ app: import("@n1h/sweetview").App; report: Record<string, any> }> | undefined;
const pageApp = () =>
  (page ??= (async () => {
    const { createApp, indexHtml, windowChromeMethods } = await import("@n1h/sweetview");
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "rows-page.ts")], target: "browser", format: "esm" });
    if (!built.success) throw new Error(`the page did not build: ${built.logs.join("\n")}`);
    const code = await built.outputs[0]!.text();
    let resolveReport!: (r: Record<string, any>) => void;
    const reported = new Promise<Record<string, any>>((r) => (resolveReport = r));
    let app: import("@n1h/sweetview").App | undefined;
    const win = () => app!.window;
    const chrome = windowChromeMethods({
      hide: () => win().hide(),
      isMaximized: () => win().isMaximized(),
      startDrag: () => win().startDrag(),
      startResize: (edge) => win().startResize(edge),
      minimize: () => win().minimize(),
      toggleMaximize: () => win().toggleMaximize(),
    });
    app = await createApp({
      title: `sweetview compat rows ${process.pid}`,
      bounds: { x: 120, y: 120, width: 480, height: 320 },
      noActivate: true,
      // A string asset is a path: the bundle and the empty style go in as bytes.
      assets: { "index.html": indexHtml({ title: "rows" }), "main.js": new TextEncoder().encode(code), "main.css": new Uint8Array(0) },
      uiMethods: { ...chrome, "rows.report": (r: Record<string, any>) => resolveReport(r) } as never,
      worker: join(import.meta.dir, "rows-worker.ts"),
      onRequest: "worker",
    });
    const report: Record<string, any> = await Promise.race([reported, Bun.sleep(30_000).then(() => ({ error: "the page never reported" }))]);
    // Out of the way of the rows that count the visible windows.
    await until(() => os.user32.IsIconic(BigInt(app!.window.handle!)) !== 0, 3000);
    report.minimisedByPage = os.user32.IsIconic(BigInt(app!.window.handle!)) !== 0;
    app.window.hide();
    return { app, report };
  })());

// ---- the input hooks: injected input over a window of the run's own ------------------------------------------------
// Nothing is swallowed: a hook that swallows an up it gets in time, after the OS passed the down on
// unseen (a hook past its time), leaves the button down for the whole desktop. Instead the cursor is
// put over a topmost window of this run's own, so the clicks and the wheel land there; F24 (no
// keyboard has it) goes to whichever window has the focus and means nothing to it. Each button or
// key sent down is let go on every way out: the injection's own finally, the run's limit (released
// first) and the process's exit.
const held = new Set<string>();
let sendRelease: (what: string) => void = () => {};
function releaseInput(): void {
  for (const what of [...held]) sendRelease(what);
  held.clear();
}
process.on("exit", releaseInput);
let hooks: Promise<{ mouse: number[]; keys: number[]; keyCodes: string[] }> | undefined;
const hookRun = () =>
  (hooks ??= (async () => {
    const mouse: number[] = [];
    const keys: number[] = [];
    const keyCodes: string[] = [];
    let recording = false;
    const mouseHook = installMouseHook((m) => {
      if (recording) mouse.push(m.event);
      return false;
    });
    const keyHook = installKeyboardHook((k) => {
      if (recording && k.raw === 0x87) {
        keys.push(k.event);
        keyCodes.push(k.code);
      }
      return false;
    });
    // The window the clicks land on: topmost, never activated, nothing in it acts on a click.
    const target = new Window({ title: `sweetview compat input ${process.pid}`, noActivate: true, topmost: true, frame: false, bounds: { x: 200, y: 200, width: 240, height: 160 } });
    target.show();
    const targetHwnd = BigInt(target.handle!);
    const original = os.cursor();
    const { Screen } = await import("@n1h/sweetview-native");
    // Another session's input on the shared desktop can be in the way: such an attempt is
    // dropped and made again (up to four times), each with the desktop's buttons up first.
    const allMouse = [0, 1, 2, 3, 4, 5, 6, 7];
    try {
      await Bun.sleep(300); // the hooks are in place before the first event
      for (let attempt = 0; attempt < 4; attempt++) {
        for (let i = 0; i < 30 && os.buttonsDown(); i++) await Bun.sleep(100);
        os.injectCursorMove(320, 280, Screen.bounds());
        await Bun.sleep(60);
        if (os.buttonsDown() || os.windowAt(320, 280) !== targetHwnd) {
          say(`hooks: attempt ${attempt + 1} not made: a button was down or another window was over the run's own`);
          await Bun.sleep(700);
          continue;
        }
        mouse.length = 0;
        keys.length = 0;
        keyCodes.length = 0;
        await injectOnce();
        if (allMouse.every((e) => mouse.includes(e)) && keys.length === 3) break;
        say(`hooks: attempt ${attempt + 1} saw mouse ${JSON.stringify(mouse)} keys ${JSON.stringify(keys)}; another session's input may have been in the way`);
        await Bun.sleep(700);
      }
    } finally {
      releaseInput();
      recording = false;
      mouseHook.dispose();
      keyHook.dispose();
      target.dispose();
      os.user32.SetCursorPos(original.x, original.y);
    }
    return { mouse, keys, keyCodes };

    async function injectOnce() {
      const rawMouse = (flags: number, data = 0) => {
        const input = new Uint8Array(40);
        const view = new DataView(input.buffer);
        view.setUint32(0, 0, true); // INPUT_MOUSE
        view.setInt32(16, data, true); // mouseData
        view.setUint32(20, flags, true);
        os.user32.SendInput(1, input, 40);
      };
      const rawKey = (up: boolean) => {
        const input = new Uint8Array(40);
        const view = new DataView(input.buffer);
        view.setUint32(0, 1, true); // INPUT_KEYBOARD
        view.setUint16(8, 0x87, true); // VK_F24
        view.setUint32(12, up ? 0x2 : 0, true); // KEYEVENTF_KEYUP
        os.user32.SendInput(1, input, 40);
      };
      // Each down's up: LEFTDOWN 0x2 -> 0x4, RIGHTDOWN 0x8 -> 0x10, MIDDLEDOWN 0x20 -> 0x40.
      const ups: Record<number, number> = { 0x2: 0x4, 0x8: 0x10, 0x20: 0x40 };
      sendRelease = (what) => (what === "F24" ? rawKey(true) : rawMouse(Number(what)));
      recording = true;
      try {
        // A move onto the window, each button down and straight up again, one notch of the wheel.
        os.injectCursorMove(321, 281, Screen.bounds());
        await Bun.sleep(40);
        for (const [down, up] of [[0x2, 0x4], [0x8, 0x10], [0x20, 0x40]] as const) {
          held.add(String(ups[down]));
          try {
            rawMouse(down);
            await Bun.sleep(30);
          } finally {
            rawMouse(up);
            held.delete(String(up));
          }
          await Bun.sleep(30);
        }
        rawMouse(0x800, 120);
        held.add("F24");
        try {
          rawKey(false);
          await Bun.sleep(40);
          rawKey(false); // held: a repeat
          await Bun.sleep(40);
        } finally {
          rawKey(true);
          held.delete("F24");
        }
        await until(() => keys.length >= 3 && mouse.includes(7), 2000);
        await Bun.sleep(100);
      } finally {
        releaseInput();
        recording = false;
      }
    }
  })());

const ctx: DesktopCtx = {
  os,
  tmp: work.tmp,
  until,
  pageApp,
  hookRun,
  window(options = {}) {
    const win = new Window({ title: `sweetview compat row ${process.pid}`, noActivate: true, ...options });
    made.windows.push(win);
    return win;
  },
  webview() {
    const existing = made.views.find((v) => v.unsafeHandle !== null);
    if (existing) return existing;
    const view = new Webview(false, { width: 360, height: 260, hint: 0 });
    view.bind("__rowsAnswer", (id: number, value: string) => answers.get(id)?.(value));
    made.views.push(view);
    return view;
  },
  ask(view, expression) {
    const id = ++asked;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no answer to ${expression}`)), 8000);
      answers.set(id, (value) => {
        clearTimeout(timer);
        answers.delete(id);
        done(value);
      });
      view.eval(`Promise.resolve().then(() => (${expression})).then((v) => __rowsAnswer(${id}, String(v)), (e) => __rowsAnswer(${id}, "error: " + e))`);
    });
  },
};

// ---- the jobs -----------------------------------------------------------------------------------------------------------------
const ranWith = new Map<string, { value: unknown; key: string }[]>();
try {
  for (const job of jobs) {
    if (job.target === "runEventLoop" || job.target === "quitEventLoop") continue; // the run's own loop, below
    const runner = RUNNERS[job.target];
    if (!runner || runner.where !== "desktop") {
      results[job.key] = `error: no desktop runner for ${job.target}`;
      continue;
    }
    try {
      const mod = (await import(job.spec)) as Record<string, unknown>;
      const value = mod[job.name];
      if (value === undefined) throw new Error(`${job.spec} does not export ${job.name}`);
      // The same export reached through another entry point ran already: the row imports the very function or class.
      const earlier = ranWith.get(job.target)?.find((r) => r.value === value);
      if (earlier) {
        results[job.key] = results[earlier.key]!.startsWith("ok") ? `ok: the same ${job.name} as ${earlier.key.split(" @ ")[1]}` : results[earlier.key]!;
        continue;
      }
      say(`run ${job.key}`);
      const note = await Promise.race([
        Promise.resolve(runner.run(value, ctx)),
        Bun.sleep(45_000).then(() => {
          throw new Error("the runner passed its limit");
        }),
      ]);
      results[job.key] = typeof note === "string" ? `ok: ${note}` : "ok";
      ranWith.set(job.target, [...(ranWith.get(job.target) ?? []), { value, key: job.key }]);
    } catch (err) {
      results[job.key] = `error: ${err instanceof Error ? err.message : String(err)}`;
      say(`FAIL ${job.key}: ${results[job.key]}`);
    } finally {
      cleanUp();
    }
  }
} finally {
  cleanUp();
  if (page) {
    try {
      (await page).app.dispose();
    } catch {}
  }
}

// The run's own loop: it pumped (a native timeout fired), and quitEventLoop ends it.
quitEventLoop();
const ended = await Promise.race([loop.then(() => true), Bun.sleep(3000).then(() => false)]);
for (const job of jobs) {
  if (job.target === "runEventLoop") results[job.key] = loopTicked ? "ok: this run's loop pumped the OS loop" : "error: the loop never pumped";
  if (job.target === "quitEventLoop") results[job.key] = ended ? "ok: it ended this run's loop" : "error: the loop did not end";
}
try {
  work.dispose();
} catch {}
finish(0);
