// macOS: drives the real built-in native tabs API (createApp({ tabs: true }),
// openTab, select, setTitle, close, moveToNewWindow, mergeAllWindows,
// responder-chain newWindowForTab:, separate page state, the failed-load
// page, window.open() as a new tab, the file input's open panel, a webview
// disposed directly, and screenshot capture into `out`).
//
//   just demos native-tabs drive

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tab } from "@n1h/sweetview";
import type { RawWebview as Webview } from "@n1h/sweetview";
import { asId, jsString, NIL, sel, send, sendInt, sendPtr, sharedApp } from "@n1h/sweetview-native/darwin/objc";
import { scheduleNativeTimeout } from "@n1h/sweetview-native/internal";
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

/** The NSWindow behind a tab, and how many tabs share its AppKit tab group. */
const tabWindowOf = (tab: Tab<any, any>) => asId(tab.webview.window.handle as bigint);
const groupSize = (tab: Tab<any, any>): number => {
  const group = asId(send(tabWindowOf(tab), sel("tabGroup")));
  return group === NIL ? 0 : Number(sendInt(asId(send(group, sel("windows"))), sel("count")) ?? 0);
};

const answers = new Map<number, (value: string) => void>();
const listening = new WeakSet<object>();
let asked = 0;
/** Evaluates `expression` in the tab's page and resolves with its value as a string. */
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
/** Polls the page until `expression` gives `expected`, and returns the last value seen. */
const askUntil = async (webview: Webview, expression: string, expected: string, ms = 6000): Promise<string> => {
  let value = "";
  for (const end = Date.now() + ms; Date.now() < end && value !== expected; await Bun.sleep(150)) {
    value = await ask(webview, expression).catch(() => "");
  }
  return value;
};

// A modal panel blocks this script inside AppKit, so a native timer (it runs
// in the modal run loop mode too) notes the class of any modal window and
// cancels it. It keeps watching until the end: a panel that opened late and
// was left up would hang the run.
let modalPanelClass = "";
let stopModalWatch = () => {};
const watchForModalPanel = () => {
  stopModalWatch = scheduleNativeTimeout(150, () => {
    const modal = asId(send(sharedApp(), sel("modalWindow")));
    if (modal !== NIL) {
      modalPanelClass = jsString(asId(send(modal, sel("className"))));
      sendPtr(modal, sel("cancel:"), NIL);
    }
    watchForModalPanel();
  });
};

const demo = await startDemoTabs();
const { app, openTabs } = demo;
let loopRunning = true;
const loop = Promise.resolve(app.run()).then(() => (loopRunning = false));

try {
  let resizeEvents = 0;
  app.window.onResize(() => resizeEvents++);
  let lastSelected: Tab<any, any> | undefined;
  app.window.onTabSelect((tab) => (lastSelected = tab as Tab<any, any>));

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
  // Tab 1's own NSWindow, not [NSApp keyWindow]: there is no key window while
  // another application is frontmost.
  const tabWin = tabWindowOf(t1);
  const shot = captureWindow(tabWin, join(out, "tabs-initial.png"));
  check("captured tabbed window screenshot", shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`);
  const nextResponder = asId(send(tabWin, sel("nextResponder")));
  if (nextResponder !== NIL) sendPtr(nextResponder, sel("newWindowForTab:"), tabWin);
  check("responder chain newWindowForTab: opens a 3rd tab", await until(() => openTabs.size === 3, 2500), openTabs.size);

  // A URL tab whose navigation fails at once (a refused loopback port) shows the failed-load page, naming the address that failed.
  const badSite = await demo.openTab("http://127.0.0.1:1");
  check("unreachable site tab stays open", openTabs.size === 4, openTabs.size);
  const failedHeading = await askUntil(badSite.webview.raw, `document.querySelector("h1")?.textContent ?? ""`, "This site did not open");
  check("a refused navigation shows the failed-load page", failedHeading === "This site did not open", failedHeading);
  const failedAddress = await ask(badSite.webview.raw, `document.querySelector("main p")?.textContent ?? ""`).catch((e) => String(e));
  check("the failed-load page names the refused address", failedAddress === "http://127.0.0.1:1/", failedAddress);

  // window.open() to an HTTP(S) address opens a tab in the same window instead of a new WKWebView window.
  t1.select();
  const groupBeforePopup = groupSize(t1);
  t1.webview.raw.eval(`window.open("http://127.0.0.1:1/popup")`);
  const popupOpened = await until(() => groupSize(t1) === groupBeforePopup + 1, 3000);
  check("window.open() opens a new tab in the host window", popupOpened, `${groupBeforePopup} -> ${groupSize(t1)} tabs`);
  const popup = popupOpened && lastSelected !== t1 ? lastSelected : undefined;
  if (popup) {
    check("the new tab belongs to the same tabbed Window", popup.window === app.window);
    const popupAddress = await askUntil(popup.webview.raw, `document.querySelector("main p")?.textContent ?? ""`, "http://127.0.0.1:1/popup");
    check("the new tab was given the address window.open() asked for", popupAddress === "http://127.0.0.1:1/popup", popupAddress);
    popup.close();
    check("closing the window.open() tab leaves the others", await until(() => groupSize(t1) === groupBeforePopup, 2500) && openTabs.size === 4, `${groupSize(t1)} tabs`);
  } else {
    check("the new tab is selected", false, "no tab was selected");
  }

  // <input type="file"> still opens the open panel: the tab's UIDelegate forwards it to the webview library's.
  watchForModalPanel();
  t1.webview.raw.eval(`(() => { const input = document.createElement("input"); input.type = "file"; document.body.append(input); input.click(); })()`);
  check("a file input opens NSOpenPanel", await until(() => modalPanelClass !== "", 5000) && /OpenPanel/.test(modalPanelClass), modalPanelClass || "no modal panel");

  // A tab's webview disposed directly: nothing crashes, the tab stays until it is closed, and the others carry on.
  const spare = await demo.openTab();
  check("a 5th tab opened", openTabs.size === 5, openTabs.size);
  spare.webview.dispose();
  check("a webview disposed directly leaves its tab and the others open", spare.webview.raw.unsafeHandle === null && openTabs.size === 5 && t1.webview.raw.unsafeHandle !== null);
  check("the other tabs' pages still answer", (await ask(t1.webview.raw, "1 + 1").catch((e) => String(e))) === "2");
  spare.close();
  check("closing the tab whose webview was disposed leaves 4 open", await until(() => openTabs.size === 4, 2500), openTabs.size);

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
  stopModalWatch();
  if (loopRunning) app.quit();
  await loop;
  app.dispose();
}

console.log(failures === 0 ? "PASS" : `FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
