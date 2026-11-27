// Type-checks every crate of the workspace for macOS from a machine that has no Apple toolchain
// (requirement R8; recorded in rust-rewrite/HANDOFF-macos.md).
//
//   bun rust-rewrite/checks/mac-check.ts
//
// `cargo check` never links, but one dependency (`objc2-exception-helper`, pulled in by `wry` on
// macOS) compiles a small Objective-C file in its build script, which needs a C compiler for the
// Apple target. This script gives cargo a stand-in for that compiler and for the archiver: a
// program that creates the output file it is asked for and nothing else. The Rust of every crate,
// ours and the dependencies', is still checked by rustc for `aarch64-apple-darwin`. What this does
// not check: linking, and anything at run time. Those need a Mac.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..");
const TARGET = "aarch64-apple-darwin";

const installed = Bun.spawnSync(["rustup", "target", "list", "--installed"], { stdout: "pipe" }).stdout.toString();
if (!installed.split(/\r?\n/).includes(TARGET)) {
  console.error(`the Rust target ${TARGET} is not installed: rustup target add ${TARGET}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "sweetview-mac-check-"));
try {
  const source = join(work, "stand-in.ts");
  writeFileSync(
    source,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const o = args.indexOf("-o");
if (o >= 0 && args[o + 1]) writeFileSync(args[o + 1], "");
else {
  const archive = args.find((a) => /\\.(a|lib)$/.test(a));
  if (archive) writeFileSync(archive, "!<arch>\\n");
}
`,
  );
  const standIn = join(work, process.platform === "win32" ? "stand-in.exe" : "stand-in");
  const built = Bun.spawnSync(["bun", "build", "--compile", source, "--outfile", standIn], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) {
    console.error(built.stderr.toString());
    process.exit(1);
  }
  const env = { ...process.env, CC_aarch64_apple_darwin: standIn, AR_aarch64_apple_darwin: standIn };
  console.log(`$ cargo check --target ${TARGET} --workspace   (C compiler and archiver: a stand-in that creates empty outputs)`);
  const check = Bun.spawnSync(["cargo", "check", "--target", TARGET, "--workspace", "--target-dir", "target/mac-check"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30 * 60_000,
  });
  const output = (check.stdout.toString() + check.stderr.toString()).trim().split(/\r?\n/);
  const problems = output.filter((line) => /^(warning|error)/.test(line));
  // Paths are printed relative to the repository, so the output can be kept as evidence.
  const shown = (line: string) => line.replaceAll(root, "<REPO>").replaceAll(root.replaceAll("\\", "/"), "<REPO>");
  for (const line of problems.length ? output.slice(-60) : output.slice(-4)) console.log(shown(line));
  console.log(`exit: ${check.exitCode}; warnings and errors: ${problems.length}`);
  process.exitCode = check.exitCode === 0 ? 0 : 1;
} finally {
  // The folder this run made, and nothing else.
  console.log(`removing ${work.replace(tmpdir(), "<TEMP>")}`);
  rmSync(work, { recursive: true, force: true });
}
