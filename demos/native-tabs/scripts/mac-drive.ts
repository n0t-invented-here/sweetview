// macOS: drives the real built-in native tabs API (createApp({ tabs: true }),
// openTab, select, setTitle, close, moveToNewWindow, mergeAllWindows) and
// captures screenshots into `out`.
//
//   just demos native-tabs drive

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { asId, sel, send, sharedApp } from "../../../src/native/darwin/objc";
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

const demo = await startDemoTabs();
const { app, openTabs } = demo;
let loopRunning = true;
const loop = Promise.resolve(app.run()).then(() => (loopRunning = false));

const t1 = await demo.openTab();
const t2 = await demo.openTab();
const t3 = await demo.openTab("https://example.com");
app.window.show();
await Bun.sleep(600);

check("three tabs opened", openTabs.size === 3, openTabs.size);
t1.select();
t1.setTitle("Alpha Tab");
check("tab 1 renamed", t1.title === "Alpha Tab", t1.title);
await Bun.sleep(200);

const keyWin = asId(send(sharedApp(), sel("keyWindow")));
if (keyWin !== 0n) {
  const shot = captureWindow(keyWin, join(out, "tabs-initial.png"));
  check("captured tabbed window screenshot", shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`);
} else {
  check("captured tabbed window screenshot", false, "no keyWindow");
}

await t2.moveToNewWindow();
await Bun.sleep(300);
app.mergeAllWindows();
await Bun.sleep(300);

t3.close();
check("closing tab 3 leaves 2 open", await until(() => openTabs.size === 2, 2000), openTabs.size);
t2.close();
check("closing tab 2 leaves 1 open", await until(() => openTabs.size === 1, 2000), openTabs.size);
t1.close();
check("closing the last tab exits the event loop", await until(() => !loopRunning, 3000));

await loop;
app.dispose();

console.log(failures === 0 ? "PASS" : `FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
