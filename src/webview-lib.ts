// sweetview runs on the webview library that @n1h/sweetview-webview-bun ships:
// upstream webview/webview plus `webview_set_background_color` and
// `webview_set_asset` (see ../docs/webview-library.md). webview-bun loads it from
// its own build/ folder; `bun build --compile` embeds that file. The two extra
// symbols are probed here at run time rather than assumed: without
// webview_set_background_color the page stays opaque with a warning; without
// webview_set_asset createWebviewApp throws, because the page cannot load.

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
    default:
      return (await import(`@n1h/sweetview-webview-bun/build/libwebview-${process.arch}.so`)).default;
  }
}

export type SetBackgroundColor = (w: Pointer, r: number, g: number, b: number, a: number) => number;
export type SetAsset = (w: Pointer, path: string, mime: string, data: Uint8Array) => number;

/** The library's `webview_set_background_color`, or undefined when this build does not have it. */
export function backgroundColorCall(libPath: string): SetBackgroundColor | undefined {
  try {
    return dlopen(libPath, {
      webview_set_background_color: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols.webview_set_background_color as SetBackgroundColor;
  } catch {
    return undefined;
  }
}

/** The library's `webview_set_asset`, or undefined when this build does not have it. */
export function setAssetCall(libPath: string): SetAsset | undefined {
  try {
    const { webview_set_asset } = dlopen(libPath, {
      webview_set_asset: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
    // The library copies the bytes, so nothing here needs to outlive the call.
    return (w, path, mime, data) => webview_set_asset(w, cstr(path), cstr(mime), data.byteLength ? ptr(data) : null, BigInt(data.byteLength));
  } catch {
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
