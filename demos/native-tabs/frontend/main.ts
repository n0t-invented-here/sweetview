// A tab's page. Everything it shows is this page's own: the instance tag, the
// clock and the click count live in this webview and no other, which is the
// point of the demo. It asks the UI thread who it is, and tells it when the
// user opens, renames or closes a tab.

import "./main.css";

import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import type { Events, Methods } from "../shared";

const bridge = createBridge<Methods, Events>(webviewTransport());
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const title = element<HTMLInputElement>("title");
const count = element("count");
const error = element("error");
const address = element<HTMLInputElement>("address");

const showCount = (tabs: number) => (count.textContent = tabs === 1 ? "It is the only one open." : `${tabs} are open.`);
bridge.on("tabs", ({ count: tabs }) => showCount(tabs));

const me = await bridge.rpc("tab.info");
document.documentElement.style.setProperty("--hue", String((me.number * 67 + 200) % 360)); // a colour of its own per tab
title.value = me.title;
showCount(me.tabs);

element("instance").textContent = crypto.randomUUID().slice(0, 4);
const startedAt = Date.now();
const alive = element("alive");
const tick = () => {
  const s = Math.round((Date.now() - startedAt) / 1000);
  alive.textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
tick();
setInterval(tick, 1000);
// WebKit slows the timers of a tab nobody is looking at; be right the moment it is looked at again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

let clicks = 0;
const clicksShown = element("clicks");
element("click").addEventListener("click", () => (clicksShown.textContent = String(++clicks)));

title.addEventListener("input", () => bridge.notify("tab.rename", title.value));
title.addEventListener("keydown", (event) => {
  if (event.key === "Enter") title.blur();
});
title.addEventListener("blur", () => {
  if (title.value.trim() === "") title.value = `Tab ${me.number}`; // what the tab bar fell back to
});

element("new").addEventListener("click", () => bridge.notify("tab.open", null));
element("close").addEventListener("click", () => bridge.notify("tab.close"));

element<HTMLFormElement>("open").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await bridge.rpc("tab.open", address.value);
    error.hidden = true;
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.hidden = false;
  }
});
address.addEventListener("input", () => (error.hidden = true));
