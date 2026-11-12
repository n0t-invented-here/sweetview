// The window's page: what happened, newest first, and two buttons that do what
// the menu does. Talks to the UI thread and the worker over the sweetview bridge.

import "./main.css";

import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import type { Events, LogEntry, Methods } from "../service";

const bridge = createBridge<Methods, Events>(webviewTransport());

const list = document.getElementById("log") as HTMLOListElement;
const empty = document.getElementById("empty") as HTMLParagraphElement;
const now = document.getElementById("now") as HTMLButtonElement;
const later = document.getElementById("later") as HTMLButtonElement;

const add = (entry: LogEntry) => {
  const item = document.createElement("li");
  item.className = entry.text.startsWith("Clicked") ? "clicked" : entry.text.startsWith("Sent") ? "sent" : "";
  const time = document.createElement("time");
  time.textContent = entry.at;
  const text = document.createElement("span");
  text.textContent = entry.text;
  item.append(time, text);
  list.prepend(item);
  empty.hidden = true;
};

bridge.on("log", add);
now.addEventListener("click", () => bridge.notify("notify.now"));
later.addEventListener("click", () => bridge.notify("notify.later", { seconds: 5 }));

const history = await bridge.rpc("page.ready");
for (const entry of history) add(entry);
