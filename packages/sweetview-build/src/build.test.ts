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

describe("writeIconFiles", () => {
  // Section 3 row "writeIconFiles": the files a build embeds, written byte for byte.
  test("writes app.ico and AppIcon.icns into a folder it makes, returns their paths in that order, and writes only the files it is given", async () => {
    const { writeIconFiles } = await import("./build");
    const root = mkdtempSync(join(tmpdir(), "sweetview-icons-"));
    try {
      const dir = join(root, "build", "icons");
      const ico = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
      const icns = new Uint8Array([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 8]);
      expect(writeIconFiles(dir, { ico, icns })).toEqual([join(dir, "app.ico"), join(dir, "AppIcon.icns")]);
      expect([...readFileSync(join(dir, "app.ico"))]).toEqual([...ico]);
      expect([...readFileSync(join(dir, "AppIcon.icns"))]).toEqual([...icns]);
      const only = join(root, "only-ico");
      expect(writeIconFiles(only, { ico })).toEqual([join(only, "app.ico")]);
      expect(readdirSync(only)).toEqual(["app.ico"]);
      const none = join(root, "none");
      expect(writeIconFiles(none, {})).toEqual([]);
      expect(readdirSync(none)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshWindowsIcons", () => {
  test("goes through the native binding, with no bun:ffi in the build package", () => {
    for (const file of ["build.ts", "refresh-icons.ts", "make-app.ts", "index.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).not.toMatch(/(from|import\()\s*["']bun:ffi["']|require\(["']bun:ffi["']\)/);
    }
  });

  test.if(process.platform === "win32")("tells the shell that icons changed and returns", async () => {
    const { refreshWindowsIcons } = await import("./build");
    // The binding the build package reaches is the native package's.
    const { refreshShellIcons } = await import("../../sweetview-native/src/shell-icons");
    expect(typeof refreshShellIcons).toBe("function");
    expect(refreshWindowsIcons()).toBeUndefined();
  });

  // What reaches the shell: a window of the test's own registered for SHCNE_ASSOCCHANGED receives
  // the shell's notification after refreshWindowsIcons(), and none in a quiet period before it.
  // Another process can raise the same event (an installer, a file association change), so a
  // quiet period spoilt by one is taken again, up to five times.
  test.if(process.platform === "win32")("refreshWindowsIcons() reaches the shell: a window registered for SHCNE_ASSOCCHANGED receives the notification", async () => {
    const { refreshWindowsIcons } = await import("./build");
    const { watchAssocChanged } = await import("../../sweetview-native/test/win32-shell");
    const { pumpEvents } = await import("@n1h/sweetview-native");
    const pumpFor = async (ms: number, until: () => boolean = () => false) => {
      for (const end = Date.now() + ms; Date.now() < end && !until(); await Bun.sleep(10)) pumpEvents();
      pumpEvents();
    };
    const watch = watchAssocChanged();
    try {
      let quiet = false;
      for (let attempt = 0; attempt < 5 && !quiet; attempt++) {
        const before = watch.assocChanged();
        await pumpFor(400);
        quiet = watch.assocChanged() === before;
      }
      expect(quiet).toBe(true);
      const before = watch.assocChanged();
      expect(refreshWindowsIcons()).toBeUndefined();
      await pumpFor(5000, () => watch.assocChanged() > before);
      expect(watch.assocChanged()).toBeGreaterThan(before);
    } finally {
      watch.dispose();
    }
  }, 30_000);

  test("does nothing on another OS", async () => {
    const { refreshWindowsIcons } = await import("./build");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: process.platform === "win32" ? "darwin" : process.platform });
    try {
      expect(refreshWindowsIcons()).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
