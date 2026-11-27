// Windows has no run-time app icon: see ../app-icon.ts. The binding does nothing with it.

import { binding } from "../binding";
import type { Icon } from "../icon";
import { iconBytes } from "./menu";

export function setAppIcon(icon: Icon): void {
  binding().setAppIcon(iconBytes(icon) ?? {});
}
