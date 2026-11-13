// Wraps the compiled binary in dist/Permissions.app with a usage description
// for every permission the window can ask for. macOS shows the description in
// its prompt, and ends an app that asks without one.
//
//   bun scripts/make-app.ts

import { join } from "node:path";
import { makeMacApp } from "@n1h/sweetview/build";
import { USAGE_DESCRIPTIONS } from "../rows";

const root = join(import.meta.dir, "..");
const app = makeMacApp({
  name: "Permissions",
  bundleId: "dev.mrowr.permissions",
  binary: join(root, "dist", "permissions-macos-arm64"),
  icns: join(root, "build", "AppIcon.icns"),
  outDir: join(root, "dist"),
  plist: USAGE_DESCRIPTIONS,
});
console.log(`wrote ${app}`);
