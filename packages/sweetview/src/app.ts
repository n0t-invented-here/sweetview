// UI thread. Owns the WebView (attached to a Layer 1 Window) and the Layer 2
// createApp helper. Everything async runs during attach/createApp; once run()
// starts, this thread runs the OS event loop (or runEventLoop() for tabbed /
// multi-window apps).

import type { HTMLBundle } from "bun";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { assetMime, indexHtml } from "./html";
import { createFrameAssembler, type AnyEvent, type EventMap, type MethodMap, type WireFrame } from "@n1h/sweetview-ipc";
import { RequestResponseAssembler, requestError, runNativeRequest, type NativeRequestResponse, type StreamingResponseFrame } from "./request-response";
import type { HttpRequestMessage, InitMessage, NativeRequest, NativeResponse, WorkerCrashFrame } from "./messages";
import { RawWebview, SizeHint, Window, quitEventLoop, runEventLoop, signalReady, type Rect, type TabHandle, type WindowOptions } from "@n1h/sweetview-native";
import { createChildWebview, discardQuit, emitWindowFileDrop, engineOf, getWindowBackend, getWindowMeta, holdWindowNativeDispose, isWindowDisposed, macosKeepsTagPath, onWindowDispose, onWindowFileDropListenersChange, preserveWindowGeometry, releaseAtEnd, scheduleNativeTimeout, windowFileDropCount } from "@n1h/sweetview-native/internal";
import { Ring } from "./ring";
import { messageOfThrown } from "./thrown-text";
import { webviewEngine, type WebviewHost, type WorkerWake } from "./webview-host";
import { ASSET_ORIGIN } from "./webview-lib";

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
  /** Worker entry calling `hostService()` or `hostRequestHandler()`. Relative paths resolve against `Bun.main`. */
  worker?: URL | string;
  /** Handle dynamic requests on the UI thread, or forward them to the Worker. */
  onRequest?: "worker" | ((request: NativeRequest) => NativeResponse);
  /**
   * Whether the webview accepts drags that start in another application
   * (files from Explorer or Finder, text or links from other apps). Default:
   * true. On Windows, false sets `ICoreWebView2Controller4::AllowExternalDrop`
   * to FALSE; on macOS, false makes the `SweetviewWKWebView` reject drags
   * whose source is another app. Drags within the page keep working.
   */
  allowExternalDrop?: boolean;
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
  /**
   * Insert the new tab directly after this tab. Honored only when `after`
   * belongs to the same window the tab opens in; a tab from another window
   * (or a closed tab) is ignored and the tab opens after the currently
   * selected tab, as when `after` is omitted.
   */
  after?: TabHandle;
};

/**
 * Internal `WebView.attach` hooks the tab drivers pass under
 * `tabAttachHooks`; not part of the public API. A tab's webview is attached
 * to a borrowed child window (a pane or one NSWindow of a tab group) while
 * the app sees a separate logical `Window({ tabs: true })` that can change
 * when the tab tears off or merges.
 */
export type TabAttachHooks = {
  /** The tab's current logical host: file-drop demand comes from it and drops over the webview are delivered to it. */
  fileDropHost(): Window;
  /** Replaces `window.show()` on the borrowed child window for `showOnReady` and the ready watchdog. */
  revealWindow?(): void;
  /**
   * Set by `WebView.attach`: re-subscribes file-drop demand to the current
   * `fileDropHost()`. The driver calls it after the tab's logical host
   * changes (tear-off, merge); the old host's subscription is dropped first,
   * so a drop is delivered once, to the new host.
   */
  rebindFileDrop?: () => void;
  /**
   * True once the driver abandoned this attach (its host was disposed while
   * the attach was awaiting). `WebView.attach` checks it around every await
   * and throws before touching the borrowed native window again.
   */
  isCancelled?(): boolean;
  /**
   * Called by `WebView.attach` once the native webview exists and its
   * scripts and bindings are set, right before its first `navigate`. A
   * driver registers native navigation handlers here so even a failure of
   * that first navigation reaches them. If it throws, the attach fails.
   */
  beforeNavigate?(raw: RawWebview): void;
  /**
   * Called right before the native webview is destroyed, however the
   * WebView is disposed (`dispose()`, `run()` returning, a failed attach).
   * A driver restores native state it changed on the webview here. Errors
   * are logged; the webview is destroyed anyway.
   */
  beforeDestroy?(): void;
  /**
   * Windows: makes the webview a child of the given window at `bounds` (its
   * client coordinates, physical pixels) instead of filling it, and leaves
   * the window's title, styles and bounds alone. The strip and the tabs of a
   * tabbed window are such children of its frame.
   */
  mountChild?(): { window: bigint; bounds: Rect; visible: boolean; pageBackground?: boolean };

};

/** Internal options key for `TabAttachHooks` (not exported from the package entry). */
export const tabAttachHooks: unique symbol = Symbol("sweetview.tabAttachHooks");

type InternalWebViewOptions<M extends MethodMap> = WebViewOptions<M> & { [tabAttachHooks]?: TabAttachHooks };

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

/**
 * Internal. Lets a webview's worker not keep the process alive by itself (see `WebView.attach`).
 * Until the macOS goal of the Rust rewrite the worker keeps its reference on macOS, as it did at
 * the tag `pre-rust-rewrite`: that path releases nothing at exit and has not been run on a Mac.
 * (Bun's Worker has `unref`, as Node's does; its DOM-shaped type does not declare it.)
 */
export function unrefWorker(worker: Worker | undefined): void {
  if (macosKeepsTagPath()) return;
  (worker as (Worker & { unref(): void }) | undefined)?.unref();
}

/**
 * Internal. Calls each `onEvent` listener with one event of the worker's. On Windows each runs in
 * its own `try`, and what one throws is added to `errors` (the drain throws them when it ends).
 * Until the macOS goal, macOS keeps the tag's loop: a listener's throw leaves the drain at once.
 */
export function callEventListeners(listeners: Iterable<(event: { name: string; payload: unknown }) => void>, name: string, payload: unknown, errors: unknown[]): void {
  if (macosKeepsTagPath()) {
    for (const fn of listeners) fn({ name, payload });
    return;
  }
  for (const fn of listeners) {
    try {
      fn({ name, payload });
    } catch (err) {
      errors.push(err);
    }
  }
}

/**
 * Internal. Whether a path that sees the worker fail prints its line. On Windows only the first
 * path does, so one failure is printed once. Until the macOS goal, macOS prints from every path,
 * as at the tag.
 */
export function printsWorkerFailure(alreadyFailed: boolean, down: boolean): boolean {
  return macosKeepsTagPath() || !(alreadyFailed || down);
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
    const tabHooks = (options as InternalWebViewOptions<M>)[tabAttachHooks];
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
    const onRequest = options.onRequest;
    if (onRequest === "worker" && options.worker === undefined) {
      throw new Error('sweetview: onRequest: "worker" requires a worker entry point');
    }
    // A tab driver can abandon the attach while it awaits (its host was
    // disposed); the borrowed native window may be gone, so stop before using it.
    const ensureAttachable = () => {
      if (tabHooks?.isCancelled?.() || isWindowDisposed(window)) {
        throw new Error("sweetview: cannot attach WebView to a disposed window");
      }
    };
    ensureAttachable();
    const engine = await webviewEngine();
    ensureAttachable();
    if (onRequest !== undefined && !engine.hasRequests) {
      throw new Error("sweetview: onRequest requires webview_set_request_handler and webview_complete_request from @n1h/sweetview-webview-bun >= 2.8.0 or a compatible WEBVIEW_PATH");
    }
    const meta = getWindowMeta(window);

    const useDirectUrl = options.url !== undefined && options.page === undefined && options.assets === undefined;
    const assets: Record<string, Asset> = { ...options.assets };
    let index = options.index ?? "index.html";
    let title = options.title ?? (meta.title || undefined);

    if (!useDirectUrl) {
      if (options.page) {
        const page = await pageAssets(options.page);
        ensureAttachable();
        Object.assign(assets, page.assets);
        index = options.index ?? page.index;
        const html = assets[index];
        if (title === undefined && html !== undefined) {
          title = htmlTitle(
            typeof html === "string" ? await Bun.file(html).text() : html instanceof Uint8Array ? new TextDecoder().decode(html) : await html.text(),
          );
          ensureAttachable();
        }
      }
      const windowTitle: string = title ?? basename(Bun.main, extname(Bun.main));
      if (!(index in assets)) assets[index] = indexHtml({ title: windowTitle, css: "main.css" in assets ? "main.css" : "" });
      title = windowTitle;
    } else {
      title ??= basename(Bun.main, extname(Bun.main));
    }

    ensureAttachable();
    const host = window.handle;
    if (host === null || host === 0 || host === 0n) {
      throw new Error("sweetview: cannot attach WebView to a window with a NULL handle");
    }

    const ringBytes = options.ringBytes ?? 1 << 20;
    if (!Number.isInteger(ringBytes) || ringBytes < 128 || ringBytes > 1 << 30 || (ringBytes & (ringBytes - 1)) !== 0) {
      throw new RangeError(`sweetview: ringBytes must be a power of two between 128 and 2^30, got ${ringBytes}`);
    }

    // Read DIPs directly from the Window so callers never duplicate width/height/scale/resizable.
    // Read after the last await so the borrowed window is known to be live.
    const scale = window.scale() || 1;
    const winBounds: Rect = window.bounds();
    const widthDips = Math.max(1, Math.round(winBounds.width / scale));
    const heightDips = Math.max(1, Math.round(winBounds.height / scale));
    // Frameless windows resize via Window.startResize(), not WS_THICKFRAME.
    const hint = meta.frame && meta.resizable ? SizeHint.NONE : SizeHint.FIXED;
    // A child webview is placed by its driver and changes nothing of the window it is in.
    const child = tabHooks?.mountChild?.();
    const restoreGeometry = child ? () => {} : preserveWindowGeometry(window);
    const createRaw = (): RawWebview => {
      // webview_create pumps messages while WebView2 initializes, so the window can be
      // closed under it. Hold the owned window's native dispose until the new view is
      // either kept or destroyed, so it is never created on, or left bound to, a dead HWND.
      const releaseCreateHold = meta.owned ? holdWindowNativeDispose(window) : undefined;
      try {
        // On Windows the binding gives the webview the backgroundColor of the window it is made in
        // (a tab's: its tabbed window's) from the moment WebView2 makes it.
        const created = child
          ? createChildWebview(options.debug ?? false, child.window, child.bounds, child.pageBackground === true)
          : new RawWebview(options.debug ?? false, { width: widthDips, height: heightDips, hint }, host);
        // A tab is shown by its driver once it is selected, never over the tab on show while it loads.
        if (child && !child.visible) engineOf(created)?.setVisible(false);
        if (created.unsafeHandle === null || Number(created.unsafeHandle) === 0) {
          throw new Error(
            process.platform === "win32"
              ? "sweetview: webview_create failed for the given window (is the WebView2 runtime installed?)"
              : "sweetview: webview_create failed for the given window",
          );
        }
        if (isWindowDisposed(window) || tabHooks?.isCancelled?.()) {
          created.destroy();
          discardQuit();
          throw new Error("sweetview: the window was disposed during WebView.attach");
        }
        // Restore exact styles and outer bounds if webview_set_size mutated them (Windows).
        restoreGeometry();
        return created;
      } finally {
        releaseCreateHold?.();
      }
    };
    const raw = createRaw();
    let view: WebviewHost | undefined;

    try {
      const engineHost = (view = engine.host(raw));
      if (!child) raw.title = title;
      if (meta.owned && !meta.title && title) window.setTitle(title);

      const quit = () => {
        if (raw.unsafeHandle !== null) engineHost.quit();
      };

      if (meta.transparent) {
        const err = engineHost.setBackgroundColor(0, 0, 0, 0);
        if (err === undefined) {
          console.warn("sweetview: this webview library has no webview_set_background_color; the page will not be transparent (see @n1h/sweetview-webview-bun)");
        } else if (err !== 0) {
          throw new Error(`sweetview: webview_set_background_color failed (${err})`);
        }
      }
      // On Windows the webview was made with its window's colour as the browser's background
      // (backgroundColor, or appearance's; a tab's, its tabbed window's), in the runtime (D46).
      if (options.allowExternalDrop !== undefined) {
        const error = engineHost.setAllowExternalDrop(options.allowExternalDrop);
        if (error !== undefined && error !== 0) throw new Error(`sweetview: webview_set_allow_external_drop failed (${error})`);
      }

      const sab = Ring.create(ringBytes);
      const ring = new Ring(sab);
      const taps = new Set<(event: { name: string; payload: unknown }) => void>();

      const emit = (name: string, payload: unknown) => {
        if (raw.unsafeHandle === null) return;
        raw.eval(`__sweetview_emit(${JSON.stringify(name)}, ${asJsLiteral(JSON.stringify(payload ?? null))})`);
      };

      const assembler = createFrameAssembler();
      const streamCalls = onRequest === "worker" ? engineHost.streaming : undefined;
      const requestResponses = new RequestResponseAssembler(!streamCalls);
      const activeStreams = new Set<string>();
      // Work handed to the worker and not answered yet: page RPC seqs and native request ids.
      // If the worker dies, each is failed so neither a page RPC nor a fetch() hangs forever.
      const pendingWorkerCalls = new Set<string>();
      const pendingWorkerRequests = new Set<bigint>();
      let workerFailure: string | undefined;
      const decoder = new TextDecoder();
      let down = false;
      // Takes back the dispose registered for the end of the application.
      let unregisterAtEnd: (() => void) | undefined;
      const isLive = () => !down && !isWindowDisposed(window) && raw.unsafeHandle !== null;
      const completeRequest = ({ id, status, headers, body }: NativeRequestResponse) => {
        pendingWorkerRequests.delete(BigInt(id));
        if (!isLive() || !engine.hasRequests) return;
        const error = engineHost.completeRequest(BigInt(id), status, JSON.stringify(headers), body);
        if (error !== 0) console.error(`sweetview: webview_complete_request failed (${error})`);
      };
      const streamResponse = (frame: StreamingResponseFrame) => {
        if (!isLive() || !streamCalls) return;
        const { id } = frame;
        const requestId = BigInt(id);
        if (frame.kind === "begin") {
          const error = streamCalls.begin(requestId, frame.status, JSON.stringify(frame.headers));
          if (error === 0) activeStreams.add(id);
          else {
            console.error(`sweetview: webview_begin_response failed (${error})`);
            completeRequest(requestError(requestId, 500, "Internal Server Error"));
          }
          return;
        }
        if (!activeStreams.has(id)) return;
        if (frame.kind === "chunk") {
          const error = streamCalls.write(requestId, frame.body);
          if (error === 0) return;
          console.error(`sweetview: webview_write_response_chunk failed (${error})`);
        }
        // The native API can end an already-started response, including after a reader error.
        activeStreams.delete(id);
        pendingWorkerRequests.delete(requestId);
        const error = streamCalls.end(requestId);
        if (error !== 0) console.error(`sweetview: webview_end_response failed (${error})`);
      };
      const drain = () => {
        ring.acknowledgeWakeup();
        let crashed: string | undefined;
        // What onEvent listeners threw: each listener and the page still get every event, the drain
        // goes on, and the errors are thrown once it has finished.
        const listenerErrors: unknown[] = [];
        for (const bytes of ring.drain()) {
          if (!isLive()) break;
          if (bytes[0] === 0) {
            const response = requestResponses.push(bytes);
            if (response) {
              if ("kind" in response) streamResponse(response);
              else completeRequest(response);
            }
            continue;
          }
          const wire = JSON.parse(decoder.decode(bytes)) as WireFrame | WorkerCrashFrame;
          if (wire.kind === "workerError") {
            // The worker's own error/unhandledrejection handler wrote this as it went down.
            // Worker.onerror cannot fire while webview_run() blocks this thread; this drain can.
            crashed = wire.message;
            break;
          }
          const frame = assembler.push(wire);
          if (!frame) continue;
          if (frame.kind === "reply") {
            // A reply for a call already failed (the worker was declared dead) is not answered twice.
            if (!pendingWorkerCalls.delete(frame.seq)) continue;
            if (frame.ok) raw.return(frame.seq, 0, JSON.stringify(frame.result ?? null));
            else raw.return(frame.seq, 1, JSON.stringify({ message: frame.error }));
          } else if (frame.kind === "event") {
            callEventListeners(taps, frame.name, frame.payload, listenerErrors);
            if (isLive()) emit(frame.name, frame.payload);
          }
        }
        if (crashed !== undefined) workerFailed(`worker crashed: ${crashed}`, ["sweetview: the worker failed:", crashed]);
        // One listener's error is thrown as it is, so it is printed as it was; several, together.
        if (listenerErrors.length === 1) throw listenerErrors[0];
        if (listenerErrors.length > 1) throw new AggregateError(listenerErrors, `sweetview: ${listenerErrors.length} onEvent listeners threw`);
      };
      // The worker ended. The first path to see it (its crash frame in the drain, Worker.onerror,
      // Worker.onmessageerror) prints the line and fails the worker; the others print nothing.
      const workerFailed = (reason: string, line: unknown[]) => {
        if (!printsWorkerFailure(workerFailure !== undefined, down)) return;
        console.error(...line);
        failWorker(reason);
      };

      const workerUrl =
        options.worker === undefined
          ? undefined
          : typeof options.worker === "string"
            ? /^[a-z][a-z0-9+.-]+:/i.test(options.worker)
              ? new URL(options.worker)
              : new URL(options.worker, pathToFileURL(Bun.main))
            : options.worker;

      // The worker's wake-up of this thread: registered with the engine once the worker starts.
      let workerDrain: { wake: WorkerWake; close(): void } | undefined;
      const closeWorkerDrain = () => {
        workerDrain?.close();
        workerDrain = undefined;
      };
      const worker = workerUrl === undefined ? undefined : new Worker(workerUrl.href);
      // The worker never keeps the process alive by itself: the loop does while it runs, and once
      // the application has quit the process ends with its script. The worker is terminated
      // with the webview, by dispose() or at the end of the application.
      unrefWorker(worker);
      let requestHandlerSet = false;
      let isReady = false;
      let cancelWatchdog: (() => void) | undefined;
      let deferScheduled = false;
      let cancelDispatch: (() => void) | undefined;
      const queue: UiJob[] = [];
      const cancelStartup = () => {
        cancelWatchdog?.();
        cancelWatchdog = undefined;
      };
      const clearDispatches = () => {
        queue.length = 0;
        cancelDispatch?.();
        cancelDispatch = undefined;
      };
      const dropHost = (): Window => tabHooks?.fileDropHost() ?? window;
      let dropRegistered = false;
      const onNativeDrop = (paths: string[]) => {
        if (isLive() && dropRegistered) emitWindowFileDrop(dropHost(), paths);
      };
      const setFileDrop = (enabled: boolean) => {
        if (enabled === dropRegistered || raw.unsafeHandle === null || (enabled && !isLive())) return;
        const error = engineHost.setFileDropHandler(enabled ? onNativeDrop : null);
        // An engine with no file drop handler leaves drops to the native window.
        if (error === undefined) return;
        // On failure native keeps whatever it had, so the state stays as it was.
        if (error === 0) dropRegistered = enabled;
        else console.error(`sweetview: webview_set_file_drop_handler failed (${error})`);
      };
      let unsubscribeFileDrop: (() => void) | undefined;
      // Subscribes file-drop demand to the logical host (the window itself,
      // or a tab's current tabbed Window), replacing any previous host's
      // subscription so one drop is never delivered to two hosts.
      const bindFileDrop = () => {
        unsubscribeFileDrop?.();
        unsubscribeFileDrop = undefined;
        const target = isLive() ? dropHost() : undefined;
        if (target === undefined || isWindowDisposed(target)) {
          setFileDrop(false);
          return;
        }
        unsubscribeFileDrop = onWindowFileDropListenersChange(target, setFileDrop);
        setFileDrop(windowFileDropCount(target) > 0);
      };
      const detachFileDrop = () => {
        unsubscribeFileDrop?.();
        unsubscribeFileDrop = undefined;
        // A failed unregister leaves native holding the handler: the host keeps it
        // alive until shutdown disposes it, once the webview is destroyed.
        setFileDrop(false);
      };
      // True while run() is inside webview_run: the native loop still owns the view.
      let running = false;
      // Inside run(), webview_run must return before the view is destroyed:
      // stop everything that can reach the view, end the loop, and let
      // run()'s finally finish the teardown (webview_destroy).
      const stopInsideRun = () => {
        cancelStartup();
        clearDispatches();
        detachFileDrop();
        closeWorkerDrain();
        ring.stopDispatch();
        worker?.terminate();
        quit();
      };
      const unsubscribeWindowDispose = onWindowDispose(window, () => {
        if (running) {
          stopInsideRun();
          return;
        }
        if (!meta.owned) {
          // A borrowed window's owner (a tab driver, or the embedding app)
          // disposes the WebView itself.
          cancelStartup();
          clearDispatches();
          detachFileDrop();
          return;
        }
        shutdown();
        discardQuit();
      });
      const shutdown = () => {
        if (down) return;
        down = true;
        unregisterAtEnd?.();
        if (tabHooks) tabHooks.rebindFileDrop = undefined;
        unsubscribeWindowDispose();
        cancelStartup();
        clearDispatches();
        assembler.clear();
        requestResponses.clear();
        // Destroying the webview aborts native streams, including any waiting for their next chunk.
        activeStreams.clear();
        detachFileDrop();
        if (requestHandlerSet && raw.unsafeHandle !== null) engineHost.setRequestHandler(null);
        requestHandlerSet = false;
        closeWorkerDrain();
        ring.stopDispatch();
        worker?.terminate();
        if (raw.unsafeHandle !== null) {
          try {
            tabHooks?.beforeDestroy?.();
          } catch (err) {
            console.error("sweetview: a tab driver's beforeDestroy hook threw:", err);
          }
          raw.destroy();
        }
        // Only now, with the webview destroyed, can the host free what native held.
        dropRegistered = false;
        engineHost.dispose();
      };

      const respond =(seq: string, status: number, value: unknown) => {
        if (isLive()) raw.return(seq, status, JSON.stringify(value ?? null));
      };
      const replyError = (seq: string, error: unknown, readFailed?: (failure: unknown) => void) => {
        respond(seq, 1, { message: messageOfThrown(error, readFailed) });
      };
      // The worker is gone (an uncaught error, or a message it sent could not be read): fail
      // everything waiting on it, then refuse new work for it instead of letting it hang.
      const failWorker = (reason: string) => {
        if (workerFailure !== undefined || down) return;
        // Set first: the drain below can meet the worker's own crash frame and re-enter.
        workerFailure = reason;
        // Whatever the worker finished before it died is still delivered.
        try {
          if (isLive()) drain();
        } catch (err) {
          console.error("sweetview: draining the failed worker's replies threw:", err);
        }
        closeWorkerDrain();
        worker?.terminate();
        for (const seq of [...pendingWorkerCalls]) replyError(seq, reason);
        pendingWorkerCalls.clear();
        for (const id of [...pendingWorkerRequests]) {
          const key = String(id);
          if (activeStreams.has(key)) {
            // The status line already went out; end the body so the reader is not left waiting.
            activeStreams.delete(key);
            if (isLive() && streamCalls) {
              const error = streamCalls.end(id);
              if (error !== 0) console.error(`sweetview: webview_end_response failed (${error})`);
            }
          } else {
            completeRequest(requestError(id, 500, "Internal Server Error"));
          }
        }
        pendingWorkerRequests.clear();
        assembler.clear();
        requestResponses.clear();
      };
      const invoke = ({ seq, method, fn, params }: UiJob, readFailed?: (failure: unknown) => void) => {
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
          replyError(seq, err, readFailed);
        }
      };
      const scheduleDeferred = () => {
        if (!isLive() || deferScheduled || queue.length === 0) return;
        deferScheduled = true;
        try {
          cancelDispatch = engineHost.dispatch(() => {
            cancelDispatch = undefined;
            try {
              // Keep the scheduled flag set during handlers. A modal loop may
              // pump more RPC messages while the current dialog is open.
              // On the main branch the first value of a batch whose read threw ended the batch, and
              // the native dispatch's catch printed `sweetview: UI dispatch failed:` for what the
              // read threw: every call is answered now, and that line is printed once the batch is
              // done, with a listener too (a fault of this package's, not told: D44).
              let readFailure: { error: unknown } | undefined;
              for (const job of queue.splice(0)) {
                if (!isLive()) break;
                invoke(job, (error) => void (readFailure ??= { error }));
              }
              if (readFailure) console.error("sweetview: UI dispatch failed:", readFailure.error);
            } finally {
              deferScheduled = false;
              scheduleDeferred();
            }
          });
        } catch (err) {
          cancelDispatch = undefined;
          deferScheduled = false;
          for (const { seq } of queue.splice(0)) replyError(seq, err);
        }
      };
      const showWhenReady = () => {
        if (!isLive() || !options.showOnReady) return;
        if (tabHooks?.revealWindow) tabHooks.revealWindow();
        else if (!window.isVisible()) window.show();
      };
      const callReadyHook = (name: string, hook: (() => void) | undefined) => {
        try {
          hook?.();
        } catch (err) {
          console.error(`sweetview: ${name} handler threw:`, err);
        }
      };

      try {
        bindFileDrop();
        if (tabHooks) tabHooks.rebindFileDrop = bindFileDrop;
        if (worker) {
          workerDrain = engineHost.openDrain(drain);
          const init: InitMessage = { kind: "init", ring: sab, wake: workerDrain.wake };
          worker.postMessage(init);
          worker.onerror = (e) => {
            workerFailed(`worker crashed: ${e.message ?? String(e)}`, ["sweetview: the worker failed:", e.message ?? e]);
          };
          worker.onmessageerror = () => {
            workerFailed("worker crashed: a message from the worker could not be deserialized", ["sweetview: the worker sent a message that could not be deserialized"]);
          };
        }
        if (onRequest !== undefined && engine.hasRequests) {
          const error = engineHost.setRequestHandler((request: NativeRequest) => {
              if (!isLive()) return;
              const { id } = request;
              try {
                if (onRequest === "worker") {
                  if (workerFailure !== undefined) {
                    completeRequest(requestError(id, 500, "Internal Server Error"));
                    return;
                  }
                  const msg: HttpRequestMessage = { kind: "http-request", ...request };
                  pendingWorkerRequests.add(id);
                  worker!.postMessage(msg, request.body.byteLength ? [request.body.buffer] : []);
                } else {
                  completeRequest(runNativeRequest(onRequest, request));
                }
              } catch {
                completeRequest(requestError(id, 500, "Internal Server Error"));
              }
          });
          if (error !== 0) throw new Error(`sweetview: webview_set_request_handler failed (${error})`);
          requestHandlerSet = true;
        }
        // A plain external page (a URL, no bundled page or assets) with nothing that answers
        // RPCs or waits for readiness gets no __sweetview_rpc binding: zero native surface.
        const needsRpc =
          !useDirectUrl ||
          options.uiMethods !== undefined ||
          options.deferredUiMethods !== undefined ||
          options.worker !== undefined ||
          options.showOnReady === true ||
          options.readyTimeoutMs !== undefined ||
          options.onReady !== undefined;
        if (needsRpc) raw.bindRaw("__sweetview_rpc", (seq, req) => {
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
            } else if (worker) {
              if (workerFailure !== undefined) {
                replyError(seq, workerFailure);
                return;
              }
              pendingWorkerCalls.add(seq);
              worker.postMessage({ kind: "call", seq, method, params });
            } else replyError(seq,`${method}: this window has no worker and no UI-thread method of that name`);
          } catch (err) {
            replyError(seq, err);
          }
        });

        if (useDirectUrl) {
          tabHooks?.beforeNavigate?.(raw);
          raw.navigate(options.url!);
        } else {
          for (const [path, source] of Object.entries(assets)) {
            const bytes = await assetBytes(source);
            if (!isLive() || tabHooks?.isCancelled?.()) throw new Error("sweetview: the window was disposed during WebView.attach");
            const err = engineHost.setAsset(path, assetMime(path), bytes);
            if (err !== 0) throw new Error(`sweetview: webview_set_asset(${path}) failed (${err})`);
          }
          if (!isLive() || tabHooks?.isCancelled?.()) throw new Error("sweetview: the window was disposed during WebView.attach");
          tabHooks?.beforeNavigate?.(raw);
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

      const webview = new WebView<M, E>({
        raw,
        window,
        emit,
        notify(method, params) {
          if (worker && workerFailure !== undefined) console.error(`sweetview: ${method}: ${workerFailure}`);
          else if (worker) worker.postMessage({ kind: "call", seq: null, method, params: params ?? null });
          else console.error(`sweetview: ${method}: this window has no worker`);
        },
        onEvent(fn) {
          const tap = fn as (event: { name: string; payload: unknown }) => void;
          taps.add(tap);
          return () => taps.delete(tap);
        },
        run() {
          if (down) return;
          // Keep the owned native window alive until webview_destroy has run:
          // a window.dispose() or native close inside the loop only ends it.
          const releaseWindowDispose = meta.owned ? holdWindowNativeDispose(window) : undefined;
          // A window the end of an earlier run() hid (below) is shown again for this one: now,
          // or with showOnReady once this page is ready.
          // Only when nothing but Sweetview hid it since: the application's own hide() stands.
          if (getWindowBackend(window).takeHiddenAtRunEnd?.() && !isWindowDisposed(window) && !window.isVisible()) {
            if (!options.showOnReady || isReady) window.show();
          }
          running = true;
          try {
            engineHost.run();
          } finally {
            running = false;
            try {
              // Off the screen before its webview goes, so the window is never seen with its
              // client area empty (D46). It stays alive for code after run() and a second run(),
              // which shows it again; the end of the application destroys it. A window disposed
              // inside the loop was hidden by its dispose and is destroyed below.
              // macOS keeps the tag's order until its goal (D42).
              if (!macosKeepsTagPath() && meta.owned && !child && !isWindowDisposed(window)) getWindowBackend(window).hideAtRunEnd?.();
              shutdown();
            } finally {
              releaseWindowDispose?.();
            }
            discardQuit();
          }
        },
        quit,
        dispose() {
          if (down) return;
          if (running) {
            stopInsideRun();
            return;
          }
          shutdown();
          discardQuit();
        },
      });
      // Disposed when the application ends, before the windows: its worker stops and its webview goes.
      unregisterAtEnd = releaseAtEnd("app", () => webview.dispose());
      return webview;
    } catch (err) {
      if (raw.unsafeHandle !== null) {
        raw.destroy();
        discardQuit();
      }
      view?.dispose();
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

  /** Fire-and-forget call to a worker method: no reply, and errors are not reported back. */
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
    // True while run() is inside webview.run(): dispose() then ends the loop and
    // leaves the window to run(), after the webview is destroyed.
    let inRun = false;
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
        inRun = true;
        try {
          webview.run();
        } finally {
          inRun = false;
          if (disposed) window.dispose();
        }
      },
      quit() {
        webview.quit();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubAutoQuit?.();
        // Outside run(), the window's dispose hides it, then destroys the webview (its dispose
        // hook), then the window (D46). Inside run(), the webview ends the loop, and run()
        // hides the window, destroys the webview and then disposes the window.
        if (macosKeepsTagPath()) {
          // The tag's order until the macOS goal (D42).
          webview.dispose();
          if (!inRun) window.dispose();
          return;
        }
        if (!inRun) window.dispose();
        webview.dispose();
      },
    };
  } catch (err) {
    window.dispose();
    throw err;
  }
}
