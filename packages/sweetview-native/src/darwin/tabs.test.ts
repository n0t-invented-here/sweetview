// Live AppKit tests for the macOS tab-window primitives. macOS only.

import { expect, test } from "bun:test";

test.if(process.platform === "darwin")("noActivate select() moves current() even when no tab window is key", async () => {
  const { createWindowTabs } = await import("./tabs");
  const tabs = createWindowTabs({
    identifier: `dev.sweetview.test.tabs.${crypto.randomUUID()}`,
    width: 640,
    height: 480,
    noActivate: true,
    onNewTabRequest() {},
    onClosed() {},
  });
  try {
    const first = tabs.createWindow("First");
    tabs.show(first);
    const second = tabs.createWindow("Second");
    tabs.show(second);
    expect(tabs.count()).toBe(2);
    expect(tabs.current()).toBe(second);

    tabs.select(first);
    expect(tabs.current()).toBe(first);

    tabs.select(second);
    expect(tabs.current()).toBe(second);
  } finally {
    tabs.dispose();
  }
});
