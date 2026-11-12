// Notification-area icon: Shell_NotifyIcon on a hidden message window.
// Right click pops the menu; left double click fires onDoubleClick; a left
// click that is not followed by a second one within GetDoubleClickTime fires
// onClick. The single/double distinction uses a Win32 timer on the message
// window rather than setTimeout, because Bun's event loop does not tick while
// the webview's run loop owns the thread.

import { resolveMenu } from "../menu";
import type { MenuSource } from "../menu";
import { type NotificationClick, type NotificationOptions, notificationId } from "../notifications";
import type { Tray, TrayOptions } from "../tray";
import {
  SM_CXICON,
  WM_APP,
  WM_LBUTTONDBLCLK,
  WM_LBUTTONUP,
  WM_RBUTTONUP,
  WM_TIMER,
  lastError,
  shell32,
  user32,
  wstr,
} from "./api";
import { loadIcon, releaseIcon } from "./icon";
import { popupMenuAtCursor } from "./menu";
import { createMessageWindow } from "./message-window";

const WM_TRAYICON = WM_APP + 1;
const CLICK_TIMER_ID = 1n;

const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIF_MESSAGE = 0x1;
const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const NIF_INFO = 0x10;

// dwInfoFlags
const NIIF_INFO = 0x1;
const NIIF_USER = 0x4;
const NIIF_NOSOUND = 0x10;
const NIIF_LARGE_ICON = 0x20;
const NIIF_RESPECT_QUIET_TIME = 0x80;

// Balloon callbacks in the low word of lParam.
const NIN_BALLOONUSERCLICK = 0x0405;

// NOTIFYICONDATAW, x64, current version (sizeof = 976).
export const NID_SIZE = 976;
export const NID_HWND = 8;
export const NID_UID = 16;
export const NID_FLAGS = 20;
export const NID_CALLBACK = 24;
export const NID_HICON = 32;
export const NID_TIP = 40; // WCHAR[128]
export const NID_INFO = 304; // WCHAR[256]
export const NID_INFO_TITLE = 820; // WCHAR[64]
export const NID_INFO_FLAGS = 948;
export const NID_BALLOON_ICON = 968;

let nextUid = 1;
let taskbarCreated: number | undefined;

/**
 * The Windows tray, as the rest of this folder sees it: the public Tray plus
 * the balloon channel the notifier uses. Not exported from the package.
 */
export interface Win32Tray extends Tray {
  readonly balloon: {
    /** Shows a balloon (a toast on Windows 10/11), replacing the one still showing. False once the tray is disposed or when the shell refuses. */
    show(n: NotificationOptions): boolean;
    /** Called with the newest balloon's id and data: the shell reports only that the balloon was clicked. */
    onClick(fn: ((click: NotificationClick) => void) | undefined): void;
  };
}

let active: Win32Tray | undefined;
/** The most recently created tray that has not been disposed. */
export const currentTray = (): Win32Tray | undefined => active;

/** Copies `value` into a fixed WCHAR[wchars] field, truncated so the NUL still fits. */
const setWide = (nid: Uint8Array, offset: number, value: string, wchars: number) => {
  const bytes = wstr(value);
  nid.set(bytes.subarray(0, Math.min(bytes.length, (wchars - 1) * 2)), offset);
};

export type Balloon = { title: string; body: string; silent: boolean; hIcon: bigint };

/** The NOTIFYICONDATAW for the icon itself, plus a balloon (Windows 10/11 shows it as a toast) when given. */
export function notifyIconData(hwnd: bigint, uid: number, hIcon: bigint, tip: string, balloon?: Balloon): Uint8Array {
  const nid = new Uint8Array(NID_SIZE);
  const dv = new DataView(nid.buffer);
  dv.setUint32(0, NID_SIZE, true);
  dv.setBigUint64(NID_HWND, hwnd, true);
  dv.setUint32(NID_UID, uid, true);
  dv.setUint32(NID_FLAGS, NIF_MESSAGE | NIF_ICON | NIF_TIP | (balloon ? NIF_INFO : 0), true);
  dv.setUint32(NID_CALLBACK, WM_TRAYICON, true);
  dv.setBigUint64(NID_HICON, hIcon, true);
  setWide(nid, NID_TIP, tip, 128);
  if (balloon) {
    setWide(nid, NID_INFO, balloon.body, 256);
    setWide(nid, NID_INFO_TITLE, balloon.title, 64);
    const ownIcon = balloon.hIcon !== 0n;
    let flags = (ownIcon ? NIIF_USER | NIIF_LARGE_ICON : NIIF_INFO) | NIIF_RESPECT_QUIET_TIME;
    if (balloon.silent) flags |= NIIF_NOSOUND;
    dv.setUint32(NID_INFO_FLAGS, flags, true);
    dv.setBigUint64(NID_BALLOON_ICON, balloon.hIcon, true);
  }
  return nid;
}

export function createTray(options: TrayOptions): Win32Tray {
  const uid = nextUid++;
  let icon = loadIcon(options.icon?.windows?.ico);
  let balloonIcon = loadIcon(options.icon?.windows?.ico, SM_CXICON); // toasts want the 32px image
  let tooltip = options.tooltip ?? "";
  let balloonClick: ((click: NotificationClick) => void) | undefined;
  let lastBalloon: NotificationClick | undefined; // the shell shows one balloon per icon, so the click is for this one
  let menu: MenuSource | undefined = options.menu;
  let disposed = false;
  let menuOpen = false;
  // A double click arrives as DOWN, UP, DBLCLK, UP: the trailing UP must not start the single-click timer.
  let swallowNextUp = false;

  taskbarCreated ??= user32.RegisterWindowMessageW(wstr("TaskbarCreated"));

  const window = createMessageWindow((message, wParam, lParam) => {
    if (message === WM_TRAYICON && Number(wParam) === uid) {
      onTrayMessage(Number(lParam) & 0xffff);
    } else if (message === WM_TIMER && wParam === CLICK_TIMER_ID) {
      user32.KillTimer(window.hwnd, CLICK_TIMER_ID);
      options.onClick?.();
    } else if (message === taskbarCreated && !disposed) {
      sync(NIM_ADD); // Explorer restarted and dropped every icon
    }
  });

  const sync = (op: number, balloon?: Balloon) => {
    const nid = notifyIconData(window.hwnd, uid, icon.handle, tooltip, balloon);
    const ok = shell32.Shell_NotifyIconW(op, nid);
    if (!ok && balloon) console.error(`sweetnative: Shell_NotifyIcon balloon failed (${lastError()})`);
    // NIM_ADD fails with ERROR_TIMEOUT while Explorer is still starting (login autostart);
    // the TaskbarCreated broadcast that follows re-adds the icon, so do not throw.
    if (!ok && op === NIM_ADD) console.error(`sweetnative: Shell_NotifyIcon(NIM_ADD) failed (${lastError()}); waiting for TaskbarCreated`);
  };

  const onTrayMessage = (mouse: number) => {
    switch (mouse) {
      case NIN_BALLOONUSERCLICK:
        if (lastBalloon) balloonClick?.(lastBalloon);
        return;
      case WM_RBUTTONUP: {
        if (menuOpen || menu === undefined) return;
        const template = resolveMenu(menu);
        if (template.length === 0) return;
        menuOpen = true;
        try {
          popupMenuAtCursor(window.hwnd, template);
        } finally {
          menuOpen = false;
        }
        return;
      }
      case WM_LBUTTONUP:
        if (swallowNextUp) {
          swallowNextUp = false;
          return;
        }
        // Wait one double-click interval before calling it a single click.
        if (options.onClick) user32.SetTimer(window.hwnd, CLICK_TIMER_ID, user32.GetDoubleClickTime(), null);
        return;
      case WM_LBUTTONDBLCLK:
        user32.KillTimer(window.hwnd, CLICK_TIMER_ID);
        swallowNextUp = true;
        options.onDoubleClick?.();
        return;
    }
  };

  sync(NIM_ADD);

  const tray: Win32Tray = {
    balloon: {
      show(n) {
        if (disposed) return false;
        // Only an icon we created is safe to hand over as hBalloonIcon; the stock one gets the info glyph.
        const hIcon = balloonIcon.owned ? balloonIcon.handle : 0n;
        const nid = notifyIconData(window.hwnd, uid, icon.handle, tooltip, { title: n.title, body: n.body ?? "", silent: n.silent === true, hIcon });
        const ok = shell32.Shell_NotifyIconW(NIM_MODIFY, nid) !== 0;
        if (!ok) console.error(`sweetnative: Shell_NotifyIcon balloon failed (${lastError()})`);
        if (ok) lastBalloon = { id: notificationId(n), data: n.data };
        return ok;
      },
      onClick(fn) {
        balloonClick = fn;
      },
    },
    setTooltip(text) {
      if (disposed) return;
      tooltip = text;
      sync(NIM_MODIFY);
    },
    setIcon(next) {
      if (disposed) return;
      const previous = icon;
      const previousBalloon = balloonIcon;
      icon = loadIcon(next.windows?.ico);
      balloonIcon = loadIcon(next.windows?.ico, SM_CXICON);
      sync(NIM_MODIFY);
      releaseIcon(previous);
      releaseIcon(previousBalloon);
    },
    setMenu(next) {
      menu = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      user32.KillTimer(window.hwnd, CLICK_TIMER_ID);
      sync(NIM_DELETE);
      window.destroy();
      releaseIcon(icon);
      releaseIcon(balloonIcon);
      if (active === tray) active = undefined;
    },
  };

  active = tray;
  return tray;
}
