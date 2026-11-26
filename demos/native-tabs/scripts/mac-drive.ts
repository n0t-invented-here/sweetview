// macOS: drives the real built-in native tabs API (createApp({ tabs: true }),
// openTab, select, setTitle, close, moveToNewWindow, mergeAllWindows,
// responder-chain newWindowForTab:, separate page state, load-error fallback,
// and screenshot capture into `out`).
//
//   just demos native-tabs drive

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { asId, NIL, sel, send, sendInt, sendPtr, sharedApp } from "@n1h/sweetview-native/darwin/objc";
import { startDemoTabs } from "../app";
import { captureWindow } from "./mac-capture";

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

const appWindowCount = (): number => {
  const wins = asId(send(sharedApp(), sel("windows")));
  return wins === NIL ? 0 : Number(sendInt(wins, sel("count")) ?? 0);
};

const demo = await startDemoTabs();
const { app, openTabs } = demo;
let loopRunning = true;
const loop = Promise.resolve(app.run()).then(() => (loopRunning = false));

try {
  let resizeEvents = 0;
  app.window.onResize(() => resizeEvents++);

  const t1 = await demo.openTab();
  const t2 = await demo.openTab();
  check("window stays hidden before app.window.show()", !app.window.isVisible(), app.window.isVisible());

  app.window.show();
  await Bun.sleep(600);
  check("window becomes visible after show()", app.window.isVisible(), app.window.isVisible());
  check("two initial tabs opened", openTabs.size === 2, openTabs.size);

  // Separate page state check: rename tab 1 from JS/API and verify tab 2 keeps its own title.
  t1.select();
  t1.setTitle("Alpha Tab");
  check("tab 1 renamed independently of tab 2", t1.title === "Alpha Tab" && t2.title === "Tab 2", `${t1.title} / ${t2.title}`);
  await Bun.sleep(250);

  // Trigger the native AppKit `+` / Cmd+T responder chain (`newWindowForTab:`).
  const keyWin = asId(send(sharedApp(), sel("keyWindow")));
  if (keyWin !== NIL) {
    const shot = captureWindow(keyWin, join(out, "tabs-initial.png"));
    check("captured tabbed window screenshot", shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`);
    const nextResponder = asId(send(keyWin, sel("nextResponder")));
    if (nextResponder !== NIL) {
      sendPtr(nextResponder, sel("newWindowForTab:"), keyWin);
    }
  } else {
    check("captured tabbed window screenshot", false, "no keyWindow");
  }
  check("responder chain newWindowForTab: opens a 3rd tab", await until(() => openTabs.size === 3, 2500), openTabs.size);

  // Open an unreachable site tab to exercise the WKNavigationDelegate load-error fallback without crashing.
  const badSite = await demo.openTab("http://127.0.0.1:1");
  await Bun.sleep(500);
  check("unreachable site tab stays open with error fallback", openTabs.size === 4, openTabs.size);

  // Resize via virtual Window controller and verify onResize fires.
  const beforeBounds = app.window.bounds();
  app.window.setBounds({ x: beforeBounds.x, y: beforeBounds.y, width: beforeBounds.width + 20, height: beforeBounds.height + 10 });
  await Bun.sleep(200);
  check("virtual Window.onResize fires on tabbed window resize", resizeEvents > 0, resizeEvents);

  // Tear off tab 2 into its own tabbed Window, then merge all windows back together.
  const detachedWin = await t2.moveToNewWindow();
  await Bun.sleep(300);
  const detachedNsWin = asId(t2.webview.window.handle as bigint);
  const tabGroupAfterDetach = asId(send(detachedNsWin, sel("tabGroup")));
  const groupCountAfterDetach =
    tabGroupAfterDetach === NIL ? 0 : Number(sendInt(asId(send(tabGroupAfterDetach, sel("windows"))), sel("count")) ?? 0);
  check(
    "moveToNewWindow returns a new tabbed Window isolating tab 2",
    detachedWin !== app.window && groupCountAfterDetach === 1,
    `groupCount=${groupCountAfterDetach}, totalWin=${appWindowCount()}`,
  );

  app.mergeAllWindows();
  await Bun.sleep(350);
  const tabGroupAfterMerge = asId(send(detachedNsWin, sel("tabGroup")));
  const groupCountAfterMerge =
    tabGroupAfterMerge === NIL ? 0 : Number(sendInt(asId(send(tabGroupAfterMerge, sel("windows"))), sel("count")) ?? 0);
  check("mergeAllWindows recombines tabs into one window group", groupCountAfterMerge === openTabs.size, `groupCount=${groupCountAfterMerge}/${openTabs.size}`);

  // Close every remaining tab down to zero and verify clean loop exit.
  badSite.close();
  check("closing unreachable site tab leaves 3 open", await until(() => openTabs.size === 3, 2500), openTabs.size);
  for (const tab of [...openTabs.values()].reverse()) {
    const targetCount = openTabs.size - 1;
    tab.close();
    check(`closing tab leaves ${targetCount} open`, await until(() => openTabs.size === targetCount, 2500), openTabs.size);
  }
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
