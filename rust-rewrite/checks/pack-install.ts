// Checklist item W8.1: packs every package as `bun publish` would, installs the tarballs with
// `bun add` into an empty project in the system temp directory, and runs a script there that loads
// the prebuilt binding through the installed package and uses it.
//
//   bun rust-rewrite/checks/pack-install.ts
//
// Nothing is published. The temp folder is removed at the end.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..");
const work = mkdtempSync(join(tmpdir(), "sweetview-pack-"));
const shown = (text: string) => text.replaceAll(work, "<TEMP>/pack").replaceAll(root, "<REPO>");

function run(cmd: string[], cwd: string) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, SWEETVIEW_NATIVE_PATH: "" } });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}

let failed = false;
try {
  const tarballs = join(work, "tarballs");
  const names: string[] = [];
  for (const dir of readdirSync(join(root, "packages"))) {
    const manifest = join(root, "packages", dir, "package.json");
    if (!(await Bun.file(manifest).exists())) continue;
    const name = JSON.parse(readFileSync(manifest, "utf8")).name as string;
    const packed = run(["bun", "pm", "pack", "--destination", tarballs], join(root, "packages", dir));
    if (packed.code !== 0) throw new Error(`bun pm pack failed in packages/${dir}:\n${packed.out}`);
    names.push(name);
  }
  const files = readdirSync(tarballs).sort();
  console.log(`packed ${files.length} packages: ${files.join(", ")}`);
  // The two bindings (D50): the native package's, with no webview, and the facade's, with it.
  const carried: string[][] = [];
  for (const tarball of [files.find((f) => f.includes("sweetview-native"))!, files.find((f) => /^n1h-sweetview-\d/.test(f))!]) {
    const listing = run(["tar", "-tzf", tarball], tarballs).out.split(/\r?\n/).filter((l) => l.includes("prebuilt/"));
    console.log(`prebuilt files inside ${tarball}:`);
    for (const line of listing) console.log(`  ${line}`);
    carried.push(listing);
  }
  const [nativeFiles, facadeFiles] = carried;
  if (!nativeFiles!.some((l) => l.endsWith("prebuilt/sweetview.win32-x64-msvc.node")) || !facadeFiles!.some((l) => l.endsWith("prebuilt/sweetview-webview.win32-x64-msvc.node"))) {
    throw new Error("a tarball does not carry its binding: the native package's sweetview.win32-x64-msvc.node, @n1h/sweetview's sweetview-webview.win32-x64-msvc.node");
  }

  // An empty project that depends on every tarball, so each package's dependencies on the
  // others resolve to the packed files and nothing comes from the registry or this checkout.
  const app = join(work, "app");
  const dependencies = Object.fromEntries(
    names.map((name) => [name, `file:../tarballs/${files.find((f) => f.startsWith(name.replace("@", "").replace("/", "-") + "-"))}`]),
  );
  await Bun.write(join(app, "package.json"), JSON.stringify({ name: "empty-project", private: true, type: "module", dependencies, overrides: dependencies }, null, 2));
  const installed = run(["bun", "install"], app);
  console.log(`$ bun install (in the empty project): exit ${installed.code}`);
  if (installed.code !== 0) throw new Error(installed.out);

  writeFileSync(
    join(app, "probe.ts"),
    `import { Screen, Window, Clipboard, pumpEvents } from "@n1h/sweetview/native";
import { ASSET_ORIGIN, RawWebview } from "@n1h/sweetview";
const window = new Window({ title: "pack-install probe", bounds: { x: 80, y: 80, width: 320, height: 200 } });
pumpEvents();
const report = {
  platform: process.platform + "-" + process.arch,
  bindingInstalled: require("node:fs").existsSync("node_modules/@n1h/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node"),
  webviewBindingInstalled: require("node:fs").existsSync("node_modules/@n1h/sweetview/prebuilt/sweetview-webview.win32-x64-msvc.node"),
  primaryScreenHasSize: Screen.primary().bounds.width > 0,
  windowHandleIsBigint: typeof window.handle === "bigint" && window.handle !== 0n,
  windowBounds: window.bounds(),
  clipboardIsCallable: typeof Clipboard.readText === "function",
  rawWebviewIsAClass: typeof RawWebview === "function",
  assetOrigin: ASSET_ORIGIN,
};
window.dispose();
console.log("PROBE " + JSON.stringify(report));
`,
  );
  const probe = run(["bun", "probe.ts"], app);
  console.log(`$ bun probe.ts (in the empty project): exit ${probe.code}`);
  console.log(shown(probe.out));
  if (probe.code !== 0 || !probe.out.includes("PROBE ")) failed = true;
} catch (err) {
  console.error(shown((err as Error).message));
  failed = true;
} finally {
  console.log(`removing ${shown(work)}`);
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? "FAIL" : "OK: the packed native package and @n1h/sweetview carry their bindings and the loader finds them after install");
process.exit(failed ? 1 : 0);
