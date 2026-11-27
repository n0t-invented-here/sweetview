// Prints the state of the Rust rewrite against rust-rewrite/REQUIREMENTS.md.
//
//   bun rust-rewrite/verify.ts windows            every check; the last line is the verdict
//   bun rust-rewrite/verify.ts windows --quick    skips the slow checks; can never print COMPLETE
//   bun rust-rewrite/verify.ts windows --ledger   also rewrites rust-rewrite/UNSAFE-LEDGER.md
//
// The goal's evaluator reads only what is printed in the session, so this
// script is the evidence: run it after the last change and show all of it.
// Checks may be added here. A check is never removed or loosened.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const platform = args.find((a) => a === "windows" || a === "macos");
const quick = args.includes("--quick");
const writeLedger = args.includes("--ledger");
if (!platform) {
  console.error("usage: bun rust-rewrite/verify.ts <windows|macos> [--quick] [--ledger]");
  process.exit(2);
}
const TAG = "pre-rust-rewrite";
const BRANCH = "v1-rust-rewrite";

type Result = { name: string; ok: boolean; skipped?: boolean; lines: string[] };
const results: Result[] = [];

function sh(cmd: string[], opts: { timeoutMs?: number } = {}): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? 30 * 60_000 });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const has = (rel: string) => existsSync(join(root, rel));
const tail = (text: string, n: number) => text.split(/\r?\n/).slice(-n);
const tracked = (...pathspec: string[]) => sh(["git", "ls-files", "--", ...pathspec]).out.split(/\r?\n/).filter(Boolean);

function check(name: string, heavy: boolean, body: () => { ok: boolean; lines: string[] }) {
  if (heavy && quick) {
    results.push({ name, ok: false, skipped: true, lines: ["skipped by --quick"] });
    return;
  }
  try {
    results.push({ name, ...body() });
  } catch (err) {
    results.push({ name, ok: false, lines: [`check threw: ${(err as Error).message}`] });
  }
}

// ---- blocked -----------------------------------------------------------------
check("blocked", false, () =>
  has("rust-rewrite/BLOCKED.md")
    ? { ok: false, lines: ["rust-rewrite/BLOCKED.md exists: the goal was declared blocked"] }
    : { ok: true, lines: ["no BLOCKED.md"] },
);

// ---- checklist ---------------------------------------------------------------
check("checklist", false, () => {
  const file = `rust-rewrite/CHECKLIST-${platform}.md`;
  const text = read(file).split(/\r?\n/);
  const open: string[] = [];
  const bare: string[] = [];
  let done = 0;
  for (let i = 0; i < text.length; i++) {
    const m = /^- \[( |x)\] (\S+)/.exec(text[i]!);
    if (!m) continue;
    const id = m[2]!;
    if (m[1] === " ") {
      open.push(id);
      continue;
    }
    done++;
    let evidence = false;
    for (let j = i + 1; j < text.length && !/^- \[( |x)\] /.test(text[j]!) && !/^#/.test(text[j]!); j++) {
      if (/```/.test(text[j]!) || /rust-rewrite\/evidence\//.test(text[j]!)) evidence = true;
    }
    if (!evidence) bare.push(id);
  }
  const lines = [`${done} ticked, ${open.length} open, ${bare.length} ticked without evidence`];
  if (open.length) lines.push(`open: ${open.join(" ")}`);
  if (bare.length) lines.push(`no evidence: ${bare.join(" ")}`);
  return { ok: open.length === 0 && bare.length === 0 && done > 0, lines };
});

// ---- ffi ---------------------------------------------------------------------
check("ffi", false, () => {
  const importing = sh(["git", "grep", "-l", "bun:ffi", "--", "packages", "demos"]).out.split(/\r?\n/).filter(Boolean);
  const allow = new Map<string, string>();
  if (has("rust-rewrite/ffi-allowlist.txt")) {
    for (const line of read("rust-rewrite/ffi-allowlist.txt").split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [path, ...reason] = line.split("\t");
      allow.set(path!.trim(), reason.join("\t").trim());
    }
  }
  const isWindowsFile = (p: string) => /(^|\/)win32\//.test(p) || /\/win-[^/]*$/.test(p);
  const isMacFile = (p: string) => /(^|\/)darwin\//.test(p) || /\/(mac|darwin)-[^/]*$/.test(p);
  const bad: string[] = [];
  for (const file of importing) {
    const reason = allow.get(file);
    if (reason === undefined) bad.push(`${file}: imports bun:ffi and is not in ffi-allowlist.txt`);
    else if (reason === "") bad.push(`${file}: allowlisted with no reason`);
    else if (reason.startsWith("probe:")) {
      if (file.startsWith("packages/") && !/\.test\.ts$|\/test\//.test(file)) bad.push(`${file}: a probe must be a test or a script, not package source`);
    } else if (platform === "macos") bad.push(`${file}: only probes may remain after the macOS goal`);
    else if (isWindowsFile(file) || !isMacFile(file)) bad.push(`${file}: runs on Windows and still imports bun:ffi`);
  }
  return { ok: bad.length === 0, lines: [`${importing.length} files import bun:ffi, ${allow.size} allowlisted`, ...bad] };
});

// ---- engine (the C++ library and its bindings package) -------------------------
check("engine", false, () => {
  const hits = sh(["git", "grep", "-l", "sweetview-webview-bun", "--", "*package.json"]).out.split(/\r?\n/).filter(Boolean);
  if (platform === "windows") return { ok: true, lines: [`${hits.length} package.json files still name the bindings package (allowed until the macOS goal)`] };
  return { ok: hits.length === 0, lines: hits.length ? hits.map((h) => `${h}: still depends on @n1h/sweetview-webview-bun`) : ["no package depends on the bindings package"] };
});

// ---- unsafe ------------------------------------------------------------------
check("unsafe", false, () => {
  const files = tracked("crates").filter((f) => f.endsWith(".rs"));
  if (files.length === 0) return { ok: false, lines: ["no Rust sources under crates/"] };
  const bad: string[] = [];
  const ledger: [string, number][] = [];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    let blocks = 0;
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i]!.replace(/\/\/.*$/, "");
      if (!/\bunsafe\b/.test(code) || /forbid\(unsafe_code\)|unsafe_op_in_unsafe_fn/.test(code)) continue;
      blocks++;
      const near = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      if (!/SAFETY:|# Safety/.test(near)) bad.push(`${file}:${i + 1}: unsafe without a SAFETY comment`);
    }
    if (blocks > 0) {
      ledger.push([file, blocks]);
      if (!file.startsWith("crates/sweetview-platform/")) bad.push(`${file}: ${blocks} unsafe outside crates/sweetview-platform`);
    }
  }
  for (const lib of tracked("crates").filter((f) => /^crates\/[^/]+\/src\/lib\.rs$/.test(f))) {
    if (lib.startsWith("crates/sweetview-platform/")) {
      for (const lint of ["unsafe_op_in_unsafe_fn", "clippy::undocumented_unsafe_blocks", "clippy::multiple_unsafe_ops_per_block"]) {
        if (!read(lib).includes(lint)) bad.push(`${lib}: missing #![deny(${lint})]`);
      }
    } else if (!read(lib).includes("#![forbid(unsafe_code)]")) bad.push(`${lib}: missing #![forbid(unsafe_code)]`);
  }
  const total = ledger.reduce((n, [, c]) => n + c, 0);
  if (writeLedger) {
    const rows = ledger.map(([f, c]) => `| \`${f}\` | ${c} |`).join("\n");
    const path = join(root, "rust-rewrite/UNSAFE-LEDGER.md");
    const reasons = existsSync(path) ? (readFileSync(path, "utf8").split("## Reasons")[1] ?? "\n\n") : "\n\n";
    writeFileSync(path, `# Unsafe ledger\n\nRewritten by \`bun rust-rewrite/verify.ts <platform> --ledger\`. ${total} uses in ${ledger.length} files.\n\n| File | Uses of \`unsafe\` |\n|---|---|\n${rows}\n\n## Reasons${reasons}`);
  }
  return { ok: bad.length === 0, lines: [`${files.length} Rust files, ${total} uses of unsafe in ${ledger.length} files`, ...ledger.map(([f, c]) => `  ${c}  ${f}`), ...bad] };
});

// ---- cargo -------------------------------------------------------------------
check("cargo", true, () => {
  if (!has("Cargo.toml")) return { ok: false, lines: ["no Cargo.toml at the repository root"] };
  const test = sh(["cargo", "test", "--workspace"]);
  const clippy = sh(["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]);
  return {
    ok: test.code === 0 && clippy.code === 0,
    lines: [`cargo test --workspace: exit ${test.code}`, ...tail(test.out, 6), `cargo clippy -D warnings: exit ${clippy.code}`, ...tail(clippy.out, 6)],
  };
});

// ---- tests -------------------------------------------------------------------
check("tests", true, () => {
  const types = sh(["bun", "run", "typecheck"]);
  const tests = sh(["bun", "test"]);
  return {
    ok: types.code === 0 && tests.code === 0,
    lines: [`bun run typecheck: exit ${types.code}`, ...tail(types.out, 4), `bun test: exit ${tests.code}`, ...tail(tests.out, 8)],
  };
});

// ---- demos -------------------------------------------------------------------
check("demos", true, () => {
  const built = sh(["just", "compile"], { timeoutMs: 60 * 60_000 });
  return { ok: built.code === 0, lines: [`just compile: exit ${built.code}`, ...tail(built.out, 8)] };
});

// ---- api surface -------------------------------------------------------------
check("api-surface", false, () => {
  if (sh(["git", "rev-parse", "--verify", "--quiet", `${TAG}^{commit}`]).code !== 0) return { ok: false, lines: [`tag ${TAG} does not exist`] };
  const exportsOf = (source: string): Set<string> => {
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
  const before = sh(["git", "ls-tree", "-r", "--name-only", TAG, "--", "packages"]).out.split(/\r?\n/).filter((f) => /^packages\/[^/]+\/src\/index\.ts$/.test(f));
  const missing: string[] = [];
  let count = 0;
  for (const file of before) {
    const old = exportsOf(sh(["git", "show", `${TAG}:${file}`]).out);
    const now = has(file) ? exportsOf(read(file)) : new Set<string>();
    for (const name of old) {
      count++;
      if (!now.has(name)) missing.push(`${file}: export ${name} is gone`);
    }
  }
  return { ok: missing.length === 0 && count > 0, lines: [`${count} exports of ${before.length} package entry points at ${TAG}, ${missing.length} missing now`, ...missing] };
});

// ---- upgrade guide -----------------------------------------------------------
check("upgrade-guide", false, () => {
  const guide = has("docs/upgrading.md");
  const compat = tracked("rust-rewrite/compat").filter((f) => f.endsWith(".test.ts"));
  const removed = guide ? read("docs/upgrading.md").split(/\r?\n/).filter((l) => /^\|.*\b(removed|no longer available|not supported anymore)\b/i.test(l)) : [];
  return {
    ok: guide && compat.length > 0 && removed.length === 0,
    lines: [`docs/upgrading.md: ${guide ? "present" : "missing"}`, `rust-rewrite/compat: ${compat.length} test files`, ...removed.map((l) => `row says an export is gone: ${l.slice(0, 100)}`)],
  };
});

// ---- dependents (private; only what is under rust-rewrite/local/) --------------
check("dependents", false, () => {
  if (!has("rust-rewrite/local/dependents.txt")) return { ok: true, lines: ["no rust-rewrite/local/dependents.txt on this machine: nothing to verify"] };
  const count = read("rust-rewrite/local/dependents.txt").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).length;
  if (!has("rust-rewrite/local/dependents-result.md")) return { ok: false, lines: [`${count} applications listed and no dependents-result.md`] };
  const result = read("rust-rewrite/local/dependents-result.md");
  const passes = (result.match(/^RESULT: PASS$/gm) ?? []).length;
  const fails = (result.match(/^RESULT: FAIL$/gm) ?? []).length;
  return { ok: fails === 0 && passes === count, lines: [`${count} applications listed, ${passes} passed, ${fails} failed (names are not printed)`] };
});

// ---- privacy -----------------------------------------------------------------
check("privacy", false, () => {
  const bad: string[] = [];
  const ignored = sh(["git", "check-ignore", "-q", "rust-rewrite/local/x"]).code === 0;
  if (!ignored) bad.push("rust-rewrite/local/ is not ignored by git");
  if (tracked("rust-rewrite/local").length) bad.push("files under rust-rewrite/local/ are tracked");
  const base = sh(["git", "rev-parse", "--verify", "--quiet", `${TAG}^{commit}`]).code === 0 ? TAG : "origin/main";
  const changed = sh(["git", "diff", "--name-only", "--diff-filter=AM", `${base}..HEAD`]).out.split(/\r?\n/).filter((f) => f && has(f) && !/\.(png|ico|icns|glb|node|dll|dylib|so|lock)$/.test(f));
  const localPath = /\b[A-Za-z]:[\\/]+Users[\\/]|\/Users\/[A-Za-z0-9._-]+\/|\/home\/[a-z0-9._-]+\//;
  const terms = has("rust-rewrite/local/private-terms.txt") ? read("rust-rewrite/local/private-terms.txt").split(/\r?\n/).map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
  const messages = sh(["git", "log", "--format=%B", `${base}..HEAD`]).out.toLowerCase();
  let pathHits = 0;
  let termHits = 0;
  for (const file of changed) {
    if (file === "rust-rewrite/verify.ts") continue;
    const text = read(file);
    if (localPath.test(text) && !/^(README\.md|docs\/|\.apmm\/)/.test(file)) {
      pathHits++;
      bad.push(`${file}: contains a machine-local absolute path`);
    }
    const lower = text.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      termHits++;
      bad.push(`${file}: contains a term from the private list`);
    }
  }
  if (terms.some((t) => messages.includes(t))) {
    termHits++;
    bad.push("a commit message contains a term from the private list");
  }
  return { ok: bad.length === 0, lines: [`${changed.length} changed files scanned since ${base}; ${terms.length} private terms loaded; ${pathHits} path hits, ${termHits} term hits`, ...bad] };
});

// ---- git ---------------------------------------------------------------------
check("git", false, () => {
  const branch = sh(["git", "branch", "--show-current"]).out;
  const dirty = sh(["git", "status", "--porcelain", "--untracked-files=no"]).out.split(/\r?\n/).filter(Boolean);
  const ahead = sh(["git", "rev-list", "--count", "@{u}..HEAD"]);
  const untracked = sh(["git", "ls-files", "--others", "--exclude-standard", "--", "crates", "packages", "rust-rewrite", "docs", "demos"]).out.split(/\r?\n/).filter(Boolean);
  const ok = branch === BRANCH && dirty.length === 0 && ahead.code === 0 && ahead.out === "0" && untracked.length === 0;
  return {
    ok,
    lines: [`branch ${branch}; ${dirty.length} modified tracked files; ${untracked.length} untracked files in project folders; unpushed commits: ${ahead.code === 0 ? ahead.out : "no upstream"}`, ...dirty.slice(0, 8), ...untracked.slice(0, 8)],
  };
});

// ---- report ------------------------------------------------------------------
const mode = quick ? "quick" : "full";
console.log(`sweetview rust rewrite: ${platform}, mode=${mode}, ${new Date().toISOString()}, ${sh(["git", "rev-parse", "--short", "HEAD"]).out}`);
for (const r of results) {
  console.log(`${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  for (const line of r.lines) console.log(`      ${line}`);
}
const failing = results.filter((r) => !r.ok).map((r) => r.name);
const label = platform.toUpperCase();
if (failing.length === 0 && !quick) console.log(`SWEETVIEW-REWRITE ${label}: COMPLETE mode=full`);
else console.log(`SWEETVIEW-REWRITE ${label}: INCOMPLETE mode=${mode} failing=${failing.join(",")}`);
process.exit(failing.length === 0 && !quick ? 0 : 1);
