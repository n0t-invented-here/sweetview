// UI thread. Owns the WebView (attached to a Layer 1 Window) and the Layer 2
// createApp helper. Everything async runs during attach/createApp; once run()
// starts, this thread runs the OS event loop (or runEventLoop() for tabbed /
// multi-window apps).

import { FFIType, JSCallback, type Pointer } from "bun:ffi";
import type { HTMLBundle } from "bun";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { SizeHint, Webview as RawWebview } from "@n1h/sweetview-webview-bun";
import { assetMime, indexHtml } from "./html";
import { createFrameAssembler, type AnyEvent, type EventMap, type MethodMap, type WireFrame } from "@n1h/sweetview-ipc";
import type { InitMessage } from "./messages";
import { Window, quitEventLoop, runEventLoop, signalReady, type Rect, type TabHandle, type WindowOptions } from "@n1h/sweetview-native";
import { discardQuit, getWindowMeta, isWindowDisposed, onWindowDispose, preserveWindowGeometry, scheduleNativeTimeout } from "@n1h/sweetview-native/internal";
import { Ring } from "./ring";
import { ASSET_ORIGIN, backgroundColorCall, openWebviewCore, setAssetCall, webviewLibPath } from "./webview-lib";

/** Methods that return synchronously on the UI thread. */
export type UiMethods<M extends MethodMap> = { [K in keyof M & string]?: (params: M[K][0]) => M[K][1] };

/**
 * The bytes served at one asset path. A string is a file path, as a
 * `with { type: "file" }` import gives, read with `Bun.file`; a Blob (a
 * `BunFile`, or what `indexHtml` returns) and a `Uint8Array` are served as
 * they are.
 */
export type Asset = string | Uint8Array | Blob;

export type WebViewOptions<M extends MethodMap = MethodMap> = {
  /** HTML import (`import index from "./index.html"`). */
  page?: HTMLBundle;
  /** External or custom URL to load directly instead of bundled assets. */
  url?: string;
  /** Default: the window's title, then the page's `<title>`, else the entry script's name. */
  title?: string;
  /** Extra files served at the page's origin, by asset path. */
  assets?: Record<string, Asset>;
  /** Asset path the webview opens. Default: the page's HTML, or "index.html". */
  index?: string;
  /** Worker entry calling `hostService()`. Relative paths resolve against `Bun.main`. */
  worker?: URL | string;
  /** Devtools and context menu. */
  debug?: boolean;
  /** Synchronous UI-thread method handlers. */
  uiMethods?: UiMethods<M>;
  /** Synchronous handlers run on the next native UI tick, for operations such as modal dialogs. */
  deferredUiMethods?: UiMethods<M>;
  /** Show the window on the ready handshake or on startup timeout. Defaults to false. */
  showOnReady?: boolean;
  /** Opt-in native startup watchdog. A positive value enables it. */
  readyTimeoutMs?: number;
  onReady?: () => void;
  onReadyTimeout?: () => void;
  /** Replaces the page on startup timeout. Defaults to a built-in error page. */
  readyFallbackHtml?: string;
  /** Ring capacity in bytes for worker -> UI frames. Default 1 MiB. */
  ringBytes?: number;
};

export type TabOptions<M extends MethodMap = MethodMap> = WebViewOptions<M> & {
  /** Insert after this tab instead of the currently selected tab. */
  after?: TabHandle;
};

export interface Tab<M extends MethodMap = MethodMap, E extends EventMap = EventMap> extends TabHandle {
  readonly webview: WebView<M, E>;
  readonly window: Window;
  readonly title: string;
  setTitle(title: string): void;
  select(): void;
  close(): void;
  moveToNewWindow(): Promise<Window>;
  dispose(): void;
}

export type AppOptions<M extends MethodMap = MethodMap> = WindowOptions & WebViewOptions<M>;

export interface App<M extends MethodMap = MethodMap, E extends EventMap = EventMap> {
  readonly window: Window;
  readonly webview?: WebView<M, E>;
  openTab<TM extends MethodMap = M, TE extends EventMap = E>(options: TabOptions<TM>): Promise<Tab<TM, TE>>;
  mergeAllWindows(): void;
  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  run(): void | Promise<void>;
  quit(): void;
  dispose(): void;
}

/** Internal hook registered by `src/tabs/` to back `WebView.openTab` and `mergeAllWindows`. */
export type TabsDriver = {
  openTab<M extends MethodMap, E extends EventMap>(window: Window, options: TabOptions<M>): Promise<Tab<M, E>>;
  mergeAllWindows(into?: Window): void;
  disposeWindow(window: Window): void;
};

let tabsDriver: TabsDriver | undefined;
export function registerTabsDriver(driver: TabsDriver): void {
  tabsDriver = driver;
}

/** The bundled files of an HTML import, by asset path, plus the path of its HTML. */
async function pageAssets(page: HTMLBundle): Promise<{ assets: Record<string, Asset>; index: string }> {
  const assets: Record<string, Asset> = {};
  let index: string | undefined;
  if (page.files) {
    for (const f of page.files) {
      const path = basename(f.path);
      assets[path] = Bun.file(f.path);
      if (extname(path) === ".html") index = path;
    }
  } else {
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

const htmlTitle = (html: string): string | undefined => {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m
    ? m[1]!
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim() || undefined
    : undefined;
};

const assetBytes = async (source: Asset): Promise<Uint8Array> =>
  typeof source === "string"
    ? new Uint8Array(await Bun.file(source).arrayBuffer())
    : source instanceof Uint8Array
      ? source
      : new Uint8Array(await source.arrayBuffer());

// JSON is JS source except U+2028/2029 inside strings.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const asJsLiteral = (json: string) => json.replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");

const startupErrorHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Startup timed out</title>
<style>body{color-scheme:light dark;font:1rem system-ui;margin:3rem;max-width:36rem}</style>
<h1>The app took too long to start</h1><p>Close this window and reopen the app to try again.</p></html>`;

type UiHandler = (params: unknown) => unknown;
type UiJob = { seq: string; method: string; fn: UiHandler; params: unknown };

let nextDispatchId = 0n;
const pendingUiDispatches = new Map<bigint, () => void>();
// Cocoa may invoke an already-posted dispatch after the webview is gone. The
// native trampoline stays valid while shutdown drops the per-view queue and
// its dispatch token.
let deferDrain: JSCallback | undefined;
function deferredDrainPointer(): Pointer {
  deferDrain ??= new JSCallback(
    (_webview, id: bigint) => {
      const run = pendingUiDispatches.get(id);
      pendingUiDispatches.delete(id);
      try {
        run?.();
      } catch (err) {
        console.error("sweetview: deferred UI dispatch failed:", err);
      }
    },
    { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  );
  if (!deferDrain.ptr) throw new Error("sweetview: could not allocate the deferred UI dispatcher");
  return deferDrain.ptr;
}

export class WebView<M extends MethodMap = MethodMap, E extends EventMap = EventMap> {
  readonly raw: RawWebview;
  readonly window: Window;
  readonly #emit: (name: string, payload: unknown) => void;
  readonly #notify: (method: string, params: unknown) => void;
  readonly #onEvent: (fn: (event: AnyEvent<E>) => void) => () => void;
  readonly #run: () => void;
  readonly #quit: () => void;
  readonly #dispose: () => void;

  private constructor(parts: {
    raw: RawWebview;
    window: Window;
    emit: (name: string, payload: unknown) => void;
    notify: (method: string, params: unknown) => void;
    onEvent: (fn: (event: AnyEvent<E>) => void) => () => void;
    run: () => void;
    quit: () => void;
    dispose: () => void;
  }) {
    this.raw = parts.raw;
    this.window = parts.window;
    this.#emit = parts.emit;
    this.#notify = parts.notify;
    this.#onEvent = parts.onEvent;
    this.#run = parts.run;
    this.#quit = parts.quit;
    this.#dispose = parts.dispose;
  }

  /** Mounts a webview inside an existing Layer 1 Window. */
  static async attach<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
    window: Window,
    options: WebViewOptions<M>,
  ): Promise<WebView<M, E>> {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      throw new Error(
        `sweetview: ${process.platform} is not supported (win32 and darwin are): the native module has no backend for it and the webview library does not serve assets there`,
      );
    }
    const uiMethods = (options.uiMethods ?? {}) as Record<string, UiHandler | undefined>;
    const deferredUiMethods = (options.deferredUiMethods ?? {}) as Record<string, UiHandler | undefined>;
    for (const name of Object.keys(deferredUiMethods)) {
      if (Object.hasOwn(uiMethods, name)) {
        throw new Error(`sweetview: ${name} is defined in both uiMethods and deferredUiMethods`);
      }
    }
    const libPath = await webviewLibPath();
    const meta = getWindowMeta(window);
    const scale = window.scale() || 1;
    const winBounds: Rect = window.bounds();

    const useDirectUrl = options.url !== undefined && options.page === undefined && options.assets === undefined;
    const assets: Record<string, Asset> = { ...options.assets };
    let index = options.index ?? "index.html";
    let title = options.title ?? (meta.title || undefined);

    if (!useDirectUrl) {
      if (options.page) {
        const page = await pageAssets(options.page);
        Object.assign(assets, page.assets);
        index = options.index ?? page.index;
        const html = assets[index];
        if (title === undefined && html !== undefined) {
          title = htmlTitle(
            typeof html === "string" ? await Bun.file(html).text() : html instanceof Uint8Array ? new TextDecoder().decode(html) : await html.text(),
          );
        }
      }
      const windowTitle: string = title ?? basename(Bun.main, extname(Bun.main));
      if (!(index in assets)) assets[index] = indexHtml({ title: windowTitle, css: "main.css" in assets ? "main.css" : "" });
      title = windowTitle;
    } else {
      title ??= basename(Bun.main, extname(Bun.main));
    }

    const host = window.handle;
    if (isWindowDisposed(window)) throw new Error("sweetview: cannot attach WebView to a disposed window");
    if (host === null || host === 0 || host === 0n) {
      throw new Error("sweetview: cannot attach WebView to a window with a NULL handle");
    }

    const ringBytes = options.ringBytes ?? 1 << 20;
    if (!Number.isInteger(ringBytes) || ringBytes < 128 || ringBytes > 1 << 30 || (ringBytes & (ringBytes - 1)) !== 0) {
      throw new RangeError(`sweetview: ringBytes must be a power of two between 128 and 2^30, got ${ringBytes}`);
    }

    // Read DIPs directly from the Window so callers never duplicate width/height/scale/resizable.
    const widthDips = Math.max(1, Math.round(winBounds.width / scale));
    const heightDips = Math.max(1, Math.round(winBounds.height / scale));
    // Frameless windows resize via Window.startResize(), not WS_THICKFRAME.
    const hint = meta.frame && meta.resizable ? SizeHint.NONE : SizeHint.FIXED;
    const restoreGeometry = preserveWindowGeometry(window);
    const raw = new RawWebview(options.debug ?? false, { width: widthDips, height: heightDips, hint }, Number(host) as Pointer);
    if (raw.unsafeHandle === null || Number(raw.unsafeHandle) === 0) {
      throw new Error(
        process.platform === "win32"
          ? "sweetview: webview_create failed for the given window (is the WebView2 runtime installed?)"
          : "sweetview: webview_create failed for the given window",
      );
    }

    // Restore exact styles and outer bounds if webview_set_size mutated them (Windows).
    restoreGeometry();

    try {
      raw.title = title;
      if (meta.owned && !meta.title && title) window.setTitle(title);

      const core = openWebviewCore(libPath);
      const handle = () => Number(raw.unsafeHandle) as Pointer;
      const quit = () => {
        if (raw.unsafeHandle !== null) core.webview_terminate(handle());
      };

      if (meta.transparent) {
        const set = backgroundColorCall(libPath);
        if (set) {
          const err = set(handle(), 0, 0, 0, 0);
          if (err !== 0) throw new Error(`sweetview: webview_set_background_color failed (${err})`);
        } else {
          console.warn("sweetview: this webview library has no webview_set_background_color; the page will not be transparent (see @n1h/sweetview-webview-bun)");
        }
      }

      const sab = Ring.create(ringBytes);
      const ring = new Ring(sab);
      const taps = new Set<(event: { name: string; payload: unknown }) => void>();

      const emit = (name: string, payload: unknown) => {
        if (raw.unsafeHandle === null) return;
        raw.eval(`__sweetview_emit(${JSON.stringify(name)}, ${asJsLiteral(JSON.stringify(payload ?? null))})`);
      };

      const assembler = createFrameAssembler();
      const drain = new JSCallback(
        () => {
          ring.acknowledgeWakeup();
          const decoder = new TextDecoder();
          for (const bytes of ring.drain()) {
            const wire = JSON.parse(decoder.decode(bytes)) as WireFrame;
            const frame = assembler.push(wire);
            if (!frame) continue;
            if (frame.kind === "reply") {
              if (frame.ok) raw.return(frame.seq, 0, JSON.stringify(frame.result ?? null));
              else raw.return(frame.seq, 1, JSON.stringify({ message: frame.error }));
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

      const init: InitMessage = { kind: "init", ring: sab, webviewHandle: Number(raw.unsafeHandle), drainCallbackPtr: Number(drain.ptr), libPath };
      let down = false;
      let isReady = false;
      let cancelWatchdog: (() => void) | undefined;
      let deferScheduled = false;
      let dispatchId: bigint | undefined;
      const queue: UiJob[] = [];
      const cancelStartup = () => {
        cancelWatchdog?.();
        cancelWatchdog = undefined;
      };
      const clearDispatches = () => {
        queue.length = 0;
        if (dispatchId !== undefined) pendingUiDispatches.delete(dispatchId);
        dispatchId = undefined;
      };
      const unsubscribeWindowDispose = onWindowDispose(window, () => {
        cancelStartup();
        clearDispatches();
      });
      const shutdown = () => {
        if (down) return;
        down = true;
        unsubscribeWindowDispose();
        cancelStartup();
        clearDispatches();
        assembler.clear();
        worker?.terminate();
        drain.close();
        if (raw.unsafeHandle !== null) raw.destroy();
      };

      const isLive = () => !down && !isWindowDisposed(window) && raw.unsafeHandle !== null;
      const respond = (seq: string, status: number, value: unknown) => {
        if (isLive()) raw.return(seq, status, JSON.stringify(value ?? null));
      };
      const replyError = (seq: string, error: unknown) => {
        respond(seq, 1, { message: error instanceof Error ? error.message : String(error) });
      };
      const invoke = ({ seq, method, fn, params }: UiJob) => {
        try {
          const result = fn(params);
          if ((typeof result === "object" && result !== null || typeof result === "function")
            && typeof (result as { then?: unknown }).then === "function") {
            // A rejected async handler must not become an unhandled rejection.
            void Promise.resolve(result).catch(() => {});
            throw new Error(`${method}: a UI-thread method must return synchronously; this one returned a Promise`);
          }
          respond(seq, 0, result);
        } catch (err) {
          replyError(seq, err);
        }
      };
      const scheduleDeferred = () => {
        if (!isLive() || deferScheduled || queue.length === 0) return;
        deferScheduled = true;
        const id = ++nextDispatchId;
        dispatchId = id;
        pendingUiDispatches.set(id, () => {
          dispatchId = undefined;
          try {
            // Keep the scheduled flag set during handlers. A modal loop may
            // pump more RPC messages while the current dialog is open.
            for (const job of queue.splice(0)) {
              if (!isLive()) break;
              invoke(job);
            }
          } finally {
            deferScheduled = false;
            scheduleDeferred();
          }
        });
        try {
          const error = core.webview_dispatch(handle(), deferredDrainPointer(), id);
          if (error !== 0) throw new Error(`sweetview: webview_dispatch failed (${error})`);
        } catch (err) {
          pendingUiDispatches.delete(id);
          dispatchId = undefined;
          deferScheduled = false;
          for (const { seq } of queue.splice(0)) replyError(seq, err);
        }
      };
      const showWhenReady = () => {
        if (isLive() && options.showOnReady && !window.isVisible()) window.show();
      };
      const callReadyHook = (name: string, hook: (() => void) | undefined) => {
        try {
          hook?.();
        } catch (err) {
          console.error(`sweetview: ${name} handler threw:`, err);
        }
      };

      try {
        worker?.postMessage(init);
        if (worker) worker.onerror = (e) => console.error("sweetview: the worker failed:", e.message ?? e);
        raw.bindRaw("__sweetview_rpc", (seq, req) => {
          if (!isLive()) return;
          try {
            const [method, params] = JSON.parse(req) as [string, unknown];
            if (method === "__sweetview.ready") {
              if (!isReady) {
                isReady = true;
                cancelStartup();
                signalReady();
                callReadyHook("onReady", options.onReady);
                showWhenReady();
              }
              respond(seq, 0, null);
              return;
            }
            const local = Object.hasOwn(uiMethods, method) ? uiMethods[method] : undefined;
            const deferred = Object.hasOwn(deferredUiMethods, method) ? deferredUiMethods[method] : undefined;
            if (local) invoke({ seq, method, fn: local, params });
            else if (deferred) {
              queue.push({ seq, method, fn: deferred, params });
              scheduleDeferred();
            } else if (worker) worker.postMessage({ kind: "call", seq, method, params });
            else replyError(seq, `${method}: this window has no worker and no UI-thread method of that name`);
          } catch (err) {
            replyError(seq, err);
          }
        });

        if (useDirectUrl) {
          raw.navigate(options.url!);
        } else {
          const setAsset = setAssetCall(libPath);
          if (!setAsset) {
            throw new Error("sweetview: this webview library has no webview_set_asset; it needs the library @n1h/sweetview-webview-bun ships (is WEBVIEW_PATH pointing at a stock one?)");
          }
          for (const [path, source] of Object.entries(assets)) {
            const bytes = await assetBytes(source);
            if (!isLive()) throw new Error("sweetview: the window was disposed during WebView.attach");
            const err = setAsset(handle(), path, assetMime(path), bytes);
            if (err !== 0) throw new Error(`sweetview: webview_set_asset(${path}) failed (${err})`);
          }
          raw.navigate(`${ASSET_ORIGIN}/${index}`);
        }
        if (isLive() && !isReady && options.readyTimeoutMs !== undefined && options.readyTimeoutMs > 0) {
          cancelWatchdog = scheduleNativeTimeout(options.readyTimeoutMs, () => {
            cancelWatchdog = undefined;
            if (!isLive() || isReady) return;
            raw.setHTML(options.readyFallbackHtml ?? startupErrorHtml);
            callReadyHook("onReadyTimeout", options.onReadyTimeout);
            showWhenReady();
          });
        }
      } catch (err) {
        shutdown();
        discardQuit();
        throw err;
      }

      return new WebView<M, E>({
        raw,
        window,
        emit,
        notify(method, params) {
          if (worker) worker.postMessage({ kind: "call", seq: null, method, params: params ?? null });
          else console.error(`sweetview: ${method}: this window has no worker`);
        },
        onEvent(fn) {
          const tap = fn as (event: { name: string; payload: unknown }) => void;
          taps.add(tap);
          return () => taps.delete(tap);
        },
        run() {
          try {
            core.webview_run(handle());
          } finally {
            shutdown();
            discardQuit();
          }
        },
        quit,
        dispose() {
          if (down) return;
          shutdown();
          discardQuit();
        },
      });
    } catch (err) {
      if (raw.unsafeHandle !== null) {
        raw.destroy();
        discardQuit();
      }
      throw err;
    }
  }

  /** Opens a new tab hosting a webview inside a tabbed Window (`tabs: true`). */
  static openTab<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
    window: Window,
    options: TabOptions<M>,
  ): Promise<Tab<M, E>> {
    if (!tabsDriver) {
      throw new Error("sweetview: tabs driver is not loaded");
    }
    return tabsDriver.openTab<M, E>(window, options);
  }

  emit<N extends keyof E & string>(name: N, payload: E[N]): void {
    this.#emit(name, payload);
  }

  /** Fire-and-forget call to the worker (renamed from `call`). */
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void {
    this.#notify(method, params[0] ?? null);
  }

  onEvent(fn: (event: AnyEvent<E>) => void): () => void {
    return this.#onEvent(fn);
  }

  run(): void {
    this.#run();
  }

  quit(): void {
    this.#quit();
  }

  dispose(): void {
    this.#dispose();
  }
}

/** Layer 2 declarative helper: creates a Window and attaches a WebView (or sets up tabs). */
export async function createApp<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
  options: AppOptions<M>,
): Promise<App<M, E>> {
  const window = new Window(options);

  if (options.tabs) {
    const unsubAutoQuit = options.onClose ? undefined : onWindowDispose(window, () => {
      if (Window.visibleWindows().length === 0) quitEventLoop();
    });
    let disposed = false;
    return {
      window,
      webview: undefined,
      openTab<TM extends MethodMap = M, TE extends EventMap = E>(tabOptions: TabOptions<TM>): Promise<Tab<TM, TE>> {
        return WebView.openTab<TM, TE>(window, tabOptions);
      },
      mergeAllWindows() {
        tabsDriver?.mergeAllWindows(window);
      },
      emit() {
        console.error("sweetview: app.emit() is unavailable on a tabbed app; emit on a specific tab.webview instead");
      },
      notify() {
        console.error("sweetview: app.notify() is unavailable on a tabbed app; notify on a specific tab.webview instead");
      },
      onEvent() {
        return () => {};
      },
      run() {
        return runEventLoop();
      },
      quit() {
        quitEventLoop();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubAutoQuit?.();
        tabsDriver?.disposeWindow(window);
        window.dispose();
      },
    };
  }

  try {
    const webview = await WebView.attach<M, E>(window, options);
    // Quit after disposal so a close handler can still hide the window.
    const unsubAutoQuit = options.onClose ? undefined : onWindowDispose(window, () => {
      if (Window.visibleWindows().length === 0) webview.quit();
    });
    let disposed = false;
    return {
      window,
      webview,
      openTab() {
        throw new Error("sweetview: openTab() requires createApp({ tabs: true })");
      },
      mergeAllWindows() {
        tabsDriver?.mergeAllWindows(window);
      },
      emit(name, payload) {
        webview.emit(name, payload);
      },
      notify(method, ...params) {
        webview.notify(method, ...params);
      },
      onEvent(fn) {
        return webview.onEvent(fn);
      },
      run() {
        webview.run();
      },
      quit() {
        webview.quit();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubAutoQuit?.();
        webview.dispose();
        window.dispose();
      },
    };
  } catch (err) {
    window.dispose();
    throw err;
  }
}
