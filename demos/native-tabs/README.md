# Native tabs, one webview per tab

A window with a tab bar where every tab is a separate webview. A tab shows this demo's page or any
site; open tabs with the `+` in the tab bar, the keyboard, or the page's own buttons. Drag a tab to
reorder it, drag it out to give it its own window, and bring it back.

```
just demos native-tabs app
```

macOS and Windows. The two are different shapes, because the platforms are:

| | macOS | Windows |
| --- | --- | --- |
| The tab bar | the system's: AppKit window tabbing | ours: a webview where the title bar was |
| A tab | an `NSWindow` hosting a `WKWebView` | a `WebView2` webview, a child of the window |
| New tab, close tab | `⌘T`, `⌘W`, File menu | `Ctrl+T`, `Ctrl+W` or `Ctrl+F4`, the tab's menu |
| Next, previous tab | `⌃Tab`, `⌃⇧Tab` | `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+Page Down / Up`, `Ctrl+1` to `Ctrl+9` |
| A tab to its own window | drag it out, or Window › Move Tab to New Window | drag it out, or right-click › Move tab to new window |
| And back | drag it onto a tab bar, or Window › Merge All Windows | drag it onto a tab strip, or right-click › Merge all windows |

What the two share is the page ([`frontend/main.ts`](frontend/main.ts), [`tab-page.ts`](tab-page.ts),
[`shared.ts`](shared.ts)), which shows state that lives in its webview only (instance tag, clock,
click count) and calls `tab.open`, `tab.rename` and `tab.close` on the UI thread, and the loop
([`app.ts`](app.ts)): `runEventLoop`, not the webview's blocking `run()`, so opening a tab (which
awaits) works at any moment, and one tab's webview can be disposed while the rest run.

A site tab gets none of the page methods: only this demo's own page may open, rename and close
tabs. Its title follows the site's `document.title`. What is typed in "open a site" becomes an
address in [`web-address.ts`](web-address.ts): `bun.sh` is https, `localhost:3000` and a bare IPv4
address are http, anything that is not http or https (`mailto:`, `tel:`, `javascript:`) is refused
in words.

## Built-in tabs architecture

Native tabs are built directly into `@n1h/sweetview` (`createApp({ tabs: true })`, `WebView.openTab`, `Window({ tabs: true })`). This demo's [`app.ts`](app.ts) is a thin consumer of that API, plus the demo page ([`frontend/main.ts`](frontend/main.ts), [`tab-page.ts`](tab-page.ts), [`web-address.ts`](web-address.ts)) and automated drive scripts (`scripts/`).

### macOS

On macOS a tab **is** a window. AppKit's window tabbing puts `NSWindow`s that share a tabbing
identifier behind one tab bar, and draws the bar, the `+`, reordering and tear-off itself. So "one
webview per tab" is the platform's own model:

| Piece | Where | What it does |
| --- | --- | --- |
| Window tabbing primitives | `@n1h/sweetview-native`, its macOS backend | makes a framed `NSWindow` set up for tabbing, joins it to the tab bar (`addTabbedWindow:ordered:`), reports "the user asked for a tab" and "this tab closed" |
| Tab webview coordinator | `@n1h/sweetview`, its tabs library on macOS | `WebView.attach` hosts a webview in each tab window; manages `WKWebView` load-error hooks, message-handler detachment, and `Tab` lifecycle |

What the code does that is not obvious:

- **The `+` button.** AppKit shows it when `newWindowForTab:` has a target in the window's
  responder chain. Each tab window's `nextResponder` is one small `NSResponder` of ours that
  implements it, which is the slot a window controller normally fills.
- **The tab bar is always there.** AppKit hides it, and the `+` with it, in a window that has one
  tab. Here a window of ours that has no bar gets it back, when shown and when a tab becomes a
  window of its own, so there is no View › Show Tab Bar.
- **A tab joins the bar when its webview is attached.** `openTab` resolves once the tab's
  webview exists and is navigating, and the tab window joins the tab bar then, its page drawing as
  it loads. While the tabbed window is still hidden, new tabs wait, in order, and join when it is
  shown.
- **Tabs asked for in a row keep their order.** A new tab goes after the tab passed as `after`
  (the demo passes the tab whose page asked for it), or after the selected tab.
- **Every native call brings its own autorelease pool** (`pooled`). The OS loop is pumped from a
  Bun timer, and only the pump has a pool; a call made from any other turn of Bun's loop
  autoreleases into nothing. Unpooled, every closed tab's `NSWindow` stayed allocated.
- **Closing a tab.** Before the webview is disposed, `detachPage` takes the page's message
  handlers away and drains the main dispatch queue. The webview library queues every page call and
  every reply there with a pointer to its engine, and does not flush that queue for a window it did
  not create; without the drain, the reply to the page's own "close this tab" call ran on freed
  memory and ended the process.
- **A link that asks for a new window gets a tab.** An HTTP(S) `target="_blank"` link or
  `window.open()` opens the address as a new tab after the current one; any other scheme is
  dropped.
- **A site that cannot be loaded** shows a "This site did not open" page with the address, the
  system's reason and a Try Again link (`onLoadFailed`, in the tabs library),
  not a blank page.

### Windows

Windows has no window tabbing to borrow, and a tab is not a window there. So the window is ours,
built the way Windows 11's own tabbed apps are: one window whose title bar is the tab strip.

```
the frame        a normal resizable window, minus its caption
├─ the strip     a webview along the top, a child of the frame, that draws the tabs
└─ a tab         a webview below it, a child of the frame; one shown at a time
```

| Piece | Where | What it does |
| --- | --- | --- |
| The frame | [`crates/sweetview-runtime/src/window/tab_frame.rs`](../../crates/sweetview-runtime/src/window/tab_frame.rs), [`crates/sweetview-platform-window/src/tab_frame.rs`](../../crates/sweetview-platform-window/src/tab_frame.rs), and `@n1h/sweetview-native`'s Windows backend | a `tao` window with its caption taken off and the system's border and shadow kept; reports where the strip and the page go, hands drags to the window manager, shows the system menu and the tab menu |
| The embedded strip | `@n1h/sweetview`, its tabs library on Windows | self-contained HTML/CSS/JS tab strip page drawing the tabs, `+`, and window buttons (no build step required) |
| The tabs coordinator | `@n1h/sweetview`, its tabs library on Windows | which tabs are in which window, in what order, and which is shown; `WebView.attach` per tab, as a child webview of the frame |
| WebView2 helpers | `@n1h/sweetview`, its tabs library on Windows | what the tabs need of a webview beyond `RawWebview`, through the Rust engine: hide a tab's page, give one the keyboard, hear accelerator keys, take over "open a new window", hear a failed load |

What the code does that is not obvious:

- **The window is still the system's.** Only the caption is taken away: the frame is `tao`'s
  window without decorations but with its shadow, which keeps the caption and resize styles, so the
  shadow, the rounded corners, the side and bottom resize borders, snapping, maximise and the
  taskbar are Windows' own. The top edge lost its resize border with the
  caption, so the strip offers it back (a 4 pixel band, and the two top corners).
- **A click in the strip never keeps the keyboard.** The strip is a webview, so a press on it
  takes the focus as any page would. After every call from the strip (and when its menu closes, or
  a drag is let go) the keyboard is given back to the page on show, as a click on a title bar
  leaves it with the document.
- **A right-click has two menus**, both the system's own popup. On a tab: New tab, Move tab to
  new window, Merge all windows, Close tab, Close other tabs. On the strip's empty part: the
  window's menu (Restore, Move, Size, Minimize, Maximize, Close), as on any title bar.
- **A drag is the window manager's.** A press on the strip's empty part moves the window, and a
  press on its top edge resizes it, by handing the press over (`WM_NCLBUTTONDOWN`). The cursor has
  travelled by the time the UI thread hears of the press, so the page says where in the strip the
  press was and the window is put back under the cursor first; without that the window trails the
  hand by a third of a quick drag.
- **The keys work from any page, a site's too.** While a page has the focus no key reaches a
  window procedure of ours. WebView2 reports accelerator keys to its host
  (`add_AcceleratorKeyPressed`), which the Rust engine subscribes to. A site is given no function
  to call for this, so it cannot open or close tabs by script.
- **A link that asks for a new window gets a tab** (`add_NewWindowRequested`): an HTTP(S)
  `target="_blank"` link or `window.open()` opens a tab after the tab it was clicked in, and any
  other scheme is dropped. Left alone, WebView2 opens a bare popup window.
- **A new tab is shown at once.** It is selected in the strip and its webview takes the place of the
  one on show as soon as its webview is attached; its page draws as it loads.
- **Tabs asked for in a row keep their order.** A new tab goes after the selected one and is
  selected itself, so the next goes after it; one asked for by a page goes after that page's tab
  and the tabs it asked for before.
- **Moving a tab to another window moves its webview.** The webview is given the other frame as
  its parent (`reparent`); the page is not reloaded and keeps its state. A tab dragged out of the strip gets
  a new window with the tab under the cursor where it was held, and the press is handed to the
  window manager, so the new window follows the cursor at once. Let go over another window's
  strip, it joins that window where it was dropped. A window's only tab takes the window with it.
- **A tab that is not shown is told so** (`put_IsVisible`): it stops painting, and its page sees
  `document.hidden`. WebView2 starts every page off as visible, so one that was opened behind
  another is told once it has drawn.
- **More tabs than fit scroll.** A tab is never narrower than 72 pixels; past that the row scrolls
  to keep the selected tab in view, fades out at an end that has more, and turns with the mouse
  wheel. The page tells the UI thread how far it is scrolled, which is how a tab dropped on a
  scrolled strip lands where it was dropped.
- **The selected tab is the colour of its page.** The demo's page tints itself by tab, and the
  strip gives the tab the same tint (`tabHue`), so tab and page read as one sheet; a site's tab is
  neutral.
- **Closing a tab never happens inside its own call.** Everything that destroys, shows or moves a
  webview runs on a turn of Bun's loop of its own: a webview cannot be destroyed from inside the
  page call that asked for it, and the menu and a drag run a loop of their own.
- **A site that cannot be loaded** shows the same "This site did not open" page as on macOS, with
  the address, the reason and a Try Again link, set when `NavigationCompleted` reports a failure.
  An HTTP error response is not a failure: the server's own page shows, as on macOS.

## Checking it

```
just demos native-tabs drive
```

plays the user against the real app and prints a line per check: every way a tab opens and closes,
that two tabs' pages hold separate state, six tabs asked for at once, a site that cannot be
reached, a tab moved to its own window and merged back, and closing site tabs while they are still
loading. It writes PNG captures of the window into `build/drive/`. `DRIVE_APPEARANCE=light` or
`dark` picks the appearance.

- **macOS** ([`scripts/mac-drive.ts`](scripts/mac-drive.ts), [`scripts/mac-capture.ts`](scripts/mac-capture.ts)).
  It does not click the screen, which would need the Accessibility grant: menu items are performed
  by AppKit, the `+` button's message is sent down the responder chain it uses, and page buttons
  are clicked in the page. The capture asks the window server for the process's own window, which
  needs no Screen Recording grant.
- **Windows** ([`scripts/win-drive.ts`](scripts/win-drive.ts), [`scripts/win-capture.ts`](scripts/win-capture.ts)).
  It also uses the real mouse and keyboard ([`scripts/win-input.ts`](scripts/win-input.ts)), for
  what nothing else shows: that the window manager takes over a drag, that keys pressed in a page
  reach the tabs, that a tab dragged out becomes a window and dropped on a strip comes back, that
  the system's menu opens. Each of those runs only while the app's window is the foreground
  window, and prints `SKIP` when it is not; nothing is sent to another program. `DRIVE_INPUT=off`
  leaves the mouse and keyboard alone.

## Not here yet

- A compiled app; `just demos native-tabs app` runs from source.
- Windows: a tab dragged over another window's strip joins it when dropped, with no preview of
  where it will land while it is still held.
- Windows: hovering the maximise button does not show Windows 11's Snap Layouts flyout. The system
  shows it only where the window itself answers `HTMAXBUTTON` to a hit test, and here that button
  is drawn by the strip's webview, which is another process's window. It takes a maximise button
  drawn natively in a gap in the strip. Snapping by dragging to a screen edge, `Win`+arrows and
  `Win+Z` work as for any window.
- Windows: tabs have no icons (a site's favicon, a loading mark), and a strip with more tabs than
  fit has no arrows, only the wheel.
