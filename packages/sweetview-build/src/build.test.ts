// makeMacApp writes files and, on macOS, signs the bundle. The signing tests
// need a real Mach-O binary, so they copy /usr/bin/true. codesign accepts a
// bundle whose executable is a text file, so its failure path is not provoked
// here.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAppIdentity } from "@n1h/sweetview-settings";
import { makeMacApp } from "./build";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "sweetview-make-app-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("makeMacApp", () => {
  test("writes the bundle's files and the plist entries, unsigned when asked", () => {
    const binary = join(dir, "my-app-macos-arm64");
    writeFileSync(binary, "not a Mach-O"); // sign: false, so codesign never sees it
    const app = makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir: join(dir, "dist"), plist: { LSUIElement: true }, sign: false });
    expect(app).toBe(join(dir, "dist", "My App.app"));
    expect(existsSync(join(app, "Contents", "MacOS", "my-app-macos-arm64"))).toBe(true);
    expect(readFileSync(join(app, "Contents", "PkgInfo"), "utf8")).toBe("APPL????");
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>dev.example.my-app</string>");
    expect(plist).toContain("<key>LSUIElement</key><true/>");
  });

  test("writes CFBundleURLTypes from urlSchemes and supports defineAppIdentity", () => {
    const binary = join(dir, "my-app-macos-arm64");
    writeFileSync(binary, "not a Mach-O");
    const identity = defineAppIdentity({
      appId: "dev.example.scheme-app",
      appName: "Scheme App",
      version: "2.3.4",
      urlSchemes: ["My-App", "scheme2"],
    });
    const app = makeMacApp({ identity, binary, outDir: join(dir, "dist"), sign: false });
    expect(app).toBe(join(dir, "dist", "Scheme App.app"));
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>dev.example.scheme-app</string>");
    expect(plist).toContain("<key>CFBundleVersion</key><string>2.3.4</string>");
    expect(plist).toContain("<key>CFBundleURLTypes</key>");
    expect(plist).toContain("<key>CFBundleURLName</key><string>dev.example.scheme-app</string>");
    expect(plist).toContain("<string>my-app</string>");
    expect(plist).toContain("<string>scheme2</string>");
  });

  test("plist.CFBundleURLTypes alongside urlSchemes throws before anything is written", () => {
    const binary = join(dir, "my-app-macos-arm64");
    writeFileSync(binary, "not a Mach-O");
    expect(() =>
      makeMacApp({
        name: "My App",
        bundleId: "dev.example.my-app",
        binary,
        outDir: join(dir, "dist"),
        urlSchemes: ["my-app"],
        plist: { CFBundleURLTypes: "my-app" },
        sign: false,
      }),
    ).toThrow(/CFBundleURLTypes conflicts with urlSchemes/);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

  test("a missing binary throws before anything is written", () => {
    expect(() => makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary: join(dir, "missing"), outDir: join(dir, "dist"), sign: false })).toThrow(/not found/);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

  test("a name with path separators or .. is rejected before anything is written", () => {
    const binary = join(dir, "my-app-macos-arm64");
    writeFileSync(binary, "not a Mach-O");
    for (const name of ["../escape", "sub/My App", "sub\\My App", "..", "a..b"]) {
      expect(() => makeMacApp({ name, bundleId: "dev.example.my-app", binary, outDir: join(dir, "dist"), sign: false })).toThrow(/path separators/);
    }
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(existsSync(join(dir, "escape.app"))).toBe(false);
  });

  test("a failed rebuild leaves the existing bundle intact and no staging folder behind", () => {
    const binary = join(dir, "my-app-macos-arm64");
    writeFileSync(binary, "first build");
    const outDir = join(dir, "dist");
    const app = makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir, sign: false });
    const plistBefore = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    writeFileSync(binary, "second build");
    expect(() => makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir, plist: { Broken: Number.NaN }, sign: false })).toThrow(/Info.plist cannot hold NaN/);
    expect(readFileSync(join(app, "Contents", "MacOS", "my-app-macos-arm64"), "utf8")).toBe("first build");
    expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toBe(plistBefore);
    expect(readdirSync(outDir)).toEqual(["My App.app"]);
  });

  test("a failed swap restores the existing bundle and leaves no staging or backup folder behind", () => {
    const binary = join(dir, "my-app-macos-arm64");
    writeFileSync(binary, "first build");
    const outDir = join(dir, "dist");
    const app = makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir, sign: false });
    writeFileSync(binary, "second build");
    const realRename = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // Only the staging -> bundle swap fails; moving the old bundle aside and back still works.
      if (String(from).includes(".staging-")) throw new Error("rename refused");
      realRename(from, to);
    });
    try {
      expect(() => makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir, sign: false })).toThrow("rename refused");
    } finally {
      rename.mockRestore();
    }
    expect(readFileSync(join(app, "Contents", "MacOS", "my-app-macos-arm64"), "utf8")).toBe("first build");
    expect(readdirSync(outDir)).toEqual(["My App.app"]);
  });

  test("a rebuild replaces the existing bundle", () => {
    const binary = join(dir, "my-app-macos-arm64");
    const outDir = join(dir, "dist");
    writeFileSync(binary, "first build");
    makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir, sign: false });
    writeFileSync(binary, "second build");
    const app = makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir, sign: false });
    expect(readFileSync(join(app, "Contents", "MacOS", "my-app-macos-arm64"), "utf8")).toBe("second build");
    expect(readdirSync(outDir)).toEqual(["My App.app"]);
  });

  test.if(process.platform === "darwin")("signs the bundle ad-hoc by default, with the bundle id as the identifier", () => {
    const binary = join(dir, "my-app-macos-arm64");
    cpSync("/usr/bin/true", binary);
    const app = makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir: join(dir, "dist") });
    const info = spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr; // codesign reports on stderr
    expect(info).toContain("Identifier=dev.example.my-app");
    expect(info).toContain("Signature=adhoc");
    expect(spawnSync("codesign", ["--verify", "--deep", app]).status).toBe(0);
  });

  test.if(process.platform === "darwin")("sign: false leaves the binary's own signature in place", () => {
    const binary = join(dir, "my-app-macos-arm64");
    cpSync("/usr/bin/true", binary); // Apple-signed as com.apple.true; a Bun binary is linker-signed as a.out
    const app = makeMacApp({ name: "My App", bundleId: "dev.example.my-app", binary, outDir: join(dir, "dist"), sign: false });
    const info = spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;
    expect(info).toContain("Identifier=com.apple.true");
    expect(info).not.toContain("dev.example.my-app");
  });
});
