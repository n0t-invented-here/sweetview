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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const guidePath = join(root, "docs", "upgrading.md");
const typesPath = join(import.meta.dir, "upgrade-types.ts");
const guide = readFileSync(guidePath, "utf8");
const typesFile = readFileSync(typesPath, "utf8");

type Row = { section: string; line: number; old: string; spans: string[] };

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
      const [old, write] = splitCells(lines[i]!);
      rows.push({ section, line: i + 1, old: old ?? "", spans: [...(write ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!) });
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
    const bad = rows.filter((r) => !/`[^`]+`/.test(r.old) || r.spans.length === 0).map((r) => `line ${r.line}`);
    expect(bad).toEqual([]);
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

  test("upgrade-types.ts and the compat fixtures typecheck", () => {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    const run = Bun.spawnSync([process.execPath, tsc, "--noEmit", "-p", join(import.meta.dir, "tsconfig.json")], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect({ exit: run.exitCode, output: (run.stdout.toString() + run.stderr.toString()).trim() }).toEqual({ exit: 0, output: "" });
  }, 150_000);
});
