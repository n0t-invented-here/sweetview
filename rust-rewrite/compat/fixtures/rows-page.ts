// The page side of the guide's rows that run inside a webview: bundled by
// rows-desktop.ts and loaded by an app made with `createApp`. It calls the
// page-side forms (`isWebview`, `webviewTransport`, `signalReady`,
// `windowChromeControls`, `wsUrl`, `createBridge`) where they are meant to
// run, and reports what they gave through the UI method `rows.report`.

import { createBridge } from "@n1h/sweetview/ipc";
import { wsUrl } from "@n1h/sweetview/ipc-ws/client";
import { isWebview, signalReady, webviewTransport } from "@n1h/sweetview/page";
import { windowChromeControls } from "@n1h/sweetview/window-chrome";

const report: Record<string, unknown> = {};
const step = async (name: string, work: () => unknown) => {
  try {
    report[name] = await work();
  } catch (err) {
    report[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
};

const transport = webviewTransport();
await step("isWebview", () => isWebview());
await step("origin", () => location.origin);
await step("wsUrl", () => wsUrl("/sock"));
await step("signalReady", async () => (await signalReady(), "resolved"));
const chrome = windowChromeControls(transport);
await step("chromeInfo", () => chrome.info());
const bridge = createBridge<{ echo: [string, string] }, Record<string, never>>(transport);
await step("workerEcho", () => bridge.rpc("echo", "from the page"));
await step("workerRequest", async () => (await fetch("/rows-dynamic")).text());
// Last: the window is minimised by the page's own control.
chrome.minimize();
transport.notify("rows.report", report);
