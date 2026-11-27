// Native macOS folder picker: NSOpenPanel through the Objective-C runtime via
// bun:ffi. No child process. Must run on the main thread (AppKit rule), which
// the webview UI thread is. See objc.ts for the id-as-bigint rule.

import type { WindowHandle } from "../window";
import { NIL, asId, cls, jsString, nsString, sel, send, sendBool, sendInt, sendPtr, sharedApp } from "./objc";

const NSModalResponseOK = 1n;

/** Opens NSOpenPanel in folder mode (app-modal; `owner` is not used). Returns the POSIX path, or null if cancelled. */
export function pickFolder(_owner: WindowHandle, title: string): string | null {
  sendBool(sharedApp(), sel("activateIgnoringOtherApps:"), true);

  const panel = asId(send(cls("NSOpenPanel"), sel("openPanel")));
  if (panel === NIL) throw new Error("NSOpenPanel.openPanel returned nil");
  sendBool(panel, sel("setCanChooseDirectories:"), true);
  sendBool(panel, sel("setCanChooseFiles:"), false);
  sendBool(panel, sel("setAllowsMultipleSelection:"), false);
  sendBool(panel, sel("setCanCreateDirectories:"), true);
  sendPtr(panel, sel("setMessage:"), nsString(title));
  sendPtr(panel, sel("setPrompt:"), nsString("Choose"));

  if (BigInt(sendInt(panel, sel("runModal")) ?? 0) !== NSModalResponseOK) return null;

  const url = asId(send(asId(send(panel, sel("URLs"))), sel("firstObject")));
  if (url === NIL) return null;
  const path = asId(send(url, sel("path")));
  return path === NIL ? null : jsString(path);
}
