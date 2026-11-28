// What a WebView's `window` is on the object, made without a webview: its own keys, whether
// `window` is an own property, whether an object spread of it carries `window`, and whether it
// names the window it was made with. For the macOS seam test (review round 5, R5-6).

export function webviewWindowShape(app: { WebView: unknown }): { keys: string[]; own: boolean; spread: boolean; isTheWindow: boolean } {
  const window = { name: "the window" };
  const noop = () => {};
  // The constructor is private: reached as the class the module exports, with stand-in parts.
  const WebViewClass = app.WebView as new (parts: Record<string, unknown>) => Record<string, unknown>;
  const view = new WebViewClass({ raw: {}, window: () => window, emit: noop, notify: noop, onEvent: () => noop, run: noop, quit: noop, dispose: noop });
  return { keys: Object.keys(view), own: Object.hasOwn(view, "window"), spread: "window" in { ...view }, isTheWindow: view.window === window };
}
