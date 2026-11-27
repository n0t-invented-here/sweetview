// The origins the webview serves at. Pure constants: no native code is loaded here.

/**
 * Where assets are served from, per platform. Windows intercepts
 * http://webview.localhost with WebView2's WebResourceRequested; macOS
 * registers a WKURLSchemeHandler for the "webview" scheme. Relative URLs in
 * the page work the same on both.
 */
export const ASSET_ORIGIN = process.platform === "darwin" ? "webview://localhost" : "http://webview.localhost";

/** The second intercepted origin, for content isolated from the app page. */
export const FRAMES_ORIGIN = process.platform === "darwin" ? "webview-frames://localhost" : "http://frames.webview.localhost";
