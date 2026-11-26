import { describe, expect, test } from "bun:test";
import { backgroundColorCall, openWebviewCore, setAssetCall, webviewLibPath } from "./webview-lib";

describe("webview-lib caching", () => {
  test("caches core, backgroundColor, and setAsset symbol lookups per libPath", async () => {
    const libPath = await webviewLibPath();
    const core1 = openWebviewCore(libPath);
    const core2 = openWebviewCore(libPath);
    expect(core1).toBe(core2);
    expect(typeof core1.webview_run).toBe("function");
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
