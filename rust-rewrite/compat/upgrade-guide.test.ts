// R2: every row of docs/upgrading.md is exercised here. This test reads the
// guide itself, so a row cannot drift from what it checks.
//
// The convention of the "Write now" column (the guide's "Reading the tables"
// says the same for a person):
//
// A table is any markdown table whose header row is exactly
// `| Old | Write now | Change |`. In each row, the code spans of the second
// column are read in order.
//
// The first span is one of:
//   import { Name } from "module"        a value export; the module is imported
//                                        and must export Name (not undefined)
//   import type { Name } from "module"   a type export; upgrade-types.ts must
//                                        import it, and tsc proves it there
//   import { dlopen } from "bun:ffi"     the application's own table; the next
//                                        span is dlopen("lib.dll", { … }) and the
//                                        fixtures/own-ffi.ts child opens that
//                                        library and calls it inside Sweetview's
//                                        event loop
//   type Name = …                        a declaration the application keeps in
//                                        its own code; upgrade-types.ts must
//                                        contain it verbatim
//
// Every later span is a check on Name:
//   new Name(…)          a class: a function with a prototype
//   Name(…)              a function
//   Name.member…         a static member, an enum member or an object property
//   Name#member…         an instance member: on the prototype at run time, and
//                        upgrade-types.ts has `Alias["member"]` for it, so tsc
//                        proves fields and type members too
//   Name === literal     a constant's value; `Name.member === literal` for an
//                        enum member
// Any other span fails the test, so the convention holds.
//
// A module under `/darwin/` is checked from its source on other platforms,
// because importing it there loads macOS libraries.
//
// What a row's change is more than a rename of is run for real in
// behaviour.test.ts.
//
// And every row runs (R2): the spans after the import name the row's
// targets (`new Name`, `Name.member`, `Name#member`, a call `Name`, a
// constant `Name` or `Name.member`; a row with nothing after its import is
// the export itself), and fixtures/row-runners.ts has a runner for each,
// which calls it once in its new form with real arguments and checks what
// comes back. A row added to the guide whose target has no runner fails
// "every row's new form has a runner". Runners that need the desktop run in
// fixtures/rows-desktop.ts, a process of its own. Type rows (`import type`,
// `type X = …`) are checked by tsc through upgrade-types.ts; rows of a
// `/darwin/` module are macOS-only and are not run on Windows.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROWS_OF_ANOTHER_CHANGE, RUNNERS, scratch } from "./fixtures/row-runners";

const root = join(import.meta.dir, "..", "..");
const guidePath = join(root, "docs", "upgrading.md");
const typesPath = join(import.meta.dir, "upgrade-types.ts");
const guide = readFileSync(guidePath, "utf8");
const typesFile = readFileSync(typesPath, "utf8");

type Row = { section: string; line: number; old: string; write: string; change: string; spans: string[] };

/** The Write now of a row whose capability 1.0 has no public call for: no code (D45). */
const NO_PUBLIC_CALL = "no public call in 1.0";

function splitCells(line: string): string[] {
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
  return cells;
}

function parseGuide(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split(/\r?\n/);
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{2,4} /.test(line)) section = line.replace(/^#+ /, "");
    if (line.trim() !== "| Old | Write now | Change |") continue;
    for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) {
      const [old, write, change] = splitCells(lines[i]!);
      rows.push({ section, line: i + 1, old: old ?? "", write: write ?? "", change: change ?? "", spans: [...(write ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!) });
    }
  }
  return rows;
}

const rows = parseGuide(guide);

// Package entry points, for reading a module's source without importing it.
const entryFiles = new Map<string, string>();
for (const dir of readdirSync(join(root, "packages"))) {
  const pkgPath = join(root, "packages", dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target === "string") entryFiles.set(sub === "." ? pkg.name : pkg.name + sub.slice(1), join(root, "packages", dir, target));
  }
}
const sourceExports = (source: string): Set<string> => {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  return names;
};

/** The alias upgrade-types.ts gives `Name` from `module`. */
const typeAlias = (name: string, module: string) => `${name}__${module.replace(/^@n1h\//, "").replace(/\//g, "__").replace(/[^A-Za-z0-9_]/g, "_")}`;

const modules = new Map<string, Promise<Record<string, unknown>>>();
const load = (spec: string) => {
  let p = modules.get(spec);
  if (!p) modules.set(spec, (p = import(spec) as Promise<Record<string, unknown>>));
  return p;
};

const IMPORT = /^import (type )?\{ ([\w$]+) \} from "([^"]+)"$/;
const literal = (text: string): unknown => new Function(`return (${text});`)();

/** Checks one row; returns what is wrong with it, or nothing. Collects the libraries of own-table rows. */
async function checkRow(row: Row, ownLibraries: Set<string>): Promise<string[]> {
  const problems: string[] = [];
  if (row.write === NO_PUBLIC_CALL) return [];
  const [first, ...checks] = row.spans;
  if (!first) return ["no code in the Write now column"];

  if (first.startsWith("type ")) {
    if (!typesFile.includes(first)) problems.push(`upgrade-types.ts must contain: export ${first};`);
    if (checks.length) problems.push("a declaration row has no further spans");
    return problems;
  }
  const m = IMPORT.exec(first);
  if (!m) return [`the first span is not an import or a declaration: ${first}`];
  const [, isType, name, spec] = m as unknown as [string, string | undefined, string, string];

  if (spec === "bun:ffi") {
    const lib = /^dlopen\("([\w.-]+\.dll)", \{ … \}\)$/.exec(checks[0] ?? "");
    if (name !== "dlopen" || !lib || checks.length !== 1) return [`an own-table row is \`import { dlopen } from "bun:ffi"\` then \`dlopen("lib.dll", { … })\``];
    ownLibraries.add(lib[1]!);
    return problems;
  }

  const alias = typeAlias(name, spec);
  const needType = (member?: string) => {
    const importLine = `import type { ${name} as ${alias} } from "${spec}";`;
    if (!typesFile.includes(importLine)) problems.push(`upgrade-types.ts must contain: ${importLine}`);
    if (member) {
      const memberLine = `export type ${alias}_${member} = ${alias}["${member}"];`;
      if (!typesFile.includes(memberLine)) problems.push(`upgrade-types.ts must contain: ${memberLine}`);
    }
  };

  if (isType) {
    needType();
    for (const c of checks) {
      const mm = new RegExp(`^${name}#(\\w+)`).exec(c);
      if (!mm) problems.push(`a type row only takes ${name}#member checks: ${c}`);
      else needType(mm[1]);
    }
    return problems;
  }

  // A value export.
  const sourceOnly = spec.includes("/darwin/") && process.platform !== "darwin";
  let value: unknown;
  if (sourceOnly) {
    const file = entryFiles.get(spec);
    if (!file) return [`${spec} is not an entry point of any package`];
    if (!sourceExports(readFileSync(file, "utf8")).has(name)) problems.push(`${spec} does not export ${name}`);
    if (checks.length) problems.push(`checks on a macOS-only module run on macOS only`);
    return problems;
  }
  try {
    const mod = await load(spec);
    if (!(name in mod) || mod[name] === undefined) return [`${spec} does not export ${name}`];
    value = mod[name];
  } catch (err) {
    return [`import of ${spec} failed: ${(err as Error).message}`];
  }

  const esc = name.replace(/\$/g, "\\$");
  for (const c of checks) {
    let mm: RegExpExecArray | null;
    if ((mm = new RegExp(`^new ${esc}\\(.*\\)$`).exec(c))) {
      if (typeof value !== "function" || !(value as { prototype?: unknown }).prototype) problems.push(`${c}: ${name} is not a class`);
    } else if ((mm = new RegExp(`^${esc}(\\.\\w+)? === (.+)$`).exec(c))) {
      const actual = mm[1] ? (value as Record<string, unknown>)[mm[1].slice(1)] : value;
      const expected = literal(mm[2]!);
      if (!Object.is(actual, expected)) problems.push(`${c}: the value is ${String(actual)}`);
    } else if ((mm = new RegExp(`^${esc}\\(.*\\)$`).exec(c))) {
      if (typeof value !== "function") problems.push(`${c}: ${name} is not a function`);
    } else if ((mm = new RegExp(`^${esc}\\.(\\w+)`).exec(c))) {
      if (value === null || !(mm[1]! in Object(value))) problems.push(`${c}: ${name} has no ${mm[1]}`);
    } else if ((mm = new RegExp(`^${esc}#(\\w+)`).exec(c))) {
      needType(mm[1]);
      const proto = (value as { prototype?: object }).prototype;
      if (typeof value !== "function" || !proto) problems.push(`${c}: ${name} is not a class`);
    } else problems.push(`unrecognised span: ${c}`);
  }
  return problems;
}

/** What a span of the "Write now" column names: the target its runner is filed under. */
function targetOf(span: string, name: string): string | undefined {
  const esc = name.replace(/\$/g, "\\$");
  let m: RegExpExecArray | null;
  if (new RegExp(`^new ${esc}\\(`).test(span)) return `new ${name}`;
  if ((m = new RegExp(`^${esc}(\\.\\w+)? === `).exec(span))) return `${name}${m[1] ?? ""}`;
  if ((m = new RegExp(`^${esc}([.#]\\w+)`).exec(span))) return `${name}${m[1]}`;
  if (new RegExp(`^${esc}\\(`).test(span)) return name;
  return undefined;
}

/** The rows whose new form is a value of a module that loads on this platform, with their targets. */
function valueRows(): { row: Row; name: string; spec: string; targets: string[] }[] {
  const out: { row: Row; name: string; spec: string; targets: string[] }[] = [];
  for (const row of rows) {
    const m = IMPORT.exec(row.spans[0] ?? "");
    if (!m || m[1] || m[3] === "bun:ffi" || m[3]!.includes("/darwin/")) continue;
    if ([...ROWS_OF_ANOTHER_CHANGE].some((old) => row.old === `\`${old}\``)) continue;
    const [name, spec] = [m[2]!, m[3]!];
    const checks = row.spans.slice(1);
    const targets = checks.length === 0 ? [name] : [...new Set(checks.map((c) => targetOf(c, name) ?? `?${c}`))];
    out.push({ row, name, spec, targets });
  }
  return out;
}

/** A row's kind, from its first span after the import (or the import alone). */
function rowKind(row: Row): string {
  if (row.write === NO_PUBLIC_CALL) return NO_PUBLIC_CALL;
  const first = row.spans[0] ?? "";
  if (first.startsWith("type ")) return "type";
  const m = IMPORT.exec(first);
  if (!m) return "other";
  if (m[1]) return "type";
  if (m[3] === "bun:ffi") return "own bun:ffi table";
  if (m[3]!.includes("/darwin/")) return "macOS-only";
  if ([...ROWS_OF_ANOTHER_CHANGE].some((old) => row.old === `\`${old}\``)) return "another change's";
  const check = row.spans[1];
  if (check === undefined) return "export alone";
  if (check.startsWith("new ")) return "class";
  if (check.includes(" === ")) return "constant";
  if (/^[\w$]+[.#]\w+/.test(check)) return "method or member";
  return "function";
}

describe("docs/upgrading.md", () => {
  test("has the three parts and their tables", () => {
    for (const heading of ["## Part A: published 0.x packages", "## Part B: the `v1-drafting` API", "## Part C: the bindings package", "## Reading the tables", "## Steps for each kind of application"]) {
      expect(guide).toContain(heading);
    }
    expect(rows.length).toBeGreaterThan(800);
  });

  test("no row says an export is gone", () => {
    const bad = guide.split(/\r?\n/).filter((l) => /^\|.*\b(removed|no longer available|not supported anymore)\b/i.test(l));
    expect(bad).toEqual([]);
  });

  test("every row names an old export in backticks and a new form", () => {
    const bad = rows.filter((r) => !/`[^`]+`/.test(r.old) || (r.spans.length === 0 && r.write !== NO_PUBLIC_CALL)).map((r) => `line ${r.line}`);
    expect(bad).toEqual([]);
  });

  // The capabilities an application reached only through an internal, which 1.0 has no public call for (D45).
  // Each is on the owner's list; a row added here is a decision, not a slip.
  const internalSource: Record<string, string> = {
    "`@n1h/sweetview-native/internal`": "internal",
    "`@n1h/sweetview-native/win32/shortcuts`": "win32/shortcuts",
    "`@n1h/sweetview-native/win32/strip-shared`": "win32/strip-shared",
    "`@n1h/sweetview-native/win32/tab-window`": "win32/tab-window",
    "`FrameWindow` and `FrameCallbacks` members that changed": "win32/tab-window",
    "`@n1h/sweetview-native/win32/window`": "win32/window",
    "`@n1h/sweetview-native/win32/menu`": "win32/menu",
    "`@n1h/sweetview-native/darwin/objc`": "darwin/objc",
    "`@n1h/sweetview-native/darwin/screen`": "darwin/screen",
    "`@n1h/sweetview-native/darwin/tabs`": "darwin/tabs",
    "`@n1h/sweetview-native/darwin/window`": "darwin/window",
  };
  /** The macOS rows with no public call: Sweetview's Objective-C runtime calls, its AppKit coordinate helpers and the tabs library's AppKit tab groups. */
  const DARWIN_NO_PUBLIC: Record<string, string[]> = {
    objc: ["ID", "Id", "NIL", "TargetMethod", "alloc", "allocRaw", "asId", "class_addMethod", "cls", "cstr", "dataSymbolAddress", "defineYesClass", "invokeBlock", "jsString", "makeBlock", "makeTarget", "nsString", "objc_allocateClassPair", "objc_getClass", "objc_registerClassPair", "release", "retain", "retainCallback", "sel", "send", "sendBool", "sendBytesLen", "sendCStr", "sendF64", "sendF64PtrSelPtrBool", "sendF64Void", "sendInt", "sendIntArg", "sendIntRetBool", "sendPoint", "sendPtr", "sendPtrArg", "sendPtrIntVoid", "sendPtrPointPtrRetBool", "sendPtrPtr", "sendPtrPtrPtr", "sendPtrPtrPtrVoid", "sendPtrPtrRetBool", "sendPtrSelPtr", "sendPtrSelPtrPtrVoid", "sendPtrSelPtrVoid", "sendPtrSelU32U32Void", "sendRectBool", "sendRectUIntUIntBool", "sendRetBool", "sendRetF64", "sendSelPtrF64", "sendSize", "sendSuperPtr", "sendU32RetPtr", "sendUInt", "sendUIntArg", "sendUIntPtrPtrBool", "sendUIntPtrVoid", "sendUIntRetPtr", "sharedApp"],
    screen: ["CocoaRect", "cursorPoint", "fromCocoa", "primaryHeight", "primaryScreen", "rectOf", "toCocoa"],
    tabs: ["WindowTabs", "WindowTabsOptions", "createWindowTabs", "installTabMenus", "pooled"],
    window: ["DarwinTabGroupController", "bindDarwinTabGroup", "darwinTabWindowClass", "getDarwinTabActiveHandle", "setDarwinTabCloseRequest", "stopDarwinWindowResize"],
  };
  /** The pane rows (rust-rewrite-api-review-fixes): a webview of the application's own at a rectangle, which 1.0 has no call for. */
  const PANE_ROWS = ["`createPane(…)`", "`adoptPane(…)`", "`placePane(…)`", "`showPane(…)`", "`hidePane(…)`", "`destroyPane(…)`"];
  const NO_PUBLIC_ROWS = [
    ...["emitActivationUrl", "emitWindowFileDrop", "emitWindowNewTab", "emitWindowTabClose", "emitWindowTabSelect", "forwardWindowTabEvents", "getWindowBackend", "getWindowMeta", "holdWindowNativeDispose", "isWindowDisposed", "onWindowDispose", "onWindowFileDropListenersChange", "preserveWindowGeometry", "scheduleNativeTimeout", "windowFileDropCount"].map((n) => `\`@n1h/sweetview-native/internal\` | \`${n}\``),
    ...["Key", "LAST_TAB", "Shortcut", "shortcutFor"].map((n) => `\`@n1h/sweetview-native/win32/shortcuts\` | \`${n}\``),
    ...["CAPTION_WIDTH", "DRAG_ROOM", "NEW_TAB_WIDTH", "STRIP_HEIGHT", "StripEvents", "StripMethods", "StripPoint", "StripState", "StripTab", "TABS_LEFT", "TAB_MAX_WIDTH", "TAB_MIN_WIDTH", "dropIndex", "scrollToShow", "tabWidth", "tabsViewport"].map((n) => `\`@n1h/sweetview-native/win32/strip-shared\` | \`${n}\``),
    ...["FrameCallbacks", "FrameWindow", "getTabFrame"].map((n) => `\`@n1h/sweetview-native/win32/tab-window\` | \`${n}\``),
    ...["stripPane", "layout()", "stripRect()"].map((n) => `\`FrameWindow\` and \`FrameCallbacks\` members that changed | \`${n}\``),
    ...["_debugTrackedCount", "asHwnd", "systemIsDark"].map((n) => `\`@n1h/sweetview-native/win32/window\` | \`${n}\``),
    ...["buildMenu", "destroyMenu"].map((n) => `\`@n1h/sweetview-native/win32/menu\` | \`${n}\``),
    ...PANE_ROWS.map((old) => `\`FrameWindow\` and \`FrameCallbacks\` members that changed | ${old}`),
    ...Object.entries(DARWIN_NO_PUBLIC).flatMap(([module, names]) => names.map((n) => `\`@n1h/sweetview-native/darwin/${module}\` | \`${n}\``)),
  ];
  const noPublic = () => rows.filter((r) => r.write === NO_PUBLIC_CALL);
  /** The export a no-public-call row is about: the Old name, or for a member row the type it is a member of. */
  const exportOf = (r: Row) => (r.section.startsWith("`FrameWindow`") ? "FrameWindow" : r.old.replace(/`/g, "").replace(/\(\)$/, ""));

  test("the capabilities 1.0 has no public call for are these rows, each saying which capability", () => {
    expect(noPublic().map((r) => `${r.section} | ${r.old}`).sort()).toEqual([...NO_PUBLIC_ROWS].sort());
    const unsaid = noPublic().filter((r) => !PANE_ROWS.includes(r.old) && (!/no public call in 1\.0/.test(r.change) || r.change.length < 40));
    expect(unsaid.map((r) => r.old)).toEqual([]);
  });

  test("no public entry point exports what a no-public-call row names (values at run time, types through upgrade-types.ts)", async () => {
    const { NOT_MODULES, publicSpecifiers } = await import("./public-entries");
    const modules = await Promise.all(publicSpecifiers().filter((s) => !NOT_MODULES.has(s)).map(async (s) => [s, (await import(s)) as Record<string, unknown>] as const));
    const exported: string[] = [];
    const missingTypeCheck: string[] = [];
    for (const r of noPublic()) {
      const name = exportOf(r);
      const file = internalSource[r.section]!;
      // A macOS module loads macOS libraries when imported: off macOS its exports are read from its source.
      const isValue = file.startsWith("darwin/")
        ? new RegExp(`^export (?:async )?(?:const|let|function|class) ${name}\\b`, "m").test(readFileSync(join(root, "packages", "sweetview-native", "src", `${file}.ts`), "utf8"))
        : name in ((await import(`../../packages/sweetview-native/src/${file}`)) as Record<string, unknown>);
      if (isValue) {
        for (const [spec, mod] of modules) if (name in mod) exported.push(`${name} (${r.section}) from ${spec}`);
      } else {
        // A type: upgrade-types.ts must fail to import it from the two public entries an application would look in.
        for (const spec of ["@n1h/sweetview", "@n1h/sweetview-native"]) {
          const line = `// @ts-expect-error no public call in 1.0\nimport type { ${name} as NoPublic_${name}__${spec.replace(/\W+/g, "_")} } from "${spec}";`;
          if (!typesFile.replace(/\r\n/g, "\n").includes(line)) missingTypeCheck.push(line);
        }
      }
    }
    expect({ exported, missingTypeCheck: [...new Set(missingTypeCheck)] }).toEqual({ exported: [], missingTypeCheck: [] });
  });

  test("each public call a row names for the part 1.0 covers is a row of this guide, or a member of a public export", async () => {
    const { NOT_MODULES, publicSpecifiers } = await import("./public-entries");
    const modules = await Promise.all(publicSpecifiers().filter((s) => !NOT_MODULES.has(s)).map(async (s) => (await import(s)) as Record<string, unknown>));
    /** A class or function some public entry exports, with the member named (`#m` on its prototype, `.m` on itself). */
    const publicMember = (name: string, member: string | undefined) =>
      modules.some((mod) => {
        const value: unknown = mod[name];
        if (typeof value !== "function") return false;
        if (!member) return true;
        const key = member.slice(1);
        return member.startsWith("#") ? key in ((value as { prototype?: object }).prototype ?? {}) : key in value;
      });
    const targets = new Set<string>();
    for (const r of rows) {
      const m = IMPORT.exec(r.spans[0] ?? "");
      if (!m) continue;
      for (const c of r.spans.slice(1)) {
        const t = targetOf(c, m[2]!);
        if (t) targets.add(t.replace(/^new /, ""));
      }
    }
    const unknown: string[] = [];
    for (const r of [...noPublic(), ...rows.filter((x) => /no public call in 1\.0/.test(x.change) && x.write !== NO_PUBLIC_CALL)]) {
      for (const [, span] of r.change.matchAll(/`([^`]+)`/g)) {
        const call = /^([A-Za-z_$][\w$]*)(?:([.#]\w+))?\(.*\)$/.exec(span!) ?? /^([A-Z][\w$]*)([.#]\w+)$/.exec(span!);
        if (!call) continue;
        // In a row with a public form, only a member of a named export (`Name.member`, `Name#member`) is checked.
        if (r.write !== NO_PUBLIC_CALL && !call[2]) continue;
        const target = `${call[1]}${call[2] ?? ""}`;
        if (!targets.has(target) && !publicMember(call[1]!, call[2])) unknown.push(`${r.old}: ${span}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test("the pane rows, which 1.0 has no public call for, name nothing in their place", () => {
    // Each is on the owner's list; a row added here is a decision, not a slip.
    const none = rows.filter((r) => r.write === NO_PUBLIC_CALL && PANE_ROWS.includes(r.old));
    expect(none.map((r) => r.old)).toEqual(["`createPane(…)`", "`adoptPane(…)`", "`placePane(…)`", "`showPane(…)`", "`hidePane(…)`", "`destroyPane(…)`"]);
    // A capability without a public call is not offered a substitute in its Change column either.
    const offered = none.filter((r) => /`[A-Za-z]+[.#(]/.test(guide.split(/\r?\n/)[r.line - 1]!.split("|")[3] ?? ""));
    expect(offered.map((r) => r.old)).toEqual([]);
    // The two uses of a message window of the application's own that 1.0 has no call for are said so, with no substitute.
    for (const old of ["`HWND_MESSAGE`", "`createMessageWindow`", "`createMessageWindowRaw`"]) {
      const line = guide.split(/\r?\n/)[rows.find((r) => r.old === old)!.line - 1]!;
      expect({ old, says: line.includes("Two uses have no public call in 1.0"), offersHook: line.includes("installKeyboardHook") }).toEqual({ old, says: true, offersHook: false });
    }
  });

  test("every row's new form imports and is what the row says", async () => {
    const own = new Set<string>();
    const failures: string[] = [];
    for (const row of rows) {
      for (const p of await checkRow(row, own)) failures.push(`docs/upgrading.md:${row.line} (${row.section}) ${row.old}: ${p}`);
    }
    expect(failures).toEqual([]);
    // Own-table rows: the application's own bun:ffi table, run inside Sweetview's loop.
    if (process.platform !== "win32") return;
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "own-ffi.ts"), ...own], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const out = child.stdout.toString().trim().split(/\r?\n/).at(-1) ?? "";
    expect({ exit: child.exitCode, stderr: child.stderr.toString().trim() }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(out) as { inLoop: boolean; calls: Record<string, string> };
    expect(result.inLoop).toBe(true);
    expect(Object.keys(result.calls).sort()).toEqual([...own].sort());
    for (const [lib, outcome] of Object.entries(result.calls)) expect(`${lib}: ${outcome}`).toBe(`${lib}: ok`);
  }, 120_000);

  test("every row's new form has a runner", () => {
    const missing = [...new Set(valueRows().flatMap((r) => r.targets.filter((t) => RUNNERS[t] === undefined).map((t) => `${t} (docs/upgrading.md:${r.row.line}, ${r.row.old})`)))];
    expect(missing).toEqual([]);
    // The rows of another change still exist under their Old names; their runners come with that change.
    for (const old of ROWS_OF_ANOTHER_CHANGE) expect(rows.some((r) => r.old === `\`${old}\``)).toBe(true);
  });

  test("every runner is the runner of a row, so none is left that nothing runs", () => {
    const targets = new Set(valueRows().flatMap((r) => r.targets));
    // Runners that others call (`RUNNERS["…"]` in row-runners.ts) run through those.
    const called = new Set([...readFileSync(join(import.meta.dir, "fixtures", "row-runners.ts"), "utf8").matchAll(/RUNNERS\["([^"]+)"\]|RUNNERS\.([\w$]+)!/g)].map((m) => m[1] ?? m[2]!));
    expect(Object.keys(RUNNERS).filter((key) => !targets.has(key) && !called.has(key))).toEqual([]);
  });

  test.skipIf(process.platform !== "win32")("every row's new form runs", async () => {
    const jobs = new Map<string, { key: string; target: string; name: string; spec: string; where: "here" | "desktop" }>();
    for (const r of valueRows()) {
      for (const target of r.targets) {
        const runner = RUNNERS[target];
        if (!runner) continue; // reported by the test above
        const key = `${target} @ ${r.spec}`;
        jobs.set(key, { key, target, name: r.name, spec: r.spec, where: runner.where });
      }
    }
    const results: Record<string, string> = {};

    // In this process: the runners with no window, webview or OS input.
    const work = scratch();
    const ranWith = new Map<string, { value: unknown; key: string }[]>();
    try {
      for (const job of [...jobs.values()].filter((j) => j.where === "here")) {
        try {
          const value = (await load(job.spec))[job.name];
          const earlier = ranWith.get(job.target)?.find((r) => r.value === value);
          if (earlier) {
            results[job.key] = results[earlier.key]!.startsWith("ok") ? `ok: the same ${job.name} as ${earlier.key.split(" @ ")[1]}` : results[earlier.key]!;
            continue;
          }
          const runner = RUNNERS[job.target]!;
          const note = await (runner.run as (v: unknown, c: { tmp: string }) => unknown)(value, { tmp: work.tmp });
          results[job.key] = typeof note === "string" ? `ok: ${note}` : "ok";
          ranWith.set(job.target, [...(ranWith.get(job.target) ?? []), { value, key: job.key }]);
        } catch (err) {
          results[job.key] = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } finally {
      work.dispose();
    }

    // In a process of its own, on a WebView2 profile of its own: the desktop runners.
    const desktopJobs = [...jobs.values()].filter((j) => j.where === "desktop");
    const dir = mkdtempSync(join(tmpdir(), "sweetview-compat-desktop-"));
    let output = "";
    try {
      const jobFile = join(dir, "jobs.json");
      writeFileSync(jobFile, JSON.stringify(desktopJobs));
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "rows-desktop.ts"), jobFile], {
        cwd: root,
        env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(dir, "profile") },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 280_000,
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      output = `exit ${exit}\n${stderr.split(/\r?\n/).filter((l) => l.startsWith("FAIL")).join("\n")}`;
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
      Object.assign(results, line ? JSON.parse(line.slice("RESULT ".length)) : { "(desktop run)": `error: no result\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}` });
    } finally {
      // WebView2's browser processes can hold the profile a moment after the child exits.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
      } catch {}
    }

    // Per kind of row: how many there are and how many ran (every target of the row ran).
    const counts: Record<string, { rows: number; ran: number }> = {};
    const count = (kind: string, ran: boolean) => {
      const c = (counts[kind] ??= { rows: 0, ran: 0 });
      c.rows++;
      if (ran) c.ran++;
    };
    const byRow = new Map(valueRows().map((r) => [r.row, r]));
    for (const row of rows) {
      const value = byRow.get(row);
      let kind = rowKind(row);
      // An import with nothing after it: a function, or a constant (an object or a value).
      if (kind === "export alone" && value) kind = typeof (await load(value.spec))[value.name] === "function" ? "function" : "constant";
      // Run elsewhere: an own-table row by fixtures/own-ffi.ts (the test above), a type row by tsc (the test below).
      if (kind === "own bun:ffi table") count("own bun:ffi table (run by fixtures/own-ffi.ts)", true);
      else if (kind === "type") count("type (checked by tsc in upgrade-types.ts)", false);
      else if (value === undefined) count(kind, false);
      else count(kind, value.targets.length > 0 && value.targets.every((t) => results[`${t} @ ${value.spec}`]?.startsWith("ok") === true));
    }
    console.log(`docs/upgrading.md rows by kind (rows / run): ${Object.entries(counts).map(([k, c]) => `${k} ${c.rows}/${c.ran}`).join(", ")}`);

    const failures = Object.entries(results).filter(([, v]) => !v.startsWith("ok")).map(([k, v]) => `${k}: ${v}`);
    expect(failures, output).toEqual([]);
    expect(Object.keys(results).filter((k) => jobs.has(k)).length).toBe(jobs.size);
  }, 300_000);

  test("upgrade-types.ts and the compat fixtures typecheck", () => {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    const run = Bun.spawnSync([process.execPath, tsc, "--noEmit", "-p", join(import.meta.dir, "tsconfig.json")], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect({ exit: run.exitCode, output: (run.stdout.toString() + run.stderr.toString()).trim() }).toEqual({ exit: 0, output: "" });
  }, 150_000);
});
