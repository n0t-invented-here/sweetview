// The answers of the pure-TypeScript functions docs/native.md calls any-thread, computed the same
// way on the UI thread and in a Worker by src/binding.test.ts (W1.5): menu templates, hit-region
// geometry, the icon encoders and the PNG decoder, and the regular-file helpers.

import { decodePng, dotPng, hitRegions, icoFromPng, packRegions, readTextFile, resolveMenu } from "../src/index";

export async function pureAnswers(file: string) {
  const menu = resolveMenu(() => [{ label: "Open" }, { type: "separator" }]).map((item) => ("label" in item ? item.label : item.type));
  const square = packRegions([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]]);
  const hits = [hitRegions(square, 5, 5), hitRegions(square, 15, 5)];
  const png = dotPng(24);
  const decoded = decodePng(png);
  const ico = icoFromPng(png, [16, 24]);
  return {
    menu,
    hits,
    png: { width: decoded.width, height: decoded.height, firstPixel: [...decoded.rgba.subarray(0, 4)] },
    // ICONDIR: reserved 0, type 1 (icon), two images.
    icoHeader: [...ico.subarray(0, 6)],
    icoBytes: ico.length,
    text: await readTextFile(file),
  };
}
