# Native tabs, one webview per tab (macOS)

A window with the system's own tab bar, where every tab is a separate webview. Open tabs with the
`+` in the tab bar, `⌘T`, File › New Tab, or the page's own buttons; a tab shows this demo's page
or any site. Drag a tab to reorder it, drag it out to give it its own window, Window › Merge All
Windows to bring it back.

```
just demos native-tabs app
```

macOS only. Windows has no window tabbing for this to map onto; a Windows version is a tab strip
of our own over child webviews in one window, which is a different shape and not built here.

## How it works

On macOS a tab **is** a window. AppKit's window tabbing puts `NSWindow`s that share a tabbing
identifier behind one tab bar, and draws the bar, the `+`, reordering and tear-off itself. So "one
webview per tab" is the platform's own model:

| Piece | File | What it does |
| --- | --- | --- |
| A tab's window | [`mac-window-tabs.ts`](mac-window-tabs.ts) | makes a framed `NSWindow` set up for tabbing, joins it to the tab bar (`addTabbedWindow:ordered:`), reports "the user asked for a tab" and "this tab closed" |
| A tab's webview | [`tabs-app.ts`](tabs-app.ts) | `createWebviewApp({ window })` hosts a webview in that window; a tab's window, webview and record are made together and torn down together |
| The page | [`frontend/`](frontend/main.ts), [`shared.ts`](shared.ts) | shows state that lives in this webview only (instance tag, clock, click count) and calls `tab.open`, `tab.rename`, `tab.close` on the UI thread |
| The loop | [`app.ts`](app.ts) | `runEventLoop`, not the webview's blocking `run()`, so opening a tab (which awaits) works at any moment, and one tab's webview can be disposed while the rest run |

What the code does that is not obvious:

- **The `+` button.** AppKit shows it when `newWindowForTab:` has a target in the window's
  responder chain. Each tab window's `nextResponder` is one small `NSResponder` of ours that
  implements it, which is the slot a window controller normally fills.
- **The tab bar is always there.** AppKit hides it, and the `+` with it, in a window that has one
  tab. Here a window of ours that has no bar gets it back, when shown and when a tab becomes a
  window of its own, so there is no View › Show Tab Bar.
- **A tab appears already drawn.** Its window stays hidden until the page asks who it is
  (`tab.info`), then joins the tab bar; a site tab joins at once.
- **Tabs asked for in a row keep their order.** Each new tab follows the one asked for before
  it, though that one may still be loading, and waits for it before joining the bar.
- **Every native call brings its own autorelease pool** (`pooled`). The OS loop is pumped from a
  Bun timer, and only the pump has a pool; a call made from any other turn of Bun's loop
  autoreleases into nothing. Unpooled, every closed tab's `NSWindow` stayed allocated.
- **Closing a tab.** Before the webview is disposed, `detachPage` takes the page's message
  handlers away and drains the main dispatch queue. The webview library queues every page call and
  every reply there with a pointer to its engine, and does not flush that queue for a window it did
  not create; without the drain, the reply to the page's own "close this tab" call ran on freed
  memory and ended the process.

A site tab gets none of the page methods: only this demo's own page may open, rename and close
tabs. Its title follows the site's `document.title`. A site that cannot be loaded shows the
address, the system's reason and a Try Again button (`onLoadFailed`), not a blank page. What is
typed in "open a site" becomes an address in [`web-address.ts`](web-address.ts): `bun.sh` is
https, `localhost:3000` and a bare IPv4 address are http, anything that is not http or https
(`mailto:`, `tel:`, `javascript:`) is refused in words.

## Checking it

```
just demos native-tabs drive
```

[`scripts/drive.ts`](scripts/drive.ts) plays the user against the real app and prints a line per
check: every way a tab opens and closes, that two tabs' pages hold separate state, six tabs asked
for at once (their order, every page's count, their windows freed after closing), a site that
cannot be reached, tear-off and merge through the Window menu, and closing site tabs while they
are still loading. It writes PNG
captures of the window into `build/drive/` ([`scripts/capture.ts`](scripts/capture.ts) asks the
window server for the process's own window, which needs no Screen Recording grant).
`DRIVE_APPEARANCE=light` or `dark` picks the appearance. It does not click the screen, which would
need the Accessibility grant: menu items are performed by AppKit, the `+` button's message is sent
down the responder chain it uses, and page buttons are clicked in the page.

## Not here yet

- A compiled `.app`; `just demos native-tabs app` runs from source.
- Windows.
- `mac-window-tabs.ts` lives in this demo, not in `@n1h/sweetview/native`, because what the
  cross-platform API should look like is still open.
