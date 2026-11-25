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
import { createFrameAssembler, type AnyEvent, type EventMap, type MethodMap, type WireFrame } from "./ipc";
import type { InitMessage } from "./messages";
import { discardQuit, quitEventLoop, runEventLoop } from "./native/event-loop";
import { Window, getWindowMeta, preserveWindowGeometry, type Rect, type TabHandle, type WindowOptions } from "./native/window";
import { Ring } from "./ring";
import { ASSET_ORIGIN, backgroundColorCall, openWebviewCore, setAssetCall, webviewLibPath } from "./webview-lib";

/** Methods answered synchronously on the UI thread instead of by the worker (native dialogs, window state). */
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
      worker?.postMessage(init);
      if (worker) worker.onerror = (e) => console.error("sweetview: the worker failed:", e.message ?? e);

      let down = false;
      const shutdown = () => {
        if (down) return;
        down = true;
        assembler.clear();
        worker?.terminate();
        drain.close();
        if (raw.unsafeHandle !== null) raw.destroy();
      };

      try {
        const uiMethods = (options.uiMethods ?? {}) as Record<string, ((params: unknown) => unknown) | undefined>;
        raw.bindRaw("__sweetview_rpc", (seq, req) => {
          const [method, params] = JSON.parse(req) as [string, unknown];
          const local = Object.hasOwn(uiMethods, method) ? uiMethods[method] : undefined;
          if (!local) {
            if (worker) worker.postMessage({ kind: "call", seq, method, params });
            else raw.return(seq, 1, JSON.stringify({ message: `${method}: this window has no worker and no UI-thread method of that name` }));
            return;
          }
          try {
            const result = local(params);
            if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
              throw new Error(`${method}: a UI-thread method must return synchronously; this one returned a Promise`);
            }
            raw.return(seq, 0, JSON.stringify(result ?? null));
          } catch (err) {
            raw.return(seq, 1, JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
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
            const err = setAsset(handle(), path, assetMime(path), await assetBytes(source));
            if (err !== 0) throw new Error(`sweetview: webview_set_asset(${path}) failed (${err})`);
          }
          raw.navigate(`${ASSET_ORIGIN}/${index}`);
        }
      } catch (err) {
        worker?.terminate();
        drain.close();
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
          core.webview_run(handle());
          shutdown();
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
    let unsubAutoQuit: (() => void) | undefined;
    if (!options.onClose) {
      unsubAutoQuit = window.onClose(() => {
        window.dispose();
        quitEventLoop();
      });
    }
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
    // If the user did not intercept onClose, closing the main window exits app.run() cleanly.
    let unsubAutoQuit: (() => void) | undefined;
    if (!options.onClose) {
      unsubAutoQuit = window.onClose(() => {
        window.dispose();
        webview.quit();
      });
    }
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
