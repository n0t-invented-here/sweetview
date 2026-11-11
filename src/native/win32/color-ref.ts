// Pure: no Win32 symbols are loaded here, so it can be imported and tested on any OS.

/** `#rrggbb` -> COLORREF (0x00bbggrr). */
export const colorRef = (hex: string): number => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`sweetnative: color key must be #rrggbb, got ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
};
