// An application of `@n1h/sweetview` that makes a call of the native package first, for
// webview-split.test.ts: the binding the process loads is the facade's (D48). It waits to be ended.

import "@n1h/sweetview";
import { Screen } from "@n1h/sweetview-native";

console.log(Screen.all().length);
setInterval(() => {}, 1_000);
