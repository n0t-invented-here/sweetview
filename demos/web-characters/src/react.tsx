// The character as a React component. It renders nothing itself: the canvas is
// appended to `host` (or the body) outside React's tree, and removed on
// unmount. Props after the first render reach the character through its handle.
// `model` is compared by its URL, so an object literal in the render body does
// not reload it.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { sameModel } from "./model";
import { createCharacter, type CharacterHandle, type CharacterOptions } from "./character";

export type CharacterProps = CharacterOptions & {
  /** The running character, for `spawn`, `setModel`, `setSettings` and `position`. Null until the first effect has run. */
  ref?: Ref<CharacterHandle>;
};

export function Character({ ref, model, scale, bottom, spawn, host, zIndex, onFault }: CharacterProps) {
  const [handle, setHandle] = useState<CharacterHandle | null>(null);
  // The latest of every prop, for the one-time creation below, so changing a prop does not re-create the character.
  const latest = useRef({ model, scale, bottom, spawn, onFault });
  latest.current = { model, scale, bottom, spawn, onFault };

  useEffect(() => {
    const created = createCharacter({ ...latest.current, host, zIndex, onFault: (m, e) => latest.current.onFault?.(m, e) ?? console.error(m, e ?? "") });
    setHandle(created);
    return () => {
      created.dispose();
      setHandle(null);
    };
  }, [host, zIndex]);

  useEffect(() => {
    if (handle && !sameModel(model, handle.model)) void handle.setModel(model);
  }, [handle, model]);

  useEffect(() => {
    handle?.setSettings({ scale, bottom });
  }, [handle, scale, bottom]);

  useImperativeHandle(ref, () => handle as CharacterHandle, [handle]); // a RefObject's current is nullable; it is null until the character is up
  return null;
}
