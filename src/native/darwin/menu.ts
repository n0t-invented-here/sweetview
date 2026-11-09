// NSMenu from a MenuTemplate. Every item targets one shared NSObject whose
// `menuAction:` looks the sender up in a map, so item handlers never need
// their own Objective-C class.

import { isSeparator, isSubmenu, type MenuTemplate } from "../menu";
import { applyImage, makeImage } from "./image";
import {
  NIL,
  type Id,
  alloc,
  allocRaw,
  asId,
  cls,
  makeTarget,
  nsString,
  release,
  sel,
  send,
  sendBool,
  sendIntArg,
  sendIntRetBool,
  sendPtr,
  sendPtrSelPtr,
} from "./objc";

const NSControlStateValueOn = 1n;
/** Menu item images are 16x16 points. */
const MENU_ITEM_POINTS = 16;
// macOS 27 hides menu item images by default (NSMenuItemImageVisibilityAutomatic = 0):
// symbol images for apps linked on the 26 SDK, every image on the 27 SDK. An
// item keeps its image only by asking for it. The selector is new in 27, so
// it is sent only where it exists.
const NSMenuItemImageVisibilityVisible = 1n;

/** NSMenuItem pointer -> click handler, for the menus currently alive. */
const handlers = new Map<Id, () => void>();

let target: Id | undefined;
const menuTarget = () => (target ??= makeTarget("NativeShellMenuTarget", { "menuAction:": (sender) => handlers.get(sender)?.() }));

export type BuiltMenu = { readonly menu: Id; readonly dispose: () => void };

/** Builds an NSMenu (+1, retained for the caller) from `template`. */
export function buildMenu(template: MenuTemplate): BuiltMenu {
  const owned: Id[] = [];
  const build = (items: MenuTemplate): Id => {
    const menu = alloc("NSMenu");
    sendBool(menu, sel("setAutoenablesItems:"), false);
    for (const item of items) {
      if (isSeparator(item)) {
        sendPtr(menu, sel("addItem:"), asId(send(cls("NSMenuItem"), sel("separatorItem"))));
        continue;
      }
      const it = allocRaw("NSMenuItem");
      const inited = asId(sendPtrSelPtr(it, sel("initWithTitle:action:keyEquivalent:"), nsString(item.label), NIL, nsString("")));
      sendBool(inited, sel("setEnabled:"), item.enabled !== false);
      if (item.icon?.macos) {
        const made = makeImage(item.icon.macos, MENU_ITEM_POINTS);
        if (made.img === NIL) console.error(`sweetnative: menu item "${item.label}" has no usable macOS image`);
        applyImage(inited, "setImage:", made);
        if (sendIntRetBool(inited, sel("respondsToSelector:"), sel("setPreferredImageVisibility:"))) {
          sendIntArg(inited, sel("setPreferredImageVisibility:"), NSMenuItemImageVisibilityVisible);
        }
      }
      if (isSubmenu(item)) {
        const sub = build(item.submenu);
        sendPtr(inited, sel("setSubmenu:"), sub);
        release(sub); // the item retains it
      } else {
        sendPtr(inited, sel("setTarget:"), menuTarget());
        sendPtr(inited, sel("setAction:"), sel("menuAction:"));
        sendIntArg(inited, sel("setState:"), item.checked ? NSControlStateValueOn : 0n);
        handlers.set(inited, item.click ?? (() => {}));
        owned.push(inited);
      }
      sendPtr(menu, sel("addItem:"), inited);
      release(inited); // the menu retains it
    }
    return menu;
  };
  const menu = build(template);
  return {
    menu,
    dispose() {
      for (const id of owned) handlers.delete(id);
      release(menu);
    },
  };
}
