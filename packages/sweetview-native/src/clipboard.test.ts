import { expect, test } from "bun:test";
import { Clipboard } from "./index";

// The system clipboard belongs to whoever is at the machine: the test reads
// the current text first and puts it back afterwards (non-text contents, such
// as an image, are not preserved).
test.if(process.platform === "win32" || process.platform === "darwin")("clipboard round-trips Unicode and empty text, and clears", () => {
  const priorText = Clipboard.readText();
  try {
    // An emoji and a non-BMP musical symbol (U+1D11E) both need surrogate pairs in UTF-16.
    const text = "Sweetview 🥐 日本語 \u{1D11E}\nUnicode";
    Clipboard.writeText(text);
    expect(Clipboard.readText()).toBe(text);
    Clipboard.writeText("");
    expect(Clipboard.readText()).toBe("");
    Clipboard.clear();
    expect(Clipboard.readText()).toBeNull();
  } finally {
    if (priorText === null) Clipboard.clear();
    else Clipboard.writeText(priorText);
  }
});
