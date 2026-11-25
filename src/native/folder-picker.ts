// The OS folder dialog (IFileOpenDialog on Windows, NSOpenPanel on macOS).

import { backend } from "./platform";
import { unwrapHandle, type WindowHandle, type WindowRef } from "./types";

type Backend = { pickFolder(owner: WindowHandle, title: string): string | null };
const impl = backend<Backend>(
  () => require("./win32/folder-picker"),
  () => require("./darwin/folder-picker"),
);

/** Modal. Blocks until the user picks or cancels. Returns the absolute path, or null when cancelled. */
export function pickFolder(owner: WindowRef | null, title: string): string | null {
  return impl().pickFolder(unwrapHandle(owner), title);
}
