// Windows: plays the user against the real app and says what happened: every
// way a tab opens, closes and moves, that each tab's page has its own state,
// and that the window behaves like a window. Captures of the window go to the
// folder given as the first argument (default build/drive).
//
// Three ways in, each used for what it can show:
//   - the app's own functions, for what a gesture ends up calling;
//   - events dispatched in the strip's page, for the strip's handling of them;
//   - the real mouse and keyboard (scripts/win-input.ts), for what only they
//     can show: that the window manager takes over a drag, that keys pressed
//     in a page reach the tabs, that the system's menu opens. Those run only
//     while this app's window is the foreground window, and print SKIP when
//     it is not; nothing is ever sent to another program.
//
//   just demos native-tabs drive
//   DRIVE_APPEARANCE=light|dark   captures in that appearance, whatever the system is set to
//   DRIVE_INPUT=off               no real mouse or keyboard

import { FFIType, dlopen } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Webview } from "@n1h/sweetview-webview-bun";
import { runEventLoop } from "@n1h/sweetview/native";
import { WM_CLOSE, user32 } from "../../../src/native/win32/api";
import { webviewLibPath } from "../../../src/webview-lib";
import { STRIP_HEIGHT, tabWidth } from "../strip-shared";
import { LAST_TAB } from "../win-shortcuts";
import { windowExists } from "../win-tab-window";
import { startTabsApp, type Tab, type TabWindow } from "../win-tabs-app";
import { controllerOf, devTools } from "../win-webview2";
import { captureScreen, captureWindow } from "./win-capture";

const out = resolve(process.argv[2] ?? "build/drive");
mkdirSync(out, { recursive: true });

let failures = 0;
let skipped = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `: ${detail}`}`);
};
const skip = (what: string, why: string) => {
  skipped++;
  console.log(`SKIP ${what}: ${why}`);
};
const until = async (condition: () => boolean, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (condition()) return true;
  return condition();
};

const loop = runEventLoop();
let running = true;
void loop.then(() => (running = false));
const app = await startTabsApp();
const { open, windows } = app;
const libPath = await webviewLibPath();

type Page = { webview: Webview };
const numbers = (win: TabWindow) => win.tabs.map((tab) => tab.number).join(" ");
const onShow = (tab: Tab) => user32.IsWindowVisible(tab.pane) !== 0;
const windowRect = (hwnd: bigint) => {
  const rect = new Int32Array(4);
  user32.GetWindowRect(hwnd, rect);
  return { x: rect[0]!, y: rect[1]!, width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! };
};

// Run an expression in a page and get its value back as a string.
const answers = new Map<number, (value: string) => void>();
const listening = new WeakSet<object>();
let asked = 0;
const ask = (page: Page | undefined, expression: string): Promise<string> => {
  if (page === undefined) throw new Error("drive: that page is gone");
  const { webview } = page;
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
const inPage = (page: Page | undefined, statements: string) => ask(page, `(() => { ${statements} })()`);
const text = (tab: Tab, id: string) => ask(tab.app, `document.getElementById("${id}").textContent`);

// DRIVE_APPEARANCE: every page is told the system is in that appearance; the strip passes it on to the window.
const appearance = process.env.DRIVE_APPEARANCE === "light" || process.env.DRIVE_APPEARANCE === "dark" ? process.env.DRIVE_APPEARANCE : undefined;
const dressed = new WeakSet<object>();
const dress = () => {
  if (appearance === undefined) return;
  for (const page of [...windows.map((win) => win.strip), ...[...open.values()].map((tab) => tab.app)]) {
    if (page === undefined || dressed.has(page.webview) || page.webview.unsafeHandle === null) continue;
    dressed.add(page.webview);
    devTools(controllerOf(page.webview, libPath), "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: appearance }] });
  }
};
const capture = async (win: TabWindow, name: string) => {
  dress();
  await Bun.sleep(450); // the strip's transitions, and a page's first paint in its new appearance
  const { width, height } = await captureWindow(win.frame.hwnd, join(out, name));
  console.log(`     ${name} ${width}x${height}`);
};

// --- the strip's page: what it shows, and events in it
type Shown = { id: number; title: string; x: number; selected: boolean };
/** The tabs a strip draws, left to right, where each is heading (a transition may still be under way). */
const stripTabs = async (win: TabWindow) =>
  JSON.parse(
    await ask(
      win.strip,
      `JSON.stringify([...document.querySelectorAll(".tab")].map((t) => ({ id: Number(t.dataset.id), title: t.querySelector(".title").textContent, x: parseFloat(/-?[0-9.]+/.exec(t.style.transform)[0]), selected: t.classList.contains("selected") })).sort((a, b) => a.x - b.x))`,
    ),
  ) as Shown[];
const stripOrder = async (win: TabWindow) => (await stripTabs(win)).map((tab) => tab.id).join(" ");
const POINTER = `const at = (x, y) => ({ bubbles: true, button: 0, pointerId: 77, clientX: x, clientY: y });
  const middle = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const tab = (id) => document.querySelector('.tab[data-id="' + id + '"]');`;
/** A press and release on a tab, as pointer events in the strip's page. */
const pressTab = (win: TabWindow, id: number) => inPage(win.strip, `${POINTER} const [x, y] = middle(tab(${id})); tab(${id}).dispatchEvent(new PointerEvent("pointerdown", at(x, y))); window.dispatchEvent(new PointerEvent("pointerup", at(x, y)));`);
/** A tab pressed, dragged by (dx, dy) in two moves, and let go unless it left the strip on the way. */
const dragTab = (win: TabWindow, id: number, dx: number, dy: number) =>
  inPage(
    win.strip,
    `${POINTER} const [x, y] = middle(tab(${id})); tab(${id}).dispatchEvent(new PointerEvent("pointerdown", at(x, y)));
     window.dispatchEvent(new PointerEvent("pointermove", at(x + ${dx} / 2, y + ${dy} / 2)));
     window.dispatchEvent(new PointerEvent("pointermove", at(x + ${dx}, y + ${dy})));
     window.dispatchEvent(new PointerEvent("pointerup", at(x + ${dx}, y + ${dy})));`,
  );

// --- the real mouse and keyboard
const realInput = process.env.DRIVE_INPUT !== "off";
const shell = dlopen("user32.dll", {
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  GetClassNameW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
}).symbols;
const { GetCurrentThreadId } = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: FFIType.u32 } }).symbols;
/**
 * Windows lets a program put its window in front only when the user was just
 * working in that program, which a script started by another script never
 * is. When what is in front is the desktop or the taskbar, and so nobody's
 * work, this joins this thread's input to the shell's for the length of one
 * call, which makes the request the shell's own. In front of another
 * program's window it does nothing: that program keeps the foreground, and
 * the checks that need it are skipped.
 */
const takeForegroundFromShell = (hwnd: bigint) => {
  const front = shell.GetForegroundWindow();
  const name = new Uint8Array(128);
  const className = Buffer.from(name.subarray(0, shell.GetClassNameW(front, name, 63) * 2)).toString("utf16le");
  if (front !== 0n && !["Progman", "WorkerW", "Shell_TrayWnd"].includes(className)) return;
  const theirs = shell.GetWindowThreadProcessId(front, null);
  const ours = GetCurrentThreadId();
  if (theirs !== 0) shell.AttachThreadInput(ours, theirs, 1);
  user32.SetForegroundWindow(hwnd);
  if (theirs !== 0) shell.AttachThreadInput(ours, theirs, 0);
};
type Step = ["move", number, number] | ["down"] | ["up"] | ["middle"] | ["right"] | ["key", ...number[]] | ["wait", number];
/** Runs the steps while `win` is the foreground window. False, and a SKIP line, when it is not. */
const real = async (win: TabWindow, what: string, steps: Step[]): Promise<boolean> => {
  if (!realInput) return skip(what, "DRIVE_INPUT=off"), false;
  win.frame.show();
  await Bun.sleep(250);
  if (!win.frame.isForeground()) {
    takeForegroundFromShell(win.frame.hwnd);
    await Bun.sleep(250);
  }
  if (!win.frame.isForeground()) return skip(what, "another program's window is in front, so no real input was sent"), false;
  const code = await Bun.spawn(["bun", "run", join(import.meta.dir, "win-input.ts"), String(process.pid), JSON.stringify(steps)], { stdout: "inherit", stderr: "inherit" }).exited;
  if (code !== 0) return skip(what, code === 3 ? "another window took the foreground part-way; the rest was not sent" : `win-input exited with ${code}`), false;
  await Bun.sleep(350);
  return true;
};
type At = [x: number, y: number];
/** Screen pixels for a place in a window's strip, given in the strip page's CSS pixels. */
const stripPoint = (win: TabWindow, x: number, y: number): At => {
  const strip = win.frame.stripRect();
  return [strip.x + Math.round(x * win.frame.scale()), strip.y + Math.round(y * win.frame.scale())];
};
const tabPoint = async (win: TabWindow, id: number): Promise<At> => {
  const [x, y] = JSON.parse(await inPage(win.strip, `${POINTER} return JSON.stringify(middle(tab(${id})));`)) as At;
  return stripPoint(win, x, y);
};
/** The strip's empty part: just left of the caption buttons. */
const emptyPoint = (win: TabWindow): At => stripPoint(win, win.frame.stripRect().width / win.frame.scale() - 138 - 24, STRIP_HEIGHT / 2);
/** The mouse from one place to another in small moves, as a hand does it. */
const glide = (from: At, to: At, moves = 14): Step[] => Array.from({ length: moves }, (_, i): Step => ["move", Math.round(from[0] + ((to[0] - from[0]) * (i + 1)) / moves), Math.round(from[1] + ((to[1] - from[1]) * (i + 1)) / moves)]);
const VK = { control: 0x11, shift: 0x10, tab: 0x09, enter: 0x0d, down: 0x28, t: 0x54, w: 0x57 };

// ============================================================ launch, as app.ts does
const first = await app.openTab();
const second = await app.openTab();
const site = await app.openTab("https://bun.sh");
app.select(first);
const win = windows[0]!;
check("three tabs open at launch, in one window", open.size === 3 && windows.length === 1 && win.visible, `${open.size} tabs, ${windows.length} window(s)`);
const siteTitled = await until(() => site.title !== "bun.sh", 8000);
await Bun.sleep(300);
let drawn = await stripTabs(win);
check("the site tab's title follows the site, in the strip too", siteTitled && drawn[2]?.title === site.title, `"${drawn[2]?.title}"`);
check("the strip shows the three tabs in order, the first selected", drawn.map((t) => t.id).join(" ") === "1 2 3" && drawn.map((t) => t.selected).join() === "true,false,false", JSON.stringify(drawn.map((t) => [t.id, t.selected])));
check("only the selected tab's page is on show", onShow(first) && !onShow(second) && !onShow(site));
check("a page that is not on show knows it is hidden", (await ask(first.app, `document.hidden`)) === "false" && (await ask(second.app, `document.hidden`)) === "true");
check("a tab opens with nothing focused in its page", (await ask(first.app, `document.activeElement === document.body`)) === "true", `active element: ${await ask(first.app, `document.activeElement?.id || document.activeElement?.tagName`)}`);
check("the window has no caption: the strip starts at the window's top edge", win.frame.stripRect().y === windowRect(win.frame.hwnd).y, `strip at ${win.frame.stripRect().y}, window at ${windowRect(win.frame.hwnd).y}`);
await capture(win, "01-launch.png");
win.frame.show();
await Bun.sleep(300);
if (!win.frame.isForeground()) takeForegroundFromShell(win.frame.hwnd);
await Bun.sleep(300);
if (win.frame.isForeground()) {
  // what the window manager draws around the window: only the screen has it
  const frame = windowRect(win.frame.hwnd);
  const shot = await captureScreen({ x: frame.x - 16, y: frame.y - 24, width: frame.width + 32, height: frame.height + 48 }, join(out, "01-launch-on-screen.png"));
  console.log(`     01-launch-on-screen.png ${shot.width}x${shot.height}`);
} else skip("a capture of the window as it is on screen", "another program's window is in front");

// ============================================================ each tab is its own page
await inPage(first.app, `for (let i = 0; i < 3; i++) document.getElementById("click").click()`);
const clicks = [await text(first, "clicks"), await text(second, "clicks")];
check("clicks in Tab 1 stay in Tab 1", clicks[0] === "3" && clicks[1] === "0", `Tab 1 shows ${clicks[0]}, Tab 2 shows ${clicks[1]}`);
const instances = [await text(first, "instance"), await text(second, "instance")];
check("the two pages are different instances", instances[0] !== instances[1] && instances[0] !== "", instances.join(" vs "));
check("every page knows how many tabs are open", (await text(first, "count")) === "3 tabs are open.");
await capture(win, "02-tab-1-after-three-clicks.png");
app.select(second);
check("selecting a tab swaps the page on show", onShow(second) && !onShow(first));
await capture(win, "03-tab-2-untouched.png");

// ============================================================ the strip's own controls
await inPage(win.strip, `document.getElementById("new").click()`);
check("the + in the strip opens a tab", await until(() => open.size === 4), `${open.size} tabs`);
const fromPlus = win.selected!;
check("the new tab is the selected one, right after the one that was", fromPlus.title === "Tab 4" && numbers(win) === "1 2 4 3", numbers(win));
await until(() => fromPlus.ready);
await pressTab(win, first.number);
check("a press on a tab in the strip selects it and shows its page", await until(() => win.selected === first && onShow(first) && !onShow(fromPlus)));

const width = tabWidth(win.frame.stripRect().width / win.frame.scale(), win.tabs.length);
await dragTab(win, second.number, width, 0);
check("a tab dragged along the strip by a tab's width changes places with its neighbour", await until(() => numbers(win) === "1 4 2 3"), numbers(win));
await Bun.sleep(100);
check("the strip draws the new order", (await stripOrder(win)) === "1 4 2 3", await stripOrder(win));
await dragTab(win, second.number, 3, 2);
check("a press that wobbles is not a drag", numbers(win) === "1 4 2 3" && win.selected === second);

await inPage(win.strip, `document.querySelector('.tab[data-id="${fromPlus.number}"] .close').click()`);
check("the x on a tab closes it", await until(() => !open.has(fromPlus.number) && open.size === 3), `${open.size} tabs`);
check("a closed tab's webview and its child window are destroyed", fromPlus.app?.webview.unsafeHandle === null && !windowExists(fromPlus.pane));
check("the event loop outlives a closed tab", running && windows.length === 1);

const forMiddle = await app.openTab();
await inPage(win.strip, `document.querySelector('.tab[data-id="${forMiddle.number}"]').dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }))`);
check("a middle click on a tab closes it", await until(() => !open.has(forMiddle.number)));

// ============================================================ what the keys run
app.select(first);
app.shortcut(win, "new");
check("Ctrl+T's command opens a tab after the selected one", (await until(() => open.size === 4)) && win.tabs[1] === win.selected, numbers(win));
const fromKey = win.selected!;
await until(() => fromKey.ready);
app.shortcut(win, "previous");
check("Ctrl+Shift+Tab's command selects the tab before", win.selected === first);
app.shortcut(win, "previous");
check("and from the first goes round to the last", win.selected === win.tabs.at(-1));
app.shortcut(win, "next");
check("Ctrl+Tab's command from the last goes round to the first", win.selected === first);
app.shortcut(win, { select: 2 });
check("Ctrl+3's command selects the third tab", win.selected === win.tabs[2]);
app.shortcut(win, { select: LAST_TAB });
check("Ctrl+9's command selects the last tab", win.selected === win.tabs.at(-1));
app.select(fromKey);
app.shortcut(win, "close");
check("Ctrl+W's command closes the selected tab", !open.has(fromKey.number) && open.size === 3);

// ============================================================ tabs asked for faster than they load (Ctrl+T held down)
app.select(first);
const burst = await Promise.all(Array.from({ length: 6 }, () => app.openTab()));
await Bun.sleep(300);
check("six tabs asked for at once sit after the selected tab in the order asked", burst.every((tab, i) => win.tabs[i + 1] === tab), numbers(win));
check("the last one asked for is the selected one, and on show", win.selected === burst.at(-1) && onShow(burst.at(-1)!));
const counts = await Promise.all([first, second, ...burst].map((tab) => text(tab, "count")));
check("every page shows the same, right number of tabs", new Set(counts).size === 1 && counts[0] === `${open.size} tabs are open.`, [...new Set(counts)].join(" / "));
await capture(win, "04-nine-tabs.png");
for (const tab of burst) app.close(tab);
check("six tabs closed at once are gone, panes and all", open.size === 3 && burst.every((tab) => !windowExists(tab.pane) && tab.app?.webview.unsafeHandle === null), `${open.size} tabs`);

// ============================================================ the page's own controls
app.select(first);
await inPage(second.app, `document.getElementById("new").click()`);
check("a page's New Tab button opens a tab", await until(() => open.size === 4), `${open.size} tabs`);
const fromPage = win.selected!;
check("it sits right after the tab that asked, though another tab was selected", win.tabs[win.tabs.indexOf(second) + 1] === fromPage && fromPage.opener === second, numbers(win));
await until(() => fromPage.ready);
await inPage(second.app, `document.getElementById("new").click()`);
await until(() => open.size === 5);
check("a second one from the same page goes after the first", win.tabs[win.tabs.indexOf(second) + 2] === win.selected, numbers(win));
app.close(win.selected!);
await inPage(second.app, `const a = document.getElementById("address"); a.value = "example.com"; document.getElementById("open").requestSubmit()`);
check("a page opens a site in a tab", await until(() => [...open.values()].some((t) => t.address === "https://example.com/") && open.size === 5), `${open.size} tabs`);
const example = [...open.values()].find((t) => t.address === "https://example.com/")!;
await inPage(second.app, `const a = document.getElementById("address"); a.value = "ftp://nope"; document.getElementById("open").requestSubmit()`);
await Bun.sleep(300);
const refusal = await ask(second.app, `document.getElementById("error").hidden ? "" : document.getElementById("error").textContent`);
check("an address that is not http or https is refused in words, and opens nothing", refusal === "Only http and https addresses open in a tab, not ftp." && open.size === 5, `"${refusal}"`);
await inPage(second.app, `const t = document.getElementById("title"); t.value = "Renamed here"; t.dispatchEvent(new Event("input"))`);
check("typing in the page's title renames the tab", (await until(() => second.title === "Renamed here")) && (await Bun.sleep(100), (await stripTabs(win)).some((t) => t.id === second.number && t.title === "Renamed here")), `"${second.title}"`);
app.select(second);
await capture(win, "05-five-tabs-one-renamed.png");

// ============================================================ a site asks for a new window
await until(() => example.title !== "example.com", 8000);
await ask(example.app, `window.open("https://example.org/") === null`).catch(() => "no answer");
const popped = await until(() => [...open.values()].some((t) => t.address === "https://example.org/"), 3000);
const fromSite = [...open.values()].find((t) => t.address === "https://example.org/");
check("a site's request for a new window opens a tab after it, not a window", popped && fromSite?.opener === example && win.tabs[win.tabs.indexOf(example) + 1] === fromSite && windows.length === 1, numbers(win));
if (fromSite) app.close(fromSite);
app.close(example);

// ============================================================ a site that cannot be reached
const unreachable = await app.openTab("http://nonexistent.invalid/");
await Bun.sleep(1500);
const explained = await ask(unreachable.app, `document.body.innerText`).catch((err) => `no answer (${err})`);
check("a site that cannot be reached says so in the tab", /nonexistent\.invalid/i.test(explained) && explained.length > 40, JSON.stringify(explained.slice(0, 140)));
await capture(win, "06-unreachable-site.png");
app.close(unreachable);

// ============================================================ a tab gets a window of its own, and comes back
const torn = await app.moveToNewWindow(first);
check("Move tab to new window gives the tab its own window", windows.length === 2 && torn.tabs.length === 1 && first.window === torn && torn.visible && open.size === 4, `${windows.length} windows`);
check("the page went with it, state and all", (await text(first, "clicks")) === "3" && onShow(first));
await Bun.sleep(300);
check("each window's strip shows its own tabs", (await stripOrder(torn)) === "1" && (await stripOrder(win)) === numbers(win), `${await stripOrder(torn)} | ${await stripOrder(win)}`);
await capture(torn, "07-tab-1-in-its-own-window.png");
app.mergeAll();
check("Merge all windows brings every tab into one window", (await until(() => windows.length === 1)) && windows[0]!.tabs.length === 4 && [win, torn].filter((w) => windowExists(w.frame.hwnd)).length === 1, `${windows.length} window(s), ${windows[0]?.tabs.length} tabs`);
let main = windows[0]!;
check("and the page is still the same page", (await text(first, "clicks")) === "3" && (await text(first, "instance")) === instances[0]);

// ============================================================ the window
app.select(first);
await inPage(main.strip, `document.getElementById("maximize").click()`);
check("the strip's maximise button maximises the window", await until(() => main.frame.maximized()));
await Bun.sleep(200);
check("the strip shows restore and gives up its top resize edge", (await ask(main.strip, `document.documentElement.classList.contains("maximized") + " " + document.getElementById("maximize").title + " " + getComputedStyle(document.querySelector(".edge")).display`)) === "true Restore Down none");
await capture(main, "08-maximised.png");
await inPage(main.strip, `document.getElementById("maximize").click()`);
check("and restores it", await until(() => !main.frame.maximized()));
const before = windowRect(main.frame.hwnd);
user32.SetWindowPos(main.frame.hwnd, 0n, 0, 0, 200, 150, 0x0002 | 0x0004 | 0x0010); // SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
const least = windowRect(main.frame.hwnd);
check("the window cannot be made smaller than its least size", least.width >= 560 * main.frame.scale() && least.height >= (420 + STRIP_HEIGHT) * main.frame.scale(), `${least.width}x${least.height}`);
await capture(main, "09-least-size.png");
user32.SetWindowPos(main.frame.hwnd, 0n, 0, 0, before.width, before.height, 0x0002 | 0x0004 | 0x0010);
await Bun.sleep(400); // the strip lays its tabs out for the width it has again

// ============================================================ the real mouse and keyboard
const order = () => numbers(main);
{
  const others = main.tabs.filter((tab) => tab !== first);
  const target = others[0]!;
  if (await real(main, "a real click on a tab", [["move", ...(await tabPoint(main, target.number))], ["down"], ["up"]])) {
    check("a real click on a tab selects it", main.selected === target);
    check("and leaves the keyboard with its page, not with the strip", (await ask(target.app, `document.hasFocus()`)) === "true" && (await ask(main.strip, `document.hasFocus()`)) === "false");
  }
  let count = open.size;
  if (await real(main, "Ctrl+T pressed in a page", [["key", VK.control, VK.t]])) {
    check("Ctrl+T pressed in a page opens a tab", await until(() => open.size === count + 1), `${open.size} tabs`);
    const made = main.selected!;
    await until(() => made.ready);
    await Bun.sleep(300);
    const at = main.tabs.indexOf(made);
    if (await real(main, "Ctrl+Tab pressed in a page", [["key", VK.control, VK.tab]])) check("Ctrl+Tab pressed in a page selects the next tab", main.selected === main.tabs[(at + 1) % main.tabs.length], order());
    if (await real(main, "Ctrl+Shift+Tab pressed in a page", [["key", VK.control, VK.shift, VK.tab]])) check("Ctrl+Shift+Tab pressed in a page goes back", main.selected === made, order());
    count = open.size;
    if (await real(main, "Ctrl+W pressed in a page", [["key", VK.control, VK.w]])) check("Ctrl+W pressed in a page closes the tab", (await until(() => open.size === count - 1)) && !open.has(made.number), `${open.size} tabs`);
    else app.close(made);
  }

  const dragged = main.tabs[0]!;
  const from = await tabPoint(main, dragged.number);
  const step = Math.round(tabWidth(main.frame.stripRect().width / main.frame.scale(), main.tabs.length) * main.frame.scale());
  const wasOrder = order();
  if (await real(main, "a real drag along the strip", [["move", ...from], ["down"], ...glide(from, [from[0] + step, from[1]]), ["up"]])) {
    check("a tab really dragged along the strip changes places with its neighbour", main.tabs[1] === dragged, `${wasOrder} -> ${order()}`);
  }

  const grip = emptyPoint(main);
  const where = main.frame.stripRect();
  if (await real(main, "a real drag of the strip's empty part", [["move", ...grip], ["down"], ...glide(grip, [grip[0] + 60, grip[1] + 40]), ["up"]])) {
    const now = main.frame.stripRect();
    check("the strip's empty part moves the window, as a title bar does", now.x - where.x === 60 && now.y - where.y === 40, `moved by ${now.x - where.x}, ${now.y - where.y}`);
  }
  const top: At = [main.frame.stripRect().x + 300, main.frame.stripRect().y + 1];
  const tall = windowRect(main.frame.hwnd);
  if (await real(main, "a real drag of the top edge", [["move", ...top], ["down"], ...glide(top, [top[0], top[1] - 30]), ["up"]])) {
    const now = windowRect(main.frame.hwnd);
    check("the top edge resizes the window", now.y - tall.y === -30 && now.height - tall.height === 30, `top moved by ${now.y - tall.y}, height by ${now.height - tall.height}`);
  }
  const again = emptyPoint(main);
  if (await real(main, "a real double-click on the strip's empty part", [["move", ...again], ["down"], ["up"], ["down"], ["up"]])) {
    check("a double-click on the strip's empty part maximises the window", await until(() => main.frame.maximized(), 1500));
    const restore = emptyPoint(main);
    await real(main, "a second double-click", [["move", ...restore], ["down"], ["up"], ["down"], ["up"]]);
    check("and another restores it", await until(() => !main.frame.maximized(), 1500));
  }

  // tear a tab off by hand, and drop it back on the strip it left
  const pulled = main.tabs[1]!;
  const hold = await tabPoint(main, pulled.number);
  const away: At = [hold[0] + 160, hold[1] + 260];
  if (await real(main, "a real drag of a tab out of the strip", [["move", ...hold], ["down"], ...glide(hold, [hold[0], hold[1] + 120]), ["wait", 1200], ...glide([hold[0], hold[1] + 120], away), ["up"]])) {
    const own = pulled.window;
    check("a tab really dragged out of the strip gets a window of its own", (await until(() => windows.length === 2)) && own !== main && own.tabs.length === 1, `${windows.length} windows`);
    const strip = own.frame.stripRect();
    check("the window is under the cursor where the tab was let go", away[0] >= strip.x && away[0] < strip.x + strip.width && away[1] >= strip.y && away[1] < strip.y + strip.height, `let go at ${away}, strip at ${strip.x},${strip.y}`);
    await capture(own, "10-torn-off-by-hand.png");
    if (windows.length === 2) {
      const lone = await tabPoint(own, pulled.number);
      const home = stripPoint(main, 8 + 30, STRIP_HEIGHT / 2); // the left half of the first tab
      if (await real(own, "a real drag of a window by its one tab onto another strip", [["move", ...lone], ["down"], ...glide(lone, [lone[0] + 20, lone[1] + 10], 4), ...glide([lone[0] + 20, lone[1] + 10], home, 24), ["wait", 200], ["up"]])) {
        check("a window dropped by its one tab on another strip joins that window, where it was dropped", (await until(() => windows.length === 1)) && main.tabs[0] === pulled, `${windows.length} window(s), ${order()}`);
      }
    }
  }
  if (windows.length > 1) app.mergeAll();
  await until(() => windows.length === 1);
  main = windows[0]!; // whichever window the tabs were merged into
  await Bun.sleep(300);

  const menuTab = main.tabs[1]!;
  if (await real(main, "a real right-click on a tab", [["move", ...(await tabPoint(main, menuTab.number))], ["right"], ["wait", 500], ["key", VK.down], ["key", VK.down], ["key", VK.enter]])) {
    check("a right-click on a tab opens the system's menu; its second entry moves the tab to a new window", (await until(() => windows.length === 2)) && menuTab.window !== main, `${windows.length} windows`);
  }
  if (windows.length > 1) app.mergeAll();
  await until(() => windows.length === 1);
  main = windows[0]!;
  await Bun.sleep(300);

  const closing = main.tabs.at(-1)!;
  if (closing !== first && (await real(main, "a real middle click on a tab", [["move", ...(await tabPoint(main, closing.number))], ["middle"]]))) {
    check("a real middle click on a tab closes it", await until(() => !open.has(closing.number)));
  }
}

// ============================================================ closing
const left = windows[0]!;
const spare = await app.openTab();
await until(() => spare.listening);
await inPage(spare.app, `document.getElementById("close").click()`).catch(() => "closed before it answered");
check("a page's Close Tab button closes its tab", await until(() => !open.has(spare.number)), `${open.size} tabs`);
check("the others hear about it", (await text(first, "count")) === `${open.size} tabs are open.`, await text(first, "count"));

for (let i = 0; i < 5; i++) {
  const busy = await app.openTab("https://bun.sh"); // still loading, and reporting its title as it does
  await Bun.sleep(i * 60);
  app.close(busy);
}
check("closing site tabs while they load leaves the app standing", running && [...open.values()].every((tab) => tab.address !== "https://bun.sh/" || tab === site), `${open.size} tabs`);
const racing = app.openTab();
const raced = left.selected!; // the tab just asked for: its webview does not exist yet
check("a tab can be closed before its webview exists", raced.app === undefined && !raced.ready);
app.close(raced);
check("and goes all the same, pane and all, once the webview arrives", (await racing) === raced && raced.closed && !open.has(raced.number) && !windowExists(raced.pane) && running);

const second2 = await app.moveToNewWindow(left.tabs.at(-1)!);
await app.openTab(undefined, { window: second2 });
await app.openTab(undefined, { window: second2 });
const theirs = [...second2.tabs];
user32.SendMessageW(second2.frame.hwnd, WM_CLOSE, 0n, 0n);
check("closing a window closes its tabs and leaves the other window running", (await until(() => windows.length === 1 && theirs.every((tab) => tab.closed))) && running && !windowExists(second2.frame.hwnd), `${windows.length} window(s)`);

const third = await app.moveToNewWindow(left.tabs.at(-1)!);
const lone = third.tabs[0]!;
await Bun.sleep(300);
if (await real(third, "Alt+F4 pressed in a page", [["move", third.frame.stripRect().x + 300, third.frame.stripRect().y + 300], ["down"], ["up"], ["key", 0x12, 0x73]])) {
  check("Alt+F4 pressed in a page closes that window and no other", (await until(() => windows.length === 1 && lone.closed)) && running && windows[0] === left, `${windows.length} window(s)`);
} else app.closeWindow(third);

for (const tab of left.tabs.slice(1)) app.close(tab);
await Bun.sleep(300);
const last = left.tabs[0]!;
check("the last tab left is selected and on show", left.tabs.length === 1 && left.selected === last && onShow(last), `${left.tabs.length} tab(s)`);
await capture(left, "11-last-tab.png");
app.close(last);
const ended = await Promise.race([loop.then(() => true), Bun.sleep(4000).then(() => false)]);
check("closing the last tab closes the window and ends the app", ended && open.size === 0 && windows.length === 0);

console.log(failures === 0 ? `\nall checks passed${skipped ? `, ${skipped} skipped` : ""}; captures in ${out}` : `\n${failures} check(s) failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failures === 0 ? 0 : 1);
