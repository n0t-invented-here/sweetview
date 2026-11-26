// Windows notifications: per-notification hidden Shell_NotifyIconW channels on
// a dedicated message window, so:
// 1. Notifier works standalone with or without a Tray.
// 2. Each notification has its own uID, so firing multiple notifications and
//    clicking an earlier one delivers that notification's exact id and data.
// 3. When a Tray exists, we reuse its icon bytes for the toast icon; otherwise
//    the stock application icon is used.

import { type NotificationClick, type NotificationOptions, type NotifierBackend, type NotifierOptions, notificationId } from "../notifications";
import { SM_CXICON, WM_APP, lastError, shell32, wstr } from "./api";
import { loadIcon, releaseIcon, type LoadedIcon } from "./icon";
import { ensureWin32Init } from "./init";
import { createMessageWindow } from "./message-window";
import { NID_BALLOON_ICON, NID_CALLBACK, NID_FLAGS, NID_HICON, NID_HWND, NID_INFO, NID_INFO_FLAGS, NID_INFO_TITLE, NID_SIZE, NID_TIP, NID_UID, currentTrayIconBytes } from "./tray";

const WM_NOTIFIER = WM_APP + 2;

const NIM_ADD = 0;
const NIM_DELETE = 2;
const NIF_MESSAGE = 0x1;
const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const NIF_STATE = 0x8;
const NIF_INFO = 0x10;

const NIS_HIDDEN = 0x1;
const NID_STATE = 296;
const NID_STATE_MASK = 300;

const NIIF_INFO = 0x1;
const NIIF_USER = 0x4;
const NIIF_NOSOUND = 0x10;
const NIIF_LARGE_ICON = 0x20;
const NIIF_RESPECT_QUIET_TIME = 0x80;

const NIN_BALLOONHIDE = 0x0403;
const NIN_BALLOONTIMEOUT = 0x0404;
const NIN_BALLOONUSERCLICK = 0x0405;

let nextNotificationUid = 10000;

const setWide = (nid: Uint8Array, offset: number, value: string, wchars: number) => {
  const bytes = wstr(value);
  nid.set(bytes.subarray(0, Math.min(bytes.length, (wchars - 1) * 2)), offset);
};

export function hiddenBalloonData(
  hwnd: bigint,
  uid: number,
  smallIcon: bigint,
  balloonIcon: bigint,
  title: string,
  body: string,
  silent: boolean,
): Uint8Array {
  const nid = new Uint8Array(NID_SIZE);
  const dv = new DataView(nid.buffer);
  dv.setUint32(0, NID_SIZE, true);
  dv.setBigUint64(NID_HWND, hwnd, true);
  dv.setUint32(NID_UID, uid, true);
  dv.setUint32(NID_FLAGS, NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_STATE | NIF_INFO, true);
  dv.setUint32(NID_CALLBACK, WM_NOTIFIER, true);
  dv.setBigUint64(NID_HICON, smallIcon, true);
  setWide(nid, NID_TIP, title, 128);
  dv.setUint32(NID_STATE, NIS_HIDDEN, true);
  dv.setUint32(NID_STATE_MASK, NIS_HIDDEN, true);
  setWide(nid, NID_INFO, body, 256);
  setWide(nid, NID_INFO_TITLE, title, 64);
  const ownIcon = balloonIcon !== 0n;
  let flags = (ownIcon ? NIIF_USER | NIIF_LARGE_ICON : NIIF_INFO) | NIIF_RESPECT_QUIET_TIME;
  if (silent) flags |= NIIF_NOSOUND;
  dv.setUint32(NID_INFO_FLAGS, flags, true);
  dv.setBigUint64(NID_BALLOON_ICON, balloonIcon, true);
  return nid;
}

function deleteBalloonData(hwnd: bigint, uid: number): Uint8Array {
  const nid = new Uint8Array(NID_SIZE);
  const dv = new DataView(nid.buffer);
  dv.setUint32(0, NID_SIZE, true);
  dv.setBigUint64(NID_HWND, hwnd, true);
  dv.setUint32(NID_UID, uid, true);
  return nid;
}

type PendingEntry = {
  click: NotificationClick;
  smallIcon: LoadedIcon;
  largeIcon: LoadedIcon;
};

export function createNotifier(options: NotifierOptions = {}): NotifierBackend {
  ensureWin32Init();
  let disposed = false;
  const pending = new Map<number, PendingEntry>();

  const removeUid = (uid: number): PendingEntry | undefined => {
    const entry = pending.get(uid);
    if (!entry) return undefined;
    pending.delete(uid);
    shell32.Shell_NotifyIconW(NIM_DELETE, deleteBalloonData(window.hwnd, uid));
    releaseIcon(entry.smallIcon);
    releaseIcon(entry.largeIcon);
    return entry;
  };

  const window = createMessageWindow((message, wParam, lParam) => {
    if (message !== WM_NOTIFIER) return;
    const uid = Number(wParam);
    const event = Number(lParam) & 0xffff;
    if (event === NIN_BALLOONUSERCLICK) {
      const entry = removeUid(uid);
      if (entry && !disposed && options.onClick) {
        try {
          options.onClick(entry.click);
        } catch (err) {
          console.error("sweetview: notification onClick threw:", err);
        }
      }
    } else if (event === NIN_BALLOONTIMEOUT || event === NIN_BALLOONHIDE) {
      removeUid(uid);
    }
  });

  return {
    notify(n: NotificationOptions): boolean {
      if (disposed) return false;
      const uid = nextNotificationUid++;
      const ico = currentTrayIconBytes();
      const smallIcon = loadIcon(ico);
      const largeIcon = loadIcon(ico, SM_CXICON);
      const hBalloon = largeIcon.owned ? largeIcon.handle : 0n;
      const nid = hiddenBalloonData(window.hwnd, uid, smallIcon.handle, hBalloon, n.title, n.body ?? "", n.silent === true);
      const ok = shell32.Shell_NotifyIconW(NIM_ADD, nid) !== 0;
      if (!ok) {
        console.error(`sweetview: Shell_NotifyIcon notification failed (${lastError()})`);
        releaseIcon(smallIcon);
        releaseIcon(largeIcon);
        return false;
      }
      // Clone data through JSON when possible to match macOS behavior cleanly; fallback to raw value if needed.
      let data: unknown = n.data;
      if (data !== undefined) {
        try {
          data = JSON.parse(JSON.stringify(data));
        } catch {}
      }
      pending.set(uid, { click: { id: notificationId(n), data }, smallIcon, largeIcon });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const uid of [...pending.keys()]) removeUid(uid);
      window.destroy();
    },
  };
}
