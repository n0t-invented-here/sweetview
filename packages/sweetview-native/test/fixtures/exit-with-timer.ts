// A process that exits with a native interval still set (decision D38): the thread that posts the
// interval's ticks is ended by Windows before the runtime's thread-local storage is torn down, and
// the runtime must not try to join it there. Prints `TICKED <n>` and exits with code 0.

import { binding } from "../../src/binding";

const native = binding();
let ticks = 0;
native.scheduleInterval(10, () => void ticks++);
for (const end = performance.now() + 300; performance.now() < end; ) {
  native.pumpEvents();
  Bun.sleepSync(5);
}
console.log(`TICKED ${ticks}`);
process.exit(0);
