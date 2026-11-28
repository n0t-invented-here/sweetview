// API audit tooling: dumps the full public shape of every package entry point
// at two checkouts of this repository, and diffs them symbol by symbol.
//
//   bun rust-rewrite/checks/api-diff.ts <before-root> [out-dir]
//
// <before-root> is a checkout of the "before" side (a worktree of tag
// `pre-rust-rewrite` with `bun install` run in it). The "after" side is the
// checkout this script lives in. The bindings package
// `@n1h/sweetview-webview-bun` is dumped from the after side's node_modules
// (the version this branch pins) as a third "before" surface. out-dir defaults
// to rust-rewrite/evidence and receives api-audit-before.txt,
// api-audit-after.txt and api-audit-diff.txt.
//
// The shapes come from the TypeScript compiler (the `typescript` dev
// dependency), not from reading source by eye: for every export of every entry
// point in each package.json `exports` map, the resolved symbol's kind, every
// call and construct signature (parameter names, types, optionality, rest,
// defaults, return type, generics), every public class member and static,
// every interface or object member with optionality and readonly, every enum
// member with its value, every literal of a union, JSDoc `@deprecated`,
// `@default` and `@throws`, and the unit and thread words of the doc comment.
// Parameters whose type is an object type (an options object) are expanded one
// level, field by field. Each fact is one line `subkey = value`, so the diff is
// a comparison of keyed lines.
//
// The diff matches a before symbol to an after symbol by, in order: the same
// entry point and name; the row of docs/upgrading.md (Part B for the tag, Part
// C for the bindings package) whose first "Write now" span imports the new
// form; the same name exported by another entry point. It prints what has no
// counterpart, what changed line by line, and what is new. Judgement about
// whether a guide row really provides the same capability is left to the
// report (rust-rewrite/evidence/api-audit.md); this tool supplies the facts.
//
// Paths in the output are relative to each checkout's root.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const afterRoot = resolve(import.meta.dir, "..", "..");
const beforeRoot = process.argv[2] ? resolve(process.argv[2]) : "";
const outDir = resolve(process.argv[3] ?? join(afterRoot, "rust-rewrite", "evidence"));
if (!beforeRoot || !existsSync(join(beforeRoot, "packages"))) {
  console.error("usage: bun rust-rewrite/checks/api-diff.ts <before-root> [out-dir]");
  process.exit(2);
}

// ---- entry points ---------------------------------------------------------------

type Entry = { spec: string; file: string; internal: boolean };

const isInternal = (spec: string) => /\/internal$|\/win32\/|\/darwin\//.test(spec);

function entriesOf(root: string): Entry[] {
  const out: Entry[] = [];
  for (const dir of readdirSync(join(root, "packages")).sort()) {
    const pkgPath = join(root, "packages", dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      const t = typeof target === "string" ? target : (target as { types?: string }).types;
      if (!t) continue;
      const spec = sub === "." ? pkg.name : pkg.name + sub.slice(1);
      out.push({ spec, file: join(root, "packages", dir, t), internal: isInternal(spec) });
    }
  }
  return out;
}

// ---- shapes ---------------------------------------------------------------------

type Rec = { entry: string; name: string; internal: boolean; facts: Map<string, string> };

const F = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
const clean = (s: string) => s.replace(/import\("[^"]*"\)\./g, "").replace(/\s+/g, " ").trim();

const UNIT_WORDS: [RegExp, string][] = [
  [/physical pixels?/i, "physical-px"],
  [/\bDIPs?\b|device[- ]independent/i, "dip"],
  [/\blogical (pixels?|points?|units?)\b/i, "logical"],
  [/\bpoints?\b(?! to)/i, "points"],
  [/\bclient (area|size|rect)/i, "client-area"],
  [/\bouter (frame|bounds|size)|\bframe\b.*\bincluding\b/i, "outer-frame"],
  [/\bmilliseconds?\b|\bms\b/i, "ms"],
  [/\bseconds?\b/i, "seconds"],
  [/\bUI thread\b|\bmain thread\b/i, "ui-thread"],
  [/\bany thread\b|\bfrom a worker\b|\bin a worker\b|\bWorker\b/, "worker"],
  [/\bthrows?\b/i, "throws"],
  [/\basync\b|\bresolves?\b|\bPromise\b/, "async"],
];

function docFacts(prefix: string, sym: ts.Symbol, checker: ts.TypeChecker, facts: Map<string, string>) {
  const tags = sym.getJsDocTags(checker);
  for (const t of tags) {
    const text = clean(ts.displayPartsToString(t.text ?? []));
    if (t.name === "deprecated") facts.set(`${prefix}@deprecated`, text || "yes");
    if (t.name === "default" || t.name === "defaultValue") facts.set(`${prefix}@default`, text);
    if (t.name === "throws") facts.set(`${prefix}@throws`, text);
  }
  const doc = ts.displayPartsToString(sym.getDocumentationComment(checker));
  if (doc) {
    const notes = UNIT_WORDS.filter(([re]) => re.test(doc)).map(([, w]) => w);
    if (notes.length) facts.set(`${prefix}doc.notes`, notes.join(","));
    const def = doc.match(/\b[Dd]efaults? (?:to|is)\s+([^.;\n]+)|\b[Dd]efault:\s*([^.;\n]+)|\(default ([^)]+)\)/);
    if (def) facts.set(`${prefix}doc.default`, clean(def[1] ?? def[2] ?? def[3] ?? ""));
  }
}

function makeDumper(program: ts.Program, root: string) {
  const checker = program.getTypeChecker();
  const inWorkspace = (d: ts.Declaration) => {
    const f = d.getSourceFile().fileName.replaceAll("\\", "/");
    return !/\/node_modules\/(typescript|@types|bun-types)\//.test(f);
  };
  const str = (t: ts.Type, at?: ts.Node, extra = 0) => clean(checker.typeToString(t, at, F | extra));

  /** An options object worth expanding: an object type with properties, not a function, array, class instance or lib type. */
  function expandable(t: ts.Type): ts.Type | undefined {
    let u = t;
    if (u.isUnion()) {
      const rest = u.types.filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      if (rest.length !== 1) return undefined;
      u = rest[0]!;
    }
    if (!(u.flags & ts.TypeFlags.Object) && !u.isIntersection()) return undefined;
    if (u.getCallSignatures().length || u.getConstructSignatures().length) return undefined;
    if (checker.isArrayType(u) || checker.isTupleType(u)) return undefined;
    const s = u.aliasSymbol ?? u.getSymbol();
    if (s && s.flags & ts.SymbolFlags.Class) return undefined;
    const decls = s?.declarations ?? [];
    if (decls.length && !decls.some(inWorkspace)) return undefined;
    if (checker.getPropertiesOfType(u).length === 0) return undefined;
    return u;
  }

  function propLine(p: ts.Symbol, at: ts.Node | undefined): string {
    const d = p.valueDeclaration ?? p.declarations?.[0];
    const t = checker.getTypeOfSymbolAtLocation(p, d ?? at!);
    const opt = p.flags & ts.SymbolFlags.Optional ? "?" : "";
    const ro = d && ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly ? "readonly " : "";
    if (p.flags & ts.SymbolFlags.Method) return `${ro}method${opt} ${t.getCallSignatures().map((s) => clean(checker.signatureToString(s, d, F))).join(" | ")}`;
    if (p.flags & ts.SymbolFlags.Accessor) {
      const g = p.flags & ts.SymbolFlags.GetAccessor ? "get" : "";
      const s = p.flags & ts.SymbolFlags.SetAccessor ? "set" : "";
      return `${[g, s].filter(Boolean).join(" ")}${opt}: ${str(t, d)}`;
    }
    return `${ro}property${opt}: ${str(t, d)}`;
  }

  function fields(prefix: string, t: ts.Type, at: ts.Node | undefined, facts: Map<string, string>, defaults?: Map<string, string>) {
    for (const p of checker.getPropertiesOfType(t)) {
      if (isHidden(p)) continue;
      const k = `${prefix}.${p.name}`;
      facts.set(k, propLine(p, at) + (defaults?.has(p.name) ? ` = ${defaults.get(p.name)}` : ""));
      docFacts(`${k} `, p, checker, facts);
    }
    for (const info of checker.getIndexInfosOfType(t)) facts.set(`${prefix}[${str(info.keyType)}]`, `${info.isReadonly ? "readonly " : ""}${str(info.type, at)}`);
  }

  function isHidden(p: ts.Symbol): boolean {
    if (p.name.startsWith("#") || p.name.startsWith("__@")) return true;
    const d = p.valueDeclaration ?? p.declarations?.[0];
    if (!d) return false;
    const m = ts.getCombinedModifierFlags(d);
    return !!(m & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) || (ts.isPropertyDeclaration(d) && ts.isPrivateIdentifier(d.name));
  }

  function signature(prefix: string, sig: ts.Signature, facts: Map<string, string>) {
    const d = sig.getDeclaration() as ts.SignatureDeclaration | undefined;
    facts.set(prefix, clean(checker.signatureToString(sig, d, F)));
    sig.getParameters().forEach((p, i) => {
      const pd = p.valueDeclaration as ts.ParameterDeclaration | undefined;
      const name = pd && !ts.isIdentifier(pd.name) ? `arg${i}` : p.name;
      const t = checker.getTypeOfSymbolAtLocation(p, pd ?? d!);
      const optional = pd ? checker.isOptionalParameter(pd) : !!(p.flags & ts.SymbolFlags.Optional);
      const rest = pd?.dotDotDotToken ? "..." : "";
      const init = pd?.initializer ? ` = ${clean(pd.initializer.getText())}` : "";
      facts.set(`${prefix}.p${i}`, `${rest}${name}${optional ? "?" : ""}: ${str(t, pd)}${init}`);
      // Defaults written in a destructuring pattern: ({ a = 1 }: Opts).
      const defaults = new Map<string, string>();
      if (pd && ts.isObjectBindingPattern(pd.name)) {
        for (const el of pd.name.elements) if (el.initializer) defaults.set((el.propertyName ?? el.name).getText(), clean(el.initializer.getText()));
      }
      const ex = expandable(t);
      if (ex) fields(`${prefix}.p${i}{${name}}`, ex, pd, facts, defaults);
    });
    facts.set(`${prefix}.returns`, str(sig.getReturnType(), d));
    if (sig.typeParameters?.length) facts.set(`${prefix}.generics`, sig.typeParameters.map((tp) => clean(checker.typeToString(tp, d, F)) + (tp.getConstraint() ? ` extends ${str(tp.getConstraint()!, d)}` : "")).join(", "));
  }

  function typeParamsOf(decl: ts.Declaration | undefined): string {
    const tps = decl && (decl as ts.ClassLikeDeclaration).typeParameters;
    return tps?.length ? `<${tps.map((tp) => clean(tp.getText())).join(", ")}>` : "";
  }

  function dumpSymbol(entry: Entry, exportName: string, exported: ts.Symbol): Rec {
    const sym = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const facts = new Map<string, string>();
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    const kinds: string[] = [];
    const f = sym.flags;
    if (f & ts.SymbolFlags.Class) kinds.push("class");
    else if (f & ts.SymbolFlags.Function) kinds.push("function");
    else if (f & ts.SymbolFlags.Variable) kinds.push(decl && ts.isVariableDeclaration(decl) && decl.parent.flags & ts.NodeFlags.Const ? "const" : "let");
    if (f & ts.SymbolFlags.ConstEnum) kinds.push("const enum");
    else if (f & ts.SymbolFlags.RegularEnum) kinds.push("enum");
    if (f & ts.SymbolFlags.Interface && !(f & ts.SymbolFlags.Class)) kinds.push("interface");
    if (f & ts.SymbolFlags.TypeAlias) kinds.push("type");
    if (f & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule) && !(f & ts.SymbolFlags.Enum)) kinds.push("namespace");
    facts.set("kind", kinds.join("+") || `flags:${f}`);
    if (exported !== sym && sym.name !== exportName && sym.name !== "default") facts.set("alias-of", sym.name);
    if (decl) facts.set("declared-in", relative(root, decl.getSourceFile().fileName).replaceAll("\\", "/"));
    docFacts("", sym, checker, facts);

    if (f & ts.SymbolFlags.Class) {
      const staticType = checker.getTypeOfSymbolAtLocation(sym, decl!);
      facts.set("generics", typeParamsOf(decl));
      staticType.getConstructSignatures().forEach((s, i) => signature(`new[${i}]`, s, facts));
      const inst = checker.getDeclaredTypeOfSymbol(sym);
      for (const p of checker.getPropertiesOfType(inst)) {
        if (isHidden(p)) continue;
        const k = `#${p.name}`;
        facts.set(k, propLine(p, decl));
        docFacts(`${k} `, p, checker, facts);
        if (p.flags & ts.SymbolFlags.Method) {
          const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? decl!);
          pt.getCallSignatures().forEach((s, i) => signature(`${k}(${i})`, s, facts));
        }
      }
      for (const p of checker.getPropertiesOfType(staticType)) {
        if (p.name === "prototype" || isHidden(p)) continue;
        const k = `static.${p.name}`;
        facts.set(k, propLine(p, decl));
        docFacts(`${k} `, p, checker, facts);
        if (p.flags & ts.SymbolFlags.Method) {
          const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? decl!);
          pt.getCallSignatures().forEach((s, i) => signature(`${k}(${i})`, s, facts));
        }
      }
    } else if (f & ts.SymbolFlags.Function) {
      checker.getTypeOfSymbolAtLocation(sym, decl!).getCallSignatures().forEach((s, i) => signature(`call[${i}]`, s, facts));
    } else if (f & ts.SymbolFlags.Variable) {
      const t = checker.getTypeOfSymbolAtLocation(sym, decl!);
      facts.set("type", str(t, decl));
      t.getCallSignatures().forEach((s, i) => signature(`call[${i}]`, s, facts));
      t.getConstructSignatures().forEach((s, i) => signature(`new[${i}]`, s, facts));
      if (!t.getCallSignatures().length && t.flags & ts.TypeFlags.Object) fields("", t, decl, facts);
      const init = decl && ts.isVariableDeclaration(decl) && decl.initializer;
      if (init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)) facts.set("value", init.getText());
    }
    if (f & ts.SymbolFlags.Enum) {
      for (const m of (sym.exports ? [...(sym.exports as Map<string, ts.Symbol>).values()] : [])) {
        const md = m.valueDeclaration as ts.EnumMember | undefined;
        facts.set(`enum.${m.name}`, md ? JSON.stringify(checker.getConstantValue(md) ?? null) : "?");
      }
    }
    if (f & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias) && !(f & ts.SymbolFlags.Class)) {
      const tdecl = sym.declarations?.find((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d));
      const t = checker.getDeclaredTypeOfSymbol(sym);
      const pre = kinds.length > 1 ? "T" : "";
      facts.set(`${pre}generics`, typeParamsOf(tdecl));
      facts.set(`${pre}type`, str(t, tdecl, ts.TypeFormatFlags.InTypeAlias));
      if (t.isUnion()) {
        for (const m of t.types) if (m.isStringLiteral() || m.isNumberLiteral()) facts.set(`${pre}literal ${JSON.stringify(m.value)}`, "member");
      }
      if (t.flags & ts.TypeFlags.Object || t.isIntersection()) {
        fields(pre, t, tdecl, facts);
        t.getCallSignatures().forEach((s, i) => signature(`${pre}call[${i}]`, s, facts));
        t.getConstructSignatures().forEach((s, i) => signature(`${pre}new[${i}]`, s, facts));
      }
    }
    if (f & ts.SymbolFlags.NamespaceModule || (f & ts.SymbolFlags.ValueModule && !(f & (ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)))) {
      for (const m of checker.getExportsOfModule(sym)) facts.set(`ns.${m.name}`, m.flags & ts.SymbolFlags.Value ? str(checker.getTypeOfSymbolAtLocation(m, m.valueDeclaration ?? decl!)) : "type");
    }
    return { entry: entry.spec, name: exportName, internal: entry.internal, facts };
  }

  function dumpEntry(entry: Entry): Rec[] {
    const sf = program.getSourceFile(entry.file);
    if (!sf) throw new Error(`not in program: ${entry.file}`);
    const mod = checker.getSymbolAtLocation(sf);
    if (!mod) return []; // a file with no exports (a module of side effects or ambient declarations only)
    return checker
      .getExportsOfModule(mod)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => dumpSymbol(entry, s.name, s));
  }
  return { dumpEntry };
}

function programFor(root: string, files: string[]): ts.Program {
  const cfgPath = join(root, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  return ts.createProgram({ rootNames: files, options: { ...parsed.options, noEmit: true } });
}

function dumpSide(root: string, entries: Entry[]): Rec[] {
  const program = programFor(root, entries.map((e) => e.file));
  const d = makeDumper(program, root);
  const recs: Rec[] = [];
  for (const e of entries) {
    const sf = program.getSourceFile(e.file)!;
    const got = d.dumpEntry(e);
    if (!got.length) recs.push({ entry: e.spec, name: "(ambient)", internal: e.internal, facts: new Map([["kind", "ambient declarations"], ["text", clean(sf.text.replace(/\/\/.*$/gm, "")).slice(0, 2000)]]) });
    recs.push(...got);
  }
  return recs;
}

// ---- the guide ------------------------------------------------------------------

type Row = { part: string; entry: string; members: string[]; line: number; old: string; oldName: string; spans: string[]; change: string };

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
  let part = "";
  let entry = "";
  let members: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^## /.test(line)) {
      part = /^## Part ([ABC])/.exec(line)?.[1] ?? "";
      entry = "";
      members = [];
    }
    if (/^### /.test(line)) {
      entry = /^### `([^`]+)`$/.exec(line)?.[1] ?? line.slice(4);
      members = [];
    }
    if (/^#### /.test(line)) members = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((n) => !n.includes("/") && !n.includes("("));
    if (line.trim() !== "| Old | Write now | Change |") continue;
    for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) {
      const [old, write, change] = splitCells(lines[i]!);
      const oldName = /`([^`]+)`/.exec(old ?? "")?.[1] ?? old ?? "";
      rows.push({ part, entry, members, line: i + 1, old: old ?? "", oldName, spans: [...(write ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!), change: change ?? "" });
    }
  }
  return rows;
}

/** The after key a row's first span imports, and the member spans after it. */
function rowTarget(r: Row): { key?: string; via: string[] } {
  const imp = /^import (?:type )?\{\s*([A-Za-z_$][\w$]*)(?:\s+as\s+\w+)?\s*\} from "([^"]+)"/.exec(r.spans[0] ?? "");
  return { key: imp ? `${imp[2]}::${imp[1]}` : undefined, via: r.spans.slice(1) };
}

// ---- run ------------------------------------------------------------------------

const beforeEntries = entriesOf(beforeRoot);
const afterEntries = entriesOf(afterRoot);
const bindingsFile = join(afterRoot, "node_modules", "@n1h", "sweetview-webview-bun", "src", "index.ts");
const bindingsVersion = existsSync(bindingsFile) ? JSON.parse(readFileSync(join(dirname(bindingsFile), "..", "package.json"), "utf8")).version : "missing";

const before = dumpSide(beforeRoot, beforeEntries);
const after = dumpSide(afterRoot, afterEntries);
const bindings = existsSync(bindingsFile) ? dumpSide(afterRoot, [{ spec: "@n1h/sweetview-webview-bun", file: bindingsFile, internal: false }]) : [];

const guideText = readFileSync(join(afterRoot, "docs", "upgrading.md"), "utf8");
const rows = parseGuide(guideText);

function printDump(title: string, recs: Rec[], entries: Entry[], note: string): string {
  const out = [`# ${title}`, `# ${note}`, `# ${recs.length} symbols, ${recs.reduce((n, r) => n + r.facts.size, 0)} facts`, ""];
  for (const e of entries) {
    const mine = recs.filter((r) => r.entry === e.spec);
    out.push(`## entry ${e.spec} [${e.internal ? "internal" : "app"}] ${relative(e.file.startsWith(afterRoot) ? afterRoot : beforeRoot, e.file).replaceAll("\\", "/")} (${mine.length} exports)`);
    for (const r of mine) {
      out.push(`symbol ${r.entry} :: ${r.name}`);
      for (const [k, v] of r.facts) out.push(`  ${k} = ${v}`);
    }
    out.push("");
  }
  return out.join("\n");
}

const key = (r: Rec) => `${r.entry}::${r.name}`;
const afterByKey = new Map(after.map((r) => [key(r), r]));
const afterByName = new Map<string, Rec[]>();
for (const r of after) afterByName.set(r.name, [...(afterByName.get(r.name) ?? []), r]);
const matchedAfter = new Set<string>();

const guideRowLines = guideText.split(/\r?\n/).map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.startsWith("|"));
const mentions = (word: string) => {
  const re = new RegExp("`[^`]*\\b" + word.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&") + "\\b[^`]*`");
  return guideRowLines.filter((x) => re.test(x.l)).map((x) => x.n);
};

/** The member name a fact key is about, for looking it up in the guide. */
const memberWord = (k: string) => /^(?:#|static\.|\.|enum\.|T\.)?([A-Za-z_$][\w$]*)/.exec(k.replace(/^(call|new)\[\d+\]\.p\d+\{[^}]*\}\./, ""))?.[1] ?? k;

function compare(b: Rec, a: Rec, out: string[], counts: Counts) {
  const keys = new Set([...b.facts.keys(), ...a.facts.keys()]);
  for (const k of keys) {
    if (k === "declared-in") continue;
    const bv = b.facts.get(k);
    const av = a.facts.get(k);
    if (bv === av) continue;
    if (av === undefined) {
      counts.memberRemoved++;
      const m = mentions(memberWord(k));
      out.push(`  - ${k} = ${bv}${m.length ? `   [guide rows naming \`${memberWord(k)}\`: ${m.slice(0, 6).join(",")}]` : "   [no guide row names it]"}`);
    } else if (bv === undefined) {
      counts.memberAdded++;
      out.push(`  + ${k} = ${av}`);
    } else {
      counts.memberChanged++;
      const m = mentions(memberWord(k));
      out.push(`  ~ ${k}`, `      before: ${bv}`, `      after:  ${av}${m.length ? `   [guide rows naming \`${memberWord(k)}\`: ${m.slice(0, 6).join(",")}]` : "   [no guide row names it]"}`);
    }
  }
}

type Counts = { mapped: number; same: number; viaGuide: number; moved: number; removed: number; guideTargetMissing: number; memberRemoved: number; memberChanged: number; memberAdded: number; identical: number };
const newCounts = (): Counts => ({ mapped: 0, same: 0, viaGuide: 0, moved: 0, removed: 0, guideTargetMissing: 0, memberRemoved: 0, memberChanged: 0, memberAdded: 0, identical: 0 });

function diffSurface(label: string, recs: Rec[], part: string): { text: string[]; counts: Counts } {
  const out: string[] = [`# ${label}`, ""];
  const counts = newCounts();
  for (const b of recs) {
    const k = key(b);
    const row = rows.find((r) => r.part === part && r.entry === b.entry && r.members.length === 0 && r.oldName === b.name);
    const t = row ? rowTarget(row) : { via: [] };
    let a = afterByKey.get(k);
    let how = "same entry and name";
    if (a) counts.same++;
    else if (t.key && afterByKey.get(t.key)) {
      a = afterByKey.get(t.key)!;
      how = `guide line ${row!.line}: ${row!.spans.join(" ; ")}  (${row!.change})`;
      counts.viaGuide++;
    } else if (afterByName.get(b.name)?.length) {
      a = afterByName.get(b.name)!.find((x) => !x.internal) ?? afterByName.get(b.name)![0]!;
      how = `same name exported by ${a.entry}${row ? `; guide line ${row.line} points at ${t.key ?? row.spans[0]}` : ""}`;
      counts.moved++;
    }
    if (!a) {
      if (row) {
        counts.guideTargetMissing++;
        out.push(`GUIDE-TARGET-NOT-AN-EXPORT ${k}  ->  guide line ${row.line}: ${row.spans.join(" ; ")}  (${row.change})`);
      } else {
        counts.removed++;
        out.push(`REMOVED ${k} (${b.facts.get("kind")})${mentions(b.name).length ? `   [guide rows naming it: ${mentions(b.name).slice(0, 6).join(",")}]` : "   [no guide row names it]"}`);
      }
      continue;
    }
    matchedAfter.add(key(a));
    const checks = row && how.startsWith("guide") ? targetChecks(row, a) : [];
    if (kindClass(b) !== kindClass(a)) {
      // A guide row that sends an export of one kind to an export of another (a constant to a class
      // method, a function to an option): the shapes are not comparable, so only the named targets are checked.
      counts.mapped++;
      out.push(`MAPPED ${k} (${b.facts.get("kind")}: ${b.facts.get("type") ?? b.facts.get("call[0]") ?? b.facts.get("value") ?? ""})  ->  ${key(a)} (${a.facts.get("kind")})  [${how}]`, ...checks.map((c) => `  ? ${c}`));
      continue;
    }
    const lines: string[] = [];
    compare(b, a, lines, counts);
    if (lines.length || checks.some((c) => /ABSENT|not found/.test(c))) out.push(`CHANGED ${k}  ->  ${key(a)}  [${how}]`, ...checks.map((c) => `  ? ${c}`), ...lines);
    else counts.identical++;
  }
  return { text: out, counts };
}

/** Kinds that can be compared fact by fact. */
function kindClass(r: Rec): string {
  const k = r.facts.get("kind") ?? "";
  if (k.startsWith("class")) return "class";
  if (k.includes("enum")) return "enum";
  if (k.startsWith("function")) return "function";
  if (k.startsWith("const") || k.startsWith("let")) return r.facts.has("call[0]") ? "function" : "const";
  if (k.startsWith("interface") || k.startsWith("type")) return "type";
  return k;
}

/** Whether what a guide row names after its import exists on the target: `Name#member`, `Name.member`, `new Name(…)`, `Name(…)`, and option fields the change column names as `field` or `field: value`. */
function targetChecks(row: Row, a: Rec): string[] {
  const res: string[] = [];
  const n = a.name.replace(/\$/g, "\\$");
  const has = (...ks: string[]) => ks.some((k) => a.facts.has(k));
  for (const s of row.spans.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^${n}#([\\w$]+)`).exec(s))) res.push(`${s}: ${has(`#${m[1]}`, `T.${m[1]}`, `.${m[1]}`) ? "member present" : "MEMBER ABSENT"}`);
    else if ((m = new RegExp(`^${n}\\.([\\w$]+)`).exec(s))) res.push(`${s}: ${has(`static.${m[1]}`, `.${m[1]}`, `enum.${m[1]}`, `T.${m[1]}`) ? "member present" : "MEMBER ABSENT"}`);
    else if (s.startsWith(`new ${a.name}(`)) res.push(`${s}: ${has("new[0]") ? "constructor present" : "MEMBER ABSENT"}`);
    else if (s.startsWith(`${a.name}(`)) res.push(`${s}: ${has("call[0]") ? "call present" : "MEMBER ABSENT"}`);
  }
  for (const m of row.change.matchAll(/`([a-z][\w$]*)(?::[^`]*)?`/g)) {
    const f = m[1]!;
    if (/^(true|false|null|undefined|bun|this|new)$/.test(f)) continue;
    const hit = [...a.facts.keys()].find((k) => k.endsWith(`.${f}`) || k === `#${f}` || k === `static.${f}` || k.startsWith(`#${f}(`));
    res.push(`\`${f}\` named in the change column: ${hit ? `found as ${hit}` : `not found on ${a.name}`}`);
  }
  return res;
}

const tagDiff = diffSurface("tag pre-rust-rewrite -> head (guide Part B)", before, "B");
const bindDiff = diffSurface(`bindings package @n1h/sweetview-webview-bun ${bindingsVersion} -> head (guide Part C)`, bindings, "C");

// 0.x: the published package is not installed in this checkout, so its surface is the guide's Part A rows.
const partA = rows.filter((r) => r.part === "A");
const partALines: string[] = ["# published @n1h/sweetview 0.1.x/0.2.x, as docs/upgrading.md Part A states it (the package itself is not installed here)", ""];
let aMissing = 0;
for (const r of partA) {
  const t = rowTarget(r);
  const ok = t.key ? afterByKey.has(t.key) : false;
  if (t.key && !ok) aMissing++;
  partALines.push(`${t.key && !ok ? "TARGET-NOT-AN-EXPORT " : ""}${r.entry}${r.members.length ? ` [${r.members.join("/")} member]` : ""} :: ${r.old}  ->  ${r.spans.join(" ; ")}  (${r.change})  [line ${r.line}]`);
}

// Names rust-rewrite/reference/bindings-exports.txt lists (2.8.0) that the installed package does not export:
// no source for them is in either checkout, so they are checked by name and guide row only.
const listed = readFileSync(join(afterRoot, "rust-rewrite", "reference", "bindings-exports.txt"), "utf8").split(/?
/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const notInstalled = listed.filter((n) => !bindings.some((b) => b.name === n));
const listedLines = [`# bindings names listed for 2.8.0 that the installed ${bindingsVersion} does not export (${notInstalled.length}): checked by name and guide row only`, ""];
for (const n of notInstalled) {
  const row = rows.find((r) => r.part === "C" && r.oldName === n);
  const t = row ? rowTarget(row) : { via: [] };
  const a = t.key ? afterByKey.get(t.key) : undefined;
  if (a) matchedAfter.add(key(a));
  listedLines.push(`${a ? "NAME-ONLY" : "NO-TARGET"} @n1h/sweetview-webview-bun::${n}  ->  ${row ? `guide line ${row.line}: ${row.spans.join(" ; ")} (${row.change})` : "no Part C row"}${a ? `; target ${a.facts.get("kind")}: ${a.facts.get("call[0]") ?? a.facts.get("type") ?? a.facts.get("new[0]") ?? ""}` : ""}`);
}

const added: string[] = ["# added at head: exports matched by no before symbol (same key, guide row or same name)", ""];
for (const a of after) {
  if (matchedAfter.has(key(a))) continue;
  const bindingName = bindings.some((b) => b.name === a.name);
  added.push(`ADDED ${a.internal ? "[internal] " : ""}${key(a)} (${a.facts.get("kind")})${bindingName ? " [same name as a bindings export]" : ""}`);
}

const totals = (c: Counts) => `same key ${c.same}, via guide row ${c.viaGuide} (of which mapped to another kind ${c.mapped}), same name elsewhere ${c.moved}, removed ${c.removed}, guide target not an export ${c.guideTargetMissing}; identical ${c.identical}; member facts removed ${c.memberRemoved}, changed ${c.memberChanged}, added ${c.memberAdded}`;
const summary = [
  `# api-diff summary`,
  `before (tag): ${before.length} symbols, ${before.reduce((n, r) => n + r.facts.size, 0)} facts, ${beforeEntries.length} entry points`,
  `bindings ${bindingsVersion}: ${bindings.length} symbols, ${bindings.reduce((n, r) => n + r.facts.size, 0)} facts`,
  `after (head): ${after.length} symbols, ${after.reduce((n, r) => n + r.facts.size, 0)} facts, ${afterEntries.length} entry points`,
  `guide rows: ${rows.length} (Part A ${partA.length}, Part B ${rows.filter((r) => r.part === "B").length}, Part C ${rows.filter((r) => r.part === "C").length})`,
  `tag -> head: ${totals(tagDiff.counts)}`,
  `bindings -> head: ${totals(bindDiff.counts)}`,
  `0.x (guide Part A): ${partA.length} rows, ${aMissing} whose first span imports a name the head does not export`,
  `bindings names listed for 2.8.0 and not in the installed package: ${notInstalled.length}`,
  `added at head: ${added.length - 2} symbols`,
  "",
];

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "api-audit-before.txt"),
  [
    printDump("before: tag pre-rust-rewrite", before, beforeEntries, "every export of every package.json exports entry at the tag, as the TypeScript compiler resolves it"),
    printDump(`before: bindings package @n1h/sweetview-webview-bun ${bindingsVersion}`, bindings, [{ spec: "@n1h/sweetview-webview-bun", file: bindingsFile, internal: false }], "src/index.ts of the installed package, the version this branch pins"),
    partALines.join("\n"),
  ].join("\n"),
);
writeFileSync(join(outDir, "api-audit-after.txt"), printDump("after: head", after, afterEntries, "every export of every package.json exports entry at the head, as the TypeScript compiler resolves it"));
writeFileSync(join(outDir, "api-audit-diff.txt"), [...summary, ...tagDiff.text, "", ...bindDiff.text, "", ...listedLines, "", ...added, ""].join("\n"));
console.log(summary.join("\n"));
