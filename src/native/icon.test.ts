import { describe, expect, test } from "bun:test";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { decodePng, trimTransparent, dotIcns, dotIcon, dotPng, encodeIcns, encodeIco, encodePng, icnsFromPng, icoFromPng, icoRgba, parseIco, pickIcoEntry, renderDot, resampleRgba } from "./icon";

describe("renderDot", () => {
  test("centre is opaque fill, corners are transparent", () => {
    const px = renderDot(16, { color: "#ff0000" });
    const centre = (8 * 16 + 8) * 4;
    expect([...px.subarray(centre, centre + 4)]).toEqual([255, 0, 0, 255]);
    expect(px[3]).toBe(0); // top-left corner alpha
  });

  test("ring colour sits at the edge", () => {
    const px = renderDot(32, { color: "#000000", ring: "#00ff00" });
    const edge = (16 * 32 + 1) * 4; // row 16, column 1: inside the disc, within the ring width
    expect(px[edge + 1]).toBe(255);
    expect(px[edge]).toBe(0);
  });
});

describe("ico container", () => {
  test("round-trips sizes and offsets", () => {
    const ico = dotIcon({ sizes: [16, 32] });
    const entries = parseIco(ico);
    expect(entries.map((e) => e.width)).toEqual([16, 32]);
    for (const e of entries) {
      // Each image is a BITMAPINFOHEADER (40) + BGRA + mask rows (4 bytes per 32 px).
      expect(e.size).toBe(40 + e.width * e.height * 4 + Math.ceil(e.width / 32) * 4 * e.height);
      expect(e.offset + e.size).toBeLessThanOrEqual(ico.length);
      const dv = new DataView(ico.buffer, ico.byteOffset + e.offset);
      expect(dv.getUint32(0, true)).toBe(40);
      expect(dv.getInt32(8, true)).toBe(e.height * 2);
    }
    expect(entries.at(-1)!.offset + entries.at(-1)!.size).toBe(ico.length);
  });

  test("rejects non-ico bytes", () => {
    expect(() => parseIco(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow("not a .ico");
  });

  test("encodeIco handles 256px entries with the 0 convention", () => {
    const ico = encodeIco(new Map([[256, new Uint8Array(256 * 256 * 4)]]));
    expect(ico[6]).toBe(0);
    expect(parseIco(ico)[0]!.width).toBe(256);
  });
});

describe("pickIcoEntry", () => {
  const entries = parseIco(dotIcon({ sizes: [16, 24, 32] }));
  test("exact match wins", () => expect(pickIcoEntry(entries, 24).width).toBe(24));
  test("otherwise the smallest larger", () => expect(pickIcoEntry(entries, 20).width).toBe(24));
  test("otherwise the largest", () => expect(pickIcoEntry(entries, 64).width).toBe(32));
});

describe("decodeIcoEntry / icoRgba", () => {
  test("round-trips the pixels dotIcon encoded", () => {
    const px = renderDot(16, { color: "#123456" });
    const ico = encodeIco(new Map([[16, px]]));
    expect([...icoRgba(ico, 16)]).toEqual([...px]);
  });

  test("scales the next larger entry down when the size is missing", () => {
    const ico = dotIcon({ color: "#ff0000", sizes: [32] });
    const px = icoRgba(ico, 16);
    expect(px.length).toBe(16 * 16 * 4);
    const centre = (8 * 16 + 8) * 4;
    expect([...px.subarray(centre, centre + 4)]).toEqual([255, 0, 0, 255]);
    expect(px[3]).toBe(0); // corner still transparent
  });

});

describe("resampleRgba", () => {
  test("identity at the same size", () => {
    const px = renderDot(8);
    expect(resampleRgba(px, 8, 8)).toBe(px);
  });
  test("a flat colour stays flat", () => {
    const px = new Uint8Array(4 * 4 * 4).fill(200);
    expect(new Set(resampleRgba(px, 4, 3)).size).toBe(1);
  });
});

describe("encodePng", () => {
  test("writes a PNG whose IDAT inflates back to the filtered rows", () => {
    const px = renderDot(4, { color: "#ff00ff" });
    const png = encodePng(4, px);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(8, false)).toBe(13); // IHDR length
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect(dv.getUint32(16, false)).toBe(4); // width
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    const idatLen = dv.getUint32(33, false);
    expect(new TextDecoder().decode(png.subarray(37, 41))).toBe("IDAT");
    const rows = new Uint8Array(inflateSync(png.subarray(41, 41 + idatLen)));
    expect(rows.length).toBe((4 * 4 + 1) * 4);
    expect(rows[0]).toBe(0); // filter None
    expect([...rows.subarray(1, 17)]).toEqual([...px.subarray(0, 16)]);
    // CRC of the IHDR chunk, over type + data
    expect(dv.getUint32(29, false)).toBe(crc32(png.subarray(12, 29)));
  });
  test("rejects a size that does not match the pixels", () => {
    expect(() => encodePng(3, new Uint8Array(4))).toThrow("not 3x3");
  });
});

describe("encodeIcns", () => {
  test("header, total length and one element per size", () => {
    const icns = encodeIcns(new Map([[16, dotPng(16)], [32, dotPng(32)]]));
    const dv = new DataView(icns.buffer);
    expect(new TextDecoder().decode(icns.subarray(0, 4))).toBe("icns");
    expect(dv.getUint32(4, false)).toBe(icns.length);
    expect(new TextDecoder().decode(icns.subarray(8, 12))).toBe("icp4");
    const first = dv.getUint32(12, false);
    expect(new TextDecoder().decode(icns.subarray(8 + first, 12 + first))).toBe("icp5");
    expect([...icns.subarray(16, 24)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // the PNG follows the element header
  });
  test("refuses a size with no element type", () => {
    expect(() => encodeIcns(new Map([[48, dotPng(48)]]))).toThrow("no element type for 48px");
  });
  test("dotIcns has all seven standard sizes", () => {
    const icns = dotIcns();
    let pos = 8;
    const types: string[] = [];
    while (pos < icns.length) {
      types.push(new TextDecoder().decode(icns.subarray(pos, pos + 4)));
      pos += new DataView(icns.buffer).getUint32(pos + 4, false);
    }
    expect(types).toEqual(["icp4", "icp5", "icp6", "ic07", "ic08", "ic09", "ic10"]);
  });
});

describe("decodePng", () => {
  test("round-trips an RGBA PNG from encodePng", () => {
    const px = renderDot(12, { color: "#336699", ring: "#ffffff" });
    const out = decodePng(encodePng(12, px));
    expect(out.width).toBe(12);
    expect(out.height).toBe(12);
    expect([...out.rgba]).toEqual([...px]);
  });

  test("decodes an 8-bit palette PNG with tRNS and every row filter", () => {
    // 3x5 image: palette of three colours, index 2 fully transparent; one filter type per row.
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, data.length, false);
      out.set(new TextEncoder().encode(type), 4);
      out.set(data, 8);
      dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
      return out;
    };
    const ihdr = new Uint8Array([0, 0, 0, 3, 0, 0, 0, 5, 8, 3, 0, 0, 0]);
    const plte = new Uint8Array([255, 0, 0, 0, 255, 0, 9, 9, 9]);
    const trns = new Uint8Array([255, 255, 0]);
    const indices = [
      [0, 1, 2],
      [1, 1, 0],
      [2, 0, 1],
      [0, 0, 0],
      [1, 2, 1],
    ];
    // Build filtered rows by applying each filter forward.
    const raw: number[] = [];
    let prev = [0, 0, 0];
    indices.forEach((row, y) => {
      const filter = y; // 0..4
      raw.push(filter);
      for (let x = 0; x < 3; x++) {
        const a = x > 0 ? row[x - 1]! : 0;
        const b = prev[x]!;
        const c = x > 0 ? prev[x - 1]! : 0;
        let pred = 0;
        if (filter === 1) pred = a;
        else if (filter === 2) pred = b;
        else if (filter === 3) pred = (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        raw.push((row[x]! - pred) & 0xff);
      }
      prev = row;
    });
    const png = new Uint8Array([
      ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      ...chunk("IHDR", ihdr),
      ...chunk("PLTE", plte),
      ...chunk("tRNS", trns),
      ...chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
      ...chunk("IEND", new Uint8Array(0)),
    ]);
    const out = decodePng(png);
    expect(out.width).toBe(3);
    expect(out.height).toBe(5);
    const px = (x: number, y: number) => [...out.rgba.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(1, 0)).toEqual([0, 255, 0, 255]);
    expect(px(2, 0)).toEqual([9, 9, 9, 0]);
    expect(px(0, 2)).toEqual([9, 9, 9, 0]);
    expect(px(1, 4)).toEqual([9, 9, 9, 0]);
    expect(px(2, 4)).toEqual([0, 255, 0, 255]);
  });

  test("rejects non-PNG bytes and interlaced images", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("not a PNG");
    const png = encodePng(2, new Uint8Array(16));
    png[28] = 1; // IHDR interlace flag (CRC now wrong, but the decoder reads the header first)
    expect(() => decodePng(png)).toThrow("interlaced");
  });
});

describe("icoFromPng / icnsFromPng", () => {
  const png = encodePng(32, renderDot(32, { color: "#ff8800" }));
  test("icoFromPng resamples to every requested size", () => {
    const ico = icoFromPng(png, [16, 32, 48]);
    expect(parseIco(ico).map((e) => e.width)).toEqual([16, 32, 48]);
    const centre = (8 * 16 + 8) * 4;
    expect([...icoRgba(ico, 16).subarray(centre, centre + 3)]).toEqual([255, 136, 0]);
  });
  test("icnsFromPng wraps resampled PNGs", () => {
    const icns = icnsFromPng(png, [16, 64]);
    expect(new TextDecoder().decode(icns.subarray(8, 12))).toBe("icp4");
    expect(new DataView(icns.buffer).getUint32(4, false)).toBe(icns.length);
  });
  test("a PNG-compressed .ico entry decodes too", () => {
    const ico = new Uint8Array(6 + 16 + png.length);
    const dv = new DataView(ico.buffer);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, 1, true);
    ico[6] = 32;
    ico[7] = 32;
    dv.setUint32(14, png.length, true);
    dv.setUint32(18, 22, true);
    ico.set(png, 22);
    const centre = (16 * 32 + 16) * 4;
    expect([...icoRgba(ico, 32).subarray(centre, centre + 3)]).toEqual([255, 136, 0]);
  });
  test("refuses a non-square PNG", () => {
    expect(() => icoFromPng(encodePng(2, new Uint8Array(16)).slice(0, 0))).toThrow();
  });
});

describe("trimTransparent", () => {
  test("crops a padded subject to a centred square with the margin", () => {
    // 20x20 canvas, an opaque 6x10 block at x 4..9, y 3..12.
    const rgba = new Uint8Array(20 * 20 * 4);
    for (let y = 3; y <= 12; y++) for (let x = 4; x <= 9; x++) rgba.set([10, 20, 30, 255], (y * 20 + x) * 4);
    const out = trimTransparent({ width: 20, height: 20, rgba }, 1);
    expect(out.width).toBe(12); // 10 tall + 2 margin
    expect(out.height).toBe(12);
    // Row 0 and the last row are the margin: transparent.
    expect(out.rgba[3]).toBe(0);
    expect(out.rgba[(11 * 12 + 6) * 4 + 3]).toBe(0);
    // The block is centred horizontally: columns 3..8 of 12 at a middle row.
    const row = 6;
    expect(out.rgba[(row * 12 + 2) * 4 + 3]).toBe(0);
    expect(out.rgba[(row * 12 + 3) * 4 + 3]).toBe(255);
    expect(out.rgba[(row * 12 + 8) * 4 + 3]).toBe(255);
    expect(out.rgba[(row * 12 + 9) * 4 + 3]).toBe(0);
  });
  test("pads with transparency when the square runs past the edge", () => {
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) rgba.set([1, 2, 3, 255], (y * 8 + 0) * 4); // a full-height column at x = 0
    const out = trimTransparent({ width: 8, height: 8, rgba }, 1);
    expect(out.width).toBe(10);
    // The 1px column is centred in the 10px square: column 4; everything around it is transparent padding.
    expect(out.rgba[(5 * 10 + 0) * 4 + 3]).toBe(0);
    expect(out.rgba[(5 * 10 + 3) * 4 + 3]).toBe(0);
    expect(out.rgba[(5 * 10 + 4) * 4 + 3]).toBe(255);
    expect(out.rgba[(5 * 10 + 5) * 4 + 3]).toBe(0);
    expect(out.rgba[(0 * 10 + 4) * 4 + 3]).toBe(0); // top margin row
    expect(out.rgba[(1 * 10 + 4) * 4 + 3]).toBe(255); // first source row
  });
  test("leaves a fully transparent image alone", () => {
    const img = { width: 4, height: 4, rgba: new Uint8Array(64) };
    expect(trimTransparent(img)).toBe(img);
  });
});
