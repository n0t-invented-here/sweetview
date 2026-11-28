# Running an application against a local Sweetview checkout

Sweetview 1.0.0 is not on npm yet ([Install](../README.md#install)), so an
application in its own repository that depends on `@n1h/sweetview` `^1.0.0`
(or on `@n1h/sweetview-native`, `@n1h/sweetview-build`, …) cannot install it.
It can run against a Sweetview checkout on the same machine instead, through
Bun's link registry. No command takes a path: the checkout registers its
packages by name, and the application asks for them by name.

- [The commands](#the-commands)
- [What changes in the application](#what-changes-in-the-application)
- [Changing Sweetview while an application is linked](#changing-sweetview-while-an-application-is-linked)
- [The justfile recipes for an application](#the-justfile-recipes-for-an-application)
- [Without just](#without-just)

## The commands

In the Sweetview checkout, on the `v1-rust-rewrite` branch, once:

```sh
just link
```

It builds the Rust binding (`just native build`) and registers the eight
packages under `packages/` with `bun link`.

In the application's checkout, with the [two recipes below](#the-justfile-recipes-for-an-application)
in its `justfile`:

```sh
just link-sweetview
```

`bun install`, `bun run`, `bun test` and `bun build --compile` then use the
checkout's packages, in every workspace package of the application. To go
back, in the application:

```sh
just unlink-sweetview
```

and, when no application needs it any more, in the Sweetview checkout:

```sh
just unlink
```

Run `just unlink-sweetview` first: after `just unlink`, a linked
application's next `bun install` fails with `Package "@n1h/sweetview" is not
linked`, and an application that is a workspace no longer finds the packages
at all (see [What changes in the application](#what-changes-in-the-application)).

## What changes in the application

`just link-sweetview` adds a root `overrides` entry for each of the eight
package names, `"@n1h/sweetview": "link:@n1h/sweetview"` and so on, and runs
`bun install`. An override applies to the dependency wherever it is declared,
so one block at the root covers every workspace package of the application.
`link:@n1h/sweetview` is a name in Bun's link registry, not a path, so
`package.json` and `bun.lock` hold no path while linked: `bun.lock` records
the same `link:` names. The path is only in `node_modules`, which is not
tracked: each `@n1h/sweetview*` folder there is a link. In an application of
one package (Bun's hoisted install) it points at the checkout's package
folder, as registered when `bun install` last ran. In an application that is
a workspace (Bun's isolated install) it points at the entry in Bun's link
registry, under the user's Bun folder, so it follows whichever checkout is
registered now.

An override for a package the application does not depend on does nothing,
so the recipe names all eight; `just link` registers all eight. A linked
package's own `workspace:*` dependencies (`@n1h/sweetview` on
`@n1h/sweetview-native`, …) resolve inside the checkout, through its own
`node_modules`, so the checkout needs its `bun install`, which `just link`
runs. As with the packages from npm, under Bun's isolated installs the
application reaches only the packages it names: it imports
`@n1h/sweetview-native` itself only when it depends on it ([Upgrading, step
A.1](upgrading.md#a-published-01x-or-02x)). When it names both, both resolve
to the same folder, so there is one copy of each module.

`bun build --compile --target=bun-windows-x64` embeds the binding from the
checkout's `prebuilt/` as it does from an installed package: the executable,
alone in an empty folder, runs.

`just link-sweetview` refuses to start when `package.json` or `bun.lock`
has uncommitted edits, so that `just unlink-sweetview` can put both back as
committed (`git status` is clean afterwards). It also refuses, in one
sentence, when no checkout on this machine has run `just link`. While
linked, do not commit `package.json` or `bun.lock`: the `link:` entries would
make the application's install fail on every machine where Sweetview is not
registered. An edit made to `package.json` while linked is kept by
`just unlink-sweetview`, which then lets `bun install` rewrite `bun.lock`.

`just unlink-sweetview` runs `bun install` after putting the files back.
Until the versions the application names are on npm, that install fails, and
the recipe says so: `package.json` and `bun.lock` are back as committed, but
`node_modules` still holds the links.

## Changing Sweetview while an application is linked

- **TypeScript** under `packages/`: nothing to run. The application's next
  `bun run` or `bun test` reads the checkout's files.
- **Rust** under `crates/`: run `just native build` in the checkout (or
  `just link` again, which builds first). Stop the application first: on
  Windows a running process holds the binding open, and the build cannot
  replace it.
- **A compiled executable** embeds what it was built from, so build it again
  after either change.
- **Another checkout**: a name is registered by the last `just link` that
  registered it. After `just link` in the other checkout, run `bun install`
  in the application (a workspace application follows at once; one of a
  single package points at a checkout's folder until it installs again).
  `just unlink` removes the names whichever checkout registered them.

## The justfile recipes for an application

Copy these into the application's `justfile`, at its root beside
`package.json` and `bun.lock`. The recipes are TypeScript run by Bun, through
`just`'s `[script]` attribute (tested with `just` 1.58), so they run the same
whatever shell the `justfile` sets.

```just
sweetview_packages := "@n1h/sweetview @n1h/sweetview-build @n1h/sweetview-ipc @n1h/sweetview-ipc-electron @n1h/sweetview-ipc-tauri @n1h/sweetview-ipc-ws @n1h/sweetview-native @n1h/sweetview-settings"

# Resolve every @n1h/sweetview* dependency to the packages `just link` registered in a Sweetview checkout
[script("bun")]
[extension(".ts")]
link-sweetview:
    import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const names = "{{sweetview_packages}}".split(" ");
    const fail = (sentence: string): never => { console.error(`link-sweetview: ${sentence}`); process.exit(1); };
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args]);
    if (git("ls-files", "--error-unmatch", "package.json", "bun.lock").exitCode !== 0) fail("package.json and bun.lock must both be committed, so that unlink-sweetview can put them back.");
    if (git("status", "--porcelain", "--", "package.json", "bun.lock").stdout.length > 0) fail("package.json or bun.lock has uncommitted edits; commit or discard them first, so that unlink-sweetview can put them back exactly.");
    // `bun link --dry-run <names>` in an empty project fails when a name is not registered.
    const probe = mkdtempSync(join(tmpdir(), "link-sweetview-"));
    writeFileSync(join(probe, "package.json"), '{ "name": "link-sweetview-probe", "private": true }');
    const registered = Bun.spawnSync(["bun", "link", "--dry-run", ...names], { cwd: probe }).exitCode === 0;
    rmSync(probe, { recursive: true, force: true });
    if (!registered) fail("Sweetview's packages are not registered on this machine; run `just link` in your Sweetview checkout, then run this again.");
    const text = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(text);
    pkg.overrides = { ...pkg.overrides, ...Object.fromEntries(names.map((name) => [name, `link:${name}`])) };
    writeFileSync("package.json", JSON.stringify(pkg, null, text.match(/\n([ \t]+)"/)?.[1] ?? 2) + "\n");
    if (Bun.spawnSync(["bun", "install"], { stdio: ["inherit", "inherit", "inherit"] }).exitCode !== 0) {
      git("checkout", "--", "package.json", "bun.lock");
      fail("bun install failed (above); package.json and bun.lock are back as committed.");
    }
    console.log("link-sweetview: every @n1h/sweetview* dependency now resolves to the local Sweetview checkout; run `just unlink-sweetview` to undo.");

# Undo link-sweetview: package.json and bun.lock back as committed, then bun install
[script("bun")]
[extension(".ts")]
unlink-sweetview:
    import { readFileSync, writeFileSync } from "node:fs";
    import { isDeepStrictEqual } from "node:util";
    const names = "{{sweetview_packages}}".split(" ");
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args]);
    const head = JSON.parse(git("show", "HEAD:package.json").stdout.toString());
    const text = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(text);
    for (const name of names) {
      if (pkg.overrides?.[name] !== `link:${name}`) continue;
      if (head.overrides && name in head.overrides) pkg.overrides[name] = head.overrides[name];
      else delete pkg.overrides[name];
    }
    if (pkg.overrides && Object.keys(pkg.overrides).length === 0 && !head.overrides) delete pkg.overrides;
    // Nothing else edited: both files exactly as committed. Otherwise keep the other edits.
    if (isDeepStrictEqual(pkg, head)) git("checkout", "--", "package.json", "bun.lock");
    else { writeFileSync("package.json", JSON.stringify(pkg, null, text.match(/\n([ \t]+)"/)?.[1] ?? 2) + "\n"); git("checkout", "--", "bun.lock"); }
    if (Bun.spawnSync(["bun", "install"], { stdio: ["inherit", "inherit", "inherit"] }).exitCode !== 0) {
      console.error("unlink-sweetview: package.json and bun.lock no longer link Sweetview, but bun install failed (above), so node_modules still holds the local packages; until the versions this application names are on npm there is nothing else to install.");
      process.exit(1);
    }
    console.log("unlink-sweetview: the @n1h/sweetview* dependencies come from the registry again.");
```

## Without just

The same, by hand, in the application's checkout. Add to the root
`package.json`, merged with any `overrides` already there, the names the
application depends on (all eight do no harm):

```json
"overrides": {
  "@n1h/sweetview": "link:@n1h/sweetview",
  "@n1h/sweetview-build": "link:@n1h/sweetview-build",
  "@n1h/sweetview-ipc": "link:@n1h/sweetview-ipc",
  "@n1h/sweetview-ipc-electron": "link:@n1h/sweetview-ipc-electron",
  "@n1h/sweetview-ipc-tauri": "link:@n1h/sweetview-ipc-tauri",
  "@n1h/sweetview-ipc-ws": "link:@n1h/sweetview-ipc-ws",
  "@n1h/sweetview-native": "link:@n1h/sweetview-native",
  "@n1h/sweetview-settings": "link:@n1h/sweetview-settings"
}
```

then run `bun install`. To undo, with no other edits to the two files:

```sh
git checkout -- package.json bun.lock
bun install
```

`bun link @n1h/sweetview` alone, in the application, is not enough: it puts
the link in `node_modules` and writes nothing, so the next `bun install`
resolves `^1.0.0` against npm and fails. In an application that is a
workspace, `bun link @n1h/sweetview` and `bun link --save @n1h/sweetview`
fail at once, resolving the workspace packages' own `^1.0.0` against npm;
`--save` would only have written `link:` into the root's own `dependencies`.
