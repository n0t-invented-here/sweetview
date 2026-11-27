// Windows custom URL scheme registration (HKCU\Software\Classes\<scheme>) and
// the single-instance lock and handoff, through the native binding. Names and
// wire format are today's: mutex `Local\sweetview.instance.<id>`, message-only
// window `SweetviewSingleInstanceWindow`, WM_COPYDATA tagged "SWV1" carrying
// the JSON `{ args, cwd, url? }`. No administrator rights required.

import { validateUrlScheme } from "@n1h/sweetview-settings";
import { binding } from "../binding";
import { parseSecondInstanceEvent, type RegisterUrlSchemeOptions, type SecondInstanceEvent, type SingleInstanceLock } from "../activation";

export function registerUrlScheme(scheme: string, options: RegisterUrlSchemeOptions = {}): void {
  const normalized = validateUrlScheme(scheme);
  const exePath = options.executablePath ?? process.execPath;
  const appName = options.appName ?? options.identity?.appName ?? normalized;
  const icon = options.iconPath ?? `${exePath},0`;
  const command = options.command ?? `"${exePath}" "%1"`;
  binding().registerUrlScheme(normalized, appName, icon, command);
}

export function unregisterUrlScheme(scheme: string): void {
  binding().unregisterUrlScheme(validateUrlScheme(scheme));
}

export async function acquireSingleInstance(params: {
  appId: string;
  payload: SecondInstanceEvent;
  onSecondInstance: (event: SecondInstanceEvent) => void;
}): Promise<SingleInstanceLock> {
  const lock = binding().SingleInstance.acquire(params.appId, JSON.stringify(params.payload), (json) => {
    try {
      // The binding passes on only payloads that pass this same check.
      const event = parseSecondInstanceEvent(json);
      if (event !== undefined) params.onSecondInstance(event);
    } catch (err) {
      console.error("sweetview: singleInstance WM_COPYDATA handler threw:", err);
    }
  });
  const isPrimary = lock.isPrimary;
  const handedOff = lock.handedOff;
  let disposed = false;
  return {
    isPrimary,
    handedOff,
    dispose() {
      if (disposed) return;
      disposed = true;
      lock.dispose();
    },
  };
}

export function installUrlEventHandler(_onUrl: (url: string) => void): void {
  // Windows delivers custom URL launches as argv[1] to the process (or via singleInstance WM_COPYDATA).
}
