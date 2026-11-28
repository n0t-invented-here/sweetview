// The demo's one identity, for everything that names it to a person. `appId` is the bundle id and
// `appName` the bundle name that `just demos desktop-pet mac-app` gives the macOS bundle (the justfile's
// `app_id` and `name`, which make-app.ts takes as --bundle-id and --name, and which name the Windows
// executable too). On Windows `appId` and `appName` are the notifications' identity, the name a
// toast shows; `appName` is also the window titles, the tray tooltip and the menus.

import { defineAppIdentity } from "@n1h/sweetview/native";

export const IDENTITY = defineAppIdentity({ appId: "dev.mrowr.pet", appName: "Pet", version: "0.1.0" });
