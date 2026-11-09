// Writes the icon files the build embeds: build/app.ico for the Windows
// executable (`--windows-icon`) and build/AppIcon.icns for the .app bundle
// (`just mac-app` hands it to sweetview's make-app script). Both are the cat (icon.ts).
//
//   bun scripts/write-icons.ts

import { join } from "node:path";
import { writeIconFiles } from "@n1h/sweetview/build";
import { appIcns, appIco } from "../icon";

console.log(`wrote ${writeIconFiles(join(import.meta.dir, "..", "build"), { ico: appIco(), icns: appIcns() }).join(" and ")}`);
