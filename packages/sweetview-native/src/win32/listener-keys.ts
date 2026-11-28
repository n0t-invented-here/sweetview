// The number each function is known by to the binding's window listeners: a
// window has one list of resize, move and maximise listeners, and the same
// function added again, through any wrapper, is one listener of it.

const functionKeys = new WeakMap<Function, number>();
let nextFunctionKey = 1;

/** The binding's key for `fn`: the same number every time it is asked for the same function. */
export function keyOf(fn: Function): number {
  let key = functionKeys.get(fn);
  if (key === undefined) functionKeys.set(fn, (key = nextFunctionKey++));
  return key;
}
