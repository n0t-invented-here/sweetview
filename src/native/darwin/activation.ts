// macOS custom URL scheme handler (NSAppleEventManager kInternetEventClass /
// kAEGetURL) and CLI single-instance handoff via a Unix domain socket in
// appDataDir (zero TCP ports). Scheme registration on macOS is declared in
// Info.plist (`CFBundleURLTypes`) via `makeMacApp({ urlSchemes })`.

import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { validateUrlScheme } from "../../app-identity";
import { appDataDir } from "../../settings-store";
import type { RegisterUrlSchemeOptions, SecondInstanceEvent, SingleInstanceLock } from "../activation";
import {
  NIL,
  type Id,
  asId,
  cls,
  jsString,
  makeTarget,
  sel,
  send,
  sendPtrSelU32U32Void,
  sendU32RetPtr,
  sharedApp,
} from "./objc";

// FourCC constants: 'GURL' = 0x4755524c, '----' = 0x2d2d2d2d
const kInternetEventClass = 0x4755524c;
const kAEGetURL = 0x4755524c;
const keyDirectObject = 0x2d2d2d2d;

let urlTarget: Id = NIL;
let urlDispatch: ((url: string) => void) | undefined;

export function installUrlEventHandler(onUrl: (url: string) => void): void {
  urlDispatch = onUrl;
  if (urlTarget !== NIL) return;
  sharedApp();
  urlTarget = makeTarget("SweetviewUrlEventHandler", {
    "handleGetURLEvent:withReplyEvent:": {
      args: 2,
      impl: (event, _reply) => {
        if (event === NIL) return;
        const descriptor = asId(sendU32RetPtr(event, sel("paramDescriptorForKeyword:"), keyDirectObject));
        if (descriptor === NIL) return;
        const strObj = asId(send(descriptor, sel("stringValue")));
        if (strObj === NIL) return;
        const url = jsString(strObj);
        if (url) urlDispatch?.(url);
      },
    },
  });
  const manager = asId(send(cls("NSAppleEventManager"), sel("sharedAppleEventManager")));
  if (manager !== NIL) {
    sendPtrSelU32U32Void(
      manager,
      sel("setEventHandler:andSelector:forEventClass:andEventID:"),
      urlTarget,
      sel("handleGetURLEvent:withReplyEvent:"),
      kInternetEventClass,
      kAEGetURL,
    );
  }
}

export function registerUrlScheme(scheme: string, _options?: RegisterUrlSchemeOptions): void {
  // Validate syntax; macOS Launch Services registers schemes from Info.plist CFBundleURLTypes (makeMacApp({ urlSchemes })).
  validateUrlScheme(scheme);
}

export function unregisterUrlScheme(scheme: string): void {
  validateUrlScheme(scheme);
}

function safeId(appId: string): string {
  return appId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function trySendToSocket(socketPath: string, payload: SecondInstanceEvent): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(socketPath);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 1500);
    client.once("connect", () => {
      client.end(`${JSON.stringify(payload)}\n`, "utf8", () => {
        clearTimeout(timer);
        finish(true);
      });
    });
    client.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function listenSocket(socketPath: string, onPayload: (event: SecondInstanceEvent) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            onPayload(JSON.parse(line) as SecondInstanceEvent);
          } catch (err) {
            console.error("sweetview: singleInstance socket payload invalid:", err);
          }
        }
      });
    });
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

export async function acquireSingleInstance(params: {
  appId: string;
  payload: SecondInstanceEvent;
  onSecondInstance: (event: SecondInstanceEvent) => void;
}): Promise<SingleInstanceLock> {
  const dir = appDataDir(safeId(params.appId));
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, "instance.sock");

  if (await trySendToSocket(socketPath, params.payload)) {
    return { isPrimary: false, handedOff: true, dispose() {} };
  }

  // Remove any stale socket left behind by a crashed previous process.
  try {
    rmSync(socketPath, { force: true });
  } catch {}

  let server: Server;
  try {
    server = await listenSocket(socketPath, params.onSecondInstance);
  } catch {
    // Race: another instance bound the socket first; hand off to it.
    const handedOff = await trySendToSocket(socketPath, params.payload);
    return { isPrimary: false, handedOff, dispose() {} };
  }

  let disposed = false;
  return {
    isPrimary: true,
    handedOff: false,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        server.close();
      } catch {}
      try {
        rmSync(socketPath, { force: true });
      } catch {}
    },
  };
}
