// What the Windows tab driver asks of a tab's webview beyond the `RawWebview`
// class: visibility, focus, position sync, accelerator keys, new-window
// interception, failed navigations and DevTools commands. Each is a typed call
// on the Rust engine; the hand-built COM vtables this file once held are gone.
// Lives in src/tabs/ (webview layer), never in the native package.

import type { RawWebview } from "@n1h/sweetview-native";
import { engineOf, reportCallbackError, type NativeEngine } from "@n1h/sweetview-native/internal";
import type { Key } from "@n1h/sweetview-native/win32/shortcuts";

/** A live webview's engine: what the tab driver holds for as long as the tab's webview exists. */
export type Controller = NativeEngine;

/** The engine of a webview the library made. Throws when the webview is destroyed. */
export function controllerOf(webview: RawWebview): Controller {
  const engine = engineOf(webview);
  if (!engine) throw new Error("sweetview: the webview has no browser controller");
  return engine;
}

export function setVisible(controller: Controller, visible: boolean): void {
  controller.setVisible(visible);
}

/** Gives the page the keyboard focus. */
export function moveFocus(controller: Controller): void {
  controller.moveFocus();
}

/** Tells the webview its window moved, so open popups follow. */
export function notifyMoved(controller: Controller): void {
  controller.notifyMoved();
}

const failed = (what: string, code: number) => new Error(`sweetview: ${what} failed (${code})`);

/** Handles accelerator keys the page would see; the returned function removes the handler. */
export function onAcceleratorKey(controller: Controller, taken: (key: Key) => boolean): () => void {
  const code = controller.onAcceleratorKey((key) => {
    try {
      return taken(key) === true;
    } catch (err) {
      reportCallbackError("internal", err, "sweetview: an accelerator key handler threw:");
      return false;
    }
  });
  if (code !== 0) throw failed("add_AcceleratorKeyPressed", code);
  return () => {
    if (!controller.destroyed) controller.onAcceleratorKey(null);
  };
}

/** Calls `opened` (on a later tick) instead of opening a window for each new-window request; the returned function removes the handler. */
export function onNewWindowRequested(controller: Controller, opened: (address: string) => void): () => void {
  controller.onNewWindowRequested((address) => {
    try {
      opened(address);
    } catch (err) {
      reportCallbackError("internal", err, "sweetview: a new-window handler threw:");
    }
  });
  return () => {
    if (!controller.destroyed) controller.onNewWindowRequested(null);
  };
}

export type NavigationFailure = {
  /** The address the failed navigation was loading (its last redirect target). */
  readonly url: string;
  readonly reason: string;
  /** False once a newer navigation has started; a page shown for this failure must not replace that navigation. */
  isCurrent(): boolean;
};

/**
 * Calls `onFailed` when the webview's latest top-level navigation fails
 * without a response. Navigations cancelled by a newer one, aborted ones
 * (which a navigation that becomes a download also reports), HTTP error
 * responses (the server's own error page is shown), `about:`/`data:` loads,
 * and navigations a newer one already superseded are not reported. Register
 * this before the first `navigate` to catch an initial navigation that fails
 * at once. The returned function removes the handler; call it before the
 * webview is destroyed.
 *
 * The engine knows the host's navigation intent itself: every `navigate` and
 * `setHTML` on the webview counts, so a failure is reported only while no
 * host navigation was issued after it started. `hostNavEpoch`, when given, is
 * read as well for `isCurrent()` after the report.
 */
export function onNavigationFailed(
  controller: Controller,
  onFailed: (failure: NavigationFailure) => void,
  hostNavEpoch?: () => number,
): () => void {
  const code = controller.onNavigationFailed((url, reason) => {
    const epoch = hostNavEpoch?.();
    try {
      onFailed({ url, reason, isCurrent: () => hostNavEpoch === undefined || hostNavEpoch() === epoch });
    } catch (err) {
      reportCallbackError("internal", err, "sweetview: a navigation-failed handler threw:");
    }
  });
  if (code !== 0) throw failed("add_NavigationCompleted", code);
  return () => {
    if (!controller.destroyed) controller.onNavigationFailed(null);
  };
}

/** Sends a DevTools Protocol command to the webview. Throws when the engine refuses it. */
export function devTools(controller: Controller, method: string, params: object): void {
  const code = controller.callDevToolsProtocolMethod(method, JSON.stringify(params));
  if (code !== 0) throw failed(`CallDevToolsProtocolMethod(${method})`, code);
}
