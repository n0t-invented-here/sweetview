// The low-level webview: one native web view, in a window of its own or
// mounted inside a window you give it. This is the class the package
// `@n1h/sweetview-webview-bun` exported as `Webview`; `@n1h/sweetview` builds
// `WebView.attach` and `createApp` on it and re-exports it as `RawWebview`.
//
// Windows: the Rust binding (`wry` on WebView2, plus Sweetview's own request
// handler). macOS: the webview library of `@n1h/sweetview-webview-bun`, until
// the macOS goal of the rewrite replaces it; `./darwin/webview` is that seam.

import { binding } from "./binding";
import { reportCallbackError } from "./callback-errors";
import type { Engine } from "../prebuilt/binding";
import { releaseAtEnd } from "./lifetime";
import type { WindowHandle } from "./types";

/**
 * Names a live webview. Pass it to the functions a `Worker` calls
 * ({@link completeWebviewRequest} and the streaming ones). An opaque number:
 * it is not a pointer and has no meaning outside this package.
 */
export type WebviewHandle = number;

/** A `webview_error_t` other than `WEBVIEW_ERROR_OK`. */
export class WebviewError extends Error {
  constructor(
    readonly fn: string,
    readonly code: number,
  ) {
    super(`${fn} failed with webview_error_t ${code}`);
    this.name = "WebviewError";
  }
}

function check(fn: string, code: number) {
  if (code !== 0) throw new WebviewError(fn, code);
}

// A status that is not an integer from 100 to 599 is refused here with
// WEBVIEW_ERROR_INVALID_ARGUMENT, before any conversion can wrap or truncate it.
function checkStatus(fn: string, status: number) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new WebviewError(fn, -2);
  }
}

/** A request to one of the webview's origins that no asset answered (see {@link Webview.setRequestHandler}). */
export interface WebviewRequest {
  /** Pass to {@link Webview.completeRequest} when answering it yourself. */
  id: bigint;
  /** The HTTP method, for example `GET` or `POST`. */
  method: string;
  /** The full URL, for example `http://webview.localhost/api?x=1`. */
  url: string;
  /** The request headers in the order the browser sent them; a name may repeat. */
  headers: [name: string, value: string][];
  /** The request body (a copy), or null when there is none. */
  body: Uint8Array | null;
}

/** The answer to a {@link WebviewRequest}. */
export interface WebviewResponse {
  /** HTTP status code, 100 to 599. Defaults to 200. */
  status?: number;
  /**
   * Response headers: an object of name to value, or `[name, value]` pairs,
   * which allow a name to repeat. Each name must be an RFC 9110 token and each
   * value free of CR, LF, NUL and other control characters but tab; anything
   * else throws a {@link WebviewError} (`WEBVIEW_ERROR_INVALID_ARGUMENT`) and
   * answers nothing. Windows sends every pair as its own header line; macOS
   * (`NSHTTPURLResponse`) joins repeated names with `", "` and keeps only the
   * first `Set-Cookie`, so at most one `Set-Cookie` per response there.
   */
  headers?: Record<string, string> | [name: string, value: string][];
  /** The body; a string is encoded as UTF-8. */
  body?: Uint8Array | ArrayBuffer | string | null;
}

/**
 * Answers a {@link WebviewRequest}: return (or resolve to) a
 * {@link WebviewResponse} and it is sent, or return nothing and call
 * {@link Webview.completeRequest} with `request.id` later. A handler that
 * throws or rejects answers 500.
 */
export type RequestHandler = (request: WebviewRequest) => WebviewResponse | void | Promise<WebviewResponse | void>;

/** The head of a streamed answer (see {@link beginWebviewResponse}). */
export interface WebviewResponseHead {
  /** HTTP status code, 100 to 599. Defaults to 200. */
  status?: number;
  /** Response headers, exactly as {@link WebviewResponse.headers}. */
  headers?: WebviewResponse["headers"];
}

/** Receives the real filesystem paths of files dropped on the webview from the operating system (see {@link Webview.setFileDropHandler}). */
export type FileDropHandler = (paths: string[]) => void;

/** Window size */
export interface Size {
  /** The width of the window */
  width: number;
  /** The height of the window */
  height: number;
  /** The window size hint */
  hint: SizeHint;
}

/** Window size hints */
export enum SizeHint {
  /** Width and height are default size */
  NONE,
  /** Width and height are minimum bounds */
  MIN,
  /** Width and height are maximum bounds */
  MAX,
  /** Window size can not be changed by a user */
  FIXED,
}

/**
 * The version of the webview engine's API this class follows: the
 * `webview/webview` C API version whose calls and error codes it keeps.
 */
export const WEBVIEW_VERSION = "0.12.0";

function responseBodyBytes(body: WebviewResponse["body"]): Uint8Array | null {
  if (body == null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

const headersJson = (headers: WebviewResponse["headers"]): string | null => (headers ? JSON.stringify(headers) : null);

// The macOS seam: these four and the class fall through to the webview library there.
// The library is loaded with `import()`, not `require`: it has a top-level await of its own.
type DarwinWebview = typeof import("./darwin/webview");
const onDarwin = process.platform === "darwin";
const darwinModule: DarwinWebview | undefined = onDarwin ? await import("./darwin/webview") : undefined;
const darwin = (): DarwinWebview => darwinModule!;

/**
 * Answers a request handed to a {@link Webview.setRequestHandler request handler},
 * given the webview's {@link Webview.unsafeHandle}. Safe to call from any
 * thread: this is how a `Worker` answers requests while {@link Webview.run}
 * blocks the thread that owns the webview. Post the handle and the request
 * to the worker, then call this there. The headers and body are copied before
 * this returns. Completing a request twice, or one the browser has since
 * cancelled, does nothing.
 *
 * Safe against the webview being destroyed on another thread: once
 * {@link Webview.destroy} has begun this throws a {@link WebviewError}
 * (`WEBVIEW_ERROR_INVALID_STATE`, code -3), and an answer queued just before
 * then does nothing. Still stop the worker before destroying the webview, so
 * it does not keep answering into nothing.
 *
 * @throws {WebviewError} Bad headers (see {@link WebviewResponse.headers}),
 * a status outside 100-599, a body over 4 GiB - 1, or a destroyed webview.
 */
export function completeWebviewRequest(handle: WebviewHandle, id: bigint, response: WebviewResponse = {}) {
  if (onDarwin) return darwin().completeWebviewRequest(handle, id, response);
  const status = response.status ?? 200;
  checkStatus("webview_complete_request", status);
  const body = responseBodyBytes(response.body);
  check(
    "webview_complete_request",
    binding().completeRequest(handle, id, status, headersJson(response.headers), body && body.byteLength > 0 ? body : null),
  );
}

/**
 * Starts a streamed answer to a {@link WebviewRequest}, given the webview's
 * {@link Webview.unsafeHandle}: the status and headers go now, the body
 * follows piece by piece with {@link writeWebviewResponseChunk}, and
 * {@link endWebviewResponse} ends it, with no socket. Use instead of
 * {@link completeWebviewRequest}, never both for one request. Safe to call
 * from any thread.
 *
 * Windows: the body is a stream WebView2 reads on its own thread, but
 * WebView2 hands the page the response only once the whole body is read (a
 * WebView2 limitation for intercepted requests), so an `EventSource` there
 * gets every event at {@link endWebviewResponse}, not one by one. macOS: the
 * page reads the body as it arrives.
 *
 * @throws {WebviewError} Bad headers, a status outside 100-599, a response
 * already begun for this request (`WEBVIEW_ERROR_DUPLICATE`, Windows), or a
 * destroyed webview (`WEBVIEW_ERROR_INVALID_STATE`, code -3).
 */
export function beginWebviewResponse(handle: WebviewHandle, id: bigint, head: WebviewResponseHead = {}) {
  if (onDarwin) return darwin().beginWebviewResponse(handle, id, head);
  const status = head.status ?? 200;
  checkStatus("webview_begin_response", status);
  check("webview_begin_response", binding().beginResponse(handle, id, status, headersJson(head.headers)));
}

/**
 * Appends a piece of the body to a response started with
 * {@link beginWebviewResponse}. Safe to call from any thread; the bytes are
 * copied before this returns. A chunk for a response that has ended, was
 * never begun, or that the page abandoned is dropped; an empty chunk writes
 * nothing, but is still checked like any other (a destroyed webview throws).
 *
 * @param chunk The bytes; a string is encoded as UTF-8.
 * @throws {WebviewError} A chunk over 4 GiB - 1, or a destroyed webview
 * (`WEBVIEW_ERROR_INVALID_STATE`, code -3).
 */
export function writeWebviewResponseChunk(handle: WebviewHandle, id: bigint, chunk: Uint8Array | ArrayBuffer | string) {
  if (onDarwin) return darwin().writeWebviewResponseChunk(handle, id, chunk);
  check("webview_write_response_chunk", binding().writeResponseChunk(handle, id, responseBodyBytes(chunk)!));
}

/**
 * Ends a response started with {@link beginWebviewResponse}; the page sees
 * the end once it has read every chunk written before. Safe to call from any
 * thread. Ending twice, or a response never begun, does nothing.
 *
 * @throws {WebviewError} A destroyed webview (`WEBVIEW_ERROR_INVALID_STATE`, code -3).
 */
export function endWebviewResponse(handle: WebviewHandle, id: bigint) {
  if (onDarwin) return darwin().endWebviewResponse(handle, id);
  check("webview_end_response", binding().endResponse(handle, id));
}

/**
 * How a binding's thrown or rejected value reaches the page (see {@link Webview.bind}). As the
 * main branch for every value it could read. Where its read threw (a Proxy whose `getPrototypeOf`
 * throws, an `Error` whose `message` getter throws), the page's call is rejected all the same,
 * the value described as any other, and `readFailed` is told what that read threw.
 */
export function serializeBindingError(err: unknown, readFailed?: (failure: unknown) => void): string {
  if (err === undefined) return "";
  let isError: boolean;
  try {
    isError = err instanceof Error;
  } catch (failure) {
    readFailed?.(failure);
    isError = false;
  }
  if (isError) {
    try {
      return JSON.stringify((err as Error).message);
    } catch (failure) {
      readFailed?.(failure);
      return describedForPage(err);
    }
  }
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return json;
  } catch {
    // Falls through to String().
  }
  return describedForPage(err);
}

function describedForPage(err: unknown): string {
  try {
    return JSON.stringify(String(err));
  } catch {
    return JSON.stringify("binding failed");
  }
}

const instances = new Set<Webview>();
/** Takes back the end-of-application destroy of each live native webview, by its handle. */
const endOfWebview = new Map<WebviewHandle, () => void>();
const engines = new WeakMap<Webview, Engine>();

/** Internal: the engine of a live webview, for the tabs library; `undefined` once it is destroyed (and always on macOS). */
export function engineOf(webview: Webview): Engine | undefined {
  return engines.get(webview);
}

/**
 * How `createChildWebview` asks the constructor for a child: passed with the call, in place of a
 * size, so nothing is held across the creation (which pumps messages: a webview made meanwhile
 * takes nothing of it). Not exported: only this module makes one.
 */
class ChildMount {
  constructor(
    readonly bounds: { x: number; y: number; width: number; height: number },
    readonly pageBackground: boolean,
  ) {}
}

/** The size a webview made without one gets. */
const DEFAULT_SIZE: Size = { width: 1024, height: 768, hint: SizeHint.NONE };

/**
 * Internal, Windows: a webview made as a child of `window` at `bounds` (its
 * client coordinates, physical pixels), for the tabs library's strip and tabs.
 * With `pageBackground`, the child is a page of the window (a tab), and starts
 * with the window's `backgroundColor`; the strip keeps its own.
 */
export function createChildWebview(debug: boolean, window: bigint, bounds: { x: number; y: number; width: number; height: number }, pageBackground = false): Webview {
  return new Webview(debug, new ChildMount(bounds, pageBackground) as unknown as Size, window);
}

/**
 * Destroys every webview this process created through {@link Webview} that
 * is still alive. Installed mouse or keyboard hooks are not removed; dispose
 * them first.
 */
export function unload() {
  if (onDarwin) return darwin().unload();
  for (const instance of [...instances]) instance.destroy();
}

/** An instance of a webview window. */
export class Webview {
  #engine: Engine | null = null;
  #handle: WebviewHandle | null = null;
  // True while this webview's run() is inside the loop; see destroy().
  #running = false;

  /** The number that names this webview to the functions a `Worker` calls; `null` once destroyed. */
  get unsafeHandle(): WebviewHandle | null {
    return this.#handle;
  }

  /**
   * The native window the webview lives in: the `HWND` on Windows, the
   * `NSWindow` pointer on macOS. The window you passed when you passed one.
   */
  get unsafeWindowHandle(): number | null {
    return this.#engine ? Number(this.#engine.windowHandle) : null;
  }

  /** Sets the native window size. */
  set size({ width, height, hint }: Size) {
    this.#engine?.setSize(width, height, hint);
  }

  /** Sets the native window title. */
  set title(title: string) {
    this.#engine?.setTitle(title);
  }

  /**
   * Wraps a webview that already exists, given its {@link Webview.unsafeHandle}.
   *
   * @param handle A live webview's handle
   */
  constructor(handle: WebviewHandle);
  /**
   * Creates a new webview.
   *
   * @param debug Defaults to false; when true developer tools and the
   * context menu are enabled
   * @param size The window size, default 1024x768 with no size hint
   * (`undefined` is a missing argument, so it gets the default too). A
   * window you pass is restyled and resized by it, as the C++ library did,
   * but not shown.
   * @param window A native window handle (`HWND`, or `NSWindow` pointer on
   * macOS) to mount the webview in. When `null` or omitted a new window is
   * created.
   */
  constructor(debug?: boolean, size?: Size, window?: WindowHandle);
  constructor(
    debugOrHandle: boolean | WebviewHandle = false,
    sizeOrMount: Size | undefined = DEFAULT_SIZE,
    window: WindowHandle = null,
  ) {
    const mount = sizeOrMount instanceof ChildMount ? sizeOrMount : undefined;
    // A child gets the size a webview made without one gets, as it always has.
    const size = mount ? DEFAULT_SIZE : sizeOrMount;
    // The macOS seam: there the instance is the webview library's own class, with this same API.
    if (onDarwin) return darwin().createWebview(debugOrHandle, size, window) as unknown as Webview;
    const native = binding();
    if (typeof debugOrHandle === "number" || typeof debugOrHandle === "bigint") {
      const existing = native.Engine.fromHandle(Number(debugOrHandle));
      // A handle that names nothing is never registered: every later call would act on nothing.
      if (!existing) throw new WebviewError("webview_create", -1);
      this.#engine = existing;
    } else {
      const host = window === null || window === 0 || window === 0n ? null : BigInt(window);
      try {
        this.#engine =
          mount !== undefined && host !== null
            ? native.Engine.createChild(Boolean(debugOrHandle), host, mount.bounds, mount.pageBackground)
            : native.Engine.create(Boolean(debugOrHandle), host);
      } catch (err) {
        throw Object.assign(new WebviewError("webview_create", -1), { cause: err });
      }
    }
    this.#handle = this.#engine.handle;
    engines.set(this, this.#engine);
    if (size !== undefined && typeof debugOrHandle === "boolean") this.size = size;
    instances.add(this);
    // Destroyed when the application ends, before the windows (see lifetime.ts): one entry for
    // the native webview, however many wrappers `new Webview(handle)` makes of it.
    const handle = this.#handle;
    if (!endOfWebview.has(handle)) {
      endOfWebview.set(handle, releaseAtEnd("webview", () => {
        for (const instance of [...instances]) if (instance.unsafeHandle === handle) instance.destroy();
      }));
    }
  }

  // The engine, or the library's answer for a destroyed webview: WEBVIEW_ERROR_INVALID_STATE.
  #live(fn: string): Engine {
    if (!this.#engine) throw new WebviewError(fn, -3);
    return this.#engine;
  }

  /**
   * Destroys the webview and, when it made its own window, closes it.
   *
   * Safe to call from inside the request handler, the file drop handler or a
   * binding. The webview counts as destroyed at once: no handler or binding
   * is called again, and the methods that check (such as
   * {@link Webview.completeRequest} and {@link Webview.setRequestHandler})
   * throw `WEBVIEW_ERROR_INVALID_STATE` (code -3). The native teardown waits
   * until the callback has returned: it happens when {@link Webview.run}
   * returns, or on the next turn of the event loop.
   */
  destroy() {
    const engine = this.#engine;
    if (!engine) return;
    this.#engine = null;
    const handle = this.#handle;
    this.#handle = null;
    instances.delete(this);
    engines.delete(this);
    // Destroying any wrapper destroys the native webview, so its end entry goes.
    if (handle !== null) {
      endOfWebview.get(handle)?.();
      endOfWebview.delete(handle);
    }
    // Requests still open are released unanswered, open streams are aborted,
    // and every handler and binding goes with the webview.
    engine.destroy();
    // Ends run(). Only while this webview's own run() is in progress: otherwise the
    // quit would reach whichever loop runs next on this thread.
    if (this.#running) binding().quitLoop();
  }

  /** Navigates the webview to the given URL. A `data:` URI works. */
  navigate(url: string) {
    this.#engine?.navigate(url);
  }

  /** Sets the current HTML of the webview to the given string. */
  setHTML(html: string) {
    this.#engine?.setHtml(html);
  }

  /**
   * Serves bytes at a path of the webview's own origin, so the page can be
   * loaded with {@link Webview.navigate} instead of {@link Webview.setHTML}
   * (which Windows caps at 2 MB) and can fetch scripts, styles, images and
   * models by relative URL. Nothing reaches the network. The bytes are copied;
   * calling again with the same path replaces them.
   *
   * The origin is `http://webview.localhost` on Windows and
   * `webview://localhost` on macOS; {@link Webview.assetOrigin} is the one for
   * this platform. The request URL's raw path is matched (not
   * percent-decoded; a trailing slash kept), query string and fragment
   * removed, leading slashes ignored.
   *
   * @param path URL path without the leading slash, for example `index.html`
   * or `js/main.js`. Must not need percent-encoding.
   * @param mime The `Content-Type` header, for example `text/html; charset=utf-8`.
   * @param data The bytes; a string is encoded as UTF-8.
   */
  setAsset(path: string, mime: string, data: Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    check("webview_set_asset", this.#live("webview_set_asset").setAsset(path, mime, bytes));
  }

  /** The origin {@link Webview.setAsset} serves at on this platform; navigate to `${webview.assetOrigin}/index.html`. */
  get assetOrigin(): string {
    return process.platform === "win32" ? "http://webview.localhost" : "webview://localhost";
  }

  /**
   * A second origin, cross-origin from {@link Webview.assetOrigin}, for
   * content the page must not reach into, such as a sandboxed `<iframe>`.
   * Every request to it goes to the {@link Webview.setRequestHandler request handler}.
   */
  get framesOrigin(): string {
    return process.platform === "win32" ? "http://frames.webview.localhost" : "webview-frames://localhost";
  }

  /**
   * Answers requests in code instead of from fixed bytes: every request to
   * {@link Webview.assetOrigin} that no {@link Webview.setAsset asset}
   * matches (assets still answer first), and every request to
   * {@link Webview.framesOrigin}. Nothing reaches the network and no socket
   * is opened. Without a handler those requests answer 404.
   *
   * The handler runs on the thread that runs the webview, inside
   * {@link Webview.run}. It must not block. Return a
   * {@link WebviewResponse} to send it, or return nothing and answer later
   * with {@link Webview.completeRequest} or, from a `Worker`,
   * {@link completeWebviewRequest}; a handler that throws answers 500.
   * Requests stay open until answered, and the browser waits for them.
   *
   * A returned promise is answered when it settles (500 if it rejects), but
   * promises settle only when the thread's event loop turns, and
   * {@link Webview.run} blocks it. For work that needs `await`, post the
   * request to a `Worker` and answer it there with
   * {@link completeWebviewRequest}.
   *
   * Pass `null` to remove the handler; requests already handed to it stay
   * open until completed or until the webview is destroyed, which releases
   * them unanswered.
   *
   * The handler may replace or clear itself, or destroy the webview, from
   * inside its own call. A destroyed webview throws
   * `WEBVIEW_ERROR_INVALID_STATE` (code -3).
   */
  setRequestHandler(handler: RequestHandler | null) {
    const engine = this.#live("webview_set_request_handler");
    if (!handler) {
      check("webview_set_request_handler", engine.setRequestHandler(null));
      return;
    }
    check(
      "webview_set_request_handler",
      engine.setRequestHandler((raw) => {
        // Destroyed from inside an earlier call: the native side releases the request.
        if (!this.#engine) return;
        let request: WebviewRequest;
        try {
          request = {
            id: raw.id,
            method: raw.method,
            url: raw.url,
            headers: raw.headersJson ? JSON.parse(raw.headersJson) : [],
            // A copy in a buffer of JavaScript's own: the bytes native code hands over
            // sit in a buffer that cannot be transferred to a Worker.
            body: raw.body ? new Uint8Array(raw.body) : null,
          };
        } catch {
          this.#completeQuietly(raw.id, { status: 500 });
          return;
        }
        let result: ReturnType<RequestHandler>;
        try {
          result = handler(request);
        } catch (err) {
          reportCallbackError("webview.setRequestHandler", err, null);
          this.#completeQuietly(request.id, { status: 500 });
          return;
        }
        // As the main branch: a Promise is awaited, through its own `then`, and anything else
        // that is truthy (a thenable that is no Promise included) is the response. The checks are
        // part of the call: a value whose `instanceof` or `then` throws fails it, as a handler
        // that throws does, with 500.
        try {
          if (result instanceof Promise) {
            result.then(
              (response) => {
                if (response) this.#completeQuietly(request.id, response);
              },
              (err: unknown) => {
                reportCallbackError("webview.setRequestHandler", err, null);
                this.#completeQuietly(request.id, { status: 500 });
              },
            );
          } else if (result) {
            this.#completeQuietly(request.id, result);
          }
        } catch (err) {
          // The main branch let this escape to the binding's own catch, which printed
          // `sweetview: a request handler threw:` and answered 500: with no listener told it still
          // does. Told, it is not handed on: one report, of this kind.
          if (!reportCallbackError("webview.setRequestHandler", err, null)) throw err;
          this.#completeQuietly(request.id, { status: 500 });
        }
      }),
    );
  }

  /**
   * Answers a request handed to the {@link Webview.setRequestHandler request handler}.
   * Safe to call after the handler returned. Completing a request twice, or
   * one the browser has since cancelled, does nothing. A response refused
   * here leaves the request open, so it can still be answered.
   *
   * @throws {WebviewError} Bad headers, a status outside 100-599, a body over
   * 4 GiB - 1, or a webview already destroyed (`WEBVIEW_ERROR_INVALID_STATE`, code -3).
   */
  completeRequest(id: bigint, response: WebviewResponse = {}) {
    // Read once: the value checked is the value sent, even from a getter.
    const status = response.status ?? 200;
    checkStatus("webview_complete_request", status);
    if (this.#handle === null) throw new WebviewError("webview_complete_request", -3);
    completeWebviewRequest(this.#handle, id, { ...response, status });
  }

  /** Starts a streamed answer to a request; see {@link beginWebviewResponse}, which a `Worker` calls with {@link Webview.unsafeHandle}. */
  beginResponse(id: bigint, head: WebviewResponseHead = {}) {
    const status = head.status ?? 200;
    checkStatus("webview_begin_response", status);
    beginWebviewResponse(this.#liveHandle("webview_begin_response"), id, { ...head, status });
  }

  /** Appends a body chunk; see {@link writeWebviewResponseChunk}. */
  writeResponseChunk(id: bigint, chunk: Uint8Array | ArrayBuffer | string) {
    writeWebviewResponseChunk(this.#liveHandle("webview_write_response_chunk"), id, chunk);
  }

  /** Ends a streamed answer; see {@link endWebviewResponse}. */
  endResponse(id: bigint) {
    endWebviewResponse(this.#liveHandle("webview_end_response"), id);
  }

  #liveHandle(fn: string): WebviewHandle {
    if (this.#handle === null) throw new WebviewError(fn, -3);
    return this.#handle;
  }

  /**
   * Receives the real filesystem paths of files dropped on the webview from
   * the operating system (Explorer, Finder). While a handler is set, a file
   * drop the platform captures is taken from the page: the browser does not
   * open the dropped file, and the handler gets every path. Drags inside the
   * page, and drags that carry no files, are untouched. Pass `null` to hand
   * drops back to the page.
   *
   * The handler needs external drops allowed (see
   * {@link Webview.setAllowExternalDrop}) and runs after the operating
   * system's drop event has returned, so it may clear or replace itself, open
   * a dialog, or {@link Webview.destroy} the webview. It never gets an empty
   * list. Windows: drops are captured only on the top-level document
   * (WebView2 Runtime 113 or later).
   *
   * @throws {WebviewError} The platform refused the change; the previous
   * handler stays in place. A destroyed webview throws
   * `WEBVIEW_ERROR_INVALID_STATE` (code -3).
   */
  setFileDropHandler(handler: FileDropHandler | null) {
    const engine = this.#live("webview_set_file_drop_handler");
    if (!handler) {
      check("webview_set_file_drop_handler", engine.setFileDropHandler(null));
      return;
    }
    check(
      "webview_set_file_drop_handler",
      engine.setFileDropHandler((paths) => {
        // Destroyed from inside an earlier call.
        if (!this.#engine) return;
        try {
          handler(paths);
        } catch (err) {
          // Printed nowhere, as before; told to an onCallbackError listener.
          reportCallbackError("webview.setFileDropHandler", err, null);
        }
      }),
    );
  }

  // For responses produced from the handler: a bad response becomes a 500
  // rather than an exception thrown into the native callback.
  #completeQuietly(id: bigint, response: WebviewResponse) {
    try {
      this.completeRequest(id, response);
    } catch {
      try {
        this.completeRequest(id, { status: 500 });
      } catch {
        // The webview is gone; nothing to answer.
      }
    }
  }

  /**
   * Sets whether files and other content dragged from outside the app can be
   * dropped on the page. Allowed by default. Drags that start inside the page
   * keep working either way. A {@link Webview.setFileDropHandler file drop
   * handler} receives drops only while external drops are allowed.
   *
   * @throws {WebviewError} The platform refused the change (a WebView2
   * Runtime without `AllowExternalDrop` throws `WEBVIEW_ERROR_UNSPECIFIED`, code -1).
   */
  setAllowExternalDrop(allow: boolean) {
    check("webview_set_allow_external_drop", this.#live("webview_set_allow_external_drop").setAllowExternalDrop(allow));
  }

  /**
   * Sets the color the browser paints behind the page, each channel an
   * integer from 0 to 255. With `a` 0 and a page whose own background is
   * transparent, the native window shows through.
   *
   * Windows: WebView2 takes only `a` of 0 or 255; any other alpha is refused
   * (`WEBVIEW_ERROR_UNSPECIFIED`, code -1). For true transparency the host
   * window also needs DWM composition that honors alpha.
   *
   * @throws {WebviewError} A channel that is not an integer from 0 to 255
   * (`WEBVIEW_ERROR_INVALID_ARGUMENT`, code -2), or the platform's own error.
   */
  setBackgroundColor(r: number, g: number, b: number, a: number) {
    for (const channel of [r, g, b, a]) {
      if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw new WebviewError("webview_set_background_color", -2);
      }
    }
    check("webview_set_background_color", this.#live("webview_set_background_color").setBackgroundColor(r, g, b, a));
  }

  /**
   * Runs the main event loop until it is terminated or, for a webview with a
   * window of its own, that window is closed. When this returns the webview
   * is destroyed.
   */
  run() {
    if (!this.#engine) return;
    this.#running = true;
    try {
      this.#engine.run();
    } finally {
      this.#running = false;
      this.destroy();
    }
  }

  /**
   * Binds a callback so that it appears in the page under the given name as
   * a global async function. The callback receives `seq`, to answer with
   * {@link Webview.return}, and `req`, the JSON text of the array of
   * arguments the page passed.
   *
   * @param name The name of the bound function
   * @param callback Called with `seq`, `req` and the `arg` given here
   * @param arg A value handed back to the callback on every call
   * @throws {WebviewError} A name already bound (`WEBVIEW_ERROR_DUPLICATE`,
   * code 1); the existing binding is left untouched.
   */
  bindRaw<A = null>(name: string, callback: (seq: string, req: string, arg: A) => void, arg: A = null as A) {
    const engine = this.#live("webview_bind");
    check(
      "webview_bind",
      engine.bind(name, (seq, req) => {
        // Destroyed from inside an earlier call.
        if (!this.#engine) return;
        callback(seq, req, arg);
      }),
    );
  }

  /**
   * Binds a callback so that it appears in the page under the given name as
   * a global async function. Arguments are converted from JSON, and the
   * return value is converted to JSON and returned to the page.
   *
   * Bindings are reachable from the top-level document only.
   *
   * Results, errors and promises: `undefined` (or nothing) resolves the
   * page's call with `undefined`. A callback that throws, or whose arguments
   * are not valid JSON, rejects the page's call: an `Error` arrives as its
   * `message` string, other values as their JSON (or their `String()` form
   * when they have none). A returned promise (or thenable) settles the
   * page's call the same way. A result JSON cannot represent (a cycle, a
   * BigInt) rejects the call. Promises settle only when the thread's event
   * loop turns, which {@link Webview.run} blocks; keep bindings synchronous,
   * or hand the work to a `Worker`.
   */
  bind(name: string, callback: (...args: any) => any) {
    this.bindRaw(name, (seq, req) => {
      // Every path ends in exactly one return, so the page's call always settles.
      let settled = false;
      const reply = (status: number, json: string) => {
        if (settled) return;
        settled = true;
        // Destroyed while a promise was pending: nothing to answer.
        if (!this.#engine) return;
        this.return(seq, status, json);
      };
      // What reading a thrown value for the page threw, the first time (see serializeBindingError).
      let readFailure: { error: unknown } | undefined;
      const reject = (err: unknown) => reply(1, serializeBindingError(err, (error) => void (readFailure ??= { error })));
      const fulfill = (value: unknown) => {
        let json: string | undefined;
        try {
          json = value === undefined ? "" : JSON.stringify(value);
        } catch (err) {
          reject(err);
          return;
        }
        // "" is the page's undefined; JSON.stringify gives undefined for a function or a symbol.
        reply(0, json ?? "");
      };
      // The bound function's own failure (it throws, or its promise rejects) is told to an
      // onCallbackError listener and rejects the page's call; an unreadable request only rejects.
      // Reported first, as every catch of the package does: the reply's text reads the value
      // (its `message`, its `toJSON`), which can add or remove a listener.
      // With no listener, and when the call failed while this callback runs, a read of the thrown
      // value that threw leaves it for the binding's own catch, after the page's call was
      // rejected: the main branch printed `sweetview: a binding threw:` for it there.
      const failed = (err: unknown, synchronous = false) => {
        const told = reportCallbackError("webview.bind", err, null, name);
        reject(err);
        if (!told && synchronous && readFailure) throw readFailure.error;
      };
      let args: unknown[];
      try {
        args = JSON.parse(req);
      } catch (err) {
        reject(err);
        return;
      }
      let result: unknown;
      try {
        result = callback(...args);
      } catch (err) {
        failed(err, true);
        return;
      }
      let fulfilledNow = false;
      try {
        // As the main branch: a value whose `then` is a function is awaited. Reading `then` is
        // part of the call: a getter that throws fails it, and the page's call is rejected.
        if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as PromiseLike<unknown>).then === "function") {
          Promise.resolve(result as PromiseLike<unknown>).then(fulfill, (err: unknown) => failed(err));
        } else {
          fulfill(result);
          fulfilledNow = true;
        }
      } catch (err) {
        failed(err, true);
        return;
      }
      // A value returned now whose JSON throws a value that cannot be read: rejected, and, as on
      // the main branch, what the read threw leaves for the binding's own catch (no listener is
      // told of a value's JSON either way).
      if (fulfilledNow && readFailure) throw readFailure.error;
    });
  }

  /**
   * Unbinds a previously bound function and removes it from the page.
   *
   * @throws {WebviewError} A name that is not bound (`WEBVIEW_ERROR_NOT_FOUND`, code 2).
   */
  unbind(name: string) {
    check("webview_unbind", this.#live("webview_unbind").unbind(name));
  }

  /**
   * Returns a value to the page for the call `seq`.
   *
   * @param seq The `seq` given to the {@link Webview.bindRaw} callback
   * @param status Zero resolves the page's promise with `result`; anything else rejects it
   * @param result JSON text; the empty string is `undefined`
   */
  return(seq: string, status: number, result: string) {
    this.#engine?.returnValue(seq, status, result);
  }

  /**
   * Evaluates arbitrary JavaScript in the current page. Asynchronous; the
   * result is discarded. Run it after the page has loaded, or it is dropped.
   */
  eval(source: string) {
    this.#engine?.eval(source);
  }

  /**
   * Injects JavaScript that runs at the start of every page the webview
   * opens, before `window.onload`. Windows runs it in every frame's
   * document, `<iframe>`s included; guard code that belongs to the top-level
   * document with `if (window === window.top)`.
   */
  init(source: string) {
    this.#engine?.init(source);
  }
}
