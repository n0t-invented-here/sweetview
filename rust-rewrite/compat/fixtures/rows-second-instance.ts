// A second instance for the `singleInstance` row: asks for the lock of the
// app id given as argv[2] while rows-desktop.ts holds it, and prints what it
// got as one JSON line.

import { singleInstance } from "@n1h/sweetview-native";

const lock = await singleInstance({ appId: process.argv[2]!, args: ["--from-second", "sweetview-compat-row://opened"], urlSchemes: ["sweetview-compat-row"] });
console.log(JSON.stringify({ isPrimary: lock.isPrimary, handedOff: (lock as { handedOff?: boolean }).handedOff }));
process.exit(0);
