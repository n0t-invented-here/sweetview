import { describe, expect, test } from "bun:test";
import { ASSET_ORIGIN, FRAMES_ORIGIN } from "./webview-lib";

describe("webview origins", () => {
  test("the asset and frames origins are this platform's, and differ", () => {
    if (process.platform === "darwin") {
      expect(ASSET_ORIGIN).toBe("webview://localhost");
      expect(FRAMES_ORIGIN).toBe("webview-frames://localhost");
    } else {
      expect(ASSET_ORIGIN).toBe("http://webview.localhost");
      expect(FRAMES_ORIGIN).toBe("http://frames.webview.localhost");
    }
    expect(ASSET_ORIGIN).not.toBe(FRAMES_ORIGIN);
  });
});

// macOS runs on the webview library until the macOS goal: its symbol lookups stay cached per library path.
describe.if(process.platform === "darwin")("webview library symbol caching (macOS)", () => {
  test("caches core, backgroundColor, and setAsset symbol lookups per libPath", async () => {
    const { backgroundColorCall, openWebviewCore, setAssetCall, webviewLibPath } = await import("./darwin-webview-lib");
    const libPath = await webviewLibPath();
    const core1 = openWebviewCore(libPath);
    const core2 = openWebviewCore(libPath);
    expect(core1).toBe(core2);
    expect(typeof core1.webview_run).toBe("function");
    expect(typeof core1.webview_dispatch).toBe("function");
    expect(typeof core1.webview_terminate).toBe("function");
    expect(typeof core1.webview_get_native_handle).toBe("function");

    const bg1 = backgroundColorCall(libPath);
    const bg2 = backgroundColorCall(libPath);
    expect(bg1).toBe(bg2);

    const asset1 = setAssetCall(libPath);
    const asset2 = setAssetCall(libPath);
    expect(asset1).toBe(asset2);
    expect(typeof asset1).toBe("function");
  });
});
