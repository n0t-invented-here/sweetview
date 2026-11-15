// Plays the user against the real app and says what happened: every way a tab
// opens and closes, that each tab's page has its own state, and that tearing a
// tab off and merging it back keeps everything working. Captures of the
// window go to the folder given as the first argument (default build/drive).
//
// Nothing here clicks the screen: that needs the Accessibility grant. Each
// step goes in at the first point this process owns: a menu item is performed
// by AppKit (`performActionForItemAtIndex:`), the + button's message is sent
// down the responder chain it uses, and a page's button is clicked in the page.
//
//   just demos native-tabs drive

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runEventLoop } from "@n1h/sweetview/native";
import { NIL, asId, cls, jsString, nsString, sel, send, sendIntArg, sendPtr, sendPtrPtrPtr, sendRetBool, sendUIntRetPtr, sharedApp } from "../../../src/native/darwin/objc";
import { pooled } from "../mac-window-tabs";
import { startTabsApp, type Tab } from "../tabs-app";
import { captureWindow } from "./capture";

const out = resolve(process.argv[2] ?? "build/drive");
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};
const until = async (condition: () => boolean, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (condition()) return true;
  return condition();
};

const nsApp = sharedApp();
// DRIVE_APPEARANCE=light|dark: captures in that appearance, whatever the system is set to
const appearance = { light: "NSAppearanceNameAqua", dark: "NSAppearanceNameDarkAqua" }[process.env.DRIVE_APPEARANCE ?? ""];
if (appearance) sendPtr(nsApp, sel("setAppearance:"), asId(sendPtr(cls("NSAppearance"), sel("appearanceNamed:"), nsString(appearance))));
const loop = runEventLoop();
const app = startTabsApp();
const { tabs, open } = app;
const tabOf = (window: bigint): Tab => {
  const tab = open.get(window);
  if (!tab) throw new Error("drive: that tab is closed");
  return tab;
};
// Everything below that asks AppKit a question does it in a pool of its own (see `pooled`): the
// arrays AppKit hands back hold on to the windows in them, and unpooled they would never let go.
const windowTitle = (window: bigint) => pooled(() => jsString(asId(send(window, sel("title")))));
const tabBarVisible = (window: bigint) => pooled(() => Boolean(sendRetBool(asId(send(window, sel("tabGroup"))), sel("isTabBarVisible"))));
const liveWindows = () => pooled(() => Number(asId(send(asId(send(nsApp, sel("windows"))), sel("count"))))); // every NSWindow of the app still allocated, closed or not
// Titles in tab-bar order, for the window a tab is in.
const tabOrder = (window: bigint) =>
  pooled(() => {
    const group = asId(send(asId(send(window, sel("tabGroup"))), sel("windows")));
    const titles: string[] = [];
    for (let i = 0n, n = BigInt(asId(send(group, sel("count")))); i < n; i++) titles.push(jsString(asId(send(asId(sendUIntRetPtr(group, sel("objectAtIndex:"), i)), sel("title")))));
    return titles;
  });
const capture = (window: bigint, name: string) => {
  const { width, height } = pooled(() => captureWindow(window, join(out, name)));
  console.log(`     ${name} ${width}x${height}`);
};

// Run an expression in a tab's page and get its value back as a string.
const answers = new Map<number, (value: string) => void>();
const listening = new WeakSet<object>(); // by webview, not by window: AppKit gives a freed window's address to a later one
let asked = 0;
const ask = (window: bigint, expression: string): Promise<string> => {
  const { webview } = tabOf(window).app!;
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
const inPage = (window: bigint, statements: string) => ask(window, `(() => { ${statements} })()`);

// A top-level menu by name. Its item in the menu bar has no title of its own; the menu under it carries the name.
const topMenu = (menuTitle: string) => {
  const menubar = asId(send(nsApp, sel("mainMenu")));
  for (let i = 0n, n = BigInt(asId(send(menubar, sel("numberOfItems")))); i < n; i++) {
    const submenu = asId(send(asId(sendUIntRetPtr(menubar, sel("itemAtIndex:"), i)), sel("submenu")));
    if (submenu !== NIL && jsString(asId(send(submenu, sel("title")))) === menuTitle) return submenu;
  }
  throw new Error(`drive: no ${menuTitle} menu`);
};
const menuItemTitles = (menuTitle: string) =>
  pooled(() => {
    const menu = topMenu(menuTitle);
    const titles: string[] = [];
    for (let i = 0n, n = BigInt(asId(send(menu, sel("numberOfItems")))); i < n; i++) titles.push(jsString(asId(send(asId(sendUIntRetPtr(menu, sel("itemAtIndex:"), i)), sel("title")))));
    return titles.filter(Boolean);
  });

// The item with that title in a top-level menu, performed as if chosen.
const chooseMenuItem = (menuTitle: string, itemTitle: string) => pooled(() => chooseMenuItemNow(menuTitle, itemTitle));
const chooseMenuItemNow = (menuTitle: string, itemTitle: string) => {
  const menu = topMenu(menuTitle);
  const at = BigInt.asIntN(64, asId(sendPtr(menu, sel("indexOfItemWithTitle:"), nsString(itemTitle)))); // NSInteger, -1 when absent
  if (at < 0n) throw new Error(`drive: no menu item ${menuTitle} > ${itemTitle}`);
  const key = jsString(asId(send(asId(sendPtr(menu, sel("itemWithTitle:"), nsString(itemTitle))), sel("keyEquivalent"))));
  sendIntArg(menu, sel("performActionForItemAtIndex:"), at);
  return key;
};

// --- launch, as app.ts does
const first = await app.openTab();
const second = await app.openTab();
const site = await app.openTab("https://bun.sh");
tabs.select(first);
check("three tabs open at launch", tabs.count() === 3, `${tabs.count()}`);
const siteTitled = await until(() => tabOf(site).title !== "bun.sh", 8000);
check("the site tab's title follows the site", siteTitled && windowTitle(site) === tabOf(site).title, `"${windowTitle(site)}"`);
check("a tab opens with nothing focused in its page", (await ask(first, `document.activeElement === document.body`)) === "true", `active element: ${await ask(first, `document.activeElement?.id || document.activeElement?.tagName`)}`);
await Bun.sleep(1200);
capture(first, "01-launch.png");

// --- each tab is its own page
await inPage(first, `for (let i = 0; i < 3; i++) document.getElementById("click").click()`);
const clicks = [await ask(first, `document.getElementById("clicks").textContent`), await ask(second, `document.getElementById("clicks").textContent`)];
check("clicks in Tab 1 stay in Tab 1", clicks[0] === "3" && clicks[1] === "0", `Tab 1 shows ${clicks[0]}, Tab 2 shows ${clicks[1]}`);
const instances = [await ask(first, `document.getElementById("instance").textContent`), await ask(second, `document.getElementById("instance").textContent`)];
check("the two pages are different instances", instances[0] !== instances[1] && instances[0] !== "", instances.join(" vs "));
check("every page knows how many tabs are open", (await ask(first, `document.getElementById("count").textContent`)) === "3 tabs are open.");
await Bun.sleep(200);
capture(first, "02-tab-1-after-three-clicks.png");
tabs.select(second);
await Bun.sleep(600);
capture(second, "03-tab-2-untouched.png");

// --- the + button: AppKit shows it when newWindowForTab: has a target in the window's responder chain, and sends it there
const plusHasTarget = pooled(() => asId(sendPtrPtrPtr(nsApp, sel("targetForAction:to:from:"), sel("newWindowForTab:"), NIL, NIL)) !== NIL);
check("newWindowForTab: has a target, so the tab bar has a +", plusHasTarget);
pooled(() => sendPtrPtrPtr(nsApp, sel("sendAction:to:from:"), sel("newWindowForTab:"), NIL, NIL));
check("the + opens a tab", await until(() => tabs.count() === 4), `${tabs.count()} tabs`);
const fromPlus = tabs.current()!;
check("the new tab is the selected one", fromPlus !== second && tabOf(fromPlus).title === "Tab 4", tabOf(fromPlus).title);

// --- the menu
const newTabKey = chooseMenuItem("File", "New Tab");
check("File > New Tab (Cmd+T) opens a tab", (await until(() => tabs.count() === 5)) && newTabKey === "t", `${tabs.count()} tabs, key "${newTabKey}"`);
const fromMenu = tabs.current()!;
const fromMenuTab = tabOf(fromMenu);
const closeKey = chooseMenuItem("File", "Close Tab");
check("File > Close Tab (Cmd+W) closes the tab the user is on", (await until(() => tabs.count() === 4 && !open.has(fromMenu))) && closeKey === "w", `${tabs.count()} tabs, key "${closeKey}"`);
check("a closed tab's webview is destroyed", (await until(() => fromMenuTab.app?.webview.unsafeHandle === null)) && tabOf(fromPlus).app?.webview.unsafeHandle !== null);

// --- tabs asked for faster than they load (Cmd+T held down)
const allocatedBefore = liveWindows();
tabs.select(fromPlus);
await Bun.sleep(200);
const burst = await Promise.all(Array.from({ length: 6 }, () => app.openTab()));
await Bun.sleep(300);
const burstTitles = burst.map((w) => tabOf(w).title);
const afterPlus = tabOrder(fromPlus).slice(tabOrder(fromPlus).indexOf("Tab 4") + 1, tabOrder(fromPlus).indexOf("Tab 4") + 7);
check("six tabs asked for at once sit after the current tab in the order asked", afterPlus.join() === burstTitles.join(), tabOrder(fromPlus).join(" | "));
check("the last one asked for is the selected one", tabs.current() === burst.at(-1), tabOf(tabs.current()!).title);
const counts = await Promise.all([first, second, fromPlus, ...burst].map((w) => ask(w, `document.getElementById("count").textContent`)));
check("every page shows the same, right number of tabs", new Set(counts).size === 1 && counts[0] === `${tabs.count()} tabs are open.`, [...new Set(counts)].join(" / "));
capture(tabs.current()!, "04-ten-tabs.png");
for (const window of burst) tabs.close(window);
await until(() => tabs.count() === 4);
await Bun.sleep(400);
check("a closed tab's window is freed", liveWindows() === allocatedBefore, `${allocatedBefore} windows allocated before the six, ${liveWindows()} after closing them`);
tabs.select(fromPlus);
await Bun.sleep(200);

const windowMenu = menuItemTitles("Window");
check(
  "the Window menu has the tab commands once each, and AppKit's list of the tabs",
  ["Show Previous Tab", "Show Next Tab", "Move Tab to New Window", "Merge All Windows", "Tab 1"].every((t) => windowMenu.filter((title) => title === t).length === 1),
  windowMenu.join(" | "),
);

// --- the page's own controls
await inPage(second, `document.getElementById("new").click()`);
check("a page's New Tab button opens a tab", await until(() => tabs.count() === 5), `${tabs.count()} tabs`);
const fromPage = `Tab ${Math.max(...[...open.values()].map((t) => t.number))}`; // the newest
check("it sits right after the tab that asked, though another tab was in front", tabOrder(second)[tabOrder(second).indexOf("Tab 2") + 1] === fromPage, tabOrder(second).join(" | "));
await inPage(second, `const a = document.getElementById("address"); a.value = "example.com"; document.getElementById("open").requestSubmit()`);
check("a page opens a site in a tab", await until(() => [...open.values()].some((t) => t.address === "https://example.com/") && tabs.count() === 6), `${tabs.count()} tabs`);
await inPage(second, `const a = document.getElementById("address"); a.value = "ftp://nope"; document.getElementById("open").requestSubmit()`);
await Bun.sleep(300);
const refusal = await ask(second, `document.getElementById("error").hidden ? "" : document.getElementById("error").textContent`);
check("an address that is not http or https is refused in words, and opens nothing", refusal === "Only http and https addresses open in a tab, not ftp." && tabs.count() === 6, `"${refusal}"`);
await inPage(second, `const t = document.getElementById("title"); t.value = "Renamed here"; t.dispatchEvent(new Event("input"))`);
check("typing in the page's title renames the tab", await until(() => windowTitle(second) === "Renamed here"), `"${windowTitle(second)}"`);
tabs.select(second);
await Bun.sleep(500);
capture(second, "05-six-tabs-one-renamed.png");

// --- a site that cannot be reached
const unreachable = await app.openTab("http://nonexistent.invalid/");
const explained = await until(() => false, 1500).then(() => ask(unreachable, `document.querySelector("h1")?.textContent + " | " + document.querySelector("p:nth-of-type(2)")?.textContent`));
check("a site that cannot be reached says so in the tab, with the reason", explained.startsWith("This site did not open | ") && explained.length > 30 && windowTitle(unreachable) === "nonexistent.invalid", explained);
capture(unreachable, "06-unreachable-site.png");
tabs.close(unreachable);
await until(() => tabs.count() === 6);

// --- tear a tab off and merge it back
tabs.select(first);
await Bun.sleep(200);
chooseMenuItem("Window", "Move Tab to New Window");
await Bun.sleep(700);
const groups = () => pooled(() => new Set([...open.keys()].map((w) => asId(send(w, sel("tabGroup"))))).size);
check("Move Tab to New Window gives the tab its own window", groups() === 2 && tabs.count() === 6, `${groups()} windows`);
check("a tab alone in a window still has its tab bar, and so its +", tabBarVisible(first) && tabBarVisible(second));
check("the torn-off tab's page kept its state", (await ask(first, `document.getElementById("clicks").textContent`)) === "3");
capture(first, "07-tab-1-in-its-own-window.png");
chooseMenuItem("Window", "Merge All Windows");
await Bun.sleep(700);
check("Merge All Windows brings it back", groups() === 1 && tabs.count() === 6, `${groups()} window`);

// --- closing
await inPage(second, `document.getElementById("close").click()`).catch(() => "closed before it answered");
check("a page's Close Tab button closes its tab", await until(() => !open.has(second) && tabs.count() === 5), `${tabs.count()} tabs`);
check("the others hear about it", (await ask(first, `document.getElementById("count").textContent`)) === "5 tabs are open.");

// --- closing a tab whose page is in the middle of talking to us
for (let i = 0; i < 5; i++) {
  const busy = await app.openTab("https://bun.sh"); // still loading, and reporting its title as it does
  await Bun.sleep(i * 60);
  tabs.close(busy);
}
check("closing site tabs while they load leaves the app standing", await until(() => tabs.count() === 5), `${tabs.count()} tabs`);
for (const window of [...open.keys()].slice(1)) tabs.close(window);
await until(() => tabs.count() === 1);
await Bun.sleep(400);
const last = [...open.keys()][0]!;
check("the last tab left keeps its tab bar", tabBarVisible(last), tabOf(last).title);
capture(last, "08-last-tab.png");
tabs.close(last);
const ended = await Promise.race([loop.then(() => true), Bun.sleep(4000).then(() => false)]);
check("closing the last tab ends the app", ended && tabs.count() === 0);

console.log(failures === 0 ? `\nall checks passed; captures in ${out}` : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
