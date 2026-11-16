#!/usr/bin/env bun
// Tells Windows that program icons changed, so Explorer, the taskbar and the Start menu draw a
// rebuilt program's icon instead of the one they kept from the file that was at that path before.
// Run it after `bun build --compile --windows-icon=...`. It is the call an installer makes
// (SHChangeNotify, SHCNE_ASSOCCHANGED); it changes nothing on the computer. On another OS it does nothing.
//
//   bun src/refresh-icons.ts

import { refreshWindowsIcons } from "./build";

refreshWindowsIcons();
