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
// with the entries and their importers. The page checks leave the macOS entries out on purpose:
// macOS runs the path of tag `pre-rust-rewrite` until its goal, which rewrites the guide's Darwin
// rows. Those rows are pinned by name and by a digest of each (darwin-rows.ts), so a new or changed
// Darwin row is seen.
//
// `scan(root)` reads a tree; the tests run it on this repository, and on small trees of their own
// that each hold one way an internal could leak, to prove the scan sees it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { DARWIN_ROWS } from "./darwin-rows";
import { PUBLIC } from "./public-entries";

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
 * (`/darwin/`) entries are left to the macOS goal (D42).
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
 * The macOS (`/darwin/`) entries are left to the macOS goal (D42).
 */
function internalMentions(text: string, ctx: MentionContext): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/@n1h\/(sweetview(?:-[a-z]+)*)((?:\/[\w*.-]+)+)?/g)) {
    const pkg = `@n1h/${m[1]}`;
    if (!SWEETVIEW.has(pkg)) continue; // not a package of this repository
    const sub = (m[2] ?? "").replace(/\.+$/, "");
    if (sub.startsWith("/darwin/")) continue;
    if (/\.\w+$/.test(sub)) {
      const dir = ctx.dirOf.get(pkg);
      if (dir !== undefined && internalSource(`${dir}${sub}`, ctx)) found.push(`${pkg}${sub}`);
    } else if (!PUBLIC[pkg]!.includes(`.${sub}`)) found.push(`${pkg}${sub}`);
  }
  for (const m of text.matchAll(/(?:^|[\s`"'(\[])(\.?\/(?:internal|shell-icons|win32\/[\w*.-]+))(?![\w/-])/g)) found.push(m[1]!);
  for (const m of text.matchAll(/(?:(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'][^"']*?|\bbun\s+(?:run\s+)?)(packages\/[\w-]+\/src\/[\w/.-]*\w)/g)) {
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
const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
const code = (n: string) => /\.(m?[jt]sx?)$/.test(n) && !n.endsWith(".d.ts");

type Pkg = { name: string; dir: string; exports: Map<string, string | undefined> };

/** What `scan` finds in a tree; every list is empty for a tree that keeps its internals. */
type Scan = {
  unlistedEntries: string[];
  staleEntries: string[];
  unexported: string[];
  reached: string[];
  pendingImports: Record<string, string[]>;
  reexports: string[];
  demoReach: Record<string, string[]>;
  darwinRows: Record<string, string>;
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
  const out: Scan = { unlistedEntries: [], staleEntries: [], unexported: [], reached: [], pendingImports: {}, reexports: [], demoReach: {}, darwinRows: {}, guideRows: [], guideProse: [], pageLines: [] };

  // Entries: the documented ones and the pending internal ones, nothing else.
  for (const p of packages) {
    const allowed = new Set([...(PUBLIC[p.name] ?? []), ...Object.keys(PENDING_ENTRIES[p.name] ?? {})]);
    for (const key of p.exports.keys()) if (!allowed.has(key)) out.unlistedEntries.push(`${p.name} ${key}`);
    for (const key of allowed) if (!p.exports.has(key)) out.staleEntries.push(`${p.name} ${key}`);
  }

  // Imports across package boundaries.
  const ownPackage = (file: string) => {
    let d = dirname(file);
    while (!existsSync(join(d, "package.json")) && d !== dirname(d)) d = dirname(d);
    return d;
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

  // Re-exports: no public entry module reaches an internal entry's module through `export … from`.
  const resolveFrom = (from: string, spec: string): string | undefined => {
    if (spec.startsWith(".")) {
      const t = resolve(dirname(from), spec);
      return [t, `${t}.ts`, `${t}.tsx`, join(t, "index.ts")].find((f) => existsSync(f) && statSync(f).isFile());
    }
    const s = /^(@n1h\/[^/]+)(\/.+)?$/.exec(spec);
    return s ? byName.get(s[1]!)?.exports.get(`.${s[2] ?? ""}`) : undefined;
  };
  const internalFiles = new Map<string, string>();
  for (const p of packages) for (const [key, file] of p.exports) if (file && !(PUBLIC[p.name] ?? []).includes(key)) internalFiles.set(file, `${p.name}${key.slice(1)}`);
  for (const p of packages) {
    for (const key of PUBLIC[p.name] ?? []) {
      const entry = p.exports.get(key);
      if (!entry || !existsSync(entry)) continue;
      const seen = new Set<string>();
      const visit = (file: string, chain: string[]) => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const m of readFileSync(file, "utf8").matchAll(REEXPORT)) {
          const next = resolveFrom(file, m[1]!);
          if (!next || !existsSync(next)) continue;
          const via = [...chain, posix(relative(base, next))];
          if (internalFiles.has(next)) out.reexports.push(`${p.name}${key.slice(1)} re-exports ${internalFiles.get(next)}: ${via.join(" -> ")}`);
          else visit(next, via);
        }
      };
      visit(entry, [posix(relative(base, entry))]);
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
        // A macOS row (D42): pinned, not checked.
        if (section.includes("/darwin/") || rest.includes("/darwin/")) {
          out.darwinRows[`${section} | ${cells[0]}`] = createHash("sha256").update(line).digest("hex").slice(0, 12);
          continue;
        }
        const named = internalMentions(rest, ctx);
        if (named.length > 0 || (/^`@n1h\/sweetview-native\/(internal|win32\/)/.test(section) && /\bof this subpath\b/.test(rest))) out.guideRows.push(`${section} | ${cells[0]}`);
        continue;
      }
      for (const m of internalMentions(line, ctx)) out.guideProse.push(`${line.trim()}: ${m}`);
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
function withTree(files: Record<string, string | object>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sweetview-boundaries-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  test("no public entry module re-exports from an internal entry's module, directly or through others", () => {
    expect(here.reexports).toEqual([]);
  });

  test("counter-example: a public index re-exporting from the internal entry, and a facade entry re-exporting that index, are both found", () => {
    withTree(
      {
        "packages/sweetview-native/package.json": { name: "@n1h/sweetview-native", exports: { ".": "./src/index.ts", "./internal": "./src/internal.ts" } },
        "packages/sweetview-native/src/index.ts": 'export { wakeNative as wake } from "./internal";\n',
        "packages/sweetview-native/src/internal.ts": "export const wakeNative = () => {};\n",
        "packages/sweetview/package.json": { name: "@n1h/sweetview", exports: { "./native": "./src/native/index.ts" } },
        "packages/sweetview/src/native/index.ts": 'export * from "@n1h/sweetview-native";\n',
      },
      (dir) => {
        expect(scan(dir).reexports.sort()).toEqual([
          "@n1h/sweetview-native re-exports @n1h/sweetview-native/internal: packages/sweetview-native/src/index.ts -> packages/sweetview-native/src/internal.ts",
          "@n1h/sweetview/native re-exports @n1h/sweetview-native/internal: packages/sweetview/src/native/index.ts -> packages/sweetview-native/src/index.ts -> packages/sweetview-native/src/internal.ts",
        ]);
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

  test("the guide's macOS rows, left out of these checks until the macOS goal (D42), are exactly the pinned ones, unchanged", () => {
    expect(here.darwinRows).toEqual(DARWIN_ROWS);
  });

  test("counter-example: a new macOS row and a changed one are seen", () => {
    const first = Object.keys(DARWIN_ROWS)[0]!;
    const [section, old] = first.split(" | ") as [string, string];
    const added = `${section} | \`addedRow\``;
    withTree(
      {
        "docs/upgrading.md": [
          `### ${section}`,
          "| Old | Write now | Change |",
          "|---|---|---|",
          `| ${old} | \`import { x } from "@n1h/sweetview-native/darwin/objc"\` | changed |`,
          '| `addedRow` | `import { addedRow } from "@n1h/sweetview-native/darwin/objc"` | new |',
        ].join("\n"),
      },
      (dir) => {
        const found = scan(dir).darwinRows;
        expect({ added: added in found && !(added in DARWIN_ROWS), changed: found[first] !== undefined && found[first] !== DARWIN_ROWS[first] }).toEqual({ added: true, changed: true });
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
