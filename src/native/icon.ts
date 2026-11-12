// Icons as data, with no image library: the per-platform byte formats an app
// hands to sweetnative, encoders for the two container formats the OSes want
// (.ico for Windows, .icns for a macOS app bundle) plus PNG, and a filled disc
// renderer so an app has a passable icon before it has real art.

import { crc32, deflateSync, inflateSync } from "node:zlib";

/**
 * An icon, one section per platform; each platform reads only its own. Omit a
 * section for that platform's stock image. The same shape serves the tray,
 * menu items, windows and the app icon.
 */
export type Icon = {
  windows?: {
    /** A .ico file's bytes. The best-fitting image is picked for each use (16px tray and menu, 32px toasts, both for a window). */
    ico: Uint8Array;
  };
  macos?: {
    /** An SF Symbol name; preferred over `png` when both are given. */
    symbol?: string;
    /** PNG bytes. Sized by the use: 18x18 points in the menu bar, 16x16 in menus, as-is for the Dock. Supply 2x pixels for Retina. */
    png?: Uint8Array;
    /** Monochrome, recoloured by the system for light and dark. Default true in the menu bar and in menus, false for the Dock. */
    template?: boolean;
  };
};

export type DotIconOptions = {
  /** CSS-style hex colour, "#rrggbb". Default violet. */
  color?: string;
  /** Hex colour of a thin outer ring; omitted = no ring. */
  ring?: string;
  /** Pixel sizes of the entries `dotIcon` writes; `dotPng` and `dotIcns` ignore it. Default 16, 24, 32. */
  sizes?: number[];
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a #rgb or #rrggbb colour: ${hex}`);
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Anti-aliased disc as top-down RGBA. */
export function renderDot(size: number, opts: DotIconOptions = {}): Uint8Array {
  const fill = hexToRgb(opts.color ?? "#8b5cf6");
  const ring = opts.ring ? hexToRgb(opts.ring) : null;
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const radius = size / 2 - 0.5;
  const ringWidth = Math.max(1, size / 10);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const coverage = Math.min(1, Math.max(0, radius - d + 0.5));
      if (coverage <= 0) continue;
      const rgb = ring !== null && d > radius - ringWidth ? ring : fill;
      const i = (y * size + x) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = Math.round(coverage * 255);
    }
  }
  return px;
}

/** One 32bpp icon image: BITMAPINFOHEADER + bottom-up BGRA + (empty) AND mask. */
function dibImage(size: number, rgba: Uint8Array): Uint8Array {
  const bgra = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // DIB rows are bottom-up
    const dst = y * size * 4;
    for (let x = 0; x < size; x++) {
      bgra[dst + x * 4] = rgba[src + x * 4 + 2]!;
      bgra[dst + x * 4 + 1] = rgba[src + x * 4 + 1]!;
      bgra[dst + x * 4 + 2] = rgba[src + x * 4]!;
      bgra[dst + x * 4 + 3] = rgba[src + x * 4 + 3]!;
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = new Uint8Array(maskStride * size); // all zero: the alpha channel governs
  const hdr = new DataView(new ArrayBuffer(40));
  hdr.setUint32(0, 40, true);
  hdr.setInt32(4, size, true);
  hdr.setInt32(8, size * 2, true); // XOR + AND
  hdr.setUint16(12, 1, true);
  hdr.setUint16(14, 32, true);
  hdr.setUint32(20, bgra.length + mask.length, true);
  const out = new Uint8Array(40 + bgra.length + mask.length);
  out.set(new Uint8Array(hdr.buffer), 0);
  out.set(bgra, 40);
  out.set(mask, 40 + bgra.length);
  return out;
}

/** Wraps rendered images (size -> top-down RGBA) as a .ico file. */
export function encodeIco(images: Map<number, Uint8Array>): Uint8Array {
  const entries = [...images.entries()].sort((a, b) => a[0] - b[0]);
  const dir = new Uint8Array(6 + 16 * entries.length);
  const dv = new DataView(dir.buffer);
  dv.setUint16(2, 1, true); // type: icon
  dv.setUint16(4, entries.length, true);
  const blobs: Uint8Array[] = [];
  let offset = dir.length;
  entries.forEach(([size, rgba], i) => {
    if (size < 1 || size > 256) throw new Error(`an .ico image is 1 to 256 pixels a side, not ${size}`);
    const img = dibImage(size, rgba);
    const e = 6 + i * 16;
    dir[e] = size === 256 ? 0 : size;
    dir[e + 1] = size === 256 ? 0 : size;
    dv.setUint16(e + 4, 1, true); // planes
    dv.setUint16(e + 6, 32, true); // bits per pixel
    dv.setUint32(e + 8, img.length, true);
    dv.setUint32(e + 12, offset, true);
    blobs.push(img);
    offset += img.length;
  });
  const out = new Uint8Array(offset);
  out.set(dir, 0);
  let pos = dir.length;
  for (const b of blobs) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}

/** A coloured disc as a multi-size .ico, for `Icon.windows.ico`. */
export function dotIcon(opts: DotIconOptions = {}): Uint8Array {
  const sizes = opts.sizes ?? [16, 24, 32];
  return encodeIco(new Map(sizes.map((s) => [s, renderDot(s, opts)])));
}

export type IcoEntry = { width: number; height: number; offset: number; size: number };

/** Reads the directory of a .ico file. */
export function parseIco(bytes: Uint8Array): IcoEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 6 || dv.getUint16(2, true) !== 1) throw new Error("not a .ico file");
  const count = dv.getUint16(4, true);
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > bytes.length) throw new Error("truncated .ico directory");
    const width = bytes[e]! || 256;
    const height = bytes[e + 1]! || 256;
    const size = dv.getUint32(e + 8, true);
    const offset = dv.getUint32(e + 12, true);
    if (offset + size > bytes.length) throw new Error(`.ico image ${i} runs past the end of the file`);
    entries.push({ width, height, offset, size });
  }
  return entries;
}

/** The entry matching `want` exactly, else the smallest larger one, else the largest. */
export function pickIcoEntry(entries: IcoEntry[], want: number): IcoEntry {
  if (entries.length === 0) throw new Error(".ico has no images");
  const exact = entries.find((e) => e.width === want);
  if (exact) return exact;
  const larger = entries.filter((e) => e.width > want).sort((a, b) => a.width - b.width)[0];
  return larger ?? entries.slice().sort((a, b) => b.width - a.width)[0]!;
}

/** The pixels of a .ico entry as top-down RGBA: a 32bpp DIB entry, or a PNG-compressed one (the usual 256px form). */
export function decodeIcoEntry(bytes: Uint8Array, entry: IcoEntry): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + entry.offset, entry.size);
  if (entry.size >= 8 && dv.getUint32(0, false) === 0x89504e47) {
    const png = decodePng(bytes.subarray(entry.offset, entry.offset + entry.size));
    if (png.width !== entry.width || png.height !== entry.height) throw new Error(`.ico entry says ${entry.width}x${entry.height} but its PNG is ${png.width}x${png.height}`);
    return png.rgba;
  }
  if (dv.getUint32(0, true) !== 40) throw new Error(`.ico entry ${entry.width}px: unexpected BITMAPINFOHEADER size`);
  const bpp = dv.getUint16(14, true);
  if (bpp !== 32) throw new Error(`.ico entry ${entry.width}px is ${bpp}bpp; only 32bpp decodes here`);
  const { width, height } = entry;
  const rgba = new Uint8Array(width * height * 4);
  const pixels = entry.offset + 40;
  for (let y = 0; y < height; y++) {
    const src = pixels + (height - 1 - y) * width * 4; // bottom-up BGRA
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      rgba[dst + x * 4] = bytes[src + x * 4 + 2]!;
      rgba[dst + x * 4 + 1] = bytes[src + x * 4 + 1]!;
      rgba[dst + x * 4 + 2] = bytes[src + x * 4]!;
      rgba[dst + x * 4 + 3] = bytes[src + x * 4 + 3]!;
    }
  }
  return rgba;
}

/** Bilinear resample of a square top-down RGBA image. Returns the input when the size already matches. */
export function resampleRgba(src: Uint8Array, from: number, to: number): Uint8Array {
  if (from === to) return src;
  const out = new Uint8Array(to * to * 4);
  const scale = from / to;
  for (let y = 0; y < to; y++) {
    const sy = Math.min(from - 1, Math.max(0, (y + 0.5) * scale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(from - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < to; x++) {
      const sx = Math.min(from - 1, Math.max(0, (x + 0.5) * scale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(from - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * to + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * from + x0) * 4 + c]!;
        const p10 = src[(y0 * from + x1) * 4 + c]!;
        const p01 = src[(y1 * from + x0) * 4 + c]!;
        const p11 = src[(y1 * from + x1) * 4 + c]!;
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

/** The RGBA of a .ico at exactly `size` px: the matching entry, or the next larger one scaled down. */
export function icoRgba(ico: Uint8Array, size: number): Uint8Array {
  const entry = pickIcoEntry(parseIco(ico), size);
  if (entry.width !== entry.height) throw new Error(`.ico entry ${entry.width}x${entry.height} is not square`);
  return resampleRgba(decodeIcoEntry(ico, entry), entry.width, size);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

/** A square top-down RGBA image as an 8-bit RGBA PNG. */
export function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== size * size * 4) throw new Error(`encodePng: ${rgba.length} bytes is not ${size}x${size} RGBA`);
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, size, false);
  idv.setUint32(4, size, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression, filter, interlace: 0
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size); // filter byte 0 (None) before every row
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const idat = new Uint8Array(deflateSync(raw));
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** The .icns element type that holds a PNG of this pixel size (the 1x types; Finder scales for Retina). */
export const ICNS_TYPES: Record<number, string> = {
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};

/** Wraps PNGs (pixel size -> PNG bytes) as an .icns file, for CFBundleIconFile. Sizes without an element type throw. */
export function encodeIcns(images: Map<number, Uint8Array>): Uint8Array {
  const elements: Uint8Array[] = [];
  for (const [size, png] of [...images.entries()].sort((a, b) => a[0] - b[0])) {
    const type = ICNS_TYPES[size];
    if (type === undefined) throw new Error(`encodeIcns: no element type for ${size}px (use ${Object.keys(ICNS_TYPES).join(", ")})`);
    const el = new Uint8Array(8 + png.length);
    el.set(new TextEncoder().encode(type), 0);
    new DataView(el.buffer).setUint32(4, el.length, false);
    el.set(png, 8);
    elements.push(el);
  }
  const total = 8 + elements.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode("icns"), 0);
  new DataView(out.buffer).setUint32(4, total, false);
  let pos = 8;
  for (const e of elements) {
    out.set(e, pos);
    pos += e.length;
  }
  return out;
}

/** The disc as a PNG of `size` px, for `Icon.macos.png`. */
export function dotPng(size: number, opts: DotIconOptions = {}): Uint8Array {
  return encodePng(size, renderDot(size, opts));
}

/** The disc as an .icns with every standard size, for a macOS app bundle. */
export function dotIcns(opts: DotIconOptions = {}): Uint8Array {
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  return encodeIcns(new Map(sizes.map((s) => [s, dotPng(s, opts)])));
}

export type DecodedPng = { width: number; height: number; rgba: Uint8Array };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG as top-down RGBA: 8-bit greyscale, RGB, palette (with tRNS alpha),
 * greyscale+alpha and RGBA, non-interlaced, which covers what image editors
 * and asset packs write. Anything else throws with the reason.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  for (let pos = 8; pos + 8 <= bytes.length; ) {
    const length = dv.getUint32(pos, false);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (data.length !== length) throw new Error(`PNG ${type} chunk runs past the end of the file`);
    switch (type) {
      case "IHDR":
        width = dv.getUint32(pos + 8, false);
        height = dv.getUint32(pos + 12, false);
        depth = data[8]!;
        colour = data[9]!;
        if (data[12] !== 0) throw new Error("interlaced PNGs are not supported");
        if (depth !== 8) throw new Error(`${depth}-bit PNGs are not supported (8-bit only)`);
        break;
      case "PLTE":
        palette = data;
        break;
      case "tRNS":
        trns = data;
        break;
      case "IDAT":
        idat.push(data);
        break;
    }
    pos += 12 + length;
    if (type === "IEND") break;
  }
  if (width === 0 || height === 0) throw new Error("PNG has no IHDR");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (channels === undefined) throw new Error(`PNG colour type ${colour} is not supported`);
  if (colour === 3 && palette === undefined) throw new Error("palette PNG has no PLTE");
  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) {
    compressed.set(c, at);
    at += c.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is short");

  // Undo the per-row filters in place, into `rows` (no filter bytes).
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = y > 0 ? dst - stride : -1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[dst + x - channels]! : 0; // left
      const b = prev >= 0 ? rows[prev + x]! : 0; // up
      const c = prev >= 0 && x >= channels ? rows[prev + x - channels]! : 0; // up-left
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`PNG row ${y} has unknown filter ${filter}`);
      }
      rows[dst + x] = (raw[src + x]! + predictor) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * channels;
    switch (colour) {
      case 0: {
        const g = rows[s]!;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = trns !== undefined && trns.length >= 2 && ((trns[0]! << 8) | trns[1]!) === g ? 0 : 255;
        break;
      }
      case 2: {
        rgba[o] = rows[s]!;
        rgba[o + 1] = rows[s + 1]!;
        rgba[o + 2] = rows[s + 2]!;
        const keyed =
          trns !== undefined &&
          trns.length >= 6 &&
          ((trns[0]! << 8) | trns[1]!) === rows[s]! &&
          ((trns[2]! << 8) | trns[3]!) === rows[s + 1]! &&
          ((trns[4]! << 8) | trns[5]!) === rows[s + 2]!;
        rgba[o + 3] = keyed ? 0 : 255;
        break;
      }
      case 3: {
        const index = rows[s]!;
        rgba[o] = palette![index * 3] ?? 0;
        rgba[o + 1] = palette![index * 3 + 1] ?? 0;
        rgba[o + 2] = palette![index * 3 + 2] ?? 0;
        rgba[o + 3] = trns !== undefined && index < trns.length ? trns[index]! : 255;
        break;
      }
      case 4:
        rgba[o] = rgba[o + 1] = rgba[o + 2] = rows[s]!;
        rgba[o + 3] = rows[s + 1]!;
        break;
      case 6:
        rgba[o] = rows[s]!;
        rgba[o + 1] = rows[s + 1]!;
        rgba[o + 2] = rows[s + 2]!;
        rgba[o + 3] = rows[s + 3]!;
        break;
    }
  }
  return { width, height, rgba };
}

/** A square PNG's pixels, or a throw naming the shape. */
function squarePng(png: Uint8Array): { size: number; rgba: Uint8Array } {
  const { width, height, rgba } = decodePng(png);
  if (width !== height) throw new Error(`PNG is ${width}x${height}; icons want a square image`);
  return { size: width, rgba };
}

/** A PNG as a multi-size .ico (32bpp entries, resampled from the PNG), for `Icon.windows.ico`. */
export function icoFromPng(png: Uint8Array, sizes?: number[]): Uint8Array {
  const { size, rgba } = squarePng(png);
  return icoFromRgba(size, rgba, sizes);
}

/** A PNG as an .icns (resampled to each size), for CFBundleIconFile. Sizes above the PNG's own are upscaled. */
export function icnsFromPng(png: Uint8Array, sizes?: number[]): Uint8Array {
  const { size, rgba } = squarePng(png);
  return icnsFromRgba(size, rgba, sizes);
}

/**
 * The image cropped to its opaque pixels (alpha above `threshold`), as a
 * square centred on them with `margin` transparent pixels around, so an
 * asset with padding around its subject fills a 16px menu icon instead of
 * leaving a speck in the middle. The square is padded with transparency
 * where it runs past the source. A fully transparent image comes back as is.
 */
export function trimTransparent(image: DecodedPng, margin = 1, threshold = 8): DecodedPng {
  const { width, height, rgba } = image;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return image;
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1) + 2 * margin;
  const left = Math.round((x0 + x1 + 1) / 2 - side / 2);
  const top = Math.round((y0 + y1 + 1) / 2 - side / 2);
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    const sy = top + y;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < side; x++) {
      const sx = left + x;
      if (sx < 0 || sx >= width) continue;
      out.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * side + x) * 4);
    }
  }
  return { width: side, height: side, rgba: out };
}

/** Square RGBA as a multi-size .ico (32bpp entries, resampled), for `Icon.windows.ico`. */
export function icoFromRgba(size: number, rgba: Uint8Array, sizes: number[] = [16, 24, 32, 48, 64]): Uint8Array {
  return encodeIco(new Map(sizes.map((s) => [s, resampleRgba(rgba, size, s)])));
}

/** Square RGBA as an .icns (resampled to each size), for CFBundleIconFile. Sizes above the source are upscaled. */
export function icnsFromRgba(size: number, rgba: Uint8Array, sizes: number[] = [16, 32, 64, 128, 256]): Uint8Array {
  return encodeIcns(new Map(sizes.map((s) => [s, encodePng(s, resampleRgba(rgba, size, s))])));
}
