// The demos that send notifications each have one identity (identity.ts), and everything that names
// the demo to a person agrees with it: the justfile's `name` and `app_id` (the macOS bundle's name and
// id, and the Windows executable's product name and description), the window titles, the tray
// tooltip, and the name a Windows toast shows. The toast is built the way the demo's notifier builds
// it and held back from the platform, so nothing is shown and no input is injected; what it
// registers is read from the registry and left there, as a run of the demo leaves it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppIdentity } from "@n1h/sweetview-settings";

const DEMOS = ["desktop-pet", "menubar-notify", "web-app"] as const;
const here = import.meta.dir;
const identityOf = async (demo: string) => (await import(join(here, demo, "identity.ts"))).IDENTITY as AppIdentity;
const justVar = (demo: string, name: string) => new RegExp(`^${name} := "([^"]*)"\\r?$`, "m").exec(readFileSync(join(here, demo, "justfile"), "utf8"))?.[1];

describe("each demo's identity", () => {
  for (const demo of DEMOS) {
    test(`${demo}: the justfile, the app and the notifier use identity.ts`, async () => {
      const identity = await identityOf(demo);
      expect({ name: justVar(demo, "name"), app_id: justVar(demo, "app_id") }).toEqual({ name: identity.appName, app_id: identity.appId });
      const justfile = readFileSync(join(here, demo, "justfile"), "utf8");
      expect(justfile).toContain('--name "{{name}}" --bundle-id {{app_id}} ');
      expect(justfile).toContain('--windows-title=\\"" + name + "\\" --windows-description=\\"" + name + "\\""');
      const app = readFileSync(join(here, demo, "app.ts"), "utf8");
      expect(app).toContain("const APP_NAME = IDENTITY.appName;");
      expect(app).toMatch(/createNotifier\(\{\s*identity: IDENTITY\b/);
      expect(app).toMatch(/(createApp<[^>]*>\(\{|new Window\(\{)\s*identity: IDENTITY,/);
    });
  }

  test.skipIf(process.platform !== "win32")("a toast of each demo is registered under the demo's own name, not Sweetview's", async () => {
    const { createNotifier, debugNativeNotifier } = await import("../packages/sweetview-native/src/win32/notifier");
    const displayName = (appId: string): string | null => {
      const out = Bun.spawnSync(["reg", "query", `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`, "/v", "DisplayName"], { stdout: "pipe", stderr: "pipe" });
      return out.exitCode === 0 ? (/DisplayName\s+REG_SZ\s+(.*)/.exec(out.stdout.toString())?.[1]?.trim() ?? null) : null;
    };
    const shown: Record<string, string | null> = {};
    for (const demo of DEMOS) {
      const identity = await identityOf(demo);
      const backend = createNotifier({ identity });
      try {
        const native = debugNativeNotifier(backend)!;
        native.debugForcePath("toastHeld");
        native.debugShow(`${demo}-identity-test`, identity.appName, "held back, never shown", true, null);
      } finally {
        backend.dispose();
      }
      shown[demo] = displayName(identity.appId);
    }
    console.log(`the name each demo's toast shows: ${JSON.stringify(shown)}`);
    expect(shown).toEqual({ "desktop-pet": "Pet", "menubar-notify": "Menubar Notify", "web-app": "Web App" });
  });
});
