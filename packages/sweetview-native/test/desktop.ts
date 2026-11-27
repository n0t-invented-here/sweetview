// Test support: a check that needs the shared desktop in a given state (no mouse button held, the
// test's own window under the cursor, the foreground) is retried a few times with a short wait
// between, because other sessions on this machine inject input and take the foreground. When the
// desktop never comes right, the test throws with the reason, so the run shows a failure, never a
// pass that asserted nothing.

export class DesktopNotOurs extends Error {}

/**
 * Resolves once `ready()` is true. Between attempts it runs `between` (to re-place a window, move
 * the cursor again, pump the loop) and waits `waitMs`. Throws `DesktopNotOurs` naming `what` after
 * the last attempt.
 */
export async function untilDesktopIsOurs(
  what: string,
  ready: () => boolean | Promise<boolean>,
  { attempts = 5, waitMs = 250, between }: { attempts?: number; waitMs?: number; between?: () => void | Promise<void> } = {},
): Promise<number> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await ready()) return attempt;
    if (attempt === attempts) break;
    await Bun.sleep(waitMs);
    await between?.();
  }
  throw new DesktopNotOurs(`not run: ${what}, after ${attempts} attempts (the desktop is shared with other sessions)`);
}
