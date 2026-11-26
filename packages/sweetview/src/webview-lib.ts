// sweetview runs on the webview library that @n1h/sweetview-webview-bun ships:
// upstream webview/webview plus the Sweetview additions in docs/webview-library.md.
// webview-bun loads it from its build/ folder; `bun build --compile` embeds
// that file. Optional symbols are probed at first use.
//
// All dlopen() calls are cached per libPath so repeated window/tab creation
// never leaks open shared-library handles.

import { FFIType, dlopen, ptr, type Pointer } from "bun:ffi";

/** The path webview-bun loads its native library from, resolved the same way it does, so the worker can dlopen the same file (it needs webview_dispatch). */
export async function webviewLibPath(): Promise<string> {
  if (process.env.WEBVIEW_PATH) return process.env.WEBVIEW_PATH;
  switch (process.platform) {
    case "win32":
      //@ts-expect-error file import
      return (await import("@n1h/sweetview-webview-bun/build/libwebview.dll")).default;
    case "darwin":
      //@ts-expect-error file import
      return (await import("@n1h/sweetview-webview-bun/build/libwebview.dylib")).default;
    case "linux":
      if (process.arch !== "x64") throw new Error(`sweetview: @n1h/sweetview-webview-bun ships no library for linux ${process.arch} (x64 only); set WEBVIEW_PATH to one you built`);
      //@ts-expect-error file import
      return (await import("@n1h/sweetview-webview-bun/build/libwebview-x64.so")).default;
    default:
      throw new Error(`sweetview: ${process.platform} is not supported (win32, darwin and linux x64 are)`);
  }
}

export type SetBackgroundColor = (w: Pointer, r: number, g: number, b: number, a: number) => number;
export type SetAsset = (w: Pointer, path: string, mime: string, data: Uint8Array) => number;

export type WebviewCoreSymbols = {
  webview_terminate: (w: Pointer) => number;
  webview_run: (w: Pointer) => number;
  webview_dispatch: (w: Pointer, fn: Pointer, arg: bigint) => number;
  webview_get_native_handle: (w: Pointer, kind: number) => Pointer | null;
};

type CachedLib = {
  core?: WebviewCoreSymbols;
  backgroundColor?: SetBackgroundColor | null;
  setAsset?: SetAsset | null;
  requestHandler?: ReturnType<typeof openRequestHandler> | null;
  allowExternalDrop?: ReturnType<typeof openExternalDrop> | null;
  streamingResponse?: ReturnType<typeof openStreamingResponse> | null;
  fileDropHandler?: ReturnType<typeof openFileDropHandler> | null;
};

const cache = new Map<string, CachedLib>();

function entry(libPath: string): CachedLib {
  let c = cache.get(libPath);
  if (!c) {
    c = {};
    cache.set(libPath, c);
  }
  return c;
}

/** Cached core webview C symbols. */
export function openWebviewCore(libPath: string): WebviewCoreSymbols {
  const c = entry(libPath);
  if (c.core) return c.core;
  const lib = dlopen(libPath, {
    webview_terminate: { args: [FFIType.ptr], returns: FFIType.i32 },
    webview_run: { args: [FFIType.ptr], returns: FFIType.i32 },
    // The opaque void* argument carries an integer token and is never dereferenced.
    webview_dispatch: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    webview_get_native_handle: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  });
  c.core = {
    webview_terminate: lib.symbols.webview_terminate as (w: Pointer) => number,
    webview_run: lib.symbols.webview_run as (w: Pointer) => number,
    webview_dispatch: lib.symbols.webview_dispatch as WebviewCoreSymbols["webview_dispatch"],
    webview_get_native_handle: lib.symbols.webview_get_native_handle as (w: Pointer, kind: number) => Pointer | null,
  };
  return c.core;
}

/** The library's `webview_set_background_color`, or undefined when this build does not have it. Cached per `libPath`. */
export function backgroundColorCall(libPath: string): SetBackgroundColor | undefined {
  const c = entry(libPath);
  if (c.backgroundColor !== undefined) return c.backgroundColor ?? undefined;
  try {
    const fn = dlopen(libPath, {
      webview_set_background_color: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols.webview_set_background_color as SetBackgroundColor;
    c.backgroundColor = fn;
    return fn;
  } catch {
    c.backgroundColor = null;
    return undefined;
  }
}

/** The library's `webview_set_asset`, or undefined when this build does not have it. Cached per `libPath`. */
export function setAssetCall(libPath: string): SetAsset | undefined {
  const c = entry(libPath);
  if (c.setAsset !== undefined) return c.setAsset ?? undefined;
  try {
    const { webview_set_asset } = dlopen(libPath, {
      webview_set_asset: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
    // The library copies the bytes, so nothing here needs to outlive the call.
    const fn: SetAsset = (w, path, mime, data) => webview_set_asset(w, cstr(path), cstr(mime), data.byteLength ? ptr(data) : null, BigInt(data.byteLength));
    c.setAsset = fn;
    return fn;
  } catch {
    c.setAsset = null;
    return undefined;
  }
}

/**
 * Where assets are served from, per platform. Windows intercepts
 * http://webview.localhost with WebView2's WebResourceRequested; macOS
 * registers a WKURLSchemeHandler for the "webview" scheme. Relative URLs in
 * the page work the same on both.
 */
export const ASSET_ORIGIN = process.platform === "darwin" ? "webview://localhost" : "http://webview.localhost";

/** The second intercepted origin, for content isolated from the app page. */
export const FRAMES_ORIGIN = process.platform === "darwin" ? "webview-frames://localhost" : "http://frames.webview.localhost";

function openRequestHandler(libPath: string) {
  const { webview_set_request_handler, webview_complete_request } = dlopen(libPath, {
    webview_set_request_handler: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    webview_complete_request: {
      args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  }).symbols;
  return {
    setRequestHandler: webview_set_request_handler,
    completeRequest(w: Pointer, id: bigint, status: number, headersJson: string, body: Uint8Array) {
      return webview_complete_request(
        w, id, status, Buffer.from(`${headersJson}\0`, "utf8"),
        body.byteLength ? body : null, BigInt(body.byteLength),
      );
    },
  };
}

export function requestHandlerCalls(libPath: string) {
  const c = entry(libPath);
  if (c.requestHandler === undefined) {
    try {
      c.requestHandler = openRequestHandler(libPath);
    } catch {
      c.requestHandler = null;
    }
  }
  return c.requestHandler ?? undefined;
}

function openStreamingResponse(libPath: string) {
  const symbols = dlopen(libPath, {
    webview_begin_response: {
      args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    webview_write_response_chunk: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    webview_end_response: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  }).symbols;
  return {
    beginResponse(w: Pointer, id: bigint, status: number, headersJson: string) {
      return symbols.webview_begin_response(w, id, status, Buffer.from(`${headersJson}\0`, "utf8"));
    },
    writeResponseChunk(w: Pointer, id: bigint, chunk: Uint8Array) {
      // Passing the view itself keeps its buffer rooted until the native copy completes.
      return symbols.webview_write_response_chunk(w, id, chunk, BigInt(chunk.byteLength));
    },
    endResponse: symbols.webview_end_response,
  };
}

/** Probe all three streaming symbols together so older libraries can buffer instead. */
export function streamingResponseCalls(libPath: string) {
  const c = entry(libPath);
  if (c.streamingResponse === undefined) {
    try {
      c.streamingResponse = openStreamingResponse(libPath);
    } catch {
      c.streamingResponse = null;
    }
  }
  return c.streamingResponse ?? undefined;
}

function openFileDropHandler(libPath: string) {
  return dlopen(libPath, {
    webview_set_file_drop_handler: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols.webview_set_file_drop_handler;
}

export function fileDropHandlerCall(libPath: string) {
  const c = entry(libPath);
  if (c.fileDropHandler === undefined) {
    try {
      c.fileDropHandler = openFileDropHandler(libPath);
    } catch {
      c.fileDropHandler = null;
    }
  }
  return c.fileDropHandler ?? undefined;
}

function openExternalDrop(libPath: string) {
  return dlopen(libPath, {
    webview_set_allow_external_drop: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  }).symbols.webview_set_allow_external_drop;
}

export function allowExternalDropCall(libPath: string) {
  const c = entry(libPath);
  if (c.allowExternalDrop === undefined) {
    try {
      c.allowExternalDrop = openExternalDrop(libPath);
    } catch {
      console.warn("sweetview: allowExternalDrop requires webview_set_allow_external_drop from @n1h/sweetview-webview-bun >= 2.8.0 or a compatible WEBVIEW_PATH");
      c.allowExternalDrop = null;
    }
  }
  return c.allowExternalDrop ?? undefined;
}
