import { expect, test } from "bun:test";
import { Clipboard } from "./index";

test.if(process.platform === "win32")("clipboard round-trips Unicode and empty text, and clears", () => {
  const priorText = Clipboard.readText();
  try {
    Clipboard.writeText("Sweetview 🥐 日本語\nUnicode");
    expect(Clipboard.readText()).toBe("Sweetview 🥐 日本語\nUnicode");
    Clipboard.writeText("");
    expect(Clipboard.readText()).toBe("");
    Clipboard.clear();
    expect(Clipboard.readText()).toBeNull();
  } finally {
    if (priorText === null) Clipboard.clear();
    else Clipboard.writeText(priorText);
  }
});
