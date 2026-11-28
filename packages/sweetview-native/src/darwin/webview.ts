// macOS only, until the macOS goal of the Rust rewrite replaces it: the webview is the
// library of @n1h/sweetview-webview-bun, and `raw-webview.ts` of @n1h/sweetview hands every call to it.
// The handle that names a webview is the library's pointer here; it travels as a number.
// Each function reaches the package when called (see ./library), not when this module loads.

import { library } from "./library";

// The shapes `RawWebview` of @n1h/sweetview passes, as the library takes them.
type Size = { width: number; height: number; hint: number };
type WebviewResponse = object;
type WebviewResponseHead = object;
import type { WindowHandle } from "../types";

type AnyThread<Args extends unknown[]> = (handle: number, id: bigint, ...rest: Args) => void;
type LibraryWebview = new (debugOrHandle?: boolean | number, size?: Size, window?: number | null) => object;

/**
 * The library's `new Webview(...)`. A window handle is passed as a number, the form the library's
 * `webview_create` (an `FFIType.ptr` argument) was given at the tag `pre-rust-rewrite`, where
 * `createApp` passed `Number(handle)`: a macOS `Window`'s handle is a bigint (`asNSWindow`).
 */
export function createWebview(debugOrHandle: boolean | number, size: Size | undefined, window: WindowHandle): object {
  const host = window === null ? null : Number(window);
  return new (library().Webview as LibraryWebview)(debugOrHandle, size, host);
}

const anyThread =
  <Args extends unknown[]>(name: string): AnyThread<Args> =>
  (handle, id, ...rest) =>
    (library()[name] as AnyThread<Args>)(handle, id, ...rest);

export const completeWebviewRequest = anyThread<[response?: WebviewResponse]>("completeWebviewRequest");
export const beginWebviewResponse = anyThread<[head?: WebviewResponseHead]>("beginWebviewResponse");
export const writeWebviewResponseChunk = anyThread<[chunk: Uint8Array | ArrayBuffer | string]>("writeWebviewResponseChunk");
export const endWebviewResponse = anyThread<[]>("endWebviewResponse");
export const unload = (): void => (library().unload as () => void)();
