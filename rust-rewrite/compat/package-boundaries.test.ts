// Internals are not public API (the owner's ruling, D44 in rust-rewrite/DECISIONS.md): no package
// exports an entry point an application is not meant to import, no package of this repository
// reaches into another package's unexported module, and no page tells an application to import an
// internal one.
//
// Some internal entries are still exported, because Sweetview's own packages import them across a
// package boundary and no arrangement that exposes nothing exists for those uses yet, or because
// they carry a capability an application has no public call for. Whether and how each is closed is
// the owner's decision (D44). They are listed below by name, each with its reason: the entries, the
// files that import them, and the guide rows and page lines that still name them. Each list must
// match the tree exactly, so it can neither grow unseen nor keep an entry that is gone.
//
// `./darwin/*` and the macOS files stay as they are until the macOS goal (D42): they are listed
// with the entries and their importers, and the page checks do not cover them.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..", "..");
const posix = (p: string) => p.split(sep).join("/");

import { PUBLIC } from "./public-entries";

const FACADE = "imported across the boundary by @n1h/sweetview (createApp, WebView, the tabs, the worker wake), and no arrangement that exposes nothing exists for it yet";
const MACOS = "macOS: Sweetview's own AppKit wrappers, until the macOS goal (D42)";

/** Internal entries still exported, pending the owner's decision (D44). */
const PENDING_ENTRIES: Record<string, Record<string, string>> = {
  "@n1h/sweetview-native": {
    "./internal": `${FACADE}; also the macOS facade files; scheduleNativeTimeout is item I3`,
    "./shell-icons": "imported across the boundary by @n1h/sweetview-build (build.ts), inside refreshWindowsIcons(), the public call",
    "./win32/shortcuts": `${FACADE} (the Windows tabs)`,
    "./win32/strip-shared": `${FACADE} (the Windows tabs)`,
    "./win32/tab-window": `${FACADE} (the Windows tabs); getTabFrame and FrameWindow are item I2`,
    "./win32/window": `${FACADE} (asHwnd in the Windows tabs); systemIsDark is item I4`,
    "./win32/menu": "buildMenu and destroyMenu (item I1) have no public call",
    "./darwin/objc": MACOS,
    "./darwin/screen": MACOS,
    "./darwin/tabs": MACOS,
    "./darwin/window": MACOS,
  },
};

/** Every import of a pending entry under packages/ and demos/, by file. */
const PENDING_IMPORTS: Record<string, string[]> = {
  "packages/sweetview/src/app.ts": ["@n1h/sweetview-native/internal"],
  "packages/sweetview/src/webview-host.ts": ["@n1h/sweetview-native/internal"],
  "packages/sweetview/src/worker-wake.ts": ["@n1h/sweetview-native/internal"],
  "packages/sweetview/src/tabs/win-tabs.ts": ["@n1h/sweetview-native/internal", "@n1h/sweetview-native/win32/shortcuts", "@n1h/sweetview-native/win32/strip-shared", "@n1h/sweetview-native/win32/tab-window", "@n1h/sweetview-native/win32/window"],
  "packages/sweetview/src/tabs/win-webview2.ts": ["@n1h/sweetview-native/internal", "@n1h/sweetview-native/win32/shortcuts"],
  "packages/sweetview-build/src/build.ts": ["@n1h/sweetview-native/shell-icons"],
  // macOS files (D42).
  "packages/sweetview/src/tabs/darwin-tabs.ts": ["@n1h/sweetview-native/darwin/objc", "@n1h/sweetview-native/darwin/screen", "@n1h/sweetview-native/darwin/tabs", "@n1h/sweetview-native/darwin/window", "@n1h/sweetview-native/internal"],
  "packages/sweetview/src/tabs/darwin-webview.ts": ["@n1h/sweetview-native/darwin/objc", "@n1h/sweetview-native/darwin/tabs", "@n1h/sweetview-native/internal"],
  "packages/sweetview/src/app.test.ts": ["@n1h/sweetview-native/darwin/objc"],
  "packages/sweetview/test/fixtures/webview-file-drop.darwin.ts": ["@n1h/sweetview-native/darwin/objc", "@n1h/sweetview-native/internal"],
  "demos/native-tabs/scripts/mac-capture.ts": ["@n1h/sweetview-native/darwin/objc"],
  "demos/native-tabs/scripts/mac-drive.ts": ["@n1h/sweetview-native/darwin/objc", "@n1h/sweetview-native/internal"],
};

// None: every guide row and page line that sent an application to an internal now names the public
// call, or says that 1.0 has no public call for the capability (the owner's ruling, D44). A row or line
// added back fails the two tests at the end.
const PENDING_ROWS: Record<string, string> = {};
const GUIDE_PROSE: Record<string, string> = {};
const PAGE_LINES: Record<string, string> = {};

/** An internal subpath of either package, as a page would name it. `/darwin/` is left to the macOS goal (D42). */
const INTERNAL_SPEC = /@n1h\/sweetview(?:-native\/(?:internal|shell-icons|win32\/[\w*-]+)|\/native\/(?:internal|win32\/[\w*-]+))/;

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "prebuilt", "dist", "target", ".git", "build", "out"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

const packageDirs = readdirSync(join(root, "packages")).filter((d) => existsSync(join(root, "packages", d, "package.json")));
const exportsOf = new Map<string, Set<string>>(
  packageDirs.map((d) => {
    const pkg = JSON.parse(readFileSync(join(root, "packages", d, "package.json"), "utf8")) as { name: string; exports: Record<string, unknown> };
    return [pkg.name, new Set(Object.keys(pkg.exports))];
  }),
);

/** The folder of the package (or demo) a file belongs to: the nearest one with a package.json. */
const ownPackage = (file: string) => {
  let d = dirname(file);
  while (!existsSync(join(d, "package.json"))) d = dirname(d);
  return d;
};
/** A test of this repository, or a demo's script, may import another package's source by relative path. */
const mayReachSource = (file: string) => {
  const rel = posix(relative(root, file));
  return /\.test(\.worker)?\.tsx?$/.test(rel) || /^packages\/[^/]+\/test\//.test(rel) || /^demos\/.+\/scripts\//.test(rel);
};
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function imports(): { file: string; spec: string }[] {
  const files = [...walk(join(root, "packages"), (n) => /\.(m?[jt]sx?)$/.test(n) && !n.endsWith(".d.ts")), ...walk(join(root, "demos"), (n) => /\.(m?[jt]sx?)$/.test(n) && !n.endsWith(".d.ts"))];
  return files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(SPEC)].map((m) => ({ file, spec: m[1]! })));
}

describe("internals are not public API (D44)", () => {
  test("every package exports only its documented entry points, and the pending internal entries listed by name", () => {
    const unlisted: string[] = [];
    const stale: string[] = [];
    for (const [name, keys] of exportsOf) {
      const allowed = new Set([...(PUBLIC[name] ?? []), ...Object.keys(PENDING_ENTRIES[name] ?? {})]);
      for (const key of keys) if (!allowed.has(key)) unlisted.push(`${name} ${key}`);
      for (const key of allowed) if (!keys.has(key)) stale.push(`${name} ${key}`);
    }
    expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
  });

  test("no package or demo imports another package's unexported module, or reaches into its source outside a test", () => {
    const unexported: string[] = [];
    const reached: string[] = [];
    for (const { file, spec } of imports()) {
      const rel = posix(relative(root, file));
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const own = ownPackage(file);
        if (!target.startsWith(own + sep) && !mayReachSource(file)) reached.push(`${rel}: ${spec}`);
        continue;
      }
      const m = /^(@n1h\/[^/]+)(\/.+)?$/.exec(spec);
      if (!m || !exportsOf.has(m[1]!)) continue; // not a package of this repository
      if (!exportsOf.get(m[1]!)!.has(`.${m[2] ?? ""}`)) unexported.push(`${rel}: ${spec}`);
    }
    expect({ unexported, reached }).toEqual({ unexported: [], reached: [] });
  });

  test("the imports of pending internal entries are exactly the listed ones", () => {
    const pending = new Set(Object.entries(PENDING_ENTRIES).flatMap(([name, entries]) => Object.keys(entries).map((key) => `${name}${key.slice(1)}`)));
    const seen: Record<string, string[]> = {};
    for (const { file, spec } of imports()) {
      if (!pending.has(spec)) continue;
      const rel = posix(relative(root, file));
      (seen[rel] ??= []).includes(spec) || seen[rel]!.push(spec);
    }
    const sorted = (r: Record<string, string[]>) =>
      Object.fromEntries(
        Object.keys(r)
          .sort()
          .map((k) => [k, [...r[k]!].sort()]),
      );
    expect(sorted(seen)).toEqual(sorted(PENDING_IMPORTS));
  });

  test("no row of docs/upgrading.md names an internal import, except the listed rows on the owner's list", () => {
    const lines = readFileSync(join(root, "docs", "upgrading.md"), "utf8").split(/\r?\n/);
    const rows: string[] = [];
    const prose: string[] = [];
    let section = "";
    let inTable = false;
    for (const line of lines) {
      if (/^#{2,4} /.test(line)) {
        section = line.replace(/^#+ /, "");
        inTable = false;
        continue;
      }
      if (/^\| Old \| Write now \| Change \|/.test(line)) {
        inTable = true;
        continue;
      }
      if (inTable && line.startsWith("|")) {
        const cells = line.split(" | ");
        const old = cells[0]!.replace(/^\| /, "");
        const rest = cells.slice(1).join(" | ");
        const internalSection = INTERNAL_SPEC.test(section);
        if (INTERNAL_SPEC.test(rest) || (internalSection && /\bof this subpath\b/.test(rest))) rows.push(`${section} | ${old}`);
        continue;
      }
      inTable = false;
      if (INTERNAL_SPEC.test(line)) prose.push(line.trim());
    }
    const unlisted = rows.filter((r) => !(r in PENDING_ROWS));
    const stale = Object.keys(PENDING_ROWS).filter((r) => !rows.includes(r));
    const unlistedProse = prose.filter((l) => !(l in GUIDE_PROSE));
    const staleProse = Object.keys(GUIDE_PROSE).filter((l) => !prose.includes(l));
    expect({ unlisted, stale, unlistedProse, staleProse }).toEqual({ unlisted: [], stale: [], unlistedProse: [], staleProse: [] });
  });

  test("no other page, README.md or demo names an internal subpath, except the listed lines on the owner's list", () => {
    const pages = [...walk(join(root, "docs"), (n) => n.endsWith(".md")).filter((f) => !f.endsWith(`${sep}upgrading.md`)), join(root, "README.md"), ...walk(join(root, "demos"), (n) => n.endsWith(".md"))];
    const found: string[] = [];
    for (const page of pages) {
      const rel = posix(relative(root, page));
      for (const line of readFileSync(page, "utf8").split(/\r?\n/)) if (INTERNAL_SPEC.test(line)) found.push(`${rel}: ${line.trim()}`);
    }
    // The demos' code: covered by the import tests above; their text other than imports is checked here.
    for (const file of walk(join(root, "demos"), (n) => /\.(m?[jt]sx?)$/.test(n))) {
      const rel = posix(relative(root, file));
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        if (INTERNAL_SPEC.test(line) && !/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@n1h\//.test(line)) found.push(`${rel}: ${line.trim()}`);
      }
    }
    const unlisted = found.filter((l) => !(l in PAGE_LINES));
    const stale = Object.keys(PAGE_LINES).filter((l) => !found.includes(l));
    expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
  });
});
