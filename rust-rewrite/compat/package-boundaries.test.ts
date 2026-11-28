// Internals are not public API (the owner's ruling, D44 in rust-rewrite/DECISIONS.md): no package
// exports an entry point an application is not meant to import, no public entry point re-exports
// an internal one, no package of this repository reaches into another package's unexported module,
// and no page tells an application to import an internal one.
//
// Some internal entries are still exported, because Sweetview's own packages import them across a
// package boundary and no arrangement that exposes nothing exists for those uses yet, or because
// they carry a capability an application has no public call for. Whether and how each is closed is
// the owner's decision (D44). They are listed below by name, each with its reason, with the files
// that import them. Each list must match the tree exactly, so it can neither grow unseen nor keep an
// entry that is gone.
//
// `./darwin/*` and the macOS files stay as they are until the macOS goal (D42): they are listed
// with the entries and their importers, and the page checks do not cover them.
//
// `scan(root)` reads a tree; the tests run it on this repository, and on small trees of their own
// that each hold one way an internal could leak, to prove the scan sees it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PUBLIC } from "./public-entries";

const root = join(import.meta.dir, "..", "..");
const posix = (p: string) => p.split(sep).join("/");

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

/** An internal subpath of either package, as a page would name it. `/darwin/` is left to the macOS goal (D42). */
const INTERNAL_SPEC = /@n1h\/sweetview(?:-native\/(?:internal|shell-icons|win32\/[\w*-]+)|\/native\/(?:internal|win32\/[\w*-]+))/;

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
  const out: Scan = { unlistedEntries: [], staleEntries: [], unexported: [], reached: [], pendingImports: {}, reexports: [], guideRows: [], guideProse: [], pageLines: [] };

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
  const mayReachSource = (rel: string) => /\.test(\.worker)?\.tsx?$/.test(rel) || /^packages\/[^/]+\/test\//.test(rel) || /^demos\/.+\/scripts\//.test(rel);
  const pending = new Set(Object.entries(PENDING_ENTRIES).flatMap(([name, entries]) => Object.keys(entries).map((key) => `${name}${key.slice(1)}`)));
  for (const file of [...walk(join(base, "packages"), code), ...walk(join(base, "demos"), code)]) {
    const rel = posix(relative(base, file));
    for (const m of readFileSync(file, "utf8").matchAll(SPEC)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) {
        if (!resolve(dirname(file), spec).startsWith(ownPackage(file) + sep) && !mayReachSource(rel)) out.reached.push(`${rel}: ${spec}`);
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

  // The guide: no row or prose line names an internal import.
  const guidePath = join(base, "docs", "upgrading.md");
  if (existsSync(guidePath)) {
    let section = "";
    let inTable = false;
    for (const line of readFileSync(guidePath, "utf8").split(/\r?\n/)) {
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
        if (INTERNAL_SPEC.test(rest) || (INTERNAL_SPEC.test(section) && /\bof this subpath\b/.test(rest))) out.guideRows.push(`${section} | ${old}`);
        continue;
      }
      inTable = false;
      if (INTERNAL_SPEC.test(line)) out.guideProse.push(line.trim());
    }
  }

  // The other pages, README.md, the demos' pages and the demos' code other than its imports.
  const pages = [...walk(join(base, "docs"), (n) => n.endsWith(".md")).filter((f) => !f.endsWith(`${sep}upgrading.md`)), ...[join(base, "README.md")].filter(existsSync), ...walk(join(base, "demos"), (n) => n.endsWith(".md"))];
  for (const page of pages) {
    const rel = posix(relative(base, page));
    for (const line of readFileSync(page, "utf8").split(/\r?\n/)) if (INTERNAL_SPEC.test(line)) out.pageLines.push(`${rel}: ${line.trim()}`);
  }
  for (const file of walk(join(base, "demos"), code)) {
    const rel = posix(relative(base, file));
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (INTERNAL_SPEC.test(line) && !/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@n1h\//.test(line)) out.pageLines.push(`${rel}: ${line.trim()}`);
    }
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

describe("internals are not public API (D44)", () => {
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

  test("no row or prose line of docs/upgrading.md names an internal import", () => {
    expect({ rows: here.guideRows, prose: here.guideProse }).toEqual({ rows: [], prose: [] });
  });

  test("no other page, README.md or demo names an internal subpath", () => {
    expect(here.pageLines).toEqual([]);
  });
});
