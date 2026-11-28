// The exported names of each public entry point, as the TypeScript compiler sees them (values and
// types alike), the way rust-rewrite/checks/api-diff.ts enumerates them. Used by
// package-boundaries.test.ts to pin the public surface by name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { PUBLIC } from "./public-entries";

/** The file an `exports` target names: the string, or its `import`, `default` or `types` condition. */
function targetOf(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (typeof target !== "object" || target === null) return undefined;
  const t = target as Record<string, unknown>;
  return (t.import ?? t.default ?? t.types) as string | undefined;
}

/** Every key of every package's `exports` map under `root`, or only the public ones, with the file it names. */
export function exportEntries(root: string, only: "public" | "all"): { spec: string; file: string }[] {
  const out: { spec: string; file: string }[] = [];
  const dir = join(root, "packages");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const pkgPath = join(dir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string; exports?: Record<string, unknown> };
    const keys = only === "public" ? (PUBLIC[pkg.name] ?? []) : Object.keys(pkg.exports ?? {});
    for (const key of keys) {
      const rel = targetOf(pkg.exports?.[key]);
      if (rel) out.push({ spec: `${pkg.name}${key.slice(1)}`, file: resolve(join(dir, name), rel) });
    }
  }
  return out;
}

/** Each public entry point of the packages under `root`, with the file its `exports` key names. */
export const publicEntries = (root: string): { spec: string; file: string }[] => exportEntries(root, "public");

/**
 * What is wrong with each entry's target: it does not exist, does not parse, or does not load. An
 * entry `parseOnly` names (a script run by path, a types-only entry, an entry for another OS) is
 * parsed and not loaded; every other one is imported.
 */
export async function entryFaults(entries: { spec: string; file: string }[], parseOnly: (spec: string) => boolean): Promise<string[]> {
  const faults: string[] = [];
  for (const { spec, file } of entries) {
    if (!existsSync(file)) {
      faults.push(`${spec}: its target does not exist`);
    } else if (parseOnly(spec)) {
      const program = ts.createProgram({ rootNames: [file], options: { noEmit: true, noResolve: true, noLib: true } });
      if (program.getSyntacticDiagnostics(program.getSourceFile(file)).length > 0) faults.push(`${spec}: its target does not parse`);
    } else {
      try {
        await import(file);
      } catch (e) {
        faults.push(`${spec}: its target does not load (${String(e).split(/\r?\n/)[0]})`);
      }
    }
  }
  return faults;
}

/** Each pinned value a module entry does not have at run time, and each run-time value not pinned. */
export async function valueGaps(entries: { spec: string; file: string }[], pinned: Record<string, string[]>): Promise<string[]> {
  const gaps: string[] = [];
  for (const { spec, file } of entries) {
    const values = pinned[spec];
    if (!values) continue;
    const names = Object.keys((await import(file)) as Record<string, unknown>);
    for (const name of values) if (!names.includes(name)) gaps.push(`${spec}: ${name} is pinned as a value and is not one at run time`);
    for (const name of names) if (!values.includes(name)) gaps.push(`${spec}: ${name} is a value at run time and is not pinned as one`);
  }
  return gaps;
}

/** The names each entry exports, sorted, by entry specifier. `options` defaults to the root tsconfig's. */
export function surfaceOf(root: string, entries: { spec: string; file: string }[], options?: ts.CompilerOptions): Record<string, string[]> {
  let compilerOptions = options;
  if (!compilerOptions) {
    const cfgPath = join(root, "tsconfig.json");
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
    compilerOptions = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root).options;
  }
  const program = ts.createProgram({ rootNames: entries.map((e) => e.file), options: { ...compilerOptions, noEmit: true } });
  const checker = program.getTypeChecker();
  const out: Record<string, string[]> = {};
  for (const e of entries) {
    const sf = program.getSourceFile(e.file);
    if (!sf) throw new Error(`${e.spec}: its target ${e.file} does not exist`);
    const mod = checker.getSymbolAtLocation(sf);
    out[e.spec] = mod ? checker.getExportsOfModule(mod).map((s) => s.name).sort() : [];
  }
  return out;
}
