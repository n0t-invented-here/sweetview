// SWEETVIEW_NATIVE_PATH names the binding to load. Loads it through a public
// call and prints one JSON line: { ok } or { error }.
import { Screen } from "@n1h/sweetview-native";

try {
  const { bounds } = Screen.primary();
  console.log(JSON.stringify({ ok: bounds.width > 0 }));
} catch (err) {
  console.log(JSON.stringify({ error: (err as Error).message }));
}
process.exit(0);
