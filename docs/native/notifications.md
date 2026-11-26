# Notifications

`Notifier` shows system notifications and tells you which one the user
clicked. On Windows 10 and 11 they are WinRT toasts; on macOS they come from
`UNUserNotificationCenter`. Neither needs a `Tray`. Part of the
[native module](../native.md).

- [Sending a notification](#sending-a-notification)
- [Options](#options)
- [What `notify()` returns](#what-notify-returns)
- [Windows](#windows)
- [macOS](#macos)

## Sending a notification

```ts
import { Notifier } from "@n1h/sweetview/native";

const notifier = new Notifier({
  onClick: ({ id, data }) => console.log("clicked", id, data),
});

notifier.notify({ title: "Export finished", body: "notes.pdf is ready", id: "export", data: { path: "notes.pdf" } });
```

`createNotifier(options)` is the same as `new Notifier(options)`.
`dispose()` releases the notifier's native resources and is safe to call
twice. Clicks route to the notifier that sent the notification, so several
notifiers in one process stay independent.

## Options

`NotifierOptions`, for the constructor:

| Field | Meaning |
|---|---|
| `onClick(click)` | Called on the UI thread with `{ id, data }` of the clicked notification. |
| `appId` | Windows toast identity (AUMID). Ignored on macOS. |
| `identity` | An [`AppIdentity`](../settings-store.md#defineappidentity); supplies the Windows AUMID (`identity.appId`) and display name (`identity.appName`). |

`NotificationOptions`, for `notify()`:

| Field | Meaning |
|---|---|
| `title` | Required. |
| `body` | Second line. |
| `silent` | No sound. |
| `id` | Names the notification; `onClick` reports it. Default `sweetview-<n>`, counting up per process. |
| `data` | Anything `JSON.stringify` accepts. `onClick` receives it back as parsed JSON, or `undefined` when none was given. |

`data` travels as JSON on both platforms, so `onClick` sees the same value on
each: a `Date` comes back as a string, a `Map` as `{}`. Keep it to plain JSON
values. On macOS the data has to survive the process exiting, since a click
can relaunch the app; on Windows it is cloned through JSON to match.

## What `notify()` returns

`true` means the notification was handed to the OS: submitted to the toast
notifier or the shell on Windows, scheduled with the notification center on
macOS. It does not mean the user saw it. Focus Assist or Do Not Disturb,
notification settings, a denied macOS permission (which arrives later and
asynchronously) or the OS's own rate limits can still keep it off the screen.

`false` means it could not be submitted: the notifier was disposed, the
Windows balloon fallback failed, or the macOS process is not a bundled app.

## Windows

The primary path is a WinRT `ToastNotificationManager` toast.

- Identity. Toasts are attributed to an Application User Model ID. The AUMID
  is `options.appId`, else `options.identity.appId`, else
  `Sweetview.DesktopApp`. It must be at most 128 characters with no
  backslash, whitespace or NUL.
- Registration. Windows only shows toasts for a registered AUMID. On first
  use Sweetview creates `HKCU\Software\Classes\AppUserModelId\<appId>` (no
  administrator rights needed) and sets `DisplayName` to `identity.appName`,
  else to the `appId` when one was given, else `Sweetview`. An existing
  `DisplayName`, such as one an installer wrote, is kept.
- Content. The title and body are XML-escaped into a `ToastGeneric`
  template, and characters XML cannot carry become U+FFFD, so any string is
  safe. `silent` adds `<audio silent="true"/>`. The notification `id` is the
  toast's launch argument, which is how a click finds its `{ id, data }`.
- Fallback. If WinRT cannot be initialized, the AUMID cannot be registered,
  or a toast fails, the notification is shown as a `Shell_NotifyIconW`
  balloon from a hidden notification-area icon. Windows 10 and 11 render
  balloons as toasts too. Each balloon carries its own click payload, and it
  uses the current `Tray` icon when one exists.

## macOS

Notifications go through `UNUserNotificationCenter`, which only serves a
real application bundle:

- The process must be a signed `.app` with a bundle identifier, outside
  temporary folders. A bare executable, or a bundle run from a temp
  directory, cannot notify: `notify()` returns `false` when there is no
  bundle identifier, and macOS refuses authorization for an unsigned bundle,
  which Sweetview logs. [`makeMacApp`](../build.md#makemacapp) builds and
  ad-hoc signs a suitable bundle.
- The first notification asks the user for permission. If they deny it,
  later notifications are dropped by macOS.
- The notifier registers its delegate in the constructor, before the first
  `notify()`. When a click on a notification launches the app, create the
  `Notifier` with its `onClick` at startup and the click arrives as soon as
  the event loop runs.
- A new notification with the `id` of one still on screen replaces it, which
  suits progress or status updates.
- Notifications show as banners even while the app is in front.
