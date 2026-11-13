// The pet as a React component. It renders nothing itself: the canvas is
// appended to `host` (or the body) outside React's tree, and removed on
// unmount. Props after the first render reach the pet through its handle.
// `pet` may be a cube pet's name or a model spec; a spec is compared by its
// file, so an object literal in the render body does not reload it.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { sameModel } from "./model";
import { createPet, resolveModel, type PetHandle, type PetOptions } from "./pet";

export type PetProps = PetOptions & {
  /** The running pet, for `spawn`, `setPet`, `setSettings` and `position`. Null until the first effect has run. */
  ref?: Ref<PetHandle>;
};

export function Pet({ ref, pet, scale, bottom, spawn, host, assetsUrl, zIndex, onFault }: PetProps) {
  const [handle, setHandle] = useState<PetHandle | null>(null);
  // The latest of every prop, for the one-time creation below, so changing a prop does not re-create the pet.
  const latest = useRef({ pet, scale, bottom, spawn, onFault });
  latest.current = { pet, scale, bottom, spawn, onFault };

  useEffect(() => {
    const created = createPet({ ...latest.current, host, assetsUrl, zIndex, onFault: (m, e) => latest.current.onFault?.(m, e) ?? console.error(m, e ?? "") });
    setHandle(created);
    return () => {
      created.dispose();
      setHandle(null);
    };
  }, [host, assetsUrl, zIndex]);

  useEffect(() => {
    if (handle && pet && !sameModel(resolveModel(pet), handle.model)) void handle.setPet(pet);
  }, [handle, pet]);

  useEffect(() => {
    handle?.setSettings({ scale, bottom });
  }, [handle, scale, bottom]);

  useImperativeHandle(ref, () => handle as PetHandle, [handle]); // a RefObject's current is nullable; it is null until the pet is up
  return null;
}
