// The app's icons are the pets themselves: Kenney's 64x64 preview render of
// each animal (pet-previews.ts). The tray, the Pet menu, the settings window
// and the Dock show the current pet; the executable and the bundle show the
// cat. One module so the app and the build script agree.
//
// The previews leave a lot of transparent padding around the animal (the cat
// is 35x51 of 64), which at 16px left a speck, so each is cropped to the
// animal first and the icon sizes are resampled from that.

import { decodePng, encodePng, icnsFromRgba, icoFromRgba, trimTransparent, type DecodedPng, type Icon } from "@n1h/sweetview/native";
import { PET_PREVIEW_FILES } from "./pet-previews";
import { PETS, type Pet } from "./pets";

/** Every preview, read once at startup (24 files, ~2 KB each) and cropped to the animal. */
const previews: Record<Pet, DecodedPng> = Object.fromEntries(
  await Promise.all(PETS.map(async (p) => [p, trimTransparent(decodePng(await Bun.file(PET_PREVIEW_FILES[p]).bytes()), 1)] as const)),
) as Record<Pet, DecodedPng>;

const icons = new Map<Pet, Icon>();

/** The pet's picture as an Icon: a .ico resampled from the cropped preview on Windows, the cropped PNG (in colour, not a template) on macOS. */
export function petIcon(pet: Pet): Icon {
  let icon = icons.get(pet);
  if (icon === undefined) {
    const { width, rgba } = previews[pet];
    icon = { windows: { ico: icoFromRgba(width, rgba) }, macos: { png: encodePng(width, rgba), template: false } };
    icons.set(pet, icon);
  }
  return icon;
}

/** The pet on the executable and the bundle, where there is no "current" pet yet. */
export const COVER_PET: Pet = "cat";

/** The executable's icon (`bun build --compile --windows-icon`). */
export const appIco = (): Uint8Array => icoFromRgba(previews[COVER_PET].width, previews[COVER_PET].rgba);

/** The .app bundle's CFBundleIconFile. */
export const appIcns = (): Uint8Array => icnsFromRgba(previews[COVER_PET].width, previews[COVER_PET].rgba);
