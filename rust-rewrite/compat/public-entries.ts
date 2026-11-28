// The entry points an application is meant to import, by package: each documented in docs/ (a
// standalone package's subpath as the facade subpath it mirrors). Every other key of a package's
// `exports` map is internal (D44). Shared by package-boundaries.test.ts and upgrade-guide.test.ts.

export const PUBLIC: Record<string, string[]> = {
  "@n1h/sweetview": [".", "./worker", "./page", "./build", "./settings-store", "./window-chrome", "./ipc", "./ipc-ws", "./ipc-ws/server", "./ipc-ws/client", "./ipc-electron", "./ipc-electron/client", "./ipc-electron/preload", "./ipc-electron/server", "./ipc-tauri", "./ipc-tauri/client", "./native", "./native/hit-regions", "./file-imports"],
  "@n1h/sweetview-build": [".", "./make-app", "./refresh-icons"],
  "@n1h/sweetview-ipc": ["."],
  "@n1h/sweetview-ipc-electron": [".", "./client", "./preload", "./server"],
  "@n1h/sweetview-ipc-tauri": [".", "./client"],
  "@n1h/sweetview-ipc-ws": [".", "./server", "./client"],
  "@n1h/sweetview-native": [".", "./hit-regions"],
  "@n1h/sweetview-settings": [".", "./settings-store", "./app-identity"],
};

/** Public entries that are not modules to import for their exports: scripts run by path, and a types-only entry. */
export const NOT_MODULES = new Set(["@n1h/sweetview-build/make-app", "@n1h/sweetview-build/refresh-icons", "@n1h/sweetview/file-imports"]);

/** Every public entry as an import specifier (`@n1h/sweetview/native`, …). */
export const publicSpecifiers = (): string[] => Object.entries(PUBLIC).flatMap(([name, keys]) => keys.map((key) => `${name}${key.slice(1)}`));
