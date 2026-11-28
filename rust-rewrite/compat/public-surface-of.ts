// The exported names of each public entry point, as the TypeScript compiler sees them (values and
// types alike), the way rust-rewrite/checks/api-diff.ts enumerates them. Used by
// package-boundaries.test.ts to pin the public surface by name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { PUBLIC } from "./public-entries";

/** Each public entry point of the packages under `root`, with the file its `exports` key names. */
export function publicEntries(root: string): { spec: string; file: string }[] {
  const out: { spec: string; file: string }[] = [];
  const dir = join(root, "packages");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const pkgPath = join(dir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string; exports?: Record<string, unknown> };
    for (const key of PUBLIC[pkg.name] ?? []) {
      const target = pkg.exports?.[key];
      const rel = typeof target === "string" ? target : typeof target === "object" && target !== null ? (((target as Record<string, unknown>).import ?? (target as Record<string, unknown>).default ?? (target as Record<string, unknown>).types) as string | undefined) : undefined;
      if (rel) out.push({ spec: `${pkg.name}${key.slice(1)}`, file: resolve(join(dir, name), rel) });
    }
  }
  return out;
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
    const mod = sf && checker.getSymbolAtLocation(sf);
    out[e.spec] = mod ? checker.getExportsOfModule(mod).map((s) => s.name).sort() : [];
  }
  return out;
}
