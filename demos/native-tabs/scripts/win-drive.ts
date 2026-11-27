// Windows: drives the real built-in native tabs API (createApp({ tabs: true }),
// openTab, select, setTitle, close, moveToNewWindow, mergeAllWindows, maximize,
// and clean exit) and captures screenshots into `out`.
//
//   just demos native-tabs drive

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Webview } from "@n1h/sweetview-webview-bun";
import { startDemoTabs } from "../app";
import { captureWindow } from "./win-capture";

const out = resolve(process.argv[2] ?? "build/drive");
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `: ${detail}`}`);
};

const until = async (condition: () => boolean, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (condition()) return true;
  return condition();
};

const answers = new Map<number, (value: string) => void>();
const listening = new WeakSet<object>();
let asked = 0;
const ask = (webview: Webview, expression: string): Promise<string> => {
  if (!listening.has(webview)) {
    listening.add(webview);
    webview.bind("__driveAnswer", (id: number, value: string) => answers.get(id)?.(value));
  }
  const id = ++asked;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`drive: no answer to ${expression}`)), 4000);
    answers.set(id, (value) => {
      clearTimeout(timer);
      answers.delete(id);
      done(value);
    });
    webview.eval(`Promise.resolve().then(() => (${expression})).then((v) => __driveAnswer(${id}, String(v)), (e) => __driveAnswer(${id}, "error: " + e))`);
  });
};

const demo = await startDemoTabs();
const { app, openTabs } = demo;
let loopRunning = true;
const loop = Promise.resolve(app.run()).then(() => (loopRunning = false));

try {
  const t1 = await demo.openTab();
  const t2 = await demo.openTab();
  const t3 = await demo.openTab("https://example.com");
  app.window.show();
  await Bun.sleep(600);

  check("three tabs opened", openTabs.size === 3, openTabs.size);
  check("window is visible", app.window.isVisible());

  // Select tab 1 and verify independent page DOM + title update
  t1.select();
  await Bun.sleep(250);
  t1.setTitle("Alpha Tab");
  check("tab 1 renamed", t1.title === "Alpha Tab", t1.title);

  const titleValue = await ask(t1.webview.raw, `document.getElementById("title")?.value ?? ""`);
  const instanceText = await ask(t1.webview.raw, `document.getElementById("instance")?.textContent ?? ""`);
  check("tab 1 page rendered", titleValue.length > 0 && instanceText.length > 0, `${titleValue} (${instanceText})`);

  if (app.window.handle) {
    const shot = await captureWindow(BigInt(app.window.handle), join(out, "tabs-main.png"));
    check("captured tabbed window screenshot", shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`);
  }

  // Maximize & restore on the tabbed window
  app.window.toggleMaximize();
  check("tabbed window maximizes", await until(() => app.window.isMaximized(), 1500));
  app.window.toggleMaximize();
  check("tabbed window restores", await until(() => !app.window.isMaximized(), 1500));

  // Tear off tab 2 into a new window, then merge all windows back
  const detachedWin = await t2.moveToNewWindow();
  await Bun.sleep(300);
  check("moveToNewWindow returns a new visible Window", detachedWin !== app.window && detachedWin.isVisible());
  app.mergeAllWindows();
  await Bun.sleep(300);
  check("mergeAllWindows moves tab back into primary window", t2.window === app.window);

  // A URL tab whose first navigation fails at once (a refused loopback port) shows the failed-load page
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const refusedPort = probe.port;
  probe.stop(true);
  const t4 = await demo.openTab(`http://127.0.0.1:${refusedPort}/`);
  let failedHeading = "";
  for (const end = Date.now() + 6000; Date.now() < end && failedHeading !== "This site did not open"; await Bun.sleep(150)) {
    failedHeading = await ask(t4.webview.raw, `document.querySelector("h1")?.textContent ?? ""`).catch(() => "");
  }
  check("a refused initial navigation shows the failed-load page", failedHeading === "This site did not open", failedHeading);
  const failedText = await ask(t4.webview.raw, `document.querySelector("main p")?.textContent ?? ""`).catch((e) => String(e));
  check("the failed-load page names the refused address", failedText === `http://127.0.0.1:${refusedPort}/`, failedText);
  t4.close();
  check("closing the failed tab leaves 3 open", await until(() => openTabs.size === 3, 2000), openTabs.size);

  // Close tabs one by one; closing the last ends the loop cleanly
  t3.close();
  check("closing tab 3 leaves 2 open", await until(() => openTabs.size === 2, 2000), openTabs.size);
  t2.close();
  check("closing tab 2 leaves 1 open", await until(() => openTabs.size === 1, 2000), openTabs.size);
  t1.close();
  check("closing the last tab exits the event loop", await until(() => !loopRunning, 3000));
} catch (err) {
  // A thrown step (an unanswered ask, a failed tear-off) still ends the loop below.
  check("drive ran to the end without throwing", false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  if (loopRunning) app.quit();
  await loop;
  app.dispose();
}

console.log(failures === 0 ? "PASS" : `FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
