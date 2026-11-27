// Prints where every package of the Cargo workspace comes from (checklist item W0.4):
// every dependency from crates.io at a version pinned in Cargo.lock, no git dependency,
// and no path dependency outside this repository, which is what "no crate is forked" means.
//
//   bun rust-rewrite/checks/cargo-sources.ts

import { dirname, join } from "node:path";

const root = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..");
const run = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked"], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (run.exitCode !== 0) {
  console.error(run.stderr.toString());
  process.exit(1);
}
type Package = { name: string; version: string; source: string | null; manifest_path: string };
const meta = JSON.parse(run.stdout.toString()) as { packages: Package[]; workspace_root: string };
const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
const workspaceRoot = norm(meta.workspace_root);

const cratesIo = meta.packages.filter((p) => p.source?.startsWith("registry+https://github.com/rust-lang/crates.io-index"));
const git = meta.packages.filter((p) => p.source?.startsWith("git+"));
const path = meta.packages.filter((p) => p.source === null);
const outside = path.filter((p) => !norm(p.manifest_path).startsWith(`${workspaceRoot}/`));
const other = meta.packages.filter((p) => p.source !== null && !cratesIo.includes(p) && !git.includes(p));

console.log(`packages in the dependency graph: ${meta.packages.length} (cargo metadata --locked: Cargo.lock is current)`);
console.log(`from crates.io: ${cratesIo.length}`);
console.log(`git dependencies: ${git.length}${git.length ? `: ${git.map((p) => p.name).join(", ")}` : ""}`);
console.log(`other registries: ${other.length}${other.length ? `: ${other.map((p) => p.name).join(", ")}` : ""}`);
console.log(`path packages: ${path.length}: ${path.map((p) => p.name).sort().join(", ")}`);
console.log(`path packages outside this repository: ${outside.length}${outside.length ? `: ${outside.map((p) => p.name).join(", ")}` : ""}`);
console.log("versions of the crates the design names:");
for (const name of ["tao", "wry", "muda", "tray-icon", "rfd", "napi", "napi-derive", "napi-build", "windows", "webview2-com"]) {
  const versions = meta.packages.filter((p) => p.name === name).map((p) => p.version);
  console.log(`  ${name}: ${versions.join(", ") || "not a dependency yet"}`);
}
const ok = git.length === 0 && other.length === 0 && outside.length === 0;
console.log(ok ? "OK: no crate is forked" : "FAIL");
process.exit(ok ? 0 : 1);
