import { describe, expect, spyOn, test } from "bun:test";
import { CFunction, FFIType, read, type Pointer } from "bun:ffi";
import { defineAppIdentity } from "@n1h/sweetview-settings";
import { Notifier, type NotificationClick } from "../notifications";

describe.if(process.platform === "win32")("Windows notifier", () => {
  test("registers an AUMID and shows real WinRT toasts with independently routed clicks", async () => {
    const { advapi32, HKEY_CURRENT_USER, wstr } = await import("./api");
    const { pumpEvents } = await import("./event-loop");
    const { createMessageWindow } = await import("./message-window");
    const { ToastEvent, toastXml, WinRtToastNotifier, WM_TOAST_EVENT } = await import("./winrt-toast");
    const appId = `Sweetview.NotifierTest.${crypto.randomUUID()}`;
    const subKey = wstr(`Software\\Classes\\AppUserModelId\\${appId}`);
    const identity = defineAppIdentity({ appId, appName: 'Sweetview <test> & "toast"' });
    const clicks: NotificationClick[] = [];
    const failures: bigint[] = [];
    const fallbacks: string[] = [];
    type EventKind = (typeof ToastEvent)[keyof typeof ToastEvent];
    const handlers = new Map<string, Pointer>();
    let notifier: InstanceType<typeof WinRtToastNotifier> | undefined;
    const window = createMessageWindow((message, cookie, event) => {
      if (message === WM_TOAST_EVENT) {
        if (event === ToastEvent.Failed) failures.push(cookie);
        notifier?.handleEvent(cookie, event);
      }
    });

    function slot(handler: Pointer, index: number): Pointer {
      return read.ptr(read.ptr(handler, 0) as Pointer, index * 8) as Pointer;
    }

    function refCount(handler: Pointer, index: 1 | 2): number {
      const fn = CFunction({ ptr: slot(handler, index), args: [FFIType.ptr], returns: FFIType.u32 });
      try {
        return fn(handler);
      } finally {
        fn.close();
      }
    }

    class ObservedNotifier extends WinRtToastNotifier {
      protected override createHandler(cookie: bigint, event: EventKind): Pointer {
        const handler = super.createHandler(cookie, event);
        refCount(handler, 1); // Keep a reference for this test through disposal.
        handlers.set(`${cookie}:${event}`, handler);
        return handler;
      }
    }

    // Drive the actual subscribed COM delegates without relying on banner
    // visibility, shell settings or user interaction.
    function invoke(cookie: bigint, event: EventKind): void {
      const handler = handlers.get(`${cookie}:${event}`)!;
      const callback = CFunction({
        ptr: slot(handler, 3),
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      });
      try {
        expect(callback(handler, null, null)).toBe(0);
      } finally {
        callback.close();
      }
    }

    try {
      const notification = { title: '<Title> & "quotes"', body: "It’s <body> & 'more'", silent: true };
      const first = { id: 'first<&>"', data: { index: 1 } };
      const second = { id: "second", data: ["different", 2] };
      expect(toastXml(notification, first.id)).toBe(
        '<toast launch="first&lt;&amp;&gt;&quot;"><visual><binding template="ToastGeneric">' +
        '<text>&lt;Title&gt; &amp; &quot;quotes&quot;</text><text>It’s &lt;body&gt; &amp; &apos;more&apos;</text>' +
        '</binding></visual><audio silent="true"/></toast>',
      );
      expect(toastXml({ title: "Sound on" }, "audible")).not.toContain("<audio");
      notifier = new ObservedNotifier(window.hwnd, { identity, onClick: (click) => clicks.push(click) });
      // These calls check actual IToastNotifier.Show HRESULTs. There is no
      // Shell_NotifyIconW fallback in this test's WinRT notifier.
      const firstCookie = notifier.show(notification, first);
      const secondCookie = notifier.show(notification, second);
      const outstanding = notifier.show(notification, { id: "outstanding", data: null });
      expect(firstCookie).not.toBe(secondCookie);

      const name = new Uint8Array(256);
      const size = new Uint32Array([name.byteLength]);
      expect(advapi32.RegGetValueW(HKEY_CURRENT_USER, subKey, wstr("DisplayName"), 2, null, name, size)).toBe(0);
      expect(Buffer.from(name.subarray(0, size[0]! - 2)).toString("utf16le")).toBe(identity.appName);
      expect(pumpEvents()).toBe(true);
      expect(failures).toEqual([]);

      invoke(secondCookie, ToastEvent.Activated);
      invoke(firstCookie, ToastEvent.Activated);
      invoke(secondCookie, ToastEvent.Activated);
      expect(clicks).toEqual([]);
      expect(pumpEvents()).toBe(true);
      expect(clicks).toEqual([second, first]);

      const failed = notifier.show(notification, { id: "failed", data: null }, () => fallbacks.push("failed"));
      const dismissed = notifier.show(notification, { id: "dismissed", data: null }, () => fallbacks.push("dismissed"));
      invoke(failed, ToastEvent.Failed);
      invoke(failed, ToastEvent.Failed);
      invoke(dismissed, ToastEvent.Dismissed);
      invoke(failed, ToastEvent.Activated);
      invoke(dismissed, ToastEvent.Activated);
      expect(pumpEvents()).toBe(true);
      expect(clicks).toEqual([second, first]);
      expect(fallbacks).toEqual(["failed"]);

      notifier.dispose();
      notifier.dispose();
      invoke(outstanding, ToastEvent.Activated);
      expect(pumpEvents()).toBe(true);
      expect(clicks).toEqual([second, first]);
    } finally {
      try {
        notifier?.dispose();
      } finally {
        try {
          // Removing the WinRT subscriptions must leave the test's reference
          // as the last owner of every registered delegate.
          const remaining = [...handlers.values()].map((handler) => refCount(handler, 2));
          expect(remaining.every((refs) => refs === 0)).toBe(true);
        } finally {
          window.destroy();
          const status = advapi32.RegDeleteTreeW(HKEY_CURRENT_USER, subKey);
          expect([0, 2]).toContain(status);
        }
      }
    }
  });

  test("uses the explicit app ID and falls back when WinRT Show fails", async () => {
    const { advapi32, HKEY_CURRENT_USER, shell32, wstr } = await import("./api");
    const { WinRtToastNotifier } = await import("./winrt-toast");
    const appId = `Sweetview.NotifierFallbackTest.${crypto.randomUUID()}`;
    const subKey = wstr(`Software\\Classes\\AppUserModelId\\${appId}`);
    const identity = defineAppIdentity({ appId: "Sweetview.Unused", appName: "Sweetview fallback test" });
    const show = spyOn(WinRtToastNotifier.prototype, "show");
    const balloon = spyOn(shell32, "Shell_NotifyIconW").mockReturnValue(1);
    let notifier: Notifier | undefined;
    try {
      notifier = new Notifier({ appId, identity });
      expect(notifier.notify({ title: "WinRT", silent: true })).toBe(true);
      expect(show).toHaveBeenCalledTimes(1);
      expect(balloon).not.toHaveBeenCalled();
      show.mockImplementationOnce(() => {
        throw new Error("Simulated IToastNotifier.Show failure");
      });
      expect(notifier.notify({ title: "Fallback", silent: true, data: [1] })).toBe(true);
      expect(show).toHaveBeenCalledTimes(2);
      expect(balloon.mock.calls.map(([command]) => command)).toEqual([0]); // NIM_ADD
      expect(advapi32.RegGetValueW(HKEY_CURRENT_USER, subKey, wstr("DisplayName"), 2, null, null, new Uint32Array(1))).toBe(0);
      notifier.dispose();
      expect(balloon.mock.calls.map(([command]) => command)).toEqual([0, 2]); // NIM_ADD, NIM_DELETE
      expect(notifier.notify({ title: "Disposed" })).toBe(false);
    } finally {
      try {
        notifier?.dispose();
      } finally {
        show.mockRestore();
        balloon.mockRestore();
        const status = advapi32.RegDeleteTreeW(HKEY_CURRENT_USER, subKey);
        expect([0, 2]).toContain(status);
      }
    }
  });
});
