#!/usr/bin/env bun
// The macOS .app bundle around a compiled sweetview binary, from the command
// line. The same thing as a function is `makeMacApp` in "@n1h/sweetview/build".
// Runs on any OS: it only writes files.
//
//   bun src/make-app.ts --name "My App" --bundle-id dev.example.my-app \
//     --binary dist/my-app-macos-arm64 --out dist [--icns build/AppIcon.icns] \
//     [--version 1.0.0] [--min-macos 11.0] [--plist LSUIElement=true] [--sign "Developer ID Application: …" | --no-sign]

import { parseArgs } from "node:util";
import { makeMacApp, type MacAppOptions } from "./build";

const USAGE = `usage: bun src/make-app.ts --name <name> --bundle-id <id> --binary <path> --out <dir>
                          [--icns <path>] [--version <x.y.z>] [--min-macos <x.y>] [--plist <Key=value>]...
                          [--sign <identity> | --no-sign]

  --name       what Finder and the Dock show; the bundle is <name>.app
  --bundle-id  reverse-DNS id (dev.example.my-app); macOS notifications need one
  --binary     the compiled macOS executable (bun build --compile --target=bun-darwin-arm64)
  --out        folder the bundle is written into; an existing <name>.app there is replaced
  --icns       the .icns for Finder and the Dock (sweetview/build writeIconFiles); stock icon without it
  --version    CFBundleVersion and CFBundleShortVersionString (default 0.1.0)
  --min-macos  LSMinimumSystemVersion (default 11.0)
  --plist      an extra Info.plist entry; true/false and numbers are typed, anything else is a string. Repeatable
  --sign       the codesign identity (default: ad-hoc on macOS, none elsewhere); an unsigned bundle shows no notifications
  --no-sign    leave the bundle unsigned
`;

const SPEC = {
  name: { type: "string" },
  "bundle-id": { type: "string" },
  binary: { type: "string" },
  out: { type: "string" },
  icns: { type: "string" },
  version: { type: "string" },
  "min-macos": { type: "string" },
  plist: { type: "string", multiple: true },
  sign: { type: "string" },
  "no-sign": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: SPEC, strict: true }).values;
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    return undefined;
  }
}

function main(argv: string[]): number {
  const args = parse(argv);
  if (args === undefined) return 2;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const missing = (["name", "bundle-id", "binary", "out"] as const).filter((k) => args[k] === undefined || args[k] === "");
  if (missing.length > 0) {
    console.error(`missing: ${missing.map((k) => `--${k}`).join(", ")}`);
    console.error(USAGE);
    return 2;
  }

  if (args.sign !== undefined && args["no-sign"]) {
    console.error("--sign and --no-sign exclude each other");
    return 2;
  }

  const plist: Record<string, string | number | boolean> = {};
  for (const entry of args.plist ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      console.error(`--plist wants Key=value, got ${JSON.stringify(entry)}`);
      return 2;
    }
    const key = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);
    plist[key] = raw === "true" ? true : raw === "false" ? false : raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }

  const options: MacAppOptions = {
    name: args.name!,
    bundleId: args["bundle-id"]!,
    binary: args.binary!,
    outDir: args.out!,
    ...(args.icns !== undefined ? { icns: args.icns } : {}),
    ...(args.version !== undefined ? { version: args.version } : {}),
    ...(args["min-macos"] !== undefined ? { minimumSystemVersion: args["min-macos"] } : {}),
    ...(Object.keys(plist).length > 0 ? { plist } : {}),
    ...(args["no-sign"] ? { sign: false } : args.sign !== undefined ? { sign: args.sign } : {}),
  };
  try {
    console.log(`wrote ${makeMacApp(options)}`);
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
