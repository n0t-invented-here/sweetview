// UI thread. Owns the native window and the OS event loop.
//
// webview.run() blocks this thread, and with it Bun's event loop, so nothing
// async can live here. The worker ("@n1h/sweetview/worker") owns the Bun event
// loop and the app's Service. Transport:
//   page   -> here    : bound `__sweetview_rpc(method, params)`; answered later via webview_return
//   here   -> worker  : worker.postMessage (synchronous enqueue, works while blocked)
//   worker -> here    : sweetipc frames in a shared ring + webview_dispatch as the wakeup,
//                       which runs `drain` on this thread, inside the OS loop
//   here   -> page    : webview_eval of `__sweetview_emit(name, payload)`
//
// The page itself is never passed to set_html (Windows caps that at 2 MB): its
// index, bundle, styles and files are registered as assets the library serves
// at the page's own origin, and the webview navigates there.
//
// Everything in sweetnative (tray, notifications, window, dialogs, app menu)
// runs on this thread too; create those between createWebviewApp() and run().

import { ASSET_ORIGIN, backgroundColorCall, setAssetCall, webviewLibPath } from "./webview-lib";
import { FFIType, JSCallback, dlopen, type Pointer } from "bun:ffi";
import type { AnyEvent, EventMap, Frame, MethodMap } from "./ipc";
import { nativeWindow, type NativeWindow, type WindowHandle } from "./native";
import { SizeHint, Webview } from "@n1h/sweetview-webview-bun";
import { assetMime, indexHtml } from "./html";
import type { HTMLBundle } from "bun";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { InitMessage } from "./messages";
import { Ring } from "./ring";

/** Methods answered synchronously on the UI thread instead of by the worker (native dialogs, window state). */
export type UiMethods<M extends MethodMap> = { [K in keyof M & string]?: (params: M[K][0]) => M[K][1] };

/**
 * The bytes served at one asset path. A string is a file path, as a
 * `with { type: "file" }` import gives, read with `Bun.file`; a Blob (a
 * `BunFile`, or what `indexHtml` returns) and a `Uint8Array` are served as
 * they are.
 */
export type Asset = string | Uint8Array | Blob;

export type WebviewAppOptions<M extends MethodMap> = {
  /**
   * The page: an HTML import (`import index from "./index.html"`). Bun
   * bundles the scripts and stylesheets it references; under `bun run` the
   * bundling happens here at start-up, inside a `bun build --compile`
   * executable the bundled files are embedded. Every output is served at
   * the page's origin and the webview opens the page.
   */
  page?: HTMLBundle;
  /** The window title. Default: the page's `<title>`, else the entry script's name. */
  title?: string;
  /**
   * More files for the page's origin, by asset path: models, images, data
   * the page fetches by relative URL. Without `page`, the whole page goes
   * here, by convention `main.js` and `main.css`, and an `index.html` that
   * loads them is generated from `title` unless supplied.
   */
  assets?: Record<string, Asset>;
  /** Asset path the webview opens. Default: the page's HTML, or "index.html". */
  index?: string;
  /**
   * The worker entry, which must call hostService(). A relative path
   * ("./worker.ts") is resolved against the entry script (`Bun.main`), which
   * in a compiled executable is where the second entrypoint lives too, so
   * the same string works uncompiled and compiled. Pass the file to `bun
   * build --compile` as a second entrypoint. Leave it out for a window whose
   * page only needs `uiMethods` (a settings window, say); a call to any other
   * method is then answered with an error.
   */
  worker?: URL | string;
  /** Client size. With `window`, this is locked in as fixed (the library would otherwise apply 640x480 later). */
  width?: number;
  height?: number;
  /** Devtools and context menu. */
  debug?: boolean;
  /**
   * The browser paints a transparent background, so a page with
   * `background: transparent` shows whatever is behind the window. Pair with
   * `createOverlayWindow({ transparent: true })` from @n1h/sweetview/native.
   * Needs the library @n1h/sweetview-webview-bun ships (Windows and macOS);
   * with a library that lacks webview_set_background_color, a warning and an
   * opaque page.
   */
  transparent?: boolean;
  /**
   * Host the browser in a window you created (createOverlayWindow in @n1h/sweetview/native)
   * instead of letting the library make one. You then own showing it and
   * ending the run loop when it is destroyed. On Windows the library still
   * applies `width`/`height` to it, as DIPs: for an overlay pass the size you
   * gave the window divided by its scale; for a framed window they are the
   * client area, and the library sizes the frame around it. On macOS they
   * are ignored.
   */
  window?: WindowHandle;
  /**
   * With `window`: leave the window resizable (a framed window; the library
   * keeps its thick frame and maximise box). Default false: the size is
   * locked, which an overlay wants.
   */
  resizable?: boolean;
  uiMethods?: UiMethods<M>;
  /** Ring capacity in bytes for worker -> UI frames. The worker blocks when it is full. */
  ringBytes?: number;
};

export type WebviewApp<M extends MethodMap, E extends EventMap> = {
  readonly webview: Webview;
  /** Show/hide/toggle and close-to-tray, from sweetnative. */
  readonly window: NativeWindow;
  /** The native window (HWND / NSWindow*), for sweetnative's dialogs. */
  readonly windowHandle: WindowHandle;
  /** Push an event to the page. */
  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  /** Call the worker's service without waiting; whatever it emits comes back as events. */
  call<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  /** See every event the worker sends to the page, before the page does. For mirroring state into a tray menu. */
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  /**
   * Run the OS loop. Returns when the window is closed or quit() is called;
   * the worker is terminated. One process has one OS loop: with several
   * windows (several createWebviewApp calls on this thread), call run() on
   * one of them and the others live in the same loop.
   */
  run(): void;
  quit(): void;
};

/** The bundled files of an HTML import, by asset path, plus the path of its HTML. */
async function pageAssets(page: HTMLBundle): Promise<{ assets: Record<string, Asset>; index: string }> {
  const assets: Record<string, Asset> = {};
  let index: string | undefined;
  if (page.files) {
    // built ahead of time (bun build --compile): the outputs are embedded beside the entry
    for (const f of page.files) {
      const path = basename(f.path);
      assets[path] = Bun.file(f.path);
      if (extname(path) === ".html") index = path;
    }
  } else {
    // bun run: bundle now, in memory
    const built = await Bun.build({ entrypoints: [page.index], target: "browser", minify: true });
    for (const o of built.outputs) {
      const path = basename(o.path);
      assets[path] = o;
      if (extname(path) === ".html") index = path;
    }
  }
  if (index === undefined) throw new Error("sweetview: the page bundle has no HTML output");
  return { assets, index };
}

/** The <title> of an HTML document, or undefined. */
const htmlTitle = (html: string): string | undefined => {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || undefined : undefined;
};

const assetBytes = async (source: Asset): Promise<Uint8Array> =>
  typeof source === "string" ? new Uint8Array(await Bun.file(source).arrayBuffer()) : source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());

// JSON is JS source except U+2028/2029 inside strings.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const asJsLiteral = (json: string) => json.replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");

export async function createWebviewApp<M extends MethodMap, E extends EventMap>(options: WebviewAppOptions<M>): Promise<WebviewApp<M, E>> {
  // Everything async happens here; after run() this thread is the OS loop.
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error(`sweetview: ${process.platform} is not supported (win32 and darwin are): the native module has no backend for it and the webview library does not serve assets there`);
  }
  const libPath = await webviewLibPath();

  // the page: an HTML import bundled by Bun, or the assets as given
  const assets: Record<string, Asset> = { ...options.assets };
  let index = options.index ?? "index.html";
  let title = options.title;
  if (options.page) {
    const page = await pageAssets(options.page);
    Object.assign(assets, page.assets);
    index = options.index ?? page.index;
    const html = assets[index];
    if (title === undefined && html !== undefined) {
      title = htmlTitle(typeof html === "string" ? await Bun.file(html).text() : html instanceof Uint8Array ? new TextDecoder().decode(html) : await html.text());
    }
  }
  const windowTitle: string = title ?? basename(Bun.main, extname(Bun.main));
  // the convention without a page import: main.js, and main.css when shipped; an index of the app's own wins
  if (!(index in assets)) assets[index] = indexHtml({ title: windowTitle, css: "main.css" in assets ? "main.css" : "" });

  // With a window of our own, the hint is FIXED unless `resizable`: on Windows the
  // library's set_size would otherwise give an overlay popup a resizable frame (WS_THICKFRAME).
  const host = options.window ?? null;
  const webview =
    host !== null
      ? new Webview(options.debug ?? false, { width: options.width ?? 320, height: options.height ?? 240, hint: options.resizable ? SizeHint.NONE : SizeHint.FIXED }, Number(host) as Pointer)
      : new Webview(options.debug ?? false, { width: options.width ?? 1100, height: options.height ?? 800, hint: SizeHint.NONE });
  if (webview.unsafeHandle === null || Number(webview.unsafeHandle) === 0) {
    throw new Error(
      host !== null
        ? "sweetview: webview_create failed for the given window (is COM initialised as an STA on this thread? createOverlayWindow in @n1h/sweetview/native does that)"
        : process.platform === "win32"
          ? "sweetview: webview_create failed (is the WebView2 runtime installed?)"
          : "sweetview: webview_create failed",
    );
  }
  try {
    return await finishSetup();
  } catch (err) {
    if (webview.unsafeHandle !== null) webview.destroy();
    throw err;
  }

  async function finishSetup(): Promise<WebviewApp<M, E>> {
  webview.title = windowTitle;
  // webview_get_window reports NULL for a window the library did not create.
  const windowHandle: WindowHandle = host ?? webview.unsafeWindowHandle;
  const window = nativeWindow(windowHandle);

  // webview-bun exposes terminate only inside destroy(), which run() calls again on exit;
  // take the one symbol we need from the same library file.
  const lib = dlopen(libPath, {
    webview_terminate: { args: [FFIType.ptr], returns: FFIType.i32 },
    webview_run: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const handle = () => Number(webview.unsafeHandle) as Pointer;
  const quit = () => void lib.symbols.webview_terminate(handle());

  if (options.transparent) {
    const set = backgroundColorCall(libPath);
    if (set) {
      const err = set(handle(), 0, 0, 0, 0);
      if (err !== 0) throw new Error(`sweetview: webview_set_background_color failed (${err})`);
    } else {
      console.warn("sweetview: this webview library has no webview_set_background_color; the page will not be transparent (see @n1h/sweetview-webview-bun)");
    }
  }

  const sab = Ring.create(options.ringBytes ?? 1 << 20);
  const ring = new Ring(sab);
  const taps = new Set<(event: { name: string; payload: unknown }) => void>();

  const emit = (name: string, payload: unknown) =>
    webview.eval(`__sweetview_emit(${JSON.stringify(name)}, ${asJsLiteral(JSON.stringify(payload ?? null))})`);

  const drain = new JSCallback(
    () => {
      ring.acknowledgeWakeup();
      const decoder = new TextDecoder();
      for (const bytes of ring.drain()) {
        const frame = JSON.parse(decoder.decode(bytes)) as Frame;
        if (frame.kind === "reply") {
          if (frame.ok) webview.return(frame.seq, 0, JSON.stringify(frame.result ?? null));
          else webview.return(frame.seq, 1, JSON.stringify({ message: frame.error }));
        } else if (frame.kind === "event") {
          for (const fn of taps) fn({ name: frame.name, payload: frame.payload });
          emit(frame.name, frame.payload);
        }
      }
    },
    { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  );

  const workerUrl =
    options.worker === undefined
      ? undefined
      : typeof options.worker === "string"
        ? /^[a-z][a-z0-9+.-]+:/i.test(options.worker)
          ? new URL(options.worker)
          : new URL(options.worker, pathToFileURL(Bun.main))
        : options.worker;
  let worker: Worker | undefined;
  try {
    worker = workerUrl === undefined ? undefined : new Worker(workerUrl.href);
  } catch (err) {
    drain.close();
    throw err;
  }
  const init: InitMessage = { kind: "init", ring: sab, webviewHandle: Number(webview.unsafeHandle), drainCallbackPtr: Number(drain.ptr), libPath };
  worker?.postMessage(init);

  // Worker first, then the handle: the worker calls webview_dispatch on the handle until it is terminated.
  const shutdown = () => {
    worker?.terminate();
    drain.close();
    if (webview.unsafeHandle !== null) webview.destroy();
  };
  if (worker) worker.onerror = (e) => console.error("sweetview: the worker failed:", e.message ?? e);

  try {

  const uiMethods = (options.uiMethods ?? {}) as Record<string, ((params: unknown) => unknown) | undefined>;

  // page -> backend. `req` is the JSON array of call arguments: [method, params].
  webview.bindRaw("__sweetview_rpc", (seq, req) => {
    const [method, params] = JSON.parse(req) as [string, unknown];
    const local = Object.hasOwn(uiMethods, method) ? uiMethods[method] : undefined;
    if (!local) {
      if (worker) worker.postMessage({ kind: "call", seq, method, params });
      else webview.return(seq, 1, JSON.stringify({ message: `${method}: this window has no worker and no UI-thread method of that name` }));
      return;
    }
    try {
      const result = local(params);
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        throw new Error(`${method}: a UI-thread method must return synchronously; this one returned a Promise`);
      }
      webview.return(seq, 0, JSON.stringify(result ?? null));
    } catch (err) {
      webview.return(seq, 1, JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
    }
  });

  const setAsset = setAssetCall(libPath);
  if (!setAsset) {
    throw new Error("sweetview: this webview library has no webview_set_asset; it needs the library @n1h/sweetview-webview-bun ships (is WEBVIEW_PATH pointing at a stock one?)");
  }
  for (const [path, source] of Object.entries(assets)) {
    const err = setAsset(handle(), path, assetMime(path), await assetBytes(source));
    if (err !== 0) throw new Error(`sweetview: webview_set_asset(${path}) failed (${err})`);
  }
  webview.navigate(`${ASSET_ORIGIN}/${index}`);
  } catch (err) {
    worker?.terminate();
    drain.close();
    throw err;
  }

  return {
    webview,
    window,
    windowHandle,
    emit,
    call: (method, ...params) => {
      if (worker) worker.postMessage({ kind: "call", seq: null, method, params: params[0] ?? null });
      else console.error(`sweetview: ${method}: this window has no worker`);
    },
    onEvent(fn) {
      const tap = fn as (event: { name: string; payload: unknown }) => void;
      taps.add(tap);
      return () => taps.delete(tap);
    },
    run() {
      lib.symbols.webview_run(handle()); // blocks until the window closes or quit()
      shutdown();
    },
    quit,
  };
  }
}
