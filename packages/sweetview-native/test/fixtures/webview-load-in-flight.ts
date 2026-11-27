// bind, init and unbind while the page is loading from a Bun.serve in this
// same process, under both loops: argv[2] is "pump" (the loop pumped from a
// Bun timer, so the server can answer) or "run" (the blocking run(), inside
// which this process's JavaScript, the server included, does not run).
// Prints `STEP <text>` as each call is made and returns, written straight to
// stdout so the steps survive a hang, and one `RESULT <json>`. Run by
// src/webview.test.ts with a hard limit, because a call that never returns
// blocks this process's own watchdog too.

import { writeSync } from "node:fs";
import { Webview } from "../../src/webview";
import { finish, native, report, watchdog } from "./kit";

watchdog(30_000);
const mode = process.argv[2];
report.mode = mode;
const steps: string[] = [];
report.steps = steps;
const step = (text: string) => {
  steps.push(text);
  writeSync(1, `STEP ${text}\n`);
};

/** The page each address answers: it reports what it sees to `ready`. */
const page = (name: string) => `<!doctype html><title>${name}</title><script>
(async () => {
  const r = { page: ${JSON.stringify(name)}, during: typeof window.during, early: typeof window.early, init: window.__initDuring === true };
  if (r.during === "function") r.duringResult = await window.during("x");
  window.ready(r);
})();
</script>`;

const DELAY_MS = 500;
let requested: () => void = () => {};
const firstRequested = new Promise<void>((resolve) => (requested = resolve));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 404 });
    if (path === "/first") requested();
    await Bun.sleep(DELAY_MS);
    return new Response(page(path.slice(1)), { headers: { "content-type": "text/html" } });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

const webview = new Webview(false, { width: 400, height: 300, hint: 0 });
const pages: Record<string, unknown>[] = [];
report.pages = pages;
let onPage: (r: Record<string, unknown>) => void = () => {};
webview.bind("ready", (r: Record<string, unknown>) => {
  pages.push(r);
  onPage(r);
});
webview.bind("early", () => "early");
const nextPage = () => new Promise<Record<string, unknown>>((resolve) => (onPage = resolve));

/** The three calls, made while the navigation to /first waits for its response. */
function callsDuringLoad() {
  step("bind");
  webview.bind("during", (x: string) => `during:${x}`);
  step("bind returned");
  step("init");
  webview.init("window.__initDuring = true");
  step("init returned");
  step("unbind");
  webview.unbind("early");
  step("unbind returned");
}

if (mode === "pump") {
  const pump = setInterval(() => native.pumpEvents(), 8);
  let first = nextPage();
  webview.navigate(`${origin}/first`);
  await firstRequested;
  callsDuringLoad();
  report.firstLoaded = (await first).page === "first";
  // The next navigation has all three calls applied.
  first = nextPage();
  webview.navigate(`${origin}/second`);
  report.next = await first;
  clearInterval(pump);
  webview.destroy();
  finish();
}

if (mode === "run") {
  // run() blocks this process's JavaScript, so /first is never answered while
  // it runs; the calls are made from a native timeout inside run(), and the
  // next navigation is setHTML, which needs no server.
  webview.navigate(`${origin}/first`);
  native.scheduleTimeout(1_000, () => {
    callsDuringLoad();
    onPage = (r) => {
      report.next = r;
      webview.destroy();
    };
    webview.setHTML(page("second"));
  });
  webview.run();
  report.runReturned = true;
  report.firstLoaded = pages.some((p) => p.page === "first");
  finish();
}
