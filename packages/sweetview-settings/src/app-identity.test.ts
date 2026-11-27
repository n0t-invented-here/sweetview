import { expect, test } from "bun:test";
import { join } from "node:path";
import { appDataDir, defineAppIdentity, SettingsStore } from "./index";

test("identity supplies normalized defaults and the settings path", () => {
  const identity = defineAppIdentity({ appId: " com.example.Example-App ", appName: " Example App ", urlSchemes: [" Example+App "] });
  expect(identity).toMatchObject({
    appId: "com.example.Example-App",
    appName: "Example App",
    slug: "example-app",
    urlSchemes: ["example+app"],
    version: "0.1.0",
    dataDir: appDataDir("example-app"),
  });
  expect(new SettingsStore({ identity, defaults: {} }).path).toBe(join(identity.dataDir, "settings.json"));
  expect(new SettingsStore({ identity, app: "override", file: "other.json", defaults: {} }).path).toBe(join(appDataDir("override"), "other.json"));
});

test("identity and settings reject missing required inputs and invalid URL schemes", () => {
  expect(() => defineAppIdentity({ appId: " ", appName: "App" })).toThrow(/non-empty appId/);
  expect(() => defineAppIdentity({ appId: "com.example.app", appName: " " })).toThrow(/non-empty appName/);
  expect(() => defineAppIdentity({ appId: "com.example.app", appName: "App", urlSchemes: ["1 app"] })).toThrow(/invalid URL scheme/);
  expect(() => new SettingsStore({ defaults: {} })).toThrow(/requires app or identity/);
});
