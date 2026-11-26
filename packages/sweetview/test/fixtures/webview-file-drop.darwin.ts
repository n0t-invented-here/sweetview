// macOS counterpart of ./webview-file-drop.ts: Window.onFileDrop listeners
// switch webview_set_file_drop_handler on a live WKWebView, and a file
// dragged from outside the app reaches the listener.
//
// A real Finder drag cannot be made from a test, so the WKWebView's
// NSDraggingDestination methods are called directly with a stand-in
// NSDraggingInfo whose pasteboard holds a real file URL. WKWebView's own drag
// methods are replaced with counting stubs for the run: the library's
// SweetviewWKWebView subclass forwards to them exactly the drags it leaves to
// WebKit, so the counts say who took each drag, and WebKit's real
// implementations never see the stand-in.
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import { join } from "node:path";
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { ID, NIL, type Id, asId, class_addMethod, cls, cstr, nsString, objc_allocateClassPair, objc_registerClassPair, release, sel, send, sendPtr } from "@n1h/sweetview-native/darwin/objc";
import { scheduleNativeTimeout } from "@n1h/sweetview-native/internal";
import { hostedWebView } from "../../src/tabs/darwin-webview";

const { u64, bool } = FFIType;
const runtime = dlopen("/usr/lib/libobjc.A.dylib", {
  class_getInstanceMethod: { args: [u64, u64], returns: u64 },
  method_setImplementation: { args: [u64, FFIType.ptr], returns: u64 },
}).symbols;
// -(BOOL)selector:(id)sender
const sendPtrRetBool = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_msgSend: { args: [u64, u64, u64], returns: bool },
}).symbols.objc_msgSend;

const NSDragOperationCopy = 1n;

// What WebKit itself is handed, by selector.
const webkit: Record<string, number> = {};
const kept: JSCallback[] = [];
for (const [name, returns, value] of [
  ["draggingEntered:", u64, NSDragOperationCopy],
  ["draggingUpdated:", u64, NSDragOperationCopy],
  ["draggingExited:", FFIType.void, undefined],
  ["prepareForDragOperation:", bool, true],
  ["performDragOperation:", bool, true],
] as const) {
  webkit[name] = 0;
  const stub = new JSCallback(
    () => {
      webkit[name]!++;
      return value as never;
    },
    { args: [ID, ID, ID], returns },
  );
  kept.push(stub);
  const method = runtime.class_getInstanceMethod(cls("WKWebView"), sel(name));
  if (!method) throw new Error(`WKWebView does not implement ${name}`);
  runtime.method_setImplementation(method, stub.ptr);
}

/** A stand-in NSDraggingInfo for a drag from another application carrying `pasteboard`. */
function externalDrag(pasteboard: Id, sequence: bigint): Id {
  const className = `SweetviewTestDraggingInfo_${sequence}`;
  const klass = asId(objc_allocateClassPair(cls("NSObject"), cstr(className), 0n));
  if (klass === NIL) throw new Error(`objc_allocateClassPair(${className}) failed`);
  for (const [name, types, value] of [
    ["draggingSequenceNumber", "q@:", sequence],
    ["draggingSource", "@@:", NIL], // nil: the drag began outside this application
    ["draggingSourceOperationMask", "Q@:", NSDragOperationCopy],
    ["draggingPasteboard", "@@:", pasteboard],
  ] as const) {
    const method = new JSCallback(() => value, { args: [ID, ID], returns: u64 });
    kept.push(method);
    if (!class_addMethod(klass, sel(name), method.ptr, cstr(types))) throw new Error(`class_addMethod(${className}, ${name}) failed`);
  }
  objc_registerClassPair(klass);
  return asId(send(asId(send(klass, sel("alloc"))), sel("init")));
}

const path = join(process.env.WEBVIEW2_USER_DATA_FOLDER!, "dropped ü.txt");
await Bun.write(path, "file drop fixture");
// Written as an NSURL, the way Finder does, so the pasteboard server issues
// the file's sandbox extension along with its public.file-url string.
const fileUrl = asId(sendPtr(cls("NSURL"), sel("fileURLWithPath:"), nsString(path)));
const pasteboard = asId(send(cls("NSPasteboard"), sel("pasteboardWithUniqueName")));
send(pasteboard, sel("clearContents"));
if (!sendPtrRetBool(pasteboard, sel("writeObjects:"), asId(sendPtr(cls("NSArray"), sel("arrayWithObject:"), fileUrl)))) {
  throw new Error("the test pasteboard refused the file URL");
}

const win = new Window({ title: "WKWebView file drop test", noActivate: true });
const states: boolean[] = [];
let delivered: string[] | undefined;
let timedOut = false;
let off = win.onFileDrop(() => {});

const view = await WebView.attach(win, {
  assets: { "index.html": new Blob(["<!doctype html><html><body>Drop target</body></html>"]) },
});
const webView = hostedWebView(asId(win.handle as bigint));
if (webView === undefined) throw new Error("no WKWebView in the window");

let sequence = 100n;
/** True when a new external file drag over the webview is taken by the file drop handler rather than handed to WebKit. */
function handlerTakesDrag(): boolean {
  const info = externalDrag(pasteboard, ++sequence);
  try {
    const before = webkit["draggingEntered:"]!;
    const operation = asId(sendPtr(webView!, sel("draggingEntered:"), info));
    const taken = operation === NSDragOperationCopy && webkit["draggingEntered:"] === before;
    sendPtr(webView!, sel("draggingExited:"), info);
    return taken;
  } finally {
    release(info);
  }
}

// One listener; a second listener replacing the first; none; one again.
states.push(handlerTakesDrag());
const second = win.onFileDrop(() => {});
off();
off = second;
states.push(handlerTakesDrag());
off();
states.push(handlerTakesDrag());
off = win.onFileDrop((paths) => {
  delivered = paths;
  view.quit();
});
states.push(handlerTakesDrag());

// The whole drop: the paths are read during performDragOperation: and the
// listener runs afterwards, from the run loop inside run().
const drop = externalDrag(pasteboard, ++sequence);
const webkitBeforeDrop = { ...webkit };
const dropSteps = {
  entered: asId(sendPtr(webView, sel("draggingEntered:"), drop)) === NSDragOperationCopy,
  updated: asId(sendPtr(webView, sel("draggingUpdated:"), drop)) === NSDragOperationCopy,
  prepared: Boolean(sendPtrRetBool(webView, sel("prepareForDragOperation:"), drop)),
  performed: Boolean(sendPtrRetBool(webView, sel("performDragOperation:"), drop)),
  deliveredInsidePerform: delivered !== undefined,
};
sendPtr(webView, sel("draggingEnded:"), drop);
const webkitSawDrop = Object.keys(webkit).some((name) => webkit[name] !== webkitBeforeDrop[name]);

const stopTimer = scheduleNativeTimeout(8000, () => {
  timedOut = true;
  view.quit();
});
try {
  win.show();
  view.run(); // Destroys the view with its final drop listener still installed.
  off();
  win.onFileDrop(() => {})();
  console.log("RESULT " + JSON.stringify({
    timedOut,
    report: { states, dropSteps, webkitSawDrop, delivered, path, disposed: view.raw.unsafeHandle === null },
  }));
} finally {
  stopTimer();
  release(drop);
  send(pasteboard, sel("releaseGlobally"));
  view.dispose();
  win.dispose();
}
