import { expect, test } from "bun:test";
import { pumpEvents, singleInstance, type SecondInstanceEvent } from "../index";

test.if(process.platform === "darwin")("CFMessagePort hands off a secondary launch through the native main loop", async () => {
  const appId = `dev.sweetview.test.${crypto.randomUUID()}.${"long".repeat(100)}`;
  let received: SecondInstanceEvent | undefined;
  let lock = await singleInstance({
    appId,
    args: [],
    onSecondInstance: (event) => {
      received = event;
      lock.dispose();
    },
  });
  const payload = ["--extra", "svtest://warm/🥐"];
  const script = `
    import { singleInstance } from "@n1h/sweetview-native";
    const lock = await singleInstance({ appId: ${JSON.stringify(appId)}, args: ${JSON.stringify(payload)} });
    console.log(JSON.stringify({ isPrimary: lock.isPrimary, handedOff: lock.handedOff }));
    lock.dispose();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  try {
    expect(lock.isPrimary).toBe(true);
    const deadline = performance.now() + 3500;
    do {
      pumpEvents();
      if (received) break;
      Bun.sleepSync(5);
    } while (performance.now() < deadline);
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ isPrimary: false, handedOff: true });
    expect(received).toEqual({ args: payload, url: payload[1], cwd: process.cwd() });
    pumpEvents(); // Drain callback cleanup scheduled by dispose inside the native handler.
    lock = await singleInstance({ appId, args: [] });
    expect(lock.isPrimary).toBe(true);
  } finally {
    lock.dispose();
  }
});
