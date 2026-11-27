// Writes build/icon.ico, the window icon main.ts gives its BrowserWindow: the
// web-app demo's sparkle tile (demos/web-app/icon.ts).
//
//   bun scripts/write-icon.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appIco } from "../../web-app/icon";

const dir = join(import.meta.dir, "..", "build");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "icon.ico"), appIco());
console.log(`wrote ${join("build", "icon.ico")}`);
