// Internals are not public API (the owner's ruling, D45 in rust-rewrite/DECISIONS.md): no package
// exports an entry point an application is not meant to import, no public entry point re-exports
// an internal one, no package of this repository reaches into another package's unexported module,
// and no page tells an application to import an internal one.
//
// Some internal entries are still exported, because Sweetview's own packages import them across a
// package boundary and no arrangement that exposes nothing exists for those uses yet, or because
// they carry a capability an application has no public call for. Whether and how each is closed is
// the owner's decision (D45). They are listed below by name, each with its reason, with the files
// that import them. Each list must match the tree exactly, so it can neither grow unseen nor keep an
// entry that is gone.
//
// `./darwin/*` and the macOS files stay as they are until the macOS goal (D42): they are listed
// with the entries and their importers. The pages, the guide's rows included, name no internal
// entry on either platform: a macOS row names the public call or says `no public call in 1.0`.
//
// `scan(root)` reads a tree; the tests run it on this repository, and on small trees of their own
// that each hold one way an internal could leak, to prove the scan sees it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { NOT_MODULES, PUBLIC } from "./public-entries";
import { PUBLIC_SURFACE, PUBLIC_VALUES } from "./public-surface";
import { entryFaults, exportEntries, publicEntries, surfaceOf, valueGaps } from "./public-surface-of";

const root = join(import.meta.dir, "..", "..");
const posix = (p: string) => p.split(sep).join("/");

const FACADE = "imported across the boundary by @n1h/sweetview (createApp, WebView, the tabs, the worker wake), and no arrangement that exposes nothing exists for it yet";
const MACOS = "macOS: Sweetview's own AppKit wrappers, until the macOS goal (D42)";

/** Internal entries still exported, pending the owner's decision (D45). */
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

/** The demos' files that reach outside their own demo by relative path (another demo's files, the demos' shared `window-size.ts`), by file: each named, so none is added unseen. */
const DEMO_REACH: Record<string, string[]> = {
  "demos/web-app-electron/scripts/write-icon.ts": ["../../web-app/icon"],
  "demos/web-app-tauri/scripts/write-icon.ts": ["../../web-app/icon"],
  "demos/desktop-pet/app.ts": ["../window-size"],
  "demos/menubar-notify/app.ts": ["../window-size"],
  "demos/web-app/app.ts": ["../window-size"],
};

const SWEETVIEW = new Set(Object.keys(PUBLIC));
/**
 * Each place `text` names an internal entry for an application: a subpath of a Sweetview package
 * that is not one of its public entry points (so a newly named internal entry is caught without
 * naming it here), a shorthand subpath with no package name (`./internal`, `/win32/window`,
 * `./win32/*`), or a package's source file that is not a public entry's file. The macOS
 * entries count as any other.
 */
type MentionContext = { base: string; publicFiles: Set<string>; dirOf: Map<string, string> };
/** Whether `file` (repository-relative) is a source file an application has no entry to: present, under a package's `src/`, not a test, and not the file of a public entry. */
const internalSource = (file: string, ctx: MentionContext) => /\/src\//.test(file) && !/\.test(\.worker)?\.tsx?$/.test(file) && [file, `${file}.ts`, `${file}.tsx`].some((f) => existsSync(join(ctx.base, f)) && !ctx.publicFiles.has(f));
/**
 * Each place `text` names an internal entry for an application:
 * - a subpath of a Sweetview package that is not one of its public entry points, so a newly named
 *   internal entry is caught without naming it here (`@n1h/sweetview/native/shell-icons` too); a
 *   path to a file in the package counts when it is a source file there that is no public entry's
 *   (a path the package no longer has is the old side of the guide);
 * - a shorthand subpath with no package name (`./internal`, `/win32/window`, `./win32/*`);
 * - a package's source file given to import or to run (`from "…/packages/<pkg>/src/…"`,
 *   `bun packages/<pkg>/src/…`) that is no public entry's file.
 */
function internalMentions(text: string, ctx: MentionContext): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/@n1h\/(sweetview(?:-[a-z]+)*)((?:\/[\w*.-]+)+)?/g)) {
    const pkg = `@n1h/${m[1]}`;
    if (!SWEETVIEW.has(pkg)) continue; // not a package of this repository
    const sub = (m[2] ?? "").replace(/\.+$/, "");
    if (/\.\w+$/.test(sub)) {
      const dir = ctx.dirOf.get(pkg);
      if (dir !== undefined && internalSource(`${dir}${sub}`, ctx)) found.push(`${pkg}${sub}`);
    } else if (!PUBLIC[pkg]!.includes(`.${sub}`)) found.push(`${pkg}${sub}`);
  }
  for (const m of text.matchAll(/(?:^|[\s`"'(\[])(\.?\/(?:internal|shell-icons|win32\/[\w*.-]+|darwin\/[\w*.-]+))(?![\w/-])/g)) found.push(m[1]!);
  // Named anywhere: in an import, a command, backticks or a link.
  for (const m of text.matchAll(/(?<![\w-])(packages\/[\w-]+\/src\/[\w/.-]*\w)/g)) {
    if (internalSource(m[1]!, ctx)) found.push(m[1]!);
  }
  return found;
}

/** The cells of a markdown table row, with or without spaces around its bars, a bar inside code kept. */
function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 1; i < line.length; i++) {
    const c = line[i]!;
    if (c === "`") inCode = !inCode;
    if (c === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) cells.push(cur.trim());
  return cells;
}

/** A guide section named by an internal entry of the native package (its Old side). */
const INTERNAL_SECTION = /^`@n1h\/sweetview-native\/(?:internal|shell-icons|win32\/|darwin\/)/;

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "prebuilt", "dist", "target", ".git", "build", "out"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
const code = (n: string) => /\.(m?[jt]sx?)$/.test(n) && !n.endsWith(".d.ts");

type Pkg = { name: string; dir: string; exports: Map<string, string | undefined> };

/** What `scan` finds in a tree; every list is empty for a tree that keeps its internals. */
type Scan = {
  unlistedEntries: string[];
  staleEntries: string[];
  unexported: string[];
  reached: string[];
  pendingImports: Record<string, string[]>;
  demoReach: Record<string, string[]>;
  guideRows: string[];
  guideProse: string[];
  pageLines: string[];
};

function scan(base: string): Scan {
  const packages: Pkg[] = (existsSync(join(base, "packages")) ? readdirSync(join(base, "packages")) : [])
    .filter((d) => existsSync(join(base, "packages", d, "package.json")))
    .map((d) => {
      const dir = join(base, "packages", d);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; exports: Record<string, unknown> };
      const target = (t: unknown) => (typeof t === "string" ? t : typeof t === "object" && t !== null ? ((t as Record<string, unknown>).import ?? (t as Record<string, unknown>).default) : undefined);
      return { name: pkg.name, dir, exports: new Map(Object.entries(pkg.exports).map(([k, t]) => [k, typeof target(t) === "string" ? resolve(dir, target(t) as string) : undefined])) };
    });
  const byName = new Map(packages.map((p) => [p.name, p]));
  const out: Scan = { unlistedEntries: [], staleEntries: [], unexported: [], reached: [], pendingImports: {}, demoReach: {}, guideRows: [], guideProse: [], pageLines: [] };

  // Entries: the documented ones and the pending internal ones, nothing else.
  for (const p of packages) {
    const allowed = new Set([...(PUBLIC[p.name] ?? []), ...Object.keys(PENDING_ENTRIES[p.name] ?? {})]);
    for (const key of p.exports.keys()) if (!allowed.has(key)) out.unlistedEntries.push(`${p.name} ${key}`);
    for (const key of allowed) if (!p.exports.has(key)) out.staleEntries.push(`${p.name} ${key}`);
  }

  // Imports across package boundaries.
  // The package (or demo) a file belongs to: the nearest folder with a package.json, never above
  // packages/<name> or demos/<name>; a file directly under packages/ or demos/ belongs to no package
  // but its own folder, so every relative reach out of it is seen.
  const ownPackage = (file: string) => {
    const [top, name] = posix(relative(base, file)).split("/");
    const limit = name !== undefined && (top === "packages" || top === "demos") && posix(relative(base, dirname(file))) !== top ? join(base, top, name) : dirname(file);
    let d = dirname(file);
    while (!existsSync(join(d, "package.json")) && d !== limit && d.startsWith(limit)) d = dirname(d);
    return d.startsWith(limit) ? d : limit;
  };
  const isTest = (rel: string) => /\.test(\.worker)?\.tsx?$/.test(rel) || /^packages\/[^/]+\/test\//.test(rel);
  const pending = new Set(Object.entries(PENDING_ENTRIES).flatMap(([name, entries]) => Object.keys(entries).map((key) => `${name}${key.slice(1)}`)));
  for (const file of [...walk(join(base, "packages"), code), ...walk(join(base, "demos"), code)]) {
    const rel = posix(relative(base, file));
    for (const m of readFileSync(file, "utf8").matchAll(SPEC)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) {
        if (resolve(dirname(file), spec).startsWith(ownPackage(file) + sep) || isTest(rel)) continue;
        if (/^demos\//.test(rel)) (out.demoReach[rel] ??= []).includes(spec) || out.demoReach[rel]!.push(spec);
        else out.reached.push(`${rel}: ${spec}`);
        continue;
      }
      const s = /^(@n1h\/[^/]+)(\/.+)?$/.exec(spec);
      const p = s && byName.get(s[1]!);
      if (!p) continue; // not a package of this repository
      if (!p.exports.has(`.${s[2] ?? ""}`)) out.unexported.push(`${rel}: ${spec}`);
      if (pending.has(spec)) (out.pendingImports[rel] ??= []).includes(spec) || out.pendingImports[rel]!.push(spec);
    }
  }

  // The source files of public entries, which a page may name (a script run by path).
  const publicFiles = new Set(packages.flatMap((p) => (PUBLIC[p.name] ?? []).map((k) => p.exports.get(k)).filter((f): f is string => f !== undefined).map((f) => posix(relative(base, f)))));

  const ctx: MentionContext = { base, publicFiles, dirOf: new Map(packages.map((p) => [p.name, posix(relative(base, p.dir))])) };

  // The guide: no table cell but an Old one, no heading but a section's name, and no prose line names an internal entry.
  const guidePath = join(base, "docs", "upgrading.md");
  if (existsSync(guidePath)) {
    let section = "";
    for (const line of readFileSync(guidePath, "utf8").split(/\r?\n/)) {
      if (/^#{1,6} /.test(line)) {
        section = line.replace(/^#+ /, "");
        // A section is named by its Old entry or file, alone in backticks: that is the Old side.
        if (!/^`[^`]+`$/.test(section.trim())) for (const m of internalMentions(section, ctx)) out.guideProse.push(`heading "${section}": ${m}`);
        continue;
      }
      if (line.trimStart().startsWith("|")) {
        const cells = cellsOf(line.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c)) || cells[0] === "Old") continue;
        const rest = cells.slice(1).join(" | ");
        const named = internalMentions(rest, ctx);
        if (named.length > 0 || (INTERNAL_SECTION.test(section) && /\bof this subpath\b/.test(rest))) out.guideRows.push(`${section} | ${cells[0]}`);
        continue;
      }
      for (const m of internalMentions(line, ctx)) out.guideProse.push(`${line.trim()}: ${m}`);
      // Under an internal entry's heading, "of this subpath" names that entry.
      if (INTERNAL_SECTION.test(section) && /\bof this subpath\b/.test(line)) out.guideProse.push(`${line.trim()}: of this subpath (${section})`);
    }
  }

  // The other pages, README.md, the packages' and the demos' pages: every line, headings included.
  const pages = [
    ...walk(join(base, "docs"), (n) => n.endsWith(".md")).filter((f) => !f.endsWith(`${sep}upgrading.md`)),
    ...[join(base, "README.md")].filter(existsSync),
    ...walk(join(base, "packages"), (n) => n.endsWith(".md")),
    ...walk(join(base, "demos"), (n) => n.endsWith(".md")),
  ];
  for (const page of pages) {
    const rel = posix(relative(base, page));
    for (const line of readFileSync(page, "utf8").split(/\r?\n/)) for (const m of internalMentions(line, ctx)) out.pageLines.push(`${rel}: ${m}`);
  }
  // The demos' code: each line without its import specifiers (the import checks above cover those).
  const IMPORT_STRING = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])[^"']*\2/g;
  for (const file of walk(join(base, "demos"), code)) {
    const rel = posix(relative(base, file));
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) for (const m of internalMentions(line.replace(IMPORT_STRING, "$1"), ctx)) out.pageLines.push(`${rel}: ${m}`);
  }
  // The packages' doc comments (JSDoc), which an application reads in its editor.
  for (const file of walk(join(base, "packages"), code)) {
    const rel = posix(relative(base, file));
    if (/\.test(\.worker)?\.tsx?$/.test(rel) || /^packages\/[^/]+\/test\//.test(rel)) continue;
    for (const [block] of readFileSync(file, "utf8").matchAll(/\/\*\*[\s\S]*?\*\//g)) for (const m of internalMentions(block, ctx)) out.pageLines.push(`${rel} (doc comment): ${m}`);
  }
  return out;
}

const sorted = (r: Record<string, string[]>) =>
  Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, [...r[k]!].sort()]),
  );

/** A tree of its own under the system temp directory, `files` by path; removed after `run`. */
function withTree<T>(files: Record<string, string | object>, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sweetview-boundaries-"));
  const clean = () => rmSync(dir, { recursive: true, force: true });
  let result: T;
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
    }
    result = run(dir);
  } catch (e) {
    clean();
    throw e;
  }
  if (result instanceof Promise) return result.finally(clean) as T;
  clean();
  return result;
}

/** An entry that is parsed and not loaded here: a script run by path, the types-only entry, or an entry for another OS. */
const parseOnly = (spec: string): boolean =>
  NOT_MODULES.has(spec) || (spec.includes("/darwin/") && process.platform !== "darwin") || (spec.includes("/win32/") && process.platform !== "win32");

describe("internals are not public API (D45)", () => {
  const here = scan(root);

  test("every package exports only its documented entry points, and the pending internal entries listed by name", () => {
    expect({ unlisted: here.unlistedEntries, stale: here.staleEntries }).toEqual({ unlisted: [], stale: [] });
  });

  test("no package or demo imports another package's unexported module, or reaches into its source outside a test", () => {
    expect({ unexported: here.unexported, reached: here.reached }).toEqual({ unexported: [], reached: [] });
  });

  test("the imports of pending internal entries are exactly the listed ones", () => {
    expect(sorted(here.pendingImports)).toEqual(sorted(PENDING_IMPORTS));
  });

  test("the public surface of every public entry point is pinned by name: values and types, as the compiler sees them", () => {
    expect(surfaceOf(root, publicEntries(root))).toEqual(PUBLIC_SURFACE);
  });

  test("every exports target of every package exists and loads; a script, the types-only entry and another OS's entry exist and parse", async () => {
    expect(await entryFaults(exportEntries(root, "all"), parseOnly)).toEqual([]);
  });

  test("every public entry module has exactly its pinned values at run time, and each is a name of the pinned surface", async () => {
    const modules = publicEntries(root).filter((e) => !NOT_MODULES.has(e.spec));
    expect(Object.keys(PUBLIC_VALUES).sort()).toEqual(modules.map((e) => e.spec).sort());
    const unpinned = Object.entries(PUBLIC_VALUES).flatMap(([spec, names]) => names.filter((n) => !(PUBLIC_SURFACE[spec] ?? []).includes(n)).map((n) => `${spec}: ${n}`));
    expect({ gaps: await valueGaps(modules, PUBLIC_VALUES), unpinned }).toEqual({ gaps: [], unpinned: [] });
  });

  test("counter-examples: a missing target, a script that does not parse, a module that does not load, and a pinned value turned type-only, are found", async () => {
    const found = await withTree(
      {
        "packages/sweetview-build/package.json": { name: "@n1h/sweetview-build", exports: { ".": "./src/index.ts", "./gone": "./src/gone.ts", "./make-app": "./src/make-app.ts", "./broken": "./src/broken.ts" } },
        "packages/sweetview-build/src/index.ts": 'export type { Tool } from "./tool";\n',
        "packages/sweetview-build/src/tool.ts": "export class Tool {}\n",
        "packages/sweetview-build/src/make-app.ts": "const = ;\n",
        "packages/sweetview-build/src/broken.ts": 'throw new Error("broken at load");\n',
      },
      async (dir) => {
        const all = exportEntries(dir, "all");
        return {
          faults: await entryFaults(all, (spec) => spec.endsWith("/make-app")),
          gaps: await valueGaps(all.filter((e) => e.spec === "@n1h/sweetview-build"), { "@n1h/sweetview-build": ["Tool"] }),
          // The pin by name alone still passes: the compiler sees `Tool` either way.
          names: surfaceOf(dir, all.filter((e) => e.spec === "@n1h/sweetview-build"), { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler })["@n1h/sweetview-build"],
        };
      },
    );
    expect(found).toEqual({
      faults: ["@n1h/sweetview-build/gone: its target does not exist", "@n1h/sweetview-build/make-app: its target does not parse", "@n1h/sweetview-build/broken: its target does not load (Error: broken at load)"],
      gaps: ["@n1h/sweetview-build: Tool is pinned as a value and is not one at run time"],
      names: ["Tool"],
    });
  });

  test("counter-examples: an internal published under another name, in any of four spellings, changes the pinned surface", () => {
    const internal = "export const wakeNative = () => {};\nexport const scheduleNativeTimeout = () => {};\n";
    const forms: Record<string, string> = {
      "a const alias": 'import { wakeNative } from "./internal";\nexport const wake = wakeNative;\nexport class Window {}\n',
      "a destructured export": 'import * as inside from "./internal";\nexport const { wakeNative: wake } = inside;\nexport class Window {}\n',
      "a default export with no semicolon": 'import * as inside from "./internal";\nexport class Window {}\nexport default inside\n',
      "an export list with no from": 'import { wakeNative } from "./internal";\nexport class Window {}\nexport { wakeNative as wake };\n',
    };
    const options: ts.CompilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true };
    const seen: Record<string, string[]> = {};
    for (const [form, index] of Object.entries(forms)) {
      withTree(
        {
          "packages/sweetview-native/package.json": { name: "@n1h/sweetview-native", exports: { ".": "./src/index.ts", "./internal": "./src/internal.ts" } },
          "packages/sweetview-native/src/index.ts": index,
          "packages/sweetview-native/src/internal.ts": internal,
        },
        (dir) => {
          seen[form] = surfaceOf(dir, publicEntries(dir), options)["@n1h/sweetview-native"]!;
        },
      );
    }
    // Pinned as `["Window"]`, each form adds a name the pin does not have.
    expect(seen).toEqual({
      "a const alias": ["Window", "wake"],
      "a destructured export": ["Window", "wake"],
      "a default export with no semicolon": ["Window", "default"],
      "an export list with no from": ["Window", "wake"],
    });
  });

  test("counter-examples: a file directly under demos/ or in a demo folder with no package.json reaching into a package's source, and a page naming an internal source file in backticks or a link, are found", () => {
    withTree(
      {
        "packages/sweetview-native/package.json": { name: "@n1h/sweetview-native", exports: { ".": "./src/index.ts" } },
        "packages/sweetview-native/src/index.ts": "export const x = 1;\n",
        "packages/sweetview-native/src/win32/menu.ts": "export const buildMenu = () => {};\n",
        "demos/shared.ts": 'import { buildMenu } from "../packages/sweetview-native/src/win32/menu";\n',
        "demos/loose/app.ts": 'import { buildMenu } from "../../packages/sweetview-native/src/win32/menu";\n',
        "docs/page.md": "The menu handle is built in `packages/sweetview-native/src/win32/menu.ts`; see [the menu](../packages/sweetview-native/src/win32/menu.ts).\n",
      },
      (dir) => {
        const found = scan(dir);
        expect({ reach: found.demoReach, pages: found.pageLines }).toEqual({
          reach: { "demos/shared.ts": ["../packages/sweetview-native/src/win32/menu"], "demos/loose/app.ts": ["../../packages/sweetview-native/src/win32/menu"] },
          pages: ["docs/page.md: packages/sweetview-native/src/win32/menu.ts", "docs/page.md: packages/sweetview-native/src/win32/menu.ts"],
        });
      },
    );
  });

  test("the demos' files that reach outside their own demo are exactly the listed ones", () => {
    expect(sorted(here.demoReach)).toEqual(sorted(DEMO_REACH));
  });

  test("counter-examples: each way a page, a doc comment or a demo could name an internal entry is found", () => {
    withTree(
      {
        "packages/sweetview-native/package.json": { name: "@n1h/sweetview-native", exports: { ".": "./src/index.ts", "./hit-regions": "./src/hit-regions.ts" } },
        "packages/sweetview-native/src/index.ts": "/** Reach the timer through `@n1h/sweetview-native/win32/menu`. */\nexport const x = 1;\n",
        "packages/sweetview-native/src/hit-regions.ts": "export const y = 1;\n",
        "packages/sweetview-native/src/win32/menu.ts": "export const buildMenu = () => {};\n",
        "packages/sweetview-native/README.md": "Import `@n1h/sweetview-native/internal` for the hooks.\n",
        "docs/upgrading.md": [
          "## Part B",
          "### `@n1h/sweetview-native/hit-regions`",
          "| Old | Write now | Change |",
          "|---|---|---|",
          '|`a`|`import { a } from "@n1h/sweetview-native/win32/window"`|packed|',
          "#### Using the `@n1h/sweetview-native/internal` entry",
          "Keep importing `./win32/window` as before.",
        ].join("\n"),
        "docs/page.md": ["## Using `./internal`", "Import `@n1h/sweetview/native/shell-icons`, or `@n1h/sweetview-native/secret-entry`.", "Copy it: `import { buildMenu } from \"../packages/sweetview-native/src/win32/menu\"`."].join("\n"),
        "demos/d/package.json": { name: "d" },
        "demos/d/app.ts": 'import { Menu } from "@n1h/sweetview-native"; // the menu handle is in @n1h/sweetview-native/win32/menu\n',
        "demos/d/scripts/drive.ts": 'import { wakeNative } from "../../../packages/sweetview-native/src/internal";\n',
      },
      (dir) => {
        const found = scan(dir);
        expect({ rows: found.guideRows, prose: found.guideProse, pages: [...found.pageLines].sort(), scripts: found.demoReach }).toEqual({
          // A table row written without spaces around its bars.
          rows: ["`@n1h/sweetview-native/hit-regions` | `a`"],
          // A heading that is not a section's name, and a shorthand spelling with no package name.
          prose: ['heading "Using the `@n1h/sweetview-native/internal` entry": @n1h/sweetview-native/internal', "Keep importing `./win32/window` as before.: ./win32/window"],
          pages: [
            // A demo line with a public import and an internal mention.
            "demos/d/app.ts: @n1h/sweetview-native/win32/menu",
            // A heading, the facade's spelling, an entry no list names, and a source path.
            "docs/page.md: ./internal",
            "docs/page.md: @n1h/sweetview-native/secret-entry",
            "docs/page.md: @n1h/sweetview/native/shell-icons",
            "docs/page.md: packages/sweetview-native/src/win32/menu",
            // A package's README and a doc comment of its source.
            "packages/sweetview-native/README.md: @n1h/sweetview-native/internal",
            "packages/sweetview-native/src/index.ts (doc comment): @n1h/sweetview-native/win32/menu",
          ],
          // A demo script reaching into a package's source, not on the list.
          scripts: { "demos/d/scripts/drive.ts": ["../../../packages/sweetview-native/src/internal"] },
        });
      },
    );
  });

  test("counter-example: a macOS row that names a darwin entry, and a shorthand darwin spelling, are found as any other", () => {
    withTree(
      {
        "docs/upgrading.md": [
          "### `@n1h/sweetview-native/darwin/objc`",
          "| Old | Write now | Change |",
          "|---|---|---|",
          '| `sel` | `import { sel } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only |',
          "Keep importing `./darwin/window` on macOS.",
          "| `send` | `import { Window } from \"@n1h/sweetview-native\"`; `new Window(options)` | keep `send` of this subpath |",
          "Keep using `sel` of this subpath.",
        ].join("\n"),
      },
      (dir) => {
        const found = scan(dir);
        expect({ rows: found.guideRows, prose: found.guideProse }).toEqual({
          rows: ["`@n1h/sweetview-native/darwin/objc` | `sel`", "`@n1h/sweetview-native/darwin/objc` | `send`"],
          prose: ["Keep importing `./darwin/window` on macOS.: ./darwin/window", "Keep using `sel` of this subpath.: of this subpath (`@n1h/sweetview-native/darwin/objc`)"],
        });
      },
    );
  });

  test("no row or prose line of docs/upgrading.md names an internal import", () => {
    expect({ rows: here.guideRows, prose: here.guideProse }).toEqual({ rows: [], prose: [] });
  });

  test("no other page, README.md, package README, doc comment or demo names an internal entry", () => {
    expect(here.pageLines).toEqual([]);
  });
});
