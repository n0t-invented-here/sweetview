// D50: the webview is not in the native package. An application that imports only the native
// package (here `demos/menubar-only`, through `@n1h/sweetview/native`, which is the native package)
// bundles no webview module and no reference to the webview binding; the binding the native package
// ships holds no WebView2 code; and the running demo loads that binding and no other. Each proof has
// its control: the same check on an application of `@n1h/sweetview` finds the webview.

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const onWindows = process.platform === "win32";
const NATIVE_BINDING = join(root, "packages/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node");
const WEBVIEW_BINDING = join(root, "packages/sweetview/prebuilt/sweetview-webview.win32-x64-msvc.node");

/** What a bundle of `entry` holds of the webview: its modules, and the files it emits beside the code. */
async function bundleOf(entry: string): Promise<{ webviewModules: string[]; bindings: string[] }> {
  const outdir = mkdtempSync(join(tmpdir(), "sweetview-split-"));
  try {
    const built = await Bun.build({ entrypoints: [join(root, entry)], target: "bun", outdir });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const code = built.outputs.filter((o) => o.kind === "entry-point" || o.kind === "chunk");
    const text = (await Promise.all(code.map((o) => o.text()))).join("\n");
    const webviewModules = ["raw-webview.ts", "webview-host.ts", "darwin/webview.ts"].filter((m) => text.includes(m));
    const bindings = built.outputs.filter((o) => o.path.endsWith(".node")).map((o) => (o.path.includes("sweetview-webview") ? "webview" : "native"));
    if (text.includes("sweetview-webview.win32-x64-msvc.node")) bindings.push("webview (named in the code)");
    return { webviewModules, bindings: [...new Set(bindings)].sort() };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

/** Which of the WebView2 names occur in a binary, as bytes. */
function webview2NamesIn(file: string): string[] {
  const bytes = readFileSync(file).toString("latin1");
  return ["CoreWebView2", "WebView2Loader", "wry"].filter((name) => bytes.includes(name));
}

/** The Sweetview bindings a process has loaded, by file name. */
function loadedBindings(pid: number): string[] {
  const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(Get-Process -Id ${pid}).Modules | ForEach-Object { $_.FileName }`], { stdout: "pipe" });
  return listed.stdout
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[\\/]/).pop() ?? "")
    .filter((name) => name.startsWith("sweetview") && name.endsWith(".node"))
    .sort();
}

/** Starts `args`, waits until it has loaded a Sweetview binding (or 15 s), and returns what it loaded. */
async function bindingsLoadedBy(args: string[], cwd: string): Promise<string[]> {
  const child = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, SWEETVIEW_NATIVE_PATH: "" } });
  try {
    const until = Date.now() + 15_000;
    let seen: string[] = [];
    while (Date.now() < until && seen.length === 0) {
      await Bun.sleep(500);
      seen = loadedBindings(child.pid);
    }
    // A little longer, so a second binding loaded later would be seen too.
    await Bun.sleep(1_000);
    return loadedBindings(child.pid);
  } finally {
    child.kill();
    await child.exited;
  }
}

describe("the webview is not in the native package (D50)", () => {
  test("the bundle of demos/menubar-only holds no webview module and no reference to the webview binding; an application of @n1h/sweetview holds both", async () => {
    expect({ menubarOnly: await bundleOf("demos/menubar-only/app.ts"), facade: await bundleOf("rust-rewrite/compat/fixtures/facade-binding.ts") }).toEqual({
      menubarOnly: { webviewModules: [], bindings: ["native"] },
      facade: { webviewModules: ["raw-webview.ts", "webview-host.ts", "darwin/webview.ts"], bindings: ["native", "webview", "webview (named in the code)"] },
    });
  }, 60_000);

  test.skipIf(!onWindows)("the binding the native package ships holds no CoreWebView2, WebView2Loader or wry; the facade's holds them", () => {
    expect({ native: webview2NamesIn(NATIVE_BINDING), webview: webview2NamesIn(WEBVIEW_BINDING).length > 0 }).toEqual({ native: [], webview: true });
  });

  test.skipIf(!onWindows)("demos/menubar-only running loads the native binding only", async () => {
    expect(await bindingsLoadedBy(["bun", "app.ts"], join(root, "demos/menubar-only"))).toEqual(["sweetview.win32-x64-msvc.node"]);
  }, 30_000);

  test.skipIf(!onWindows)("an application of @n1h/sweetview loads the facade's binding only, which has the native calls too", async () => {
    expect(await bindingsLoadedBy(["bun", join(import.meta.dir, "fixtures/facade-binding.ts")], root)).toEqual(["sweetview-webview.win32-x64-msvc.node"]);
  }, 30_000);

  test.skipIf(!onWindows)("demos/web-app shows its window from source and as a compiled executable copied alone into an empty folder, loading one binding", async () => {
    const built = Bun.spawnSync(["just", "demos::web-app::compile-win"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(built.stdout.toString() + built.stderr.toString());
    const alone = mkdtempSync(join(tmpdir(), "sweetview-alone-"));
    try {
      copyFileSync(join(root, "demos/web-app/dist/web-app-windows-x64.exe"), join(alone, "web-app-windows-x64.exe"));
      const fromSource = await windowAndModules(["bun", "app.ts"], join(root, "demos/web-app"));
      const compiled = await windowAndModules([join(alone, "web-app-windows-x64.exe")], alone);
      expect({ fromSource, compiled: { ...compiled, nodeModules: compiled.nodeModules.length }, folder: readdirSync(alone) }).toEqual({
        fromSource: { window: "Web App", nodeModules: ["sweetview-webview.win32-x64-msvc.node"] },
        compiled: { window: "Web App", nodeModules: 1 },
        folder: ["web-app-windows-x64.exe"],
      });
    } finally {
      rmSync(alone, { recursive: true, force: true });
    }
  }, 180_000);
});

/** Starts `args`, waits up to 40 s for its main window, and returns the window's title and the `.node` files it loaded. */
async function windowAndModules(args: string[], cwd: string): Promise<{ window: string; nodeModules: string[] }> {
  const child = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, SWEETVIEW_NATIVE_PATH: "" } });
  const ask = (script: string) => Bun.spawnSync(["powershell", "-NoProfile", "-Command", script], { stdout: "pipe" }).stdout.toString().trim();
  try {
    const until = Date.now() + 40_000;
    let window = "";
    while (Date.now() < until && window === "") {
      await Bun.sleep(500);
      window = ask(`(Get-Process -Id ${child.pid}).MainWindowTitle`);
    }
    await Bun.sleep(1_000);
    const nodeModules = ask(`(Get-Process -Id ${child.pid}).Modules | ForEach-Object { $_.FileName }`)
      .split(/\r?\n/)
      .map((line) => line.trim().split(/[\\/]/).pop() ?? "")
      .filter((name) => name.endsWith(".node"))
      .sort();
    return { window, nodeModules };
  } finally {
    child.kill();
    await child.exited;
  }
}
