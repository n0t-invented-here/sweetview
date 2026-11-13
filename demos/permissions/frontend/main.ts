// The window's page: every permission with what macOS says about it now, read
// from the UI thread every two seconds, so an answer given in a prompt or in
// System Settings shows up without a click.

import "./main.css";

import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import { GROUPS, type Events, type Methods } from "../rows";
import { createView } from "./view";

// A full read is some twenty round trips to the system's privacy service, 150 to 300 ms on the UI thread.
const REFRESH_MS = 2000;
const bridge = createBridge<Methods, Events>(webviewTransport());

const refresh = async () => view.update(await bridge.rpc("permissions.snapshot"));

const view = createView(document.querySelector("main")!, GROUPS, {
  async ask(row) {
    const result = await bridge.rpc("permissions.ask", { id: row.id });
    if ("error" in result) view.notice(result.error, "error");
    else if (result.status === "granted") view.notice(`${row.label}: granted.`);
    else if (result.status === "denied" || result.status === "restricted") view.notice(`${row.label}: ${result.status}. macOS asks once; from here it is the switch in Settings.`);
    else view.notice(`Asked for ${row.label}. Its status changes here when macOS has your answer.`);
    await refresh();
  },
  async settings(row) {
    const opened = await bridge.rpc("permissions.settings", { id: row.id });
    view.notice(opened ? `Opened System Settings for ${row.label}.` : `System Settings did not open for ${row.label}.`, opened ? "info" : "error");
  },
});

await refresh();
setInterval(refresh, REFRESH_MS);
