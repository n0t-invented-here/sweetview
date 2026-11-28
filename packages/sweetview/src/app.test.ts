// Live Windows tests for WebView.attach, createApp outer-bounds & style preservation,
// ringBytes validation, error-path recovery, and Layer 1 tabbed Window disposal
// (both explicit win.dispose() and default WM_CLOSE), and their live macOS
// counterparts on NSWindow and WKWebView.

import { describe, expect, test } from "bun:test";
import { createApp, WebView } from "./index";
import { RawWebview, SizeHint, Window, closeToTrayOnLastWindow, onOpenUrl, pumpEvents } from "@n1h/sweetview-native";
import { emitActivationUrl } from "@n1h/sweetview-native/internal";
import { _resetActivationForTest } from "../../sweetview-native/src/activation";

const onWindows = process.platform === "win32";
const liveDesktop = onWindows || process.platform === "darwin";

const htmlBytes = (html: string) => new TextEncoder().encode(html);

// How long a live test waits for something that must happen. WebView2 itself can take seconds to
// start on a loaded machine, and that is not what these tests measure; a wait ends as soon as
// its condition holds.
const LIVE_TEST_MS = 30_000;

function pumpUntil(done: () => boolean, budgetMs = 10_000): void {
  const deadline = performance.now() + budgetMs;
  do {
    pumpEvents();
    if (done()) return;
    Bun.sleepSync(5);
  } while (performance.now() < deadline);
}

describe.if(liveDesktop)("desktop startup & deferred RPC", () => {
  test("a native watchdog fires during pumpEvents, loads fallback HTML, and reveals the window", async () => {
    const win = new Window({ noActivate: true });
    let timeouts = 0;
    let fallbackLoaded = false;
    const view = await WebView.attach(win, {
      url: "about:blank",
      showOnReady: true,
      readyTimeoutMs: 30,
      readyFallbackHtml: '<script>window.__sweetview_rpc("fallbackLoaded", null)</script>',
      onReadyTimeout: () => { timeouts++; },
      uiMethods: { fallbackLoaded: () => { fallbackLoaded = true; } },
    });
    try {
      expect(win.isVisible()).toBe(false);
      pumpUntil(() => fallbackLoaded);
      expect(timeouts).toBe(1);
      expect(win.isVisible()).toBe(true);
      expect(fallbackLoaded).toBe(true);
    } finally {
      view.dispose();
      win.dispose();
    }
  }, LIVE_TEST_MS);

  test("a native watchdog also fires while webview_run blocks Bun", async () => {
    // A broken watchdog could hang a blocking native run. Bound it from the parent: twenty seconds,
    // which a run whose watchdog fires never needs and a slow start of WebView2 does not reach.
    const script = `
      import { createApp } from "@n1h/sweetview";
      let timeouts = 0;
      const app = await createApp({
        url: "about:blank",
        readyTimeoutMs: 30,
        onReadyTimeout: () => { timeouts++; app.quit(); },
      });
      try {
        app.run();
        console.log(JSON.stringify({ timeouts, visible: app.window.isVisible() }));
      } finally {
        app.dispose();
      }
      const next = await createApp({ url: "about:blank" });
      next.dispose();
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit", timeout: 20_000 });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ timeouts: 1, visible: false });
  }, LIVE_TEST_MS);

  test("the ready handshake drains activation, acknowledges duplicates, and cancels the watchdog", async () => {
    _resetActivationForTest();
    const win = new Window({ noActivate: true });
    const order: string[] = [];
    const offUrl = onOpenUrl((url) => order.push(url));
    const activationUrl = "sweetview-ready-test://queued";
    emitActivationUrl(activationUrl);
    expect(order).toEqual([]);
    let ack: unknown;
    let view: WebView | undefined;
    try {
      view = await WebView.attach(win, {
        assets: { "index.html": htmlBytes(`<script>
          window.__sweetview_rpc("__sweetview.ready", null)
            .then(result => window.__sweetview_rpc("__sweetview.ready", null).then(duplicate =>
              window.__sweetview_rpc("capture", [result, duplicate])));
        </script>`) },
        showOnReady: true,
        readyTimeoutMs: 1000,
        onReady: () => order.push("ready"),
        onReadyTimeout: () => order.push("timeout"),
        uiMethods: { capture: (params: unknown) => { ack = params; } },
      });
      expect(win.isVisible()).toBe(false);
      pumpUntil(() => ack !== undefined);
      expect(ack).toEqual([null, null]);
      expect(order).toEqual([activationUrl, "ready"]);
      expect(win.isVisible()).toBe(true);
      // Run past the original deadline with Bun's event loop blocked.
      pumpUntil(() => order.includes("timeout"), 1050);
      expect(order).toEqual([activationUrl, "ready"]);
    } finally {
      offUrl();
      _resetActivationForTest();
      view?.dispose();
      win.dispose();
    }
  }, LIVE_TEST_MS);

  test("keeps startup behavior opt-in and cancels an armed watchdog on disposal", async () => {
    const win = new Window({ noActivate: true });
    let timeouts = 0;
    let view: WebView | undefined;
    try {
      view = await WebView.attach(win, { url: "about:blank", onReadyTimeout: () => { timeouts++; } });
      pumpUntil(() => win.isVisible(), 50);
      expect(win.isVisible()).toBe(false);
      expect(timeouts).toBe(0);
      view.dispose();
      view = await WebView.attach(win, {
        url: "about:blank",
        showOnReady: true,
        readyTimeoutMs: 30,
        onReadyTimeout: () => { timeouts++; },
      });
      view.dispose();
      pumpUntil(() => win.isVisible(), 60);
      expect(timeouts).toBe(0);
      expect(win.isVisible()).toBe(false);
    } finally {
      view?.dispose();
      win.dispose();
    }
  });

  test("dispatches deferred RPCs without reentering a running UI handler", async () => {
    const win = new Window();
    const calls: string[] = [];
    let result: unknown;
    const view = await WebView.attach(win, {
      assets: { "index.html": htmlBytes(`<script>
        const rpc = window.__sweetview_rpc;
        Promise.all([
          rpc("modal", "first"),
          rpc("modal", "second"),
          rpc("bad", null).catch(error => error.message),
        ]).then(values => rpc("capture", values));
      </script>`) },
      uiMethods: { capture: (params: unknown) => { result = params; } },
      deferredUiMethods: {
        modal: (params: unknown) => {
          calls.push(`open ${params}`);
          pumpUntil(() => false, 30);
          calls.push(`close ${params}`);
          return params;
        },
        bad: () => Promise.reject(new Error("async UI code")),
      },
    });
    try {
      pumpUntil(() => result !== undefined);
      expect(calls).toEqual(["open first", "close first", "open second", "close second"]);
      expect(result).toEqual(["first", "second", expect.stringContaining("must return synchronously")]);
    } finally {
      view.dispose();
      win.dispose();
    }
  });

  test("rejects duplicate UI method names before attaching", async () => {
    const win = new Window();
    try {
      await expect(WebView.attach(win, {
        url: "about:blank",
        uiMethods: { duplicate: () => null },
        deferredUiMethods: { duplicate: () => null },
      })).rejects.toThrow(/duplicate is defined in both uiMethods and deferredUiMethods/);
    } finally {
      win.dispose();
    }
  });
});

describe.if(onWindows)("WebView & createApp (win32)", () => {
  test("a window's backgroundColor is what shows behind a page that paints nothing, and after its webview has gone; createApp takes contentSize and backgroundColor", async () => {
    const { clientSize, clientToScreen, screenPixel } = await import("../../sweetview-native/test/win32-os");
    const win = new Window({ title: "app.test background", backgroundColor: "#305070", topmost: true, noActivate: true, contentSize: { width: 360, height: 240 } });
    const hwnd = BigInt(win.handle!);
    // The page draws a green stripe at its top: seen there, the webview is shown, so the colour below is the browser's.
    const MARK = "#00ff00";
    const sampled = () => {
      const size = clientSize(hwnd);
      const top = clientToScreen(hwnd, size.width >> 1, 8);
      const middle = clientToScreen(hwnd, size.width >> 1, size.height >> 1);
      return { top: screenPixel(top.x, top.y), middle: screenPixel(middle.x, middle.y) };
    };
    const settle = (want: { top: string; middle: string }) => {
      let seen = { top: "", middle: "" };
      const deadline = performance.now() + 5000;
      do {
        pumpEvents();
        seen = sampled();
        if (seen.top === want.top && seen.middle === want.middle) break;
        Bun.sleepSync(20);
      } while (performance.now() < deadline);
      return seen;
    };
    let loaded = false;
    let view: WebView | undefined;
    try {
      // A page with no background of its own: what shows is the browser's background behind it.
      view = await WebView.attach(win, {
        assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}#m{height:16px;background:${MARK}}</style><div id="m"></div><script>window.__sweetview_rpc("loaded", null)</script>`) },
        uiMethods: { loaded: () => { loaded = true; } },
      });
      win.show();
      pumpUntil(() => loaded, 15_000);
      expect(loaded).toBe(true);
      expect(settle({ top: MARK, middle: "#305070" })).toEqual({ top: MARK, middle: "#305070" });
      view.dispose();
      view = undefined;
      // The webview is gone (no stripe) and the window shows its colour everywhere.
      expect(settle({ top: "#305070", middle: "#305070" })).toEqual({ top: "#305070", middle: "#305070" });
    } finally {
      view?.dispose();
      win.dispose();
    }

    // createApp: the page area is contentSize at the screen's scale, and the browser shows backgroundColor behind the page.
    let appLoaded = false;
    const app = await createApp({
      title: "app.test createApp background",
      topmost: true,
      noActivate: true,
      contentSize: { width: 300, height: 200 },
      backgroundColor: "#102030",
      assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}#m{height:16px;background:${MARK}}</style><div id="m"></div><script>window.__sweetview_rpc("loaded", null)</script>`) },
      uiMethods: { loaded: () => { appLoaded = true; } },
    });
    try {
      const appHwnd = BigInt(app.window.handle!);
      const scale = app.window.scale();
      expect(clientSize(appHwnd)).toEqual({ width: Math.round(300 * scale), height: Math.round(200 * scale) });
      app.window.show();
      pumpUntil(() => appLoaded, 15_000);
      let seen = { top: "", middle: "" };
      const deadline = performance.now() + 5000;
      do {
        pumpEvents();
        const size = clientSize(appHwnd);
        const top = clientToScreen(appHwnd, size.width >> 1, 8);
        const middle = clientToScreen(appHwnd, size.width >> 1, size.height >> 1);
        seen = { top: screenPixel(top.x, top.y), middle: screenPixel(middle.x, middle.y) };
        if (seen.top === MARK && seen.middle === "#102030") break;
        Bun.sleepSync(20);
      } while (performance.now() < deadline);
      expect(seen).toEqual({ top: MARK, middle: "#102030" });
    } finally {
      app.dispose();
    }

    // A tab of a tabbed window takes the window's backgroundColor behind its page too.
    const tabbed = new Window({ tabs: true, backgroundColor: "#507030", topmost: true, noActivate: true, contentSize: { width: 520, height: 340 } });
    const frame = BigInt(tabbed.handle!);
    let tabLoaded = false;
    try {
      await WebView.openTab(tabbed, {
        title: "background",
        assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}</style><script>window.__sweetview_rpc("loaded", null)</script>`) },
        uiMethods: { loaded: () => { tabLoaded = true; } },
      });
      tabbed.show();
      pumpUntil(() => tabLoaded, 15_000);
      expect(tabLoaded).toBe(true);
      const size = clientSize(frame);
      const { STRIP_HEIGHT } = await import("@n1h/sweetview-native/win32/strip-shared");
      const strip = Math.round(STRIP_HEIGHT * tabbed.scale());
      let seen = "";
      const deadline = performance.now() + 5000;
      do {
        pumpEvents();
        const at = clientToScreen(frame, size.width >> 1, strip + ((size.height - strip) >> 1));
        seen = screenPixel(at.x, at.y);
        if (seen === "#507030") break;
        Bun.sleepSync(20);
      } while (performance.now() < deadline);
      expect(seen).toBe("#507030");
    } finally {
      tabbed.dispose();
    }
  }, 90_000);

  test("the browser's background is the colour of the window the page is in: through a wrapper of a coloured window, for a tab moved into another tabbed window, for a tab opened in a torn-off window", async () => {
    // Review finding 5 and N4. Each page draws a green stripe at its top and leaves the rest
    // transparent: the stripe shows the webview is there, so the colour below it is the browser's.
    const { clientSize, clientToScreen, screenPixel } = await import("../../sweetview-native/test/win32-os");
    const { getWindowMeta } = await import("@n1h/sweetview-native/internal");
    const { STRIP_HEIGHT } = await import("@n1h/sweetview-native/win32/strip-shared");
    // Each page draws a stripe of its own colour (round 2's finding 9: the tab sampled is the one meant).
    const STRIPES = { wrapped: "#00ff00", home: "#0000ff", moved: "#ff00ff", second: "#00ffff" } as const;
    let MARK = "";
    const loaded = new Set<string>();
    const page = (name: string) => ({
      assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}#m{height:16px;background:${STRIPES[name as keyof typeof STRIPES]}}</style><div id="m"></div><script>window.__sweetview_rpc("loaded", "${name}")</script>`) },
      uiMethods: { loaded: (n: unknown) => void loaded.add(String(n)) },
    });
    const painted = (win: Window, top: number, want: string, name: keyof typeof STRIPES) => {
      MARK = STRIPES[name];
      const hwnd = BigInt(win.handle!);
      let seen = { mark: "", below: "" };
      const deadline = performance.now() + 8000;
      do {
        pumpEvents();
        const size = clientSize(hwnd);
        const mark = clientToScreen(hwnd, size.width >> 1, top + 8);
        const below = clientToScreen(hwnd, size.width >> 1, top + ((size.height - top) >> 1));
        seen = { mark: screenPixel(mark.x, mark.y), below: screenPixel(below.x, below.y) };
        if (seen.mark === MARK && seen.below === want) break;
        Bun.sleepSync(20);
      } while (performance.now() < deadline);
      return seen;
    };
    const strip = (win: Window) => Math.round(STRIP_HEIGHT * win.scale());
    const size = { width: 520, height: 340 };

    const own = new Window({ title: "app.test wrapped background", backgroundColor: "#305070", topmost: true, noActivate: true, contentSize: size });
    const wrapper = Window.fromHandle(own.handle);
    let view: WebView | undefined;
    try {
      expect(getWindowMeta(wrapper).backgroundColor).toBe("#305070");
      view = await WebView.attach(wrapper, page("wrapped"));
      own.show();
      pumpUntil(() => loaded.has("wrapped"), 15_000);
      expect(painted(own, 0, "#305070", "wrapped")).toEqual({ mark: STRIPES.wrapped, below: "#305070" });
    } finally {
      view?.dispose();
      wrapper.dispose();
      own.dispose();
    }

    const app = await createApp({ tabs: true, title: "app.test blue", backgroundColor: "#203080", topmost: true, noActivate: true, contentSize: size });
    const red = new Window({ tabs: true, title: "app.test red", backgroundColor: "#a02020", topmost: true, noActivate: true, contentSize: size });
    let tornOff: Window | undefined;
    try {
      // The blue window has a tab of its own first: a tabbed window takes merged tabs once it has one.
      await app.openTab({ title: "home", ...page("home") });
      app.window.show();
      pumpUntil(() => loaded.has("home"), 15_000);
      const tab = await WebView.openTab(red, { title: "moved", ...page("moved") });
      red.show();
      pumpUntil(() => loaded.has("moved"), 15_000);
      expect(painted(red, strip(red), "#a02020", "moved")).toEqual({ mark: STRIPES.moved, below: "#a02020" });
      // Into the blue window, through the public merge.
      app.mergeAllWindows();
      app.window.show();
      expect(tab.window).toBe(app.window);
      tab.select(); // the merge keeps the window's own tab shown
      expect(painted(app.window, strip(app.window), "#203080", "moved")).toEqual({ mark: STRIPES.moved, below: "#203080" });
      // Torn off into a window of its own, which is the window it came from in every option, its colour included.
      tornOff = await tab.moveToNewWindow();
      expect(getWindowMeta(tornOff).backgroundColor).toBe("#203080");
      tornOff.setTopmost(true);
      await WebView.openTab(tornOff, { title: "second", ...page("second") });
      pumpUntil(() => loaded.has("second"), 15_000);
      expect(painted(tornOff, strip(tornOff), "#203080", "second")).toEqual({ mark: STRIPES.second, below: "#203080" });
    } finally {
      tornOff?.dispose();
      red.dispose();
      app.dispose();
    }
  }, 120_000);

  test("the documented window chrome on a real frameless window and page: window.maximize maximises, windowChromeEvents tells the page, and while window.systemMenu's menu is open a call the page starts is answered and the page acknowledges the answer", async () => {
    // Review N7 (the chrome only ever ran against stand-ins) and finding 1 (the system menu from
    // uiMethods, inside WebView2's message callback: the page's calls still arrive and are answered).
    const { openPopupMenu, pressKeys, VK } = await import("../../sweetview-native/test/win32-os");
    const { scheduleNativeTimeout } = await import("@n1h/sweetview-native/internal");
    const { windowChromeEvents, windowChromeMethods } = await import("./window-chrome");
    const win = new Window({ title: "app.test chrome", frame: false, transparent: true, noActivate: true, contentSize: { width: 420, height: 300 } });
    // The page's calls by number, and the answers it acknowledges having received.
    let lastPing = 0;
    const acks: number[] = [];
    const told: unknown[] = [];
    let menu: { openedAfter: number; acksWhileOpen: number[] } | undefined;
    let view: WebView | undefined;
    try {
      view = await WebView.attach(win, {
        // As docs/window-chrome.md attaches it: the chrome's methods in uiMethods.
        uiMethods: {
          ...windowChromeMethods(win),
          ping: (n: unknown) => ((lastPing = Number(n)), Number(n)),
          ack: (n: unknown) => void acks.push(Number(n)),
          told: (payload: unknown) => void told.push(payload),
        } as never,
        assets: {
          "index.html": htmlBytes(`<script>
            window.__sweetview_emit = (name, payload) => { if (name === "window.maximized") window.__sweetview_rpc("told", payload); };
            let n = 0;
            setInterval(() => {
              n++;
              // Each answer, once it reaches the page, is acknowledged with the number it answered.
              window.__sweetview_rpc("ping", n).then((answer) => window.__sweetview_rpc("ack", answer));
              if (n === 3) window.__sweetview_rpc("window.maximize", null); // the maximise button
              if (n === 8) window.__sweetview_rpc("window.systemMenu", null); // the title bar's right click
            }, 25);
          </script>`),
        },
      });
      windowChromeEvents(win, view as unknown as { emit(name: "window.maximized", payload: { maximized: boolean }): void });
      win.show();
      pumpUntil(() => told.length > 0, 15_000);
      expect({ maximized: win.isMaximized(), told }).toEqual({ maximized: true, told: [{ maximized: true }] });
      // From inside the menu's modal loop: for 400 ms, then the menu is closed. The acknowledgements
      // read then are of calls the page started after the menu opened, answered and received before it closes.
      const watch = (end: number) => {
        if (openPopupMenu() !== 0n && menu === undefined) {
          const openedAfter = lastPing;
          scheduleNativeTimeout(400, () => {
            menu = { openedAfter, acksWhileOpen: acks.filter((n) => n > openedAfter) };
            const open = openPopupMenu();
            if (open !== 0n) pressKeys(open, VK.ESCAPE);
          });
          return;
        }
        if (menu === undefined && performance.now() < end) scheduleNativeTimeout(10, () => watch(end));
      };
      watch(performance.now() + 15_000);
      pumpUntil(() => menu !== undefined && openPopupMenu() === 0n, 20_000);
      expect(menu).toBeDefined();
      expect(menu!.acksWhileOpen.length).toBeGreaterThan(3);
    } finally {
      view?.dispose();
      win.dispose();
    }
  }, 60_000);

  test("a webview attached to a visible window with a backgroundColor, and a tab opened in a visible tabbed window, never show WebView2's white while they start, and the page paints during the interval sampled", async () => {
    // Review N9, and round 2's findings 8 and 9 and M7. Sampled while the webview starts: no white
    // (WebView2's own default background) anywhere, the target page's own stripe seen during the
    // sampling (so the interval sampled is the one it started and painted in), and the page area
    // settled on the window's colour once it has. A page's own canvas, before its stylesheet applies,
    // follows its colour scheme (#121212 in a dark one): that is the page's, not the browser's
    // background (docs/native/windows.md says so). This runtime has ICoreWebView2ControllerOptions3,
    // which is when the colour is WebView2's from the moment it is made.
    const { clientSize, clientToScreen, screenPixel } = await import("../../sweetview-native/test/win32-os");
    const { scheduleNativeTimeout } = await import("@n1h/sweetview-native/internal");
    const { STRIP_HEIGHT } = await import("@n1h/sweetview-native/win32/strip-shared");
    const colour = "#304050";
    const STRIPE = "#ff00ff";
    const stripePage = (loaded: () => void) => ({
      assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}#m{height:16px;background:${STRIPE}}</style><div id="m"></div><script>window.__sweetview_rpc("loaded", null)</script>`) },
      uiMethods: { loaded },
    });
    // Samples the stripe's place and the middle of the page area of `win` (below `top`), from native
    // timers, which fire inside the loops WebView2 pumps while it starts.
    const sampler = (win: Window, top: () => number) => {
      const hwnd = BigInt(win.handle!);
      const stripe = new Set<string>();
      const middle = new Set<string>();
      let lastMiddle = "";
      let on = true;
      const tick = () => {
        if (!on) return;
        const size = clientSize(hwnd);
        const t = top();
        const a = clientToScreen(hwnd, size.width >> 1, t + 8);
        const b = clientToScreen(hwnd, size.width >> 1, t + ((size.height - t) >> 1));
        stripe.add(screenPixel(a.x, a.y));
        lastMiddle = screenPixel(b.x, b.y);
        middle.add(lastMiddle);
        scheduleNativeTimeout(2, tick);
      };
      return { start: tick, stop: () => void (on = false), stripe, middle, lastMiddle: () => lastMiddle };
    };
    const settle = (ms: number) => {
      const until = performance.now() + ms;
      pumpUntil(() => performance.now() > until, ms + 500);
    };
    for (let round = 0; round < 3; round++) {
      // Each round in a place of its own: a window closed at the same place fades out over the next one.
      const win = new Window({ title: `app.test start colour ${round}`, backgroundColor: colour, topmost: true, noActivate: true, bounds: { x: 120 + round * 400, y: 160, width: 360, height: 260 } });
      const s = sampler(win, () => 0);
      let view: WebView | undefined;
      try {
        win.show();
        settle(400); // the window's own fade-in, before the webview starts
        s.start();
        let loaded = false;
        view = await WebView.attach(win, stripePage(() => { loaded = true; }));
        pumpUntil(() => loaded && s.stripe.has(STRIPE), 15_000);
        settle(200);
      } finally {
        s.stop();
        view?.dispose();
        win.dispose();
      }
      const last = s.lastMiddle();
      expect({ round, white: s.middle.has("#ffffff") || s.stripe.has("#ffffff"), stripeSeen: s.stripe.has(STRIPE), settled: last }).toEqual({ round, white: false, stripeSeen: true, settled: colour });
    }

    // A tab opened in a visible tabbed window: its page area, below the strip, as the tab starts.
    const tabbed = new Window({ tabs: true, title: "app.test start colour tab", backgroundColor: colour, topmost: true, noActivate: true, bounds: { x: 140, y: 480, width: 560, height: 380 } });
    const s = sampler(tabbed, () => Math.round(STRIP_HEIGHT * tabbed.scale()));
    try {
      // The first tab makes the strip and paints nothing (no stripe): the stripe seen is the second tab's.
      let firstLoaded = false;
      await WebView.openTab(tabbed, { title: "first", assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}</style><script>window.__sweetview_rpc("loaded", null)</script>`) }, uiMethods: { loaded: () => { firstLoaded = true; } } });
      tabbed.show();
      pumpUntil(() => firstLoaded, 15_000);
      settle(400);
      s.start();
      let loaded = false;
      await WebView.openTab(tabbed, { title: "second", ...stripePage(() => { loaded = true; }) });
      pumpUntil(() => loaded && s.stripe.has(STRIPE), 15_000);
      settle(200);
    } finally {
      s.stop();
      tabbed.dispose();
    }
    expect({ white: s.middle.has("#ffffff") || s.stripe.has("#ffffff"), stripeSeen: s.stripe.has(STRIPE), settled: s.lastMiddle() }).toEqual({ white: false, stripeSeen: true, settled: colour });
  }, 90_000);

  test("a webview made while another is being made takes nothing of it: the colour belongs to the window each is made in", async () => {
    // Review round 2, finding 2. Class: a webview made from inside the creation of another (a native
    // timer fires while WebView2 starts), for every creation path: a window's webview and a tab's.
    const { clientSize, clientToScreen, screenPixel } = await import("../../sweetview-native/test/win32-os");
    const { scheduleNativeTimeout } = await import("@n1h/sweetview-native/internal");
    const plainPixel = async (open: (during: () => void) => Promise<unknown>) => {
      const plain = new Window({ title: "app.test plain", topmost: true, noActivate: true, bounds: { x: 700, y: 140, width: 320, height: 220 } });
      let inner: RawWebview | undefined;
      try {
        let made = false;
        // The first native timer that fires inside the other creation makes a webview in the plain window.
        const during = () => {
          const tick = () => {
            if (made) return;
            made = true;
            inner = new RawWebview(false, { width: 300, height: 200, hint: SizeHint.NONE }, plain.handle);
          };
          scheduleNativeTimeout(1, tick);
        };
        await open(during);
        expect(made).toBe(true);
        // Light, and transparent: what shows is the browser's own background.
        // A green stripe at the top (the webview is there), transparent below (the browser's own background).
        inner!.setHTML('<style>html,body{background:transparent;margin:0}#m{height:16px;background:#00ff00}</style><div id="m"></div>');
        plain.show();
        const hwnd = BigInt(plain.handle!);
        let seen = { mark: "", below: "" };
        const deadline = performance.now() + 8000;
        do {
          pumpEvents();
          const size = clientSize(hwnd);
          const mark = clientToScreen(hwnd, size.width >> 1, 8);
          const below = clientToScreen(hwnd, size.width >> 1, size.height >> 1);
          seen = { mark: screenPixel(mark.x, mark.y), below: screenPixel(below.x, below.y) };
          if (seen.mark === "#00ff00" && seen.below !== "" ) break;
          Bun.sleepSync(20);
        } while (performance.now() < deadline);
        return seen;
      } finally {
        inner?.destroy();
        plain.dispose();
      }
    };
    // A window's webview, made in a blue window.
    const blue = new Window({ title: "app.test blue attach", backgroundColor: "#2040a0", noActivate: true, bounds: { x: 100, y: 140, width: 320, height: 220 } });
    try {
      // The webview is there, and what shows below its stripe is nothing of the blue window's colour.
      const seen = await plainPixel(async (during) => {
        during();
        await WebView.attach(blue, { url: "about:blank" });
      });
      expect(seen.mark).toBe("#00ff00");
      expect(seen.below).not.toBe("#2040a0");
    } finally {
      blue.dispose();
    }
    // A tab's webview, made in a red tabbed window.
    const red = new Window({ tabs: true, title: "app.test red tab", backgroundColor: "#a02020", noActivate: true, bounds: { x: 100, y: 400, width: 520, height: 340 } });
    try {
      const seen = await plainPixel(async (during) => {
        during();
        await WebView.openTab(red, { title: "tab", url: "about:blank" });
      });
      expect(seen.mark).toBe("#00ff00");
      expect(seen.below).not.toBe("#a02020");
    } finally {
      red.dispose();
    }
  }, 90_000);

  test("a tabbed window's strip keeps its own backdrop as it starts, not the page's backgroundColor", async () => {
    // Review round 2, M5: the strip's webview took the page's colour through its frame's wrapper.
    const { clientSize, clientToScreen, screenPixel } = await import("../../sweetview-native/test/win32-os");
    const { scheduleNativeTimeout } = await import("@n1h/sweetview-native/internal");
    const { STRIP_HEIGHT } = await import("@n1h/sweetview-native/win32/strip-shared");
    const red = "#a02020";
    const tabbed = new Window({ tabs: true, title: "app.test strip backdrop", backgroundColor: red, topmost: true, noActivate: true, bounds: { x: 120, y: 160, width: 600, height: 380 } });
    const frame = BigInt(tabbed.handle!);
    const seen = new Set<string>();
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      const strip = Math.round(STRIP_HEIGHT * tabbed.scale());
      // In the strip, right of where the first tab is drawn.
      const at = clientToScreen(frame, clientSize(frame).width - 200, strip >> 1);
      seen.add(screenPixel(at.x, at.y));
      scheduleNativeTimeout(2, sample);
    };
    try {
      tabbed.show();
      sample();
      // The first tab, opened while the window is visible, makes the strip.
      await WebView.openTab(tabbed, { title: "first", url: "about:blank" });
      const settled = performance.now() + 500;
      pumpUntil(() => performance.now() > settled, 1000);
    } finally {
      sampling = false;
      tabbed.dispose();
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.has(red)).toBe(false);
  }, 60_000);

  test("a tab moved into a window with no backgroundColor keeps the background its application set, merged or torn off", async () => {
    // Review round 2, finding 7. Class: every move of a tab (a merge into another window, a tear-off
    // into a new one) into a window with no backgroundColor, from a window with none, of a tab whose
    // application set its webview's background: the move carries the live webview with it.
    const { clientSize, clientToScreen, screenPixel } = await import("../../sweetview-native/test/win32-os");
    const { STRIP_HEIGHT } = await import("@n1h/sweetview-native/win32/strip-shared");
    const loaded = new Set<string>();
    // Each tab draws a stripe of its own colour, so the tab sampled is the one meant.
    const page = (name: string, stripe: string) => ({
      assets: { "index.html": htmlBytes(`<style>html,body{background:transparent;margin:0}#m{height:16px;background:${stripe}}</style><div id="m"></div><script>window.__sweetview_rpc("loaded", "${name}")</script>`) },
      uiMethods: { loaded: (n: unknown) => void loaded.add(String(n)) },
    });
    const painted = (win: Window, want: { mark: string; below: string }) => {
      const hwnd = BigInt(win.handle!);
      const top = Math.round(STRIP_HEIGHT * win.scale());
      let seen = { mark: "", below: "" };
      const deadline = performance.now() + 8000;
      do {
        pumpEvents();
        const size = clientSize(hwnd);
        const mark = clientToScreen(hwnd, size.width >> 1, top + 8);
        const below = clientToScreen(hwnd, size.width >> 1, top + ((size.height - top) >> 1));
        seen = { mark: screenPixel(mark.x, mark.y), below: screenPixel(below.x, below.y) };
        if (seen.mark === want.mark && seen.below === want.below) break;
        Bun.sleepSync(20);
      } while (performance.now() < deadline);
      return seen;
    };
    const size = { width: 520, height: 340 };
    const app = await createApp({ tabs: true, title: "app.test plain app", topmost: true, noActivate: true, contentSize: size });
    const other = new Window({ tabs: true, title: "app.test plain other", topmost: true, noActivate: true, contentSize: size });
    let tornOff: Window | undefined;
    try {
      await app.openTab({ title: "home", ...page("home", "#0000ff") });
      app.window.show();
      pumpUntil(() => loaded.has("home"), 15_000);
      const tab = await WebView.openTab(other, { title: "own", ...page("own", "#00ff00") });
      other.show();
      pumpUntil(() => loaded.has("own"), 15_000);
      // The application's own colour for its tab's background.
      tab.webview.raw.setBackgroundColor(0x60, 0x30, 0x90, 255);
      const own = { mark: "#00ff00", below: "#603090" };
      expect(painted(other, own)).toEqual(own);
      app.mergeAllWindows();
      tab.select();
      expect(tab.window).toBe(app.window);
      expect(painted(app.window, own)).toEqual(own);
      tornOff = await tab.moveToNewWindow();
      tornOff.setTopmost(true);
      expect(painted(tornOff, own)).toEqual(own);
    } finally {
      tornOff?.dispose();
      other.dispose();
      app.dispose();
    }
  }, 120_000);

  test("close-to-tray can intercept the default close on a createApp window", async () => {
    const { WM_CLOSE, user32 } = await import("../../sweetview-native/test/win32-os");
    const app = await createApp({ url: "about:blank", noActivate: true });
    const hwnd = BigInt(app.window.handle!);
    let hides = 0;
    const unsubscribe = closeToTrayOnLastWindow(app.window, () => { hides++; });
    try {
      app.window.show();
      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(hides).toBe(1);
      expect(app.window.isVisible()).toBe(false);
      expect(user32.IsWindow(hwnd)).not.toBe(0);
      expect(app.webview?.raw.unsafeHandle).not.toBeNull();
    } finally {
      unsubscribe();
      app.dispose();
    }
  });
  test("WebView.attach rejects invalid ringBytes (below 128, non-power-of-two, > 2^30) without poisoning later attaches", async () => {
    const win = new Window({ title: "Ring Validation", bounds: { x: 100, y: 100, width: 400, height: 300 } });
    try {
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 32 })).rejects.toThrow(/power of two between 128/);
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 200 })).rejects.toThrow(/power of two between 128/);
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 2 ** 31 })).rejects.toThrow(/power of two between 128/);
      // A healthy attach afterward must succeed cleanly.
      const view = await WebView.attach(win, { url: "about:blank", ringBytes: 256 });
      view.dispose();
    } finally {
      win.dispose();
    }
  });

  test("failed WebView.attach (missing asset) discards WM_QUIT so subsequent attaches succeed", async () => {
    const w1 = new Window({ title: "Bad Attach", bounds: { x: 100, y: 100, width: 400, height: 300 } });
    const w2 = new Window({ title: "Good Attach After Failure", bounds: { x: 140, y: 140, width: 400, height: 300 } });
    try {
      await expect(
        WebView.attach(w1, { assets: { "index.html": "C:/definitely-nonexistent-sweetview-test/index.html" } }),
      ).rejects.toThrow();
      const view = await WebView.attach(w2, { url: "about:blank" });
      expect(view.raw.unsafeHandle).not.toBeNull();
      view.dispose();
    } finally {
      w1.dispose();
      w2.dispose();
    }
  });

  test("WebView.attach preserves exact outer bounds and GWL_STYLE for framed, frameless-resizable, and Window.fromHandle windows", async () => {
    const { GWL_STYLE, user32 } = await import("../../sweetview-native/test/win32-os");
    const { asHwnd } = await import("@n1h/sweetview-native/win32/window");

    // 1. Owned framed window
    const target = { x: 120, y: 120, width: 640, height: 480 };
    const win = new Window({ title: "Attach Bounds", bounds: target });
    const framedStyleBefore = user32.GetWindowLongPtrW(asHwnd(win.handle), GWL_STYLE);
    const view = await WebView.attach(win, { url: "about:blank" });
    try {
      expect(win.bounds()).toEqual(target);
      expect(user32.GetWindowLongPtrW(asHwnd(win.handle), GWL_STYLE)).toBe(framedStyleBefore);
    } finally {
      view.dispose();
      win.dispose();
    }

    // 2. createApp framed window
    const app = await createApp({ title: "App Bounds", bounds: target, url: "about:blank" });
    try {
      expect(app.window.bounds()).toEqual(target);
    } finally {
      app.dispose();
    }

    // 3. Owned frameless + resizable window keeps exact style (no WS_THICKFRAME) and bounds
    const frameless = new Window({ frame: false, resizable: true, bounds: { x: 100, y: 100, width: 500, height: 400 } });
    const styleBefore = user32.GetWindowLongPtrW(asHwnd(frameless.handle), GWL_STYLE);
    const framelessView = await WebView.attach(frameless, { url: "about:blank" });
    try {
      expect(frameless.bounds()).toEqual({ x: 100, y: 100, width: 500, height: 400 });
      expect(user32.GetWindowLongPtrW(asHwnd(frameless.handle), GWL_STYLE)).toBe(styleBefore);
    } finally {
      framelessView.dispose();
      frameless.dispose();
    }

    // 4. Borrowed Window.fromHandle wrapper keeps exact style and bounds
    const host = new Window({ frame: false, bounds: { x: 110, y: 110, width: 500, height: 400 } });
    const hostStyleBefore = user32.GetWindowLongPtrW(asHwnd(host.handle), GWL_STYLE);
    const borrowed = Window.fromHandle(host.handle);
    const borrowedView = await WebView.attach(borrowed, { url: "about:blank" });
    try {
      expect(host.bounds()).toEqual({ x: 110, y: 110, width: 500, height: 400 });
      expect(user32.GetWindowLongPtrW(asHwnd(host.handle), GWL_STYLE)).toBe(hostStyleBefore);
    } finally {
      borrowedView.dispose();
      borrowed.dispose();
      host.dispose();
    }
  });

  test("WebView.attach mounts a webview in an application's own window (CreateWindowExW through bun:ffi): the page loads and answers a call; the window keeps GWL_STYLE and its outer bounds", async () => {
    const { GWL_STYLE, WS_OVERLAPPEDWINDOW, hInstance, user32, wide, windowRect } = await import("../../sweetview-native/test/win32-os");
    // Not made by Sweetview: a STATIC window of the application's own, as the fromHandle event test makes it.
    const hwnd = user32.CreateWindowExW(0, wide("STATIC"), wide(`app.test own window ${process.pid}`), WS_OVERLAPPEDWINDOW, 130, 120, 520, 380, 0n, 0n, hInstance(), null);
    expect(hwnd).not.toBe(0n);
    const styleBefore = user32.GetWindowLongPtrW(hwnd, GWL_STYLE);
    const rectBefore = windowRect(hwnd);
    const borrowed = Window.fromHandle(hwnd);
    let answered: unknown;
    let view: WebView | undefined;
    try {
      view = await WebView.attach(borrowed, {
        assets: { "index.html": htmlBytes(`<script>
          window.__sweetview_rpc("ping", { from: location.origin })
            .then(reply => window.__sweetview_rpc("capture", reply));
        </script>`) },
        uiMethods: {
          ping: (params: unknown) => ({ pong: params }),
          capture: (params: unknown) => { answered = params; },
        },
      });
      pumpUntil(() => answered !== undefined, 15_000);
      // The page loaded from the asset origin, its call was answered, and the answer reached it.
      expect(answered).toEqual({ pong: { from: "http://webview.localhost" } });
      expect(view.raw.unsafeHandle).not.toBeNull();
      expect(user32.GetWindowLongPtrW(hwnd, GWL_STYLE)).toBe(styleBefore);
      expect(windowRect(hwnd)).toEqual(rectBefore);
    } finally {
      view?.dispose();
      borrowed.dispose();
      if (user32.IsWindow(hwnd)) user32.DestroyWindow(hwnd);
    }
  }, 30_000);

  test("Layer 1 tabbed Window.dispose() disposes child tab webviews and blocks later openTab calls", async () => {
    const win = new Window({ title: "Layer 1 Tabs", tabs: true, bounds: { x: 140, y: 140, width: 720, height: 500 } });
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
    expect(t1.webview.raw.unsafeHandle).not.toBeNull();
    expect(t2.webview.raw.unsafeHandle).not.toBeNull();

    win.dispose();
    win.dispose(); // idempotent

    expect(t1.webview.raw.unsafeHandle).toBeNull();
    expect(t2.webview.raw.unsafeHandle).toBeNull();
    await expect(WebView.openTab(win, { title: "Three", url: "about:blank" })).rejects.toThrow(/disposed window/);
  });

  test("closing a tabbed Window via WM_CLOSE with no onClose disposes all child tab webviews", async () => {
    const { user32, WM_CLOSE } = await import("../../sweetview-native/test/win32-os");
    const { asHwnd } = await import("@n1h/sweetview-native/win32/window");
    const win = new Window({ title: "Close Tabs via WM_CLOSE", tabs: true, bounds: { x: 160, y: 160, width: 720, height: 500 } });
    const hwnd = asHwnd(win.handle);
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });

    user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);

    expect(user32.IsWindow(hwnd)).toBe(0);
    expect(t1.webview.raw.unsafeHandle).toBeNull();
    expect(t2.webview.raw.unsafeHandle).toBeNull();
    await expect(WebView.openTab(win, { title: "Three", url: "about:blank" })).rejects.toThrow(/disposed window/);
  });
});

describe.if(process.platform === "darwin")("WebView, createApp & tabs (darwin)", () => {
  const NSStatusWindowLevel = 25n;
  const objc = () => import("@n1h/sweetview-native/darwin/objc");
  const styleMaskOf = async (win: Window) => {
    const { asId, sel, sendInt } = await objc();
    return BigInt(sendInt(asId(win.handle as bigint), sel("styleMask")) ?? -1);
  };
  // Tab closes finish on a Bun timer (after AppKit's windowWillClose:), so the
  // wait yields to Bun's loop as well as pumping AppKit's.
  const settle = async (done: () => boolean, budgetMs = 3000) => {
    for (const end = performance.now() + budgetMs; performance.now() < end; await Bun.sleep(10)) {
      pumpEvents();
      if (done()) return true;
    }
    return done();
  };

  test("WebView.attach rejects invalid ringBytes without poisoning later attaches", async () => {
    const win = new Window({ title: "Ring Validation", bounds: { x: 100, y: 100, width: 400, height: 300 }, noActivate: true });
    try {
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 32 })).rejects.toThrow(/power of two between 128/);
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 200 })).rejects.toThrow(/power of two between 128/);
      const view = await WebView.attach(win, { url: "about:blank", ringBytes: 256 });
      expect(view.raw.unsafeHandle).not.toBeNull();
      view.dispose();
    } finally {
      win.dispose();
    }
  });

  test("WebView.attach preserves outer bounds and the NSWindow styleMask for framed, frameless, and Window.fromHandle windows", async () => {
    const target = { x: 120, y: 120, width: 640, height: 480 };
    const win = new Window({ title: "Attach Bounds", bounds: target, noActivate: true });
    const framedMask = await styleMaskOf(win);
    const view = await WebView.attach(win, { url: "about:blank" });
    try {
      expect(win.bounds()).toEqual(target);
      expect(await styleMaskOf(win)).toBe(framedMask);
    } finally {
      view.dispose();
      win.dispose();
    }

    // A frameless window stays borderless (styleMask 0) through the attach and after it is shown.
    const bounds = { x: 100, y: 100, width: 500, height: 400 };
    const frameless = new Window({ frame: false, bounds, noActivate: true });
    expect(await styleMaskOf(frameless)).toBe(0n);
    const framelessView = await WebView.attach(frameless, { url: "about:blank" });
    try {
      expect(await styleMaskOf(frameless)).toBe(0n);
      expect(frameless.bounds()).toEqual(bounds);
      frameless.show();
      pumpUntil(() => frameless.isVisible());
      expect(await styleMaskOf(frameless)).toBe(0n);
      expect(frameless.bounds()).toEqual(bounds);
    } finally {
      framelessView.dispose();
      frameless.dispose();
    }

    // A borrowed Window.fromHandle wrapper leaves the host's style and bounds alone.
    const host = new Window({ frame: false, bounds, noActivate: true });
    const borrowed = Window.fromHandle(host.handle);
    const borrowedView = await WebView.attach(borrowed, { url: "about:blank" });
    try {
      expect(await styleMaskOf(host)).toBe(0n);
      expect(host.bounds()).toEqual(bounds);
    } finally {
      borrowedView.dispose();
      borrowed.dispose();
      host.dispose();
    }
  });

  test("a tabbed Window shown before its first tab reveals the tabs, and setTopmost and Screen.of follow the tab windows", async () => {
    const { asId, sel, sendInt, sendRetBool } = await objc();
    const { Screen } = await import("@n1h/sweetview-native");
    const win = new Window({ title: "Tabs", tabs: true, bounds: { x: 140, y: 140, width: 720, height: 500 }, noActivate: true });
    try {
      win.show(); // before any tab exists
      const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
      const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
      const tabWindows = [t1, t2].map((tab) => asId(tab.webview.window.handle as bigint));
      expect(await settle(() => win.isVisible() && tabWindows.every((w) => Boolean(sendRetBool(w, sel("isVisible")))))).toBe(true);

      win.setTopmost(true);
      expect(tabWindows.map((w) => BigInt(sendInt(w, sel("level")) ?? -1))).toEqual([NSStatusWindowLevel, NSStatusWindowLevel]);
      win.setTopmost(false);
      expect(tabWindows.map((w) => BigInt(sendInt(w, sel("level")) ?? -1))).toEqual([0n, 0n]);

      const screen = Screen.of(win);
      expect(screen.bounds.width).toBeGreaterThan(0);
      expect(screen.scale).toBeGreaterThan(0);

      // With no mouse button down these do nothing, and must not throw.
      win.startResize("right");
      pumpEvents();
      expect(win.bounds().width).toBe(720);
    } finally {
      win.dispose();
    }
  });

  test("startResize and startDrag act only while the left mouse button is down", async () => {
    // The button state AppKit reports and NSWindow's own drag entry point are
    // replaced for the test, so no real input is needed. The cursor is moved
    // with CGWarpMouseCursorPosition, which posts no events, and put back.
    const { dlopen, FFIType, JSCallback } = await import("bun:ffi");
    const { asId, cls, sel, send, NIL } = await objc();
    const { Screen } = await import("@n1h/sweetview-native");
    const { u64, f64, i64, i16 } = FFIType;
    const runtime = dlopen("/usr/lib/libobjc.A.dylib", {
      class_getClassMethod: { args: [u64, u64], returns: u64 },
      class_getInstanceMethod: { args: [u64, u64], returns: u64 },
      method_setImplementation: { args: [u64, u64], returns: u64 },
    }).symbols;
    // +[NSEvent otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:]
    const makeEvent = dlopen("/usr/lib/libobjc.A.dylib", {
      objc_msgSend: { args: [u64, u64, u64, f64, f64, u64, f64, i64, u64, i16, i64, i64], returns: u64 },
    }).symbols.objc_msgSend;
    const { CGWarpMouseCursorPosition } = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGWarpMouseCursorPosition: { args: [f64, f64], returns: FFIType.i32 },
    }).symbols;

    let buttons = 0n;
    const pressedStub = new JSCallback(() => buttons, { args: [u64, u64], returns: u64 });
    const drags: bigint[] = [];
    const dragStub = new JSCallback((_self: bigint, _cmd: bigint, event: bigint) => void drags.push(BigInt(event)), { args: [u64, u64, u64], returns: FFIType.void });
    const pressedMethod = runtime.class_getClassMethod(cls("NSEvent"), sel("pressedMouseButtons"));
    const dragMethod = runtime.class_getInstanceMethod(cls("NSWindow"), sel("performWindowDragWithEvent:"));
    expect(pressedMethod).not.toBe(0n);
    expect(dragMethod).not.toBe(0n);
    const realPressed = runtime.method_setImplementation(pressedMethod, BigInt(pressedStub.ptr!));
    const realDrag = runtime.method_setImplementation(dragMethod, BigInt(dragStub.ptr!));

    const home = Screen.cursor();
    const moveCursor = (dx: number) => CGWarpMouseCursorPosition(home.x + dx, home.y);
    const bounds = { x: 300, y: 300, width: 400, height: 300 };
    const win = new Window({ frame: false, resizable: true, bounds, noActivate: true });
    const widthAfter = async (ms = 120) => {
      for (const end = performance.now() + ms; performance.now() < end; await Bun.sleep(10)) pumpEvents();
      return win.bounds().width;
    };
    try {
      win.show();
      await settle(() => win.isVisible());

      // Right button only: no resize gesture starts.
      buttons = 2n;
      win.startResize("right");
      moveCursor(40);
      expect(await widthAfter()).toBe(400);

      // Left button: the right edge follows the cursor.
      moveCursor(0);
      buttons = 1n;
      win.startResize("right");
      moveCursor(40);
      expect(await settle(() => win.bounds().width === 440)).toBe(true);
      moveCursor(60);
      expect(await settle(() => win.bounds().width === 460)).toBe(true);
      expect(win.bounds().x).toBe(300);

      // Released: the gesture ends, and the cursor no longer moves the edge.
      buttons = 0n;
      await widthAfter(60);
      moveCursor(120);
      expect(await widthAfter()).toBe(460);

      // startDrag hands AppKit the current event only while the left button is down.
      const event = asId(makeEvent(cls("NSEvent"), sel("otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:"), 15n, 0, 0, 0n, 0, 0n, NIL, 0, 0n, 0n));
      expect(event).not.toBe(NIL);
      const postEvent = dlopen("/usr/lib/libobjc.A.dylib", { objc_msgSend: { args: [u64, u64, u64, FFIType.bool], returns: FFIType.void } }).symbols.objc_msgSend;
      postEvent(asId(send(cls("NSApplication"), sel("sharedApplication"))), sel("postEvent:atStart:"), event, true);
      pumpEvents();
      for (const down of [0n, 2n]) {
        buttons = down;
        win.startDrag();
      }
      expect(drags).toEqual([]);
      buttons = 1n;
      win.startDrag();
      expect(drags).toHaveLength(1);
      expect(drags[0]).not.toBe(NIL);
    } finally {
      runtime.method_setImplementation(pressedMethod, realPressed);
      runtime.method_setImplementation(dragMethod, realDrag);
      CGWarpMouseCursorPosition(home.x, home.y);
      win.dispose();
    }
  });

  test("tab.close() closes a window's last tab, fires onTabClose, then asks the window's onClose listeners", async () => {
    const win = new Window({ title: "Last Tab", tabs: true, bounds: { x: 150, y: 150, width: 720, height: 500 }, noActivate: true });
    const events: string[] = [];
    win.onTabClose((tab) => events.push(`tab:${tab.title}`));
    win.onClose(() => events.push("window"));
    try {
      const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
      const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
      win.show();
      await settle(() => win.isVisible());
      t2.close();
      expect(await settle(() => events.length === 1)).toBe(true);
      expect(events).toEqual(["tab:Two"]);
      expect(t2.webview.raw.unsafeHandle).toBeNull();
      t1.close();
      expect(await settle(() => events.length === 3)).toBe(true);
      expect(events).toEqual(["tab:Two", "tab:One", "window"]);
      expect(t1.webview.raw.unsafeHandle).toBeNull();
    } finally {
      win.dispose();
    }
  });

  test("a tab survives its webview being disposed directly, and the library's UIDelegate is restored first", async () => {
    const { asId, jsString, sel, send } = await objc();
    const { hostedWebView } = await import("./tabs/darwin-webview");
    const className = (object: bigint) => jsString(asId(send(object, sel("className"))));
    const win = new Window({ title: "Direct Dispose", tabs: true, bounds: { x: 160, y: 160, width: 720, height: 500 }, noActivate: true });
    const closed: string[] = [];
    win.onTabClose((tab) => closed.push(tab.title));
    try {
      const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
      const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
      win.show();
      await settle(() => win.isVisible());
      const wkWebView = hostedWebView(asId(t1.webview.window.handle as bigint))!;
      // A tab's WKWebView is the library's subclass, behind the tab driver's UIDelegate.
      expect(className(wkWebView)).toBe("SweetviewWKWebView");
      expect(className(asId(send(wkWebView, sel("UIDelegate"))))).toBe("SweetviewTabUIDelegate");

      t1.webview.dispose();
      t1.webview.dispose(); // idempotent
      expect(t1.webview.raw.unsafeHandle).toBeNull();
      expect(t2.webview.raw.unsafeHandle).not.toBeNull();
      t1.close();
      expect(await settle(() => closed.length === 1)).toBe(true);
      expect(closed).toEqual(["One"]);
    } finally {
      win.dispose();
    }
  });

  test("tabbed Window.dispose() disposes its tabs' webviews, leaves a torn-off tab alone, and blocks later openTab calls", async () => {
    const win = new Window({ title: "Layer 1 Tabs", tabs: true, bounds: { x: 170, y: 170, width: 720, height: 500 }, noActivate: true });
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
    const t3 = await WebView.openTab(win, { title: "Three", url: "about:blank" });
    win.show();
    await settle(() => win.isVisible());
    const detached = await t3.moveToNewWindow();
    try {
      expect(detached).not.toBe(win);
      expect(t3.window).toBe(detached);
      expect(await settle(() => detached.isVisible())).toBe(true);

      win.dispose();
      win.dispose(); // idempotent
      expect(t1.webview.raw.unsafeHandle).toBeNull();
      expect(t2.webview.raw.unsafeHandle).toBeNull();
      expect(t3.webview.raw.unsafeHandle).not.toBeNull();
      await expect(WebView.openTab(win, { title: "Four", url: "about:blank" })).rejects.toThrow(/disposed window/);
    } finally {
      detached.dispose();
    }
    expect(t3.webview.raw.unsafeHandle).toBeNull();
  });
});
