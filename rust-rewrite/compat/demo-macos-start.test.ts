// The tray demos start and close in their 1.0 form (showOnReady with the page's signalReady(),
// closeToTrayOnLastWindow) on Windows only. Until the macOS goal (D42), macOS starts and closes each
// as at the tag pre-rust-rewrite: shown at once where it was, hidden by its own onClose. Read from
// the demos' source, since nothing here runs on a Mac.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

test("the tray demos run the 1.0 start off macOS only, and the tag's start and close on macOS", () => {
  const seen: Record<string, Record<string, boolean>> = {};
  for (const [app, page, showsAtStart] of [
    ["demos/web-app/app.ts", "demos/web-app/packages/web-app-frontend/src/main.tsx", true],
    ["demos/menubar-notify/app.ts", "demos/menubar-notify/frontend/main.ts", false],
  ] as const) {
    const a = read(app);
    const p = read(page);
    seen[app] = {
      macFlag: a.includes('const MAC_TAG_PATH = process.platform === "darwin";'),
      closeToTrayOffMac: /if \(!MAC_TAG_PATH\) closeToTrayOnLastWindow\(app\.window\);/.test(a) && !/^closeToTrayOnLastWindow\(/m.test(a),
      tagCloseOnMac: a.includes("...(MAC_TAG_PATH ? { onClose: () => app.window.hide() } : {}),"),
      showOnReadyOffMac: !/showOnReady: true/.test(a) && (!showsAtStart || a.includes("showOnReady: !MAC_TAG_PATH,")),
      tagShowOnMac: !showsAtStart || a.includes("if (MAC_TAG_PATH) app.window.show();"),
      pageSignalsOffMac: /if \(!macTagPath\)[^\n]*signalReady\(\)/.test(p) && !/^\s*(requestAnimationFrame\(\(\) => )?void signalReady\(\)/m.test(p),
    };
  }
  const all = { macFlag: true, closeToTrayOffMac: true, tagCloseOnMac: true, showOnReadyOffMac: true, tagShowOnMac: true, pageSignalsOffMac: true };
  expect(seen).toEqual({ "demos/web-app/app.ts": all, "demos/menubar-notify/app.ts": all });
});

test("menubar-notify keeps its own protocol as at the tag on every platform: the page's history call is still page.ready", () => {
  const app = read("demos/menubar-notify/app.ts");
  const service = read("demos/menubar-notify/service.ts");
  const page = read("demos/menubar-notify/frontend/main.ts");
  expect({
    app: app.includes('"page.ready": () => {'),
    service: service.includes('"page.ready": [void, LogEntry[]];') && service.includes('"page.ready": () => {'),
    page: page.includes('await bridge.rpc("page.ready")'),
    renamed: /log\.history/.test(app + service + page),
  }).toEqual({ app: true, service: true, page: true, renamed: false });
});

test("the desktop pet appears when its page has drawn it, off macOS; on macOS it is shown at once, as at the tag", () => {
  const a = read("demos/desktop-pet/app.ts");
  const p = read("demos/desktop-pet/frontend/main.ts");
  expect({
    macFlag: a.includes('const MAC_TAG_PATH = process.platform === "darwin";'),
    showOnReadyOffMac: a.includes("showOnReady: !MAC_TAG_PATH,"),
    tagShowOnMac: a.includes("if (MAC_TAG_PATH) overlay.show();") && !/^overlay\.show\(\);/m.test(a),
    pageSignalsOffMac: /if \(!macTagPath\) void signalReady\(\);/.test(p),
  }).toEqual({ macFlag: true, showOnReadyOffMac: true, tagShowOnMac: true, pageSignalsOffMac: true });
});
