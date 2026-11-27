// macOS only, until the macOS goal of the Rust rewrite replaces it: the webview is the
// library of @n1h/sweetview-webview-bun, and `../webview.ts` hands every call to it.
// The handle that names a webview is the library's pointer here; it travels as a number.

import { library } from "./library";
import type { Size, WebviewResponse, WebviewResponseHead } from "../webview";
import type { WindowHandle } from "../types";

type AnyThread<Args extends unknown[]> = (handle: number, id: bigint, ...rest: Args) => void;

export const Webview = library.Webview as unknown as new (
  debugOrHandle?: boolean | number,
  size?: Size,
  window?: WindowHandle,
) => object;
export const completeWebviewRequest = library.completeWebviewRequest as unknown as AnyThread<[response?: WebviewResponse]>;
export const beginWebviewResponse = library.beginWebviewResponse as unknown as AnyThread<[head?: WebviewResponseHead]>;
export const writeWebviewResponseChunk = library.writeWebviewResponseChunk as unknown as AnyThread<[chunk: Uint8Array | ArrayBuffer | string]>;
export const endWebviewResponse = library.endWebviewResponse as unknown as AnyThread<[]>;
export const unload = library.unload as () => void;
