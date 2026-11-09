// macOS main menu. webview creates an NSApplication with no mainMenu, so there
// is no app menu, no Quit, and Cmd+Q / Cmd+C / Cmd+V do nothing. Build the
// standard minimum: app menu (About…, Quit) and an Edit menu so text editing
// shortcuts reach the webview. Call on the main thread before webview.run().

import type { AppMenuOptions } from "../app-menu";
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
  sendInt,
  sendIntRetBool,
  sendPtr,
  sendPtrSelPtr,
  sharedApp,
} from "./objc";

const NSApplicationActivationPolicyRegular = 0n;

type Item = [title: string, action: string, key: string, target?: Id] | "separator";

function menuItem(title: string, action: string, key: string, target?: Id): Id {
  const it = allocRaw("NSMenuItem");
  const inited = sendPtrSelPtr(it, sel("initWithTitle:action:keyEquivalent:"), nsString(title), sel(action), nsString(key));
  const id = inited === null ? NIL : BigInt(inited);
  if (target !== undefined) sendPtr(id, sel("setTarget:"), target);
  return id;
}

function submenu(parent: Id, title: string, items: Item[]) {
  const holder = alloc("NSMenuItem");
  sendPtr(parent, sel("addItem:"), holder);
  const menu = asId(sendPtr(allocRaw("NSMenu"), sel("initWithTitle:"), nsString(title)));
  for (const it of items) {
    if (it === "separator") {
      sendPtr(menu, sel("addItem:"), asId(send(cls("NSMenuItem"), sel("separatorItem"))));
      continue;
    }
    const item = menuItem(...it);
    sendPtr(menu, sel("addItem:"), item);
    release(item); // the menu retains it
  }
  sendPtr(holder, sel("setSubmenu:"), menu);
  release(menu); // the holder retains it
  release(holder); // the parent retains it
}

function showAbout(appName: string, text: string) {
  const alert = alloc("NSAlert");
  sendPtr(alert, sel("setMessageText:"), nsString(`About ${appName}`));
  sendPtr(alert, sel("setInformativeText:"), nsString(text));
  sendPtr(alert, sel("addButtonWithTitle:"), nsString("OK"));
  sendInt(alert, sel("runModal"));
  release(alert);
}

export function installAppMenu(opts: AppMenuOptions) {
  const app = sharedApp();
  sendIntRetBool(app, sel("setActivationPolicy:"), NSApplicationActivationPolicyRegular);

  const target = makeTarget("SweetviewAppMenuTarget", {
    "showAbout:": () => showAbout(opts.appName, opts.aboutText),
  });

  const menubar = alloc("NSMenu");
  submenu(menubar, opts.appName, [
    [`About ${opts.appName}…`, "showAbout:", "", target],
    "separator",
    [`Quit ${opts.appName}`, "terminate:", "q"],
  ]);
  submenu(menubar, "Edit", [
    ["Undo", "undo:", "z"],
    ["Redo", "redo:", "Z"],
    ["Cut", "cut:", "x"],
    ["Copy", "copy:", "c"],
    ["Paste", "paste:", "v"],
    ["Select All", "selectAll:", "a"],
  ]);
  sendPtr(app, sel("setMainMenu:"), menubar);
}
