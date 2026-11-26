import { NIL, asId, cls, jsString, nsString, sel, send, sendPtr, sendPtrPtrRetBool, type Id } from "./objc";

const pasteboard = (): Id => asId(send(cls("NSPasteboard"), sel("generalPasteboard")));
const textType = () => nsString("public.utf8-plain-text");

export function readText(): string | null {
  const value = asId(sendPtr(pasteboard(), sel("stringForType:"), textType()));
  return value === NIL ? null : jsString(value);
}

export function writeText(text: string): void {
  const board = pasteboard();
  send(board, sel("clearContents"));
  if (!sendPtrPtrRetBool(board, sel("setString:forType:"), nsString(text), textType())) {
    throw new Error("sweetview: NSPasteboard could not write text");
  }
}

export function clear(): void {
  send(pasteboard(), sel("clearContents"));
}
