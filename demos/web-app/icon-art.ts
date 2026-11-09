// The demo's icon, drawn: a violet rounded tile with a white four-point
// sparkle (the same idea as the "sparkles" SF Symbol the macOS menu bar
// shows), rendered at each size with 4x4 supersampling so 16px is crisp
// rather than a shrunk 256px. No image library; RGBA out.

const TILE = [0x8b, 0x5c, 0xf6] as const; // violet, top
const TILE_BOTTOM = [0x6d, 0x3f, 0xe0] as const; // a little darker at the bottom
const SPARK = [0xff, 0xff, 0xff] as const;

/** Signed distance to a rounded square centred at 0, half-side `h`, corner radius `r`. */
const roundedSquare = (x: number, y: number, h: number, r: number) => {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/** Inside a four-point sparkle: the astroid |x|^(2/3) + |y|^(2/3) <= R^(2/3), whose concave sides read as a star at any size. */
const inSparkle = (x: number, y: number, cx: number, cy: number, R: number) => {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  return Math.cbrt(dx * dx) + Math.cbrt(dy * dy) <= Math.cbrt(R * R);
};

/** The tile at `size` px, top-down RGBA, straight (not premultiplied) alpha. */
export function renderSparkleTile(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const SS = 4; // subsamples per axis
  const c = size / 2;
  const half = size * 0.46; // the tile fills 92% of the canvas
  const corner = size * 0.21;
  const big = { x: size * 0.46, y: size * 0.54, R: size * 0.3 };
  const small = { x: size * 0.72, y: size * 0.28, R: size * 0.12 };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let spark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (roundedSquare(x - c, y - c, half, corner) <= 0) {
            tile++;
            if (inSparkle(x, y, big.x, big.y, big.R) || inSparkle(x, y, small.x, small.y, small.R)) spark++;
          }
        }
      }
      if (tile === 0) continue;
      const total = SS * SS;
      const alpha = tile / total;
      const s = spark / tile; // share of the covered area that is sparkle
      const t = py / size; // vertical gradient on the tile
      const i = (py * size + px) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const tileColour = TILE[ch]! + (TILE_BOTTOM[ch]! - TILE[ch]!) * t;
        out[i + ch] = Math.round(tileColour * (1 - s) + SPARK[ch]! * s);
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}
