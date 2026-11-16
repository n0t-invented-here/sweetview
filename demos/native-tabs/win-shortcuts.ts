// Windows: which keys mean what to the tabs. Pure, so it is tested without a
// window (win-shortcuts.test.ts). On macOS the same job is done by the key
// equivalents of the menu items in mac-window-tabs.ts.

/** An accelerator key as WebView2 reports it (win-webview2.ts, `onAcceleratorKey`). */
export type Key = {
  /** The virtual-key code: 0x54 for T, 0x09 for Tab. */
  virtualKey: number;
  control: boolean;
  shift: boolean;
  alt: boolean;
};

export type Shortcut = "new" | "close" | "next" | "previous" | "closeWindow" | { select: number };

const VK_TAB = 0x09;
const VK_PAGE_UP = 0x21;
const VK_PAGE_DOWN = 0x22;
const VK_1 = 0x31;
const VK_9 = 0x39;
const VK_T = 0x54;
const VK_W = 0x57;
const VK_F4 = 0x73;

/** `{ select: LAST_TAB }` is Ctrl+9: the last tab, however many there are. */
export const LAST_TAB = VK_9 - VK_1;

/**
 * What a key pressed while a page has the focus means to the tabs, if
 * anything: the keys every tabbed Windows app answers to.
 *
 *   Ctrl+T                           a new tab
 *   Ctrl+W, Ctrl+F4                  close the tab
 *   Ctrl+Tab, Ctrl+Page Down         the next tab, round to the first
 *   Ctrl+Shift+Tab, Ctrl+Page Up     the previous tab
 *   Ctrl+1 to Ctrl+8                 that tab; Ctrl+9 the last one
 *   Alt+F4                           close the window
 */
export function shortcutFor(key: Key): Shortcut | undefined {
  if (key.alt) return !key.control && !key.shift && key.virtualKey === VK_F4 ? "closeWindow" : undefined;
  if (!key.control) return undefined;
  switch (key.virtualKey) {
    case VK_TAB:
      return key.shift ? "previous" : "next";
    case VK_PAGE_DOWN:
      return key.shift ? undefined : "next";
    case VK_PAGE_UP:
      return key.shift ? undefined : "previous";
  }
  if (key.shift) return undefined;
  if (key.virtualKey === VK_T) return "new";
  if (key.virtualKey === VK_W || key.virtualKey === VK_F4) return "close";
  if (key.virtualKey >= VK_1 && key.virtualKey <= VK_9) return { select: key.virtualKey - VK_1 };
  return undefined;
}
