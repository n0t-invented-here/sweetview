// NSImage from the macOS half of an Icon: an SF Symbol by name, else PNG
// bytes. The one place the tray, menus, windows and the Dock icon get their
// images, so sizing and the template flag are decided the same way everywhere.

import type { Icon } from "../icon";
import { NIL, type Id, allocRaw, asId, cls, nsString, release, sel, sendBool, sendBytesLen, sendPtr, sendPtrPtr, sendSize } from "./objc";

export type MadeImage = {
  img: Id;
  /** We hold a +1 to release once the receiver has retained it. */
  owned: boolean;
};

/**
 * `points`: the size the image should report (18 for the menu bar, 16 for
 * menu items); omitted leaves the PNG's own size, which is what the Dock
 * wants. A PNG with 2x pixels renders crisp on Retina once its size is set
 * in points. `templateDefault`: what `template` means when unset.
 */
export function makeImage(icon: Icon["macos"] | undefined, points?: number, templateDefault = true): MadeImage {
  const template = icon?.template ?? templateDefault;
  if (icon?.symbol) {
    const img = asId(sendPtrPtr(cls("NSImage"), sel("imageWithSystemSymbolName:accessibilityDescription:"), nsString(icon.symbol), NIL));
    if (img !== NIL) {
      sendBool(img, sel("setTemplate:"), template);
      return { img, owned: false }; // +0 (autoreleased)
    }
    console.error(`sweetnative: no SF Symbol named "${icon.symbol}"${icon.png ? "; using the PNG" : ""}`);
  }
  if (icon?.png) {
    const data = asId(sendBytesLen(cls("NSData"), sel("dataWithBytes:length:"), icon.png, BigInt(icon.png.length)));
    const img = asId(sendPtr(allocRaw("NSImage"), sel("initWithData:"), data));
    if (img !== NIL) {
      sendBool(img, sel("setTemplate:"), template);
      if (points !== undefined) sendSize(img, sel("setSize:"), points, points);
      return { img, owned: true }; // +1 from alloc/init
    }
    console.error("sweetnative: NSImage could not decode the PNG bytes");
  }
  return { img: NIL, owned: false };
}

/** Sends `setter` (setImage:, setApplicationIconImage:, ...) with the made image, then drops our reference. */
export function applyImage(receiver: Id, setter: string, made: MadeImage): void {
  sendPtr(receiver, sel(setter), made.img); // the receiver retains it
  if (made.owned) release(made.img);
}
