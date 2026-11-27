// An instance built from tag pre-rust-rewrite (single instance in TypeScript over bun:ffi) and an
// instance of this tree (single instance in Rust, through the binding) hand off to each other in
// both directions (checklist item W6.2).
//
//   bun rust-rewrite/checks/single-instance-interop.ts
//
// It writes the tag's tree with `git archive` into a new folder under the system temp directory,
// runs `bun install` there, and then runs, twice, a primary from one tree and a secondary from the
// other, each as `bun -e <script>` with its own tree as the working directory so that
// `@n1h/sweetview-native` resolves to that tree's package. The temp folder is removed at the end.
// This tree's binding must be built first (`just native`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repo = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..");
const TAG = "pre-rust-rewrite";
const temp = tmpdir();
const scrub = (text: string) => text.replaceAll(temp, "<TEMP>").replaceAll(temp.replaceAll("\\", "\\\\"), "<TEMP>").replaceAll(repo, "<REPO>").replaceAll(repo.replaceAll("\\", "\\\\"), "<REPO>");
const say = (line: string) => console.log(scrub(line));

const old = mkdtempSync(join(temp, "sweetview-interop-old-"));
let failed = false;
try {
  say(`$ git archive ${TAG} | tar -x -C <TEMP>/${old.slice(temp.length + 1)}`);
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", TAG], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (archive.exitCode !== 0) throw new Error(`git archive failed: ${archive.stderr.toString()}`);
  const untar = Bun.spawnSync(["tar", "-x", "-C", old], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
  if (untar.exitCode !== 0) throw new Error(`tar failed: ${untar.stderr.toString()}`);
  say("$ bun install        (in the tag's tree)");
  const install = Bun.spawnSync(["bun", "install"], { cwd: old, stdout: "pipe", stderr: "pipe", timeout: 300_000 });
  if (install.exitCode !== 0) throw new Error(`bun install in the tag's tree failed: ${install.stderr.toString()}`);

  const primary = (appId: string) => `
    import { pumpEvents, singleInstance } from "@n1h/sweetview-native";
    let got;
    const lock = await singleInstance({ appId: ${JSON.stringify(appId)}, urlSchemes: ["svtest"], args: [], onSecondInstance: (e) => { got = e; } });
    console.log("READY isPrimary=" + lock.isPrimary);
    const deadline = Date.now() + 20000;
    while (!got && Date.now() < deadline) { pumpEvents(); await Bun.sleep(10); }
    console.log("RECEIVED " + JSON.stringify(got ?? null));
    lock.dispose();
    process.exit(0);`;
  const secondary = (appId: string, who: string) => `
    import { singleInstance } from "@n1h/sweetview-native";
    const lock = await singleInstance({ appId: ${JSON.stringify(appId)}, urlSchemes: ["svtest"], args: ["--from", ${JSON.stringify(who)}, "svtest://open/42"] });
    console.log("RESULT " + JSON.stringify({ isPrimary: lock.isPrimary, handedOff: lock.handedOff }));
    lock.dispose();
    process.exit(0);`;

  const trees = { old, new: repo } as const;
  for (const [first, second] of [["old", "new"], ["new", "old"]] as const) {
    const appId = `dev.sweetview.interop.${first}-primary.${process.pid}.${Date.now()}`;
    say(`== ${first} primary, ${second} secondary`);
    const p = Bun.spawn(["bun", "-e", primary(appId)], { cwd: trees[first], stdout: "pipe", stderr: "pipe", timeout: 40_000 });
    const reader = p.stdout.getReader();
    const decoder = new TextDecoder();
    let primaryOut = "";
    const readUntil = async (marker: string) => {
      while (!primaryOut.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) break;
        primaryOut += decoder.decode(value);
      }
    };
    await readUntil("READY");
    const ready = primaryOut.split(/\r?\n/).find((l) => l.startsWith("READY")) ?? "(no READY line)";
    say(`  [${first} primary] ${ready}`);
    const s = Bun.spawnSync(["bun", "-e", secondary(appId, second)], { cwd: trees[second], stdout: "pipe", stderr: "pipe", timeout: 40_000 });
    const result = s.stdout.toString().split(/\r?\n/).find((l) => l.startsWith("RESULT")) ?? "(no RESULT line)";
    say(`  [${second} secondary] ${result}`);
    say(`  [${second} secondary] exit ${s.exitCode}; stderr: ${JSON.stringify(s.stderr.toString().trim())}`);
    await readUntil("RECEIVED");
    const code = await p.exited;
    const received = primaryOut.split(/\r?\n/).find((l) => l.startsWith("RECEIVED")) ?? "(no RECEIVED line)";
    say(`  [${first} primary] ${received}`);
    say(`  [${first} primary] exit ${code}; stderr: ${JSON.stringify((await new Response(p.stderr).text()).trim())}`);
    const handedOff = result.includes('"handedOff":true') && result.includes('"isPrimary":false');
    const payload = received.startsWith("RECEIVED {") ? (JSON.parse(received.slice("RECEIVED ".length)) as { args?: string[]; url?: string; cwd?: string }) : null;
    const arrived = payload !== null && JSON.stringify(payload.args) === JSON.stringify(["--from", second, "svtest://open/42"]) && payload.url === "svtest://open/42" && typeof payload.cwd === "string";
    say(`  handed off: ${handedOff}; the payload { args, cwd, url } arrived unchanged: ${arrived}`);
    if (!handedOff || !arrived || code !== 0 || s.exitCode !== 0) failed = true;
  }
} catch (error) {
  failed = true;
  say(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // The folder this script made, under the temp directory, and nothing else.
  if (old.startsWith(temp) && old.includes("sweetview-interop-old-")) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(old, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(250);
      }
    }
  }
}
say(failed ? "FAIL" : "OK: the old build and the new build hand off to each other in both directions");
process.exit(failed ? 1 : 0);
